import type { ConversationRenderItem } from "@/lib/transcript-plan";
import { isTodoToolName, resolveTodoSnapshot, type TodoPhase } from "@/lib/todo-state";
import { readExitCode } from "@/lib/tool-exit-code";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolCallContent, ToolResultMessage } from "@/lib/types";

/**
 * 끝난 턴 하나의 관측 요약: 실제로 쓴 파일, 실제로 실행한 검사 명령과 그 결과, 그 턴이 띄운 발주.
 * 모델이 답변에 적은 말은 읽지 않는다 — 전부 도구 호출과 그 결과에서 온다.
 */

/**
 * 검사로 세는 bash 명령: 명령 문자열에 test·typecheck·tsc·lint·eslint·vitest·jest·pytest·
 * build·check·verify·smoke 가운데 하나가 단어로 들어 있는 것.
 */
const CHECK_COMMAND = /(?:^|[^\w-])(?:tests?|typecheck|tsc|lint|eslint|vitest|jest|pytest|build|check|verify|smoke)(?![\w])/i;

export type CheckState = "passed" | "failed" | "unobserved";

export interface CheckRun {
  toolCallId: string;
  command: string;
  state: CheckState;
  /** 결과에 기록된 종료 코드. 없으면 null. */
  exitCode: number | null;
}

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
    if (block.toolName !== "bash") continue;
    const command = typeof block.input.command === "string" ? block.input.command.trim() : "";
    if (!command || !CHECK_COMMAND.test(command)) continue;
    const result = toolResults.get(block.toolCallId);
    const exitCode = result ? readExitCode(result) : null;
    // 종료 코드가 기록되지 않은 결과(백그라운드로 넘어간 실행 등)는 성공으로 치지 않는다.
    const state: CheckState = exitCode === null
      ? (result?.isError ? "failed" : "unobserved")
      : exitCode === 0 ? "passed" : "failed";
    checks.push({ toolCallId: block.toolCallId, command, state, exitCode });
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
 * 요약을 붙일 자리: 각 턴의 마지막 답변. 아직 진행 중인 마지막 턴(`liveTurnAnchor`)은 끝난 답변이
 * 아니므로 뺀다. 값은 그 턴의 메시지 범위 [from, to)다.
 */
export function placeTurnSummaries(
  main: readonly ConversationRenderItem[],
  messages: readonly AgentMessage[],
  liveTurnAnchor: number | null,
): Map<number, { from: number; to: number }> {
  const places = new Map<number, { from: number; to: number }>();
  const userIndexes = main
    .filter((item) => item.kind === "message" && messages[item.idx]?.role === "user")
    .map((item) => item.idx);
  const lastAnswerByTurn = new Map<number, number>();
  main.forEach((item, position) => {
    if (item.kind === "answer") lastAnswerByTurn.set(item.anchorIdx, position);
  });
  for (const [anchor, position] of lastAnswerByTurn) {
    if (anchor === liveTurnAnchor) continue;
    const next = userIndexes.find((idx) => idx > anchor);
    places.set(position, { from: anchor + 1, to: next ?? messages.length });
  }
  return places;
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
  /** 끝난 턴 가운데 가장 나중 것. 그 카드만 처음부터 펼친다. */
  latest: boolean;
}

/** 끝난 턴마다 그 턴의 마지막 답변 자리(`placeTurnSummaries`)에 붙일 요약. */
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
  for (const [position, range] of places) {
    summaries.set(position, {
      ...summarizeTurn(collectTurnBlocks(messages, range.from, range.to), toolResults, cwd),
      span: readTurnSpan(messages, range.from, range.to),
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
