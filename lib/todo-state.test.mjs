import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { selectCurrentTodo } = await jiti.import("./todo-state.ts");

// A transcript whose newest todo record reports 12 of 38 done, paired call + result.
function transcriptWithTodoRecord(phases) {
  const callId = "call_todo_1";
  const messages = [
    {
      role: "assistant",
      content: [{ type: "toolCall", toolCallId: callId, toolName: "todo", input: { op: "view" } }],
    },
    { role: "toolResult", toolCallId: callId, toolName: "todo", content: [], details: { op: "view", phases } },
  ];
  return { messages, toolResults: new Map([[callId, messages[1]]]) };
}

// The list the strip renders is (phase name, task content, task status) - not the presence of
// optional keys such as `blocker`, which a reader may carry as an explicit undefined.
const shown = (phases) =>
  (phases ?? []).map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({ content: task.content, status: task.status })),
  }));

const recorded = [
  { name: "조사", tasks: [{ content: "확인", status: "completed" }, { content: "적용", status: "pending" }] },
];

test("the tracker's list wins over the transcript's older record", () => {
  const reported = [
    { name: "조사", tasks: [{ content: "확인", status: "completed" }, { content: "적용", status: "completed" }] },
  ];
  const { messages, toolResults } = transcriptWithTodoRecord(recorded);

  assert.deepEqual(shown(selectCurrentTodo(messages, toolResults, reported)), shown(reported));
});

test("an emptied tracker clears the strip instead of replaying the last record", () => {
  const { messages, toolResults } = transcriptWithTodoRecord(recorded);

  assert.deepEqual(shown(selectCurrentTodo(messages, toolResults, [])), []);
});

test("without a tracker report the transcript's own record is still the list", () => {
  const { messages, toolResults } = transcriptWithTodoRecord(recorded);

  assert.deepEqual(shown(selectCurrentTodo(messages, toolResults)), shown(recorded));
  assert.deepEqual(shown(selectCurrentTodo(messages, toolResults, null)), shown(recorded));
});
