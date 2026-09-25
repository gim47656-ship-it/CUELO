/**
 * 한 사용자 요청의 누적 spawn cap. `task.maxConcurrency=8`의 동시 실행 슬롯과는 별개이며,
 * 두 full primary wave와 한 full rework wave까지 허용한 뒤 runaway spawn을 차단한다.
 */
export const TASK_BUDGET_LIMITS = Object.freeze({
  primaryMaker: 16,
  reworkMaker: 8,
  total: 24,
});

/**
 * 잘못 발주한 full 8-slot wave를 런타임이 취소했다고 확인한 경우에만 되돌려주는 슬롯 상한(요청당).
 * 한 wave는 복구하되 spawn→cancel 반복으로 누적 cap을 우회하지 못하도록 환불에도 천장을 둔다.
 */
export const CANCEL_REFUND_LIMIT = 8;

type WorkClass = "feature" | "maintenance" | "diagnostic";
type Purpose = "primary" | "rework";

type Usage = {
  primaryMaker: number;
  reworkMaker: number;
  total: number;
};

type Lock = {
  workClass: WorkClass;
  deliverableKey: string;
  deliverable: string;
};

type Delta = Usage;

type Reservation = {
  delta: Delta;
  names: string[];
  /** 이 호출이 띄운 maker 계열 항목들(순서 = tasks[] 순서). 이름 없는 항목은 name이 없다. */
  makers: MakerSpawn[];
};

/** maker 계열 spawn 하나가 소유한다고 선언한 경로. */
export type MakerSpawn = {
  name?: string;
  /** 원본 tasks[] 안의 위치. progress[].index가 같은 기준을 쓰므로 이 값으로 대응시킨다. */
  index: number;
  ownedPaths: string[];
};

export type TaskGuardState = {
  usage: Usage;
  lock?: Lock;
  reservations: Map<string, Reservation>;
  /** child 이름 → 취소 확인 시 되돌릴 delta. 이름 없는 spawn은 식별할 수 없어 환불 대상이 아니다. */
  refundable: Map<string, Delta>;
  /** 이번 요청에서 이미 되돌린 child 슬롯 수. */
  refunded: number;
};

type GuardMetadata = {
  workClass: WorkClass;
  purpose: Purpose;
  blocksPrimary: boolean;
  primaryDeliverable: string;
  ownedPaths: string[];
  findingId?: string;
};

/**
 * 블록에서 읽은 그대로의 값. 미기재는 오류가 아니라 undefined이며, 이미 승인된 lock과 agent에서
 * 파생 가능한 항목은 resolveGuardMetadata가 채운다. 값이 있는데 enum 밖이면 파싱 단계에서 거부한다.
 */
type RawGuardMetadata = {
  workClass?: WorkClass;
  purpose?: Purpose;
  blocksPrimary?: boolean;
  primaryDeliverable?: string;
  ownedPaths: string[];
  findingId?: string;
  /** TASK_GUARD marker와 바로 뒤 정본 필드가 차지한 구간. 후속 본문은 포함하지 않는다. */
  span?: { start: number; end: number };
};

type SpawnItem = {
  agent: string;
  task: string;
  name?: string;
};

export type TaskCallInput = Record<string, unknown>;
export type EvalCallInput = Record<string, unknown>;

export type TaskGuardDecision =
  | { ok: true; input?: TaskCallInput }
  | { ok: false; reason: string };

/** 위임 정의는 maker 하나이며 같은 소유권·budget 계약을 사용한다. */
function isMakerAgent(agent: string): boolean {
  return agent === "maker";
}

function zeroUsage(): Usage {
  return { primaryMaker: 0, reworkMaker: 0, total: 0 };
}

export function createTaskGuardState(): TaskGuardState {
  return {
    usage: zeroUsage(),
    reservations: new Map(),
    refundable: new Map(),
    refunded: 0,
  };
}

export function resetTaskGuardState(state: TaskGuardState): void {
  state.usage = zeroUsage();
  state.lock = undefined;
  state.reservations.clear();
  state.refundable.clear();
  state.refunded = 0;
}

