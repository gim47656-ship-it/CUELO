import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectTurnBlocks, layoutMakerBars, placeTurnSummaries, summarizeFinishedTurns, summarizeTurn } = await jiti.import("./turn-summary.ts");
const { buildTranscriptRenderPlan, partitionTranscriptPlan } = await jiti.import("../transcript-plan.ts");

const call = (toolCallId, toolName, input) => ({ type: "toolCall", toolCallId, toolName, input });
const result = (toolCallId, toolName, textValue, details, isError = false) => ({
  role: "toolResult", toolCallId, toolName, isError, details, content: [{ type: "text", text: textValue }],
});

test("summarizes the files written and the check commands actually run, with their verdicts", () => {
  const blocks = [
    call("w", "write", { path: "src/a.ts" }),
    call("e", "edit", { path: "src/b.ts" }),
    call("ok", "bash", { command: "bun run typecheck" }),
    call("masked", "bash", { command: "bun run typecheck 2>&1 | tail -5" }),
    call("bad", "bash", { command: "bun test lib/x.test.mjs" }),
    call("plain", "bash", { command: "git status --short" }),
    call("ci", "bash", { command: "gh run list --workflow \"Verify build\" --limit 1" }),
    call("bg", "bash", { command: "bun run build" }),
    call("noexit", "bash", { command: "bunx eslint components" }),
    call("crash", "bash", { command: "bun run lint" }),
  ];
  const toolResults = new Map([
    ["w", result("w", "write", "ok")],
    ["e", result("e", "edit", "ok", undefined, true)],
    ["ok", result("ok", "bash", "Command exited with code 0", { exitCode: 0 })],
    ["masked", result("masked", "bash", "Command exited with code 0", { exitCode: 0 })],
    ["bad", result("bad", "bash", "1 fail\n\nCommand exited with code 1")],
    ["plain", result("plain", "bash", "Command exited with code 0", { exitCode: 0 })],
    ["ci", result("ci", "bash", "Command exited with code 0", { exitCode: 0 })],
    ["bg", result("bg", "bash", "Backgrounded as job bg_3")],
    ["crash", result("crash", "bash", "spawn failed", undefined, true)],
  ]);
  const summary = summarizeTurn(blocks, toolResults, "D:/repo");
  assert.deepEqual(summary.files.map((file) => file.filePath), ["D:/repo/src/a.ts"]);
  // A shell that exits 0 after `| tail` says nothing about the typecheck, and CI commands are not checks.
  assert.deepEqual(summary.checks.map((check) => [check.command, check.state, check.exitCode]), [
    ["bun run typecheck", "passed", 0],
    ["bun run typecheck 2>&1 | tail -5", "unverified", 0],
    ["bun test lib/x.test.mjs", "failed", 1],
    ["bun run build", "unobserved", null],
    ["bunx eslint components", "unobserved", null],
    ["bun run lint", "failed", null],
  ]);
});

test("collects the turn's dispatches and skips the turn still running", () => {
  const messages = [
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "text", text: "x" }, call("t", "task", { tasks: [] })], model: "m", provider: "p" },
    { role: "assistant", content: [{ type: "text", text: "done" }], model: "m", provider: "p" },
    { role: "user", content: "b" },
    { role: "assistant", content: [{ type: "text", text: "working" }], model: "m", provider: "p" },
  ];
  const main = [
    { kind: "message", idx: 0 },
    { kind: "answer", anchorIdx: 0, idx: 1, runIndex: 0, blocks: [], precedingBlocks: [] },
    { kind: "answer", anchorIdx: 0, idx: 2, runIndex: 0, blocks: [], precedingBlocks: [] },
    { kind: "message", idx: 3 },
    { kind: "answer", anchorIdx: 3, idx: 4, runIndex: 0, blocks: [], precedingBlocks: [] },
  ];
  const settled = placeTurnSummaries(main, messages, null);
  assert.deepEqual([...settled.entries()], [[2, { from: 1, to: 3 }], [4, { from: 4, to: 5 }]]);
  const live = placeTurnSummaries(main, messages, 3);
  assert.deepEqual([...live.keys()], [2]);
  const blocks = collectTurnBlocks(messages, 1, 3);
  assert.deepEqual(summarizeTurn(blocks, new Map()).dispatchCalls.map((block) => block.toolCallId), ["t"]);
});

