import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/**
 * core의 native JEV를 확장에서 쓰는 공통 틀. mcp-selection과 docmap-route가 같이 쓴다.
 * judge 역할의 첫 후보가 native가 아니면 판정하지 않고, 세션 모델 fallback을 붙이지 않으며(sessionModel 미전달),
 * 체인이 native가 아닌 후보를 내면 그 후보에서는 실행하지 않는다.
 */

export interface JudgeAnswers {
  answers: Record<string, { type: string; choice?: string; bool?: number } | undefined>;
}

/** 판정기 seam. 기본 구현은 native 후보에서만 판정을 실행한다. */
export interface NativeJudge {
  judge(request: { state: unknown; questions: Record<string, unknown> }, options?: { signal?: AbortSignal }): Promise<JudgeAnswers>;
}

export type JudgeKind = "native" | "local" | "online";

interface ChainJudgeLike {
  withCandidate<T>(run: (judge: NativeJudge, kind: JudgeKind) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

/** 기존 core 판정 모듈. 런타임 값은 host가 해석하고 타입은 여기 필요한 만큼만 둔다. */
export interface CoreJudgmentModules {
  judgment: {
    resolveJudge(deps: {
      settings: unknown;
      registry: unknown;
      sessionId?: string;
      purpose: string;
      onUsage?: unknown;
    }): ChainJudgeLike;
    hasNativeJudge(settings: unknown, registry: unknown): boolean;
    journalJudgmentUsage?(manager: unknown): unknown;
  };
  settings: { findScopedSettings(cwd?: string): unknown };
}

export async function defaultLoadCore(): Promise<CoreJudgmentModules> {
  // 지연 import: 테스트 미러에는 node_modules가 없고, 런타임은 host 번들로 해석한다(jev-runtime과 같다).
  const [judgment, settings] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/judgment"),
    import("@oh-my-pi/pi-coding-agent/config/settings"),
  ]);
  return { judgment, settings } as unknown as CoreJudgmentModules;
}

export async function resolveNativeJudge(ctx: ExtensionContext, loadCore: () => Promise<CoreJudgmentModules>, purpose: string): Promise<NativeJudge> {
  const { judgment, settings: settingsModule } = await loadCore();
  const settings = settingsModule.findScopedSettings(ctx.cwd);
  if (!settings) throw new Error("세션 설정을 찾지 못함");
  if (!judgment.hasNativeJudge(settings, ctx.modelRegistry)) throw new Error("judge 역할 첫 후보가 native JEV가 아님");
  const chain = judgment.resolveJudge({
    settings,
    registry: ctx.modelRegistry,
    sessionId: ctx.sessionManager?.getSessionId?.(),
    purpose,
    onUsage: judgment.journalJudgmentUsage?.(ctx.sessionManager),
  });
  return {
    judge: (request, options) =>
      chain.withCandidate(
        (candidate, kind) =>
          kind === "native" ? candidate.judge(request, options) : Promise.reject(new Error(`native가 아닌 judge 후보(${kind})`)),
        options,
      ),
  };
}

/** 취소·제한 시간이 판정보다 먼저 끝났음을 나타내는 race 표지. */
export const JUDGE_STOPPED: unique symbol = Symbol("judge-stopped");

/**
 * `signal`이 끊기면 바로 돌아오는 promise. provider가 signal을 무시해도 호출부가 `Promise.race`로 제때 빠져나온다.
 */
export function stoppedBy(signal: AbortSignal): Promise<typeof JUDGE_STOPPED> {
  const stopped = Promise.withResolvers<typeof JUDGE_STOPPED>();
  if (signal.aborted) stopped.resolve(JUDGE_STOPPED);
  else signal.addEventListener("abort", () => stopped.resolve(JUDGE_STOPPED), { once: true });
  return stopped.promise;
}