function normalizeDeliverable(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/**
 * OWNED_PATHS 값을 콤마로 나눠 빈 항목을 버리고 선행 `./`를 떼어낸다. `/` 구분 상대경로 계약은
 * 그대로 두고, 실제 소유 판정은 isPathOwned가 정규화하며 수행한다.
 */
export function parseOwnedPaths(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim().replace(/^\.\//, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * cwd 밖을 가리키는 표기(절대경로 또는 `..` 세그먼트). isPathOwned는 경로 해석을 하지 않는
 * 문자열 매칭이므로 스냅샷 키(`-- .`로 cwd 하위만 담는다)와 절대 매칭되지 않는다.
 */
function isEscapingOwnedPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  return (
    /^(?:[A-Za-z]:\/|\/)/.test(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  );
}

function readField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

const WORK_CLASSES = ["feature", "maintenance", "diagnostic"] as const;
const PURPOSES = ["primary", "rework"] as const;

/**
 * TASK_GUARD marker 바로 뒤에서 연속된 정본 필드만 읽는다. LLM이 빈 줄 없이
 * ROUTING_REASON·character marker·과제 본문을 이어 붙여도 그 후속 본문은 guard 블록이 아니다.
 */
function parseGuardMetadata(task: string): RawGuardMetadata | string {
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  if (!marker) return { ownedPaths: [] };

  const fieldLine =
    /^[\t ]*(?:WORK_CLASS|PURPOSE|BLOCKS_PRIMARY|PRIMARY_DELIVERABLE|OWNED_PATHS|FINDING_ID)[\t ]*:[^\r\n]*$/i;
  let cursor = marker.index + marker[0].length;
  if (task[cursor] === "\r") cursor += 1;
  if (task[cursor] === "\n") cursor += 1;
  const blockStart = cursor;
  let blockEnd = cursor;
  while (cursor < task.length) {
    const newline = task.indexOf("\n", cursor);
    const physicalEnd = newline === -1 ? task.length : newline;
    const contentEnd = physicalEnd > cursor && task[physicalEnd - 1] === "\r"
      ? physicalEnd - 1
      : physicalEnd;
    if (!fieldLine.test(task.slice(cursor, contentEnd))) break;
    blockEnd = contentEnd;
    cursor = newline === -1 ? task.length : newline + 1;
  }
  const block = task.slice(blockStart, blockEnd);
  // marker[0]은 `^\s*`가 앞 줄의 개행까지 먹을 수 있으므로 실제 마커 줄 시작으로 보정한다.
  const lead = marker[0].length - marker[0].trimStart().length;
  const span = {
    start: marker.index + lead,
    end: blockEnd,
  };
  const workClassRaw = readField(block, "WORK_CLASS")?.toLowerCase();
  const purposeRaw = readField(block, "PURPOSE")?.toLowerCase();
  const blocksPrimaryRaw = readField(block, "BLOCKS_PRIMARY")?.toLowerCase();

  if (workClassRaw && !WORK_CLASSES.includes(workClassRaw as WorkClass)) {
    return "[SpawnGuard] WORK_CLASS는 feature|maintenance|diagnostic 중 하나여야 합니다.";
  }
  if (purposeRaw && !PURPOSES.includes(purposeRaw as Purpose)) {
    return "[SpawnGuard] PURPOSE는 primary|rework 중 하나여야 합니다.";
  }
  if (blocksPrimaryRaw && !["yes", "no"].includes(blocksPrimaryRaw)) {
    return "[SpawnGuard] BLOCKS_PRIMARY는 yes|no 중 하나여야 합니다.";
  }

  return {
    ...(workClassRaw ? { workClass: workClassRaw as WorkClass } : {}),
    ...(purposeRaw ? { purpose: purposeRaw as Purpose } : {}),
    ...(blocksPrimaryRaw ? { blocksPrimary: blocksPrimaryRaw === "yes" } : {}),
    ...(readField(block, "PRIMARY_DELIVERABLE")
      ? { primaryDeliverable: readField(block, "PRIMARY_DELIVERABLE") }
      : {}),
    ownedPaths: parseOwnedPaths(readField(block, "OWNED_PATHS")),
    ...(readField(block, "FINDING_ID") ? { findingId: readField(block, "FINDING_ID") } : {}),
    span,
  };
}

/**
 * raw + agent + 현재 lock으로 계약을 완성한다. lock이 확립돼 있으면 WORK_CLASS/PRIMARY_DELIVERABLE은
 * 그 lock 값으로, PURPOSE와 BLOCKS_PRIMARY는 FINDING_ID로 파생한다. lock이 없는 첫 child는
 * 사람이 판단해야 하는 두 값을 그대로 요구한다.
 */
function resolveGuardMetadata(
  raw: RawGuardMetadata,
  lock: Lock | undefined,
): GuardMetadata | string {
  const workClass = raw.workClass ?? lock?.workClass;
  if (!workClass) {
    return "[SpawnGuard] WORK_CLASS는 feature|maintenance|diagnostic 중 하나여야 합니다.";
  }
  const primaryDeliverable = raw.primaryDeliverable ?? lock?.deliverable;
  if (!primaryDeliverable) {
    return "[SpawnGuard] PRIMARY_DELIVERABLE이 비어 있습니다.";
  }

  const purpose: Purpose = raw.purpose ?? (raw.findingId ? "rework" : "primary");

  return {
    workClass,
    purpose,
    blocksPrimary: raw.blocksPrimary ?? true,
    primaryDeliverable,
    ownedPaths: raw.ownedPaths,
    ...(raw.findingId ? { findingId: raw.findingId } : {}),
  };
}

/**
 * 실제 적용된 계약을 child와 transcript가 그대로 보도록 TASK_GUARD marker와 연속된 정본 필드만
 * 정규 블록으로 바꾼다. ROUTING_REASON·character marker·과제 본문은 건드리지 않으며, 블록이 없으면 맨 앞에 붙인다.
 */
function canonicalizeTask(
  task: string,
  raw: RawGuardMetadata,
  metadata: GuardMetadata,
  agent: string,
): string {
  const lines = [
    "TASK_GUARD:",
    `WORK_CLASS: ${metadata.workClass}`,
    `PURPOSE: ${metadata.purpose}`,
    "BLOCKS_PRIMARY: yes",
    `PRIMARY_DELIVERABLE: ${metadata.primaryDeliverable}`,
  ];
  if (isMakerAgent(agent)) lines.push(`OWNED_PATHS: ${metadata.ownedPaths.join(",")}`);
  if (metadata.findingId) lines.push(`FINDING_ID: ${metadata.findingId}`);
  const rendered = lines.join("\n");
  if (!raw.span) return `${rendered}\n\n${task}`;
  return task.slice(0, raw.span.start) + rendered + task.slice(raw.span.end);
}

function normalizeSpawnItems(input: TaskCallInput): SpawnItem[] | string {
  if (Array.isArray(input.tasks)) {
    if (input.tasks.length === 0) return "[SpawnGuard] tasks[]가 비어 있습니다.";
    const items: SpawnItem[] = [];
    for (const rawItem of input.tasks) {
      if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
        return "[SpawnGuard] tasks[] 항목 형식이 올바르지 않습니다.";
      }
      const item = rawItem as Record<string, unknown>;
      if (typeof item.agent !== "string" || typeof item.task !== "string") {
        return "[SpawnGuard] 모든 task 항목은 agent와 task를 명시해야 합니다.";
      }
      items.push({
        agent: item.agent.trim().toLowerCase(),
        task: item.task,
        ...(typeof item.name === "string" && item.name.trim()
          ? { name: item.name.trim() }
          : {}),
      });
    }
    return items;
  }

  if (typeof input.agent !== "string" || typeof input.task !== "string") {
    return "[SpawnGuard] task 호출은 agent와 task를 명시해야 합니다.";
  }
  return [
    {
      agent: input.agent.trim().toLowerCase(),
      task: input.task,
      ...(typeof input.name === "string" && input.name.trim()
        ? { name: input.name.trim() }
        : {}),
    },
  ];
}

function addDelta(target: Delta, source: Delta): void {
  target.primaryMaker += source.primaryMaker;
  target.reworkMaker += source.reworkMaker;
  target.total += source.total;
}

function subtractDelta(target: Usage, delta: Delta): void {
  target.primaryMaker = Math.max(0, target.primaryMaker - delta.primaryMaker);
  target.reworkMaker = Math.max(0, target.reworkMaker - delta.reworkMaker);
  target.total = Math.max(0, target.total - delta.total);
}

function validateItem(
  item: SpawnItem,
  metadata: GuardMetadata,
  expectedLock: Lock,
): Delta | string {
  if (!isMakerAgent(item.agent)) {
    return `[SpawnGuard] 허용 child는 maker뿐입니다: ${item.agent || "<empty>"}`;
  }

  const deliverableKey = normalizeDeliverable(metadata.primaryDeliverable);
  if (
    metadata.workClass !== expectedLock.workClass ||
    deliverableKey !== expectedLock.deliverableKey
  ) {
    return (
      "[SideQuestGuard] 한 사용자 요청 안에서 WORK_CLASS/PRIMARY_DELIVERABLE을 바꿀 수 없습니다. " +
      `locked=${expectedLock.workClass}:${expectedLock.deliverable}`
    );
  }

  if (!metadata.blocksPrimary) {
    return (
      "[SideQuestGuard] BLOCKS_PRIMARY:no 작업에는 child를 띄우지 않습니다. " +
      "현재 요청의 deliverable을 막지 않는 발견은 backlog로 남기세요."
    );
  }

  if (metadata.ownedPaths.length === 0) {
    return (
      "[SpawnGuard] maker 계열 spawn에는 OWNED_PATHS가 필요합니다. " +
      "이 child가 수정할 소유 경로를 콤마로 나열하세요."
    );
  }
  if (metadata.ownedPaths.some(isEscapingOwnedPath)) {
    return (
      "[SpawnGuard] OWNED_PATHS는 세션 cwd 기준 상대경로여야 합니다. " +
      "절대경로나 `..` 세그먼트는 어떤 경로와도 매칭되지 않으므로 허용하지 않습니다."
    );
  }
  if (metadata.purpose === "rework" && !metadata.findingId) {
    return "[SideQuestGuard] rework spawn에는 기존 FINDING_ID가 필요합니다.";
  }
  return metadata.purpose === "primary"
    ? { primaryMaker: 1, reworkMaker: 0, total: 1 }
    : { primaryMaker: 0, reworkMaker: 1, total: 1 };
}

function budgetReason(usage: Usage, delta: Delta): string | undefined {
  const next = {
    primaryMaker: usage.primaryMaker + delta.primaryMaker,
    reworkMaker: usage.reworkMaker + delta.reworkMaker,
    total: usage.total + delta.total,
  };
  if (next.total > TASK_BUDGET_LIMITS.total) {
    return (
      "[TaskBudget] 총 child spawn 한도 초과 " +
      `(current=${usage.total} requested=${delta.total} next=${next.total} limit=${TASK_BUDGET_LIMITS.total}).`
    );
  }
  if (next.primaryMaker > TASK_BUDGET_LIMITS.primaryMaker) {
    return (
      "[TaskBudget] primary Maker 한도 초과 " +
      `(current=${usage.primaryMaker} requested=${delta.primaryMaker} ` +
      `next=${next.primaryMaker} limit=${TASK_BUDGET_LIMITS.primaryMaker}).`
    );
  }
  if (next.reworkMaker > TASK_BUDGET_LIMITS.reworkMaker) {
    return (
      "[TaskBudget] rework Maker 한도 초과 " +
      `(current=${usage.reworkMaker} requested=${delta.reworkMaker} ` +
      `next=${next.reworkMaker} limit=${TASK_BUDGET_LIMITS.reworkMaker}).`
    );
  }
  return undefined;
}

export function reserveTaskCall(
  state: TaskGuardState,
  toolCallId: string,
  input: TaskCallInput,
): TaskGuardDecision {
  if (state.reservations.has(toolCallId)) return { ok: true };

  const normalized = normalizeSpawnItems(input);
  if (typeof normalized === "string") return { ok: false, reason: normalized };

  let candidateLock = state.lock;
  const delta = zeroUsage();
  const refundable: Array<{ name: string; delta: Delta }> = [];
  const makers: MakerSpawn[] = [];
  // 파생이 일어난 항목만 정규 블록으로 교체한다. 나머지 항목은 원본 문자열을 그대로 쓴다.
  const rewritten = new Map<number, string>();

  for (const [index, item] of normalized.entries()) {
    const raw = parseGuardMetadata(item.task);
    if (typeof raw === "string") return { ok: false, reason: raw };

    const metadata = resolveGuardMetadata(raw, candidateLock);
    if (typeof metadata === "string") return { ok: false, reason: metadata };

    // 같은 호출의 첫 항목이 확립한 lock을 2번째 이후 항목이 상속한다.
    candidateLock ??= {
      workClass: metadata.workClass,
      deliverableKey: normalizeDeliverable(metadata.primaryDeliverable),
      deliverable: metadata.primaryDeliverable,
    };

    const itemDelta = validateItem(item, metadata, candidateLock);
    if (typeof itemDelta === "string") return { ok: false, reason: itemDelta };
    addDelta(delta, itemDelta);
    if (item.name) refundable.push({ name: item.name, delta: itemDelta });
    if (isMakerAgent(item.agent)) {
      makers.push({
        ...(item.name ? { name: item.name } : {}),
        index,
        ownedPaths: metadata.ownedPaths,
      });
    }

    const derived =
      raw.span === undefined ||
      raw.workClass === undefined ||
      raw.purpose === undefined ||
      raw.blocksPrimary === undefined ||
      raw.primaryDeliverable === undefined;
    if (derived) rewritten.set(index, canonicalizeTask(item.task, raw, metadata, item.agent));
  }

  const overBudget = budgetReason(state.usage, delta);
  if (overBudget) return { ok: false, reason: overBudget };

  if (!state.lock) state.lock = candidateLock;
  addDelta(state.usage, delta);
  state.reservations.set(toolCallId, {
    delta,
    names: refundable.map((entry) => entry.name),
    makers,
  });
  for (const entry of refundable) state.refundable.set(entry.name, entry.delta);
  if (rewritten.size === 0) return { ok: true };
  return { ok: true, input: replaceTaskBodies(input, rewritten) };
}

/**
 * 원본 입력을 제자리에서 바꾸지 않고 교체 본문만 담은 얕은 복사본을 만든다. tasks[]의 다른 항목과
 * context·model·isolated 같은 나머지 키는 그대로 보존한다.
 */
function replaceTaskBodies(input: TaskCallInput, rewritten: Map<number, string>): TaskCallInput {
  if (!Array.isArray(input.tasks)) return { ...input, task: rewritten.get(0) };
  return {
    ...input,
    tasks: input.tasks.map((item, index) => {
      const task = rewritten.get(index);
      return task === undefined ? item : { ...(item as Record<string, unknown>), task };
    }),
  };
}

export function rollbackTaskCall(state: TaskGuardState, toolCallId: string): void {
  const reservation = state.reservations.get(toolCallId);
  if (!reservation) return;
  subtractDelta(state.usage, reservation.delta);
  state.reservations.delete(toolCallId);
  for (const name of reservation.names) state.refundable.delete(name);
  if (state.usage.total === 0) state.lock = undefined;
}

/** 이 호출이 띄운 maker 계열 항목들(순서 = tasks[] 순서). 예약이 없으면 undefined. */
export function reservedMakers(state: TaskGuardState, toolCallId: string): MakerSpawn[] | undefined {
  const reservation = state.reservations.get(toolCallId);
  if (!reservation) return undefined;
  return reservation.makers.map((maker) => ({ ...maker, ownedPaths: [...maker.ownedPaths] }));
}

/**
 * 사람이 실행 중인 턴에 끼워 넣은 redirect. 모델이 위조할 수 없는 입력이므로 side-quest
 * 판정 기준인 deliverable lock만 풀고, 비용 상한인 누적 budget은 그대로 유지한다.
 */
export function noteUserRedirect(state: TaskGuardState): boolean {
  if (!state.lock) return false;
  state.lock = undefined;
  return true;
}

/**
 * `write proc://<id>/kill` 결과 details.proc.cancelled[]에서 런타임이 실제로 취소했다고 확인한
 * id만 뽑는다. already_completed·not_found 결과는 환불 근거가 아니다.
 */
export function readCancelledJobIds(details: unknown): string[] {
  const proc = details && typeof details === "object" && "proc" in details ? details.proc : undefined;
  const cancelled = proc && typeof proc === "object" && "cancelled" in proc ? proc.cancelled : undefined;
  if (!Array.isArray(cancelled)) return [];
  const ids: string[] = [];
  for (const outcome of cancelled) {
    if (!outcome || typeof outcome !== "object") continue;
    const record = outcome as Record<string, unknown>;
    if (record.status === "cancelled" && typeof record.id === "string" && record.id) ids.push(record.id);
  }
  return ids;
}

/**
 * 취소가 확인된 child의 슬롯을 되돌린다. 요청당 CANCEL_REFUND_LIMIT 슬롯까지만 환불하므로
 * full 8-slot 취소 wave 한 번은 복구하지만 반복 spawn→cancel로는 누적 cap을 넘을 수 없다.
 */
export function releaseCancelledSpawns(state: TaskGuardState, names: string[]): number {
  let released = 0;
  for (const name of names) {
    const delta = state.refundable.get(name);
    if (!delta) continue;
    if (state.refunded + delta.total > CANCEL_REFUND_LIMIT) continue;
    state.refundable.delete(name);
    subtractDelta(state.usage, delta);
    state.refunded += delta.total;
    released += delta.total;
    for (const [id, reservation] of state.reservations) {
      if (!reservation.names.includes(name)) continue;
      reservation.names = reservation.names.filter((entry) => entry !== name);
      subtractDelta(reservation.delta, delta);
      if (reservation.delta.total === 0) state.reservations.delete(id);
    }
  }
  if (state.usage.total === 0) state.lock = undefined;
  return released;
}

export function getTaskGuardUsage(state: TaskGuardState): Readonly<Usage> {
  return { ...state.usage };
}

// 2026-09-18 사용자 결정: Main이 최종 판정 직전에 던지는 stateless `completion()`은 허용한다.
// child가 아니라 도구도 세션도 없는 1회 질의이므로 TaskBudget이 세는 대상(child 레인)이
// 아니고, 판정 권한은 그대로 Main에 남는다. 사용 계약(revision당 1회, 입력은 판정 패킷만,
// raw diff 금지, 상담 결과는 판정이 아니라 이견 목록)은 harness-policy.json의
// `mainLane.workerReview.finalVerdictConsult`가 정본이다. child를 만드는 나머지 경로
// (agent()/workpool()/tool.task())는 계속 막아 budget 우회를 차단한다.
const EVAL_MODEL_BRIDGE_PATTERNS = [
  /\bagent\s*\(/i,
  /\bworkpool\s*\(/i,
  /\btool\s*\.\s*task\s*\(/i,
  /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:agent|workpool)\b/i,
  /^\s*[A-Za-z_]\w*\s*=\s*(?:agent|workpool)\b/im,
] as const;

export function matchBlockedEvalModelBridge(input: EvalCallInput): string | undefined {
  if (typeof input.code !== "string") return undefined;
  if (!EVAL_MODEL_BRIDGE_PATTERNS.some((pattern) => pattern.test(input.code))) return undefined;
  return (
    "[SpawnGuard] eval의 agent()/workpool()/tool.task() child 실행은 금지합니다. " +
    "child는 Main의 task 경로로만 보내 TaskBudget/SideQuestGuard를 통과시키세요. " +
    "판정 상담용 stateless completion()은 허용합니다."
  );
}

// ============================================================================
// OwnershipGuard: maker 계열 child 완료 시 소유 경로 밖 변경을 보고한다.
// 차단하지 않는 advisory 보고이며, git을 못 쓰면 추정하지 않고 unobserved로 남긴다.
// ============================================================================

/** 세션 cwd 기준 working tree 스냅샷: 정규화된 상대경로 → 내용 지문(삭제·부재는 undefined). */
export type TreeSnapshot = ReadonlyMap<string, string | undefined>;

function normalizeOwnedPath(value: string): string {
  return value.trim().replace(/\\/g, "/").toLowerCase();
}

/**
 * git status가 저장소 root 기준으로 주는 경로에서 cwd→root 접두사(scope)를 뗀다.
 * 소유 판정과 같은 대소문자 무시 기준으로 비교하며, 접두사가 맞지 않으면 undefined를 돌린다.
 * 호출부는 undefined를 unobserved로 매핑해 빈 스냅샷이 outside=none(무결)으로 보이는 것을 막는다.
 */
export function stripScopePrefix(path: string, scope: string): string | undefined {
  const normalizedPath = path.replace(/\\/g, "/");
  const normalizedScope = scope.replace(/\\/g, "/");
  if (normalizedScope.length === 0) return normalizedPath;
  if (normalizedPath.length < normalizedScope.length) return undefined;
  for (let cursor = 0; cursor < normalizedScope.length; cursor += 1) {
    if (normalizedPath[cursor]!.toLowerCase() !== normalizedScope[cursor]!.toLowerCase()) {
      return undefined;
    }
  }
  return normalizedPath.slice(normalizedScope.length);
}

/**
 * 경로 소유 판정. 후행 `/`는 디렉터리 prefix, 그 밖은 정확한 파일, `.` 하나는 세션 cwd 전체다.
 * `evals/`는 `evals2/x`를 소유하지 않는다.
 */
export function isPathOwned(ownedPaths: readonly string[], changedPath: string): boolean {
  const target = normalizeOwnedPath(changedPath);
  if (!target) return false;
  for (const entry of ownedPaths) {
    const owned = normalizeOwnedPath(entry);
    if (!owned) continue;
    if (owned === ".") return true;
    if (owned.endsWith("/")) {
      if (target.startsWith(owned)) return true;
      continue;
    }
    if (target === owned) return true;
  }
  return false;
}

/** 보고 줄은 공백 구분 key=value이므로 경로와 이름의 공백·콤마만 이스케이프한다. */
function encodeReportToken(value: string): string {
  return value.replace(/ /g, "%20").replace(/,/g, "%2C");
}

/**
 * 두 스냅샷 사이에 실제로 바뀐 경로. 지문이 같으면 spawn 전부터 dirty였던 파일도 보고하지 않고,
 * 지문이 달라졌으면 그 사이에 손댄 변경을 잡는다.
 */
export function diffTreeSnapshots(before: TreeSnapshot, after: TreeSnapshot): string[] {
  const changed: string[] = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    if (before.has(path) !== after.has(path)) {
      changed.push(path);
      continue;
    }
    if (before.get(path) !== after.get(path)) changed.push(path);
  }
  return changed.sort();
}

export type OwnershipReportInput = {
  child: string;
  ownedPaths: readonly string[];
  /** undefined면 스냅샷을 뜨지 못해 변경 여부를 판정할 수 없다(`outside=unobserved`). */
  changedPaths?: readonly string[];
  concurrent: readonly string[];
};

/** 소유 밖 변경 경로(정규화·중복 제거·정렬). */
function outsidePaths(ownedPaths: readonly string[], changedPaths: readonly string[]): string[] {
  return [...new Set(changedPaths.map(normalizeOwnedPath).filter((path) => path.length > 0))]
    .filter((path) => !isPathOwned(ownedPaths, path))
    .sort();
}

/** OwnershipGuard 보고 한 줄. 공백 구분 key=value이며 인용부호를 쓰지 않는다. */
export function buildOwnershipReport(input: OwnershipReportInput): string {
  const owned = input.ownedPaths.map(normalizeOwnedPath).filter((entry) => entry.length > 0);
  const outside = input.changedPaths === undefined ? "unobserved" : outsidePaths(owned, input.changedPaths);
  return (
    `[OwnershipGuard] child=${encodeReportToken(input.child)}` +
    ` owned=${owned.map(encodeReportToken).join(",")}` +
    ` outside=${
      Array.isArray(outside)
        ? outside.length > 0
          ? outside.map(encodeReportToken).join(",")
          : "none"
        : outside
    }` +
    ` concurrent=${input.concurrent.length > 0 ? input.concurrent.map(encodeReportToken).join(",") : "none"}`
  );
}

type OwnershipEntry = {
  /** 보고 라벨: tasks[].name 또는 `unnamed`. */
  child: string;
  ownedPaths: string[];
  /** spawn 순서(단조 증가). 동시 실행 판정은 시각이 아니라 이 순서로 한다. */
  startOrder: number;
  /** 완료 보고 순서. 아직 보고하지 않았으면 없다. */
  endOrder?: number;
  /** task 결과의 progress id. 이름 없는 spawn을 job id로 되찾기 위한 별칭. */
  aliases: string[];
  /** spawn 시점 스냅샷. 보고를 마치면 버린다. git을 못 쓰면 없다. */
  snapshot?: TreeSnapshot;
  reported: boolean;
};

export type OwnershipState = {
  entries: Map<string, OwnershipEntry>;
  order: number;
};

export function createOwnershipState(): OwnershipState {
  return { entries: new Map(), order: 0 };
}

export function resetOwnershipState(state: OwnershipState): void {
  state.entries.clear();
  state.order = 0;
}

/** 아직 완료 보고를 하지 않은 child가 있으면 true. 없으면 git 스냅샷을 뜨지 않는다. */
export function hasUnreportedChildren(state: OwnershipState): boolean {
  for (const entry of state.entries.values()) {
    if (!entry.reported) return true;
  }
  return false;
}

/** child 추적 키. 예약(호출) id와 원본 tasks[] 인덱스로 항목마다 고유하다. */
function ownedChildKey(reservationKey: string, index: number): string {
  return `${reservationKey}#${index}`;
}

/**
 * spawn 예약의 maker 계열 항목을 항목 단위로 추적에 등록한다. 같은 이름을 다시 spawn하거나 한 호출에
 * unnamed가 여러 개여도 키가 겹치지 않아 서로를 가리지 않는다. child 라벨은 이름(없으면 `unnamed`)이고,
 * 이름 있는 항목은 job id가 이름과 같은 경우가 많아 그 이름을 별칭으로 미리 갖는다.
 */
export function registerSpawnedMakers(
  state: OwnershipState,
  reservationKey: string,
  makers: readonly MakerSpawn[],
  snapshot: TreeSnapshot | undefined,
): void {
  for (const maker of makers) {
    const key = ownedChildKey(reservationKey, maker.index);
    if (state.entries.has(key)) continue;
    state.order += 1;
    state.entries.set(key, {
      child: maker.name ?? "unnamed",
      ownedPaths: [...maker.ownedPaths],
      startOrder: state.order,
      aliases: maker.name ? [maker.name] : [],
      reported: false,
      ...(snapshot ? { snapshot } : {}),
    });
  }
}

/** task 결과 details.progress[]에서 index·id·status만 읽는다. */
export function readSpawnProgress(
  details: unknown,
): Array<{ index: number; id: string; status?: string }> {
  const rows = (details as { progress?: unknown } | undefined)?.progress;
  if (!Array.isArray(rows)) return [];
  const progress: Array<{ index: number; id: string; status?: string }> = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.index !== "number" || typeof record.id !== "string") continue;
    progress.push({
      index: record.index,
      id: record.id,
      ...(typeof record.status === "string" ? { status: record.status } : {}),
    });
  }
  return progress;
}

/**
 * task 결과가 알려준 progress id를 원본 tasks[] 인덱스로 spawn 항목에 연결한다. 이름 있는
 * child는 job id가 이름과 같거나 충돌 시 변형되므로(`allocate`: base, base-2, …) 실제 id를
 * 별칭으로 확정하고, 이름 없는 child는 이 별칭으로만 완료를 되찾는다.
 */
export function bindSpawnAliases(
  state: OwnershipState,
  reservationKey: string,
  makers: readonly MakerSpawn[] | undefined,
  progress: readonly { index: number; id: string }[],
): void {
  if (!makers) return;
  for (const row of progress) {
    const maker = makers.find((candidate) => candidate.index === row.index);
    if (!maker) continue;
    const entry = state.entries.get(ownedChildKey(reservationKey, maker.index));
    if (!entry || entry.aliases.includes(row.id)) continue;
    entry.aliases.push(row.id);
  }
}

/**
 * `wait`·async-result의 details.jobs[]와 `read proc://`의 jobs[]에서 종료된 task job id를 읽는다.
 * type이 없는 행(행이 먼저 evict된 전달)은 id 일치까지 확인하므로 함께 받는다.
 */
export function readSettledTaskIds(details: unknown): string[] {
  const jobs = (details as { jobs?: unknown } | undefined)?.jobs;
  if (!Array.isArray(jobs)) return [];
  const ids: string[] = [];
  for (const job of jobs) {
    if (!job || typeof job !== "object") continue;
    const record = job as Record<string, unknown>;
    if (record.type !== undefined && record.type !== "task") continue;
    if (record.status === "running") continue;
    const id = typeof record.id === "string" ? record.id : record.jobId;
    if (typeof id === "string" && id) ids.push(id);
  }
  return ids;
}

/** 추적을 버린다. spawn 자체가 실패해 child가 뜨지 않은 예약에 쓴다. */
export function dropOwnedChildren(
  state: OwnershipState,
  reservationKey: string,
  makers: readonly MakerSpawn[],
): void {
  for (const maker of makers) state.entries.delete(ownedChildKey(reservationKey, maker.index));
}

/**
 * 아직 보고되지 않은 child의 id만 남긴다. 이미 보고된 child만 담긴 결과에 대해 git 스냅샷을
 * 뜨지 않기 위한 사전 필터다.
 */
export function unreportedOwnedChildIds(state: OwnershipState, ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const key = findOwnedChildKey(state, id);
    const entry = key ? state.entries.get(key) : undefined;
    return entry !== undefined && !entry.reported;
  });
}

