import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { completeReviewer } from "./cross-review";
import { onSessionLifecycle } from "./lib/session-identity";
import { candidatesOf, pendingArtifacts, pendingGitArtifacts, readSlopRecords, slopLedgerPath, type PendingArtifact } from "./lib/slop-gate";
import { toolNonSuccess } from "./lib/tool-outcome";
import { reviewFiles, resolveFindings, SlopCheckRefusal, type Lang, type SlopDeps } from "./slop-gate/review";

/**
 * 밖에 보이는 산출물 AI 슬롭 게이트의 세션 쪽. (1) `slop_check` 도구: 보이는 산출물만 모델로 심사하고 sha256 통과를 원장에 남긴다.
 * (2) 턴 끝 게이트: 이번 입력에서 write·edit·draft·bash·eval이 쓴 산출물 중 git 밖(저장소 밖 문서 폴더 등)이고 현재 내용의 통과가 없는
 * 것이 있으면 끝내지 않고 이어 가게 한다(같은 파일 묶음에 최대 두 번, 그 뒤엔 보이는 경고).
 * 저장소 안 산출물은 git_finalize의 slop-gate가 맡는다. 무엇이 대상인지는 lib/slop-gate.ts의 classify가 정한다(공개 선언은 필요 없다).
 */

const MAX_CONTINUATIONS = 2;
export const CONTINUATION_TYPE = "slop-gate";
export const WARNING_TYPE = "slop-gate-warning";

/** "main" 저자를 풀 이 세션의 현재 모델 selector. */
function currentModel(ctx: ExtensionContext): string | undefined {
  const current = ctx.models.current() ?? ctx.model;
  return current ? `${current.provider}/${current.id}` : undefined;
}

export interface SlopCheckParams {
  action?: string;
  files?: string[];
  lang?: Lang;
  authors?: string[];
  reviewId?: string;
  resolutions?: { id: string; status: string; evidence: string }[];
}

type SlopCheckResult = { text: string; isError: boolean; details?: { refused: { by: "slop-gate" } } };

function slopRefusal(text: string): SlopCheckResult {
  return { text: `[refused by slop-gate] Not executed.\n${text}`, isError: false, details: { refused: { by: "slop-gate" } } };
}

/** Tool body with injectable reviewer dependencies. */
export async function executeSlopCheck(params: SlopCheckParams, ctx: Pick<ExtensionContext, "agent" | "cwd">, deps: SlopDeps, signal: AbortSignal): Promise<SlopCheckResult> {
  try {
    signal.throwIfAborted();
    return await checkSlop(params, ctx, deps, signal);
  } catch (error) {
    if (!(error instanceof SlopCheckRefusal) || signal.aborted) throw error;
    return slopRefusal(error.message);
  }
}

