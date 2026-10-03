import {
  resolveSubagentModelMeta,
  resolveSubagentTaskPresentation,
  type MergedSubagentRecord,
  type SubagentModelMeta,
} from "@/lib/hanse-subagent-client";
import type { ConversationRenderItem } from "@/lib/transcript-plan";
import type {
  AgentMessage,
  AssistantMessage,
  CustomMessage,
  SubagentSnapshot,
  SubagentStatus,
  ToolCallContent,
  ToolResultMessage,
} from "@/lib/types";

/**
 * Main 세션 기록에서 읽는 서브에이전트 발주 원장.
 *
 * - 발주: `task` 도구 호출과 그 결과. 결과가 오류면 spawn이 없었으므로 Maker로 세지 않는다.
 * - Maker 실행 상태: 실시간 스냅샷(`parentToolCallId`), 그다음 같은 세션의 `wait` 결과
 *   `details.jobs[]`(type `task`)와 `async-result` 통지의 `<task-result status>`.
 * - Main 판정: 같은 세션의 성공한 `routing_verdict` 결과 `details.record`. 그 assignmentId는
 *   `<sessionId>#<task toolCallId>#<tasks index>`라 발주와 그대로 맞물린다. 판정이 없으면
 *   "검수 미기록"이고 통과가 아니다.
 *
 * 모델 산문은 읽지 않는다.
 */

export type MainVerdict = "accepted" | "rework" | "held";

export interface VerdictRecord {
  verdict: MainVerdict;
  attempt: number | null;
  reason: string | null;
  /** 세션 메시지 순서. 마지막 판정이 현재 판정이다. */
  order: number;
}

export interface ObservedRun {
  status: SubagentStatus;
  order: number;
}

export interface DispatchMember {
  /** `<task toolCallId>#<index>` — assignmentId의 세션 뒤 부분. */
  key: string;
  toolCallId: string;
  index: number;
  agentId: string;
  agent: string | null;
  /** 발주 원문. TASK_TITLE을 여기서만 읽는다. */
  task: string;
  /** 이 호출의 spawn 결과가 왔는가. 없으면 아직 발주 중이다. */
  spawned: boolean;
}

export interface DispatchLedger {
  verdicts: ReadonlyMap<string, readonly VerdictRecord[]>;
  runs: ReadonlyMap<string, ObservedRun>;
  /** agentId별 가장 최근 발주 key. parentToolCallId 없는 옛 스냅샷을 그 발주에만 붙인다. */
  latestByAgent: ReadonlyMap<string, string>;
}

export const EMPTY_DISPATCH_LEDGER: DispatchLedger = {
  verdicts: new Map(),
  runs: new Map(),
  latestByAgent: new Map(),
};

/** 기록에 실린 task 입력·결과·판정·wait 결과의 모양. 쓰는 필드만 `typeof`로 확인해 읽는다. */
interface TaskEntryShape { index?: unknown; id?: unknown; name?: unknown; agent?: unknown; task?: unknown }
interface VerdictRecordShape { verdict?: unknown; assignmentId?: unknown; attempt?: unknown; reason?: unknown }
interface WaitJobShape { type?: unknown; id?: unknown; status?: unknown }

/** 배열이면 그 안의 객체 항목만, 아니면 빈 배열. 기록 필드는 런타임에 모양이 보장되지 않는다. */
function objectEntries<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((entry): entry is T => typeof entry === "object" && entry !== null) : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeStatus(value: unknown): SubagentStatus | null {
  switch (value) {
    case "pending":
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "aborted":
    case "cancelled":
    case "canceled":
      return "aborted";
    default:
      return null;
  }
}

function contentText(content: ToolResultMessage["content"] | CustomMessage["content"]): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

/**
 * 한 `task` 호출이 띄운 Maker들. 결과가 오류(가드 거절 등)면 null — 띄운 Maker가 없다.
 * 결과가 아직 없으면 입력의 tasks로 "발주 중" 항목을 만든다.
 */
