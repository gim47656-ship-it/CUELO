import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
// 런타임 패키지는 legacy-pi 확장 loader가 host SDK 경로로 재작성하므로 아래에서 지연 import한다.
import {
  authorFamily,
  REVIEW_SYSTEM,
  REVIEW_TIMEOUT_MS,
  ReviewerCallError,
  earlyReviewNotice,
  SLOT,
  ledgerPath,
  runResolve,
  runReview,
  snapshotRoot,
  spawnExec,
  type Lane,
  type ReviewDeps,
  type ReviewInput,
  type ReviewProgress,
  type ResolveInput,
} from "./lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords } from "./lib/routing-ledger";
import { onSessionLifecycle } from "./lib/session-identity";

/**
 * 계열 교차검증 도구. review(probe·delta 라운드 포함)는 Main과 Maker child(agents/maker.md tools 목록) 모두 부를 수 있고,
 * git_finalize가 믿는 통과 지문을 남기는 resolve는 Main 전용이라 subagent 세션에서는 거절한다. 모델 호출은 skim의
 * completeRole과 같은 경로(역할 slot 해석 → completeSimple → 비용 장부)이며 대화·사용자 프로필 없이 고정 system 한 줄 +
 * 변경 본문 한 통만 보낸다.
 */

const OPENAI_PROVIDERS: Record<string, true> = { "openai-codex": true, openai: true };

/** slot이 가리키는 모델을 해석해 한 번 부른다(reasoning high, 10분 제한). 응답이 돌아온 시도는 비용 장부에 남긴다. */
/** system·purpose는 slop_check가 같은 slot 해석·호출·비용 장부 경로를 재사용할 때만 바꾼다. 기본값은 cross_review 그대로다. slot은 자문 대체(crossReviewAdvisoryFallback)가 lane의 기본 slot 대신 부를 때만 준다. */
export async function completeReviewer(
  lane: Lane, prompt: string, ctx: ExtensionContext, signal: AbortSignal, options: { system?: string; purpose?: string; slot?: string } = {},
): Promise<{ model: string; text: string; usage: { input: number; output: number; cacheRead: number; cost: number } }> {
  const slot = options.slot ?? SLOT[lane];
  const [{ findScopedSettings }, { completeSimple }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"), import("@oh-my-pi/pi-ai"),
  ]);
  const selector = findScopedSettings(ctx.cwd)?.getModelRole(slot);
  if (!selector) throw new ReviewerCallError(`modelRoles.${slot} is not configured.`, `@${slot}`);
  const model = ctx.models.resolve(`@${slot}`);
  if (!model) throw new ReviewerCallError(`Could not resolve modelRoles.${slot} (${selector}).`, selector);
  const name = `${model.provider}/${model.id}`;
  // 필수 자리는 slot 이름의 계열 모델이어야 교차검증이다. 자문 자리는 provider와 무관하다.
  const ok = lane === "advisory" || (lane === "anthropic" ? model.provider === "anthropic" : Object.hasOwn(OPENAI_PROVIDERS, model.provider));
  if (!ok) throw new ReviewerCallError(`modelRoles.${slot} resolved to ${name}, which is not a ${lane} model.`, name);
  const sessionId = ctx.sessionManager.getSessionId();
  if (!(await ctx.modelRegistry.getApiKey(model, sessionId, { signal }))) throw new ReviewerCallError(`No credentials for ${name}.`, name);
  const response = await completeSimple(model, {
    systemPrompt: [options.system ?? REVIEW_SYSTEM],
    messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
  }, {
    apiKey: ctx.modelRegistry.resolver(model, sessionId), sessionId, maxTokens: model.maxTokens ?? undefined,
    reasoning: "high" as never, // Effort은 const enum이라 문자열을 단언한다.
    signal: AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]),
  });
  // 응답이 돌아온 시도는 오류·빈 답도 청구되므로 먼저 장부에 남긴다(skim completeRole과 같다).
  (ctx.sessionManager as Partial<Pick<SessionManager, "appendModelUsage">>).appendModelUsage?.({
    purpose: options.purpose ?? "cross-review", role: slot, api: model.api, provider: model.provider, model: model.id,
    usage: response.usage, stopReason: response.stopReason, errorMessage: response.errorMessage,
  }, { sessionId, parentId: ctx.sessionManager.getLeafId() });
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
  // 출력 한도·오류로 끝나도 모델이 낸 부분 답은 원문으로 남긴다(통과는 못 한다).
  if (response.stopReason !== "stop") throw new ReviewerCallError(response.errorMessage ?? `Model stopped: ${response.stopReason}`, name, text || undefined);
  if (!text) throw new ReviewerCallError(`${name} returned an empty answer.`, name);
  return { model: name, text, usage: { input: response.usage.input, output: response.usage.output, cacheRead: response.usage.cacheRead, cost: response.usage.cost?.total ?? 0 } };
}

