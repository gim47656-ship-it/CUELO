import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readPersistedTodoProgress, readTodoSnapshot, type TodoSnapshotItem } from "./lib/task-progress";

// 여러 단계 요청에서 Main 이 todo 없이 도구만 이어 부르면 한 번 안내한다(2026-09-26: GPT 계열은 todo 를
// 잘 쓰는데 Claude Main 은 생략하는 일이 잦아, 사용자가 화면에서 Main 이 무엇을 하는지 알 수 없었다).
// 도구는 막지 않고, 사용자 직접 입력이 있을 때만 켜지므로 그런 입력을 받지 않는 child 세션에는 개입하지 않는다.

/** todo 없이 이만큼 도구를 부르면 3단계 이상 작업으로 본다(AGENTS 「3단계 이상이면 todo」와 같은 기준). */
const TOOL_CALLS_BEFORE_NUDGE = 3;

const REMINDER =
  "이번 사용자 요청에서 todo 목록 없이 도구를 여러 번 이어 부르고 있다. 사용자는 todo 목록으로 지금 무엇을 하는지 본다. 3단계 이상이거나 사용자가 여러 항목을 요청한 작업이면 지금 todo 를 init 해서 요청 항목을 빠짐없이 나누고, 진행에 맞춰 상태를 갱신하며 이어 가라. 조회 한두 번으로 끝나는 일이면 이 안내는 무시한다.";

const isActive = (items: readonly TodoSnapshotItem[]) =>
  items.some((item) => item.status === "pending" || item.status === "in_progress");

export default function todoNudge(pi: ExtensionAPI): void {
  let armed = false;
  let usedTodo = false;
  let nudged = false;
  let calls = 0;
  let todos: readonly TodoSnapshotItem[] = [];

  pi.on("session_start", (_event, ctx) => {
    armed = false;
    todos = readPersistedTodoProgress(ctx.sessionManager.getBranch()).currentTodos;
  });
  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    armed = true;
    usedTodo = false;
    nudged = false;
    calls = 0;
  });
  pi.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError) return;
    const snapshot = readTodoSnapshot(event.details);
    if (snapshot) todos = snapshot;
  });
  pi.on("tool_call", (event) => {
    if (!armed || nudged || usedTodo) return;
    if (event.toolName === "todo") {
      usedTodo = true;
      return;
    }
    // 이전 요청의 진행 중 목록이 있으면 이미 추적 중이다. 끼어든 짧은 지시마다 새 목록을 강요하지 않는다.
    if (isActive(todos)) return;
    calls += 1;
    if (calls < TOOL_CALLS_BEFORE_NUDGE) return;
    nudged = true;
    pi.sendMessage(
      { customType: "todo-nudge", content: REMINDER, display: false, attribution: "agent" },
      { deliverAs: "aside" },
    );
  });
}