export function readDispatchMembers(call: ToolCallContent, result: ToolResultMessage | undefined): DispatchMember[] | null {
  if (result?.isError) return null;
  const inputTasks = objectEntries<TaskEntryShape>(call.input.tasks);
  const progress = objectEntries<TaskEntryShape>((result?.details as { progress?: unknown } | undefined)?.progress);
  const count = Math.max(inputTasks.length, progress.length);
  const members: DispatchMember[] = [];
  for (let index = 0; index < count; index++) {
    const spawn = progress.find((entry) => entry.index === index) ?? progress[index];
    const input = inputTasks[index];
    const agentId = readString(spawn?.id) ?? readString(input?.name);
    if (!agentId) continue;
    members.push({
      key: `${call.toolCallId}#${index}`,
      toolCallId: call.toolCallId,
      index,
      agentId,
      agent: readString(spawn?.agent) ?? readString(input?.agent),
      task: readString(spawn?.task) ?? readString(input?.task) ?? "",
      spawned: Boolean(result),
    });
  }
  return members;
}

function readVerdict(result: ToolResultMessage): { key: string; record: Omit<VerdictRecord, "order"> } | null {
  if (result.isError) return null;
  let record = (result.details as { record?: VerdictRecordShape } | undefined)?.record;
  if (typeof record !== "object" || record === null) {
    try {
      const parsed = JSON.parse(contentText(result.content)) as { ok?: unknown; record?: VerdictRecordShape } | null;
      record = parsed?.ok === true ? parsed.record : undefined;
    } catch {
      return null;
    }
  }
  if (typeof record !== "object" || record === null) return null;
  const verdict = record.verdict;
  if (verdict !== "accepted" && verdict !== "rework" && verdict !== "held") return null;
  const assignmentId = readString(record.assignmentId);
  const parts = assignmentId?.split("#") ?? [];
  // <sessionId>#<toolCallId>#<index>; toolCallId 안에는 `#`가 없다.
  if (parts.length < 3) return null;
  const index = parts[parts.length - 1];
  const toolCallId = parts.slice(1, -1).join("#");
  if (!/^\d+$/.test(index) || !toolCallId) return null;
  return {
    key: `${toolCallId}#${index}`,
    record: {
      verdict,
      attempt: typeof record.attempt === "number" ? record.attempt : null,
      reason: readString(record.reason),
    },
  };
}

const TASK_RESULT_TAG = /<task-result\b([^>]*)>/g;
const TAG_ATTRIBUTE = /(\w+)="([^"]*)"/g;

export function buildDispatchLedger(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
): DispatchLedger {
  const verdicts = new Map<string, VerdictRecord[]>();
  const runs = new Map<string, ObservedRun>();
  const latestByAgent = new Map<string, string>();

  const observe = (agentId: string, status: SubagentStatus | null, order: number) => {
    const key = latestByAgent.get(agentId);
    if (!key || !status) return;
    runs.set(key, { status, order });
  };

  messages.forEach((message, order) => {
    if (message.role === "assistant") {
      for (const block of (message as AssistantMessage).content ?? []) {
        if (block.type !== "toolCall" || block.toolName !== "task") continue;
        const result = toolResults.get(block.toolCallId);
        if (!result) continue;
        for (const member of readDispatchMembers(block, result) ?? []) latestByAgent.set(member.agentId, member.key);
      }
      return;
    }
    if (message.role === "toolResult") {
      if (message.toolName === "routing_verdict") {
        const read = readVerdict(message);
        if (!read) return;
        const list = verdicts.get(read.key) ?? [];
        list.push({ ...read.record, order });
        verdicts.set(read.key, list);
        return;
      }
      if (message.toolName === "wait") {
        for (const job of objectEntries<WaitJobShape>((message.details as { jobs?: unknown } | undefined)?.jobs)) {
          if (job.type !== "task") continue;
          const agentId = readString(job.id);
          if (agentId) observe(agentId, normalizeStatus(job.status), order);
        }
      }
      return;
    }
    if (message.role === "custom" && message.customType === "async-result") {
      for (const tag of contentText(message.content).matchAll(TASK_RESULT_TAG)) {
        const attributes = Object.fromEntries([...tag[1].matchAll(TAG_ATTRIBUTE)].map((match) => [match[1], match[2]]));
        if (attributes.id) observe(attributes.id, normalizeStatus(attributes.status), order);
      }
    }
  });

  return { verdicts, runs, latestByAgent };
}

