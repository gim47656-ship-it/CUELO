import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { defaultPrimaryDeliverable, extractGuardBlock, isPathOwned, isPhoneOperatorCall, isSummonCall, normalizeWorkClass, parseOwnedPaths, readGuardField, taskGuardLockOf, WORK_CLASSES } from "../command-guard/task-guard";
import { parseCharacterSummonMarker } from "../character-voice";
import { assignmentsByName, type AttemptIdentity, type DispatchOwnership, type DispatchRecord, type RoutingLedger } from "./routing-ledger";
import type { MakerEffortRange } from "./auto-effort-policy";

export interface Owner {
  name: string | null;
  ownedPaths: string[];
  active?: boolean;
  /** 관측된 spawn의 작업공간. 없으면 공유로 본다. */
  workspace?: DispatchOwnership["workspace"];
  /** 과거 원장 row처럼 소유 경로를 알 수 없는 owner. ownedPaths가 비어도 빈 소유가 아니다. */
  ownershipUnknown?: boolean;
}
interface RoutingPolicy {
  modelSelection: {
    profiles: Record<string, { modelConfigPath: string; startEffort: MakerEffortRange["start"]; maxEffort: MakerEffortRange["max"] }>;
  };
}

interface RoutingDeps {
  settings: (ctx: ExtensionContext) => Promise<{ getModelRoles(): Readonly<Record<string, string>> } | undefined>;
  owners: (ctx: ExtensionContext) => Owner[];
  ledger?: RoutingLedger;
}

const policyUrl = new URL("../../rules/harness-policy.json", import.meta.url);
export function loadRoutingPolicy(): RoutingPolicy {
  return JSON.parse(readFileSync(policyUrl, "utf8")).routing;
}

export interface DispatchContract {
  workClass: string;
  primaryDeliverable: string;
  ownedPaths: string[];
  findingId: string | null;
}

type DispatchContractLock = Pick<DispatchContract, "workClass" | "primaryDeliverable">;

/** SpawnGuard and dispatch read the same Task Guard block and fields. */
function guardFields(task: string): ((name: string) => string) | null {
  const extracted = extractGuardBlock(task);
  if (!extracted) return null;
  return (name) => readGuardField(extracted.block, name) ?? "";
}

function dispatchContract(task: string, lock: DispatchContractLock | undefined, name: string): DispatchContract | null {
  const field = guardFields(task);
  if (!field) return null;
  const explicitWorkClass = field("WORK_CLASS").toLowerCase();
  if (explicitWorkClass && !normalizeWorkClass(explicitWorkClass)) return null;
  const workClass = normalizeWorkClass(explicitWorkClass) || lock?.workClass || "feature";
  const primaryDeliverable = field("PRIMARY_DELIVERABLE") || lock?.primaryDeliverable || defaultPrimaryDeliverable(task, name);
  const ownedPaths = parseOwnedPaths(field("OWNED_PATHS"));
  if (!workClass || !primaryDeliverable || ownedPaths.length === 0) return null;
  return {
    workClass,
    primaryDeliverable,
    ownedPaths,
    findingId: field("FINDING_ID") || null,
  };
}

const GUARD_TEMPLATE =
  `복사한 뒤 <...>를 실제 판단값으로 채우세요(경로는 자동으로 정하지 않습니다):\nTASK_GUARD:\nOWNED_PATHS: <cwd 상대경로, 콤마 구분>\n\nWORK_CLASS는 생략 시 lock 또는 feature, PRIMARY_DELIVERABLE은 생략 시 lock 또는 TASK_TITLE과 task name입니다. TASK_TITLE과 TODO_TASKS는 guard 뒤에 둡니다. 정본 rule://task-guard.`;

