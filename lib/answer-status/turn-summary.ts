import type { ConversationRenderItem } from "@/lib/transcript-plan";
import { isTodoToolName, resolveTodoSnapshot, type TodoPhase } from "@/lib/todo-state";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";
import { userMessageDeliveryKind } from "./delivery";
import { deriveWorkFlow, readCheckRun, readCiSuccessHeads, type CheckRun, type CiSuccessHead, type WorkFlow } from "./work-flow";

/**
 * 끝난 턴 하나의 관측 요약: 실제로 쓴 파일, 실제로 실행한 검사 명령과 그 판정, 그 턴이 띄운 발주.
 * 모델이 답변에 적은 말은 읽지 않는다 — 전부 도구 호출과 그 결과에서 온다.
 */

/** 그 턴의 마지막 todo 목록에서 끝나지 않은 일. 완료·포기한 일은 남은 일이 아니다. */
export interface RemainingTask {
  phase: string;
  content: string;
  status: "pending" | "in_progress" | "blocked";
  blocker: string | null;
}

export interface TurnSummary {
  files: WrittenFile[];
  checks: CheckRun[];
  dispatchCalls: ToolCallContent[];
  /** 그 턴이 마지막으로 보고받은 todo 목록의 남은 일. 턴에 목록을 보고한 todo 호출이 없으면 null. */
  remaining: RemainingTask[] | null;
}

function remainingTasks(phases: readonly TodoPhase[]): RemainingTask[] {
  return phases.flatMap((phase) => phase.tasks.flatMap((task): RemainingTask[] => (
    task.status === "completed" || task.status === "abandoned"
      ? []
      : [{ phase: phase.name, content: task.content, status: task.status, blocker: task.blocker ?? null }]
  )));
}

export function summarizeTurn(
  blocks: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage>,
  cwd?: string,
): TurnSummary {
  const checks: CheckRun[] = [];
  const dispatchCalls: ToolCallContent[] = [];
  let lastTodo: TodoPhase[] | null = null;
  for (const block of blocks) {
    if (block.type !== "toolCall") continue;
    if (block.toolName === "task") {
      dispatchCalls.push(block);
      continue;
    }
    if (isTodoToolName(block.toolName)) {
      // 목록을 보고한 결과만 쓴다. 거절·오류·갱신만 한 호출과 결과가 오지 않은 요청은 앞선 목록을 지우지 않는다.
      const snapshot = resolveTodoSnapshot(block, toolResults.get(block.toolCallId));
      if (snapshot.kind === "authoritative") lastTodo = snapshot.phases;
      continue;
    }
    const check = readCheckRun(block, toolResults.get(block.toolCallId));
    if (check) checks.push(check);
  }
  return {
    checks,
    dispatchCalls,
    files: extractTurnWrittenFiles(blocks, toolResults, cwd),
    remaining: lastTodo ? remainingTasks(lastTodo) : null,
  };
}

/** 한 턴의 모든 assistant 블록(작업 로그로 접힌 것 포함), 메시지 순서대로. */
export function collectTurnBlocks(messages: readonly AgentMessage[], from: number, to: number): AssistantContentBlock[] {
  const blocks: AssistantContentBlock[] = [];
  for (let idx = Math.max(0, from); idx < Math.min(messages.length, to); idx++) {
    const message = messages[idx];
    if (message.role === "assistant") blocks.push(...((message as AssistantMessage).content ?? []));
  }
  return blocks;
}

/**
 * 그 사용자 메시지가 속한 요청을 연 메시지. 실행 중에 끼어든 입력(omp가 `steering: true`를 단 user 메시지)은 새 요청이 아니라
 * 그 앞 요청의 이어짐이다 — 앞 user 메시지로 거슬러 올라간다. 완료 후 요청(follow-up)과 큐 밖 입력은 새 요청을 연다.
 */
export function findRequestStart(messages: readonly AgentMessage[], userIdx: number): number {
  let start = userIdx;
  while (messages[start]?.role === "user" && userMessageDeliveryKind(messages[start]) === "steer") {
    let previous = start - 1;
    while (previous >= 0 && messages[previous].role !== "user") previous -= 1;
    if (previous < 0) break;
    start = previous;
  }
  return start;
}

/**
 * 요약을 붙일 자리: 각 요청의 마지막 답변. 스티어링으로 나뉜 조각들은 한 요청이라 카드 하나가 그 전체 범위를 요약한다.
 * 아직 진행 중인 마지막 요청(`liveTurnAnchor`가 속한 요청)은 끝난 답변이 아니므로 뺀다. 값은 그 요청의 메시지 범위 [from, to)다.
 */
export function placeTurnSummaries(
  main: readonly ConversationRenderItem[],
  messages: readonly AgentMessage[],
  liveTurnAnchor: number | null,
): Map<number, { from: number; to: number }> {
  const places = new Map<number, { from: number; to: number }>();
  const requestStarts = main
    .filter((item) => item.kind === "message" && messages[item.idx]?.role === "user" && findRequestStart(messages, item.idx) === item.idx)
    .map((item) => item.idx);
  const liveRequest = liveTurnAnchor === null ? null : findRequestStart(messages, liveTurnAnchor);
  const lastAnswerByRequest = new Map<number, number>();
  main.forEach((item, position) => {
    if (item.kind === "answer") lastAnswerByRequest.set(findRequestStart(messages, item.anchorIdx), position);
  });
  for (const [anchor, position] of lastAnswerByRequest) {
    if (anchor === liveRequest) continue;
    const next = requestStarts.find((idx) => idx > anchor);
    places.set(position, { from: anchor + 1, to: next ?? messages.length });
  }
  return places;
}

