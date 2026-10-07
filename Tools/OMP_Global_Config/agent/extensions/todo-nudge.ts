import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { readPersistedTodoProgress, readTodoSnapshot, type TodoSnapshotItem } from "./lib/task-progress";

// 사용자 직접 입력 하나에서 todo 없이 도구를 세 번 부르면 요청당 한 번 안내한다.
// 2026-10-08 사용자 결정: 요청 분류용 JEV 호출을 두지 않는다. 결정론적 3회 규칙만 쓴다.
const TOOL_CALLS_BEFORE_NUDGE = 3;

const REMINDER =
  "이번 사용자 요청에서 todo 없이 도구를 이어 부르고 있다. 여러 항목 또는 3단계 이상 작업이면 지금 todo 를 init 해서 요청 항목을 빠짐없이 나누고, 진행에 맞춰 상태를 갱신하며 이어 가라.";

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
  pi.on("session_shutdown", () => {
    armed = false;
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
    // 이전 요청의 진행 중 목록이 있으면 이미 추적 중이다.
    if (todos.some((item) => item.status === "pending" || item.status === "in_progress")) return;
    calls += 1;
    if (calls < TOOL_CALLS_BEFORE_NUDGE) return;
    nudged = true;
    pi.sendMessage(
      { customType: "todo-nudge", content: REMINDER, display: false, attribution: "agent" },
      { deliverAs: "aside" },
    );
  });
}
