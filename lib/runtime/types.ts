// CUELO 외부 Maker 런타임 계약. core patch(`Tools/OMP_Global_Config/patches/apply-core-patch.mjs`의
// "task maker external runtime bridge")가 `CUELO_RUNTIME_DIR/index.ts`를 동적 import해 이 형태로 쓴다.
// core 쪽 타입 사본과 모양이 같아야 한다.

export type ExternalMakerEngine = "claude";

export type ExternalMakerEvent =
  | { type: "session_started"; sessionId: string; engine: ExternalMakerEngine }
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_started"; id: string; name: string; input: unknown }
  | { type: "tool_completed"; id: string; output: string; isError: boolean }
  | { type: "file_changed"; path: string }
  | { type: "usage"; input: number; cachedInput: number; cacheWrite: number; output: number }
  | { type: "turn_completed"; stopReason: "stop" | "aborted" | "error"; text: string }
  | { type: "error"; message: string };

/** `createAuthGatewayRouter()`(pi-ai auth-gateway)의 결과. core가 자기 AuthStorage·해석된 모델로 만든다. */
export interface GatewayRouter {
  route(req: Request, peer: string): Promise<Response>;
  close(): void;
}

export interface ExternalMakerSessionOptions {
  cwd: string;
  /** core가 최종 해석한 모델 id(표시·`--model` 값). 실제 라우팅은 gateway router가 고정 모델로 한다. */
  model: string;
  /** core의 최종 thinking level(`off`|`minimal`|`low`|`medium`|`high`|`xhigh`|`max`). */
  thinking?: string;
  /** 렌더된 maker SOP·context(subagent system prompt). */
  systemPrompt: string;
  /** 발주 브리프 원문. OWNED_PATHS를 여기서 읽는다. */
  assignment: string;
  /** 활성 OMP agent 디렉터리(RULES.md·rules/). */
  agentDir: string;
  /** 자식 셸용으로 거른 env(core `filterChildShellEnv`). */
  env: Record<string, string>;
  createGatewayRouter(): GatewayRouter;
}

export interface ExternalMakerSession {
  readonly id: string;
  readonly engine: ExternalMakerEngine;
  prompt(message: string): Promise<void>;
  abort(): Promise<void>;
  onEvent(handler: (event: ExternalMakerEvent) => void): () => void;
  /** Claude 프로세스 트리 종료를 관측한 뒤에만 resolve한다. */
  dispose(): Promise<void>;
}

export interface ExternalMakerRuntime {
  readonly engine: ExternalMakerEngine;
  createSession(options: ExternalMakerSessionOptions): Promise<ExternalMakerSession>;
}
