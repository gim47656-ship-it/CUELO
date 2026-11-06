import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./memory-trace.ts");
}

const CWD = "/work/proj";
let clock = Date.parse("2026-11-06T00:00:00.000Z");
const at = () => new Date((clock += 1000)).toISOString();
const line = (value) => JSON.stringify(value);

const header = () => line({ type: "session", id: "s1", timestamp: at(), cwd: CWD });
const user = (id, text, extra = {}) => line({ type: "message", id, timestamp: at(), message: { role: "user", content: [{ type: "text", text }], attribution: "user", ...extra } });
const developer = (id, text) => line({ type: "message", id, timestamp: at(), message: { role: "developer", content: [{ type: "text", text }], attribution: "agent" } });
const assistant = (id, calls) => line({
  type: "message",
  id,
  timestamp: at(),
  message: { role: "assistant", content: calls.map(([callId, name, args]) => ({ type: "toolCall", id: callId, name, arguments: args })) },
});
const toolResult = (id, callId, text) => line({ type: "message", id, timestamp: at(), message: { role: "toolResult", toolCallId: callId, content: [{ type: "text", text }] } });
const memoryRecall = (id, memories) => line({ type: "custom", customType: "memory_recall", id, timestamp: at(), data: { version: 1, scope: "x", text: "", memories } });
const mnemopiRecall = (id, ids) => line({ type: "custom", customType: "mnemopi-recall", id, timestamp: at(), data: { ids } });
const customMessage = (id, customType, content) => line({ type: "custom_message", customType, id, timestamp: at(), content, display: false });

const A = "aaaaaaaaaaaaaaa1";
const B = "bbbbbbbbbbbbbbb2";
const C = "ccccccccccccccc3";
const D = "ddddddddddddddd4";

const JEV = [
  "[JevRuntime:memory-application] 이번 요청 전에 전달된 기억을 JEV가 대조했다.",
  `- 관련되나 조건 불충족·예외(적용하지 않는다면 그 이유를 판단에 남긴다): ${A}, ${B}`,
  `- 적용(그대로 따른다): ${C}`,
  "판정 불명 1개, 무관 5개.",
].join("\n");

const DOCMAP = [
  "[문서 지도 후보] 아래는 질문과 맞을 수 있는 작업 기록 후보다.",
  "1. doc/history/2026/11/06-x/main.md (STATUS: partial)",
  "   지도: 11-06 실험 기록",
  "   SCOPE: 실험 플러그인",
  "   구간: ## 머리말 (L1-75)",
  "2. doc/history/2026/10/01-y/main.md (STATUS: accepted)",
  "   지도: 10-01 다른 기록",
].join("\n");

const EDIT_LESSONS = [
  "[edit-lessons] /work/proj/lib/plc.ts에 묶인 기억 1건. 단서일 뿐이다.",
  `- PLC 재연결은 선형 백오프로 한다. (id: ${D}, 2026-11-01)`,
].join("\n");

// 공개 미러의 비밀 패턴 검사에 걸리지 않도록 가짜 키는 실행 중에 이어 붙인다.
const FAKE_KEY = ["sk", "ant", "api03", "A".repeat(44)].join("-");

function fixture() {
  return [
    header(),
    // 요청 1: 회상이 사용자 메시지보다 먼저 기록된다.
    mnemopiRecall("r1", [A, B, C]),
    memoryRecall("r2", [{ id: A, text: "기억 A 글" }, { id: B, text: `기억 B 글 token=${FAKE_KEY}` }, { id: C, text: "기억 C 글" }]),
    user("u1", "첫 요청"),
    customMessage("d1", "docmap-route", DOCMAP),
    customMessage("j1", "jev-runtime-advisory", JEV),
    assistant("a1", [
      ["c1", "read", { path: "doc/history/2026/11/06-x/main.md:1-75" }],
      ["c2", "read", { path: `${CWD}/HANDOFF.md:15:raw` }],
      ["c3", "read", { path: "lib/plc.ts" }],
      ["c4", "write", { path: "xd://recall", content: JSON.stringify({ query: "재연결 결정" }) }],
      ["c5", "read", { path: `memory://${D}` }],
    ]),
    toolResult("t3", "c3", "irrelevant"),
    toolResult("t4", "c4", `Found 1 relevant memories:\n\n- [coding-agent-learn] 재연결 결정 기록\n두 줄째 (id: ${D}) c:0.8`),
    developer("e1", EDIT_LESSONS),
    // 진행 중 요청에서 assistant 뒤에 기록된 회상은 다음 요청이 아니라 이 요청의 것이다.
    mnemopiRecall("r3", [D]),
    assistant("a2", [["c6", "learn", { memory: "새 교훈 본문", context: "x" }]]),
    customMessage("s1", "autolearn-saved", "[교훈 자동 저장] 1건\n- 교훈: 자동 저장된 교훈"),
    // synthetic·agent 사용자 메시지는 요청 경계가 아니다.
    user("u-syn", "synthetic", { synthetic: true }),
    user("u-agent", "agent attributed", { attribution: "agent" }),
    // 요청 2: 회상이 먼저 오고 다른 기록이 끼어도 사용자 메시지에 붙는다.
    mnemopiRecall("r4", [B]),
    line({ type: "thinking_level_change", id: "tl", timestamp: at() }),
    user("u2", "두 번째 요청"),
    customMessage("j2", "jev-runtime-advisory", `[JevRuntime:memory-application] x\n- 무관하지 않음: ${B}\n판정 불명 0개, 무관 0개.`),
  ];
}

