import { isUnavailable, type Exec } from "../../tools/ego-browser/index";

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

/**
 * 예약한 tasks[] 항목 하나의 상태. 결과를 관측하면 reserved는 started 또는 released로 갈린다.
 * 시작 증거는 단조라 released 항목도 뒤늦은 증거가 오면 다시 과금하고, 취소 환불한 refunded는 종착이다.
 */
type ChildState = "reserved" | "released" | "started" | "refunded";

type ReservedChild = {
  /** 원본 tasks[] 위치. progress[].index가 같은 기준을 쓴다. */
  index: number;
  delta: Delta;
  /** 이름 있는 항목만 취소 환불 대상이다. */
  refundable: boolean;
  /** 결과 progress가 이 index에 준 canonical agent id. 표시 이름과 다를 수 있다(`Fix-2`). */
  agentId?: string;
  state: ChildState;
};

type Reservation = {
  children: ReservedChild[];
  /** 이 호출이 띄운 maker 계열 항목들(순서 = tasks[] 순서). 이름 없는 항목은 name이 없다. */
  makers: MakerSpawn[];
  /** 예약 시각. receipt 없이 실패한 호출 뒤에 등록된 job을 가리는 기준이다. */
  reservedAt: number;
  /** tool_result를 관측했다. core는 tool.execute를 부른 호출에만 tool_result를 낸다. */
  executed: boolean;
};

/** maker 계열 spawn 하나가 소유한다고 선언한 경로. */
export type MakerSpawn = {
  name?: string;
  /** 원본 tasks[] 안의 위치. progress[].index가 같은 기준을 쓰므로 이 값으로 대응시킨다. */
  index: number;
  ownedPaths: string[];
  /** 격리 worktree에서 실행한다(`isolated: true|"capture"`). 공유 checkout의 쓰기 소유자가 아니다. */
  isolated?: true;
};

export type TaskGuardState = {
  usage: Usage;
  lock?: Lock;
  /** USER_REQUEST 인용으로 이 요청에 더 받아들인 WORK_CLASS·PRIMARY_DELIVERABLE. */
  admitted: Lock[];
  /** 이번 요청의 사용자 입력 원문(첫 입력과 끼어든 steering). 모델이 위조할 수 없어 USER_REQUEST 인용의 기준이다. */
  requestTexts: string[];
  /** toolCallId → 예약. 취소 환불과 뒤늦은 결과 판정에 쓰므로 요청이 끝날 때까지 남긴다. */
  reservations: Map<string, Reservation>;
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
  /** USER_REQUEST: 이 완료물을 요구한 사용자 문장의 글자 그대로 인용. 다른 완료물을 같은 요청에 받아들이는 근거다. */
  userRequest?: string;
  ownedPaths: string[];
  findingId?: string;
  /** TASK_GUARD marker와 바로 뒤 정본 필드가 차지한 구간. 후속 본문은 포함하지 않는다. */
  span?: { start: number; end: number };
};

type SpawnItem = {
  agent: string;
  task: string;
  name?: string;
  /** 호출이 agent를 생략했다. 위임 정의가 maker 하나뿐이라 maker로 해석하고 반환 input에도 기록한다. */
  agentOmitted?: true;
  /** 항목 값이 있으면 그것, 없으면 상위 `isolated`가 격리를 요청했다(core spawnParamsFor와 같은 우선순위). */
  isolated?: true;
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
    admitted: [],
    requestTexts: [],
    reservations: new Map(),
    refunded: 0,
  };
}

export function resetTaskGuardState(state: TaskGuardState): void {
  state.usage = zeroUsage();
  state.lock = undefined;
  state.admitted = [];
  state.requestTexts = [];
  state.reservations.clear();
  state.refunded = 0;
}

