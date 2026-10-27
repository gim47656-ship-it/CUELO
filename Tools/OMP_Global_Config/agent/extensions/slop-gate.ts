import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { advisoryModelOf, completeReviewer } from "./cross-review";
import { onSessionLifecycle } from "./lib/session-identity";
import { candidatesOf, pendingArtifacts, readSlopRecords, slopLedgerPath, type PendingArtifact } from "./lib/slop-gate";
import { reviewFiles, resolveFindings, type Lang, type SlopDeps } from "./slop-gate/review";

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
  const note = skipped.length === 0 ? "" : ` ${skipped.length} file(s) are not visible artifacts (internal record, code, test, generated or not a visible format; see reason): they were not read, not sent to a reviewer and have no pass; the slop gate does not apply to them.`;
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
    description: "밖에 보이는 산출물(README·CHANGELOG·docs·md·html·pptx·docx·xlsx·pdf·hwpx·보고 csv·UI 문구 언어 팩)의 AI 슬롭 검사. 대상은 파일을 읽기 전에 경로와 형식으로 정한다: 보이는 형식이면 공개 저장소·.publicignore·공개 선언과 상관없이 대상이고(.slop-gate.json visible glob은 대상을 더하기만 한다), 소스 코드·주석·로그·테스트·fixture·생성물·내부 규칙·프롬프트·스킬·HANDOFF.md·doc/history·doc/README.md는 대상이 아니라 읽지도 모델에 보내지도 않고 status:\"internal\"과 reason을 돌려준다(통과 아님). action=review(기본): files(cwd 안, 또는 홈·/mnt/<드라이브>/ 아래 경로)의 보이는 글을 뽑아 한국어는 humanizer, 영어는 stop-slop, html·UI 문구·슬라이드는 kill-ai-slop 규칙 본문을 기준으로 cross_review와 같은 reviewer slot 규칙(authors의 반대 계열 필수 reviewer + 자문 슬롯 crossReviewAdvisory reviewer, 병렬, 자문은 120초가 지나거나 필수 reviewer가 모두 끝나고 20초 유예가 지나면 끊기고 실패해도 기록만 한다)으로 심사해 finding {id, file, quote, rule, fix}을 돌려준다. finding이 없으면 같은 호출에서 파일 내용(sha256)에 묶인 통과를 원장에 남기고, 이미 통과한 내용은 모델을 부르지 않는다. 고친 파일은 바이트가 달라 새로 심사해야 한다. action=resolve(Main 전용): reviewId의 finding을 {id, status:\"refuted\", evidence}로만 닫으며, 모든 finding이 반박되고 파일 내용이 심사한 바이트와 같을 때 통과를 기록한다. git_finalize는 커밋할 보이는 산출물마다 이 통과를 요구하고, 이번 입력에서 저장소 밖에 쓴 보이는 산출물은 통과 없이 턴이 끝나지 않는다.",
    parameters: z.object({
      action: z.string().optional().describe("review(기본) 또는 resolve"),
      files: z.array(z.string()).optional().describe("review 대상: cwd 기준 경로, 또는 홈 폴더·/mnt/<드라이브>/ 아래 절대 경로(/tmp·~/.omp·~/.cache·node_modules·.git 제외)"),
      lang: z.enum(["ko", "en", "both"]).optional().describe("언어를 강제할 때만. 기본은 글자 구성으로 판정"),
      authors: z.array(z.string()).optional().describe("글을 쓴 모델 selector 또는 \"main\"(기본 [\"main\"]). cross_review와 같은 규칙으로 reviewer slot을 정한다"),
      reviewId: z.string().optional(),
      resolutions: z.array(z.object({ id: z.string(), status: z.string(), evidence: z.string() })).optional(),
    }) as never,
    async execute(_id, params, signal, _onUpdate, ctx) {
      const abort = signal ?? new AbortController().signal;
      const result = await executeSlopCheck(params as SlopCheckParams, ctx, {
        cwd: ctx.cwd, ledgerPath: slopLedgerPath(), mainModel: currentModel(ctx), advisoryModel: advisoryModelOf(ctx),
        complete: (lane, system, prompt, attempt) => completeReviewer(lane, prompt, ctx, attempt, { system, purpose: "slop-gate" }),
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