test("회상은 다음 실제 사용자 요청에 붙고, 진행 중 회상은 그 요청에 남는다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const trace = buildMemoryTrace("s1", fixture());
  assert.deepEqual(trace.requests.map((request) => request.entryId), ["u1", "u2"]);
  const [first, second] = trace.requests;
  const recalls1 = first.steps.filter((step) => step.kind === "recall");
  assert.equal(recalls1.length, 1, "memory_recall과 mnemopi-recall은 한 단계로 합친다");
  assert.deepEqual(recalls1[0].memories.map((memory) => memory.id), [A, B, C, D]);
  assert.equal(recalls1[0].memories[0].preview, "기억 A 글");
  const recalls2 = second.steps.filter((step) => step.kind === "recall");
  assert.deepEqual(recalls2.map((step) => step.memories.map((memory) => memory.id)), [[B]]);
  assert.equal(recalls2[0].memories[0].preview.startsWith("기억 B 글"), true, "id만 남은 회상도 세션 안 글로 채운다");
  assert.equal(second.steps.some((step) => step.kind === "saved"), false);
});

test("JEV 판정 줄의 id와 판정 불명·무관 수를 모두 남긴다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const [first, second] = buildMemoryTrace("s1", fixture()).requests;
  const jev = first.steps.find((step) => step.kind === "jev");
  assert.deepEqual(jev.buckets.map((bucket) => [bucket.shortLabel, bucket.ids]), [
    ["관련되나 조건 불충족·예외", [A, B]],
    ["적용", [C]],
  ]);
  assert.equal(jev.buckets[0].label, "관련되나 조건 불충족·예외(적용하지 않는다면 그 이유를 판단에 남긴다)");
  assert.equal(jev.unknownCount, 1);
  assert.equal(jev.unrelatedCount, 5);
  assert.deepEqual(second.steps.find((step) => step.kind === "jev").buckets[0].ids, [B]);
});

test("지도 후보는 같은 요청에서 열었는지 표시하고, 연 문서는 선택자를 떼고 cwd 기준으로 적는다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const [first] = buildMemoryTrace("s1", fixture()).requests;
  const docmap = first.steps.find((step) => step.kind === "docmap");
  assert.deepEqual(docmap.candidates.map((item) => [item.path, item.status, item.opened]), [
    ["doc/history/2026/11/06-x/main.md", "partial", true],
    ["doc/history/2026/10/01-y/main.md", "accepted", false],
  ]);
  assert.equal(docmap.candidates[0].scope, "실험 플러그인");
  const reads = first.steps.filter((step) => step.kind === "doc-read");
  assert.deepEqual(reads.map((step) => [step.path, step.selector, step.candidate]), [
    ["doc/history/2026/11/06-x/main.md", "1-75", true],
    ["HANDOFF.md", "15:raw", false],
  ]);
});

test("편집 전 교훈·명시 회상·저장을 요청 안 순서대로 읽고 비밀을 가린다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const trace = buildMemoryTrace("s1", fixture());
  const [first] = trace.requests;
  const lesson = first.steps.find((step) => step.kind === "edit-lesson");
  assert.equal(lesson.file, "lib/plc.ts");
  assert.deepEqual(lesson.memories.map((memory) => [memory.id, memory.date]), [[D, "2026-11-01"]]);
  const explicit = first.steps.filter((step) => step.kind === "explicit-recall");
  assert.deepEqual(explicit.map((step) => [step.target, step.query, step.memories.map((memory) => memory.id)]), [
    ["xd://recall", "재연결 결정", [D]],
    [`memory://${D}`, null, [D]],
  ]);
  assert.equal(explicit[0].memories[0].preview, "재연결 결정 기록 두 줄째");
  assert.deepEqual(first.steps.filter((step) => step.kind === "saved").map((step) => [step.source, step.text]), [
    ["learn", "새 교훈 본문"],
    ["autolearn", "자동 저장된 교훈"],
  ]);
  assert.equal(JSON.stringify(trace).includes(FAKE_KEY), false);
});

