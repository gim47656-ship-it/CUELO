import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { didNotSucceed } from "./lib/tool-outcome";
// 런타임 패키지는 legacy-pi 확장 loader가 host SDK 경로로 재작성하므로 아래에서 지연 import한다.
import {
  authorFamily,
  REVIEW_SYSTEM,
  REVIEW_TIMEOUT_MS,
  CrossReviewRefusal,
  ReviewerCallError,
  earlyReviewNotice,
  earlyReviewNoticeText,
  SLOT,
  ledgerPath,
  resolveRepoTargets,
  runResolve,
  runReview,
  snapshotRoot,
  workingBaseline,
  spawnExec,
  type Lane,
  type ReviewDeps,
  type ReviewInput,
  type ReviewProgress,
  type ResolveInput,
  type ResolveResult,
  type ReviewResult,
  type SessionRun,
} from "./lib/cross-review";
import { helperAttemptRecorder } from "./lib/helper-usage";
import { parseAutoEffortConfig } from "./lib/auto-effort-policy";
import { messageText } from "../cuelo-plugins/requirement-carry/requirement-carry";
import { beforeModelAbort } from "./lib/model-routes";
import { createRoutingLedger, readCrossReviewRecords } from "./lib/routing-ledger";
import { onSessionLifecycle } from "./lib/session-identity";
import type { TurnEndNotices } from "./turn-end-guard";

/**
 * 계열 교차검증 도구. review(probe·delta 라운드 포함)는 Main과 Maker child(agents/maker.md tools 목록) 모두 부를 수 있고,
 * git_finalize가 믿는 통과 지문을 남기는 resolve는 Main 전용이라 subagent 세션에서는 거절한다. 모델 호출은 skim의
 * completeRole과 같은 경로(역할 slot 해석 → completeSimple → 비용 장부)이며 고정 system 한 줄과 심사 본문만 보낸다.
 * 첫 코드 검토의 심사 본문에는 현재 브랜치에서 가져온 제한된 USER REQUEST도 들어간다.
 */

const OPENAI_PROVIDERS: Record<string, true> = { "openai-codex": true, openai: true };

const NOTICE_BATCH_MS = 25;
const NOTICE_RESULT_WAIT_MS = 1_000;

function appliedAstEdit(details: unknown): details is { applied: true } {
  return !!details && typeof details === "object" && "applied" in details && details.applied === true;
}

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

const { noticePrefixes } = parseAutoEffortConfig(undefined);

function collectReviewRequest(ctx: ExtensionContext, maker: boolean) {
  const messages: string[] = [];
  let explicit: string[] | undefined;
  for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
    if (entry.type === "custom" && entry.customType === "goal-lane") {
      const conditions = (entry.data as { explicit?: unknown } | undefined)?.explicit;
      explicit = Array.isArray(conditions) ? conditions.filter((item): item is string => typeof item === "string") : undefined;
    }
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const message = entry.message;
    if (message.synthetic || "customType" in message) continue;
    // Core dispatches the first Maker assignment as an agent-attributed user message, not a steer.
    if (message.attribution === "agent" && !(maker && messages.length === 0 && !message.steering && !message.parentIrc)) continue;
    const text = messageText(message);
    const trimmed = text.trim();
    if (!trimmed || noticePrefixes.some((prefix) => trimmed.startsWith(prefix)) || /^<system-reminder(?:\s[^>]*)?>[\s\S]*<\/system-reminder>$/.test(trimmed)) continue;
    messages.push(text);
  }
  return { messages, explicit };
}

// 세션 실행은 최근 것만 본다. lib가 다시 관련된 것만 골라 개수·바이트를 묶는다.
const MAX_SESSION_RUNS = 60;

/**
 * 이 세션 branch에서 하네스가 기록한 bash·eval 실행(명령, 종료 코드, 출력, 시작 시각). reviewer가 저자에게 같은 실행을 다시 요구하지 않도록
 * 1라운드에 넘긴다. 시작 시각은 tool_execution_start 기록, 없으면 호출을 담은 assistant 항목이 끝난 시각(도구는 그 뒤에 시작한다)이다.
 */