/** 자문 slot이 가리키는 모델(provider/id). 저자가 그 모델 자체일 때 자문 자리를 빼는 데만 쓰며, 풀 수 없으면 자문 자리는 그대로 붙고 호출이 실패로 기록된다. */
export function advisoryModelOf(ctx: ExtensionContext): string | undefined {
  const model = ctx.models.resolve(`@${SLOT.advisory}`);
  return model ? `${model.provider}/${model.id}` : undefined;
}

/** 자문 reviewer 한 번의 대체 slot. 설정이 없으면 자문은 대체 없이 기록만 한다(고정 모델로 넘어가지 않는다). */
export const ADVISORY_FALLBACK_SLOT = "crossReviewAdvisoryFallback";

/**
 * 자문 대체 설정. slot이 없으면 빈 객체(대체 없음)다. 설정했으면 해석한 provider/id(못 풀면 설정한 selector)와, 대체가 이 라운드의 필수 reviewer와 겹치지
 * 않게 보는 필수 자리 slot 모델을 돌려준다. 해석·자격·입력이 맞지 않으면 대체 호출이 그 모델 이름으로 실패한다.
 */
export async function advisoryFallbackOf(ctx: ExtensionContext): Promise<{ advisoryFallbackModel?: string; requiredModels?: Partial<Record<Lane, string>> }> {
  const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const selector = findScopedSettings(ctx.cwd)?.getModelRole(ADVISORY_FALLBACK_SLOT);
  if (selector === undefined) return {};
  const named = (slot: string): string | undefined => { const model = ctx.models.resolve(`@${slot}`); return model ? `${model.provider}/${model.id}` : undefined; };
  const requiredModels: Partial<Record<Lane, string>> = {};
  for (const lane of ["openai", "anthropic"] as const) { const name = named(SLOT[lane]); if (name) requiredModels[lane] = name; }
  // 설정했지만 비었거나 풀리지 않으면 selector(빈 값이면 slot 이름)를 그대로 이름으로 써, 대체 호출이 그 이름으로 실패한다(설정이 없는 것과 다르다).
  return { advisoryFallbackModel: named(ADVISORY_FALLBACK_SLOT) ?? (selector || `@${ADVISORY_FALLBACK_SLOT}`), requiredModels };
}

async function reviewDeps(ctx: ExtensionContext, signal: AbortSignal, notify?: (text: string) => void): Promise<ReviewDeps> {
  const path = ledgerPath();
  const ledger = createRoutingLedger(path);
  const current = ctx.models.current() ?? ctx.model;
  mkdirSync(snapshotRoot(), { recursive: true, mode: 0o700 });
  chmodSync(snapshotRoot(), 0o700);
  const fallback = await advisoryFallbackOf(ctx);
  return {
    cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), mainModel: current ? `${current.provider}/${current.id}` : undefined, advisoryModel: advisoryModelOf(ctx),
    exec: spawnExec(signal), readAll: () => readCrossReviewRecords(path), append: (record) => ledger.append(record),
    snapshotRoot: snapshotRoot(),
    // 자문 호출은 review가 돌아온 뒤에도 기한까지 돈다. ctx는 그 세션의 것이라 비용 장부도 같은 세션에 남는다.
    complete: (family, prompt, attempt) => completeReviewer(family, prompt, ctx, attempt),
    ...fallback,
    ...(fallback.advisoryFallbackModel ? { completeAdvisoryFallback: (prompt: string, attempt: AbortSignal) => completeReviewer("advisory", prompt, ctx, attempt, { slot: ADVISORY_FALLBACK_SLOT }) } : {}),
    ...(notify ? { notify } : {}),
  };
}

export interface CrossReviewParams {
  action: string;
  files?: string[];
  acceptance?: string;
  authors?: string[];
  highRisk?: boolean;
  previousReviewId?: string;
  base?: string;
  inputs?: string[];
  references?: string[];
  probeResults?: { findingId: string; command: string; exitCode: number; output: string }[];
  reviewId?: string;
  resolutions?: { id: string; status: string; evidence: string }[];
  unreviewedAcknowledgements?: { path: string; evidence: string }[];
}