/** SideQuestGuard가 PRIMARY_DELIVERABLE을 비교하는 정규형. maker_route 준비·발주 검사도 같은 함수를 쓴다. */
export function normalizeDeliverable(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** 이번 요청의 사용자 입력 원문을 USER_REQUEST 인용 기준에 더한다. 첫 입력은 reset 뒤에, steering은 그대로 더한다. */
export function noteUserRequestText(state: TaskGuardState, text: string): void {
  if (text.trim()) state.requestTexts.push(text);
}

/** USER_REQUEST 인용 비교형: 대소문자·공백 차이와 인용부호를 지운다. */
function normalizeQuote(value: string): string {
  return value
    .replace(/["'`“”‘’「」『』«»]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/** 인용으로 인정하는 최소 길이(공백 제외 글자 수). "해줘"처럼 어느 요청에나 들어 있는 조각을 막는다. */
const MIN_USER_REQUEST_CHARS = 6;

/**
 * USER_REQUEST 인용이 이번 요청의 사용자 입력 원문(첫 입력 또는 steering) 어느 하나에 그대로 들어 있는지. 기준 글은 모델이
 * 쓸 수 없는 사용자 입력뿐이라 인용이 맞으면 사용자가 이 요청에서 그 완료물을 직접 요구한 것이다.
 */
function quotesUserRequest(state: TaskGuardState, quote: string | undefined): boolean {
  if (!quote || quote.replace(/\s/g, "").length < MIN_USER_REQUEST_CHARS) return false;
  const needle = normalizeQuote(quote);
  if (needle.replace(/\s/g, "").length < MIN_USER_REQUEST_CHARS) return false;
  return state.requestTexts.some((text) => normalizeQuote(text).includes(needle));
}

function sameLock(lock: Lock, workClass: string, deliverable: string): boolean {
  return lock.workClass === workClass && lock.deliverableKey === normalizeDeliverable(deliverable);
}

/** SideQuestGuard 거절 문구. TaskGuard와 maker_route 준비·발주가 같은 고치기 안내를 낸다. */
export const USER_REQUEST_HINT =
  "사용자가 이번 요청에서 이 완료물을 직접 요구했다면 TASK_GUARD 블록에 `USER_REQUEST: <그 요구 문장을 사용자 입력에서 글자 그대로 6자 이상>`을 더하면 별도 완료물로 받아들입니다. " +
  "사용자가 요구하지 않은 곁가지라면 기준 값으로 맞추거나 backlog로 남기세요.";

/**
 * OWNED_PATHS 값을 콤마로 나눠 빈 항목을 버리고 collapseOwnedPath로 동등 표기(`//`, `/./`, 선행 `./`)를
 * 접는다. 실제 소유 판정은 isPathOwned가 같은 정규화로 수행한다.
 */
export function parseOwnedPaths(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => collapseOwnedPath(entry))
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

/** guard 블록 안의 필드 한 줄을 읽는다. SpawnGuard와 maker_route 준비가 같은 reader를 쓴다. */
export function readGuardField(block: string, name: string): string | undefined {
  const match = block.match(new RegExp(`^\\s*${name}\\s*:\\s*(.+?)\\s*$`, "im"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

export const WORK_CLASSES = ["feature", "maintenance", "diagnostic"] as const;
const PURPOSES = ["primary", "rework"] as const;

/**
 * TASK_GUARD marker 바로 뒤에서 연속된 정본 필드만 읽는다. LLM이 빈 줄 없이
 * ROUTING_REASON·character marker·과제 본문을 이어 붙여도 그 후속 본문은 guard 블록이 아니다.
 * 블록 경계는 SpawnGuard와 maker_route 준비가 같아야 하므로 이 함수 하나만 계산한다.
 */
export function extractGuardBlock(task: string): { block: string; span: { start: number; end: number } } | null {
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  if (!marker) return null;

  const fieldLine =
    /^[\t ]*(?:WORK_CLASS|PURPOSE|BLOCKS_PRIMARY|PRIMARY_DELIVERABLE|OWNED_PATHS|FINDING_ID|USER_REQUEST)[\t ]*:[^\r\n]*$/i;
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
  // marker[0]은 `^\s*`가 앞 줄의 개행까지 먹을 수 있으므로 실제 마커 줄 시작으로 보정한다.
  const lead = marker[0].length - marker[0].trimStart().length;
  return {
    block: task.slice(blockStart, blockEnd),
    span: { start: marker.index + lead, end: blockEnd },
  };
}

function parseGuardMetadata(task: string): RawGuardMetadata | string {
  const extracted = extractGuardBlock(task);
  if (!extracted) return { ownedPaths: [] };
  const { block, span } = extracted;
  const workClassRaw = readGuardField(block, "WORK_CLASS")?.toLowerCase();
  const purposeRaw = readGuardField(block, "PURPOSE")?.toLowerCase();
  const blocksPrimaryRaw = readGuardField(block, "BLOCKS_PRIMARY")?.toLowerCase();

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
    ...(readGuardField(block, "PRIMARY_DELIVERABLE")
      ? { primaryDeliverable: readGuardField(block, "PRIMARY_DELIVERABLE") }
      : {}),
    ownedPaths: parseOwnedPaths(readGuardField(block, "OWNED_PATHS")),
    ...(readGuardField(block, "FINDING_ID") ? { findingId: readGuardField(block, "FINDING_ID") } : {}),
    ...(readGuardField(block, "USER_REQUEST") ? { userRequest: readGuardField(block, "USER_REQUEST") } : {}),
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
  if (raw.userRequest) lines.push(`USER_REQUEST: ${raw.userRequest}`);
  const rendered = lines.join("\n");
  if (!raw.span) return `${rendered}\n\n${task}`;
  return task.slice(0, raw.span.start) + rendered + task.slice(raw.span.end);
}

/** `isolated: true`와 `"capture"`(patch만 보존)는 둘 다 별도 worktree scope다(maker-routing workspaceOf와 같은 기준). */
function isolationRequested(value: unknown): boolean {
  return value === true || value === "capture";
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
      if (typeof item.task !== "string" || (item.agent !== undefined && typeof item.agent !== "string")) {
        return "[SpawnGuard] 모든 task 항목은 task 문자열을 가져야 하고 agent는 생략하거나 문자열이어야 합니다.";
      }
      items.push({
        agent: item.agent === undefined ? "maker" : item.agent.trim().toLowerCase(),
        task: item.task,
        ...(item.agent === undefined ? { agentOmitted: true as const } : {}),
        ...(typeof item.name === "string" && item.name.trim()
          ? { name: item.name.trim() }
          : {}),
        ...(isolationRequested(item.isolated !== undefined ? item.isolated : input.isolated)
          ? { isolated: true as const }
          : {}),
      });
    }
    return items;
  }

  if (typeof input.task !== "string" || (input.agent !== undefined && typeof input.agent !== "string")) {
    return "[SpawnGuard] task 호출은 task 문자열을 가져야 하고 agent는 생략하거나 문자열이어야 합니다.";
  }
  return [
    {
      agent: input.agent === undefined ? "maker" : input.agent.trim().toLowerCase(),
      task: input.task,
      ...(input.agent === undefined ? { agentOmitted: true as const } : {}),
      ...(typeof input.name === "string" && input.name.trim()
        ? { name: input.name.trim() }
        : {}),
      ...(isolationRequested(input.isolated) ? { isolated: true as const } : {}),
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
): Delta | string {
  if (!isMakerAgent(item.agent)) {
    return `[SpawnGuard] 허용 child는 maker뿐입니다: ${item.agent || "<empty>"}`;
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
  // 같은 호출의 중복 tool_call은 다시 세지 않는다. 전부 해제된 예약만 새 호출처럼 다시 예약한다.
  const existing = state.reservations.get(toolCallId);
  if (existing?.children.some((child) => child.state !== "released")) return { ok: true };

  const normalized = normalizeSpawnItems(input);
  if (typeof normalized === "string") return { ok: false, reason: normalized };

  let candidateLock = state.lock;
  const delta = zeroUsage();
  const children: ReservedChild[] = [];
  const makers: MakerSpawn[] = [];
  // 파생이 일어난 항목만 정규 블록으로 교체한다. 나머지 항목은 원본 문자열을 그대로 쓴다.
  const rewritten = new Map<number, string>();
  const agentFilled = new Set<number>();
  const admitted = [...state.admitted];

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
    // lock과 다른 완료물은 사용자가 이번 요청에서 직접 요구했다는 USER_REQUEST 인용이 맞을 때만 받는다(SideQuestGuard).
    if (
      isMakerAgent(item.agent) &&
      ![candidateLock, ...admitted].some((lock) => sameLock(lock, metadata.workClass, metadata.primaryDeliverable))
    ) {
      if (!quotesUserRequest(state, raw.userRequest)) {
        return {
          ok: false,
          reason:
            "[SideQuestGuard] 한 사용자 요청 안에서 WORK_CLASS/PRIMARY_DELIVERABLE을 바꿀 수 없습니다. " +
            `locked=${candidateLock.workClass}:${candidateLock.deliverable}` +
            (raw.userRequest ? " (USER_REQUEST 인용이 이번 사용자 입력에 글자 그대로 없습니다.)" : "") +
            ` ${USER_REQUEST_HINT}`,
        };
      }
      admitted.push({
        workClass: metadata.workClass,
        deliverableKey: normalizeDeliverable(metadata.primaryDeliverable),
        deliverable: metadata.primaryDeliverable,
      });
    }

    const itemDelta = validateItem(item, metadata);
    if (typeof itemDelta === "string") return { ok: false, reason: itemDelta };
    addDelta(delta, itemDelta);
    children.push({ index, delta: itemDelta, refundable: Boolean(item.name), state: "reserved" });
    if (isMakerAgent(item.agent)) {
      makers.push({
        ...(item.name ? { name: item.name } : {}),
        index,
        ownedPaths: metadata.ownedPaths,
        ...(item.isolated ? { isolated: true as const } : {}),
      });
    }

    const derived =
      raw.span === undefined ||
      raw.workClass === undefined ||
      raw.purpose === undefined ||
      raw.blocksPrimary === undefined ||
      raw.primaryDeliverable === undefined;
    if (derived) rewritten.set(index, canonicalizeTask(item.task, raw, metadata, item.agent));
    if (item.agentOmitted) agentFilled.add(index);
  }

  const overBudget = budgetReason(state.usage, delta);
  if (overBudget) return { ok: false, reason: overBudget };

  if (!state.lock) state.lock = candidateLock;
  state.admitted = admitted;
  addDelta(state.usage, delta);
  state.reservations.set(toolCallId, { children, makers, reservedAt: Date.now(), executed: false });
  if (rewritten.size === 0 && agentFilled.size === 0) return { ok: true };
  return { ok: true, input: replaceTaskBodies(input, rewritten, agentFilled) };
}

/**
 * 원본 입력을 제자리에서 바꾸지 않고 교체 본문과 생략된 agent의 maker 기록만 담은 얕은 복사본을 만든다.
 * tasks[]의 다른 항목과 context·model·isolated 같은 나머지 키는 그대로 보존한다.
 */
function replaceTaskBodies(
  input: TaskCallInput,
  rewritten: Map<number, string>,
  agentFilled: Set<number>,
): TaskCallInput {
  if (!Array.isArray(input.tasks)) {
    return {
      ...input,
      ...(rewritten.has(0) ? { task: rewritten.get(0) } : {}),
      ...(agentFilled.has(0) ? { agent: "maker" } : {}),
    };
  }
  return {
    ...input,
    tasks: input.tasks.map((item, index) => {
      const task = rewritten.get(index);
      if (task === undefined && !agentFilled.has(index)) return item;
      return {
        ...(item as Record<string, unknown>),
        ...(task === undefined ? {} : { task }),
        ...(agentFilled.has(index) ? { agent: "maker" } : {}),
      };
    }),
  };
}

/** handler ctx의 async job registry(running+recent)에서 읽은 task job 하나. */
export type TaskJobRow = {
  id: string;
  agentId?: string;
  startTime: number;
};

export type TaskCallOutcome = {
  /** tool_result로 관측했다. false는 tool_result 없이 끝난 tool_execution_end다. */
  executed: boolean;
  isError: boolean;
  details: unknown;
  /** 세션 task job registry. 조회 API가 없거나 실패하면 undefined이며, 빈 registry와 달리 등록 여부를 모른다는 뜻이다. */
  registry?: readonly TaskJobRow[];
};

export type TaskCallSettlement = {
  /** 이번에 해제한 tasks[] index. 뜨지 않은 child의 임시 ownership을 버릴 대상이다. */
  released: number[];
  /** 해제했다가 뒤늦은 시작 증거로 다시 과금한 tasks[] index. */
  recharged: number[];
};

/** sync spawn 결과 details.results[]의 child id. 결과가 있다는 것은 그 child가 실제로 실행됐다는 뜻이다. */
function readSpawnResultIds(details: unknown): string[] {
  if (!details || typeof details !== "object" || !("results" in details) || !Array.isArray(details.results)) {
    return [];
  }
  return details.results.flatMap((row: unknown) =>
    row && typeof row === "object" && "id" in row && typeof row.id === "string" ? [row.id] : [],
  );
}

function hasAsyncJob(details: unknown): boolean {
  if (!details || typeof details !== "object" || !("async" in details)) return false;
  const async: unknown = details.async;
  return Boolean(async && typeof async === "object" && "jobId" in async && typeof async.jobId === "string");
}

/** 예약 시각 이후 등록됐는데 어느 예약 항목에도 묶이지 않은 task job이 있는지 본다. */
function hasUnattributedJob(
  state: TaskGuardState,
  reservation: Reservation,
  registry: readonly TaskJobRow[],
): boolean {
  const bound = new Set<string>();
  for (const other of state.reservations.values()) {
    for (const child of other.children) if (child.agentId) bound.add(child.agentId);
  }
  return registry.some((job) => job.startTime >= reservation.reservedAt && !bound.has(job.agentId ?? job.id));
}

/**
 * task 호출의 결과를 항목 단위로 반영한다. 시작 증거는 실행 흔적(`running`·`completed` 행, results[] id)이나
 * registry에 그 agent id로 등록된 task job이다. 증거가 있으면 started로 묶고, 해제했던 항목이면 다시 과금한다.
 * 해제는 reserved 항목에서만 일어난다.
 * - tool_result 없는 end: core가 tool.execute를 부르지 않았으므로(하류 guard·승인 거부·실행 전 abort·skip) 해제한다.
 * - 행은 있는데 증거가 없는 항목: registry를 읽었으면 등록 실패로 해제하고, 못 읽었으면 유지한다.
 * - 행·results·async job이 모두 없는 결과(모드 오류·전부 등록 실패): child가 없으므로 해제한다.
 * - details 없는 isError(실행 중 예외로 receipt 소실): 예약 이후 묶이지 않은 task job이 없다고 registry가 확인할 때만 해제한다.
 * started 항목은 이후 오류 결과나 end로 해제하지 않고, refunded 항목은 다시 과금하지 않는다.
 * 예약이 없으면 undefined, tool_result를 이미 본 호출의 end는 아무것도 바꾸지 않는다.
 */
export function settleTaskCall(
  state: TaskGuardState,
  toolCallId: string,
  outcome: TaskCallOutcome,
): TaskCallSettlement | undefined {
  const reservation = state.reservations.get(toolCallId);
  if (!reservation) return undefined;
  const settlement: TaskCallSettlement = { released: [], recharged: [] };
  if (!outcome.executed && reservation.executed) return settlement;
  if (outcome.executed) reservation.executed = true;

  const rows = readSpawnProgress(outcome.details);
  const resultIds = readSpawnResultIds(outcome.details);
  const registered = outcome.registry
    ? new Set(outcome.registry.flatMap((job) => (job.agentId ? [job.agentId] : [])))
    : undefined;
  const detailsMissing = !outcome.details || typeof outcome.details !== "object";
  const noChildRecord = rows.length === 0 && resultIds.length === 0 && !hasAsyncJob(outcome.details);
  const receiptLostWithoutJob =
    outcome.executed &&
    outcome.isError &&
    detailsMissing &&
    outcome.registry !== undefined &&
    !hasUnattributedJob(state, reservation, outcome.registry);

  for (const child of reservation.children) {
    const row = rows.find((candidate) => candidate.index === child.index);
    if (row) {
      child.agentId ??= row.id;
      const ran = row.status === "running" || row.status === "completed" || resultIds.includes(row.id);
      if (ran || registered?.has(row.id)) {
        if (child.state === "released") {
          addDelta(state.usage, child.delta);
          settlement.recharged.push(child.index);
        }
        if (child.state === "reserved" || child.state === "released") child.state = "started";
        continue;
      }
      if (registered) releaseChild(state, child, settlement);
      continue;
    }
    if (!outcome.executed || receiptLostWithoutJob || (!detailsMissing && noChildRecord)) {
      releaseChild(state, child, settlement);
    }
  }
  if (state.usage.total === 0) releaseLocks(state);
  return settlement;
}

function releaseChild(state: TaskGuardState, child: ReservedChild, settlement: TaskCallSettlement): void {
  if (child.state !== "reserved") return;
  subtractDelta(state.usage, child.delta);
  child.state = "released";
  settlement.released.push(child.index);
}

/** 이 호출에서 아직 해제되지 않은 maker 계열 항목들(순서 = tasks[] 순서). 남은 항목이 없으면 undefined. */
export function reservedMakers(state: TaskGuardState, toolCallId: string): MakerSpawn[] | undefined {
  const reservation = state.reservations.get(toolCallId);
  if (!reservation) return undefined;
  const live = reservation.makers.filter((maker) =>
    reservation.children.some((child) => child.index === maker.index && child.state !== "released"),
  );
  if (live.length === 0) return undefined;
  return live.map((maker) => ({ ...maker, ownedPaths: [...maker.ownedPaths] }));
}

/**
 * 사람이 실행 중인 턴에 끼워 넣은 redirect. 모델이 위조할 수 없는 입력이므로 side-quest
 * 판정 기준인 deliverable lock만 풀고, 비용 상한인 누적 budget은 그대로 유지한다.
 */
export function noteUserRedirect(state: TaskGuardState): boolean {
  if (!state.lock) return false;
  releaseLocks(state);
  return true;
}

/** deliverable lock과 USER_REQUEST로 받아들인 추가 완료물을 함께 푼다. */
function releaseLocks(state: TaskGuardState): void {
  state.lock = undefined;
  state.admitted = [];
}

/**
 * `write proc://<id>/kill` 결과에서 런타임이 실제로 취소한 task child의 canonical agent id를 읽는다.
 * `cancelled[].id`는 요청한 id다. 실행 중 job을 manager가 취소했으면 같은 결과 `jobs[]` 행이 cancelled이고
 * `agentUrlId`가 그 job의 agent id다. job id는 충돌 시 `-N`이 붙어 agent id와 다를 수 있다. job 행이 없거나
 * 끝난 행이면 agent registry를 직접 끊은 것이라 요청 id가 곧 agent id다.
 * task가 아닌 job과 already_completed·not_found는 환불 근거가 아니다.
 */
export function readCancelledChildIds(details: unknown): string[] {
  const proc = details && typeof details === "object" && "proc" in details ? details.proc : undefined;
  const cancelled = proc && typeof proc === "object" && "cancelled" in proc ? proc.cancelled : undefined;
  if (!Array.isArray(cancelled)) return [];
  const jobs = proc && typeof proc === "object" && "jobs" in proc && Array.isArray(proc.jobs) ? proc.jobs : [];
  const ids: string[] = [];
  for (const outcome of cancelled) {
    if (!outcome || typeof outcome !== "object") continue;
    const record = outcome as Record<string, unknown>;
    if (record.status !== "cancelled" || typeof record.id !== "string" || !record.id) continue;
    const job: unknown = jobs.find(
      (candidate: unknown) =>
        candidate !== null && typeof candidate === "object" && "id" in candidate && candidate.id === record.id,
    );
    const row = job && typeof job === "object" ? job : undefined;
    if (row && "type" in row && row.type !== undefined && row.type !== "task") continue;
    const agentId =
      row && "status" in row && row.status === "cancelled" && "agentUrlId" in row && typeof row.agentUrlId === "string"
        ? row.agentUrlId
        : "";
    ids.push(agentId || record.id);
  }
  return ids;
}

/**
 * 취소가 확인된 child의 슬롯을 되돌린다. canonical agent id로 정확히 그 항목 하나만 한 번 환불하며,
 * 요청당 CANCEL_REFUND_LIMIT 슬롯까지만 환불하므로 full 8-slot 취소 wave 한 번은 복구하지만 반복
 * spawn→cancel로는 누적 cap을 넘을 수 없다. 이름 없는 항목과 이미 해제·환불된 항목은 건너뛴다.
 */
export function releaseCancelledSpawns(state: TaskGuardState, ids: readonly string[]): number {
  let released = 0;
  for (const id of ids) {
    const child = findCancellableChild(state, id);
    if (!child) continue;
    if (state.refunded + child.delta.total > CANCEL_REFUND_LIMIT) continue;
    subtractDelta(state.usage, child.delta);
    child.state = "refunded";
    state.refunded += child.delta.total;
    released += child.delta.total;
  }
  if (state.usage.total === 0) releaseLocks(state);
  return released;
}

/** 취소 receipt가 가리키는 과금 중인 named 항목. receipt 자체가 그 child가 존재했다는 런타임 확인이다. */
function findCancellableChild(state: TaskGuardState, id: string): ReservedChild | undefined {
  for (const reservation of state.reservations.values()) {
    for (const child of reservation.children) {
      if (child.agentId !== id || !child.refundable) continue;
      if (child.state === "started" || child.state === "reserved") return child;
    }
  }
  return undefined;
}

export function getTaskGuardUsage(state: TaskGuardState): Readonly<Usage> {
  return { ...state.usage };
}

/**
 * maker_route 준비가 읽는 session별 TaskGuard 정본 lock. command-guard가 자기 state를 session id로 묶고,
 * 준비 쪽은 같은 session id의 lock만 읽는다. lock을 복제해 따로 들고 있으면 취소 환불·영수 정산으로 TaskGuard가
 * lock을 풀어도 남는 stale 상속이 생기므로 사본을 만들지 않는다. 확장 module이 여러 번 평가되어도 같은 map을
 * 보도록 prepared-task와 같이 globalThis 심볼에 둔다.
 */
const TASK_GUARD_SESSIONS = Symbol.for("@oh-my-pi/omp/task-guard-sessions/v2");
/** command-guard가 소유한 캐릭터 호출 상태의 읽기 창구. */
export interface SummonView {
  /** 사용자가 요청했고 아직 task child로 쓰지 않은 alias. */
  pending(): readonly string[];
  /** 이 tool call이 이미 summon으로 claim됐는지(handler 순서와 무관하게 같은 호출을 인식하려는 용도). */
  claimed(toolCallId: string): boolean;
}
const NO_SUMMONS: SummonView = { pending: () => [], claimed: () => false };
interface BoundSession {
  state: TaskGuardState;
  summons: SummonView;
}
const boundSessions: Map<string, BoundSession> = (() => {
  const existing = Reflect.get(globalThis, TASK_GUARD_SESSIONS) as Map<string, BoundSession> | undefined;
  if (existing) return existing;
  const created = new Map<string, BoundSession>();
  Reflect.set(globalThis, TASK_GUARD_SESSIONS, created);
  return created;
})();

export function bindTaskGuardSession(sessionId: string, state: TaskGuardState, summons: SummonView = NO_SUMMONS): void {
  const key = sessionId.trim();
  if (key) boundSessions.set(key, { state, summons });
}

/** 자기 state일 때만 푼다. reload로 새 state가 같은 id를 이어받은 뒤 옛 인스턴스의 늦은 정리가 새 연결을 지우지 않는다. */
export function unbindTaskGuardSession(sessionId: string, state: TaskGuardState): void {
  const key = sessionId.trim();
  if (key && boundSessions.get(key)?.state === state) boundSessions.delete(key);
}

/** 연결된 session이 없으면 undefined(호출자가 자기 사본으로 대체), 연결됐지만 lock이 없으면 null. */
export function taskGuardLockOf(sessionId: string): { workClass: string; primaryDeliverable: string } | null | undefined {
  const state = boundSessions.get(sessionId.trim())?.state;
  if (!state) return undefined;
  return state.lock ? { workClass: state.lock.workClass, primaryDeliverable: state.lock.deliverable } : null;
}

/**
 * maker_route 준비·발주가 TaskGuard와 같은 결론을 내도록 쓰는 SideQuestGuard 면제 판정: 이 session이 USER_REQUEST로 이미 받아들인
 * 완료물이거나, 인용이 이번 요청의 사용자 입력에 글자 그대로 있다. 연결된 session이 없으면 기준 글이 없으므로 false다.
 */
export function admitsUserRequestedDeliverable(
  sessionId: string,
  workClass: string,
  deliverable: string,
  quote: string | undefined,
): boolean {
  const state = boundSessions.get(sessionId.trim())?.state;
  if (!state) return false;
  return state.admitted.some((lock) => sameLock(lock, workClass, deliverable)) || quotesUserRequest(state, quote);
}

/**
 * 이 tool call이 이 session의 실제 사용자 캐릭터 호출에 속하는가: 아직 쓰지 않은 요청이 있거나 이 호출이 이미 claim했다.
 * claim 뒤에는 pending이 비므로 guard가 먼저 도는 순서에서도 같은 호출을 summon으로 인식한다. 연결이 없으면 false.
 */
export function isSummonCall(sessionId: string, toolCallId: string): boolean {
  const summons = boundSessions.get(sessionId.trim())?.summons;
  return !!summons && (summons.pending().length > 0 || summons.claimed(toolCallId));
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

// 2026-10-29 SJF bg_15: eval cell의 `tool.git_finalize()`가 eval 데드라인(300s)에 걸려 셀이 실패 처리되고
// 반환값(커밋 SHA)을 잃었다. 길이가 정해지지 않은 Main 게이트 도구는 eval 안에서 부르지 않고 직접
// 호출한다. 직접 호출에는 eval 셀 데드라인이 없다.
const EVAL_GATE_TOOL_NAMES = "git_finalize|git_integrate|cross_review|slop_check|deploy_verify";
const GATE_MEMBER = `(?:\\.\\s*|\\[\\s*["'\`])(?:${EVAL_GATE_TOOL_NAMES})(?![\\w$])(?:["'\`]\\s*\\])?`;
const EVAL_GATE_TOOL_PATTERNS = [
  // tool.name(…) / tool["name"](…)
  new RegExp(`\\btool\\s*${GATE_MEMBER}\\s*\\(`, "i"),
  // (tool).name(…) — 함수 호출 인자 `f(tool).name(`과 구분하려고 여는 괄호 앞이 식별자·닫는 괄호가 아닐 때만 본다.
  new RegExp(`(?<![\\w$)\\]])\\(\\s*tool\\s*\\)\\s*${GATE_MEMBER}\\s*\\(`, "i"),
  // f = tool.name 같은 메서드 alias (괄호로 감싼 형태 포함)
  new RegExp(`=\\s*\\(*\\s*tool\\s*\\)*\\s*${GATE_MEMBER}`, "i"),
  // const { name: f } = tool 구조분해
  new RegExp(`\\{[^}]*\\b(?:${EVAL_GATE_TOOL_NAMES})\\b[^}]*\\}\\s*=\\s*tool\\b`, "i"),
  // getattr(tool, "name")
  new RegExp(`\\bgetattr\\s*\\(\\s*tool\\s*,\\s*["'\`](?:${EVAL_GATE_TOOL_NAMES})["'\`]`, "i"),
] as const;

function callsEvalGateTool(code: string): boolean {
  if (EVAL_GATE_TOOL_PATTERNS.some((pattern) => pattern.test(code))) return true;
  // t = tool 처럼 tool 객체를 alias한 경우, 그 alias의 게이트 도구 멤버 접근만 같은 호출로 본다.
  for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*\(*\s*tool\s*\)*\s*(?:[;,]|$)/gim)) {
    if (new RegExp(`(?<![\\w$])${match[1].replace(/\$/g, "\\$")}\\s*${GATE_MEMBER}`, "i").test(code)) return true;
  }
  return false;
}

export function matchBlockedEvalModelBridge(input: EvalCallInput): string | undefined {
  if (typeof input.code !== "string") return undefined;
  if (EVAL_MODEL_BRIDGE_PATTERNS.some((pattern) => pattern.test(input.code))) {
    return (
      "[SpawnGuard] eval의 agent()/workpool()/tool.task() child 실행은 금지합니다. " +
      "child는 Main의 task 경로로만 보내 TaskBudget/SideQuestGuard를 통과시키세요. " +
      "판정 상담용 stateless completion()은 허용합니다."
    );
  }
  if (callsEvalGateTool(input.code)) {
    return (
      "[EvalGateGuard] eval 안에서 git_finalize/git_integrate/cross_review/slop_check/deploy_verify를 부르지 마세요. " +
      "eval 셀 데드라인(30~300s)이 먼저 끝나면 셀이 실패 처리되어 도구 반환값(커밋 SHA·reviewId)을 잃습니다. " +
      "이 도구들은 eval 밖에서 직접 호출하세요."
    );
  }
  return undefined;
}

// 2026-10-31 사용자 결정 「스페이스공간 따로 만들어서 그쪽에다 하는 건 기본으로 두자 하네스정책상」: ego lite PC에서는
// 브라우저 작업을 별도 ego TaskSpace(`ego_browser`)에서 한다. 규칙(wsl-windows-reference.md)이 10-21부터 그렇게 말했지만
// 7일 집계에서 eval `browser.open`이 relay 21회·headless 6회 나왔다(코어 relay 안내가 모든 세션에 relay를 기본으로 알린다).
// relay는 사용자가 지목한 이미 열린 탭(`app.target`)에만 쓴다. ego lite가 없는 PC는 막지 않는다.
// 패턴은 위 eval 가드처럼 원문에 맞춘다(문자열 안의 `browser.open(`도 호출로 본다). 옵션이 변수·spread라 정적으로
// 못 보는 호출은 셀 어딘가에 target 키가 있으면 통과시킨다.
const BROWSER_OPEN_CALLS = [
  /(?<![\w$.])browser\s*\.\s*open\s*\(/g,
  /(?<![\w$.])browser\s*\[\s*["'`]open["'`]\s*\]\s*\(/g,
  /\(\s*browser\s*\)\s*\.\s*open\s*\(/g,
] as const;
const TARGET_KEY = /(?:(?<![\w$])target|["'`]target["'`])\s*(?::|=(?!=))/;
const OPAQUE_OPTIONS = [
  /\.\.\.|\*\*/,
  // browser.open(opts) · (opts) · opts, 처럼 변수 하나만 넘기는 형태
  /^[\s(]*[A-Za-z_$][\w$.]*[\s)]*,?\s*$/,
  /(?<![\w$])["'`]?app["'`]?\s*(?::|=(?!=))\s*(?!dict\s*\()[A-Za-z_$]/,
  /[{,]\s*app\s*[,}]/,
] as const;
const EGO_PROBE_TIMEOUT_MS = 10_000;

export type EgoLiteProbe = () => Promise<boolean>;

/**
 * `ego-browser --version`으로 ego lite 설치를 확인한다. 있음(0)·없음(127·실행 파일 없음)은 프로세스 동안 기억하고,
 * 시간 초과·다른 실패는 막지 않는 쪽(false)으로 답하되 기억하지 않아 다음 호출이 다시 묻는다.
 */
export function createEgoLiteProbe(exec: Exec): EgoLiteProbe {
  let known: boolean | undefined;
  return async () => {
    if (known !== undefined) return known;
    try {
      const result = await exec(["--version"], "", { timeoutMs: EGO_PROBE_TIMEOUT_MS });
      if (result.killed) return false;
      if (result.code === 0 || result.code === 127) known = result.code === 0;
      return known ?? false;
    } catch (error) {
      if (isUnavailable(error)) known = false;
      return false;
    }
  };
}

/** `(`(open) 다음부터 짝이 맞는 `)` 앞까지의 인자 원문. 따옴표 문자열은 건너뛰고, 짝이 없으면 끝까지다. */
function callArguments(code: string, open: number): string {
  let depth = 1;
  for (let index = open + 1; index < code.length; index++) {
    const char = code[index]!;
    if (char === '"' || char === "'" || char === "`") {
      for (index++; index < code.length && code[index] !== char; index++) {
        if (code[index] === "\\") index++;
      }
    } else if ("([{".includes(char)) depth++;
    else if (")]}".includes(char) && --depth === 0) return code.slice(open + 1, index);
  }
  return code.slice(open + 1);
}

function browserOpenArguments(code: string): string[] {
  const calls = BROWSER_OPEN_CALLS.flatMap((pattern) => [...code.matchAll(pattern)]);
  // b = browser 처럼 browser 객체를 alias한 경우 그 alias의 open 호출도 같은 호출로 본다.
  for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=\s*\(*\s*browser\s*\)*\s*(?:[;,\n]|$)/g)) {
    const alias = match[1]!.replace(/\$/g, "\\$");
    calls.push(...code.matchAll(new RegExp(`(?<![\\w$.])${alias}\\s*\\.\\s*open\\s*\\(`, "g")));
  }
  return calls.map((match) => callArguments(code, match.index! + match[0].length - 1));
}

export async function matchRelayBrowserOpen(input: EvalCallInput, egoLiteAvailable: EgoLiteProbe): Promise<string | undefined> {
  if (typeof input.code !== "string") return undefined;
  const code = input.code;
  const cellHasTarget = TARGET_KEY.test(code);
  const untargeted = browserOpenArguments(code).some(
    (args) => !TARGET_KEY.test(args) && !(cellHasTarget && OPAQUE_OPTIONS.some((pattern) => pattern.test(args))),
  );
  if (!untargeted || !(await egoLiteAvailable())) return undefined;
  return (
    "[BrowserSpaceGuard] 이 PC에는 ego lite가 있어 브라우저 작업은 `ego_browser` 도구의 별도 TaskSpace에서 합니다" +
    '(기본 profile "user", CUELO 화면 검증은 profile: "verify"; relay·headless 모두 해당). ' +
    "사용자가 지목한 이미 열린 탭에서 할 때만 `browser.open`에 그 탭의 URL·제목을 `app.target`으로 넘기세요."
  );
}

// ============================================================================
// OwnershipGuard: maker 계열 child 완료 시 소유 경로 밖 변경을 보고한다.
// 차단하지 않는 advisory 보고이며, git을 못 쓰면 추정하지 않고 unobserved로 남긴다.
// ============================================================================

/** 세션 cwd 기준 working tree 스냅샷: 정규화된 상대경로 → 내용 지문(삭제·부재는 undefined). */
export type TreeSnapshot = ReadonlyMap<string, string | undefined>;

/**
 * 어휘적 정규화: 구분자를 `/`로 통일하고 반복 `/`와 `.` 세그먼트를 접는다. 후행 `/`(디렉터리)와
 * 선행 `/`·드라이브 루트 `X:/`(절대경로 표시)는 유지하고, `..`는 건드리지 않으며(해석 없음), 비면 `.`(cwd)이다.
 * 대소문자는 바꾸지 않는다.
 */
export function collapseOwnedPath(value: string): string {
  const slashed = value.trim().replace(/\\/g, "/");
  const drive = /^[A-Za-z]:\//.exec(slashed)?.[0] ?? "";
  const rest = slashed.slice(drive.length);
  const segments = rest.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const lead = drive || (rest.startsWith("/") ? "/" : "");
  if (segments.length === 0) return lead || (slashed.length > 0 ? "." : "");
  const trail = rest.endsWith("/") ? "/" : "";
  return `${lead}${segments.join("/")}${trail}`;
}

function normalizeOwnedPath(value: string): string {
  return collapseOwnedPath(value).toLowerCase();
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
  siblingOwnedPaths?: readonly string[];
  /**
   * 소유 밖 변경 경로(정규화)를 누가 edit·write로 썼는지: 이 child(`self`), 다른 writer만(`other`: sibling·Main), 기록 없음
   * (undefined: bash 쓰기·관측 전 쓰기). 없으면 모두 이 child의 소유 밖 변경으로 본다.
   */
  attribute?: (path: string) => "self" | "other" | undefined;
};

type OwnershipOutcome = {
  owned: string[];
  /** 이 child가 쓴(또는 단독 실행이라 이 child 말고는 쓸 수 없던) 소유 밖 변경. */
  outside: string[] | "unobserved";
  /** writer 기록이 없고 동시 실행 child가 있어 누가 썼는지 모르는 소유 밖 변경. */
  unattributed: string[];
  /** 다른 writer만 쓴 소유 밖 변경. 보고 줄에는 싣지 않고 진단 기록에만 남긴다. */
  elsewhere: string[];
};

/** 정규화한 소유 경로와 소유 밖 변경의 귀속. 스냅샷이 없으면 판정할 수 없어 `unobserved`다. */
function ownershipOutcome(input: OwnershipReportInput): OwnershipOutcome {
  const owned = input.ownedPaths.map(normalizeOwnedPath).filter((entry) => entry.length > 0);
  if (input.changedPaths === undefined) return { owned, outside: "unobserved", unattributed: [], elsewhere: [] };
  const outside: string[] = [];
  const unattributed: string[] = [];
  const elsewhere: string[] = [];
  const candidates = [...new Set(input.changedPaths.map(normalizeOwnedPath).filter((path) => path.length > 0))]
    .filter((path) => !isPathOwned(owned, path))
    .sort();
  for (const path of candidates) {
    const writer = input.attribute?.(path);
    if (writer === "other" || (writer === undefined && isPathOwned(input.siblingOwnedPaths ?? [], path))) elsewhere.push(path);
    else if (writer === undefined && input.attribute && input.concurrent.length > 0) unattributed.push(path);
    else outside.push(path);
  }
  return { owned, outside, unattributed, elsewhere };
}

function formatOwnershipReport(child: string, outcome: OwnershipOutcome, concurrent: readonly string[]): string {
  const { owned, outside, unattributed } = outcome;
  const list = (paths: readonly string[]) => paths.map(encodeReportToken).join(",");
  const limitedList = (paths: readonly string[]) =>
    list(paths.slice(0, 20)) + (paths.length > 20 ? ` +${paths.length - 20} more` : "");
  return (
    `[OwnershipGuard] child=${encodeReportToken(child)}` +
    ` owned=${list(owned)}` +
    ` outside=${Array.isArray(outside) ? (outside.length > 0 ? limitedList(outside) : "none") : outside}` +
    (unattributed.length > 0 ? ` unattributed=${limitedList(unattributed)}` : "") +
    ` concurrent=${concurrent.length > 0 ? list(concurrent) : "none"}`
  );
}

/** OwnershipGuard 보고 한 줄. 공백 구분 key=value이며 인용부호를 쓰지 않는다. */
export function buildOwnershipReport(input: OwnershipReportInput): string {
  return formatOwnershipReport(input.child, ownershipOutcome(input), input.concurrent);
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
  /** 등록 시점의 writes 길이. 그 뒤의 쓰기 기록만 이 child 실행 중의 쓰기다. */
  writeMark: number;
  reported: boolean;
};

/** edit·write 도구로 공유 작업 트리의 파일을 쓴 기록. path는 정규화한 부모 cwd 기준 상대경로다. */
type OwnershipWrite = { writer: string; path: string };

export type OwnershipState = {
  entries: Map<string, OwnershipEntry>;
  order: number;
  writes: OwnershipWrite[];
};

export function createOwnershipState(): OwnershipState {
  return { entries: new Map(), order: 0, writes: [] };
}

export function resetOwnershipState(state: OwnershipState): void {
  state.entries.clear();
  state.order = 0;
  state.writes.length = 0;
}

/** Main(부모 세션 자신)의 쓰기 기록 writer id. agent id와 겹치지 않는다. */
export const OWNERSHIP_MAIN_WRITER = "\u0000main";

/**
 * writer(child agent id 또는 OWNERSHIP_MAIN_WRITER)가 부모 cwd 기준 상대경로 paths를 edit·write했다. 추적 중인 child가
 * 없으면 남기지 않는다(완료 보고가 볼 일이 없고 기록만 쌓인다).
 */
export function noteOwnershipWrites(state: OwnershipState, writer: string, paths: readonly string[]): void {
  if (!hasUnreportedChildren(state)) return;
  for (const path of paths) {
    const normalized = normalizeOwnedPath(path);
    if (normalized) state.writes.push({ writer, path: normalized });
  }
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
      writeMark: state.writes.length,
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
 * 소유 밖 변경이 있었거나(`outside`·`unattributed` 목록) 변경을 관측하지 못한(`unobserved`) 완료 보고 한 건.
 * 보고 줄은 그 턴의 대화에만 남으므로 빈도를 셀 수 있게 index.ts가 이 행을 JSONL로 덧붙인다.
 */
export type OwnershipOutsideRow = {
  child: string;
  /** spawn 이름과 task 결과 progress id(canonical agent id). */
  childIds: string[];
  owned: string[];
  outside: string[] | "unobserved";
  unattributed: string[];
  /** 다른 writer(sibling·Main)만 쓴 소유 밖 변경. 보고 줄에서 뺀 근거다. */
  elsewhere: string[];
  concurrent: string[];
};

/**
 * 쓰기 기록의 writer가 이 child인지. 이름 있는 child의 agent id는 이름이거나 충돌 변형(`이름-2` …)이다. 다른 child가 그 id를
 * 별칭으로 가졌으면(`Build`와 `Build-2`를 함께 띄운 경우) 그 child의 것이므로 변형 추정보다 정확한 별칭이 앞선다.
 */
function isEntryWriter(state: OwnershipState, entry: OwnershipEntry, writer: string): boolean {
  if (entry.aliases.includes(writer)) return true;
  if (entry.child === "unnamed" || !writer.startsWith(`${entry.child}-`)) return false;
  if (!/^\d+$/.test(writer.slice(entry.child.length + 1))) return false;
  for (const other of state.entries.values()) {
    if (other !== entry && (other.aliases.includes(writer) || other.child === writer)) return false;
  }
  return true;
}

/**
 * 종료가 관측된 child들의 OwnershipGuard 줄을 만든다. child마다 정확히 한 번만 보고하고
 * (보고 후 스냅샷을 버리고 reported로 표시) 모르는 id는 무시한다. 줄은 이 child의 소유 밖 변경이나 귀속을 모르는
 * 변경이 있을 때만 만든다: 없거나(`outside=none`) 관측하지 못했으면(`unobserved`) 알릴 행동이 없어 줄을 내지 않는다.
 * sibling·Main만 edit·write로 쓴 경로는 이 child의 변경이 아니므로 뺀다. 관측하지 못한 보고와 줄을 낸 보고는
 * onOutside에 넘긴다.
 */
export function reportOwnedChildren(
  state: OwnershipState,
  ids: readonly string[],
  tree: TreeSnapshot | undefined,
  onOutside?: (row: OwnershipOutsideRow) => void,
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
    const writes = state.writes.slice(entry.writeMark);
    const attribute = (path: string): "self" | "other" | undefined => {
      let other = false;
      for (const write of writes) {
        if (write.path !== path) continue;
        if (isEntryWriter(state, entry, write.writer)) return "self";
        other = true;
      }
      return other ? "other" : undefined;
    };
    const outcome = ownershipOutcome({
      child: entry.child,
      ownedPaths: entry.ownedPaths,
      ...(changedPaths ? { changedPaths } : {}),
      concurrent,
      siblingOwnedPaths: [...state.entries.values()]
        .filter((other) => other !== entry && other.startOrder <= entry.endOrder! &&
          (other.endOrder === undefined || other.endOrder >= entry.startOrder))
        .flatMap((other) => other.ownedPaths),
      attribute,
    });
    const { owned, outside, unattributed, elsewhere } = outcome;
    const reportable = (Array.isArray(outside) && outside.length > 0) || unattributed.length > 0;
    if (reportable) lines.push(formatOwnershipReport(entry.child, outcome, concurrent));
    if (onOutside && (reportable || outside === "unobserved")) {
      onOutside({ child: entry.child, childIds: [...entry.aliases], owned, outside, unattributed, elsewhere, concurrent });
    }
  }
  return lines;
}

// ============================================================================
// OwnerWriteGuard: 공유 작업공간 Maker child가 같은 부모의 다른 실행 중 Maker가 소유한 경로에 edit·write하는 것을 막는다.
// OWNED_PATHS 겹침은 발주 때만(maker-routing) 검사됐고, 실행 중 범위 밖 쓰기는 완료 뒤 OwnershipGuard 보고로만 드러났다.
// 다른 활성 owner가 없는 범위 밖 경로(직접 원인인 인접 파일)는 그대로 허용한다. 소유자를 확정하지 못하면 막지 않는다.
// ============================================================================

/** 공유 작업공간 maker spawn 하나의 쓰기 소유 주장. */
type WriterClaim = {
  /** 보고 라벨: tasks[].name 또는 `unnamed`. */
  child: string;
  name?: string;
  ownedPaths: string[];
  /** spawn한 task 호출 id와 원본 tasks[] 위치. */
  callId: string;
  index: number;
  /** task 결과 progress가 준 canonical agent id. 실행 중 job과는 이 값으로만 대응시킨다. */
  ids: string[];
  /** 등록 순서. 같은 id를 가진 주장이 여럿이면 가장 최근 것이 그 job의 주장이다. */
  order: number;
  /** spawn한 task 호출이 아직 끝나지 않았다. foreground child는 job snapshot에 보이지 않으므로 이 표시로 실행 중이다. */
  inFlight: boolean;
};

/**
 * 한 부모 세션의 쓰기 소유 주장. 완료 보고용 OwnershipState와 달리 사용자 입력마다 비우지 않는다:
 * 앞 요청이 띄운 Maker도 아직 실행 중이면 그 경로의 owner다. 세션이 바뀔 때만 비운다.
 */
export type WriterClaimState = { claims: Map<string, WriterClaim>; order: number };

export function createWriterClaimState(): WriterClaimState {
  return { claims: new Map(), order: 0 };
}

export function resetWriterClaimState(state: WriterClaimState): void {
  state.claims.clear();
  state.order = 0;
}

/** spawn 직전 공유 작업공간 maker 항목을 in-flight 주장으로 등록한다. 격리 항목은 공유 checkout을 쓰지 않아 주장하지 않는다. */
export function claimSharedWriters(state: WriterClaimState, callId: string, makers: readonly MakerSpawn[]): void {
  for (const maker of makers) {
    if (maker.isolated) continue;
    const key = ownedChildKey(callId, maker.index);
    if (state.claims.has(key)) continue;
    state.order += 1;
    state.claims.set(key, {
      child: maker.name ?? "unnamed",
      ...(maker.name ? { name: maker.name } : {}),
      ownedPaths: [...maker.ownedPaths],
      callId,
      index: maker.index,
      ids: [],
      order: state.order,
      inFlight: true,
    });
  }
}

/**
 * spawn한 task 호출이 끝났다(tool_result 또는 실행 전 종료). progress id를 canonical id로 묶고 in-flight를 내린다.
 * 이후 활성 여부는 부모의 실행 중 job으로만 정하므로, 뜨지 못한 child의 주장은 저절로 비활성이다.
 */
export function settleSharedWriters(
  state: WriterClaimState,
  callId: string,
  progress: readonly { index: number; id: string }[],
): void {
  for (const claim of state.claims.values()) {
    if (claim.callId !== callId) continue;
    claim.inFlight = false;
    const id = progress.find((row) => row.index === claim.index)?.id;
    if (id && !claim.ids.includes(id)) claim.ids.push(id);
  }
}

/** 부모 세션이 소유한 실행 중 task job 한 건(core async job snapshot 행). */
export type RunningTaskJob = { id: string; agentId?: string };

/** child가 부모 agent id로 찾는 부모 세션의 쓰기 소유 창구. */
export type WriterOwnerView = {
  /** 부모 세션 cwd(절대경로). 같은 cwd의 child만 공유 checkout을 쓴다. */
  cwd: string;
  state: WriterClaimState;
  /** 부모 세션이 소유한 실행 중 task job. 읽지 못하면 undefined(소유자 미상). */
  running(): RunningTaskJob[] | undefined;
  /** child가 공유 checkout에 edit·write한 부모 cwd 기준 경로를 부모의 OwnershipGuard 귀속 기록에 남긴다. */
  noteWrite?(writer: string, paths: readonly string[]): void;
};

/** 부모와 child 세션은 같은 프로세스에서 확장 module을 공유한다. 여러 번 평가되어도 같은 map을 보도록 globalThis에 둔다. */
const WRITER_OWNERS = Symbol.for("@oh-my-pi/omp/writer-owners/v1");
const writerOwners: Map<string, WriterOwnerView> = (() => {
  const existing = Reflect.get(globalThis, WRITER_OWNERS) as Map<string, WriterOwnerView> | undefined;
  if (existing) return existing;
  const created = new Map<string, WriterOwnerView>();
  Reflect.set(globalThis, WRITER_OWNERS, created);
  return created;
})();

export function bindWriterOwners(agentId: string, view: WriterOwnerView): void {
  const key = agentId.trim();
  if (key) writerOwners.set(key, view);
}

/** 자기 view일 때만 푼다. 같은 agent id를 이어받은 새 세션의 연결을 옛 인스턴스의 늦은 정리가 지우지 않는다. */
export function unbindWriterOwners(agentId: string, view: WriterOwnerView): void {
  const key = agentId.trim();
  if (key && writerOwners.get(key) === view) writerOwners.delete(key);
}

export function writerOwnersOf(agentId: string): WriterOwnerView | undefined {
  return writerOwners.get(agentId.trim());
}

export type OwnerWriteDecision = {
  /** 다른 활성 owner가 가진 첫 대상. 없으면 허용이다. */
  conflict?: { owner: string; path: string };
  /** 소유 주장을 찾지 못한 실행 중 job·이름 없는 in-flight spawn. 막을 근거가 아니며 진단에만 쓴다. */
  unknown: string[];
};

/**
 * child `selfId`가 부모 cwd 기준 상대경로 `targets`에 쓰려 할 때 다른 활성 owner와 충돌하는지 본다. 부모의 job snapshot을
 * 읽지 못하면 undefined(소유자 미상)다. 활성 owner는 spawn 호출이 아직 끝나지 않은 주장과, canonical id의 job이 지금
 * 실행 중인 주장(REWORK 재개 포함)이다. 자기 소유 경로는 겹쳐도 허용하고, 자기일 수 있는 주장은 다른 owner로 보지 않는다.
 */
export function decideOwnerWrite(
  view: WriterOwnerView,
  selfId: string,
  targets: readonly string[],
): OwnerWriteDecision | undefined {
  const running = view.running();
  if (!running) return undefined;
  const own: WriterClaim[] = [];
  const others: WriterClaim[] = [];
  const unknown: string[] = [];
  for (const claim of view.state.claims.values()) {
    if (!claim.inFlight) continue;
    if (!claim.name) {
      unknown.push(`in-flight:${claim.callId}#${claim.index}`);
      continue;
    }
    // 이름 있는 child의 agent id는 이름이거나 충돌 변형(`이름-2`, `이름-3` …)이다. 자기일 수 있으면 자기로 본다.
    const suffix = selfId.startsWith(`${claim.name}-`) ? selfId.slice(claim.name.length + 1) : "";
    (selfId === claim.name || /^\d+$/.test(suffix) ? own : others).push(claim);
  }
  for (const job of running) {
    // job id는 실행 handle이라 agent id와 다를 수 있다(충돌 시 `이름-2` 등). 주장과 자기 판정은 canonical agent id로만 하고,
    // snapshot에 agentId가 없는 옛 행만 job id를 대신 쓴다.
    const agentId = job.agentId ?? job.id;
    let match: WriterClaim | undefined;
    for (const claim of view.state.claims.values()) {
      if (!claim.ids.includes(agentId)) continue;
      if (!match || claim.order > match.order) match = claim;
    }
    if (!match) {
      if (agentId !== selfId) unknown.push(agentId);
      continue;
    }
    (agentId === selfId ? own : others).push(match);
  }
  const ownPaths = own.flatMap((claim) => claim.ownedPaths);
  for (const path of targets) {
    if (isPathOwned(ownPaths, path)) continue;
    const owner = others.find((claim) => isPathOwned(claim.ownedPaths, path));
    if (owner) return { conflict: { owner: owner.child, path: collapseOwnedPath(path) }, unknown };
  }
  return { unknown };
}
