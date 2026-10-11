import assert from "node:assert/strict";
import { test } from "bun:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildEtaHistories,
  classifySubagentPhase,
  estimateConditionalEta,
  estimateTodoRemainingMs,
  parseLedgerLines,
  quantile,
  readSubagentTodoProgress,
  splitApproxDuration,
  subagentElapsedMs,
} = await jiti.import("./subagent-progress.ts");

const MIN = 60_000;

let seq = 0;
/** 과거 세션의 시도 하나: dispatch + outcome. */
function pastRun({ model = "test/a", workClass = "NORMAL", sec, attempt = 1, status = "completed", session = "old" }) {
  seq += 1;
  const attemptId = `${session}#call${seq}#0#a${attempt}`;
  const ids = { sessionId: session, assignmentId: `${session}#call${seq}#0`, attempt, attemptId, agentId: `Past${seq}`, jobId: `Past${seq}` };
  return [
    { type: "dispatch", name: `Past${seq}`, workClass, chosenModel: model, ...ids },
    { type: "outcome", status, durationSec: sec, ...ids },
  ];
}

function currentDispatch({ model = "test/a", workClass = "NORMAL", attempt = 1, agentId = "Live", jobId = agentId }) {
  return { type: "dispatch", name: agentId, workClass, chosenModel: model, sessionId: "now", assignmentId: "now#c#0", attempt, attemptId: `now#c#0#a${attempt}`, agentId, jobId };
}

test("quantile interpolates between neighbours and handles empty sets", () => {
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile([4, 1, 3, 2], 0.5), 2.5);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(quantile([10, 20], 0.75), 17.5);
  assert.equal(quantile([], 0.5), null);
});

test("history holds sorted durations of completed first attempts of the same model and work class only", () => {
  const rows = [
    ...pastRun({ sec: 1200 }),
    ...pastRun({ sec: 600 }),
    ...pastRun({ sec: 900 }),
    // 다른 등급·모델·실패·재작업·0초 기록은 표본이 아니다.
    ...pastRun({ sec: 5000, workClass: "HARD" }),
    ...pastRun({ sec: 5000, model: "test/b" }),
    ...pastRun({ sec: 5000, status: "failed" }),
    ...pastRun({ sec: 5000, attempt: 2 }),
    ...pastRun({ sec: 0 }),
    currentDispatch({}),
  ];
  const { Live } = buildEtaHistories(rows, "now");
  assert.deepEqual(Live, { model: "test/a", workClass: "NORMAL", rework: false, durationsSec: [600, 900, 1200] });
  // 응답에는 세션·발주 id가 없다.
  assert.equal(JSON.stringify(Live).includes("old#"), false);
});

test("an unknown work class matches the model only; the latest dispatch of the same child wins", () => {
  const rows = [
    ...pastRun({ sec: 100, workClass: "HARD" }),
    ...pastRun({ sec: 200 }),
    currentDispatch({ model: "test/b" }),
    currentDispatch({ workClass: null, jobId: "Live-2" }),
  ];
  const histories = buildEtaHistories(rows, "now");
  assert.deepEqual(histories.Live.durationsSec, [100, 200]);
  assert.deepEqual(histories["Live-2"].durationsSec, [100, 200]);
});

test("a rework attempt gets no samples and no estimate; other sessions get nothing", () => {
  const rows = [...pastRun({ sec: 100 }), ...pastRun({ sec: 200 }), ...pastRun({ sec: 300 }), currentDispatch({ attempt: 2 })];
  const { Live } = buildEtaHistories(rows, "now");
  assert.equal(Live.rework, true);
  assert.deepEqual(Live.durationsSec, []);
  assert.equal(estimateConditionalEta(Live, 0), null);
  assert.deepEqual(Object.keys(buildEtaHistories(rows, "other")), []);
});

test("broken ledger lines are skipped", () => {
  assert.deepEqual(parseLedgerLines('{"type":"dispatch"}\n{"type":"outc\n\n'), [{ type: "dispatch" }]);
});

const history = (minutes) => ({ model: "m", workClass: "NORMAL", rework: false, durationsSec: minutes.map((m) => m * 60) });

test("the remaining time is the spread of (duration − elapsed) over past runs longer than elapsed", () => {
  // 경과 5분: 2·4분 실행은 빠지고 6·10·15·25분 실행이 남는다 → 남은 1·5·10·20분.
  const eta = estimateConditionalEta(history([2, 4, 6, 10, 15, 25]), 5 * MIN);
  assert.deepEqual(eta, {
    kind: "remaining",
    p25Ms: 4 * MIN,
    medianMs: 7.5 * MIN,
    p75Ms: 12.5 * MIN,
    samples: 4,
    // 5 / (5 + 7.5) = 40%
    percent: 40,
  });
});

