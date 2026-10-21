import type { AgentMessage, OpenRequestEvidence, ToolResultMessage, TrackerTodoRecords } from "@/lib/types";
import { continuesRequest } from "./delivery";
import { collectPriorCiHeads, summarizeRequest } from "./turn-summary";

/** 같은 가지의 원 기록. 화면에 실리지 않는 tracker 변경도 기록 순서대로 읽는다. */
export type RequestItem = { message: AgentMessage; entryId: string } | { trackerTodo: unknown[] };

/**
 * 압축 경계를 가로지르는 요청을 서버의 전체 기록으로 한 번 판정한다. 호출과 결과, job 완료가 경계 양쪽에
 * 있어도 기존 분류기에 함께 들어간다. 다음 실제 사용자 요청 전까지만 읽고, 결과는 화면의 끝 메시지 ID에 묶는다.
 */
export function readOpenRequest(
  hidden: readonly RequestItem[],
  displayed: readonly RequestItem[],
  cwd?: string,
): OpenRequestEvidence | null {
  if (hidden.length === 0) return null;
  const messages: (AgentMessage & TrackerTodoRecords)[] = [];
  const append = (item: RequestItem) => {
    if ("message" in item) {
      messages.push(item.message);
    } else {
      const last = messages.at(-1);
      if (last) messages[messages.length - 1] = { ...last, trackerTodos: [...(last.trackerTodos ?? []), item.trackerTodo] };
    }
  };
  let opener = -1;
  for (const item of hidden) {
    if ("message" in item && item.message.role === "user" && !continuesRequest(item.message)) opener = messages.length;
    append(item);
  }
  let throughEntryId: string | null = null;
  for (const item of displayed) {
    if ("message" in item) {
      if (item.message.role === "user" && !continuesRequest(item.message)) break;
      throughEntryId = item.entryId;
    }
    append(item);
  }
  if (throughEntryId === null) return null;
  const toolResults = new Map<string, ToolResultMessage>();
  for (const message of messages) if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
  const prior = collectPriorCiHeads(messages, toolResults, opener + 1);
  const { files, checks, remaining, span, flow } = summarizeRequest(messages, toolResults, opener + 1, messages.length, cwd, prior);
  if (flow.steps.length === 0 && remaining === null) return null;

  // 판정이 끝난 뒤에만 본문을 생략한다. 동일 명령의 재검사 묶음은 별도 식별자로 보존한다.
  // stages는 steps의 같은 사건을 가리키므로 이 변경은 두 표현 모두에 적용된다.
  const commands = new Map<string, string>();
  for (const step of flow.steps) {
    if (!("command" in step)) continue;
    let key = commands.get(step.command);
    if (key === undefined) {
      key = String(commands.size);
      commands.set(step.command, key);
    }
    step.commandKey = key;
    step.command = "";
  }
  for (const check of checks) check.command = "";
  return {
    throughEntryId,
    summary: { files, checks, remaining, span, flow },
    ciHeads: collectPriorCiHeads(messages, toolResults, messages.length, opener + 1, prior),
  };
}