const todoResult = (toolCallId, phases) => result(toolCallId, "todo", "ok", phases === undefined ? undefined : { phases });

test("remaining items come from the turn's last reported todo list, skipping done and abandoned tasks", () => {
  const blocks = [
    call("t1", "todo", { op: "replace" }),
    call("t2", "todo", { op: "update" }),
    call("t3", "todo", { op: "start" }),
  ];
  const toolResults = new Map([
    ["t1", todoResult("t1", [{ name: "A", tasks: [{ content: "옛 목록", status: "pending" }] }])],
    ["t2", todoResult("t2", [
      { name: "구현", tasks: [{ content: "카드", status: "completed" }, { content: "막대", status: "in_progress" }] },
      { name: "검증", tasks: [{ content: "모바일", status: "blocked", blocker: "브라우저 없음" }, { content: "옛 계획", status: "abandoned" }, { content: "보고", status: "pending" }] },
    ])],
    // 목록을 싣지 않은 결과는 앞 목록을 지우지 않는다.
    ["t3", todoResult("t3", undefined)],
  ]);
  assert.deepEqual(summarizeTurn(blocks, toolResults).remaining, [
    { phase: "구현", content: "막대", status: "in_progress", blocker: null },
    { phase: "검증", content: "모바일", status: "blocked", blocker: "브라우저 없음" },
    { phase: "검증", content: "보고", status: "pending", blocker: null },
  ]);
  assert.equal(summarizeTurn([call("b", "bash", { command: "bun run lint" })], new Map()).remaining, null);
  const cleared = new Map([["t1", todoResult("t1", [{ name: "A", tasks: [{ content: "끝", status: "completed" }] }])]]);
  assert.deepEqual(summarizeTurn([blocks[0]], cleared).remaining, []);
});

test("a todo request whose result has not arrived does not replace the last reported list", () => {
  const blocks = [
    call("t1", "todo", { op: "replace" }),
    call("t2", "todo", { op: "replace", list: [{ phase: "새 계획", items: ["아직 보고 안 됨"] }] }),
  ];
  const toolResults = new Map([["t1", todoResult("t1", [{ name: "A", tasks: [{ content: "보고된 일", status: "pending" }] }])]]);
  assert.deepEqual(summarizeTurn(blocks, toolResults).remaining, [
    { phase: "A", content: "보고된 일", status: "pending", blocker: null },
  ]);
});

test("Maker bars share the turn's time axis, widen it for a run past the turn, and are absent without a recorded start or duration", () => {
  const span = { startedAt: 1_000, endedAt: 11_000 };
  assert.deepEqual(layoutMakerBars(span, [
    { startedAt: 1_000, durationMs: 5_000 },
    { startedAt: 6_000, durationMs: 2_000 },
    { startedAt: null, durationMs: 3_000 },
    { startedAt: 2_000, durationMs: null },
  ]), [{ offset: 0, width: 0.5 }, { offset: 0.5, width: 0.2 }, null, null]);
  assert.deepEqual(layoutMakerBars(span, [{ startedAt: 6_000, durationMs: 15_000 }]), [{ offset: 0.25, width: 0.75 }]);
  assert.deepEqual(layoutMakerBars({ startedAt: null, endedAt: null }, [{ startedAt: 5, durationMs: 0 }]), [{ offset: 0, width: 1 }]);
});