/** 진행 알림을 받는 도구 update 콜백(core의 onUpdate와 같은 모양). review는 reviewer 상태, resolve는 자문 대기 한 줄을 보낸다. */
export type CrossReviewUpdate = (partial: { content: { type: "text"; text: string }[]; details: { progress: ReviewProgress } | { resolveProgress: string } }) => void;

export async function executeCrossReview(
  params: CrossReviewParams, ctx: ExtensionContext, signal: AbortSignal,
  makeDeps: (ctx: ExtensionContext, signal: AbortSignal) => ReviewDeps | Promise<ReviewDeps> = reviewDeps,
  onUpdate?: CrossReviewUpdate,
): Promise<unknown> {
  const sub = ctx.agent?.kind === "sub";
  if (sub && params.action === "resolve") throw new Error("cross_review resolve is Main-only: the pass git_finalize trusts is recorded only by Main. Report the reviewId chain with a proposed status (fixed|refuted|limit) and evidence for every finding; Main checks it and resolves the chain.");
  // subagent 세션에서 "main"은 Main이 아니라 이 child의 현재 모델로 풀리므로 뜻이 모호하다. 저자 selector를 직접 받는다.
  if (sub && params.action === "review" && (params.authors ?? []).some((author) => author.trim().toLowerCase() === "main")) {
    throw new Error("authors \"main\" is ambiguous in a subagent session; pass your own model selector (the provider/model you run as, e.g. anthropic/claude-sonnet-...) instead.");
  }
  // subagent 세션의 1회차는 선언한 저자를 그대로 믿지 않는다: 자기 계열 저자를 빼고 다른 계열만 적으면 같은 계열
  // reviewer가 붙어 교차검증이 무너진다. 후속 라운드의 reviewer 계열은 1회차에서 정해지므로 1회차만 본다.
  if (sub && params.action === "review" && !params.previousReviewId) {
    const current = ctx.models?.current?.() ?? ctx.model;
    if (!current) throw new Error("This subagent session's own model could not be resolved, so the declared authors cannot be checked against it; refusing rather than guessing.");
    const own = `${current.provider}/${current.id}`;
    const family = authorFamily(own);
    if (!(params.authors ?? []).some((author) => author.trim() !== "" && authorFamily(author.trim()) === family)) {
      throw new Error(`authors must include this session's own model: it runs ${own} (${family} family), but authors ${JSON.stringify(params.authors ?? [])} list no ${family} model. List your own model selector so the reviewer is the other family.`);
    }
  }
  const made = await makeDeps(ctx, signal);
  // reviewer 시작·끝을 도구의 진행 채널로 알린다. runReview는 결과를 돌려준 뒤에는 부르지 않는다.
  const deps: ReviewDeps = onUpdate ? { ...made, onProgress: (progress) => onUpdate({ content: [{ type: "text", text: progress.text }], details: { progress } }) } : made;
  if (params.action === "review") {
    const input: ReviewInput = {
      files: params.files ?? [], acceptance: params.acceptance ?? "", authors: params.authors ?? [],
      highRisk: params.highRisk, previousReviewId: params.previousReviewId, base: params.base, inputs: params.inputs, references: params.references, probeResults: params.probeResults,
    };
    return runReview(input, deps, signal);
  }
  if (params.action === "resolve") {
    if (!params.reviewId) throw new Error("resolve requires reviewId.");
    const input: ResolveInput = { reviewId: params.reviewId, resolutions: params.resolutions ?? [], unreviewedAcknowledgements: params.unreviewedAcknowledgements };
    return runResolve(input, onUpdate ? { ...deps, onProgress: (text) => onUpdate({ content: [{ type: "text", text }], details: { resolveProgress: text } }) } : deps);
  }
  throw new Error(`Unknown action ${JSON.stringify(params.action)}; use "review" or "resolve".`);
}

