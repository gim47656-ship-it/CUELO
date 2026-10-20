import assert from "node:assert/strict";
import { test } from "bun:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildEtaHistories,
  buildSubagentFlow,
  classifySubagentPhase,
  estimateConditionalEta,
  estimateTodoRemainingMs,
  parseLedgerLines,
  quantile,
  readSubagentTodoProgress,
  splitApproxDuration,
  subagentElapsedMs,
  traceSubagentRun,
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
  assert.deepEqual(Live, { model: "test/a", workClass: "NORMAL", rework: false, attempt: 1, firstDispatchedAtMs: null, durationsSec: [600, 900, 1200] });
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
  assert.equal(Live.attempt, 2);
  assert.deepEqual(Live.durationsSec, []);
  assert.equal(estimateConditionalEta(Live, 0), null);
  assert.deepEqual(Object.keys(buildEtaHistories(rows, "other")), []);
});

test("a rework attempt carries the earliest dispatch time of the same assignment", () => {
  const rows = [
    { ...currentDispatch({ attempt: 2 }), ts: "2026-10-12T02:37:31.714Z" },
    { ...currentDispatch({ attempt: 1 }), ts: "2026-10-12T02:10:19.101Z" },
    // 다른 배정·다른 세션의 더 이른 발주는 섞이지 않는다.
    { ...currentDispatch({ attempt: 1, agentId: "Other" }), assignmentId: "now#d#0", attemptId: "now#d#0#a1", ts: "2026-10-12T01:00:00.000Z" },
    { ...currentDispatch({ attempt: 1 }), sessionId: "old", attemptId: "old#c#0#a1", ts: "2026-10-11T00:00:00.000Z" },
    { ...currentDispatch({ attempt: 3 }), ts: "2026-10-12T02:59:34.312Z" },
  ];
  const { Live } = buildEtaHistories(rows, "now");
  assert.equal(Live.attempt, 3);
  assert.equal(Live.firstDispatchedAtMs, Date.parse("2026-10-12T02:10:19.101Z"));
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

// 자식 기록 한 조각: 도구 호출과(있으면) 그 결과. 검사 명령은 결과의 종료 코드로 판정한다.
let callSeq = 0;
function tool(toolName, input = {}, exitCode) {
  callSeq += 1;
  const toolCallId = `c${callSeq}`;
  const messages = [{ role: "assistant", content: [{ type: "toolCall", toolCallId, toolName, input }] }];
  if (exitCode !== undefined) {
    messages.push({ role: "toolResult", toolCallId, toolName, isError: exitCode !== 0, details: { exitCode }, content: [{ type: "text", text: `Command exited with code ${exitCode}` }] });
  }
  return messages;
}
const test_ = (exitCode) => tool("bash", { command: "bun test lib/x.test.mjs" }, exitCode);
const run = (...parts) => parts.flat();
const counts = (trace) => [trace.calls.investigate, trace.calls.implement, trace.calls.verify, trace.calls.report];

test("the run trace covers only the current run: a final yield ends a run, a progress yield does not", () => {
  const first = run(tool("read"), tool("edit"), test_(0), tool("yield", { data: {} }));
  // 깨운 뒤의 실행은 앞 실행의 보고 뒤에서 조사부터 다시 시작한다.
  const revived = traceSubagentRun(run(first, tool("read"), tool("grep")));
  assert.deepEqual([revived.phase, revived.ended, counts(revived)], ["investigate", false, [2, 0, 0, 0]]);
  // 앞 실행만 있으면 그 실행이 보고로 끝난 지금 기록의 마지막 실행이다.
  const ended = traceSubagentRun(first);
  assert.deepEqual([ended.phase, ended.ended, counts(ended), ended.checks], ["report", true, [1, 1, 1, 1], { passed: 1, failed: 0, unknown: 0 }]);
  // 부분 보고(type 배열)는 실행을 끝내지 않는다.
  const partial = traceSubagentRun(run(tool("edit"), tool("yield", { type: ["progress"], data: {} }), tool("read")));
  assert.equal(partial.ended, false);
  assert.equal(partial.calls.implement, 1);
  assert.equal(traceSubagentRun([]), null);
});

test("only checks after an edit count for verification, and an edit after the last check leaves it unverified", () => {
  const trace = traceSubagentRun(run(test_(1), tool("edit"), test_(1), tool("edit"), test_(0), tool("bash", { command: "ls" }, 0), tool("edit")));
  // 첫 검사는 고치기 전(조사)이라 검증 검사가 아니다.
  assert.deepEqual(trace.checks, { passed: 1, failed: 1, unknown: 0 });
  assert.deepEqual([trace.phase, trace.reedits, trace.verifiedAfterEdit, counts(trace)], ["implement", 2, false, [1, 3, 3, 0]]);
  // 결과가 기록에 없는 검사는 판정하지 않는다.
  assert.deepEqual(traceSubagentRun(run(tool("edit"), test_(undefined))).checks, { passed: 0, failed: 0, unknown: 1 });
  assert.equal(traceSubagentRun(run(tool("edit"), test_(0))).verifiedAfterEdit, true);
});

test("stations come from the recorded run: never-entered stages are skipped, waiting only while live, unknown without a record", () => {
  const states = (flow) => flow.stations.map((station) => station.state);
  const verifying = traceSubagentRun(run(tool("read"), tool("edit"), test_(0)));
  assert.deepEqual(states(buildSubagentFlow(verifying, true)), ["done", "done", "active", "waiting"]);
  // 끝난 실행이 보고에 닿지 못했으면 그 뒤 단계는 기록이 없다(대기가 아니다).
  assert.deepEqual(states(buildSubagentFlow(verifying, false)), ["done", "done", "done", "none"]);
  // 고치지 않고 보고한 실행: 구현·검증은 건너뛰었다.
  const diagnostic = traceSubagentRun(run(tool("read"), tool("bash", { command: "ls" }, 0), tool("yield", { data: {} })));
  assert.deepEqual(states(buildSubagentFlow(diagnostic, false)), ["done", "skipped", "skipped", "done"]);
  // 검사 뒤 다시 고치고 보고했다: 검증은 수정 전 것이다.
  const untested = traceSubagentRun(run(tool("edit"), test_(0), tool("edit"), tool("yield", { data: {} })));
  assert.deepEqual(states(buildSubagentFlow(untested, false)), ["skipped", "done", "stale", "done"]);
  // 보고로 끝난 기록인데 자식이 다시 실행 중이면 새 실행이 아직 도구를 부르지 않은 것이다.
  const woken = buildSubagentFlow(traceSubagentRun(run(tool("edit"), test_(0), tool("yield", { data: {} }))), true);
  assert.deepEqual([states(woken), woken.run.phase, woken.run.checks.passed], [["active", "waiting", "waiting", "waiting"], "investigate", 0]);
  assert.deepEqual(states(buildSubagentFlow(null, true)), ["unobserved", "unobserved", "unobserved", "unobserved"]);
  assert.equal(buildSubagentFlow(null, true).run, null);
});

/** 쓰기·수정 호출과 성공 결과. hashline 수정처럼 경로를 결과에만 남기는 호출은 `details`로 준다. */
function wrote(toolName, input, details) {
  const [message] = tool(toolName, input);
  const { toolCallId } = message.content[0];
  return [message, { role: "toolResult", toolCallId, toolName, isError: false, details, content: [{ type: "text", text: "ok" }] }];
}

test("a child's writes that touch only scratch paths are investigation, not implementation", () => {
  const scratchOnly = run(
    tool("read"),
    wrote("write", { path: ".omp/probe.sh" }),
    wrote("edit", { input: "[/tmp/x.ts#1A2B]\nPUT >1:\n+x" }, { path: "/tmp/x.ts", op: "update" }),
    tool("bash", { command: "bash .omp/probe.sh" }, 0),
  );
  assert.equal(classifySubagentPhase(scratchOnly), "investigate");
  const trace = traceSubagentRun(scratchOnly);
  assert.deepEqual([trace.phase, counts(trace), trace.reedits, trace.checks], ["investigate", [4, 0, 0, 0], 0, { passed: 0, failed: 0, unknown: 0 }]);
  assert.deepEqual(buildSubagentFlow(trace, false).stations.map((station) => station.state), ["done", "none", "none", "none"]);
  // After a real edit, a scratch probe does not count as editing again, so the earlier check still covers the code.
  const probing = traceSubagentRun(run(tool("edit", { path: "src/a.ts" }), test_(0), wrote("write", { path: ".omp/probe.sh" })));
  assert.deepEqual([probing.phase, probing.reedits, probing.verifiedAfterEdit], ["verify", 0, true]);
});

test("a child's mixed scratch-and-real write, isolated-worktree edits and omp configuration stay implementation", () => {
  const cases = {
    mixed: wrote("edit", { input: "[.omp/a.sh#1111]\nPUT >1:\n+x\n[src/a.ts#2222]\nPUT >1:\n+y" }, {
      perFileResults: [{ path: "/repo/.omp/a.sh", op: "update" }, { path: "/repo/src/a.ts", op: "update" }],
    }),
    "isolated worktree": wrote("write", { path: "/home/user/.omp/wt/iso-1a2b3c4d5/m/src/a.ts" }),
    "project rule": wrote("write", { path: ".omp/rules/r.md" }),
  };
  for (const [name, entry] of Object.entries(cases)) {
    assert.equal(classifySubagentPhase(run(tool("read"), entry)), "implement", name);
    assert.equal(traceSubagentRun(run(tool("read"), entry)).phase, "implement", name);
  }
  // A child whose cwd is known keeps the files inside it even when that folder is a temp folder.
  const inTemp = run(wrote("write", { path: "/tmp/work/src/a.ts" }));
  assert.equal(classifySubagentPhase(inTemp), "investigate");
  assert.equal(classifySubagentPhase(inTemp, "/tmp/work"), "implement");
  assert.equal(traceSubagentRun(inTemp, "/tmp/work").phase, "implement");
});
