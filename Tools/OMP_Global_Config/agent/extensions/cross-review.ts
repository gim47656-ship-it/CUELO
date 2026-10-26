import { chmodSync, mkdirSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
// 런타임 패키지는 legacy-pi 확장 loader가 host SDK 경로로 재작성하므로 아래에서 지연 import한다.
import {
  authorFamily,
  REVIEW_SYSTEM,
  REVIEW_TIMEOUT_MS,
  ReviewerCallError,
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

/**
 * 계열 교차검증 도구. review(probe·delta 라운드 포함)는 Main과 Maker child(agents/maker.md tools 목록) 모두 부를 수 있고,
 * git_finalize가 믿는 통과 지문을 남기는 resolve는 Main 전용이라 subagent 세션에서는 거절한다. 모델 호출은 skim의
 * completeRole과 같은 경로(역할 slot 해석 → completeSimple → 비용 장부)이며 대화·사용자 프로필 없이 고정 system 한 줄 +
 * 변경 본문 한 통만 보낸다.
 */

const OPENAI_PROVIDERS: Record<string, true> = { "openai-codex": true, openai: true };

/** slot이 가리키는 모델을 해석해 한 번 부른다(reasoning high, 10분 제한). 응답이 돌아온 시도는 비용 장부에 남긴다. */
/** system·purpose는 slop_check가 같은 slot 해석·호출·비용 장부 경로를 재사용할 때만 바꾼다. 기본값은 cross_review 그대로다. */
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

function reviewDeps(ctx: ExtensionContext, signal: AbortSignal): ReviewDeps {
  const path = ledgerPath();
  const ledger = createRoutingLedger(path);
  const current = ctx.models.current() ?? ctx.model;
  mkdirSync(snapshotRoot(), { recursive: true, mode: 0o700 });
  chmodSync(snapshotRoot(), 0o700);
  return {
    cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), mainModel: current ? `${current.provider}/${current.id}` : undefined, advisoryModel: advisoryModelOf(ctx),
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

/** 진행 알림을 받는 도구 update 콜백(core의 onUpdate와 같은 모양). */
export type CrossReviewUpdate = (partial: { content: { type: "text"; text: string }[]; details: { progress: ReviewProgress } }) => void;

export async function executeCrossReview(
  params: CrossReviewParams, ctx: ExtensionContext, signal: AbortSignal,
  makeDeps: (ctx: ExtensionContext, signal: AbortSignal) => ReviewDeps = reviewDeps,
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
  const made = makeDeps(ctx, signal);
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
    return runResolve(input, deps);
  }
  throw new Error(`Unknown action ${JSON.stringify(params.action)}; use "review" or "resolve".`);
}

export default function crossReview(pi: ExtensionAPI): void {
  const z = pi.zod;
  pi.registerTool({
    name: "cross_review", label: "Cross Review", loadMode: "essential", approval: "read",
    description: "계열 교차검증. review는 Main과 Maker가 부를 수 있고 resolve는 Main 전용이다(Maker는 자기 high-risk 코드의 review 체인을 돌린 뒤 reviewId 체인과 finding별 제안 status·근거를 보고하고, Main이 확인해 resolve한다). action=review: files(cwd 기준 상대 경로)의 변경을 반대 계열 reviewer(Anthropic 저자→OpenAI 슬롯 Astra, OpenAI·그 밖의 저자→Anthropic 슬롯 Opus)와 늘 함께 도는 자문 슬롯 crossReviewAdvisory(Argon, 저자가 그 모델 자체일 때만 빠진다)가 acceptance 기준으로 적대적으로 읽고 {reviewId, reviewer 모델, round, triggers, findings[]}를 돌려준다. 자문 reviewer는 필수 reviewer와 함께 시작해 120초가 지나거나 필수 reviewer가 모두 끝나면 끊기며 호출 실패·해석 불가·시간 초과·중단은 reviewers[]와 advisoryReviewers에 기록만 하고 통과를 막지 않지만(다음 라운드가 다시 부른다), 그 전에 답한 finding(R*-ADV-*, 옛 기록은 R*-GGL-*)은 다른 reviewer의 것처럼 resolve로 닫아야 한다. authors는 코드를 쓴 모델 selector이며 두 계열이면 둘 다 돌린다. Main 세션은 \"main\"(자기 현재 모델)도 쓸 수 있지만 subagent 세션에서 \"main\"은 거절되므로 자기 모델 selector를 주고, subagent 세션의 1회차 authors에 세션 자신의 모델과 같은 계열이 없으면 거절된다. previousReviewId를 주면 다음 라운드이고 체인은 최대 5회(probe 라운드 1회 + probe가 아닌 라운드 4회)다: probe가 아닌 라운드는 직전 라운드가 본 내용 이후의 delta만 보며 바뀐 것이 없으면 거절한다. finding을 고친 뒤에는 다음 라운드로 그 수정을 reviewer에게 다시 보이는 것이 정상 흐름이며, 마지막 라운드의 내용과 다른 파일이 resolve 때 있으면 결과의 unreviewedChanges로 알리며, 그 중 코드 파일(git_finalize 게이트와 같은 분류)은 통과를 막는다(문서·테스트·생성물만이면 안내일 뿐 통과 판정은 그대로다). base(선택, 1회차 전용, 빈 문자열은 주지 않은 것으로 읽는다)는 이미 커밋된 변경을 심사할 때 쓰는 HEAD 또는 그 조상 커밋이며, 그 커밋부터 HEAD까지의 변경을 보여 준다. 대상 파일의 작업 트리가 HEAD와 같아야 하고(수정·삭제·추적 안 한 새 파일은 거절, git이 무시하는 새 파일은 건너뜀) base가 없으면 HEAD와 작업 트리를 비교한다(커밋 뒤에도 같은 체인을 previousReviewId로 이어 가는 것은 base 없이 된다). reviewer는 코드만으로 가릴 수 없는 의심에 finding.probe{steps, expectIfReal, expectIfNot?}(재현 실험)를 붙일 수 있다. Main이나 Maker가 그 실험을 돌린 뒤 previousReviewId와 probeResults[{findingId, command, exitCode, output}]를 주면 probe 라운드가 되어 코드 변경이 없어도 실험 결과로 한 번 더 판단받고, reviewer가 finding마다 verdicts{confirmed|withdrawn|unresolved}를 낸다(판단이 빠지면 unresolved). 체인에 없는 findingId·중복 결과·두 번째 probe 라운드·개인키 블록이 든 결과는 거절하며, output은 발췌로 결과당 8KB(넘으면 앞뒤만 남김)·합계 40KB(넘으면 거절)이고 비밀 값은 가려 신뢰하지 않는 자료로 전달한다. verdict는 자문일 뿐 finding을 자동으로 닫거나 통과시키지 않는다. references(선택, 최대 10개)는 심사 대상이 아닌 맥락용 기존·신규 파일(예: 작업 기록, 계약 파일)의 현재 내용을 변경 뒤에 읽기 전용으로 싣는다. 명시한 경로만이며 통과 지문을 덮지 않고 references만으로는 심사하지 않는다. 비밀 경로·gitignore·심볼릭 링크·바이너리·파일당 64KB/합계 100KB 초과, 읽는 동안 열린 파일의 실제 경로가 고정한 저장소 루트 아래 요청 경로와 달라진 경우는 빠지고 skippedReferences에 이유가 나온다. 이 경로 확인은 Linux(WSL 포함)의 /proc/self/fd에 의존하므로 native Windows/macOS에서는 references를 읽지 않고 skippedReferences에 unsupported 이유를 남긴다(변경 파일 심사는 그대로). inputs(선택, 최대 10개)는 변경이 일관돼야 하는 명세·계약·스키마·호출자 파일이며, references와 같은 읽기·필터·제한으로 별도 블록에 싣고(심사 대상 아님, 빠진 것은 skippedInputs) files와 겹치면 거절한다. references와 달리 통과에 묶여서, resolve 뒤 입력이 바뀌거나 지워지면 git_finalize가 그 통과를 덮지 않는 것으로 보고 다시 검토를 요구한다(inputs 없는 검토는 그대로). 이어지는 라운드는 앞 라운드의 입력을 이어받고 더할 수 있으며, 이어받은 입력을 더 읽을 수 없으면 거절하므로 빼려면 previousReviewId 없이 새로 시작한다. 파일 내용은 reviewer 슬롯이 가리키는 provider(현재 OpenAI·Anthropic, 자문 자리는 Google AI Studio 프록시)로 전송되며 비밀 이름·내용·바이너리·큰 입력은 거절/제외한다. action=resolve(Main 전용, 다른 세션이 시작한 체인도 닫을 수 있다): reviewId 체인의 모든 finding에 {id, status fixed|refuted|limit, evidence}가 있어야 pass:true이고 그 시점 파일 내용(git blob)이 통과 지문으로 기록된다(withdrawn 판단도 자동으로 닫지 않는다). 마지막 라운드 reviewer가 본 내용과 다른 코드 파일이 resolve 시점에 남아 있으면 finding이 모두 닫혀도 pass:false(unreviewedBlocking)이고, previousReviewId로 새 라운드를 돌려 그 수정을 reviewer에게 보인 뒤 다시 resolve한다. 더 돌릴 probe가 아닌 라운드가 없는 체인(또는 마지막 라운드가 바이너리·개인키·비밀 경로로 건너뛴 파일)에서만 unreviewedAcknowledgements[{path, evidence}]로 미검토 코드 파일마다 그 내용에 한 검사를 근거로 적어 통과할 수 있고(라운드가 남았거나 근거가 비면 rejectedAcknowledgements로 거절), 받아들인 확인 응답은 resolve 기록에 경로·blob·근거로 남는다. git_finalize는 trigger·표본에 걸린 코드 파일에 이 통과 기록을 요구한다(주석 줄만 바뀐 것이 증명된 TS/JS 수정과 git이 바이너리로 보는 미디어·문서·글꼴 자산은 대상이 아니다). reviewer의 PASS 표현은 근거가 아니다.",
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
}