/** edit·write 호출이 건드린 파일의 절대 경로. edit는 path 인자와 입력 본문의 `[경로#TAG]` 머리에서 읽는다. */
export function editedPaths(toolName: string, input: unknown, cwd: string): string[] {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const tokens: string[] = [];
  if (toolName === "write" && typeof record.path === "string") tokens.push(record.path);
  else if (toolName === "edit") {
    if (typeof record.path === "string") tokens.push(record.path);
    if (typeof record.input === "string") for (const match of record.input.matchAll(/^\[(.+?)#[0-9A-F]{4}\]/gm)) tokens.push(match[1]!);
  }
  return [...new Set(tokens.map((token) => (isAbsolute(token) ? resolve(token) : resolve(cwd, token))))];
}

export default function crossReview(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "cross_review", label: "Cross Review", loadMode: "essential", approval: "read",
    description: "Cross-family review. Read rule://cross-review-procedure before calling. review: Main and Maker; resolve: Main only. review: files = changed files relative to cwd, acceptance = acceptance criteria, authors = author model selectors. A subagent session cannot use main, and its first authors must include its own model family. Uses the configured opposite-family required reviewer and the advisory route. initial uses files, acceptance, authors; delta uses previousReviewId (omitted files/acceptance carry over; a delta with no change is refused). probe uses previousReviewId and probeResults[{findingId, command, exitCode, output}]. base is only for the first round of committed changes; inputs are contracts bound to the pass; references are context. Files and excerpts go to the reviewer provider, with secret/excluded-path and size limits. A Maker reports the reviewId chain and per-finding evidence to Main and never resolves. Main resolve takes reviewId and resolutions[{id, status: fixed|refuted|limit, evidence}] for every finding. unreviewedAcknowledgements[{path, evidence}]: one per unreviewed code file, only when no non-probe round remains or the last round skipped policy-excluded files. Detailed limits, security, late advisory and unreviewed-change handling follow the referenced rule.",
    parameters: z.object({
      action: z.string(),
      files: z.array(z.string()).optional(),
      acceptance: z.string().optional(),
      authors: z.array(z.string()).optional(),
      highRisk: z.boolean().optional(),
      previousReviewId: z.string().optional(),
      base: z.string().optional(),
      inputs: z.array(z.string()).optional(),
      references: z.array(z.string()).optional(),
      probeResults: z.array(z.object({ findingId: z.string(), command: z.string(), exitCode: z.number(), output: z.string() })).optional(),
      reviewId: z.string().optional(),
      resolutions: z.array(z.object({ id: z.string(), status: z.string(), evidence: z.string() })).optional(),
      unreviewedAcknowledgements: z.array(z.object({ path: z.string(), evidence: z.string() })).optional(),
    }) as never,
    async execute(_id, params, signal, onUpdate, ctx) {
      // 늦게 끝난 자문 finding은 세션에 알린다: 도는 중이면 다음 단계 경계에, 쉬는 중이면 대화에 바로 보이게(턴을 시작하지 않는다) 남긴다.
      const notify = (text: string) => {
        pi.sendMessage({ customType: "cross-review-advisory", content: text, display: true, attribution: "agent" }, ctx.isIdle?.() ? undefined : { deliverAs: "aside" });
      };
      const result = await executeCrossReview(params as CrossReviewParams, ctx, signal ?? new AbortController().signal, (c, s) => reviewDeps(c, s, notify), onUpdate as CrossReviewUpdate | undefined);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  // 편집 직후 조기 알림(게이트 아님): marker에 맞는 코드 파일은 git_finalize 전에 cross_review가 필요하다는 것을 파일당 세션에 한 번 알린다.
  // 알림을 낸 파일만 기록하므로, 처음에는 marker가 없다가 나중에 걸리는 파일도 그때 한 번 알린다.
  const noticed = new Set<string>();
  const inflight = new Set<string>();
  onSessionLifecycle(pi, { start: () => { noticed.clear(); inflight.clear(); } });
  pi.on("tool_result", async (event, ctx) => {
    // 알림은 보조다: 경로 읽기·git·원장·전달 어느 단계의 실패도 편집 흐름으로 번지지 않고, 전달에 실패한 파일은 다음 편집에서 다시 알릴 수 있다.
    try {
      if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
      if (!(pi.getActiveTools?.().includes("cross_review") ?? true)) return;
      for (const path of editedPaths(event.toolName, event.input, ctx.cwd)) {
        if (noticed.has(path) || inflight.has(path)) continue;
        inflight.add(path);
        try {
          const text = await earlyReviewNotice(ctx.cwd, path, spawnExec(), () => readCrossReviewRecords(ledgerPath()));
          if (!text) continue;
          pi.sendMessage({ customType: "cross-review-notice", content: text, display: false, attribution: "agent" }, { deliverAs: "aside" });
          noticed.add(path);
        } finally {
          inflight.delete(path);
        }
      }
    } catch { /* 알림 실패는 편집 결과에 영향을 주지 않는다. */ }
  });
}