test("only the most recent finished turn is marked latest, and its span runs from the prompt to the last recorded time", () => {
  const messages = [
    { role: "user", content: "a", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "x" }], model: "m", provider: "p", timestamp: 150, completedAt: 400 },
    { role: "user", content: "b", timestamp: 500 },
    { role: "assistant", content: [{ type: "text", text: "y" }], model: "m", provider: "p", timestamp: 550, completedAt: 900 },
    { role: "user", content: "c", timestamp: 1_000 },
    { role: "assistant", content: [{ type: "text", text: "z" }], model: "m", provider: "p", timestamp: 1_050 },
  ];
  const main = [
    { kind: "message", idx: 0 },
    { kind: "answer", anchorIdx: 0, idx: 1, runIndex: 0, blocks: [], precedingBlocks: [] },
    { kind: "message", idx: 2 },
    { kind: "answer", anchorIdx: 2, idx: 3, runIndex: 0, blocks: [], precedingBlocks: [] },
    { kind: "message", idx: 4 },
    { kind: "answer", anchorIdx: 4, idx: 5, runIndex: 0, blocks: [], precedingBlocks: [] },
  ];
  const settled = summarizeFinishedTurns(main, messages, null, new Map());
  assert.deepEqual([...settled].map(([position, summary]) => [position, summary.latest]), [[1, false], [3, false], [5, true]]);
  assert.deepEqual(settled.get(3).span, { startedAt: 500, endedAt: 900 });
  // 마지막 턴이 아직 돌면 그 앞 턴이 가장 나중에 끝난 턴이다.
  const live = summarizeFinishedTurns(main, messages, 4, new Map());
  assert.deepEqual([...live].map(([position, summary]) => [position, summary.latest]), [[1, false], [3, true]]);
});

test("a steering message continues the same request: one card covers both fragments, a follow-up request starts fresh", () => {
  const assistant = (content, timestamp) => ({ role: "assistant", content, model: "m", provider: "p", timestamp });
  const text = (value) => ({ type: "text", text: value });
  const messages = [
    { role: "user", content: "고쳐 줘", timestamp: 100 },
    assistant([call("w", "edit", { path: "/repo/a.ts" }), call("t", "bash", { command: "bun test" })], 110),
    result("w", "edit", "ok"),
    { ...result("t", "bash", "Command exited with code 0", { exitCode: 0 }), timestamp: 130 },
    assistant([text("중간 보고")], 140),
    { role: "user", content: "이것도 같이", steering: true, timestamp: 150 },
    assistant([call("g", "git_finalize", { files: ["a.ts"] })], 160),
    result("g", "git_finalize", "git_finalize failed at fetch", undefined, true),
    assistant([text("커밋 실패")], 180),
    { role: "user", content: "다른 일", timestamp: 200 },
    assistant([call("r", "read", { path: "/repo/b.ts" })], 210),
    result("r", "read", "ok"),
    assistant([text("읽었다")], 230),
  ];
  const { main } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
  const toolResults = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const answers = main.flatMap((item, position) => (item.kind === "answer" ? [[messages[item.idx].content[0].text, position]] : []));
  const at = Object.fromEntries(answers);
  const settled = summarizeFinishedTurns(main, messages, null, toolResults, "/repo");
  assert.deepEqual([...settled.keys()].sort(), [at["커밋 실패"], at["읽었다"]].sort(), "no card after the first fragment");
  const first = settled.get(at["커밋 실패"]);
  const statuses = Object.fromEntries(first.flow.stages.map((view) => [view.stage, view.status]));
  assert.equal(statuses.edit, "done");
  assert.equal(statuses.check, "passed");
  assert.equal(statuses.commit, "failed");
  assert.equal(first.flow.reached, "check", "the earlier fragment's check carries the flow past check");
  assert.equal(statuses.review, "skipped");
  assert.equal(first.flow.next, null, "a finished request names no next stage");
  assert.deepEqual(first.files.map((file) => file.filePath), ["/repo/a.ts"]);
  assert.deepEqual(first.span, { startedAt: 100, endedAt: 180 });
  // The follow-up is its own request: nothing from the first one leaks into it.
  const second = settled.get(at["읽었다"]);
  assert.deepEqual(second.flow.steps.map((step) => step.toolCallId), ["r"]);
  // While the steered request still runs, neither of its fragments is a finished card.
  const live = placeTurnSummaries(main.slice(0, main.findIndex((item) => item.kind === "message" && item.idx === 9)), messages.slice(0, 9), 5);
  assert.equal(live.size, 0);
});
