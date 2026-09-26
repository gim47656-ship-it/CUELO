import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { isPathOwned, parseOwnedPaths } from "../command-guard/task-guard";
import { resolvePreparedTaskInput, storePreparedTaskBatch } from "./prepared-task";
import { assignmentsByName, summarizeHistory, type AttemptIdentity, type DispatchRecord, type RoutingHistory, type RoutingLedger } from "./routing-ledger";

export interface RoutingFacts {
  goal: string;
  acceptance: string[];
  facts: string[];
  hypotheses: string[] | null;
  unknowns: string[] | null;
  paths: string[];
  callBoundaries: string[] | null;
  settledImplementation: string[] | null;
  reusedPatterns: string[] | null;
  remainingJudgments: string[] | null;
  invariants: string[];
  checks: string[];
  failureEvidence: string[] | null;
}
interface RouteTask { name: string; task: string; assessment: RoutingFacts }
export interface Owner {
  name: string | null;
  primaryDeliverable: string | null;
  ownedPaths: string[];
  active?: boolean;
}
interface Candidate { profile: string; model: string; efforts: string[] }
/** registry·추론 강도 확인에 실패한 후보. 다른 후보의 발주를 막지 않고, 다른 모델로 대체하지도 않는다. */
export interface UnavailableCandidate { profile: string; model: string; reason: string }
interface CandidateSet { available: Candidate[]; unavailable: UnavailableCandidate[] }
/** 같은 준비→발주 계약에서 공유하는 provider online 갱신 시도. 값은 실패 사유이고 null이면 성공이다. */
type RefreshAttempts = Map<string, Promise<string | null>>;
interface RoutingPolicy {
  modelSelection: {
    profiles: Record<string, { modelConfigPath: string; workClass: string; allowedEfforts: string[] }>;
    criteria: Record<string, string>;
    hardFocusCriteria: Record<string, string>;
    uiUxBoundaryCriteria: string;
    /** 위임 판정 정본(MAIN·MAKER·UNKNOWN). 정책이 항상 싣는다. */
    delegationCriteria: Record<string, string>;
  };
  effortSelection: { criteria: Record<string, string> };
}
export interface RoutingQuestion {
  type: "choice" | "noul";
  instructions: string;
  criteria?: Record<string, string | null>;
}
interface RoutingAnswer { type?: string; choice?: string; noul?: number }
export interface RoutingPlacement {
  action: "dispatch-new" | "instruct-existing" | "retarget-existing" | "main-decision";
  ownerIndex: number | null;
  owner: Owner | null;
}
/** Main 재량용 계정 잔량 참고 정보. 후보 revision·Jev state에는 넣지 않는다. */
export interface QuotaLimit {
  id: string | null;
  usedFraction: number | null;
  resetsAt: number | null;
  daySlot: { usedPct: number | null; quotaPct: number | null; slotsLeft: number | null; quality: string | null } | null;
}
export interface QuotaAccount {
  credentialId: number | null;
  disabled: boolean;
  autoBlockedUntilMs: number | null;
  limitReached: boolean | null;
  fetchedAt: number | null;
  limits: QuotaLimit[];
}
export type QuotaSnapshot =
  | { state: "observed"; observedAt: number; providers: Record<string, QuotaAccount[]> }
  | { state: "unavailable"; observedAt: number; reason: string };
export interface RoutingDeps {
  judge: (ctx: ExtensionContext, request: { state: unknown; questions: Record<string, RoutingQuestion> }, signal?: AbortSignal) => Promise<{ answers: Record<string, RoutingAnswer> }>;
  settings: (ctx: ExtensionContext) => Promise<{ getModelRoles(): Readonly<Record<string, string>> } | undefined>;
  owners: () => Owner[];
  policy?: () => RoutingPolicy;
  candidates?: (ctx: ExtensionContext, policy: RoutingPolicy) => Promise<Candidate[]>;
  /** 후보 provider별 계정 잔량. 생략하면 CUELO usage 사이드카(`OMP_USAGE_PORT`, 기본 30142)를 읽는다. */
  quota?: (providers: string[], signal?: AbortSignal) => Promise<QuotaSnapshot>;
  /** 발주 이력. 생략하면 기록·history 요약을 하지 않는다. 실패는 발주를 막지 않는다. */
  ledger?: RoutingLedger;
}