async function checkSlop(params: SlopCheckParams, ctx: Pick<ExtensionContext, "agent" | "cwd">, deps: SlopDeps, signal: AbortSignal): Promise<SlopCheckResult> {
  const action = params.action ?? "review";
  if (action === "resolve") {
    if (ctx.agent?.kind === "sub") throw new SlopCheckRefusal("slop_check resolve is Main-only: a pass by refutation is recorded only by Main. Report the reviewId and your proposed refutation with evidence per finding; Main checks it and resolves.");
    if (!params.reviewId) throw new Error("resolve requires reviewId.");
    const result = resolveFindings(params.reviewId, params.resolutions ?? [], deps);
    const done = result.open.length === 0 && result.stale.length === 0 && result.rejected.length === 0;
    const next = result.stale.length > 0 ? "Some files changed after the review; run slop_check on them again (a changed file needs a new review)."
      : result.open.length > 0 ? "Findings without an accepted refutation remain open: fix the file and run slop_check again, or refute them with evidence."
        : result.rejected.length > 0 ? "Some resolutions were rejected (see rejected[])." : "All findings are closed; the passes are recorded for the exact reviewed bytes.";
    const text = JSON.stringify({ ...result, next }, null, 2);
    return !done && !signal.aborted ? slopRefusal(text) : { text, isError: signal.aborted };
  }
  if (action !== "review") throw new Error(`Unknown action ${JSON.stringify(action)}; use "review" or "resolve".`);
  if (!params.files || params.files.length === 0) throw new Error("review requires files.");
  const outcome = await reviewFiles(params.files, params.lang, { ...deps, authors: params.authors ?? deps.authors }, signal);
  const open = outcome.files.filter((file) => file.status === "findings");
  const errors = outcome.files.filter((file) => file.status === "error");
  const skipped = outcome.files.filter((file) => file.status === "internal");
  const reviewed = outcome.files.length - skipped.length;
  const next = errors.length > 0 ? "Some files could not be reviewed (see error); none of them has a pass. For a required reviewer failure read reviewers[].error and raw: it says whether the answer was invalid JSON (with the parser error) or valid JSON in the wrong shape. Do not retry with unchanged input or change the artifact's punctuation as a protocol workaround. diagnosticFindings do not count as a pass."
    : open.length > 0 ? "Fix each finding in the file (then run slop_check again on the new content), or, for a false positive, have Main close it with slop_check {action:\"resolve\", reviewId, resolutions:[{id, status:\"refuted\", evidence}]}. A changed file needs a new review."
      : reviewed > 0 ? "Every visible artifact reviewed has a pass for its exact content." : "No visible artifact was reviewed.";
  const note = skipped.length === 0 ? "" : ` ${skipped.length} file(s) are not visible artifacts or are raw data (markdown not declared in .slop-gate.json visible, internal record, code, test, generated, not a visible format, or a csv over 400000 bytes; see reason): they were not read, not sent to a reviewer and have no pass; the slop gate does not apply to them.`;
  const text = JSON.stringify({ ...outcome, next: next + note }, null, 2);
  if (!signal.aborted && errors.length > 0 && outcome.files.every((file) => file.refused || file.status === "internal" || file.status === "already-passed")) {
    return slopRefusal(text);
  }
  return { text, isError: signal.aborted || errors.length > 0 };
}

const list = (pending: readonly PendingArtifact[]) => pending.map((item) => `- ${item.path} (${item.reason})`).join("\n");

export function continuationText(pending: readonly PendingArtifact[]): string {
  return `이번 요청에서 밖에 보이는 산출물을 썼는데 현재 내용의 AI 슬롭 검사 통과가 없다:\n${list(pending)}\n끝내지 말고 지금 slop_check {files:[…위 경로…], authors:[글을 쓴 모델 selector 또는 "main"]}를 돌려라. finding이 있으면 파일을 고친 뒤 다시 slop_check를 돌리고(고친 파일은 새 내용으로 다시 심사해야 통과한다), 오탐이면 근거를 적어 Main이 resolve로 반박하게 한다. 통과 기록은 파일 내용(sha256)에 묶이므로 통과 뒤에는 그 파일을 고치지 마라.`;
}

export function warningText(pending: readonly PendingArtifact[]): string {
  return `AI 슬롭 검사를 통과하지 못한 산출물이 남은 채 턴이 끝났다. 내용을 확인하고 slop_check를 직접 돌리세요:\n${list(pending)}`;
}

