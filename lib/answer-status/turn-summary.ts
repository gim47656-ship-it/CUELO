import type { ConversationRenderItem } from "@/lib/transcript-plan";
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

export interface TurnSummary {
  files: WrittenFile[];
  checks: CheckRun[];
  dispatchCalls: ToolCallContent[];
}

function readExitCode(result: ToolResultMessage): number | null {
  const details = result.details as { exitCode?: unknown } | undefined;
  if (typeof details?.exitCode === "number") return details.exitCode;
  const text = result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
  const match = /Command exited with code (-?\d+)\s*$/.exec(text.trimEnd());
  return match ? Number(match[1]) : null;
}

export function summarizeTurn(
  blocks: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage>,
  cwd?: string,
): TurnSummary {
  const checks: CheckRun[] = [];
  const dispatchCalls: ToolCallContent[] = [];
  for (const block of blocks) {
    if (block.type !== "toolCall") continue;
    if (block.toolName === "task") {
      dispatchCalls.push(block);
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
