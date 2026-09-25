import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AgentRuntime,
  AgentRuntimeSession,
  RuntimeSessionOptions,
} from "./types";

type JsonObject = Record<string, unknown>;
type Pending = { resolve(value: unknown): void; reject(error: Error): void };

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" ? value as JsonObject : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function usageNumber(...values: unknown[]): number {
  for (const value of values) if (typeof value === "number") return value;
  return 0;
}

/** Translate a Codex app-server notification into the adapter's stable event contract. */
export function codexNotificationEvents(method: string, rawParams: unknown): AgentEvent[] {
  const params = object(rawParams);
  if (method === "item/agentMessage/delta") {
    const text = string(params.delta);
    return text === undefined ? [] : [{ type: "text_delta", text }];
  }
  if (method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") {
    const text = string(params.delta);
    return text === undefined ? [] : [{ type: "reasoning_delta", text }];
  }
  if (method === "item/started" || method === "item/completed") {
    const item = object(params.item);
    const itemType = string(item.type);
    if (itemType === "commandExecution" || itemType === "command_execution") {
      const id = string(item.id) ?? string(params.itemId) ?? randomUUID();
      if (method === "item/started") {
        return [{ type: "tool_started", id, name: "command", input: { command: item.command, cwd: item.cwd } }];
      }
      const status = string(item.status);
      return [{ type: "tool_completed", id, output: string(item.aggregatedOutput) ?? "", isError: status === "failed" || (typeof item.exitCode === "number" && item.exitCode !== 0) }];
    }
    if (itemType === "fileChange" || itemType === "file_change") {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      return changes.flatMap((change) => {
        const path = string(object(change).path);
        return path === undefined ? [] : [{ type: "file_changed" as const, path }];
      });
    }
  }
  if (method === "thread/tokenUsage/updated") {
    const tokenUsage = object(params.tokenUsage);
    const last = object(tokenUsage.last);
    return [{
      type: "usage",
      input: usageNumber(last.inputTokens),
      cachedInput: usageNumber(last.cachedInputTokens),
      cacheWrite: usageNumber(last.cacheWriteInputTokens),
      output: usageNumber(last.outputTokens),
    }];
  }
  if (method === "turn/completed") {
    const turn = object(params.turn);
    const status = string(turn.status);
    const stopReason = status === "interrupted" ? "aborted" : status === "failed" ? "error" : "stop";
    return [{ type: "turn_completed", stopReason, text: string(turn.outputText) ?? string(turn.text) ?? "" }];
  }
  if (method === "error") {
    const error = object(params.error);
    return [{ type: "error", message: string(error.message) ?? "Codex app-server turn error" }];
  }
  return [];
}

class CodexSession implements AgentRuntimeSession {
  readonly id = randomUUID();
  readonly engine = "codex" as const;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly pending = new Map<number, Pending>();
  private nextRequestId = 1;
  private buffer = "";
  private threadId: string | undefined;
  private activeTurn: Promise<void> | undefined;
  private turnText = "";
  private disposed = false;

  private constructor(private readonly child: ChildProcess, private readonly thinking?: string) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.readLines(chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) this.emit({ type: "error", message });
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code, signal) => this.fail(new Error(`codex app-server exited (code=${code}, signal=${signal})`)));
  }

  static async create(options: RuntimeSessionOptions): Promise<CodexSession> {
    const child = spawn("codex", ["app-server", "--stdio"], { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const session = new CodexSession(child, options.thinking);
    try {
      await session.request("initialize", {
        clientInfo: { name: "cuelo", title: "CUELO", version: "0.1.0" },
        capabilities: {},
      });
      session.notify("initialized", {});
      const response = object(await session.request("thread/start", {
        cwd: options.cwd,
        model: options.model,
        sandbox: "workspace-write",
        approvalPolicy: "never",
      }));
      const thread = object(response.thread);
      const threadId = string(thread.id);
      if (!threadId) throw new Error("Codex app-server thread/start returned no thread.id");
      session.threadId = threadId;
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  prompt(message: string): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Codex session is disposed"));
    if (!this.threadId) return Promise.reject(new Error("Codex thread is not initialized"));
    if (this.activeTurn) return Promise.reject(new Error("A Codex turn is already running"));
    this.turnText = "";
    let complete!: () => void;
    let fail!: (error: Error) => void;
    const finished = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
    this.turnCompletion = { resolve: complete, reject: fail };
    const input = [{ type: "text", text: message, text_elements: [] }];
    const run = this.request("turn/start", {
      threadId: this.threadId,
      input,
      effort: this.thinking,
    })
      .then((response) => {
        this.turnId = string(object(object(response).turn).id);
        return finished;
      })
      .catch((error: Error) => {
        this.turnCompletion = undefined;
        throw error;
      })
      .finally(() => { this.activeTurn = undefined; this.turnId = undefined; });
    this.activeTurn = run;
    return run;
  }

  private turnCompletion: { resolve(): void; reject(error: Error): void } | undefined;
  private turnId: string | undefined;

  /** Interrupt the running turn; resolves after app-server reports the interrupted turn. */
  async abort(): Promise<void> {
    const running = this.activeTurn;
    if (!running || !this.threadId) return;
    if (this.turnId) await this.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
    await running.catch(() => undefined);
  }

  onEvent(handler: (event: AgentEvent) => void): () => void {
    this.listeners.add(handler);
    if (this.threadId) handler({ type: "session_started", sessionId: this.threadId, engine: "codex" });
    return () => this.listeners.delete(handler);
  }


  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new Error("Codex session disposed"));
    this.child.stdin?.end();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill();
  }

  private emit(event: AgentEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private request(method: string, params: JsonObject): Promise<unknown> {
    if (this.disposed || !this.child.stdin?.writable) return Promise.reject(new Error("Codex app-server stdin is closed"));
    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
      if (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        pending?.reject(error);
      }
    });
    return promise;
  }

  private notify(method: string, params: JsonObject): void {
    this.child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  }

  private readLines(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message: JsonObject;
      try { message = object(JSON.parse(line)); }
      catch { this.emit({ type: "error", message: `Invalid JSON from codex app-server: ${line}` }); continue; }
      if (typeof message.id === "number") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        continue;
      }
      const method = string(message.method);
      if (!method) continue;
      for (const event of codexNotificationEvents(method, message.params)) {
        if (event.type === "text_delta") this.turnText += event.text;
        if (event.type === "turn_completed") {
          if (!event.text) event.text = this.turnText;
          this.turnCompletion?.resolve();
          this.turnCompletion = undefined;
        }
        this.emit(event);
      }
    }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.turnCompletion?.reject(error);
    this.turnCompletion = undefined;
  }
}

export function createCodexRuntime(): AgentRuntime {
  return {
    engine: "codex",
    createSession: (options) => CodexSession.create(options),
  };
}
