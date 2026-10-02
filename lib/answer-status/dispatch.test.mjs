import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildDispatchLedger, placeDispatchCards, presentMaker, readDispatchMembers } = await jiti.import("./dispatch.ts");

// 기록 모양은 실제 Main 세션(01a0e57e…)의 task·wait·routing_verdict 결과와 async-result 통지를 따른다.
const SID = "01a0e57e-ea29-75ac-ad41-0197568b22ee";
const assignment = (title) => [
  "TASK_GUARD:",
  "WORK_CLASS: feature",
  "PRIMARY_DELIVERABLE: 산출물",
  "OWNED_PATHS: lib/",
  `TASK_TITLE: ${title}`,
].join("\n");

const user = (text) => ({ role: "user", content: text });
const assistant = (...content) => ({ role: "assistant", content, model: "m", provider: "p" });
const text = (value) => ({ type: "text", text: value });
const taskCall = (toolCallId, names) => ({
  type: "toolCall",
  toolCallId,
  toolName: "task",
  input: { tasks: names.map((name) => ({ name, agent: "maker", task: assignment(`${name} 작업`) })) },
});
const spawnResult = (toolCallId, names) => ({
  role: "toolResult",
  toolCallId,
  toolName: "task",
  content: [{ type: "text", text: "Spawned" }],
  details: { progress: names.map((id, index) => ({ index, id, agent: "maker", status: "pending", task: `Complete assignment thoroughly:\n\n${assignment(`${id} 작업`)}` })) },
});
const verdictResult = (toolCallId, index, verdict, attempt, reason) => ({
  role: "toolResult",
  toolCallId: `v-${toolCallId}-${attempt}-${verdict}`,
  toolName: "routing_verdict",
  content: [{ type: "text", text: "{}" }],
  details: { ok: true, record: { type: "verdict", assignmentId: `${SID}#${toolCallId}#${index}`, attempt, verdict, reason } },
});
const waitResult = (jobs) => ({ role: "toolResult", toolCallId: `w-${Math.random()}`, toolName: "wait", content: [], details: { op: "wait", jobs } });

function session() {
  const messages = [
    user("메모리 동기화 고쳐"),
    assistant(text("메이커에게 맡깁니다."), taskCall("toolu_A", ["MemorySync"])),
    spawnResult("toolu_A", ["MemorySync"]),
    waitResult([{ id: "MemorySync", type: "task", status: "running" }]),
    waitResult([{ id: "MemorySync", type: "task", status: "completed" }]),
    verdictResult("toolu_A", 0, "rework", 1, "경계 보완"),
    verdictResult("toolu_A", 0, "accepted", 2, "회귀 확인"),
    assistant(text("수용했습니다.")),
    user("배포 경로도"),
    assistant(taskCall("toolu_REJECTED", ["DeployFix"])),
    { role: "toolResult", toolCallId: "toolu_REJECTED", toolName: "task", isError: true, content: [{ type: "text", text: "[SideQuestGuard] 거절" }] },
    assistant(taskCall("toolu_B", ["DeployFix", "DocsFix"])),
    spawnResult("toolu_B", ["DeployFix", "DocsFix"]),
    { role: "custom", customType: "async-result", display: true, content: '<system-notice>\n<task-result id="DocsFix" agent="maker" status="failed" duration="1m">' },
    assistant(text("둘 다 발주했습니다.")),
  ];
  const toolResults = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  return { messages, toolResults };
}

function makers(callId, subagents = []) {
  const { messages, toolResults } = session();
  const ledger = buildDispatchLedger(messages, toolResults);
  const call = messages.flatMap((m) => (m.role === "assistant" ? m.content : [])).find((b) => b.toolCallId === callId);
  return (readDispatchMembers(call, toolResults.get(callId)) ?? []).map((member) => presentMaker(member, subagents, ledger));
}

test("the latest routing_verdict for the assignment is Main's verdict, separate from the run state", () => {
  const [maker] = makers("toolu_A");
  assert.equal(maker.title, "MemorySync 작업");
  assert.equal(maker.run, "completed");
  assert.equal(maker.runSource, "record");
  assert.deepEqual([maker.verdict.verdict, maker.verdict.attempt, maker.verdict.reason], ["accepted", 2, "회귀 확인"]);
});

