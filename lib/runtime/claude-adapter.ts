import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentEvent, AgentRuntime, AgentRuntimeSession, RuntimeSessionOptions } from "./types";

// Claude stream-json은 중첩 필드를 옵셔널 체인으로 바로 읽는다. 비활성 보존 어댑터라 타입을 좁히지 않는다.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

function stringifyOutput(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Convert the stable stream-json blocks emitted by Claude Code into CUELO events. */
export function convertClaudeMessage(message: JsonObject): AgentEvent[] {
  const events: AgentEvent[] = [];
  if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") {
    events.push({ type: "session_started", sessionId: message.session_id, engine: "claude" });
  }
  if (message.type === "stream_event") {
    const delta = message.event?.delta;
    if (delta?.type === "text_delta" && typeof delta.text === "string") events.push({ type: "text_delta", text: delta.text });
    if ((delta?.type === "thinking_delta" || delta?.type === "text_delta" && message.event?.content_block?.type === "thinking") && typeof delta.thinking === "string") {
      events.push({ type: "reasoning_delta", text: delta.thinking });
    }
  }
  if (message.type === "assistant" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block?.type === "text" && typeof block.text === "string") events.push({ type: "text_delta", text: block.text });
      else if (block?.type === "thinking" && typeof block.thinking === "string") events.push({ type: "reasoning_delta", text: block.thinking });
      else if (block?.type === "tool_use") events.push({ type: "tool_started", id: String(block.id ?? randomUUID()), name: String(block.name ?? "tool"), input: block.input });
    }
  }
  if (message.type === "user" && Array.isArray(message.message?.content)) {
    for (const block of message.message.content) {
      if (block?.type === "tool_result") events.push({ type: "tool_completed", id: String(block.tool_use_id ?? ""), output: stringifyOutput(block.content), isError: block.is_error === true });
    }
  }
  if (message.type === "result") {
    const usage = message.usage;
    if (usage) events.push({
      type: "usage",
      input: Number(usage.input_tokens ?? 0),
      cachedInput: Number(usage.cache_read_input_tokens ?? 0),
      cacheWrite: Number(usage.cache_creation_input_tokens ?? 0),
      output: Number(usage.output_tokens ?? 0),
    });
    const stopReason = message.is_error || String(message.subtype ?? "").startsWith("error") ? "error" : "stop";
    events.push({ type: "turn_completed", stopReason, text: typeof message.result === "string" ? message.result : "" });
  }
  return events;
}

class ClaudeRuntimeSession implements AgentRuntimeSession {
  readonly engine = "claude" as const;
  readonly id: string;
  private child?: ChildProcess;
  private listeners = new Set<(event: AgentEvent) => void>();
  private pendingTurn?: { resolve: () => void; reject: (error: Error) => void; text: string; aborted: boolean };
  private closed = false;
  private sessionId?: string;
  private sessionStarted = false;

  constructor(private readonly options: RuntimeSessionOptions) {
    this.id = options.resumeId ?? randomUUID();
    this.sessionId = options.resumeId;
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private start(): void {
    if (this.child) return;
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-mode", "bypassPermissions"];
    if (this.options.model) args.push("--model", this.options.model);
    if (this.sessionId) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.id);
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    const child = spawn("claude", args, { cwd: this.options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      let message: JsonObject;
      try { message = JSON.parse(line) as JsonObject; }
      catch { this.emit({ type: "error", message: `Invalid Claude stream-json line: ${line}` }); return; }
      const events = convertClaudeMessage(message).filter((event) => !(message.type === "assistant" && (event.type === "text_delta" || event.type === "reasoning_delta")));
      for (const event of events) {
        if (event.type === "session_started") {
          this.sessionId = event.sessionId;
          if (this.sessionStarted) continue;
          this.sessionStarted = true;
        }
        if (event.type === "text_delta" && this.pendingTurn) this.pendingTurn.text += event.text;
        if (event.type === "turn_completed" && this.pendingTurn) {
          const turn = this.pendingTurn;
          this.pendingTurn = undefined;
          this.emit({ ...event, stopReason: turn.aborted ? "aborted" : event.stopReason });
          turn.resolve();
          continue;
        }
        this.emit(event);
      }
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      this.emit({ type: "error", message: error.message });
      const turn = this.pendingTurn;
      this.pendingTurn = undefined;
      turn?.reject(error);
    });
    child.on("close", (code, signal) => {
      this.child = undefined;
      const turn = this.pendingTurn;
      if (!turn) return;
      this.pendingTurn = undefined;
      if (turn.aborted) {
        this.emit({ type: "turn_completed", stopReason: "aborted", text: turn.text });
        turn.resolve();
      } else {
        const error = new Error(`Claude CLI exited (${signal ?? code}): ${stderr.trim()}`);
        this.emit({ type: "error", message: error.message });
        this.emit({ type: "turn_completed", stopReason: "error", text: turn.text });
        turn.reject(error);
      }
    });
  }

  async prompt(message: string): Promise<void> {
    if (this.closed) throw new Error("Claude runtime session is disposed");
    if (this.pendingTurn) throw new Error("Claude runtime session already has an active turn");
    this.start();
    return new Promise<void>((resolve, reject) => {
      this.pendingTurn = { resolve, reject, text: "", aborted: false };
      this.child!.stdin!.write(`${JSON.stringify({ type: "user", message: { role: "user", content: message }, parent_tool_use_id: null })}\n`, (error) => {
        if (!error) return;
        this.pendingTurn = undefined;
        reject(error);
      });
    });
  }

  async abort(): Promise<void> {
    const turn = this.pendingTurn;
    const child = this.child;
    if (!turn || !child) return;
    turn.aborted = true;
    const message = { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } };
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => error ? reject(error) : resolve());
    await promise;
  }

  async dispose(): Promise<void> {
    this.closed = true;
    if (!this.child) return;
    const child = this.child;
    child.stdin?.end();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
}

export function createClaudeRuntime(): AgentRuntime {
  return {
    engine: "claude",
    async createSession(options) {
      return new ClaudeRuntimeSession(options);
    },
  };
}
