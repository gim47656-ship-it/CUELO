export type EngineId = "omp" | "codex" | "claude";

export interface RuntimeSessionOptions {
  cwd: string;
  model?: string;
  thinking?: string;
  resumeId?: string;
}

export type AgentEvent =
  | { type: "session_started"; sessionId: string; engine: EngineId }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_started"; id: string; name: string; input: unknown }
  | { type: "tool_completed"; id: string; output: string; isError: boolean }
  | { type: "file_changed"; path: string }
  | { type: "usage"; input: number; cachedInput: number; cacheWrite: number; output: number }
  | { type: "turn_completed"; stopReason: "stop" | "aborted" | "error"; text: string }
  | { type: "error"; message: string };

export interface AgentRuntimeSession {
  readonly id: string;
  readonly engine: EngineId;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  onEvent(handler: (e: AgentEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface AgentRuntime {
  readonly engine: EngineId;
  createSession(o: RuntimeSessionOptions): Promise<AgentRuntimeSession>;
}
