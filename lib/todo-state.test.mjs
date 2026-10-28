import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { selectCurrentTodo, readTrackerPhases, unmetTodoDependencies, summarizeTodo } = await jiti.import("./todo-state.ts");

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

test("the list the compaction hid answers only when neither the tracker nor a shown record does", () => {
  const hidden = [{ name: "압축 전", tasks: [{ content: "가려진 할 일", status: "in_progress" }] }];
  const { messages, toolResults } = transcriptWithTodoRecord(recorded);

  assert.deepEqual(shown(selectCurrentTodo([], new Map(), null, hidden)), shown(hidden));
  assert.deepEqual(shown(selectCurrentTodo(messages, toolResults, null, hidden)), shown(recorded));
  // An emptied tracker is still the answer; the older hidden list must not come back.
  assert.deepEqual(shown(selectCurrentTodo([], new Map(), [], hidden)), []);
});

test("persisted tracker records update the current strip without a live runtime report", () => {
  const done = [{ name: "조사", tasks: [{ content: "확인", status: "completed" }, { content: "적용", status: "completed" }] }];
  const { messages, toolResults } = transcriptWithTodoRecord(recorded);
  const answer = { role: "assistant", content: [{ type: "text", text: "done" }], trackerTodos: [done] };
  assert.deepEqual(shown(selectCurrentTodo([answer], new Map(), null, recorded)), shown(done), "tracker survives a hidden native todo call");
  assert.deepEqual(shown(selectCurrentTodo([...messages, answer], toolResults)), shown(done), "tracker supersedes an older visible result");
  assert.deepEqual(selectCurrentTodo([{ ...answer, trackerTodos: [done, []] }], new Map(), null, recorded), [], "an explicit clear stays empty");
  assert.deepEqual(shown(selectCurrentTodo([...messages, { ...answer, trackerTodos: [[{ name: "bad", tasks: [{ content: 3, status: "completed" }] }]] }], toolResults)), shown(recorded));
  assert.deepEqual(shown(selectCurrentTodo([answer], new Map(), recorded)), shown(recorded), "live tracker remains authoritative");
});

test("dependency waits survive transcript and tracker reload, release only on completion, and return on rework", () => {
  const phases = [{ name: "Plan", tasks: [
    { content: "A", status: "blocked" },
    { content: "B", status: "pending", dependsOn: ["A"] },
    { content: "C", status: "pending" },
  ] }];
  const { messages, toolResults } = transcriptWithTodoRecord(phases);
  for (const snapshot of [selectCurrentTodo(messages, toolResults), readTrackerPhases(JSON.parse(JSON.stringify(phases)))]) {
    assert.deepEqual(unmetTodoDependencies(snapshot[0].tasks[1], snapshot), ["A"]);
    assert.deepEqual(unmetTodoDependencies(snapshot[0].tasks[2], snapshot), []);
    assert.equal(summarizeTodo(snapshot).activeTask.content, "C");
    snapshot[0].tasks[0].status = "completed";
    assert.deepEqual(unmetTodoDependencies(snapshot[0].tasks[1], snapshot), []);
    assert.equal(summarizeTodo(snapshot).activeTask.content, "B");
    snapshot[0].tasks[0].status = "pending";
    assert.deepEqual(unmetTodoDependencies(snapshot[0].tasks[1], snapshot), ["A"]);
    snapshot[0].tasks[0].status = "abandoned";
    assert.deepEqual(unmetTodoDependencies(snapshot[0].tasks[1], snapshot), ["A"]);
    const dependent = snapshot[0].tasks[1];
    snapshot[0].tasks.shift();
    assert.deepEqual(unmetTodoDependencies(dependent, snapshot), ["A"], "removal is not completion");
  }
});
