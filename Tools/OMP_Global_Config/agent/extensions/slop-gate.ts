import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { completeReviewer } from "./cross-review";
import { onSessionLifecycle } from "./lib/session-identity";
import { candidatesOf, pendingArtifacts, readSlopRecords, slopLedgerPath, type PendingArtifact } from "./lib/slop-gate";
import { reviewFiles, resolveFindings, SLOP_OPENAI_SLOT, type Lang, type SlopDeps, type SlopLane } from "./slop-gate/review";

/**
 * slop_check 전용 reviewer slot(사용자 결정 2026-10-29: Opus·Astra 대신 GPT-6 Luna 단독, Gemini Flash와 자문은 제거). slopReviewOpenAI가 풀리면 그 모델(provider/id)이고,
 * 설정이 없거나 풀리지 않으면 비어서 그 자리는 cross_review와 같은 옛 slot으로 돌아간다. cross_review는 이 slot을 읽지 않는다.
 */
export async function slopSlotsOf(ctx: Pick<ExtensionContext, "models" | "cwd">): Promise<{ openai?: string }> {
  // 런타임 패키지는 legacy-pi 확장 loader가 host SDK 경로로 재작성하므로 cross-review.ts처럼 지연 import한다. 설정에 없는 role은 풀기 전에 비어 있는 것으로 본다.
  const { findScopedSettings } = await import("@oh-my-pi/pi-coding-agent/config/settings");
  const settings = findScopedSettings(ctx.cwd);
  const named = (slot: string): string | undefined => {
    if (!settings?.getModelRole(slot)) return undefined;
    const model = ctx.models.resolve(`@${slot}`);
    return model ? `${model.provider}/${model.id}` : undefined;
  };
  return { openai: named(SLOP_OPENAI_SLOT) };
}

/** 한 reviewer 호출. slot이 없으면 lane의 기본 slot(cross_review와 같다)이다. slopReviewOpenAI는 completeReviewer의 OpenAI 계열 검사를 그대로 받는다. */
export async function completeSlopReviewer(lane: SlopLane, system: string, prompt: string, signal: AbortSignal, slot: string | undefined, ctx: ExtensionContext) {
  return completeReviewer(lane, prompt, ctx, signal, { system, purpose: "slop-gate", ...(slot ? { slot } : {}) });
}

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