export type MakerRunState = "dispatching" | "pending" | "running" | "completed" | "failed" | "aborted" | "unobserved";

export interface MakerPresentation {
  member: DispatchMember;
  title: string;
  explicitTitle: boolean;
  stage: string | null;
  model: SubagentModelMeta | null;
  run: MakerRunState;
  /** 실행 상태의 출처. 미관측이면 null. */
  runSource: "live" | "record" | null;
  verdict: VerdictRecord | null;
}

/** 이 발주에 속한 실시간 스냅샷. parentToolCallId가 있으면 그것으로만 잇는다. */
export function findLiveSnapshot(
  member: DispatchMember,
  subagents: readonly SubagentSnapshot[],
  ledger: DispatchLedger,
): SubagentSnapshot | undefined {
  return subagents.find((snapshot) => (
    snapshot.parentToolCallId
      ? snapshot.parentToolCallId === member.toolCallId && snapshot.id === member.agentId
      : snapshot.id === member.agentId && ledger.latestByAgent.get(member.agentId) === member.key
  ));
}

export function presentMaker(
  member: DispatchMember,
  subagents: readonly SubagentSnapshot[],
  ledger: DispatchLedger,
): MakerPresentation {
  const live = findLiveSnapshot(member, subagents, ledger);
  // 실시간 스냅샷이 발주 원문을 싣지 않았으면 spawn 결과의 원문을 assignment로 채운다. 스냅샷이 없으면 그 원문만
  // 같은 레코드 모양으로 넘겨 안정 제목 규칙(resolveSubagentTaskPresentation)을 그대로 쓴다.
  const record: MergedSubagentRecord = live
    ? { key: member.key, identity: "live", live: live.assignment ? live : { ...live, assignment: member.task } }
    : {
        key: member.key,
        identity: "live",
        live: {
          id: member.agentId,
          index: member.index,
          agent: member.agent ?? "",
          agentSource: "user",
          status: "unknown",
          task: member.task,
          lastUpdate: 0,
        },
      };
  const presentation = resolveSubagentTaskPresentation(record);
  const observed = ledger.runs.get(member.key);
  let run: MakerRunState;
  let runSource: MakerPresentation["runSource"] = null;
  if (live && live.status !== "unknown") {
    run = live.status;
    runSource = "live";
  } else if (observed && observed.status !== "unknown") {
    run = observed.status;
    runSource = "record";
  } else {
    run = member.spawned ? "unobserved" : "dispatching";
  }
  const verdicts = ledger.verdicts.get(member.key);
  return {
    member,
    title: presentation.title,
    explicitTitle: presentation.explicitTitle,
    stage: live ? presentation.stage : null,
    model: live ? resolveSubagentModelMeta(record) : null,
    run,
    runSource,
    verdict: verdicts && verdicts.length > 0 ? verdicts[verdicts.length - 1] : null,
  };
}

export interface DispatchSlot {
  calls: ToolCallContent[];
  /** 답변 본문 기준 카드 자리: 도구 호출이 답변 뒤면 "after", 앞이면 "before". */
  placement: "before" | "after";
}

/**
 * 각 `task` 호출을 같은 턴의 답변 하나에 붙인다. 작업 로그로 접힌 호출 자리에 가장 가까운 답변 —
 * 그 호출 앞(같은 메시지 포함)의 마지막 답변 뒤, 없으면 그 뒤 첫 답변 앞이다. 그 턴에 답변이
 * 없으면 붙일 자리가 없다(작업 로그와 상세 패널에는 그대로 남는다).
 */
