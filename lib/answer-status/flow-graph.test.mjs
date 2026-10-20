import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildFlowGraph, replayBeats } = await jiti.import("./flow-graph.ts");
const { buildDispatchLedger, readDispatchMembers, presentMaker } = await jiti.import("./dispatch.ts");

const maker = (key, toolCallId, run = "completed", runSource = "record") => ({
  member: { key, toolCallId, index: 0, agentId: key, agent: "maker", task: "", workClass: null, spawned: true },
  title: key, explicitTitle: false, stage: null, model: null, run, runSource, verdict: null,
});
const span = { startedAt: 0, endedAt: 100 };
const concurrency = (graph) => graph.makers.map((entry) => [entry.maker.member.key, entry.concurrency]);

test("spawn timestamps and durations cannot prove concurrent execution when Makers queue", () => {
  const queued = buildFlowGraph([maker("A", "t1"), maker("B", "t1")], [{ startedAt: 0, durationMs: 40 }, { startedAt: 0, durationMs: 30 }], span, []);
  assert.deepEqual(concurrency(queued), [["A", "unknown"], ["B", "unknown"]]);
  assert.equal(queued.parallel, "batch");
});

test("a simultaneous running observation remains parallel evidence after both Makers finish", () => {
  const call = { type: "toolCall", toolCallId: "t1", toolName: "task", input: { tasks: [{ name: "A" }, { name: "B" }] } };
  const spawn = { role: "toolResult", toolCallId: "t1", toolName: "task", timestamp: 0, content: [], details: { progress: [{ index: 0, id: "A" }, { index: 1, id: "B" }] } };
  const running = { role: "toolResult", toolCallId: "w1", toolName: "wait", content: [], details: { jobs: ["A", "B"].map((id) => ({ id, type: "task", status: "running" })) } };
  const done = { role: "toolResult", toolCallId: "w2", toolName: "wait", content: [], details: { jobs: ["A", "B"].map((id) => ({ id, type: "task", status: "completed", durationMs: 40 })) } };
  const results = new Map([spawn, running, done].map((result) => [result.toolCallId, result]));
  const ledger = buildDispatchLedger([{ role: "assistant", content: [call] }, spawn, running, done], results);
  const members = readDispatchMembers(call, spawn);
  const presentations = members.map((member) => presentMaker(member, [], ledger));
  const graph = buildFlowGraph(presentations, members.map((member) => ({ startedAt: ledger.spawnedAt.get(member.key), durationMs: ledger.durations.get(member.key) })), span, []);
  assert.equal(graph.parallel, "observed");
  assert.deepEqual(graph.makers.map((entry) => entry.concurrency), ["overlapped", "overlapped"]);
  assert.deepEqual(graph.makers.map((entry) => entry.liveRunning), [false, false]);
});

test("only simultaneous live snapshots animate parallel branches", () => {

  // Two live snapshots running right now are running at the same time, whatever the record says.
  const live = buildFlowGraph([maker("A", "t1", "running", "live"), maker("B", "t2", "running", "live")], [{ startedAt: null, durationMs: null }, { startedAt: null, durationMs: null }], span, []);
  assert.deepEqual(concurrency(live), [["A", "overlapped"], ["B", "overlapped"]]);
  assert.deepEqual(live.makers.map((entry) => entry.liveRunning), [true, true]);
  // A record that says running is not a live observation.
  const recorded = buildFlowGraph([maker("A", "t1", "running", "record"), maker("B", "t2", "running", "record")], [{ startedAt: null, durationMs: null }, { startedAt: null, durationMs: null }], span, []);
  assert.deepEqual(recorded.makers.map((entry) => entry.liveRunning), [false, false]);
  assert.equal(recorded.parallel, "none");
});

test("changed documents and other changed files become separate output nodes", () => {
  const graph = buildFlowGraph([], [], span, [{ filePath: "/r/lib/a.ts" }, { filePath: "/r/HANDOFF.md" }, { filePath: "/r/doc/notes.txt" }, { filePath: "/r/data.json" }]);
  assert.deepEqual(graph.files.map((file) => file.filePath), ["/r/lib/a.ts", "/r/data.json"]);
  assert.deepEqual(graph.docs.map((file) => file.filePath), ["/r/HANDOFF.md", "/r/doc/notes.txt"]);
});

const stageViews = (statuses, earlier = {}) => Object.entries(statuses).map(([stage, status]) => ({
  stage, status, steps: [], earlier: earlier[stage] ? [{}] : [],
}));

test("replay lights only stages the request actually reached, with the Maker branch after the first edit", () => {
  const stages = stageViews({ investigate: "passed", edit: "done", check: "passed", review: "skipped", commit: "done", ci: "notNeeded", deploy: "waiting" });
  assert.deepEqual(replayBeats(stages, [], true, true), ["investigate", "edit", "branch", "check", "commit", "outputs"]);
  assert.deepEqual(replayBeats(stages, [], false, false), ["investigate", "edit", "check", "commit"]);
});

test("replay walks the earlier attempt up to the failing stage, draws the return, then replays the current attempt from edit", () => {
  // Review findings sent the work back; check ran in both attempts, review passed on the second.
  const stages = stageViews(
    { investigate: "passed", edit: "done", check: "passed", review: "passed", commit: "done", ci: "passed", deploy: "waiting" },
    { edit: true, check: true, review: true },
  );
  assert.deepEqual(
    replayBeats(stages, [{ from: "review", attempt: 1 }], true, true),
    ["investigate", "edit", "branch", "check", "review", "return", "edit", "check", "review", "commit", "ci", "outputs"],
  );
});

test("a branch without a Main edit sits before the stage it merges into", () => {
  const stages = stageViews({ investigate: "passed", edit: "waiting", check: "passed", review: "waiting", commit: "waiting", ci: "waiting", deploy: "waiting" });
  assert.deepEqual(replayBeats(stages, [], true, false), ["investigate", "branch", "check"]);
});
