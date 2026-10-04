import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildDispatchLedger,
  collectDockMakers,
  placeCompactedDispatch,
  placeDispatchCards,
  presentMaker,
  readDispatchMembers,
  withCompactedWork,
} = await jiti.import("./dispatch.ts");
const { buildSessionContext } = await jiti.import("../session-reader.ts");
const { buildTranscriptRenderPlan, partitionTranscriptPlan } = await jiti.import("../transcript-plan.ts");

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

function dock(messages, { subagents = [], busy = false, slots = new Map() } = {}) {
  const toolResults = new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  return collectDockMakers(messages, toolResults, slots, subagents, buildDispatchLedger(messages, toolResults), busy);
}
const liveRun = (id, parentToolCallId, status = "running") => ({ id, index: 0, agent: "maker", agentSource: "user", status, parentToolCallId, lastUpdate: 1 });

test("the dock counts a finished Maker of the latest turn as awaiting Main's verdict and points at its card", () => {
  const { messages } = session();
  const slots = new Map([[4, { calls: [messages[11].content[0]], placement: "before" }]]);
  const summary = dock(messages, { slots });
  // MemorySync는 옛 턴이고 수용됐고, DeployFix는 실행 상태 미관측이라 올라오지 않는다.
  assert.deepEqual([summary.running, summary.awaiting], [0, 1]);
  assert.equal(summary.target.maker.member.agentId, "DocsFix");
  assert.equal(summary.target.position, 4);
});

test("a recorded verdict takes the Maker off the dock", () => {
  const { messages } = session();
  assert.equal(dock([...messages, verdictResult("toolu_B", 1, "held", 1, "재발주 검토")]), null);
});

test("record-only running counts only while Main still runs the latest turn; live running counts in any turn", () => {
  const messages = [
    user("작업"),
    assistant(taskCall("toolu_R", ["Runner"])),
    spawnResult("toolu_R", ["Runner"]),
    waitResult([{ id: "Runner", type: "task", status: "running" }]),
  ];
  assert.equal(dock(messages, { busy: false }), null);
  assert.equal(dock(messages, { busy: true }).running, 1);
  const later = [...messages, user("다음 질문")];
  // 다음 턴으로 넘어가면 기록만 남은 실행 중은 낡은 상태일 수 있어 빠지고, 실시간 관측은 남는다.
  assert.equal(dock(later, { busy: true }), null);
  const live = dock(later, { subagents: [liveRun("Runner", "toolu_R")] });
  assert.deepEqual([live.running, live.awaiting], [1, 0]);
  assert.equal(live.target.position, null);
});

test("a finished Maker of an earlier turn without a verdict leaves the dock once the user moves on", () => {
  const { messages } = session();
  assert.equal(dock([...messages, user("다른 얘기")]), null);
});

// --- 압축 뒤: 저장 기록(JSONL entry) 모양 그대로 세션을 만들고 화면이 쓰는 계산을 그대로 돌린다. ---
let clock = 0;
const at = () => new Date(Date.UTC(2026, 9, 4, 0, 0, clock++)).toISOString();
const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp: at(), message });
const said = (id, parentId, value) => entry(id, parentId, { role: "user", content: value });
const answered = (id, parentId, value) => entry(id, parentId, assistant(text(value)));
const dispatched = (id, parentId, callId, names) => entry(id, parentId, assistant({
  type: "toolCall",
  id: callId,
  name: "task",
  arguments: { tasks: names.map((name) => ({ name, agent: "maker", task: assignment(`${name} 작업`) })) },
}));
const spawned = (id, parentId, callId, names) => entry(id, parentId, spawnResult(callId, names));
const waited = (id, parentId, jobs) => entry(id, parentId, waitResult(jobs));
const judged = (id, parentId, callId, verdict) => entry(id, parentId, verdictResult(callId, 0, verdict, 1, "검수 완료"));
const compaction = (id, parentId, firstKeptEntryId) => ({ type: "compaction", id, parentId, timestamp: at(), summary: "이전 작업 요약", firstKeptEntryId, tokensBefore: 1000 });