test("a sparse tail distinguishes zero, one and two past runs longer than elapsed", () => {
  const past = history([2, 4, 6, 10, 15, 25]);
  for (const [elapsed, longerRuns] of [[12, 2], [16, 1], [25, 0], [26, 0]]) {
    assert.deepEqual(estimateConditionalEta(past, elapsed * MIN), {
      kind: "overrun", longestMs: 25 * MIN, samples: 6, longerRuns,
    });
  }
});

test("fewer than three past runs in total hides the estimate", () => {
  assert.equal(estimateConditionalEta(history([10, 20]), MIN), null);
  assert.equal(estimateConditionalEta(undefined, MIN), null);
  assert.equal(estimateConditionalEta(history([10, 20, 30]), null), null);
});

test("the todo extra is elapsed × remaining steps / completed steps, only after a step is done", () => {
  const todo = (completed, total) => ({ completed, total, percent: Math.round((completed / total) * 100), activeTask: null });
  assert.equal(estimateTodoRemainingMs(todo(3, 7), 6 * MIN), 8 * MIN);
  assert.equal(estimateTodoRemainingMs(todo(0, 7), 6 * MIN), null);
  assert.equal(estimateTodoRemainingMs(todo(7, 7), 6 * MIN), null);
  assert.equal(estimateTodoRemainingMs(null, 6 * MIN), null);
});

const call = (toolName) => ({ role: "assistant", content: [{ type: "toolCall", toolCallId: toolName, toolName, input: {} }] });

test("phase follows the child's own tool stream and can go back", () => {
  assert.equal(classifySubagentPhase([]), null);
  // 첫 edit 전의 bash는 아직 조사다.
  assert.equal(classifySubagentPhase([call("read"), call("grep"), call("bash")]), "investigate");
  assert.equal(classifySubagentPhase([call("read"), call("edit")]), "implement");
  assert.equal(classifySubagentPhase([call("edit"), call("read"), call("bash")]), "verify");
  // 검증 뒤 다시 고치면 구현으로 돌아간다.
  assert.equal(classifySubagentPhase([call("edit"), call("bash"), call("write")]), "implement");
  assert.equal(classifySubagentPhase([call("edit"), call("eval"), call("yield")]), "report");
  assert.equal(classifySubagentPhase([call("ext.edit"), call("bash")]), "verify");
});

test("report resets edit evidence before a later run tool", () => {
  assert.equal(classifySubagentPhase([call("yield"), call("bash")]), "investigate");
  assert.equal(classifySubagentPhase([call("edit"), call("yield"), call("bash")]), "investigate");
  assert.equal(classifySubagentPhase([call("write"), call("yield"), call("eval")]), "investigate");
  assert.equal(classifySubagentPhase([call("edit"), call("yield"), call("edit"), call("bash")]), "verify");
});

function todoTranscript(tasks) {
  return [
    { role: "assistant", content: [{ type: "toolCall", toolCallId: "t1", toolName: "todo", input: { op: "replace" } }] },
    { role: "toolResult", toolCallId: "t1", toolName: "todo", content: [], details: { phases: [{ name: "P", tasks }] } },
  ];
}

test("todo progress comes from the child's latest todo; no todo still leaves a phase and an estimate", () => {
  assert.deepEqual(
    readSubagentTodoProgress(todoTranscript([
      { content: "a", status: "completed" },
      { content: "b", status: "completed" },
      { content: "c", status: "in_progress" },
      { content: "d", status: "pending" },
      { content: "e", status: "abandoned" },
    ])),
    { completed: 2, total: 4, percent: 50, activeTask: "c" },
  );
  assert.equal(readSubagentTodoProgress(todoTranscript([])), null);
  const noTodo = [call("read"), call("edit")];
  assert.equal(readSubagentTodoProgress(noTodo), null);
  assert.equal(classifySubagentPhase(noTodo), "implement");
  assert.equal(estimateConditionalEta(history([6, 10, 15]), 5 * MIN).kind, "remaining");
});

test("elapsed time adds the time since the last report only while running", () => {
  const snapshot = (status) => ({ status, lastUpdate: 1_000, progress: { durationMs: 5_000 } });
  assert.equal(subagentElapsedMs(snapshot("running"), 4_000), 8_000);
  assert.equal(subagentElapsedMs(snapshot("completed"), 4_000), 5_000);
  assert.equal(subagentElapsedMs({ status: "running", lastUpdate: 1 }, 4_000), null);
});

test("approximate durations round to minutes and say under a minute separately", () => {
  assert.equal(splitApproxDuration(59_000), null);
  assert.deepEqual(splitApproxDuration(14.4 * MIN), { hours: 0, minutes: 14 });
  assert.deepEqual(splitApproxDuration(80 * MIN), { hours: 1, minutes: 20 });
});
