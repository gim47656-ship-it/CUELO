import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentEvent, AgentRuntime, AgentRuntimeSession, RuntimeSessionOptions } from "./types";

type EventRecord = Record<string, unknown> & { type: string };
type EventSink = (event: AgentEvent) => void;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  const message = record(value);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((part) => {
    const item = record(part);
    return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
}

/** Convert only stable OMP session events into the adapter contract. */
export function mapOmpEvent(value: EventRecord, emit: EventSink): void {
  switch (value.type) {
    case "message_update": {
      if (record(value.message)?.role !== "assistant") return;
      const update = record(value.assistantMessageEvent);
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        emit({ type: "text_delta", text: update.delta });
      } else if (update?.type === "thinking_delta" && typeof update.delta === "string") {
        emit({ type: "reasoning_delta", text: update.delta });
      }
      return;
    }
    case "tool_execution_start":
      emit({ type: "tool_started", id: String(value.toolCallId ?? ""), name: String(value.toolName ?? ""), input: value.args });
      return;
    case "tool_execution_end":
      emit({
        type: "tool_completed",
        id: String(value.toolCallId ?? ""),
        output: typeof value.result === "string" ? value.result : JSON.stringify(value.result ?? ""),
        isError: value.isError === true,
      });
      return;
    case "agent_end": {
      const messages = Array.isArray(value.messages) ? value.messages : [];
      const text = messages.flatMap((item) => {
        const message = record(item);
        return message?.role === "assistant" ? [messageText(item)] : [];
      }).join("");
      emit({ type: "turn_completed", stopReason: value.aborted === true ? "aborted" : value.error ? "error" : "stop", text });
      return;
    }
    case "error":
      emit({ type: "error", message: String(value.message ?? "OMP runtime error") });
      return;
  }
  if (value.type !== "message_end") return;
  const message = record(value.message);
  const usage = record(message?.usage) ?? record(value.usage);
  if (message?.role === "assistant" && usage) {
    emit({
      type: "usage",
      input: Number(usage.input ?? 0),
      cachedInput: Number(usage.cacheRead ?? 0),
      cacheWrite: Number(usage.cacheWrite ?? 0),
      output: Number(usage.output ?? 0),
    });
  }
}

class OmpRuntimeSession implements AgentRuntimeSession {
  readonly engine = "omp" as const;
  private readonly listeners = new Set<EventSink>();
  private unsubscribe: (() => void) | undefined;
  private turnText = "";

  constructor(readonly id: string, private readonly session: AgentSession) {
    this.unsubscribe = this.session.subscribe((event: AgentSessionEvent) => {
      mapOmpEvent(event as unknown as EventRecord, (mapped) => {
        if (mapped.type === "text_delta") this.turnText += mapped.text;
        if (mapped.type === "turn_completed" && !mapped.text) mapped.text = this.turnText;
        for (const listener of this.listeners) listener(mapped);
      });
    });
  }

  async prompt(message: string): Promise<void> {
    this.turnText = "";
    await this.session.prompt(message);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  onEvent(handler: EventSink): () => void {
    this.listeners.add(handler);
    handler({ type: "session_started", sessionId: this.id, engine: this.engine });
    return () => this.listeners.delete(handler);
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.listeners.clear();
    await this.session.dispose();
  }
}

export function createOmpRuntime(): AgentRuntime {
  return {
    engine: "omp",
    async createSession(options: RuntimeSessionOptions): Promise<AgentRuntimeSession> {
      // SDK modules are lazy so event conversion can be tested without loading OMP dependencies.
      const [{ createAgentSession, SessionManager }, { getOmpRuntime, getSettingsForCwd }, { resolveSessionPath }] = await Promise.all([
        import("@oh-my-pi/pi-coding-agent"),
        import("../omp-runtime"),
        import("../session-reader"),
      ]);
      const [runtime, settings, sessionPath] = await Promise.all([
        getOmpRuntime(),
        getSettingsForCwd(options.cwd),
        options.resumeId ? resolveSessionPath(options.resumeId) : Promise.resolve(null),
      ]);
      if (options.resumeId && !sessionPath) throw new Error(`OMP session not found: ${options.resumeId}`);
      const sessionManager = sessionPath
        ? await SessionManager.open(sessionPath, undefined)
        : SessionManager.create(options.cwd, undefined);
      // createAgentSession은 Model 객체를 받는다. "provider/modelId" 선택자를 카탈로그에서 풀고,
      // 없으면 조용히 기본 모델로 넘어가지 않고 실패한다.
      let model;
      if (options.model) {
        const slash = options.model.indexOf("/");
        model = slash > 0
          ? runtime.modelRegistry.find(options.model.slice(0, slash), options.model.slice(slash + 1))
          : undefined;
        if (!model) throw new Error(`OMP model not found: ${options.model}`);
      }
      const { session } = await createAgentSession({
        cwd: options.cwd,
        agentDir: runtime.agentDir,
        settings,
        sessionManager,
        modelRegistry: runtime.modelRegistry,
        ...(model ? { model } : {}),
        ...(options.thinking ? { thinkingLevel: options.thinking as never } : {}),
        hasUI: false,
      });
      return new OmpRuntimeSession(session.sessionId, session);
    },
  };
}