function screen(entries, { busy = false, leafId, subagents = [] } = {}) {
  const context = buildSessionContext(entries, leafId);
  const { main } = partitionTranscriptPlan(context.messages, buildTranscriptRenderPlan(context.messages, { sessionBusy: busy }));
  const compacted = context.compactedWork?.messages ?? [];
  const work = withCompactedWork(compacted, context.messages);
  const toolResults = new Map(work.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
  const slots = placeDispatchCards(main, context.messages, compacted);
  const atCompaction = placeCompactedDispatch(main, context.messages, compacted);
  const ledger = buildDispatchLedger(work, toolResults);
  const cardCalls = [...[...slots.values()].flatMap((slot) => slot.calls), ...(atCompaction?.calls ?? [])].map((call) => call.toolCallId);
  const makersOf = (callId) => {
    const call = [...[...slots.values()].flatMap((slot) => slot.calls), ...(atCompaction?.calls ?? [])].find((c) => c.toolCallId === callId);
    return (readDispatchMembers(call, toolResults.get(callId)) ?? []).map((member) => presentMaker(member, subagents, ledger));
  };
  return {
    context,
    main,
    slots,
    atCompaction,
    cardCalls,
    makersOf,
    dock: collectDockMakers(work, toolResults, slots, subagents, ledger, busy, atCompaction),
  };
}

// 턴 중간 자동 압축: 발주·spawn은 가려지고 wait부터 남은 채 Main이 이어서 검수한다.
function midTurnCompaction() {
  return [
    said("u1", null, "메모리 동기화 고쳐"),
    dispatched("a1", "u1", "toolu_A", ["MemorySync"]),
    spawned("r1", "a1", "toolu_A", ["MemorySync"]),
    waited("w1", "r1", [{ id: "MemorySync", type: "task", status: "running" }]),
    waited("w2", "w1", [{ id: "MemorySync", type: "task", status: "completed" }]),
    compaction("cmp", "w2", "w2"),
    answered("a2", "cmp", "결과를 검수하고 있습니다."),
  ];
}

test("after a mid-turn compaction the hidden dispatch keeps its card, run state and dock line without the old body", () => {
  const view = screen(midTurnCompaction());
  // 화면 transcript에는 발주 원문도 spawn도 없다 — 가려진 기록만 원장에 이어진다.
  assert.deepEqual(view.context.entryIds, ["w2", "cmp", "a2"]);
  assert.equal(JSON.stringify(view.context.compactedWork).includes("PRIMARY_DELIVERABLE"), false);
  const answerAt = view.main.findIndex((item) => item.kind === "answer");
  assert.deepEqual(view.slots.get(answerAt).calls.map((call) => call.toolCallId), ["toolu_A"]);
  assert.equal(view.atCompaction, null);
  const [maker] = view.makersOf("toolu_A");
  assert.deepEqual([maker.title, maker.run, maker.runSource, maker.verdict], ["MemorySync 작업", "completed", "record", null]);
  assert.deepEqual([view.dock.running, view.dock.awaiting, view.dock.target.position], [0, 1, answerAt]);
});

test("a verdict recorded after the compaction updates the hidden dispatch and takes it off the dock", () => {
  const entries = [...midTurnCompaction(), judged("v1", "a2", "toolu_A", "accepted")];
  const view = screen(entries);
  assert.equal(view.makersOf("toolu_A")[0].verdict.verdict, "accepted");
  assert.equal(view.dock, null);
});

test("a hidden dispatch with no recorded run is never shown as running, and a live snapshot still wins", () => {
  const entries = [
    said("u1", null, "배포 고쳐"),
    dispatched("a1", "u1", "toolu_D", ["DeployFix"]),
    spawned("r1", "a1", "toolu_D", ["DeployFix"]),
    answered("a2", "r1", "맡겼습니다."),
    compaction("cmp", "a2", "a2"),
    answered("a3", "cmp", "계속 기다립니다."),
  ];
  const quiet = screen(entries, { busy: true });
  assert.equal(quiet.makersOf("toolu_D")[0].run, "unobserved");
  assert.equal(quiet.dock, null);
  const live = screen(entries, { busy: true, subagents: [liveRun("DeployFix", "toolu_D")] });
  assert.equal(live.dock.running, 1);
});

test("a wholly hidden turn whose kept history starts with a user turn and has no answer yet shows its card at the compaction point", () => {
  const entries = [
    said("u1", null, "메모리 동기화 고쳐"),
    dispatched("a1", "u1", "toolu_A", ["MemorySync"]),
    spawned("r1", "a1", "toolu_A", ["MemorySync"]),
    judged("v1", "r1", "toolu_A", "accepted"),
    answered("a2", "v1", "수용했습니다."),
    said("u2", "a2", "다음 작업"),
    compaction("cmp", "u2", "u2"),
  ];
  const view = screen(entries, { busy: true });
  assert.deepEqual(view.context.entryIds, ["u2", "cmp"]);
  assert.equal(view.slots.size, 0);
  assert.deepEqual(view.atCompaction.calls.map((call) => call.toolCallId), ["toolu_A"]);
  // compaction 메시지 뒤 대화 항목이 없으므로 대화 끝에 그리고, dock은 마지막 항목으로 간다.
  assert.deepEqual([view.atCompaction.position, view.atCompaction.jumpTo], [view.main.length, view.main.length - 1]);
  assert.equal(view.makersOf("toolu_A")[0].verdict.verdict, "accepted");

  // 압축 뒤 답변이 생기면 카드는 그 답변이 아니라 여전히 compaction 지점(그 답변 앞)에 한 번만 있다.
  const later = screen([...entries, answered("a3", "cmp", "다음 작업을 시작합니다.")]);
  const answerAt = later.main.findIndex((item) => item.kind === "answer");
  assert.equal(later.atCompaction.position, answerAt);
  assert.deepEqual(later.cardCalls, ["toolu_A"]);
});

test("a dispatch made after the compaction keeps its card once the turn settles", () => {
  const entries = [
    ...midTurnCompaction(),
    dispatched("a3", "a2", "toolu_B", ["DocsFix"]),
    spawned("r3", "a3", "toolu_B", ["DocsFix"]),
    answered("a4", "r3", "문서도 맡겼습니다."),
  ];
  // 실행 중 꼬리는 마지막 user를, 끝난 턴의 답변은 compaction 요약을 anchor로 든다. 둘 다 카드가 있어야 한다.
  for (const busy of [true, false]) {
    const view = screen(entries, { busy });
    assert.deepEqual(view.cardCalls.sort(), ["toolu_A", "toolu_B"], `busy=${busy}`);
  }
});

test("the selected branch reads only its own hidden work", () => {
  const entries = [
    said("u1", null, "시작"),
    dispatched("a1", "u1", "toolu_MAIN", ["MainBranch"]),
    spawned("r1", "a1", "toolu_MAIN", ["MainBranch"]),
    answered("a2", "r1", "본가지"),
    compaction("cmp", "a2", "a2"),
    answered("a3", "cmp", "본가지 계속"),
    dispatched("b1", "u1", "toolu_ALT", ["AltBranch"]),
    spawned("br1", "b1", "toolu_ALT", ["AltBranch"]),
    answered("b2", "br1", "다른 가지"),
    compaction("bcmp", "b2", "b2"),
    answered("b3", "bcmp", "다른 가지 계속"),
  ];
  assert.deepEqual(screen(entries, { leafId: "a3" }).cardCalls, ["toolu_MAIN"]);
  assert.deepEqual(screen(entries, { leafId: "b3" }).cardCalls, ["toolu_ALT"]);
  // 압축 전 지점을 고르면 가려진 것이 없어 기존 그대로 보이는 기록만 쓴다.
  const before = screen(entries, { leafId: "a2" });
  assert.equal(before.context.compactedWork, null);
  assert.deepEqual(before.cardCalls, ["toolu_MAIN"]);
});