/** 도구 본체. 테스트가 가짜 reviewer를 넣을 수 있게 deps를 받는다. */
export async function executeSlopCheck(params: SlopCheckParams, ctx: Pick<ExtensionContext, "agent" | "cwd">, deps: SlopDeps, signal: AbortSignal): Promise<{ text: string; isError: boolean }> {
  const action = params.action ?? "review";
  if (action === "resolve") {
    if (ctx.agent?.kind === "sub") throw new Error("slop_check resolve is Main-only: a pass by refutation is recorded only by Main. Report the reviewId and your proposed refutation with evidence per finding; Main checks it and resolves.");
    if (!params.reviewId) throw new Error("resolve requires reviewId.");
    const result = resolveFindings(params.reviewId, params.resolutions ?? [], deps);
    const done = result.open.length === 0 && result.stale.length === 0 && result.rejected.length === 0;
    const next = result.stale.length > 0 ? "Some files changed after the review; run slop_check on them again (a changed file needs a new review)."
      : result.open.length > 0 ? "Findings without an accepted refutation remain open: fix the file and run slop_check again, or refute them with evidence."
        : result.rejected.length > 0 ? "Some resolutions were rejected (see rejected[])." : "All findings are closed; the passes are recorded for the exact reviewed bytes.";
    return { text: JSON.stringify({ ...result, next }, null, 2), isError: !done };
  }
  if (action !== "review") throw new Error(`Unknown action ${JSON.stringify(action)}; use "review" or "resolve".`);
  if (!params.files || params.files.length === 0) throw new Error("review requires files.");
  const outcome = await reviewFiles(params.files, params.lang, { ...deps, authors: params.authors ?? deps.authors }, signal);
  const open = outcome.files.filter((file) => file.status === "findings");
  const errors = outcome.files.filter((file) => file.status === "error");
  const skipped = outcome.files.filter((file) => file.status === "internal");
  const reviewed = outcome.files.length - skipped.length;
  const next = errors.length > 0 ? "Some files could not be reviewed (see error); none of them has a pass. For a reviewer failure read reviewers[].error and raw: it says whether the answer was invalid JSON (with the parser error) or valid JSON in the wrong shape. Do not retry with unchanged input and do not change the artifact's punctuation as a protocol workaround. diagnosticFindings come from a reviewer that did answer: they are real style findings you may fix, but they are not a review and never a pass."
    : open.length > 0 ? "Fix each finding in the file (then run slop_check again on the new content), or, for a false positive, have Main close it with slop_check {action:\"resolve\", reviewId, resolutions:[{id, status:\"refuted\", evidence}]}. A changed file needs a new review."
      : reviewed > 0 ? "Every visible artifact reviewed has a pass for its exact content." : "No visible artifact was reviewed.";
  const note = skipped.length === 0 ? "" : ` ${skipped.length} file(s) are not visible artifacts or are raw data (markdown not declared in .slop-gate.json visible, internal record, code, test, generated, not a visible format, or a csv over 400000 bytes; see reason): they were not read, not sent to a reviewer and have no pass; the slop gate does not apply to them.`;
  return { text: JSON.stringify({ ...outcome, next: next + note }, null, 2), isError: errors.length > 0 };
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
  const reset = () => { since = Date.now(); files = new Set(); dirs = new Set(); attempts = new Map(); warned = new Set(); };

  const z = pi.zod;
  pi.registerTool({
    name: "slop_check", label: "Slop Check", loadMode: "essential", approval: "read",
    description: "AI-slop check for artifacts a person actually sees: slides, html, pptx, docx, pdf, hwpx, report xlsx/csv, UI copy packs, manuals. Markdown of any kind (README, CHANGELOG, docs, doc maps) is out of scope unless a .slop-gate.json visible glob declares it. Scope is decided from path and format before reading, regardless of public repository, .publicignore or publication declarations (.slop-gate.json visible globs only add targets). Markdown, source code, comments, logs, tests, fixtures, generated files, internal rules, prompts, skills, HANDOFF.md, doc/history, doc/README.md and csv over 400000 bytes (treated as raw data, not a report table) are out of scope: not read, not sent to a model, and returned as status:\"internal\" with a reason (not a pass). action=review (default): extracts the visible text of files (inside cwd, or under home or /mnt/<drive>/) and judges it against the rule text of humanizer for Korean (a comma after a pattern-3 connective ending alone is not a finding; only its count stays in relaxed), stop-slop for English, and kill-ai-slop for html, UI copy and slides; only the rule sets for the detected language and format are sent, as a fixed system message ahead of the file text so provider prefix caching can hit across calls. The reviewer comes from the slop-only slot slopReviewOpenAI (GPT-6 Luna; user decision 2026-10-29: Luna alone, no advisory reviewer; cross_review is unaffected), which must resolve to an OpenAI model or the call is refused. Luna is the required reviewer for Anthropic, Gemini and other authors; an OpenAI author cannot use it, so that position falls back to the cross_review slot crossReviewAnthropic. An unset or unresolvable slopReviewOpenAI also falls back to the cross_review slot for that position (crossReviewOpenAI, crossReviewAnthropic), with reviewers[].model naming the model that answered. It returns findings {id, file, quote, rule, fix}. A reviewer answer that does not parse as JSON is asked again once in the same slot (the first raw answer and parser error stay in failedAttempts); if the retry also fails to parse there is no pass. With no findings the same call records a pass bound to the file content (sha256) in the ledger, and already-passed content does not call a model. A fixed file has different bytes and needs a new review. action=resolve (Main only): closes reviewId findings only as {id, status:\"refuted\", evidence} and records a pass when every finding is refuted and the file content equals the reviewed bytes. git_finalize requires this pass for every visible artifact it commits, and a turn that wrote a visible artifact outside the repository cannot end without a pass.",
    parameters: z.object({
      action: z.string().optional().describe("review (default) or resolve"),
      files: z.array(z.string()).optional().describe("review targets: paths relative to cwd, or absolute paths under the home folder or /mnt/<drive>/ (excluding /tmp, ~/.omp, ~/.cache, node_modules, .git)"),
      lang: z.enum(["ko", "en", "both"]).optional().describe("Only to force the language; by default it is decided from the characters"),
      authors: z.array(z.string()).optional().describe("Model selectors that wrote the text, or \"main\" (default [\"main\"]). Reviewer slots follow the slop_check slot rules in the tool description"),
      reviewId: z.string().optional(),
      resolutions: z.array(z.object({ id: z.string(), status: z.string(), evidence: z.string() })).optional(),
    }) as never,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const abort = signal ?? new AbortController().signal;
      const slopSlots = await slopSlotsOf(ctx);
      const result = await executeSlopCheck(params as SlopCheckParams, ctx, {
        cwd: ctx.cwd, ledgerPath: slopLedgerPath(), mainModel: currentModel(ctx),
        complete: (lane, system, prompt, attempt, slot) => completeSlopReviewer(lane, system, prompt, attempt, slot, ctx),
        slopSlots,
      }, abort);
      return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true as const } : {}) };
    },
  });

  onSessionLifecycle(pi, { start: reset });
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source === "interactive" || event.source === "rpc") reset();
  });
  pi.on("tool_result", (event, ctx) => {
    const found = candidatesOf(event.toolName, event.input, ctx.cwd);
    for (const file of found.files) files.add(file);
    for (const dir of found.dirs) dirs.add(dir);
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
