import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
import { helperAttemptRecorder } from "./lib/helper-usage";
import { beforeModelAbort } from "./lib/model-routes";
import { createRoutingLedger, readCrossReviewRecords } from "./lib/routing-ledger";
import { onSessionLifecycle } from "./lib/session-identity";
import type { TurnEndNotices } from "./turn-end-guard";

/**
 * 계열 교차검증 도구. review(probe·delta 라운드 포함)는 Main과 Maker child(agents/maker.md tools 목록) 모두 부를 수 있고,
 * git_finalize가 믿는 통과 지문을 남기는 resolve는 Main 전용이라 subagent 세션에서는 거절한다. 모델 호출은 skim의
 * completeRole과 같은 경로(역할 slot 해석 → completeSimple → 비용 장부)이며 대화·사용자 프로필 없이 고정 system 한 줄 +
 * 변경 본문 한 통만 보낸다.
 */

const OPENAI_PROVIDERS: Record<string, true> = { "openai-codex": true, openai: true };

/** slot이 가리키는 모델을 해석해 한 번 부른다(reasoning high, 10분 제한). 응답이 돌아온 시도는 비용 장부에 남긴다. */
/** system and purpose let slop_check reuse the role resolution, call, and usage ledger. */
export async function completeReviewer(
  lane: Lane, prompt: string, ctx: ExtensionContext, signal: AbortSignal, options: { system?: string; purpose?: string } = {},
): Promise<{ model: string; text: string; usage: { input: number; output: number; cacheRead: number; cost: number } }> {
  const slot = SLOT[lane];
  const [{ findScopedSettings }, { completeSimple }] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"), import("@oh-my-pi/pi-ai"),
  ]);
  const selector = findScopedSettings(ctx.cwd)?.getModelRole(slot);
  if (!selector) throw new ReviewerCallError(`modelRoles.${slot} is not configured.`, `@${slot}`);
  const model = ctx.models.resolve(`@${slot}`);
  if (!model) throw new ReviewerCallError(`Could not resolve modelRoles.${slot} (${selector}).`, selector);
  const name = `${model.provider}/${model.id}`;
  const ok = lane === "anthropic" ? model.provider === "anthropic" : Object.hasOwn(OPENAI_PROVIDERS, model.provider);
  if (!ok) throw new ReviewerCallError(`modelRoles.${slot} resolved to ${name}, which is not a ${lane} model.`, name);
  const sessionId = ctx.sessionManager.getSessionId();
  const attempt = AbortSignal.any([signal, AbortSignal.timeout(REVIEW_TIMEOUT_MS)]);
  const usage = helperAttemptRecorder(ctx, { purpose: options.purpose ?? "cross-review", role: slot, model });
  let response;
  try {
    response = await beforeModelAbort(attempt, async () => {
      if (!(await ctx.modelRegistry.getApiKey(model, sessionId, { signal: attempt }))) throw new ReviewerCallError(`No credentials for ${name}.`, name);
      attempt.throwIfAborted();
      return completeSimple(model, {
        systemPrompt: [options.system ?? REVIEW_SYSTEM],
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      }, {
        apiKey: ctx.modelRegistry.resolver(model, sessionId), sessionId, maxTokens: model.maxTokens ?? undefined,
        reasoning: "high" as never,
        ...(model.provider === "anthropic" ? { cacheRetention: "none" as const } : {}),
        signal: attempt, onAttempt: usage.onAttempt,
      });
    });
  } catch (error) {
    if (error instanceof ReviewerCallError) throw error;
    throw new ReviewerCallError(error instanceof Error ? error.message : String(error), name, undefined, { cause: error });
  }
  // 응답이 돌아온 시도는 오류·빈 답도 청구되므로 시도마다 onAttempt가 장부에 남겼다. 저장 실패는 여기서 알린다.
  usage.assertSaved();
  const text = response.content.filter((part) => part.type === "text").map((part) => part.text).join("").trim();
  // Preserve partial output for diagnosis without treating it as a usable review.
  if (response.stopReason !== "stop") throw new ReviewerCallError(response.errorMessage ?? `Model stopped: ${response.stopReason}`, name, text || undefined, { cause: response });
  if (!text) throw new ReviewerCallError(`${name} returned an empty answer.`, name);
  return { model: name, text, usage: { input: response.usage.input, output: response.usage.output, cacheRead: response.usage.cacheRead, cost: response.usage.cost?.total ?? 0 } };
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
  base?: string;
  inputs?: string[];
  references?: string[];
  probeResults?: { findingId: string; command: string; exitCode: number; output: string }[];
  reviewId?: string;
  resolutions?: { id: string; status: string; evidence: string }[];
  unreviewedAcknowledgements?: { path: string; evidence: string }[];
}