test("그래프는 요청·기억·문서·파일을 잇고 열어 본 후보는 후보 선을 남기지 않는다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const { requestNodeId, memoryNodeId, docNodeId, fileNodeId } = await import("./memory-trace-types.ts");
  const trace = buildMemoryTrace("s1", fixture());
  const has = (from, to, kind) => trace.edges.some((edge) => edge.from === from && edge.to === to && edge.kind === kind);
  const req = requestNodeId("u1");
  assert.equal(has(req, memoryNodeId(A), "recalled"), true);
  assert.equal(has(req, docNodeId("doc/history/2026/11/06-x/main.md"), "opened"), true);
  assert.equal(has(req, docNodeId("doc/history/2026/11/06-x/main.md"), "candidate"), false);
  assert.equal(has(req, docNodeId("doc/history/2026/10/01-y/main.md"), "candidate"), true);
  assert.equal(has(fileNodeId("lib/plc.ts"), memoryNodeId(D), "lesson"), true);
  assert.equal(has(requestNodeId("u2"), memoryNodeId(B), "recalled"), true);
  const ids = new Set(trace.nodes.map((node) => node.id));
  for (const edge of trace.edges) assert.equal(ids.has(edge.from) && ids.has(edge.to), true);
});

test("읽기 선택자는 스킴 콜론을 남기고 끝의 줄 지정만 뗀다", async () => {
  const { splitReadSelector, isDocMapPath } = await loadSubject();
  assert.deepEqual(splitReadSelector("rule://frontend"), { path: "rule://frontend", selector: null });
  assert.deepEqual(splitReadSelector("skill://hallmark:1-40"), { path: "skill://hallmark", selector: "1-40" });
  assert.deepEqual(splitReadSelector("lib/a.ts:8,56"), { path: "lib/a.ts", selector: "8,56" });
  assert.equal(isDocMapPath("Tools/X/HANDOFF.md"), true);
  assert.equal(isDocMapPath("docs/harness.md"), false);
});

test("세션 끝에 남은 회상은 앞 요청에 붙이지 않고 다음 요청을 기다린다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const head = [header(), user("u1", "first"), mnemopiRecall("r1", [A])];
  const before = buildMemoryTrace("s1", head);
  assert.equal(before.requests[0].steps.some((step) => step.kind === "recall"), false);
  const after = buildMemoryTrace("s1", [...head, user("u2", "second")]);
  assert.deepEqual(after.requests[1].steps.find((step) => step.kind === "recall").memories.map((memory) => memory.id), [A]);
});

test("role·toolCallId가 긴 content 뒤에 있어도 회상 결과를 읽는다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const result = JSON.stringify({
    type: "message",
    id: "t1",
    timestamp: at(),
    message: { content: [{ type: "text", text: `${" ".repeat(700)}\n- hit (id: ${A})` }], role: "toolResult", toolCallId: "c1" },
  });
  const trace = buildMemoryTrace("s1", [header(), user("u1", "q"), assistant("a1", [["c1", "recall", { query: "hit" }]]), result]);
  const explicit = trace.requests[0].steps.find((step) => step.kind === "explicit-recall");
  assert.deepEqual(explicit.memories.map((memory) => memory.id), [A]);
});

test("지도 후보와 읽은 경로는 같은 기준으로 맞추고, 이름 규칙 밖의 후보를 읽어도 연 문서로 센다", async () => {
  const { buildMemoryTrace } = await loadSubject();
  const route = "[문서 지도 후보] x\n1. ./HANDOFF.md\n2. docs/architecture.md";
  const trace = buildMemoryTrace("s1", [
    header(),
    user("u1", "q"),
    customMessage("d1", "docmap-route", route),
    assistant("a1", [["c1", "read", { path: "./HANDOFF.md:1-5" }], ["c2", "read", { path: `${CWD}/docs/architecture.md:1-75` }]]),
  ]);
  const [request] = trace.requests;
  assert.deepEqual(request.steps.find((step) => step.kind === "docmap").candidates.map((item) => [item.path, item.opened]), [
    ["HANDOFF.md", true],
    ["docs/architecture.md", true],
  ]);
  assert.deepEqual(request.steps.filter((step) => step.kind === "doc-read").map((step) => [step.path, step.selector, step.candidate]), [
    ["HANDOFF.md", "1-5", true],
    ["docs/architecture.md", "1-75", true],
  ]);
});