/** `to` 앞 기록의 성공한 CI 실행. 비공개 게시 판정이 그 요청보다 앞선 공개 CI 기록을 쓴다. */
export function collectPriorCiHeads(
  messages: readonly AgentMessage[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  to: number,
  from = 0,
  into: CiSuccessHead[] = [],
): CiSuccessHead[] {
  for (let idx = Math.max(0, from); idx < Math.min(messages.length, to); idx++) {
    const message = messages[idx];
    if (message.role !== "assistant") continue;
    for (const block of (message as AssistantMessage).content ?? []) {
      if (block.type === "toolCall") into.push(...readCiSuccessHeads(block, toolResults.get(block.toolCallId)));
    }
  }
  return into;
}

/** 턴의 기록된 시각 범위(ms). 기록에 시각이 하나도 없으면 null. */
export interface TurnSpan {
  startedAt: number | null;
  endedAt: number | null;
}

/**
 * 그 턴을 연 사용자 메시지(`from - 1`)부터 범위 끝까지의 기록 시각. 답변은 생성 종료 시각(`completedAt`)도
 * 끝으로 센다 — 요청 시작 시각(`timestamp`)만으로는 마지막 답변이 끝난 때를 모른다.
 */
export function readTurnSpan(messages: readonly AgentMessage[], from: number, to: number): TurnSpan {
  let startedAt: number | null = null;
  let endedAt: number | null = null;
  for (let idx = Math.max(0, from - 1); idx < Math.min(messages.length, to); idx++) {
    const message = messages[idx];
    const times = [message.timestamp, message.role === "assistant" ? (message as AssistantMessage).completedAt : undefined];
    for (const time of times) {
      if (typeof time !== "number" || !Number.isFinite(time)) continue;
      if (startedAt === null || time < startedAt) startedAt = time;
      if (endedAt === null || time > endedAt) endedAt = time;
    }
  }
  return { startedAt, endedAt };
}

export interface FinishedTurnSummary extends TurnSummary {
  span: TurnSpan;
  /** 그 요청의 작업 단계와 회차. 스티어링으로 나뉜 조각을 모두 포함한다. */
  flow: WorkFlow;
  /** 끝난 요청 가운데 가장 나중 것. 그 카드만 처음부터 펼친다. */
  latest: boolean;
}

/** 끝난 요청마다 그 요청의 마지막 답변 자리(`placeTurnSummaries`)에 붙일 요약. */
export function summarizeFinishedTurns(
  main: readonly ConversationRenderItem[],
  messages: readonly AgentMessage[],
  liveTurnAnchor: number | null,
  toolResults: Map<string, ToolResultMessage>,
  cwd?: string,
): Map<number, FinishedTurnSummary> {
  const places = placeTurnSummaries(main, messages, liveTurnAnchor);
  let latest = -1;
  for (const position of places.keys()) if (position > latest) latest = position;
  const summaries = new Map<number, FinishedTurnSummary>();
  // 앞선 기록의 공개 CI 성공은 요청 차례로 한 번만 훑어 쌓는다.
  const priorCiHeads: CiSuccessHead[] = [];
  let scanned = 0;
  for (const [position, range] of [...places].sort((a, b) => a[1].from - b[1].from)) {
    collectPriorCiHeads(messages, toolResults, range.from, scanned, priorCiHeads);
    scanned = Math.max(scanned, range.from);
    const blocks = collectTurnBlocks(messages, range.from, range.to);
    summaries.set(position, {
      ...summarizeTurn(blocks, toolResults, cwd),
      span: readTurnSpan(messages, range.from, range.to),
      flow: deriveWorkFlow(blocks, toolResults, false, priorCiHeads),
      latest: position === latest,
    });
  }
  return summaries;
}

/** Maker 한 명의 기록된 시작(spawn 결과 시각)과 소요. 모르는 값은 null이다. */
export interface MakerTiming {
  startedAt: number | null;
  durationMs: number | null;
}

/** 턴 시간축 위 막대 자리. 축 길이에 대한 비율(0~1). */
export interface MakerBar {
  offset: number;
  width: number;
}

/**
 * Maker 막대를 한 시간축에 놓는다. 축은 턴의 기록 범위이고, Maker 실행이 그 밖으로 나가면 축을 넓힌다.
 * 시작이나 소요 가운데 하나라도 없으면 그 Maker는 막대가 없다(null) — 추정해 채우지 않는다.
 */
export function layoutMakerBars(span: TurnSpan, timings: readonly MakerTiming[]): (MakerBar | null)[] {
  const runs = timings.map((timing) => (
    timing.startedAt !== null && timing.durationMs !== null
      ? { start: timing.startedAt, end: timing.startedAt + timing.durationMs }
      : null
  ));
  let axisStart = span.startedAt;
  let axisEnd = span.endedAt;
  for (const run of runs) {
    if (!run) continue;
    if (axisStart === null || run.start < axisStart) axisStart = run.start;
    if (axisEnd === null || run.end > axisEnd) axisEnd = run.end;
  }
  const length = axisStart !== null && axisEnd !== null ? axisEnd - axisStart : 0;
  return runs.map((run) => {
    if (!run) return null;
    if (length <= 0 || axisStart === null) return { offset: 0, width: 1 };
    return { offset: (run.start - axisStart) / length, width: (run.end - run.start) / length };
  });
}