export function placeDispatchCards(
  main: readonly ConversationRenderItem[],
  messages: readonly AgentMessage[],
): Map<number, DispatchSlot> {
  const slots = new Map<number, DispatchSlot>();
  const answers = main
    .map((item, position) => ({ item, position }))
    .filter((entry): entry is { item: Extract<ConversationRenderItem, { kind: "answer" }>; position: number } => entry.item.kind === "answer");
  if (answers.length === 0) return slots;
  const userIndexes = main
    .filter((item) => item.kind === "message" && messages[item.idx]?.role === "user")
    .map((item) => item.idx);

  messages.forEach((message, idx) => {
    if (message.role !== "assistant") return;
    const calls = (message as AssistantMessage).content?.filter(
      (block): block is ToolCallContent => block.type === "toolCall" && block.toolName === "task",
    ) ?? [];
    if (calls.length === 0) return;
    let anchor = -1;
    for (const userIdx of userIndexes) if (userIdx < idx) anchor = userIdx;
    const turnAnswers = answers.filter((entry) => entry.item.anchorIdx === anchor);
    const before = turnAnswers.filter((entry) => entry.item.idx <= idx).pop();
    const target = before ?? turnAnswers.find((entry) => entry.item.idx > idx);
    if (!target) return;
    const placement = before ? "after" : "before";
    const slot = slots.get(target.position);
    if (slot) slot.calls.push(...calls);
    else slots.set(target.position, { calls: [...calls], placement });
  });
  return slots;
}

export type DockPhase = "running" | "awaiting";

export interface DockMaker {
  maker: MakerPresentation;
  phase: DockPhase;
  /** 이 발주 카드가 붙은 대화 항목 위치(`placeDispatchCards`의 키). 붙을 답변이 아직 없으면 null. */
  position: number | null;
}

export interface DockSummary {
  running: number;
  awaiting: number;
  /** 눌렀을 때 갈 Maker: 카드 자리가 있는 가장 최근 발주, 없으면 가장 최근 발주. */
  target: DockMaker;
}

/** 실행 상태가 dock에서 어느 쪽 후보인가. 미관측은 실행 중인지 끝났는지 모르므로 올리지 않는다. */
const DOCK_CANDIDATE: Record<MakerRunState, DockPhase | null> = {
  dispatching: "running",
  pending: "running",
  running: "running",
  completed: "awaiting",
  failed: "awaiting",
  aborted: "awaiting",
  unobserved: null,
};

/**
 * 입력창 위 dock 한 줄에 올릴 Maker. 위로 밀려 안 보이는 발주 카드 대신 지금 볼 것만 센다.
 *
 * - 실행 중: 실시간 스냅샷이 실행 중이면 어느 턴이든. 기록·발주 중 상태는 Main이 아직 도는
 *   마지막 턴만 — 중단된 세션의 기록은 영영 바뀌지 않으므로 고정해 두지 않는다.
 * - 판정 대기: 마지막 턴에서 실행이 끝났는데 Main 판정(`routing_verdict`)이 아직 없는 것.
 *   다음 사용자 입력부터는 그 턴의 카드에만 남는다.
 */
export function collectDockMakers(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  slots: ReadonlyMap<number, DispatchSlot>,
  subagents: readonly SubagentSnapshot[],
  ledger: DispatchLedger,
  sessionBusy: boolean,
): DockSummary | null {
  let lastUser = -1;
  messages.forEach((message, idx) => {
    if (message.role === "user") lastUser = idx;
  });
  const positionByCall = new Map<string, number>();
  for (const [position, slot] of slots) for (const call of slot.calls) positionByCall.set(call.toolCallId, position);

  const dock: DockMaker[] = [];
  messages.forEach((message, idx) => {
    if (message.role !== "assistant") return;
    const latestTurn = idx > lastUser;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (block.type !== "toolCall" || block.toolName !== "task") continue;
      for (const member of readDispatchMembers(block, toolResults.get(block.toolCallId)) ?? []) {
        const maker = presentMaker(member, subagents, ledger);
        const candidate = DOCK_CANDIDATE[maker.run];
        let phase: DockPhase | null = null;
        if (candidate === "running" && (maker.runSource === "live" || (latestTurn && sessionBusy))) phase = "running";
        else if (candidate === "awaiting" && latestTurn && !maker.verdict) phase = "awaiting";
        if (phase) dock.push({ maker, phase, position: positionByCall.get(block.toolCallId) ?? null });
      }
    }
  });
  if (dock.length === 0) return null;

  let running = 0;
  for (const entry of dock) if (entry.phase === "running") running += 1;
  const placed = dock.filter((entry) => entry.position !== null);
  return {
    running,
    awaiting: dock.length - running,
    target: placed.length > 0 ? placed[placed.length - 1] : dock[dock.length - 1],
  };
}
