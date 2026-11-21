import type { ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { beforeModelAbort, directFallbackModel, modelRoleSelector, sameModelRoutes } from "./model-routes";
// 런타임 패키지는 legacy-pi 확장 loader가 host SDK 경로로 재작성하므로 아래에서 지연 import한다.

/**
 * 통역 자리(2026-10-30 사용자 결정, 2026-11-20 입력 통역 철거): Main의 비한국어 답 번역(korean-reply-guard)이 쓰는
 * 모델 호출. `modelRoles.interpreter`를 쓰고, 그 slot이 없는 설치는 예전처럼 `tiny`를 쓴다.
 */
export const INTERPRETER_ROLE = "interpreter";

/** 외부 모델로 보내지 않는 비밀처럼 보이는 글. */
export const SECRET_PATTERN = /(?:^|[\s"'`:])(?:password|passwd|api[_ -]?key|bearer|secret|token|credential|client[_ -]?secret)\b|(?:비밀번호|자격증명|인증키|토큰)|(?:sk-[A-Za-z0-9_-]{12,})|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:gh[opusr]_|github_pat_)[A-Za-z0-9_-]{12,}/i;

/**
 * 통역 모델로 한 번 호출해 텍스트 답을 돌려준다. 출력 한도에서 끊기면 끊긴 답과 `truncated`를 함께 준다.
 * An explicit alternate takes over on a usage limit, within the caller's deadline.
 */
export async function interpret(prompt: string, purpose: string, ctx: ExtensionContext, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const { completeSimple, isUsageLimitOutcome } = await import("@oh-my-pi/pi-ai");
  const selector = await modelRoleSelector(ctx.cwd, INTERPRETER_ROLE);
  const role = selector ? INTERPRETER_ROLE : "tiny";
  const primary = ctx.models.resolve(`@${role}`);
  const configured = await directFallbackModel(ctx, "interpreterFallback");
  const fallback = configured && !(primary && configured.provider === primary.provider && configured.id === primary.id) ? configured : undefined;
  if (!primary && !fallback) throw new Error(`modelRoles.${role} 모델을 해석하지 못했습니다.`);
  const sessionId = ctx.sessionManager.getSessionId();
  const models = primary ? [primary] : [fallback!];
  let lastError: unknown;
  for (let index = 0; index < models.length; index++) {
    const model = models[index]!;
    signal.throwIfAborted();
    try {
      const response = await beforeModelAbort(signal, async () => {
        if (!(await ctx.modelRegistry.getApiKey(model, sessionId, { signal }))) {
          throw new Error(`${model.provider}/${model.id} 모델 자격을 찾지 못했습니다.`);
        }
        signal.throwIfAborted();
        return completeSimple(model, {
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        }, { apiKey: ctx.modelRegistry.resolver(model, sessionId), sessionId, maxTokens: model.maxTokens ?? undefined, disableReasoning: true, signal });
      });
      (ctx.sessionManager as Partial<Pick<SessionManager, "appendModelUsage">>).appendModelUsage?.({
        purpose, role: model === fallback ? "interpreterFallback" : role, api: model.api, provider: model.provider, model: model.id,
        usage: response.usage, stopReason: response.stopReason, errorMessage: response.errorMessage,
      }, { sessionId, parentId: ctx.sessionManager.getLeafId() });
      signal.throwIfAborted();
      const truncated = response.stopReason === "length";
      if (response.stopReason !== "stop" && !truncated) {
        throw new Error(response.errorMessage ?? `Model stopped: ${response.stopReason}`);
      }
      const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
      if (!text) throw new Error(`${role} 모델이 빈 답을 반환했습니다.`);
      return { text, truncated };
    } catch (error) {
      lastError = error;
      if (signal.aborted) throw error;
      if (index === 0 && primary && isUsageLimitOutcome(undefined, error instanceof Error ? error.message : String(error))) {
        if (fallback) {
          models.push(fallback);
          continue;
        }
        for (const route of await sameModelRoutes(ctx.cwd, `${primary.provider}/${primary.id}`)) {
          const next = ctx.models.resolve(route);
          if (next) models.push(next);
        }
      }
    }
  }
  throw lastError;
}
