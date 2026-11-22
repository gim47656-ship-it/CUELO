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
 * 답변 통역 전용: 비밀 "값"처럼 생긴 글만 막는다. `token`, `credential` 같은 단어가 나오기만 해도 막던
 * SECRET_PATTERN은 토큰 갱신을 설명하는 답까지 번역을 생략시켰다(2026-11-22 사용자 보고).
 * 막는 모양(놓치는 쪽보다 가끔 번역을 생략하는 쪽을 택한다): 비밀 이름으로 끝나는 식별자(`password`, `idToken`,
 * `APIKey`, `refresh_token`, `OPENAI_API_KEY`처럼 앞부분은 무엇이든) 뒤의 `:`/`=`와 비어 있지 않은 값.
 * 값의 길이와 따옴표 안 내용(아포스트로피, 백슬래시, 줄바꿈)은 따지지 않고, 빈 따옴표(`""`, `''`)만 값으로 치지 않는다.
 * 그래서 `monkey = banana`처럼 이름 꼬리가 같은 보통 대입도 번역을 생략한다. 그 밖에 `Bearer` 토큰(대소문자 무관),
 * `sk-`·GitHub 토큰(앞에 영숫자가 없으면 `_` 같은 강조 기호 뒤도), 개인키 블록, `eyJ`로 시작하는 JWT(서명 없는 것 포함).
 * 2026-11-22 교차 검토 4라운드가 길이·따옴표·camelCase 경계를 좁힐 때마다 새 빈틈을 찾아 이 모양으로 정했다.
 */
const SECRET_NAME = String.raw`[A-Za-z0-9_-]*(?:key|secret|token|passw(?:or)?d|pwd|credential|authorization)|비밀번호|토큰|인증키`;
export const TRANSLATION_SECRET_PATTERN = new RegExp(
  [
    String.raw`(?:${SECRET_NAME})["']?\s*[:=]\s*(?!["']["'])["']?\S`,
    String.raw`\bbearer\s+[A-Za-z0-9._~+/=-]{12,}`,
    String.raw`(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{12,}`,
    String.raw`(?<![A-Za-z0-9])(?:gh[opusr]_|github_pat_)[A-Za-z0-9_-]{12,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
    String.raw`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{2,}\.(?:[A-Za-z0-9_-]{8,})?`,
    String.raw`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  ].join("|"),
  "i",
);

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