/** 계약을 완성하지 못한 이유를 필드 단위로 짚는다. 브리프 본문은 싣지 않는다. */
export function contractGapReason(task: string, lock: DispatchContractLock | undefined, name: string): string {
  const label = name.trim() ? `'${name.trim().slice(0, 60)}'` : "(이름 없음)";
  const field = guardFields(task);
  if (!field) return `task ${label}: \`TASK_GUARD:\` 블록이 없습니다. ${GUARD_TEMPLATE}`;
  const missing: string[] = [];
  const explicitWorkClass = field("WORK_CLASS").toLowerCase();
  if (explicitWorkClass && !normalizeWorkClass(explicitWorkClass)) {
    return `task ${label}: WORK_CLASS는 ${WORK_CLASSES.join("|")} 중 하나여야 합니다(받은 값 '${explicitWorkClass.slice(0, 40)}'). ${GUARD_TEMPLATE}`;
  }
  if (parseOwnedPaths(field("OWNED_PATHS")).length === 0) missing.push("OWNED_PATHS(모든 child 필수)");
  if (!field("PRIMARY_DELIVERABLE") && !lock?.primaryDeliverable && !defaultPrimaryDeliverable(task, name)) {
    missing.push("PRIMARY_DELIVERABLE(TASK_TITLE 또는 task name도 없음)");
  }
  const detail = missing.length > 0
    ? `빠진 필드: ${missing.join(", ")}.`
    : "필드가 블록 안에서 읽히지 않습니다(`TASK_GUARD:` 뒤 빈 줄이나 guard 필드 사이에 끼어든 줄이 있는지 확인).";
  return `task ${label}: ${detail} ${GUARD_TEMPLATE}`;
}

/**
 * 소유 경로는 집합 의미다. 중복을 제거하고 결정적 순서로 정렬한 정규형을 만들며, 문자열 자체는
 * `parseOwnedPaths`가 이미 한 정규화 범위 밖으로 바꾸지 않는다.
 */
function canonicalOwnedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort();
}