export function collectSessionRuns(entries: readonly unknown[]): SessionRun[] {
  const calls = new Map<string, { tool: SessionRun["tool"]; command: string; at?: number }>();
  const started = new Map<string, number>();
  const runs: SessionRun[] = [];
  // 두 시각 모두 ISO 문자열로 기록된다.
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: { toolCallId?: unknown; startedAt?: unknown }; timestamp?: unknown; message?: { role?: string; content?: unknown; toolCallId?: string; isError?: boolean; details?: { exitCode?: unknown } } };
    if (entry.type === "custom" && entry.customType === "tool_execution_start" && typeof entry.data?.toolCallId === "string") {
      const at = Date.parse(String(entry.data.startedAt));
      if (Number.isFinite(at)) started.set(entry.data.toolCallId, at);
      continue;
    }
    const message = entry.type === "message" ? entry.message : undefined;
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const at = Date.parse(String(entry.timestamp));
      for (const part of message.content as { type?: string; id?: string; name?: string; arguments?: { command?: unknown; code?: unknown } }[]) {
        if (part.type !== "toolCall" || typeof part.id !== "string" || (part.name !== "bash" && part.name !== "eval")) continue;
        const command = part.name === "bash" ? part.arguments?.command : part.arguments?.code;
        if (typeof command === "string") calls.set(part.id, { tool: part.name, command, ...(Number.isFinite(at) ? { at } : {}) });
      }
    } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      const call = calls.get(message.toolCallId);
      if (!call) continue;
      const exitCode = message.details?.exitCode;
      const startedAt = started.get(message.toolCallId) ?? call.at;
      runs.push({
        tool: call.tool, command: call.command, isError: message.isError === true, output: messageText(message as Parameters<typeof messageText>[0]),
        ...(typeof exitCode === "number" ? { exitCode } : {}), ...(startedAt !== undefined ? { startedAt } : {}),
      });
    }
  }
  return runs.slice(-MAX_SESSION_RUNS);
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
): Promise<ReviewResult | ResolveResult> {
  const sub = ctx.agent?.kind === "sub";
  if (sub && params.action === "resolve") throw new CrossReviewRefusal("cross_review resolve is Main-only: the pass git_finalize trusts is recorded only by Main. Report the reviewId chain with a proposed status (fixed|refuted|limit) and evidence for every finding; Main checks it and resolves the chain.");
  // subagent 세션에서 "main"은 Main이 아니라 이 child의 현재 모델로 풀리므로 뜻이 모호하다. 저자 selector를 직접 받는다.
  if (sub && params.action === "review" && (params.authors ?? []).some((author) => author.trim().toLowerCase() === "main")) {
    throw new CrossReviewRefusal("authors \"main\" is ambiguous in a subagent session; pass your own model selector (the provider/model you run as, e.g. anthropic/claude-sonnet-...) instead.");
  }
  // subagent 세션의 1회차는 선언한 저자를 그대로 믿지 않는다: 자기 계열 저자를 빼고 다른 계열만 적으면 같은 계열
  // reviewer가 붙어 교차검증이 무너진다. 후속 라운드의 reviewer 계열은 1회차에서 정해지므로 1회차만 본다.
  if (sub && params.action === "review" && !params.previousReviewId) {
    const current = ctx.models?.current?.() ?? ctx.model;
    if (!current) throw new CrossReviewRefusal("This subagent session's own model could not be resolved, so the declared authors cannot be checked against it; refusing rather than guessing.");
    const own = `${current.provider}/${current.id}`;
    const family = authorFamily(own);
    if (!(params.authors ?? []).some((author) => author.trim() !== "" && authorFamily(author.trim()) === family)) {
      throw new CrossReviewRefusal(`authors must include this session's own model: it runs ${own} (${family} family), but authors ${JSON.stringify(params.authors ?? [])} list no ${family} model. List your own model selector so the reviewer is the other family.`);
    }
  }
  const made = await makeDeps(ctx, signal);
  // reviewer 시작·끝을 도구의 진행 채널로 알린다. runReview는 결과를 돌려준 뒤에는 부르지 않는다.
  const deps: ReviewDeps = onUpdate ? { ...made, onProgress: (progress) => onUpdate({ content: [{ type: "text", text: progress.text }], details: { progress } }) } : made;
  if (params.action === "review") {
    const input: ReviewInput = {
      files: params.files ?? [], acceptance: params.acceptance ?? "", authors: params.authors ?? [],
      highRisk: params.highRisk, previousReviewId: params.previousReviewId, base: params.base, inputs: params.inputs, references: params.references, probeResults: params.probeResults, maker: sub,
      userRequest: params.previousReviewId ? undefined : collectReviewRequest(ctx, sub),
      sessionRuns: params.previousReviewId ? undefined : collectSessionRuns(ctx.sessionManager?.getBranch?.() ?? []),
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
    description: "Read rule://cross-review-procedure first. action: review|resolve. Review files are relative to the session cwd, not the Git root: from a subfolder omit its prefix. Review marker, high-risk, or size-triggered changes; acceptance and authors (model selectors; subagents own family, not main). Delta: previousReviewId only for an R1 blocker. One verdict-only probe before changing reviewed files or bound inputs: previousReviewId + probeResults. base: first committed round. inputs bind pass; references=context. Sends code to reviewer providers. Main-only resolve: reviewId + resolutions[{id,status:fixed|refuted|limit,evidence}].",
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
      const abort = signal ?? new AbortController().signal;
      try {
        abort.throwIfAborted();
        const result = await executeCrossReview(params as CrossReviewParams, ctx, abort, reviewDeps, onUpdate as CrossReviewUpdate | undefined);
        const text = JSON.stringify(result, null, 2);
        if ("passable" in result ? !result.passable : !!result.unusable) {
          return { content: [{ type: "text", text }], details: result, isError: true as const };
        }
        if ("pass" in result && !result.pass && (result.rejected.length || result.rejectedAcknowledgements?.length || result.unreviewedBlocking?.length)) {
          return { content: [{ type: "text", text: `[refused by cross-review] Not executed.\n${text}` }], details: { ...result, refused: { by: "cross-review" } }, isError: false as const };
        }
        return { content: [{ type: "text", text }], details: result };
      } catch (error) {
        if (!(error instanceof CrossReviewRefusal) || abort.aborted) throw error;
        return { content: [{ type: "text", text: `[refused by cross-review] Not executed.\n${error.message}` }], details: { refused: { by: "cross-review" } }, isError: false as const };
      }
    },
  });

  // 경로가 있는 편집은 marker와 변경 크기를 본다. 경로를 모르는 도구는 저장소의 변경 크기만 본다.
  // 턴 종료 연결점은 동기다. 같은 저장소의 조회가 겹치면 마지막 조회만, 세션이 바뀌면 옛 조회는 버린다.
  type RepoNoticeState = { edited: Set<string>; uncovered: string[]; lookup: number; sendPending: boolean };
  // Uncommitted code files when this session first touches a repository, so another task's earlier work is not announced.
  // A snapshot not finished before its tool started may already hold this session's writes, so it is not used.
  type Baseline = { done: Promise<void>; value?: ReadonlyMap<string, string>; usable: boolean };
  const repos = new Map<string, RepoNoticeState>();
  const baselines = new Map<string, Baseline>();
  // A root lookup that failed or ran past its wait could let a later call snapshot this session's own writes.
  // Then no new baseline is taken until reset, which keeps the earlier repository-wide notice.
  let baselinesOff = false;
  const inventoryBatches = new Map<string, { active?: Promise<void>; queued?: Promise<void> }>();
  const noticed = new Set<string>();
  let epoch = 0;
  let remindedThisInput = false;
  const reset = () => { epoch++; noticed.clear(); repos.clear(); baselines.clear(); baselinesOff = false; inventoryBatches.clear(); remindedThisInput = false; };
  onSessionLifecycle(pi, { start: reset });
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") remindedThisInput = false;
  });
  const refresh = async (root: string, state: RepoNoticeState, startedEpoch: number, send: boolean) => {
    state.sendPending ||= send;
    const lookup = ++state.lookup;
    try {
      const baseline = baselines.get(root);
      // A baseline that missed its wait is unusable; do not wait for its stalled snapshot.
      if (baseline?.usable) await baseline.done;
      const notices = await earlyReviewNotice(root, state.edited, spawnExec(), () => readCrossReviewRecords(ledgerPath()), baseline?.usable ? baseline.value : undefined);
      if (startedEpoch !== epoch || lookup !== state.lookup) return;
      state.uncovered = notices.map(({ path }) => resolve(root, path));
      if (!state.sendPending || !(pi.getActiveTools?.().includes("cross_review") ?? true)) return;
      state.sendPending = false;
      const fresh = notices.filter(({ path }) => !noticed.has(resolve(root, path)));
      if (fresh.length === 0) return;
      try {
        pi.sendMessage({ customType: "cross-review-notice", content: earlyReviewNoticeText(fresh), display: false, attribution: "agent" }, { deliverAs: "aside" });
        for (const { path } of fresh) noticed.add(resolve(root, path));
      } catch { /* 전달에 실패해도 다음 편집에서 다시 보낼 수 있다. */ }
    } catch { /* 보조 알림 실패를 편집이나 검토 결과로 전파하지 않는다. */ }
  };
  const stateFor = (root: string): RepoNoticeState => {
    let state = repos.get(root);
    if (!state) repos.set(root, state = { edited: new Set(), uncovered: [], lookup: 0, sendPending: false });
    return state;
  };
  const refreshAfterOpaqueWrite = async (cwd: string, startedEpoch: number) => {
    if (startedEpoch !== epoch) return;
    let inventory = inventoryBatches.get(cwd);
    if (!inventory) inventoryBatches.set(cwd, inventory = {});
    const queue = inventory;
    queue.queued ??= delay(NOTICE_BATCH_MS).then(async () => {
      // If the previous scan outlived its tool result, join one follow-up for writes during that scan.
      await queue.active?.catch(() => {});
      if (startedEpoch !== epoch) return;
      queue.queued = undefined;
      queue.active = (async () => {
        const git = await spawnExec()("git", ["rev-parse", "--show-toplevel"], { cwd });
        if (startedEpoch !== epoch || git.code !== 0) return;
        const root = git.stdout.replace(/\r?\n$/, "");
        if (isAbsolute(root)) await refresh(root, stateFor(root), startedEpoch, true);
      })();
      try { await queue.active; }
      finally {
        queue.active = undefined;
        if (startedEpoch === epoch && !queue.queued) inventoryBatches.delete(cwd);
      }
    });
    await queue.queued;
  };
  /** Repository roots the call can write; `null` when the lookup failed for a reason other than "not a git repository". */
  const baselineRoots = async (toolName: string, input: unknown, cwd: string): Promise<string[] | null> => {
    const exec = spawnExec();
    if (toolName === "edit" || toolName === "write") {
      const roots: string[] = [];
      for (const absolute of editedPaths(toolName, input, cwd)) {
        const target = await resolveRepoTargets(cwd, [relative(cwd, absolute)], exec);
        if (!("failure" in target)) roots.push(target.root);
      }
      return roots;
    }
    if (toolName === "bash" && input && typeof input === "object" && "cwd" in input && typeof input.cwd === "string") {
      const { resolveToCwd } = await import("@oh-my-pi/pi-coding-agent/tools/path-utils");
      cwd = resolve(resolveToCwd(input.cwd, cwd));
    }
    const git = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = git.stdout.replace(/\r?\n$/, "");
    if (git.code === 0 && isAbsolute(root)) return [root];
    return /not a git repository/i.test(git.stderr ?? "") ? [] : null;
  };
  pi.on("tool_call", async (event, ctx) => {
    if (!["bash", "eval", "edit", "write", "ast_edit", "resolve"].includes(event.toolName) || baselinesOff) return;
    const startedEpoch = epoch;
    let late = false;
    let discovered = false;
    const waited: Baseline[] = [];
    const capture = async () => {
      const roots = await baselineRoots(event.toolName, event.input, ctx.cwd);
      discovered = true;
      if (roots === null) {
        if (startedEpoch === epoch) baselinesOff = true;
        return;
      }
      for (const root of roots) {
        if (startedEpoch !== epoch || baselinesOff) return;
        let baseline = baselines.get(root);
        if (!baseline) {
          const entry: Baseline = { done: Promise.resolve(), usable: !late };
          entry.done = workingBaseline(root, spawnExec()).then((value) => { entry.value = value; }, () => { entry.usable = false; });
          baselines.set(root, baseline = entry);
        }
        waited.push(baseline);
        await baseline.done;
      }
    };
    // The runner awaits tool_call, so the tool starts after this; bound the wait like the result-side check.
    const deadline = new AbortController();
    try { await Promise.race([capture(), delay(NOTICE_RESULT_WAIT_MS, undefined, { signal: deadline.signal })]); }
    catch { /* A missing baseline only keeps the earlier repository-wide notice. */ }
    finally {
      late = true;
      deadline.abort();
      if (!discovered && startedEpoch === epoch) baselinesOff = true;
      for (const baseline of waited) if (baseline.value === undefined) baseline.usable = false;
    }
  });
  pi.on("tool_result", async (event, ctx) => {
    if (didNotSucceed(event)) return;
    if (event.toolName === "bash" && event.details && typeof event.details === "object"
      && "exitCode" in event.details && typeof event.details.exitCode === "number" && event.details.exitCode !== 0) return;
    const startedEpoch = epoch;
    if (event.toolName === "cross_review") {
      await Promise.all([...repos].filter(([, state]) => state.uncovered.length > 0).map(([root, state]) => refresh(root, state, startedEpoch, false)));
      return;
    }
    const details = event.details;
    const appliedResolve = event.toolName === "resolve" && details && typeof details === "object"
      && "sourceToolName" in details && details.sourceToolName === "ast_edit"
      && "sourceResultDetails" in details && appliedAstEdit(details.sourceResultDetails);
    if (event.toolName === "bash" || event.toolName === "eval" || appliedResolve || (event.toolName === "ast_edit" && appliedAstEdit(details))) {
      // The runner awaits tool_result. Bound the whole check, including cwd resolution, but leave a slow scan running.
      const deadline = new AbortController();
      const check = async () => {
        let cwd = ctx.cwd;
        const input = event.input;
        if (event.toolName === "bash" && input && typeof input === "object" && "cwd" in input && typeof input.cwd === "string") {
          const { resolveToCwd } = await import("@oh-my-pi/pi-coding-agent/tools/path-utils");
          cwd = resolve(resolveToCwd(input.cwd, cwd));
        }
        await refreshAfterOpaqueWrite(cwd, startedEpoch);
      };
      try { await Promise.race([check(), delay(NOTICE_RESULT_WAIT_MS, undefined, { signal: deadline.signal })]); }
      catch { /* 실패한 보조 조회는 도구 출력을 바꾸지 않는다. */ }
      finally { deadline.abort(); }
      return;
    }
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const touched = new Map<string, RepoNoticeState>();
    try {
      const exec = spawnExec();
      for (const absolute of editedPaths(event.toolName, event.input, ctx.cwd)) {
        const target = await resolveRepoTargets(ctx.cwd, [relative(ctx.cwd, absolute)], exec);
        if (startedEpoch !== epoch) return;
        if ("failure" in target) continue;
        const state = stateFor(target.root);
        state.edited.add(target.targets[0]!.path);
        touched.set(target.root, state);
      }
    } catch { /* 경로를 찾지 못해도 편집 결과는 유지한다. */ }
    await Promise.all([...touched].map(([root, state]) => refresh(root, state, startedEpoch, true)));
  });
  pi.events.on("cuelo:turn-end-notices", (data) => {
    const { ctx, notices } = data as TurnEndNotices;
    if (ctx.agent?.kind === "sub" || remindedThisInput || !(pi.getActiveTools?.().includes("cross_review") ?? true)) return;
    const uncovered = [...repos.values()].flatMap((state) => state.uncovered);
    if (uncovered.length === 0) return;
    remindedThisInput = true;
    const names = uncovered.slice(0, 5).map((path) => relative(ctx.cwd, path) || path);
    notices.push(`cross_review: ${names.join(", ")}${uncovered.length > names.length ? ` 외 ${uncovered.length - names.length}개` : ""}는 review marker 또는 변경 크기 기준에 해당하는데 지금 내용을 덮는 통과 기록이 없다. 완료를 보고하기 전에 필요한 파일을 함께 한 번 cross_review하라(rule://cross-review-procedure). 이 안내는 입력당 한 번이며 승인이 아니다.`);
  });
}
