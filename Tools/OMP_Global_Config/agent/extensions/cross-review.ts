import { chmodSync, mkdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
// 런타임 패키지는 legacy-pi 확장 loader가 host SDK 경로로 재작성하므로 아래에서 지연 import한다.
import {
  REVIEW_SYSTEM,
  REVIEW_TIMEOUT_MS,
  ReviewerCallError,
  SLOT,
  ledgerPath,
  runResolve,
  runReview,
  snapshotRoot,
  spawnExec,
  type Family,
  type ReviewDeps,
  type ReviewInput,
  type ResolveInput,
} from "./lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords } from "./lib/routing-ledger";

/**
 * Main 전용 계열 교차검증 도구. Maker child의 tools 목록(agents/maker.md)에 없어 child는 받지 않고, 이 파일도 subagent
 * 세션에서는 실행을 거절한다. 모델 호출은 skim의 completeRole과 같은 경로(역할 slot 해석 → completeSimple → 비용 장부)이며
 * 대화·사용자 프로필 없이 고정 system 한 줄 + 변경 본문 한 통만 보낸다.
 */

const OPENAI_PROVIDERS: Record<string, true> = { "openai-codex": true, openai: true };

/** slot이 가리키는 모델을 해석해 한 번 부른다(reasoning high, 10분 제한). 응답이 돌아온 시도는 비용 장부에 남긴다. */
async function completeReviewer(family: Family, prompt: string, ctx: ExtensionContext, signal: AbortSignal): Promise<{ model: string; text: string }> {
  const slot = SLOT[family];
  const [{ findScopedSettings }, { completeSimple }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"), import("@oh-my-pi/pi-ai"),
  ]);
  const selector = findScopedSettings(ctx.cwd)?.getModelRole(slot);
  if (!selector) throw new ReviewerCallError(`modelRoles.${slot} is not configured.`, `@${slot}`);
  const model = ctx.models.resolve(`@${slot}`);
  if (!model) throw new ReviewerCallError(`Could not resolve modelRoles.${slot} (${selector}).`, selector);
  const name = `${model.provider}/${model.id}`;
  // 같은 계열 모델이 slot에 들어가 있으면 교차검증이 아니므로 호출하지 않는다.
  const ok = family === "anthropic" ? model.provider === "anthropic" : Object.hasOwn(OPENAI_PROVIDERS, model.provider);
  if (!ok) throw new ReviewerCallError(`modelRoles.${slot} resolved to ${name}, which is not a ${family} model.`, name);
  const sessionId = ctx.sessionManager.getSessionId();
  if (!(await ctx.modelRegistry.getApiKey(model, sessionId, { signal }))) throw new ReviewerCallError(`No credentials for ${name}.`, name);
  const response = await completeSimple(model, {
    systemPrompt: [REVIEW_SYSTEM],
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, {
    apiKey: ctx.modelRegistry.resolver(model, sessionId), sessionId, maxTokens: model.maxTokens ?? undefined,
    reasoning: "high" as never, // Effort은 const enum이라 문자열을 단언한다.
    signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]),
  });
  // 응답이 돌아온 시도는 오류·빈 답도 청구되므로 먼저 장부에 남긴다(skim completeRole과 같다).
  (ctx.sessionManager as Partial<Pick<SessionManager, "appendModelUsage">>).appendModelUsage?.({
    purpose: "cross-review", role: slot, api: model.api, provider: model.provider, model: model.id,
    usage: response.usage, stopReason: response.stopReason, errorMessage: response.errorMessage,
  }, { sessionId, parentId: ctx.sessionManager.getLeafId() });
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
  // 출력 한도·오류로 끝나도 모델이 낸 부분 답은 원문으로 남긴다(통과는 못 한다).
  if (response.stopReason !== "stop") throw new ReviewerCallError(response.errorMessage ?? `Model stopped: ${response.stopReason}`, name, text || undefined);
  if (!text) throw new ReviewerCallError(`${name} returned an empty answer.`, name);
  return { model: name, text };
}

function reviewDeps(ctx: ExtensionContext, signal: AbortSignal): ReviewDeps {
  const path = ledgerPath();
  const ledger = createRoutingLedger(path);
  const current = ctx.models.current() ?? ctx.model;
  mkdirSync(snapshotRoot(), { recursive: true, mode: 0o700 });
  chmodSync(snapshotRoot(), 0o700);
  return {
    cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), mainModel: current ? `${current.provider}/${current.id}` : undefined,
    exec: spawnExec(signal), readAll: () => readCrossReviewRecords(path), append: (record) => ledger.append(record),
    snapshotRoot: snapshotRoot(),
    complete: (family, prompt, attempt) => completeReviewer(family, prompt, ctx, attempt),
  };
}

export interface CrossReviewParams {
  action: string;
  files?: string[];
  acceptance?: string;
  authors?: string[];
  highRisk?: boolean;
  previousReviewId?: string;
  reviewId?: string;
  resolutions?: { id: string; status: string; evidence: string }[];
}

export async function executeCrossReview(params: CrossReviewParams, ctx: ExtensionContext, signal: AbortSignal): Promise<unknown> {
  if (ctx.agent?.kind === "sub") throw new Error("cross_review is Main-only.");
  const deps = reviewDeps(ctx, signal);
  if (params.action === "review") {
    const input: ReviewInput = {
      files: params.files ?? [], acceptance: params.acceptance ?? "", authors: params.authors ?? [],
      highRisk: params.highRisk, previousReviewId: params.previousReviewId,
    };
    return runReview(input, deps, signal);
  }
  if (params.action === "resolve") {
    if (!params.reviewId) throw new Error("resolve requires reviewId.");
    const input: ResolveInput = { reviewId: params.reviewId, resolutions: params.resolutions ?? [] };
    return runResolve(input, deps);
  }
  throw new Error(`Unknown action ${JSON.stringify(params.action)}; use "review" or "resolve".`);
}

export default function crossReview(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "cross_review", label: "Cross Review", loadMode: "essential", approval: "read",
    description: "Main 전용 계열 교차검증. action=review: files(cwd 기준 상대 경로)의 변경을 반대 계열 reviewer(Anthropic 저자→Astra, OpenAI·그 밖의 저자→Opus)가 acceptance 기준으로 적대적으로 읽고 {reviewId, reviewer 모델, round, triggers, findings[]}를 돌려준다. authors는 코드를 쓴 모델 selector 또는 \"main\"이며 두 계열이면 둘 다 돌린다. previousReviewId를 주면 2회차(1회차 이후 delta만)이고 3회차는 거절한다. 파일 내용은 OpenAI 또는 Anthropic으로 전송되며 비밀 이름·내용·바이너리·큰 입력은 거절/제외한다. action=resolve: reviewId 체인의 모든 finding에 {id, status fixed|refuted|limit, evidence}가 있어야 pass:true이고 그 시점 파일 내용(git blob)이 통과 지문으로 기록된다. git_finalize는 trigger·표본에 걸린 코드 파일에 이 통과 기록을 요구한다. reviewer의 PASS 표현은 근거가 아니다.",
    parameters: z.object({
      action: z.string(),
      files: z.array(z.string()).optional(),
      acceptance: z.string().optional(),
      authors: z.array(z.string()).optional(),
      highRisk: z.boolean().optional(),
      previousReviewId: z.string().optional(),
      reviewId: z.string().optional(),
      resolutions: z.array(z.object({ id: z.string(), status: z.string(), evidence: z.string() })).optional(),
    }) as never,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const result = await executeCrossReview(params as CrossReviewParams, ctx, signal ?? new AbortController().signal);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });
}