// 잔량은 참고 정보다. 실측: 사이드카 `/usage` 웜 응답 1-3ms, 콜드 경로가 실행하는
// `omp usage --json` 0.25-1.3s(4회 실측 1249·246·750·295ms), 사이드카 자체 캐시 60s.
// 이 예산을 넘기면 배치를 더 붙잡지 않고 이번 호출만 unavailable로 두며,
// 다음 호출은 사이드카 캐시가 채워져 웜으로 답한다.
const QUOTA_ADVISORY_BUDGET_MS = 2_000;
const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** CUELO usage 사이드카의 `/usage`를 후보 provider만 남겨 요약한다. 실패는 unavailable로 두고 발주를 막지 않는다. */
export async function readSidecarQuota(providers: string[], signal?: AbortSignal): Promise<QuotaSnapshot> {
  const observedAt = Date.now();
  const port = Number(process.env.OMP_USAGE_PORT || 30142);
  const budget = AbortSignal.timeout(QUOTA_ADVISORY_BUDGET_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/usage`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, budget]) : budget,
    });
    if (!response.ok) return { state: "unavailable", observedAt, reason: `usage sidecar HTTP ${response.status}` };
    const body = await response.json() as { brokerOk?: boolean; reports?: Record<string, unknown>[] };
    if (body.brokerOk === false) return { state: "unavailable", observedAt, reason: "usage sidecar brokerOk=false" };
    const wanted = new Set(providers);
    const byProvider: Record<string, QuotaAccount[]> = Object.fromEntries(providers.map((provider) => [provider, []]));
    for (const report of body.reports ?? []) {
      const provider = typeof report.provider === "string" ? report.provider : "";
      if (!wanted.has(provider)) continue;
      const metadata = (report.metadata ?? {}) as Record<string, unknown>;
      const limits = Array.isArray(report.limits) ? report.limits as Record<string, unknown>[] : [];
      byProvider[provider]!.push({
        credentialId: finiteOrNull(report.credentialId),
        disabled: report.disabled === true,
        autoBlockedUntilMs: finiteOrNull(report.autoBlockedUntilMs),
        limitReached: typeof metadata.limitReached === "boolean" ? metadata.limitReached : null,
        fetchedAt: finiteOrNull(report.fetchedAt),
        limits: limits.map((limit) => {
          const amount = (limit.amount ?? {}) as Record<string, unknown>;
          const window = (limit.window ?? {}) as Record<string, unknown>;
          const daySlot = limit.daySlot as Record<string, unknown> | undefined;
          return {
            id: typeof limit.id === "string" ? limit.id : null,
            usedFraction: finiteOrNull(amount.usedFraction),
            resetsAt: finiteOrNull(window.resetsAt),
            daySlot: daySlot
              ? {
                usedPct: finiteOrNull(daySlot.usedPct),
                quotaPct: finiteOrNull(daySlot.quotaPct),
                slotsLeft: finiteOrNull(daySlot.slotsLeft),
                quality: typeof daySlot.quality === "string" ? daySlot.quality : null,
              }
              : null,
          };
        }),
      });
    }
    return { state: "observed", observedAt, providers: byProvider };
  } catch (error) {
    return {
      state: "unavailable",
      observedAt,
      reason: budget.aborted
        ? `usage sidecar advisory budget 초과 (${QUOTA_ADVISORY_BUDGET_MS}ms)`
        : error instanceof Error ? error.message : String(error),
    };
  }
}
const policyUrl = new URL("../../rules/harness-policy.json", import.meta.url);
export function loadRoutingPolicy(): RoutingPolicy {
  return JSON.parse(readFileSync(policyUrl, "utf8")).routing;
}

// 명시된 사실 필드만 전달한다. task 원문·현재 모델·이전 등급은 로컬 바인딩에만 남는다.
function routingFactsState(input: RoutingFacts) {
  return {
    goal: input.goal, acceptance: input.acceptance, facts: input.facts,
    hypotheses: input.hypotheses ?? null, unknowns: input.unknowns ?? null,
    paths: input.paths, callBoundaries: input.callBoundaries ?? null,
    settledImplementation: input.settledImplementation ?? null, reusedPatterns: input.reusedPatterns ?? null,
    remainingJudgments: input.remainingJudgments ?? null, invariants: input.invariants,
    checks: input.checks, failureEvidence: input.failureEvidence ?? null,
  };
}

export function routingState(input: RoutingFacts, owners: Owner[]) {
  return {
    ...routingFactsState(input),
    existingOwners: owners.map((owner, index) => ({
      owner: index, name: owner.name, goal: owner.primaryDeliverable, ownedPaths: owner.ownedPaths,
    })),
  };
}

function decisionQuestions(policy: RoutingPolicy, candidates: Candidate[]) {
  const questions: Record<string, RoutingQuestion> = {
    workClass: {
      type: "choice", criteria: policy.modelSelection.criteria,
      instructions: "위 criteria를 정본으로 facts·remainingJudgments·callBoundaries·invariants에 남은 판단을 대조한다. Main이 정한 목표·방향과 구현자가 해결할 설계·검증 판단을 구분한다. 가설과 미확인은 사실로 바꾸지 않는다. 다른 질문의 답이나 목표 분류 비율을 가정하지 않는다.",
    },
    hardFocus: {
      type: "choice", criteria: policy.modelSelection.hardFocusCriteria,
      instructions: "남은 판단의 지배적 성격을 분류한다. 프론트엔드 경로라도 실행·동시성·상태 불변식이면 CODE_SYSTEM이다. 다른 질문의 답을 가정하지 않는다.",
    },
    uiUxBoundary: {
      type: "noul",
      instructions: `${policy.modelSelection.uiUxBoundaryCriteria}. 남은 UI/UX 판단의 존재를 난이도·지배 분야와 독립적으로 판단한다. 혼합 작업의 UI/UX 경계도 포함하고 파일 확장자만으로 추정하지 않는다.`,
    },
  };
  // 위임 판정은 정책 정본(delegationCriteria = MAIN·MAKER·UNKNOWN)을 그대로 choice 선택지로 쓴다.
  questions.delegation = {
    type: "choice",
    criteria: policy.modelSelection.delegationCriteria,
    instructions: "위 criteria를 정본으로 이 조각의 수행 주체를 독립적으로 판단한다. facts·callBoundaries·reusedPatterns·remainingJudgments·unknowns에 있는 독립 완결성, Main 보유 문맥, 실제 병렬·전문성 이득, 설명·검수 부담을 대조한다. 난이도나 병렬 실행 가능성만으로 위임 이득을 단정하지 않는다. 결과는 Main의 조언이며 자동 발주·owner 변경이 아니다.",
  };
  candidates.forEach((candidate, index) => {
    if (candidate.efforts.filter((level) => level in policy.effortSelection.criteria).length <= 1) return;
    questions[`effort${index}`] = {
      type: "choice",
      criteria: Object.fromEntries(candidate.efforts.filter((level) => level in policy.effortSelection.criteria).map((level) => [level, policy.effortSelection.criteria[level]!])),
      instructions: "이 후보가 지원하는 구간에서 관측된 남은 판단과 수용 조건에 충분한 가장 낮은 추론 강도를 독립적으로 고른다. 작업 등급이나 다른 질문의 답을 가정하지 않는다. 위험·파일 수·경과 시간·이전 실패 횟수만으로 강도를 올리지 않는다.",
    };
  });
  return questions;
}
function placementQuestions(owners: Owner[]) {
  if (owners.length === 0) return {};
  return {
    duplicate: { type: "noul", instructions: "이 조각이 existingOwners 중 기존 owner의 완료물과 소유 범위를 중복하는가?" },
    additionalInstruction: { type: "noul", instructions: "새 발주 없이 existingOwners 중 기존 owner에게 추가 지시하는 것으로 충분한가?" },
    ownerTarget: {
      type: "choice",
      criteria: {
        ...Object.fromEntries(owners.map((_owner, index) => [`owner${index}`, `existingOwners[${index}]가 이 조각을 이어서 맡을 식별 가능한 owner다.`])),
        NONE: "어느 existingOwners와도 완료물·소유 범위가 맞지 않는다.",
        UNKNOWN: "주어진 사실만으로 어느 existingOwners인지 식별할 수 없다.",
      },
      instructions: "duplicate/additionalInstruction의 답을 가정하지 말고, 이 조각을 맡을 식별 가능한 기존 owner 하나를 고른다.",
    },
  } satisfies Record<string, RoutingQuestion>;
}

export function routingQuestions(policy: RoutingPolicy, candidates: Candidate[], owners: Owner[]) {
  return { ...decisionQuestions(policy, candidates), ...placementQuestions(owners) };
}

export interface DispatchContract {
  workClass: string;
  primaryDeliverable: string;
  ownedPaths: string[];
  findingId: string | null;
}

type DispatchContractLock = Pick<DispatchContract, "workClass" | "primaryDeliverable">;

/** TASK_GUARD 블록의 필드 reader. 블록이 없으면 null. */
function guardFields(task: string): ((name: string) => string) | null {
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  if (!marker) return null;
  const remainderStart = marker.index + marker[0].length;
  const remainder = task.slice(remainderStart);
  const separator = /\r?\n\s*\r?\n/.exec(remainder);
  const blockEnd = separator ? remainderStart + separator.index : task.length;
  const block = task.slice(remainderStart, blockEnd).replace(/\r\n/g, "\n");
  return (name) => block.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im"))?.[1]?.trim() ?? "";
}

function dispatchContract(task: string, lock: DispatchContractLock | undefined): DispatchContract | null {
  const field = guardFields(task);
  if (!field) return null;
  const workClass = field("WORK_CLASS").toLowerCase() || lock?.workClass;
  const primaryDeliverable = field("PRIMARY_DELIVERABLE") || lock?.primaryDeliverable;
  const ownedPaths = parseOwnedPaths(field("OWNED_PATHS"));
  if (!workClass || !primaryDeliverable || ownedPaths.length === 0) return null;
  return {
    workClass,
    primaryDeliverable,
    ownedPaths,
    findingId: field("FINDING_ID") || null,
  };
}

/**
 * 소유 경로는 집합 의미다. 중복을 제거하고 결정적 순서로 정렬한 정규형을 만들며, 문자열 자체는
 * `parseOwnedPaths`가 이미 한 정규화 범위 밖으로 바꾸지 않는다.
 */
function canonicalOwnedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function briefKey(name: string, contract: DispatchContract) {
  // extension 인스턴스가 session 귀속을 보장한다. 본문·context 문구가 아니라 task 이름과
  // SpawnGuard가 실제로 소비하는 Task Guard 의미 필드로 준비 판단을 연결한다.
  // 소유 경로만 정규형으로 직렬화해, 같은 소유 범위를 뜻하는 계약이 표기 순서나 중복 기재만으로
  // 어긋나지 않게 한다. 정규형은 키·비교용이고 파싱한 계약과 소유 판정 입력은 그대로 둔다.
  return JSON.stringify([name.trim(), { ...contract, ownedPaths: canonicalOwnedPaths(contract.ownedPaths) }]);
}

/** 거절 진단에 싣는 사용자 입력 유래 값(이름·경로·식별자)의 상한. 본문·secret 후보는 싣지 않는다. */
const DIAGNOSTIC_VALUE_LIMIT = 60;
const DIAGNOSTIC_LIST_LIMIT = 8;

function clipped(value: string, limit = DIAGNOSTIC_VALUE_LIMIT): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

function clippedList(values: readonly string[]): string {
  const shown = values.slice(0, DIAGNOSTIC_LIST_LIMIT).map((value) => clipped(value, 40));
  return values.length > DIAGNOSTIC_LIST_LIMIT
    ? `${shown.join(", ")} 외 ${values.length - DIAGNOSTIC_LIST_LIMIT}개`
    : shown.join(", ");
}

/**
 * 같은 이름으로 준비된 계약과 이번 발주 계약이 어긋난 필드. 한 항목이 한 필드이므로 길이가 곧
 * 어긋난 필드 수이고, 두 계약이 정확히 같으면 빈 배열이다. OWNED_PATHS는 집합으로 비교하므로
 * 표기 순서와 중복 기재는 차이가 아니다.
 */
function contractDelta(prepared: DispatchContract, requested: DispatchContract): string[] {
  const delta: string[] = [];
  const pair = (label: string, left: string | null, right: string | null) => {
    if ((left ?? "") === (right ?? "")) return;
    delta.push(`${label} 준비=${left === null ? "<없음>" : `'${clipped(left)}'`} 발주=${right === null ? "<없음>" : `'${clipped(right)}'`}`);
  };
  pair("WORK_CLASS", prepared.workClass, requested.workClass);
  pair("PRIMARY_DELIVERABLE", prepared.primaryDeliverable, requested.primaryDeliverable);
  pair("FINDING_ID", prepared.findingId, requested.findingId);
  const preparedPaths = canonicalOwnedPaths(prepared.ownedPaths);
  const requestedPaths = canonicalOwnedPaths(requested.ownedPaths);
  const added = requestedPaths.filter((path) => !preparedPaths.includes(path));
  const removed = preparedPaths.filter((path) => !requestedPaths.includes(path));
  if (added.length > 0) delta.push(`OWNED_PATHS 추가: ${clippedList(added)}`);
  if (removed.length > 0) delta.push(`OWNED_PATHS 빠짐: ${clippedList(removed)}`);
  return delta;
}

/**
 * 같은 이름의 준비 계약 중 이번 발주 계약과 차이가 가장 적은 것을 고른다. 어긋난 필드 수가 먼저이고,
 * 동률이면 OWNED_PATHS 차집합 크기가 작은 쪽, 그마저 동률이면 목록의 마지막(최신)을 쓴다.
 */
function closestPreparedContract(prepared: readonly DispatchContract[], requested: DispatchContract): DispatchContract {
  const requestedPaths = canonicalOwnedPaths(requested.ownedPaths);
  let best = prepared[0]!;
  let bestFields = Number.POSITIVE_INFINITY;
  let bestPaths = Number.POSITIVE_INFINITY;
  for (const candidate of prepared) {
    const fields = contractDelta(candidate, requested).length;
    const candidatePaths = canonicalOwnedPaths(candidate.ownedPaths);
    const paths = candidatePaths.filter((path) => !requestedPaths.includes(path)).length
      + requestedPaths.filter((path) => !candidatePaths.includes(path)).length;
    if (fields < bestFields || (fields === bestFields && paths <= bestPaths)) {
      best = candidate;
      bestFields = fields;
      bestPaths = paths;
    }
  }
  return best;
}

/** 빈 delta 안내가 무엇을 비교했는지 함께 보여줄 때 쓰는 비교 범위. */
const COMPARED_CONTRACT_FIELDS = "WORK_CLASS·PRIMARY_DELIVERABLE·OWNED_PATHS(집합)·FINDING_ID";

/**
 * prepared 미일치 거절 문구. 같은 이름으로 준비된 계약이 있으면 가장 가까운 계약과 어긋난 필드만
 * 지목하고, 이름 자체가 없으면 이 session에 준비된 이름 목록을 보여준 뒤 다음 한 수를 제시한다.
 */
function preparedMismatchReason(
  name: string,
  requested: DispatchContract,
  prepared: readonly DispatchContract[],
  preparedNames: readonly string[],
): string {
  const label = name ? `이름 '${clipped(name)}'` : "빈 task 이름";
  if (prepared.length === 0) {
    const known = preparedNames.length > 0
      ? `이 session에 준비된 이름: ${clippedList(preparedNames)}`
      : "이 session에는 준비된 발주가 없습니다";
    return `${label}으로 준비된 발주가 없습니다. ${known}. 그 이름과 이번 Task Guard 계약·관측 사실로 maker_route를 다시 부르고 그 결과의 preparedId로 발주하세요. 본문·context 문구는 연결 키가 아니며 같은 브리프를 두 번 판정하지 않습니다.`;
  }
  const delta = contractDelta(closestPreparedContract(prepared, requested), requested);
  if (delta.length === 0) {
    // 키가 정규형이라 여기 도달하면 준비 기록과 발주 입력의 연결 자체가 어긋난 상태다. 없는 차이를
    // 지어내지 않고, 비교한 범위와 다음 한 수만 말한다.
    return `${label}의 준비 계약과 이번 발주 계약은 ${COMPARED_CONTRACT_FIELDS}에서 차이가 없습니다. 같은 이름과 같은 Task Guard 계약으로 maker_route를 다시 불러 새 preparedId를 받은 뒤 그 값으로 발주하세요. 본문·context 문구는 연결 키가 아닙니다.`;
  }
  return `${label}의 준비 계약과 이번 발주 계약이 다릅니다: ${delta.join("; ")}. 위 차이를 포함한 이번 계약으로 maker_route를 다시 부르고 그 결과의 preparedId로 발주하세요. 본문·context 문구는 연결 키가 아닙니다.`;
}

function ownedPathsOverlap(left: string, right: string): boolean {
  return isPathOwned([left], right) || isPathOwned([right], left);
}

function relevantOwners(contract: DispatchContract, owners: Owner[]): Owner[] {
  return owners.filter((owner) =>
    owner.ownedPaths.some((owned) =>
      contract.ownedPaths.some((requested) => ownedPathsOverlap(owned, requested))
    )
  );
}

function ownerRevision(owners: Owner[]): string {
  return JSON.stringify(owners.map((owner) => [
    owner.name,
    owner.primaryDeliverable,
    owner.ownedPaths,
  ]));
}

function placementOf(
  prepared: { status: "judged" | "unavailable"; answers: Record<string, RoutingAnswer> | null },
  owners: Owner[],
): RoutingPlacement {
  if (prepared.status !== "judged" || !prepared.answers) {
    return { action: "main-decision", ownerIndex: null, owner: null };
  }
  const duplicate = (prepared.answers.duplicate?.noul ?? 0) >= 0.5;
  const additional = (prepared.answers.additionalInstruction?.noul ?? 0) >= 0.5;
  const target = prepared.answers.ownerTarget?.choice?.match(/^owner(\d+)$/);
  const ownerIndex = target ? Number(target[1]) : -1;
  const owner = owners[ownerIndex] ?? null;
  if (!owner || (!duplicate && !additional)) {
    return { action: "dispatch-new", ownerIndex: null, owner: null };
  }
  return {
    action: additional ? "instruct-existing" : "retarget-existing",
    ownerIndex,
    owner,
  };
}

const isRetired = (model: string) => /(?:^|\/)swe-2(?:[:/]|$)|^devin\//i.test(model);

/** Jev hardFocus 답과 HARD 후보 profile의 대응. 값은 `modelSelection.profiles`의 profile 이름이다. */
const HARD_FOCUS_PROFILES: Readonly<Record<string, string>> = {
  UI_UX: "HARD_UI_OPUS",
  CODE_SYSTEM: "HARD_CODE_OPUS",
};

/**
 * 비-UI NORMAL은 primary(NORMAL_SOL = modelRoles.implSol)를 우선한다.
 * 대안이 한도 여유가 더 크다는 이유로 primary를 밀지 않는다. 계정 사용 가능성은 core 신호
 * (disabled·limitReached·autoBlockedUntil)로만 보고, 미관측은 소진으로 간주하지 않는다.
 */
function normalAllocation(policy: RoutingPolicy, candidates: readonly Candidate[], quota: QuotaSnapshot) {
  const normal = candidates.filter((candidate) => policy.modelSelection.profiles[candidate.profile]?.workClass === "NORMAL" && candidate.profile !== "NORMAL_OPUS");
  const primary = normal.find((candidate) => candidate.profile === "NORMAL_SOL");
  const unavailable = (reason: string) => ({ state: "unavailable" as const, profile: (primary ?? normal[0])?.profile ?? null, reason });
  if (quota.state !== "observed") return unavailable(quota.reason);
  /** 그 후보 provider의 관측된 계정이 모두 사용 불가할 때만 소진으로 본다. 계정을 관측하지 못하면 소진이 아니다. */
  const exhausted = (candidate: Candidate) => {
    const provider = candidate.model.slice(0, candidate.model.indexOf("/"));
    const accounts = quota.providers[provider] ?? [];
    if (!accounts.length) return false;
    return !accounts.some((account) => !account.disabled && !account.limitReached
      && !(account.autoBlockedUntilMs != null && account.autoBlockedUntilMs > quota.observedAt));
  };
  if (!primary) {
    // primary NORMAL 후보 자체가 없으면(사용 불가·후보 제외) 사용 가능한 NORMAL 대안을 쓴다.
    const alternative = normal.find((candidate) => !exhausted(candidate));
    if (alternative) {
      return { state: "observed" as const, profile: alternative.profile, reason: "primary NORMAL 후보가 없어 사용 가능한 NORMAL 대안을 추천합니다." };
    }
    return unavailable("사용 가능한 NORMAL 후보가 없습니다.");
  }
  if (!exhausted(primary)) {
    return { state: "observed" as const, profile: primary.profile, reason: "primary NORMAL이 사용 가능해 한도 여유 크기 비교 없이 이를 추천합니다." };
  }
  const fallback = normal.find((candidate) => candidate.profile !== primary.profile && !exhausted(candidate));
  if (fallback) {
    return { state: "observed" as const, profile: fallback.profile, reason: "primary NORMAL 계정 한도가 소진되어 사용 가능한 NORMAL 대안을 추천합니다." };
  }
  return unavailable("primary NORMAL 계정 한도가 소진되었고 사용 가능한 NORMAL 대안이 없습니다.");
}

function recommendedProfile(answers: Record<string, RoutingAnswer> | null, candidates: readonly Candidate[]) {
  const workClass = answers?.workClass?.choice;
  const profile = workClass === "HARD"
    ? HARD_FOCUS_PROFILES[answers?.hardFocus?.choice ?? ""] ?? null
    : null;
  return candidates.some((candidate) => candidate.profile === profile) ? profile : null;
}


export function registerMakerRouting(pi: ExtensionAPI, deps: RoutingDeps) {
  type Judgment = {
    answers: Record<string, RoutingAnswer> | null;
    status: "judged" | "unavailable";
    error?: string;
  };
  type Prepared = Judgment & {
    revision: string;
    profile: string | null;
    candidates: Candidate[];
    owners: Owner[];
    publicationToken: symbol;
    refreshAttempts: RefreshAttempts;
  };
  const bindings = new Map<string, Promise<Prepared>>();
  // 검사를 통과한 발주의 이력 초안. spawn 성공(noteSpawned) 때만 identity와 함께 ledger에 남긴다.
  const pendingDispatches = new Map<string, Omit<DispatchRecord, "ts" | keyof AttemptIdentity>>();
  // 거절 진단 전용 색인. 준비된 계약을 이름별로 시간순으로 모아 어긋난 필드를 지목하며,
  // 통과·차단 판정에는 관여하지 않는다.
  const preparedContracts = new Map<string, DispatchContract[]>();
  const decisionCache = new Map<string, Promise<Judgment>>();
  const placementCache = new Map<string, Promise<Judgment>>();
  const latestPublications = new Map<string, { identity: string; token: symbol; pending: number }>();
  let generation = 0;
  let contractLock: DispatchContractLock | undefined;
  const reset = () => {
    generation++;
    bindings.clear();
    pendingDispatches.clear();
    preparedContracts.clear();
    decisionCache.clear();
    placementCache.clear();
    latestPublications.clear();
    contractLock = undefined;
  };
  const releaseContractLock = () => {
    contractLock = undefined;
  };
  const policy = deps.policy ?? loadRoutingPolicy;
  async function candidateSet(ctx: ExtensionContext, current: RoutingPolicy, attempts?: RefreshAttempts): Promise<CandidateSet> {
    // registry 지원 강도 중 profile 허용 구간 안의 것만 후보 강도다. 구간 밖(max 포함)은 질문도 발주도 하지 않는다.
    const allowedEfforts = (profile: string, efforts: readonly string[]) => {
      const allowed = current.modelSelection.profiles[profile]?.allowedEfforts ?? [];
      return efforts.filter((level) => allowed.includes(level));
    };
    if (deps.candidates) return {
      available: (await deps.candidates(ctx, current)).map((candidate) => ({
        ...candidate, efforts: allowedEfforts(candidate.profile, candidate.efforts),
      })).filter((candidate) => candidate.efforts.length > 0),
      unavailable: [],
    };
    const settings = await deps.settings(ctx);
    if (!settings) throw new Error("Maker 라우팅 설정을 읽을 수 없습니다.");
    // 임의 slot은 modelRoles record에서 읽는다(OMP 18.3.1은 Settings.get을 없앴고 getModelRoles만 남겼다).
    const modelRoles = settings.getModelRoles();
    const profiles = Object.entries(current.modelSelection.profiles);
    // 후보 하나의 장애는 그 후보만 unavailable로 표시한다. 선택하지 않을 후보 때문에 발주 전체를 막지 않는다.
    // 자리(slot)는 profile 순서를 지킨다. 강도 확인은 registry에서 찾은 뒤 그 자리에서 한 번만 한다.
    const slots: (Candidate | UnavailableCandidate)[] = [];
    const retryable: { index: number; profile: string; base: string; provider: string; id: string }[] = [];
    profiles.forEach(([profile, entry], index) => {
      const selector = modelRoles[entry.modelConfigPath.slice("modelRoles.".length)] ?? "";
      const base = selector.replace(/:(?:off|minimal|low|medium|high|xhigh|max)$/, "");
      if (isRetired(base)) { slots[index] = { profile, model: base, reason: "SWE-2는 새 작업 후보에서 제외되어 있습니다." }; return; }
      const slash = base.indexOf("/");
      const provider = base.slice(0, slash), id = base.slice(slash + 1);
      const model = ctx.modelRegistry.find(provider, id);
      if (model) {
        const efforts = allowedEfforts(profile, model.thinking?.efforts ?? []);
        slots[index] = efforts.length > 0
          ? { profile, model: base, efforts }
          : { profile, model: base, reason: "지원 추론 강도를 확인할 수 없는 후보" };
        return;
      }
      if (slash > 0) { retryable.push({ index, profile, base, provider, id }); return; }
      slots[index] = { profile, model: base, reason: "registry에 없는 Maker 후보" };
    });
    if (retryable.length > 0) {
      // 같은 준비→발주 계약에서 같은 provider의 online 갱신은 한 번만 시작하고,
      // 서로 다른 provider는 함께 시작한다. 새 prepare/reset은 새 map으로 다시 시도한다.
      const attempt = (provider: string): Promise<string | null> => {
        const shared = attempts?.get(provider);
        if (shared) return shared;
        const started = (async () => {
          try {
            await ctx.modelRegistry.refreshProvider(provider, "online");
            return null;
          } catch (error) {
            return `provider 갱신 실패: ${error instanceof Error ? error.message : String(error)}`;
          }
        })();
        attempts?.set(provider, started);
        return started;
      };
      const failures = new Map<string, string | null>();
      await Promise.all([...new Set(retryable.map((item) => item.provider))].map(async (provider) => {
        failures.set(provider, await attempt(provider));
      }));
      for (const item of retryable) {
        const failure = failures.get(item.provider);
        const model = failure ? undefined : ctx.modelRegistry.find(item.provider, item.id);
        const efforts = allowedEfforts(item.profile, model?.thinking?.efforts ?? []);
        slots[item.index] = efforts.length > 0
          ? { profile: item.profile, model: item.base, efforts }
          : {
            profile: item.profile,
            model: item.base,
            reason: model ? "지원 추론 강도를 확인할 수 없는 후보" : failure ?? "registry에 없는 Maker 후보",
          };
      }
    }
    const available = slots.filter((slot): slot is Candidate => "efforts" in slot);
    const unavailable = slots.filter((slot): slot is UnavailableCandidate => !("efforts" in slot));
    if (!available.length) {
      throw new Error(`사용 가능한 Maker 후보가 없습니다: ${unavailable.map((item) => `${item.profile}=${item.model || "<빈 slot>"} (${item.reason})`).join("; ")}`);
    }
    return { available, unavailable };
  }
  const candidateList = async (ctx: ExtensionContext, current: RoutingPolicy, attempts?: RefreshAttempts) =>
    (await candidateSet(ctx, current, attempts)).available;
  const revisionOf = (current: RoutingPolicy, candidates: Candidate[]) =>
    JSON.stringify([current.modelSelection, current.effortSelection, candidates]);

  const answersFor = (
    answers: Record<string, RoutingAnswer>,
    questions: Record<string, RoutingQuestion>,
  ): Record<string, RoutingAnswer> =>
    Object.fromEntries(Object.keys(questions).flatMap((key) => answers[key] ? [[key, answers[key]!]] : []));
  const cacheJudgment = (
    cache: Map<string, Promise<Judgment>>,
    key: string,
    pending: Promise<Judgment>,
  ): Promise<Judgment> => {
    cache.set(key, pending);
    void pending.then((result) => {
      if (result.status === "unavailable" && cache.get(key) === pending) cache.delete(key);
    });
    return pending;
  };

  const judge = async (
    ctx: ExtensionContext,
    state: unknown,
    questions: Record<string, RoutingQuestion>,
    signal?: AbortSignal,
  ): Promise<Judgment> => {
    try {
      const result = await deps.judge(ctx, { state, questions }, signal);
      return { answers: result.answers, status: "judged" };
    } catch (error) {
      return {
        answers: null,
        status: "unavailable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const INSTRUCTION = "Main은 profile·recommendations.uiUxBoundary·placement·history를 보고 후보와 concrete effort를 지정합니다. 등급 NORMAL/HARD와 모델 이름을 구분합니다. NORMAL UI/UX 경계는 NORMAL_OPUS, 비-UI는 NORMAL_SOL 우선이며 실제 소진·사용 불가 때만 NORMAL_DEEPSEEK를 추천합니다. 한도 미관측은 소진이 아닙니다. 기존 NORMAL의 명시적 Opus 선택은 ROUTING_REASON으로 유지합니다. HARD는 UI_UX→HARD_UI_OPUS, CODE_SYSTEM→HARD_CODE_OPUS이며 HARD_CODE_ASTRA는 명시적 대안입니다. 후보별 허용·registry 지원 강도만 쓰고 max나 coarse effort는 쓰지 않습니다. 작업 중 UI/UX 경계가 드러나면 기존 owner의 실제 모델을 확인하고, 비-Opus의 미완 변경·증거를 freeze해 소유권을 넘깁니다. active writer와 겹치거나 실행 중 모델·effort를 바꾸지 않습니다. 같은 Opus owner와 완료된 비-UI 작업은 재사용합니다. Opus unavailable을 다른 후보로 숨기지 않습니다. 계정 warm/exact pin·전환·쿨다운·리셋은 유지합니다. 추천 변경·Jev 불가·기존 owner 대신 새 발주는 ROUTING_REASON을 남깁니다. history는 같은 등급 최근 attempt의 중립 건수이며 후보·규칙을 자동 변경하지 않습니다. routing_verdict에는 실제 spawn identity를 씁니다. context='PREPARED_CONTEXT', task='PREPARED_TASK: <preparedId>'로 원문을 재사용하며 같은 브리프에 judge를 중복 호출하지 않습니다.";
  /** 배치 공통 정보(candidates·quota·instruction)는 한 번만, task별 route는 배열로 돌려준다. */
  async function prepareBatch(context: string, tasks: RouteTask[], ctx: ExtensionContext, signal?: AbortSignal, callId = "") {
    const current = policy();
    const allOwners = deps.owners();
    const atGeneration = generation;
    // TaskGuard는 같은 요청의 첫 child가 확립한 WORK_CLASS/PRIMARY_DELIVERABLE을 이후 child에
    // 파생한다. 준비 도구도 같은 batch와 이미 연결된 task에서 그 두 필드만 상속한다.
    let candidateLock = contractLock;
    const contracts = tasks.map((task) => {
      const contract = dispatchContract(task.task, candidateLock);
      if (!contract) throw new Error("maker_route와 task는 TaskGuard lock으로 완성 가능한 WORK_CLASS·PRIMARY_DELIVERABLE 및 명시 OWNED_PATHS가 필요합니다.");
      candidateLock ??= { workClass: contract.workClass, primaryDeliverable: contract.primaryDeliverable };
      return contract;
    });
    const keys = tasks.map((task, index) => briefKey(task.name, contracts[index]!));
    // 준비 handle. 실제 발주 identity는 spawn에서 task 호출 id·index·session으로 캡처한다.
    // 이 값으로 실제 발주를 식별하지 않으며, 중첩 prepare가 서로를 덮지 않도록 공유 map에 두지 않는다.
    const sessionId = (ctx.sessionManager?.getSessionId?.() ?? "").trim();
    const plans = tasks.map((_task, index) => ({ sessionId, planId: `${sessionId}#${callId}#${index}` }));
    const publicationClaims = tasks.map((task, index) => {
      const key = keys[index]!;
      const identity = JSON.stringify([
        routingFactsState(task.assessment),
        current.modelSelection,
        current.effortSelection,
      ]);
      const latest = latestPublications.get(key);
      if (latest?.identity === identity && latest.pending > 0) {
        latest.pending += 1;
        return { key, token: latest.token };
      }
      const token = Symbol(key);
      latestPublications.set(key, { identity, token, pending: 1 });
      return { key, token };
    });
    const requireLatest = () => {
      if (atGeneration !== generation) throw new Error("session이 변경되어 이전 라우팅 판단은 폐기되었습니다.");
      if (publicationClaims.some((claim) => latestPublications.get(claim.key)?.token !== claim.token)) {
        throw new Error("같은 task 계약에 더 최신 facts 준비가 있어 이전 라우팅 판단은 폐기되었습니다.");
      }
    };
    let quotaAbort: AbortController | undefined;
    try {
      const ownersByTask = contracts.map((contract) => relevantOwners(contract, allOwners));
      const refreshAttempts: RefreshAttempts = new Map();
      const { available: candidates, unavailable: unavailableCandidates } = await candidateSet(ctx, current, refreshAttempts);
      requireLatest();
      // 잔량은 시각마다 바뀌므로 revision·identity·Jev state 밖의 참고 정보로만 붙인다.
      // Jev 판단과 함께 시작하되 판단이 끝났을 때 아직 진행 중이면 취소하고 unavailable로 반환한다.
      // quota API는 AbortSignal을 지원하며 rejection은 여기서 흡수해 background unhandled를 남기지 않는다.
      const quotaProviders = [...new Set(candidates.map((candidate) => candidate.model.slice(0, candidate.model.indexOf("/"))))];
      quotaAbort = new AbortController();
      const quotaSignal = signal
        ? AbortSignal.any([signal, quotaAbort.signal])
        : quotaAbort.signal;
      let settledQuota: QuotaSnapshot | undefined;
      let quotaPending: Promise<void>;
      try {
        const quotaRequest = (deps.quota ?? readSidecarQuota)(quotaProviders, quotaSignal);
        quotaPending = quotaRequest.then(
          (snapshot) => {
            settledQuota = snapshot;
          },
          (error) => {
            settledQuota = {
              state: "unavailable",
              observedAt: Date.now(),
              reason: error instanceof Error ? error.message : String(error),
            };
          },
        );
      } catch (error) {
        settledQuota = {
          state: "unavailable",
          observedAt: Date.now(),
          reason: error instanceof Error ? error.message : String(error),
        };
        quotaPending = Promise.resolve();
      }
      const publications = await Promise.all(tasks.map(async (task, index) => {
        const contract = contracts[index]!;
        const owners = ownersByTask[index]!;
        const revision = revisionOf(current, candidates);
        const key = keys[index]!;
        const decisionState = routingFactsState(task.assessment);
        const decisionKey = JSON.stringify([key, decisionState, revision]);
        const placementKey = JSON.stringify([decisionKey, ownerRevision(owners)]);
        const baseQuestions = decisionQuestions(current, candidates);
        const ownerQuestions = placementQuestions(owners);
        let decisionPending = decisionCache.get(decisionKey);
        let placementPending = placementCache.get(placementKey);

        if (!decisionPending) {
          const fullQuestions = { ...baseQuestions, ...ownerQuestions };
          const fullPending = judge(ctx, routingState(task.assessment, owners), fullQuestions, signal);
          decisionPending = cacheJudgment(
            decisionCache,
            decisionKey,
            fullPending.then((result) => ({
              ...result,
              answers: result.answers ? answersFor(result.answers, baseQuestions) : null,
            })),
          );
          if (owners.length > 0) {
            placementPending = cacheJudgment(
              placementCache,
              placementKey,
              fullPending.then((result) => ({
                ...result,
                answers: result.answers ? answersFor(result.answers, ownerQuestions) : null,
              })),
            );
          }
        } else if (!placementPending && owners.length > 0) {
          placementPending = cacheJudgment(
            placementCache,
            placementKey,
            judge(
              ctx,
              routingState(task.assessment, owners),
              ownerQuestions,
              signal,
            ).then((result) => ({
              ...result,
              answers: result.answers ? answersFor(result.answers, ownerQuestions) : null,
            })),
          );
        }

        const decision = await decisionPending;
        const placement = placementPending
          ? await placementPending
          : { status: "judged" as const, answers: {} };
        const prepared: Prepared = {
          revision,
          profile: null,
          candidates,
          publicationToken: publicationClaims[index]!.token,
          refreshAttempts: new Map(refreshAttempts),
          owners,
          status: decision.status === "judged" && placement.status === "judged" ? "judged" : "unavailable",
          error: [decision.error, placement.error].filter(Boolean).join("; ") || undefined,
          answers: decision.answers === null
            ? null
            : { ...decision.answers, ...(placement.answers ?? {}) },
        };
        requireLatest();
        return {
          key,
          prepared,
          route: {
            name: task.name,
            status: prepared.status,
            error: prepared.error,
            recommendations: prepared.answers,
            placement: placementOf(prepared, owners),
            existingOwners: owners,
          },
        };
      }));
      const quota: QuotaSnapshot = settledQuota ?? {
        state: "unavailable",
        observedAt: Date.now(),
        reason: "route 판단 완료 시 quota 조회가 아직 진행 중이어서 사용할 수 없습니다.",
      };
      if (!settledQuota) quotaAbort.abort();
      // 위 rejection handler가 모든 종료를 흡수한다. 취소를 존중하는 quota 구현은 여기서 종료된다.
      void quotaPending;
      requireLatest();
      const allocation = normalAllocation(current, candidates, quota);
      // 이력은 advisory다. revision·identity·Jev state 밖에 두며 읽기 실패는 빈 이력이다.
      const ledgerRecords = deps.ledger?.read();
      const historyOf = (answers: Record<string, RoutingAnswer> | null): RoutingHistory | null => {
        const grade = answers?.workClass?.choice;
        if (!ledgerRecords || !grade || !(grade in current.modelSelection.criteria)) return null;
        return summarizeHistory(ledgerRecords, grade, grade === "HARD" ? answers?.hardFocus?.choice ?? null : null);
      };
      for (const publication of publications) {
        const answers = publication.prepared.answers;
        const uiUxBoundary = (answers?.uiUxBoundary?.noul ?? 0) >= 0.5;
        publication.prepared.profile = answers?.workClass?.choice === "NORMAL"
          ? uiUxBoundary
            ? candidates.find((candidate) => candidate.profile === "NORMAL_OPUS")?.profile ?? null
            : allocation.profile
          : recommendedProfile(answers, candidates);
      }
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("maker_route prepared 참조를 저장할 current session id가 없습니다.");
      }
      const preparedIds = storePreparedTaskBatch(context, tasks, sessionId);
      publications.forEach((publication, index) => {
        bindings.set(publication.key, Promise.resolve(publication.prepared));
        const name = tasks[index]!.name.trim();
        preparedContracts.set(name, [...(preparedContracts.get(name) ?? []), contracts[index]!]);
      });
      return {
        candidates,
        unavailableCandidates,
        quota,
        instruction: INSTRUCTION,
        routes: publications.map((publication, index) => ({
          ...publication.route,
          profile: publication.prepared.profile,
          normalAllocation: publication.prepared.answers?.workClass?.choice === "NORMAL"
            && (publication.prepared.answers?.uiUxBoundary?.noul ?? 0) < 0.5 ? allocation : null,
          uiUxHandoff: (publication.prepared.answers?.uiUxBoundary?.noul ?? 0) >= 0.5
            ? "기존 owner가 Opus인지 확인하세요. 비-Opus면 미완 변경·증거를 freeze하고 소유권을 넘깁니다. active owner를 동시에 새 발주하거나 실행 중 모델을 바꾸지 않습니다."
            : null,
          history: historyOf(publication.prepared.answers),
          preparedId: preparedIds[index],
          plan: plans[index] ?? { sessionId, planId: null },
        })),
      };
    } finally {
      quotaAbort?.abort();
      for (const claim of publicationClaims) {
        const latest = latestPublications.get(claim.key);
        if (latest?.token === claim.token && latest.pending > 0) latest.pending -= 1;
      }
    }
  }
  /** task별 route만 필요한 호출부용. 배치 공통 정보는 `prepareBatch`가 준다. */
  const prepare = async (context: string, tasks: RouteTask[], ctx: ExtensionContext, signal?: AbortSignal) =>
    (await prepareBatch(context, tasks, ctx, signal)).routes;

  async function beforeTask(input: Record<string, unknown>, ctx: ExtensionContext) {
    let canonicalInput: Record<string, unknown>;
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      canonicalInput = resolvePreparedTaskInput(input, typeof sessionId === "string" ? sessionId : "");
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
    const tasks = (Array.isArray(canonicalInput.tasks) ? canonicalInput.tasks : [canonicalInput]) as Record<string, unknown>[];
    const atGeneration = generation;
    // 후보 해석은 작업마다 현재 local registry로 다시 한다. 같은 prepared 계약에서 이미 시작한
    // online provider 시도만 재사용하고, 이 task 호출에서 새로 필요한 provider도 함께 공유한다.
    const refreshAttempts: RefreshAttempts = new Map();
    let candidateLock = contractLock;
    const contracts = tasks.map((item) => {
      const task = typeof item.task === "string" ? item.task : "";
      const contract = dispatchContract(task, candidateLock);
      if (!contract) return null;
      candidateLock ??= { workClass: contract.workClass, primaryDeliverable: contract.primaryDeliverable };
      return contract;
    });
    const drafts: [string, Omit<DispatchRecord, "ts" | keyof AttemptIdentity>][] = [];
    for (const [itemIndex, item] of tasks.entries()) {
      const requested = typeof item.model === "string" ? item.model : "";
      const task = typeof item.task === "string" ? item.task : "";
      if (isRetired(requested) || /\[character-summon[^\]]*model="devin\//.test(task)) return { block: true, reason: "SWE-2 사용은 중단되었습니다. 인증·기록·캐릭터 identity를 바꾸지 않으며 다른 모델로 몰래 대체하지 않습니다." };
      // 명시적 캐릭터 summon은 일반 구현 발주가 아니며 기존 summon guard가 검증한다.
      if (/\[character-summon alias="[^"]+" model="[^"]+"/.test(task)) continue;
      const contract = contracts[itemIndex];
      if (!contract) return { block: true, reason: "task는 TaskGuard lock으로 완성 가능한 WORK_CLASS·PRIMARY_DELIVERABLE 및 명시 OWNED_PATHS가 필요합니다." };
      const name = String(item.name ?? "").trim();
      const key = briefKey(String(item.name ?? ""), contract);
      const pending = bindings.get(key);
      if (!pending) {
        return { block: true, reason: preparedMismatchReason(name, contract, preparedContracts.get(name) ?? [], [...preparedContracts.keys()]) };
      }
      const prepared = await pending;
      for (const [provider, attempt] of prepared.refreshAttempts) {
        if (!refreshAttempts.has(provider)) refreshAttempts.set(provider, attempt);
      }
      if (atGeneration !== generation) {
        return { block: true, reason: "session이 변경되어 이전 라우팅 판단은 발주에 사용할 수 없습니다." };
      }
      if (latestPublications.get(key)?.token !== prepared.publicationToken) {
        return { block: true, reason: "같은 task 계약에 더 최신 maker_route 준비가 있습니다. 최신 판단이 끝난 뒤 그 결과로 발주하세요." };
      }
      const current = policy();
      const candidates = await candidateList(ctx, current, refreshAttempts);
      if (atGeneration !== generation) {
        return { block: true, reason: "session이 변경되어 이전 라우팅 판단은 발주에 사용할 수 없습니다." };
      }
      if (latestPublications.get(key)?.token !== prepared.publicationToken) {
        return { block: true, reason: "candidate 확인 중 같은 task 계약에 더 최신 maker_route 준비가 생겼습니다. 최신 판단으로 발주하세요." };
      }
      if (prepared.revision !== revisionOf(current, candidates)) return { block: true, reason: "후보 또는 판단 기준이 바뀌었습니다. maker_route로 변경된 조건만 다시 판단하세요." };
      const owners = relevantOwners(contract, deps.owners());
      if (ownerRevision(prepared.owners) !== ownerRevision(owners)) return { block: true, reason: "현재 소유권 충돌 조건이 바뀌었습니다. maker_route로 owner placement만 다시 판단하세요." };
      // 같은 모델이 여러 profile에 있을 수 있다(HARD_*). 추천 profile, 이어서 추천 등급의
      // profile 구간으로 검사해 등급의 강도 구간을 모델 이름으로 우회하지 못하게 한다. 추천 등급에 그 모델이
      // 없거나 등급을 모르면(Jev 불가) 그 강도를 허용하는 profile로 본다. 추천과 다른 profile은 아래에서 ROUTING_REASON을 요구한다.
      const cut = requested.lastIndexOf(":");
      const effort = cut > 0 ? requested.slice(cut + 1) : "";
      const sameModel = candidates.filter((candidate) => candidate.model === (cut > 0 ? requested.slice(0, cut) : requested));
      const grade = (prepared.profile ? current.modelSelection.profiles[prepared.profile]?.workClass : undefined)
        ?? prepared.answers?.workClass?.choice;
      const sameGrade = sameModel.filter((candidate) => current.modelSelection.profiles[candidate.profile]?.workClass === grade);
      const pool = sameGrade.length > 0 ? sameGrade : sameModel;
      const selected = sameModel.find((candidate) => candidate.profile === prepared.profile)
        ?? pool.find((candidate) => candidate.efforts.includes(effort))
        ?? pool[0];
      if (!selected || item.effort !== undefined) return { block: true, reason: "maker_route가 확인한 후보와 concrete effort를 model selector에 지정하세요. coarse effort는 전달하지 않습니다." };
      if (!selected.efforts.includes(effort)) return { block: true, reason: `${selected.profile}(${selected.model})의 허용 강도는 ${selected.efforts.join("·")}입니다. 구간 밖 강도('${effort || "<없음>"}')로는 발주하지 않습니다.` };
      const answers = prepared.answers;
      if (answers?.workClass?.choice === "NORMAL" && (answers.uiUxBoundary?.noul ?? 0) >= 0.5
        && selected.profile !== "NORMAL_OPUS") {
        return { block: true, reason: "NORMAL UI/UX 경계는 NORMAL_OPUS로 배정합니다. Opus가 없으면 unavailable로 보고하며 다른 후보로 조용히 대체하지 않습니다." };
      }
      const profile = prepared.profile;
      const index = candidates.findIndex((candidate) => candidate.profile === selected.profile);
      const recommendedEffort = selected.efforts.length === 1 ? selected.efforts[0] : answers?.[`effort${index}`]?.choice;
      const placement = placementOf(prepared, owners);
      const activeConflicts = owners.filter((owner) => owner.active === true);
      if (activeConflicts.length > 0) {
        return {
          block: true,
          reason: `현재 active owner의 소유 경로와 충돌합니다: ${activeConflicts.map((owner) => owner.name ?? "<unnamed>").join(", ")}. 오래된 owner index나 다른 경로 owner로 자동 배정하지 말고 현재 owner에게 지시하거나 maker_route로 placement를 다시 판단하세요.`,
        };
      }
      const existingOwner = placement.action === "instruct-existing" || placement.action === "retarget-existing";
      const changed = prepared.status !== "judged" || profile !== selected.profile || recommendedEffort !== effort || existingOwner;
      const routingReason = /^\s*ROUTING_REASON:\s*\S.+$/m.test(task);
      if (changed && !routingReason) return { block: true, reason: existingOwner ? `기존 owner${placement.owner?.name ? ` ${placement.owner.name}` : ""}에게 추가 지시하거나 범위를 retarget하세요. Main이 새 발주를 선택하면 ROUTING_REASON에 근거를 적습니다.` : "Jev 불가·불명확한 지배 판단·추천 변경은 Main이 같은 기준으로 결정하고 ROUTING_REASON 한 줄에 근거를 남깁니다." };
      const recommended = candidates.findIndex((candidate) => candidate.profile === profile);
      const recommendedCandidate = candidates[recommended];
      const workClass = answers?.workClass?.choice ?? null;
      drafts.push([key, {
        type: "dispatch",
        name,
        workClass,
        focus: workClass === "HARD" ? answers?.hardFocus?.choice ?? null : null,
        recommendedProfile: profile,
        recommendedModel: recommendedCandidate?.model ?? null,
        recommendedEffort: !recommendedCandidate ? null
          : recommendedCandidate.efforts.length === 1 ? recommendedCandidate.efforts[0]! : answers?.[`effort${recommended}`]?.choice ?? null,
        chosenModel: selected.model,
        chosenEffort: effort,
        routingReason,
        purpose: guardFields(task)?.("PURPOSE").toLowerCase() || null,
      }]);
    }
    for (const [key, draft] of drafts) pendingDispatches.set(key, draft);
    return canonicalInput === input ? undefined : { input: canonicalInput };
  }

  /**
   * task spawn 성공 경계. TaskGuard lock을 확립하고, 검사를 통과해 실제로 spawn된 발주만 이력에 남긴다.
   * 실제 attempt identity는 이 spawn의 task 호출 id·index·session으로만 캡처한다(준비 handle과 섞지 않는다).
   * 돌려주는 map은 task index → 관측된 identity이며, settle 시 같은 identity로 outcome을 잇는다.
   */
  function noteSpawned(
    input: Record<string, unknown>,
    sessionId: string,
    callId: string,
    ids: ReadonlyMap<number, { agentId: string; jobId: string }>,
  ): Map<number, AttemptIdentity> {
    const tasks = (Array.isArray(input.tasks) ? input.tasks : [input]) as Record<string, unknown>[];
    const dispatched = new Map<number, AttemptIdentity>();
    // 같은 session 원장에서 이름별 assignment·최대 attempt를 읽어 FINDING_ID 재작업만 같은 assignment로 잇는다.
    // 원장에서 읽으므로 reload 뒤에도 연결이 유지되고, 관측되지 않은 준비만으로는 연결하지 않는다.
    const known = assignmentsByName(deps.ledger?.read() ?? [], sessionId);
    let candidateLock = contractLock;
    for (const [index, item] of tasks.entries()) {
      const task = typeof item.task === "string" ? item.task : "";
      const contract = dispatchContract(task, candidateLock);
      if (!contract) continue;
      candidateLock ??= { workClass: contract.workClass, primaryDeliverable: contract.primaryDeliverable };
      const name = String(item.name ?? "").trim();
      const key = briefKey(name, contract);
      const draft = pendingDispatches.get(key);
      if (!draft) continue;
      pendingDispatches.delete(key);
      // 다른 guard가 막은 뒤 다른 selector로 다시 낸 발주는 그 호출의 beforeTask 초안만 맞는다.
      if (item.model !== `${draft.chosenModel}:${draft.chosenEffort}`) continue;
      const linked = sessionId && contract.findingId !== null ? known.get(name) : undefined;
      const assignmentId = linked?.assignmentId ?? `${sessionId}#${callId}#${index}`;
      const attempt = linked ? linked.lastAttempt + 1 : 1;
      const identity: AttemptIdentity = {
        sessionId,
        assignmentId,
        attempt,
        attemptId: `${assignmentId}#a${attempt}`,
        // canonical child id와 그 spawn의 jobId는 관측한 값만 쓴다. 없으면 비워 두고 추측하지 않는다.
        agentId: ids.get(index)?.agentId ?? "",
        jobId: ids.get(index)?.jobId ?? "",
      };
      deps.ledger?.append({ ...draft, ...identity, ts: new Date().toISOString() });
      dispatched.set(index, identity);
      known.set(name, { assignmentId, lastAttempt: attempt });
    }
    contractLock ??= candidateLock;
    return dispatched;
  }

  if (pi.registerTool) {
    const z = pi.zod;
    const strings = () => z.array(z.string());
    const nullable = () => strings().nullable();
    const parameters = z.object({ context: z.string(), tasks: z.array(z.object({ name: z.string(), task: z.string(), assessment: z.object({ goal: z.string(), acceptance: strings(), facts: strings(), hypotheses: nullable(), unknowns: nullable(), paths: strings(), callBoundaries: nullable(), settledImplementation: nullable(), reusedPatterns: nullable(), remainingJudgments: nullable(), invariants: strings(), checks: strings(), failureEvidence: nullable() }) })) });
    // SDK 18.2.6 TSchema의 unknown generic 불변성만 연결한다. 실제 Zod schema 검증은 그대로다.
    const toolParameters = parameters as unknown as ToolDefinition["parameters"];
    pi.registerTool({
      name: "maker_route", label: "Maker Route", loadMode: "essential", approval: "read",
      description: "Main 전용 발주 준비. Jev가 위임 적합성·NORMAL/HARD 난이도·UI/UX 경계·HARD 지배 분야·후보별 effort·owner 중복을 한 배치에서 독립 판단한다. NORMAL UI/UX는 NORMAL_OPUS, 비-UI는 NORMAL_SOL 우선이며 실제 소진·사용 불가 때만 NORMAL_DEEPSEEK를 추천한다. HARD_UI_OPUS·HARD_CODE_OPUS는 분야에 따르고 HARD_CODE_ASTRA는 명시적 대안이다. 새 UI/UX 경계는 기존 비-Opus owner를 freeze해 이관하되 실행 중 모델을 바꾸지 않는다. 후보별 강도·소유권·warm/exact pin을 보존한다. Opus unavailable을 조용히 대체하지 않는다. 난이도를 Opus 선택 수단으로 부풀리지 않는다. history는 advisory이고 routing_verdict는 실제 spawn identity를 쓴다. task 원문을 Jev에 보내거나 동일 브리프를 중복 판단하지 않는다.",
      parameters: toolParameters,
      async execute(callId, params, signal, _onUpdate, ctx) {
        // core가 위 schema로 검증한 입력이며 SDK generic 경계에서 소실된 타입만 복원한다.
        const request = params as { context: string; tasks: RouteTask[] };
        const batch = await prepareBatch(request.context, request.tasks, ctx, signal, String(callId ?? ""));
        return { content: [{ type: "text", text: JSON.stringify(batch) }], details: batch };
      },
    });
  }
  return { prepare, prepareBatch, beforeTask, noteSpawned, reset, releaseContractLock };
}