export default function slopGate(pi: ExtensionAPI): void {
  let since = Date.now();
  let files = new Set<string>();
  let dirs = new Set<string>();
  let attempts = new Map<string, number>();
  let warned = new Set<string>();
  let noticed = new Set<string>();
  const reset = () => { since = Date.now(); files = new Set(); dirs = new Set(); attempts = new Map(); warned = new Set(); noticed = new Set(); };

  const z = pi.zod;
  pi.registerTool({
    name: "slop_check", label: "Slop Check", loadMode: "essential", approval: "read",
    description: "Review visible artifacts, not source/internal files or undeclared Markdown (.slop-gate.json visible adds targets). files + authors; text goes to one judge selected by author family (Anthropic author → OpenAI slot, else Anthropic slot). Only detected Korean/English gets style passes. Re-review changed bytes. Main-only resolve: reviewId + resolutions[{id,status:\"refuted\",evidence}]. Exact-content passes gate publication/turn completion; never bypass errors.",
    parameters: z.object({
      action: z.string().optional().describe("review(default) or resolve"),
      files: z.array(z.string()).optional().describe("cwd or home,/mnt/<drive>; excludes /tmp,~/.omp,~/.cache,node_modules,.git"),
      lang: z.enum(["ko", "en", "both"]).optional().describe("Short-text hint, not language override"),
      authors: z.array(z.string()).optional().describe("Author selectors; default main"),
      reviewId: z.string().optional(),
      resolutions: z.array(z.object({ id: z.string(), status: z.string(), evidence: z.string() })).optional(),
    }) as never,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const abort = signal ?? new AbortController().signal;
      const result = await executeSlopCheck(params as SlopCheckParams, ctx, {
        cwd: ctx.cwd, ledgerPath: slopLedgerPath(), mainModel: currentModel(ctx),
        complete: (lane, system, prompt, attempt) => completeReviewer(lane, prompt, ctx, attempt, { system, purpose: "slop-gate" }),
      }, abort);
      return { content: [{ type: "text", text: result.text }], isError: result.isError, ...(result.details ? { details: result.details } : {}) };
    },
  });

  onSessionLifecycle(pi, { start: reset });
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") reset();
  });
  pi.on("tool_result", async (event, ctx) => {
    const outcome = toolNonSuccess(event);
    if (outcome === "refused" || outcome === "scriptError") return;
    const found = candidatesOf(event.toolName, event.input, ctx.cwd);
    for (const file of found.files) files.add(file);
    for (const dir of found.dirs) dirs.add(dir);
    if (event.isError || !["write", "edit", "draft"].includes(event.toolName) || !(pi.getActiveTools?.().includes("slop_check") ?? true)) return;
    const noticeState = noticed;
    try {
      const pending = (await pendingGitArtifacts(found.files.filter((path) => !noticeState.has(path)), ctx.cwd, slopLedgerPath(), AbortSignal.timeout(1_000)))
        .filter((path) => !noticeState.has(resolve(ctx.cwd, path)));
      if (noticed !== noticeState || pending.length === 0) return;
      pi.sendMessage({
        customType: "slop-gate-notice", display: false, attribution: "agent",
        content: `These visible files have no slop_check pass for their current content. If they are part of the next commit, review them once the text is settled: slop_check {files:${JSON.stringify(pending)}, authors:[<author model selectors or "main">]}. Do not edit a file after its pass.`,
      }, { deliverAs: "aside" });
      for (const path of pending) noticeState.add(resolve(ctx.cwd, path));
    } catch { /* Advisory only; never change the writing tool's result. */ }
  });
  pi.on("agent_end", (event, ctx) => {
    if (event.willContinue) return;
    const aborted = event.messages.some((message) => message.role === "assistant" && message.stopReason === "aborted");
    if (aborted) return;
    const pending = pendingArtifacts({ files, dirs }, ctx.cwd, since, readSlopRecords(slopLedgerPath()));
    if (pending.length === 0) return;
    // slop_check가 이 세션의 도구가 아니면 이어 가도 부를 수 없다. 이어 가기 대신 보이는 경고만 남긴다.
    const canCheck = pi.getActiveTools?.().includes("slop_check") ?? true;
    const key = pending.map((item) => item.path).join("\n");
    const count = attempts.get(key) ?? 0;
    if (canCheck && count < MAX_CONTINUATIONS) {
      attempts.set(key, count + 1);
      pi.sendMessage({ customType: CONTINUATION_TYPE, content: continuationText(pending), display: false, attribution: "agent" }, { deliverAs: "aside" });
      return;
    }
    if (warned.has(key)) return;
    warned.add(key);
    pi.sendMessage({ customType: WARNING_TYPE, content: warningText(pending), display: true, attribution: "agent" });
  });
}