/** child가 살아 있는 동안 겹친 다른 maker child. 완료 전에 끝난 sibling도 수정 출처 후보다. */
function concurrentChildNames(state: OwnershipState, entry: OwnershipEntry, endOrder: number): string[] {
  const names = new Set<string>();
  for (const other of state.entries.values()) {
    if (other === entry) continue;
    if (other.startOrder > endOrder) continue;
    if (other.endOrder !== undefined && other.endOrder < entry.startOrder) continue;
    names.add(other.child);
  }
  return [...names].sort();
}

/**
 * job id에 대응하는 미보고 child를 찾는다. 이미 보고된 항목은 건너뛰므로 같은 이름을 다시
 * spawn해도 새 항목이 가려지지 않고, 같은 id가 겹치면 먼저 등록된 항목을 쓴다.
 */
function findOwnedChildKey(state: OwnershipState, id: string): string | undefined {
  let found: string | undefined;
  let foundOrder = Number.POSITIVE_INFINITY;
  for (const [key, entry] of state.entries) {
    if (entry.reported) continue;
    if (key !== id && !entry.aliases.includes(id)) continue;
    if (entry.startOrder >= foundOrder) continue;
    found = key;
    foundOrder = entry.startOrder;
  }
  return found;
}

/**
 * 종료가 관측된 child들의 OwnershipGuard 줄을 만든다. child마다 정확히 한 번만 보고하고
 * (보고 후 스냅샷을 버리고 reported로 표시) 모르는 id는 무시한다.
 */
export function reportOwnedChildren(
  state: OwnershipState,
  ids: readonly string[],
  tree: TreeSnapshot | undefined,
): string[] {
  const lines: string[] = [];
  for (const id of ids) {
    const key = findOwnedChildKey(state, id);
    if (!key) continue;
    const entry = state.entries.get(key);
    if (!entry || entry.reported) continue;
    state.order += 1;
    entry.endOrder = state.order;
    entry.reported = true;
    const concurrent = concurrentChildNames(state, entry, entry.endOrder);
    const changedPaths = entry.snapshot && tree ? diffTreeSnapshots(entry.snapshot, tree) : undefined;
    entry.snapshot = undefined;
    lines.push(
      buildOwnershipReport({
        child: entry.child,
        ownedPaths: entry.ownedPaths,
        ...(changedPaths ? { changedPaths } : {}),
        concurrent,
      }),
    );
  }
  return lines;
}