/** 진행 알림을 받는 도구 update 콜백(core의 onUpdate와 같은 모양). review는 reviewer 상태를 보낸다. */
export type CrossReviewUpdate = (partial: { content: { type: "text"; text: string }[]; details: { progress: ReviewProgress } }) => void;

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
      highRisk: params.highRisk, previousReviewId: params.previousReviewId, base: params.base, inputs: params.inputs, references: params.references, probeResults: params.probeResults, maker: sub,
    };
    return runReview(input, deps, signal);
  }
  if (params.action === "resolve") {
    if (!params.reviewId) throw new Error("resolve requires reviewId.");
    const input: ResolveInput = { reviewId: params.reviewId, resolutions: params.resolutions ?? [], unreviewedAcknowledgements: params.unreviewedAcknowledgements };
    return runResolve(input, deps);
  }
  const round = typeof params.action === "string" && ["initial", "delta", "probe"].includes(params.action);
  throw new Error(round
    ? `${JSON.stringify(params.action)} is a review round, not an action: call action "review" (initial: files, acceptance, authors; delta: previousReviewId; probe: previousReviewId and probeResults).`
    : `Unknown action ${JSON.stringify(params.action)}; use "review" or "resolve".`);
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
    description: "Read rule://cross-review-procedure first. action: review|resolve. review: risk-marked files, acceptance, authors (model selectors; subagents own family, not main). Delta: previousReviewId only for an R1 blocker. One verdict-only probe on unchanged code: previousReviewId + probeResults. base: first committed round. inputs bind pass; references=context. Sends code to reviewer providers. Main-only resolve: reviewId + resolutions[{id,status:fixed|refuted|limit,evidence}].",
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
      const result = await executeCrossReview(params as CrossReviewParams, ctx, signal ?? new AbortController().signal, reviewDeps, onUpdate as CrossReviewUpdate | undefined);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
    },
  });

  // 편집 직후 조기 알림(게이트 아님): marker에 맞는 코드 파일은 git_finalize 전에 cross_review가 필요하다는 것을 파일당 세션에 한 번 알린다.
  // 알림을 낸 파일만 기록하므로, 처음에는 marker가 없다가 나중에 걸리는 파일도 그때 한 번 알린다.
  // 2026-11-23 사용자 결정(「둘이 같이말한것들은 해보자」): 검토를 모델의 기억에 맡기지 않는다. 11-22 약한 모델 비교에서 조기 알림을 받고도
  // 검토 없이 끝낸 실행이 있었다. 그래서 통과 기록이 아직 없는 파일을 기억해 두고, 턴이 끝날 때 남아 있으면 turn-end-guard의 한 번짜리
  // 안내에 문구를 붙인다(입력당 한 번). 상태는 편집과 cross_review 결과 때만 다시 계산한다(턴 끝 연결점이 동기라서).
  // 추적은 도구가 꺼져 있어도 갱신하고, 같은 경로의 조회가 겹치면 마지막 조회만, 세션이 바뀌면 옛 조회는 버린다.
  const noticed = new Set<string>();
  const uncovered = new Set<string>();
  const latestLookup = new Map<string, number>();
  let lookupSeq = 0;
  let epoch = 0;
  let remindedThisInput = false;
  onSessionLifecycle(pi, { start: () => { epoch++; noticed.clear(); uncovered.clear(); latestLookup.clear(); remindedThisInput = false; } });
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") remindedThisInput = false;
  });
  /** 지금 내용의 알림 문구를 돌려준다. 더 새 조회나 세션 교체에 밀린 조회는 상태를 건드리지 않고 undefined다. */
  const refresh = async (path: string, cwd: string): Promise<string | undefined> => {
    const mine = ++lookupSeq;
    const startedEpoch = epoch;
    latestLookup.set(path, mine);
    const text = await earlyReviewNotice(cwd, path, spawnExec(), () => readCrossReviewRecords(ledgerPath()));
    if (startedEpoch !== epoch || latestLookup.get(path) !== mine) return undefined;
    if (text) uncovered.add(path);
    else uncovered.delete(path);
    return text;
  };
  pi.on("tool_result", async (event, ctx) => {
    // 알림은 보조다: 경로 읽기·git·원장·전달 어느 단계의 실패도 편집 흐름으로 번지지 않고, 전달에 실패한 파일은 다음 편집에서 다시 알릴 수 있다.
    if (event.isError) return;
    if (event.toolName === "cross_review") {
      for (const path of [...uncovered]) {
        try { await refresh(path, ctx.cwd); } catch { /* 다음 편집이나 검토 결과에서 다시 본다. */ }
      }
      return;
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    let paths: string[];
    try { paths = editedPaths(event.toolName, event.input, ctx.cwd); } catch { return; }
    for (const path of paths) {
      try {
        const text = await refresh(path, ctx.cwd);
        if (!text || noticed.has(path) || !(pi.getActiveTools?.().includes("cross_review") ?? true)) continue;
        pi.sendMessage({ customType: "cross-review-notice", content: text, display: false, attribution: "agent" }, { deliverAs: "aside" });
        noticed.add(path);
      } catch { /* 알림 실패는 편집 결과와 다른 파일의 추적에 영향을 주지 않는다. */ }
    }
  });
  pi.events.on("cuelo:turn-end-notices", (data) => {
    const { ctx, notices } = data as TurnEndNotices;
    if (ctx.agent?.kind === "sub" || remindedThisInput || uncovered.size === 0 || !(pi.getActiveTools?.().includes("cross_review") ?? true)) return;
    remindedThisInput = true;
    const names = [...uncovered].map((path) => relative(ctx.cwd, path) || path).slice(0, 5);
    notices.push(`cross_review: ${names.join(", ")}${uncovered.size > names.length ? ` 외 ${uncovered.size - names.length}개` : ""}는 review marker가 걸렸는데 지금 내용을 덮는 통과 기록이 없다. 완료를 보고하기 전에 함께 한 번 cross_review하라(rule://cross-review-procedure). 이 안내는 입력당 한 번이며 승인이 아니다.`);
  });
}