test("a finished Maker with no recorded verdict stays unreviewed, never accepted", () => {
  const [deploy, docs] = makers("toolu_B");
  assert.equal(deploy.verdict, null);
  assert.equal(deploy.run, "unobserved");
  assert.equal(docs.run, "failed");
  assert.equal(docs.verdict, null);
});

test("a rejected task call spawned nobody and has no Maker rows", () => {
  const { toolResults } = session();
  assert.equal(readDispatchMembers(taskCall("toolu_REJECTED", ["DeployFix"]), toolResults.get("toolu_REJECTED")), null);
});

test("a live snapshot of this dispatch wins and exposes its current step and model", () => {
  const [deploy] = makers("toolu_B", [{
    id: "DeployFix",
    index: 0,
    agent: "maker",
    agentSource: "user",
    status: "running",
    parentToolCallId: "toolu_B",
    lastUpdate: 1,
    assignment: assignment("배포 경로 수정"),
    progress: { lastIntent: "Reading deploy script", currentTool: "read", resolvedModel: "anthropic/claude-opus-5-5" },
  }, {
    // 같은 이름의 다른 발주 스냅샷은 이 행에 섞이지 않는다.
    id: "DocsFix", index: 1, agent: "maker", agentSource: "user", status: "completed", parentToolCallId: "toolu_OTHER", lastUpdate: 1,
  }]);
  assert.equal(deploy.title, "배포 경로 수정");
  assert.equal(deploy.run, "running");
  assert.equal(deploy.runSource, "live");
  assert.equal(deploy.stage, "Reading deploy script · read");
  assert.equal(deploy.model.modelShort, "claude-opus-5-5");
  const docs = makers("toolu_B", [{ id: "DocsFix", index: 1, agent: "maker", agentSource: "user", status: "completed", parentToolCallId: "toolu_OTHER", lastUpdate: 1 }])[1];
  assert.equal(docs.run, "failed");
});

test("a dispatch without its spawn result yet is shown as dispatching", () => {
  const ledger = buildDispatchLedger([], new Map());
  const [member] = readDispatchMembers(taskCall("toolu_PENDING", ["Later"]), undefined);
  assert.equal(presentMaker(member, [], ledger).run, "dispatching");
});

test("cards sit in the answer nearest to the task call within the same turn", () => {
  const { messages } = session();
  const main = [
    { kind: "message", idx: 0 },
    { kind: "answer", anchorIdx: 0, idx: 1, runIndex: 0, blocks: [], precedingBlocks: [] },
    { kind: "answer", anchorIdx: 0, idx: 7, runIndex: 0, blocks: [], precedingBlocks: [] },
    { kind: "message", idx: 8 },
    { kind: "answer", anchorIdx: 8, idx: 14, runIndex: 0, blocks: [], precedingBlocks: [] },
  ];
  const slots = placeDispatchCards(main, messages);
  // 텍스트와 같은 메시지의 호출 → 그 답변 뒤. 답변보다 먼저 나온 호출(거절 포함) → 그 턴 첫 답변 앞.
  assert.equal(slots.get(1).placement, "after");
  assert.deepEqual(slots.get(1).calls.map((call) => call.toolCallId), ["toolu_A"]);
  assert.equal(slots.has(2), false);
  assert.equal(slots.get(4).placement, "before");
  assert.deepEqual(slots.get(4).calls.map((call) => call.toolCallId), ["toolu_REJECTED", "toolu_B"]);
});
test("a live snapshot without its assignment text keeps the spawn's TASK_TITLE", () => {
  const docs = makers("toolu_B", [{ id: "DocsFix", index: 1, agent: "maker", agentSource: "user", status: "running", parentToolCallId: "toolu_B", lastUpdate: 1 }])[1];
  assert.equal(docs.run, "running");
  assert.equal(docs.title, "DocsFix 작업");
});