function briefKey(name: string, contract: DispatchContract) {
  // Match the admitted contract to the spawn receipt; path order does not change ownership.
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

function ownedPathsOverlap(left: string, right: string): boolean {
  return isPathOwned([left], right) || isPathOwned([right], left);
}

type Workspace = DispatchOwnership["workspace"];

/**
 * core spawnParamsFor와 같은 우선순위로 task 항목의 격리 요청을 읽는다. 항목 값이 있으면 그것, 없으면 상위 값이다.
 * isolated 요청은 격리 준비 실패 시 공유 cwd로 fallback하지 않고 실패하므로(structured-subagent) 별도 worktree scope다.
 * `"capture"`(경쟁 후보: 격리 실행 뒤 patch만 보존하고 부모 checkout에 적용하지 않음)도 같은 worktree scope이므로 isolated다.
 */
export function workspaceOf(input: Record<string, unknown>, item: Record<string, unknown>): Workspace {
  const requested = item.isolated !== undefined ? item.isolated : input.isolated;
  return requested === true || requested === "capture" ? "isolated" : "shared";
}

/** 같은 checkout을 동시에 쓰는 경우만 충돌이다. 격리 worktree는 서로·공유 작업공간과 별도 scope다. */
const sharesCheckout = (left: Workspace | undefined, right: Workspace | undefined) =>
  left !== "isolated" && right !== "isolated";

/**
 * 같은 checkout의 active owner 중 소유 경로가 겹치는 owner. 소유 경로 미상 active owner는 빈 소유로 보지 않고
 * 공유 발주 전체와 충돌로 둔다.
 */
function activeConflicts(ownedPaths: readonly string[], workspace: Workspace, owners: readonly Owner[]): Owner[] {
  return owners.filter((owner) => owner.active === true && sharesCheckout(owner.workspace, workspace) && (
    owner.ownershipUnknown === true
    || owner.ownedPaths.some((owned) => ownedPaths.some((requested) => ownedPathsOverlap(owned, requested)))));
}

function activeConflictReason(conflicts: readonly Owner[]): string {
  const unknown = conflicts.some((owner) => owner.ownershipUnknown === true);
  return `현재 active owner의 소유 경로와 충돌합니다: ${conflicts.map((owner) => owner.name ?? "<unnamed>").join(", ")}. 현재 owner에게 지시하거나 경로를 나누거나, 작업이 끝난 뒤 다시 발주하거나 isolated로 발주하세요.${unknown ? " 소유 경로가 기록되지 않은 과거 발주가 아직 실행 중이라 공유 작업공간의 어느 경로와도 겹칠 수 있다고 봅니다." : ""}`;
}

/** 두 소유 계약이 같은 checkout에서 겹치는 경로. 격리 worktree가 끼면 겹침이 없다. */
function sharedOwnedPaths(left: DispatchOwnership, right: DispatchOwnership): string[] {
  if (!sharesCheckout(left.workspace, right.workspace)) return [];
  return left.ownedPaths.filter((path) => right.ownedPaths.some((other) => ownedPathsOverlap(path, other)));
}

const isRetired = (model: string) => /(?:^|\/)swe-2(?:[:/]|$)|^devin\//i.test(model);

const MAKER_EFFORT = Symbol.for("cuelo.makerEffort");
const effortRangeOf = (profile: RoutingPolicy["modelSelection"]["profiles"][string]): MakerEffortRange =>
  ({ start: profile.startEffort, max: profile.maxEffort });

export function registerMakerRouting(pi: ExtensionAPI, deps: RoutingDeps) {
  // 검사를 통과한 발주의 이력 초안. spawn 성공(noteSpawned) 때만 identity와 함께 ledger에 남긴다.
  // 새 초안은 항상 소유 계약을 싣는다. 원장의 과거 row만 ownership이 없을 수 있다.
  type DispatchDraft = Omit<DispatchRecord, "ts" | "ownership" | keyof AttemptIdentity> & { ownership: DispatchOwnership };
  // 검사를 통과했지만 spawn 결과를 아직 받지 못한 task 호출의 실행 초안(toolCallId → 그 호출 tasks[]의 itemIndex별 초안).
  // Spawn consumes its own drafts; a call ending without a spawn releases only its own reservation.
  const reservations = new Map<string, { itemIndex: number; key: string; draft: DispatchDraft }[]>();
  let generation = 0;
  let contractLock: DispatchContractLock | undefined;
  const reset = () => {
    generation++;
    reservations.clear();
    contractLock = undefined;
  };
  const releaseContractLock = () => {
    contractLock = undefined;
  };
  const sessionIdOf = (ctx: ExtensionContext) => (ctx.sessionManager?.getSessionId?.() ?? "").trim();
  /**
   * TaskGuard가 이 session에 연결돼 있으면 그 lock이 정본이다. 취소 환불·정산으로 TaskGuard가 푼 lock을 사본이
   * 상속하지 않고, 다른 session의 lock은 읽지 않는다. 연결이 없을 때만(TaskGuard 없는 단독 사용) 자기 사본을 쓴다.
   */
  const lockFor = (sessionId: string): DispatchContractLock | undefined => {
    const bound = taskGuardLockOf(sessionId);
    return bound === undefined ? contractLock : bound ?? undefined;
  };
  async function beforeTask(input: Record<string, unknown>, ctx: ExtensionContext, callId: string) {
    const tasks = (Array.isArray(input.tasks) ? input.tasks : [input]) as Record<string, unknown>[];
    const notices: string[] = [];
    const normalizedItems = new Map<number, Record<string, unknown>>();
    const ranges: [index: number, range: MakerEffortRange][] = [];
    const atGeneration = generation;
    let candidateLock = lockFor(sessionIdOf(ctx));
    const locksBefore: (DispatchContractLock | undefined)[] = [];
    const contracts = tasks.map((item) => {
      const task = typeof item.task === "string" ? item.task : "";
      locksBefore.push(candidateLock);
      // 파일을 쓰지 않는 폰 앱 조작 child는 발주 계약과 lock을 세우지 않는다.
      if (isPhoneOperatorCall(item, input)) return null;
      const contract = dispatchContract(task, candidateLock, String(item.name ?? ""));
      if (!contract) return null;
      candidateLock ??= { workClass: contract.workClass, primaryDeliverable: contract.primaryDeliverable };
      return contract;
    });
    const drafts: [number, DispatchDraft][] = [];
    const ready: { itemIndex: number; item: Record<string, unknown>; contract: DispatchContract }[] = [];
    for (const [itemIndex, item] of tasks.entries()) {
      const requested = typeof item.model === "string" ? item.model : "";
      const task = typeof item.task === "string" ? item.task : "";
      if (isRetired(requested) || /\[character-summon[^\]]*model="devin\//.test(task)) return { block: true, reason: "SWE-2 사용은 중단되었습니다. 인증·기록·캐릭터 identity를 바꾸지 않으며 다른 모델로 몰래 대체하지 않습니다." };
      // character-summon child는 일반 구현 발주가 아니다. 정확한 marker가 있거나, 이 session의 사용자가 요청한 캐릭터 호출이
      // 아직 task child로 쓰이지 않았으면(command-guard가 정본을 소유; 단일 alias는 평문 brief를 guard가 marker brief로 다시 쓴다)
      // 면제한다. 그 task는 guard가 pendingSummons로 검증해 요청되지 않은 marker·재사용·혼합 task를 막는다.
      // 정확하지 않은 문자열이나 summon 요청이 없는 marker는 면제하지 않는다.
      if (parseCharacterSummonMarker(task) !== undefined || isSummonCall(sessionIdOf(ctx), callId)) continue;
      // 폰 앱 조작 child는 정의 파일의 Sonnet 슬롯으로만 돌고(model 지정이 있으면 면제가 아니다) 파일을 쓰지 않는다.
      if (isPhoneOperatorCall(item, input)) continue;
      // core schema는 solutionSpace를 필수 string으로 두지만 task 도구가 lenientArgValidation이라 누락·다른 타입도 원 인자 그대로
      // 실행에 넘어오고, 공백은 schema를 통과한다. child auto 분류기는 trim 뒤 빈 값이면 brief 전문으로 강도를 고른다.
      if (typeof item.solutionSpace !== "string" || !item.solutionSpace.trim()) {
        return { block: true, reason: `'${clipped(String(item.name ?? ""), 40)}'의 solutionSpace가 ${typeof item.solutionSpace === "string" ? "공백뿐" : "없거나 문자열이 아님"}입니다. child auto 강도는 이 설명으로 고르므로 해법이 정해졌는지, 열린 원인·설계가 무엇인지 한 줄로 적어 다시 발주하세요.` };
      }
      const contract = contracts[itemIndex];
      if (!contract) return { block: true, reason: `task는 TaskGuard lock으로 완성 가능한 WORK_CLASS·PRIMARY_DELIVERABLE 및 명시 OWNED_PATHS가 필요합니다. ${contractGapReason(task, locksBefore[itemIndex], String(item.name ?? ""))}` };
      ready.push({ itemIndex, item, contract });
    }
    if (ready.length === 0) return;

    let modelRoles: Readonly<Record<string, string>>;
    try {
      const settings = await deps.settings(ctx);
      if (!settings) return { block: true, reason: "Maker 모델 후보 설정을 읽을 수 없습니다." };
      modelRoles = settings.getModelRoles();
    } catch {
      return { block: true, reason: "Maker 모델 후보 설정을 읽을 수 없습니다." };
    }
    const profiles = Object.entries(loadRoutingPolicy().modelSelection.profiles).flatMap(([profileId, profile]) => {
      const role = profile.modelConfigPath.slice("modelRoles.".length);
      const model = modelRoles[role]?.replace(/:(?:off|minimal|low|medium|high|xhigh|max|auto)$/, "");
      return model && !isRetired(model) ? [{ profileId, role: `@${role}`, model, profile }] : [];
    });
    const refreshed = new Set<string>();
    for (const { itemIndex, item, contract } of ready) {
      const name = String(item.name ?? "").trim();
      const task = typeof item.task === "string" ? item.task : "";
      const requested = typeof item.model === "string" ? item.model : "";
      const cut = requested.lastIndexOf(":");
      const base = cut > 0 ? requested.slice(0, cut) : requested;
      const selected = profiles.find((candidate) => requested === candidate.profileId || base === candidate.role || base === candidate.model);
      if (!selected) return { block: true, reason: `'${clipped(name, 40)}': task의 model에 Maker 후보 역할, 모델 또는 프로필 ID를 지정하세요(rule://agent-workflow).` };
      const slash = selected.model.indexOf("/");
      const provider = selected.model.slice(0, slash), id = selected.model.slice(slash + 1);
      let model = slash > 0 ? ctx.modelRegistry.find(provider, id) : undefined;
      if (!model && slash > 0 && !refreshed.has(provider)) {
        // This refresh discovers models without clearing the provider's rate-limit cooldown.
        try {
          await ctx.modelRegistry.refreshDiscoverableProviders([provider], "online");
          refreshed.add(provider);
          model = ctx.modelRegistry.find(provider, id);
        } catch {
          return { block: true, reason: `Maker 후보 '${clipped(selected.model)}'의 provider를 갱신하지 못했습니다.` };
        }
      }
      if (!model?.thinking?.efforts?.length) {
        return { block: true, reason: `Maker 후보 '${clipped(selected.model)}'의 auto 추론 강도를 registry에서 확인할 수 없습니다.` };
      }
      const canonicalModel = `${selected.model}:auto`;
      if (requested !== canonicalModel || item.effort !== undefined) {
        const { effort: _effort, ...normalized } = item;
        normalizedItems.set(itemIndex, { ...normalized, model: canonicalModel });
        notices.push(`[MakerRoute] model '${requested}' → '${canonicalModel}'${item.effort !== undefined ? "; effort 제거" : ""}.`);
      }
      ranges.push([itemIndex, effortRangeOf(selected.profile)]);
      drafts.push([itemIndex, {
        type: "dispatch",
        name,
        workClass: null,
        focus: null,
        recommendedProfile: null,
        recommendedModel: null,
        recommendedEffort: null,
        chosenModel: selected.model,
        chosenEffort: "auto",
        routingReason: false,
        routingReasonText: null,
        workClassConfidence: null,
        workClassProbabilities: null,
        purpose: guardFields(task)?.("PURPOSE").toLowerCase() || null,
        ownership: { primaryDeliverable: contract.primaryDeliverable, ownedPaths: contract.ownedPaths, workspace: workspaceOf(input, item) },
      }]);
    }
    if (atGeneration !== generation) {
      return { block: true, reason: "session이 변경되어 이전 task를 발주하지 않았습니다." };
    }
    // 같은 배치의 공유 작업공간 항목끼리는 게시 전에 한꺼번에 비교한다. 하나라도 겹치면 어떤 초안도 게시하지 않는다.
    const overlaps: string[] = [];
    for (const [leftIndex, [, left]] of drafts.entries()) {
      for (const [, right] of drafts.slice(leftIndex + 1)) {
        const shared = sharedOwnedPaths(left.ownership, right.ownership);
        if (shared.length > 0) overlaps.push(`'${clipped(left.name, 40)}' ↔ '${clipped(right.name, 40)}'(${clippedList(shared)})`);
      }
    }
    if (overlaps.length > 0) {
      return {
        block: true,
        reason: `같은 task 배치에서 공유 작업공간 Maker의 OWNED_PATHS가 겹칩니다: ${overlaps.slice(0, DIAGNOSTIC_LIST_LIMIT).join("; ")}. 배치 전체를 발주하지 않았습니다. 경로를 나누거나 한 owner에게 맡기거나, 겹치는 쪽을 순서대로 내거나 isolated로 발주하세요.`,
      };
    }
    // No awaits from here to reservation: check owners and pending calls on the current snapshot.
    const currentOwners = deps.owners(ctx);
    for (const [, draft] of drafts) {
      const conflicts = activeConflicts(draft.ownership.ownedPaths, draft.ownership.workspace, currentOwners);
      if (conflicts.length > 0) return { block: true, reason: activeConflictReason(conflicts) };
    }
    const reserved: string[] = [];
    for (const [, draft] of drafts) {
      for (const [heldCall, held] of reservations) {
        if (heldCall === callId) continue;
        for (const { draft: other } of held) {
          const shared = sharedOwnedPaths(draft.ownership, other.ownership);
          if (shared.length > 0) reserved.push(`'${clipped(draft.name, 40)}' ↔ 승인 중 '${clipped(other.name, 40)}'(${clippedList(shared)})`);
        }
      }
    }
    if (reserved.length > 0) {
      return {
        block: true,
        reason: `다른 task 호출이 발주 승인을 받아 spawn 결과를 기다리는 공유 작업공간 OWNED_PATHS와 겹칩니다: ${reserved.slice(0, DIAGNOSTIC_LIST_LIMIT).join("; ")}. 이 호출은 발주하지 않았습니다. 그 호출의 결과가 돌아온 뒤 현재 owner를 확인해 다시 내거나, 경로를 나누거나 isolated로 발주하세요.`,
      };
    }
    if (callId && drafts.length > 0) reservations.set(callId, drafts.map(([itemIndex, draft]) => ({ itemIndex, key: briefKey(draft.name, contracts[itemIndex]!), draft })));
    const canonicalInput = normalizedItems.size === 0 ? input : Array.isArray(input.tasks)
      ? { ...input, tasks: tasks.map((item, index) => normalizedItems.get(index) ?? item) }
      : normalizedItems.get(0)!;
    // Only attach the effort range once the entire batch passes admission.
    for (const [index, range] of ranges) Reflect.set(normalizedItems.get(index) ?? tasks[index]!, MAKER_EFFORT, range);
    if (notices.length > 0) {
      pi.sendMessage?.({ customType: "maker-route-advisory", content: notices.join("\n"), display: true }, { triggerTurn: false });
      return { ...(canonicalInput === input ? {} : { input: canonicalInput }), notices };
    }
    return canonicalInput === input ? undefined : { input: canonicalInput };
  }

  /**
   * spawn 없이 끝난 task 호출의 예약과 초안만 푼다. 하류 guard 거절·승인 거부·실행 전 abort·skip은 core가 tool_result 없이
   * tool_execution_end만 내고, task 실행 오류는 isError tool_result를 낸다. 다른 호출의 예약과 이미 이관된 owner는 건드리지 않는다.
   */
  function releaseCall(callId: string): void {
    reservations.delete(callId);
  }

  /**
   * task spawn 성공 경계. TaskGuard lock을 확립하고, 검사를 통과해 실제로 spawn된 발주만 이력에 남긴다.
   * 실제 attempt identity는 이 spawn의 task 호출 id·index·session으로만 캡처한다(준비 handle과 섞지 않는다).
   * 돌려주는 map은 task index → 관측된 identity와 원장에 남긴 소유 계약이며, settle 시 같은 identity로 outcome을 잇는다.
   */
  function noteSpawned(
    input: Record<string, unknown>,
    sessionId: string,
    callId: string,
    ids: ReadonlyMap<number, { agentId: string; jobId: string }>,
  ): Map<number, { identity: AttemptIdentity; ownership: DispatchOwnership }> {
    const tasks = (Array.isArray(input.tasks) ? input.tasks : [input]) as Record<string, unknown>[];
    const dispatched = new Map<number, { identity: AttemptIdentity; ownership: DispatchOwnership }>();
    // FINDING_ID가 있는 배치만 전체 세션 이력을 한 번 읽고, 배치 앞 항목의 발주를 메모리에서도 잇는다.
    const hasRework = tasks.some((item) => readGuardField(
      extractGuardBlock(typeof item.task === "string" ? item.task : "")?.block ?? "", "FINDING_ID",
    ) !== undefined);
    let known: Map<string, { assignmentId: string; lastAttempt: number }> | undefined;
    let candidateLock = lockFor(sessionId.trim());
    const reserved = reservations.get(callId) ?? [];
    for (const [index, item] of tasks.entries()) {
      const task = typeof item.task === "string" ? item.task : "";
      const contract = dispatchContract(task, candidateLock, String(item.name ?? ""));
      if (!contract) continue;
      candidateLock ??= { workClass: contract.workClass, primaryDeliverable: contract.primaryDeliverable };
      const name = String(item.name ?? "").trim();
      // 이 호출이 admission에서 받은 그 항목의 초안만 소비한다. 같은 이름·같은 계약의 다른 호출 초안은 그 호출의 것이다.
      const draft = reserved.find((entry) => entry.itemIndex === index && entry.key === briefKey(name, contract))?.draft;
      if (!draft) continue;
      // 다른 guard가 막은 뒤 다른 selector로 다시 낸 발주는 그 호출의 beforeTask 초안만 맞는다.
      if (item.model !== `${draft.chosenModel}:${draft.chosenEffort}`) continue;
      if (hasRework && sessionId) {
        known ??= assignmentsByName(deps.ledger?.read(sessionId) ?? [], sessionId);
      }
      const linked = sessionId && contract.findingId !== null ? known?.get(name) : undefined;
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
      dispatched.set(index, { identity, ownership: draft.ownership });
      known?.set(name, { assignmentId, lastAttempt: attempt });
    }
    contractLock ??= candidateLock;
    // 시작한 child는 이제 호출부의 live owner 목록이 소유한다. 이 호출의 예약은 여기서 넘긴다.
    reservations.delete(callId);
    return dispatched;
  }

  return { beforeTask, releaseCall, noteSpawned, reset, releaseContractLock };
}
