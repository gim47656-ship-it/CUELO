import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectTurnBlocks, layoutMakerBars, placeTurnSummaries, summarizeFinishedTurns, summarizeTurn } = await jiti.import("./turn-summary.ts");
const { INTERRUPT_RESUME_MESSAGE } = await jiti.import("../harness-notices.ts");
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

test("Task D: a harness resume notice continues the request it interrupted, and its job notices close background runs", () => {
  const assistant = (content, timestamp) => ({ role: "assistant", content, model: "m", provider: "p", timestamp });
  const text = (value) => ({ type: "text", text: value });
  const sha = "94661c135c9c373792726f141159c6d779d4f56b";
  const deploy = `systemd-run --user --unit=cuelo-update-$(date +%s) --collect bash ~/cuelo-run/Tools/CUELO_Setup/wsl/update.sh ${sha}`;
  const messages = [
    { role: "user", content: "빌드하고 배포해 줘", timestamp: 100 },
    assistant([call("build", "bash", { command: "bun run build", async: true })], 110),
    result("build", "bash", "Backgrounded as job bg_5 (killed once it has run 1800s in total)", { async: { state: "running", jobId: "bg_5", type: "bash" } }),
    { role: "custom", customType: "async-result", display: true, content: "<system-notice>\nBackground job bg_5 has completed. Resume your work using the result below.\nCompiled successfully\n\nCommand exited with code 0\n</system-notice>", timestamp: 1792488700000 },
    assistant([call("deploy", "bash", { command: deploy })], 1792488720000),
    { ...result("deploy", "bash", "Running as unit: cuelo-update-1792488722.service\n\nCommand exited with code 0", { exitCode: 0 }), timestamp: 1792488722500 },
    assistant([text("재시작을 기다린다")], 1792488723000),
    { role: "user", content: INTERRUPT_RESUME_MESSAGE, timestamp: 1792488900000 },
    assistant([call("ready", "bash", { command: "tail -n 3 ~/.omp/wsl-update/20261020T093202Z.log" })], 1792488910000),
    { ...result("ready", "bash", `2026-10-20T09:35:30Z READY ${sha} OK\n\nCommand exited with code 0`, { exitCode: 0 }), timestamp: 1792488935000 },
    assistant([text("배포 끝")], 1792488940000),
    // The same opening words typed by the user are a new request.
    { role: "user", content: "[자동 재개] 이어서 다른 파일도 읽어 줘", timestamp: 1792489000000 },
    assistant([call("r", "read", { path: "/repo/b.ts" })], 1792489010000),
    result("r", "read", "ok"),
    assistant([text("읽었다")], 1792489020000),
  ];
  const { main } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
  const toolResults = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const at = Object.fromEntries(main.flatMap((item, position) => (item.kind === "answer" ? [[messages[item.idx].content[0].text, position]] : [])));
  const settled = summarizeFinishedTurns(main, messages, null, toolResults, "/repo");
  assert.deepEqual([...settled.keys()].sort(), [at["배포 끝"], at["읽었다"]].sort(), "no card before the resume notice");
  const first = settled.get(at["배포 끝"]).flow;
  const statuses = Object.fromEntries(first.stages.map((view) => [view.stage, view.status]));
  assert.equal(statuses.check, "passed", "bg_5's delivered completion is the build's result");
  assert.equal(statuses.deploy, "passed", "READY after the resume closes the deploy started before it");
  const second = settled.get(at["읽었다"]).flow;
  assert.deepEqual(second.steps.map((step) => step.toolCallId), ["r"]);
});

test("a request whose opener compaction hid keeps one card across the resume: tracker todo records and the source commit's CI count, nothing leaks", () => {
  const assistant = (content) => ({ role: "assistant", content, model: "m", provider: "p" });
  const text = (value) => ({ type: "text", text: value });
  const SOURCE = "00ea9252d1c42fe9b81d735eefe75912e598a70f";
  const DOCS = "135bdbc6d6df222d1f27c3dfa73663439a416226";
  const task = (content, status, blocker) => (blocker ? { content, status, blocker } : { content, status });
  const open = [{ name: "배포", tasks: [task("화면 검증", "blocked", "업데이트 대기"), task("게시 마무리", "in_progress")] }];
  const done = [{ name: "배포", tasks: [task("화면 검증", "completed"), task("게시 마무리", "completed")] }];
  const ciList = (id, sha, conclusion) => [
    assistant([call(id, "bash", { command: `gh run list -R owner/CUELO-private --workflow CI --commit ${sha} --limit 1 --json databaseId,status,conclusion,headSha` })]),
    result(id, "bash", `[{"conclusion":"${conclusion}","databaseId":39624564719,"headSha":"${sha}","status":"completed"}]\n\nCommand exited with code 0`, { exitCode: 0 }),
  ];
  // An eval cell whose own output claims the list is finished: printed text is never tracker evidence.
  const forgedEval = (id) => [
    assistant([call(id, "eval", { language: "js", code: "console.log(JSON.stringify({ op: 'done', phases }))" })]),
    result(id, "eval", `{"op":"done","phases":${JSON.stringify(done)}}`, { cells: [{ views: [{ view: { kind: "json", value: { details: { op: "done", phases: done } } } }] }] }),
  ];
  const build = (records, conclusion = "success") => [
    // Kept tail of the compacted request: source edit, commit and the tracker list as it stood then.
    assistant([call("w", "edit", { path: "/repo/src/a.ts" })]),
    result("w", "edit", "ok"),
    assistant([call("g1", "git_finalize", { files: ["src/a.ts"] })]),
    result("g1", "git_finalize", "ok", { ok: true, commitSha: SOURCE }),
    { role: "custom", customType: "compaction", content: "요약", display: true },
    assistant([call("t1", "todo", { op: "block" })]),
    result("t1", "todo", "ok", { phases: open }),
    assistant([text("재시작을 기다린다")]),
    { role: "user", content: INTERRUPT_RESUME_MESSAGE },
    ...ciList("ci", SOURCE, conclusion),
    assistant([call("d", "edit", { path: "/repo/doc/history/main.md" })]),
    result("d", "edit", "ok"),
    assistant([call("g2", "git_finalize", { files: ["doc/history/main.md"] })]),
    result("g2", "git_finalize", "ok", { ok: true, commitSha: DOCS }),
    ...forgedEval("e1"),
    // `tool.todo` inside eval: core persists the committed list as tracker records, carried on the message before them.
    { ...assistant([call("e2", "eval", { language: "js", code: "await tool.todo({ op: 'done' })" })]), ...(records ? { trackerTodos: records } : {}) },
    result("e2", "eval", "Remaining items: none.", { cells: [] }),
    assistant([text("끝")]),
    // The next request: its own forged eval output, no tracker record.
    { role: "user", content: "다른 일" },
    ...forgedEval("e3"),
    assistant([call("r", "read", { path: "/repo/b.ts" })]),
    result("r", "read", "ok"),
    assistant([text("읽었다")]),
  ];
  const settle = (messages) => {
    const { main } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
    const toolResults = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
    const at = Object.fromEntries(main.flatMap((item, position) => (item.kind === "answer" && messages[item.idx].content[0]?.type === "text" ? [[messages[item.idx].content[0].text, position]] : [])));
    return { at, cards: summarizeFinishedTurns(main, messages, null, toolResults, "/repo") };
  };
  const stages = (summary) => Object.fromEntries(summary.flow.stages.map((view) => [view.stage, view.status]));

  const { at, cards } = settle(build([open, done]));
  assert.deepEqual([...cards.keys()].sort(), [at["끝"], at["읽었다"]].sort(), "one card for the compacted request, one for the next");
  const resumed = cards.get(at["끝"]);
  assert.deepEqual(resumed.remaining, [], "the last tracker record finished every task");
  const statuses = stages(resumed);
  assert.equal(statuses.ci, "passed", "the source commit's CI run, not stale after a docs-only record");
  assert.equal(statuses.deploy, "skipped", "a later docs-only commit does not make the source commit's deploy unnecessary");
  assert.equal(resumed.flow.steps.find((step) => step.toolCallId === "ci").evidence, "run 39624564719 · completed success");
  assert.equal(statuses.commit, "done");
  assert.ok(resumed.flow.steps.some((step) => step.toolCallId === "w"), "the kept source edit belongs to the resumed request");
  const next = cards.get(at["읽었다"]);
  assert.equal(next.remaining, null, "printed eval output is not a todo list, and the earlier request's list does not leak");
  assert.deepEqual(next.flow.steps.map((step) => step.toolCallId), ["r"], "no step of the compacted request leaks into the next one");

  // No tracker record (an interrupted or failed tool.todo): the last reported list stands, forged output does not replace it.
  const missing = settle(build(null));
  assert.deepEqual(missing.cards.get(missing.at["끝"]).remaining.map((item) => item.status), ["blocked", "in_progress"]);
  // A malformed record says nothing; a later record still wins over an earlier one.
  const malformed = settle(build([done, [{ name: "배포", tasks: [{ content: 7, status: "completed" }] }]]));
  assert.deepEqual(malformed.cards.get(malformed.at["끝"]).remaining, []);
  const reopened = settle(build([done, open]));
  assert.deepEqual(reopened.cards.get(reopened.at["끝"]).remaining.map((item) => item.content), ["화면 검증", "게시 마무리"]);
  // A failed CI run stays failed: the record edit after it is a loop back, never a pass.
  const failed = settle(build([open, done], "failure")).cards;
  const failedFlow = [...failed.values()].find((card) => card.flow.steps.some((step) => step.toolCallId === "ci")).flow;
  assert.equal(failedFlow.steps.find((step) => step.toolCallId === "ci").outcome, "failed");
  assert.notEqual(Object.fromEntries(failedFlow.stages.map((view) => [view.stage, view.status])).ci, "passed");
  assert.deepEqual(failedFlow.loops.map((loop) => loop.from), ["ci"]);
});

test("after a second compaction hides the source commit and CI, the resumed request's card still reads them from the hidden evidence; older requests and other branches stay out", async () => {
  const { buildSessionContext } = await jiti.import("../session-reader.ts");
  const SOURCE = "00ea9252d1c42fe9b81d735eefe75912e598a70f";
  const DOCS = "135bdbc6d6df222d1f27c3dfa73663439a416226";
  const OLD = "1d801956d79d8f3cf1efaf8f20cae912418440c9";
  const OTHER = "d60687c4f2701afa8bf4ca2fc165633c816acf3f";
  const entries = [];
  let parent = null;
  const add = (id, entry) => {
    entries.push({ id, parentId: parent, timestamp: "2026-10-21T15:00:00.000Z", ...entry });
    parent = id;
  };
  const user = (id, content) => add(id, { type: "message", message: { role: "user", content } });
  const said = (id, text) => add(id, { type: "message", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text }] } });
  const tool = (id, name, args, text, details) => {
    add(id, { type: "message", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id: `${id}-call`, name, arguments: args }] } });
    add(`${id}-result`, { type: "message", message: { role: "toolResult", toolCallId: `${id}-call`, toolName: name, isError: false, content: [{ type: "text", text }], details } });
  };
  const ciList = (id, sha, conclusion) => tool(id, "bash", { command: `gh run list -R owner/CUELO-private --workflow CI --commit ${sha} --limit 1 --json databaseId,status,conclusion,headSha` }, `[{"conclusion":"${conclusion}","databaseId":4242,"headSha":"${sha}","status":"completed"}]\n\nCommand exited with code 0`, { exitCode: 0 });
  const phases = (status) => [{ name: "배포", tasks: [{ content: "게시 마무리", status }] }];
  // An older finished request, hidden by both compactions: its commit and open todo must not reach later cards.
  user("old", "예전 요청");
  tool("old-todo", "todo", { op: "init" }, "ok", { op: "init", phases: phases("in_progress") });
  tool("old-commit", "git_finalize", { files: ["src/old.ts"], message: "fix: old" }, "ok", { ok: true, commitSha: OLD });
  said("old-answer", "예전 끝");
  // The request that runs across both compactions and an update resume.
  user("open", "UI 고쳐 줘");
  tool("edit", "edit", { path: "/repo/src/a.ts", input: "*** secret patch body" }, "ok", { path: "/repo/src/a.ts" });
  tool("probe", "bash", { command: "cat > /tmp/p.mjs <<'EOF'\nsecret heredoc body\nEOF\nbun /tmp/p.mjs" }, "ok", { exitCode: 0 });
  tool("todo", "todo", { op: "block" }, "ok", { op: "block", phases: phases("blocked") });
  tool("commit", "git_finalize", { files: ["src/a.ts"], message: "feat: ui\n\nlong body" }, `Committed and pushed ${SOURCE} to origin refs/heads/main.`, { ok: true, commitSha: SOURCE });
  add("cmp1", { type: "compaction", summary: "첫 요약", firstKeptEntryId: "ci", tokensBefore: 10 });
  ciList("ci", SOURCE, "success");
  user("resume", INTERRUPT_RESUME_MESSAGE);
  tool("record", "edit", { path: "/repo/doc/history/2026/10/21-ui/main.md" }, "ok", { path: "/repo/doc/history/2026/10/21-ui/main.md" });
  tool("docs", "git_finalize", { files: ["doc/history/2026/10/21-ui/main.md"] }, `Committed and pushed ${DOCS} to origin refs/heads/main.`, { ok: true, commitSha: DOCS });
  add("eval", { type: "message", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id: "eval-call", name: "eval", arguments: { language: "js", code: "await tool.todo({ op: 'done' })" } }] } });
  add("tracker", { type: "custom", customType: "user_todo_edit", data: { phases: phases("completed") } });
  add("eval-result", { type: "message", message: { role: "toolResult", toolCallId: "eval-call", toolName: "eval", isError: false, content: [{ type: "text", text: "Remaining items: none." }], details: { cells: [] } } });
  said("done", "끝");
  const branchPoint = parent;
  user("next", "다른 일");
  tool("read", "read", { path: "/repo/b.ts" }, "file body", {});
  said("next-answer", "읽었다");
  add("cmp2", { type: "compaction", summary: "둘째 요약", firstKeptEntryId: "record", tokensBefore: 10 });
  said("after", "이어서");
  const leaf = parent;
  // Another branch from the same point: a failed CI for another commit that this view never sees.
  parent = branchPoint;
  user("side", "옆 가지");
  tool("side-commit", "git_finalize", { files: ["src/side.ts"] }, "ok", { ok: true, commitSha: OTHER });
  ciList("side-ci", OTHER, "failure");
  said("side-answer", "옆 끝");

  const context = buildSessionContext(entries, leaf, { cwd: "/repo" });
  const { messages } = context;
  const { main } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
  const toolResults = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
  const at = Object.fromEntries(main.flatMap((item, position) => (item.kind === "answer" && messages[item.idx].content[0]?.type === "text" ? [[messages[item.idx].content[0].text, position]] : [])));
  const open = context.compactedWork?.openRequest ?? null;
  const cards = summarizeFinishedTurns(main, messages, null, toolResults, "/repo", open, context.entryIds);
  const stages = (card) => Object.fromEntries(card.flow.stages.map((view) => [view.stage, view.status]));

  const resumed = cards.get(at["끝"]);
  const ids = resumed.flow.steps.map((step) => step.toolCallId);
  assert.equal(stages(resumed).ci, "passed", "the hidden CI run of the source commit");
  assert.equal(resumed.flow.steps.find((step) => step.toolCallId === "ci-call").evidence, "run 4242 · completed success");
  assert.equal(stages(resumed).commit, "done");
  assert.equal(stages(resumed).deploy, "skipped", "nothing proves a deploy; the docs commit does not make it unnecessary");
  assert.deepEqual(resumed.remaining, [], "the tracker record after the second compaction");
  assert.ok(ids.includes("edit-call") && ids.includes("commit-call"), "hidden source work belongs to this request");
  for (const leaked of ["old-commit-call", "old-todo-call", "side-commit-call", "side-ci-call"]) assert.equal(ids.includes(leaked), false, leaked);
  // The second compaction's summary leads the shown branch, so "이어서" is still that next request's last answer.
  const next = cards.get(at["이어서"]);
  assert.deepEqual(next.flow.steps.map((step) => step.toolCallId), ["read-call"]);
  assert.equal(next.remaining, null);
  // The hidden evidence carries no prose, patch body, commit body or file body.
  const payload = JSON.stringify(open);
  for (const body of ["예전 끝", "secret patch body", "secret heredoc body", "long body", "UI 고쳐 줘", INTERRUPT_RESUME_MESSAGE, "Remaining items"]) assert.equal(payload.includes(body), false, body);
  assert.deepEqual(open.summary.files.map((file) => file.filePath), ["/repo/src/a.ts", "/repo/doc/history/2026/10/21-ui/main.md"]);
  // Without the hidden evidence the card falls back to the visible docs-only work (the failure this fixes).
  const visibleOnly = summarizeFinishedTurns(main, messages, null, toolResults, "/repo").get(at["끝"]);
  assert.notEqual(stages(visibleOnly).ci, "passed");
});

test("compaction anywhere inside a request preserves completed calls, canonical todo and long CI verdicts without copying command bodies", async () => {
  const { buildSessionContext } = await jiti.import("../session-reader.ts");
  const sha = "a".repeat(40);
  const secret = "PRIVATE_HEREDOC_BODY";
  const entries = [];
  let parentId = null;
  const add = (id, value) => {
    entries.push({ id, parentId, timestamp: "2026-10-22T00:00:00.000Z", ...value });
    parentId = id;
  };
  const message = (id, value) => add(id, { type: "message", message: value });
  const tool = (id, name, args, output, details) => {
    message(id, { role: "assistant", provider: "p", model: "m", content: [{ type: "toolCall", id, name, arguments: args }] });
    message(`${id}-result`, result(id, name, output, details));
  };
  message("user", { role: "user", content: "fix" });
  tool("todo", "todo", { op: "init" }, "ok", { phases: [{ name: "work", tasks: [{ content: "finish", status: "blocked" }] }] });
  tool("write", "write", { path: "src/a.ts", content: "PRIVATE_FILE_BODY" }, "ok");
  tool("check", "bash", { command: `cat > /tmp/probe <<'EOF'\n${secret}\nEOF\nbun test` }, "Command exited with code 1", { exitCode: 1 });
  tool("commit", "git_finalize", { files: ["src/a.ts"] }, "ok", { ok: true, commitSha: sha });
  tool("ci", "bash", { command: `gh run list --workflow CI --commit ${sha} --json databaseId,status,conclusion,headSha,displayTitle` },
    JSON.stringify([{ databaseId: 4242, status: "completed", conclusion: "success", headSha: sha, displayTitle: "x".repeat(4000) }]), { exitCode: 0 });
  add("tracker", { type: "custom", customType: "user_todo_edit", data: { phases: [{ name: "work", tasks: [{ content: "finish", status: "completed" }] }] } });
  message("answer", { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "done" }] });
  const card = (context) => {
    const { messages, entryIds } = context;
    const { main } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
    const results = new Map(messages.filter((value) => value.role === "toolResult").map((value) => [value.toolCallId, value]));
    return [...summarizeFinishedTurns(main, messages, null, results, "/repo", context.compactedWork?.openRequest, entryIds).values()].at(-1);
  };
  const observable = (summary) => ({
    files: summary.files.map((file) => file.filePath),
    checks: summary.checks.map(({ toolCallId, state, exitCode }) => ({ toolCallId, state, exitCode })),
    remaining: summary.remaining,
    steps: summary.flow.steps.map(({ toolCallId, stage, outcome, stale }) => ({ toolCallId, stage, outcome, stale })),
    stages: summary.flow.stages.map(({ stage, status }) => ({ stage, status })),
  });
  const whole = card(buildSessionContext(entries, parentId, { cwd: "/repo" }));
  assert.deepEqual(whole.checks.map(({ state }) => state), ["failed"]);
  assert.equal(whole.flow.stages.find(({ stage }) => stage === "ci").status, "passed");
  assert.deepEqual(whole.remaining, []);
  for (let cut = 1; cut < entries.length; cut += 1) {
    const compacted = [...entries, { id: "compaction", parentId, type: "compaction", timestamp: "2026-10-22T00:00:01.000Z", summary: "summary", firstKeptEntryId: entries[cut].id, tokensBefore: 100 }];
    const context = buildSessionContext(compacted, "compaction", { cwd: "/repo" });
    const actual = card(context);
    assert.deepEqual(observable(actual), observable(whole), `cut before ${entries[cut].id}`);
    const payload = JSON.stringify(context.compactedWork?.openRequest ?? null);
    assert.equal(payload.includes(secret), false, `command body at ${entries[cut].id}`);
    assert.equal(payload.includes("PRIVATE_FILE_BODY"), false, `file body at ${entries[cut].id}`);
  }
});

test("a compacted request resolves async eval and reused job ids from the complete trace, and rejects a stale snapshot", async () => {
  const { readOpenRequest } = await jiti.import("./open-request.ts");
  const { latestChecks } = await jiti.import("./work-flow.ts");
  const { withLocalCommandOutputs } = await jiti.import("../transcript-plan.ts");
  const sha = "b".repeat(40);
  const assistant = (...content) => ({ role: "assistant", provider: "p", model: "m", content });
  const launch = (id, name, job) => result(id, name, `Backgrounded as job ${job}`, { async: { state: "running", jobId: job, type: name } });
  const notice = (job, text) => ({ role: "custom", customType: "async-result", content: `Background job ${job} has completed.\n${text}`, display: true });
  const all = [
    { role: "user", content: "finish" },
    assistant(call("A", "bash", { command: "bun test alpha.test.mjs" })),
    launch("A", "bash", "bg_1"),
    assistant(call("B", "bash", { command: "bun test beta.test.mjs" })),
    launch("B", "bash", "bg_1"),
    assistant(call("proc", "read", { path: "proc://bg_1" })),
    result("proc", "read", "1|bg_1 [bash] — completed — bun test beta.test.mjs\n2|Command exited with code 0"),
    assistant(call("commit", "eval", { code: "await tool.git_finalize({ files: ['src/a.ts'] }); // PRIVATE_EVAL_BODY", language: "js" })),
    launch("commit", "eval", "bg_2"),
    notice("bg_2", `Committed and pushed ${sha} to origin refs/heads/main.\nCommand exited with code 0`),
    // Re-delivery of B must never settle the superseded A after compaction.
    notice("bg_1", "Command exited with code 0"),
    assistant(call("C", "bash", { command: "bun test beta.test.mjs" })),
    result("C", "bash", "Command exited with code 0", { exitCode: 0 }),
    { ...assistant({ type: "text", text: "done" }), trackerTodos: [[{ name: "work", tasks: [{ content: "finish", status: "completed" }] }]] },
  ];
  const items = all.map((message, index) => ({ message, entryId: `entry-${index}` }));
  for (let cut = 1; cut < items.length; cut += 1) {
    const snapshot = JSON.parse(JSON.stringify(readOpenRequest(items.slice(0, cut), items.slice(cut), "/repo")));
    const flow = snapshot.summary.flow;
    const steps = new Map(flow.steps.map((step) => [step.toolCallId, step]));
    assert.equal(steps.get("A").outcome, "unobserved", `superseded A at ${cut}`);
    assert.equal(steps.get("B").outcome, "passed", `completed B at ${cut}`);
    assert.equal(steps.get("commit").outcome, "done", `eval completion at ${cut}`);
    assert.equal(steps.get("commit").commit, sha);
    assert.deepEqual(latestChecks(flow.steps).map((step) => step.toolCallId), ["A", "C"], "distinct checks stay distinct; the repeated beta check uses its last result");
    assert.equal(JSON.stringify(snapshot).includes("PRIVATE_EVAL_BODY"), false);

    const shown = items.slice(cut);
    const messages = shown.map((item) => item.message);
    const entryIds = shown.map((item) => item.entryId);
    const { main } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));
    const results = new Map(messages.filter((message) => message.role === "toolResult").map((message) => [message.toolCallId, message]));
    assert.equal(summarizeFinishedTurns(main, messages, null, results, "/repo", snapshot, entryIds).size, 1);
    const local = withLocalCommandOutputs(messages, entryIds, [{
      entryId: "local-command:help",
      baseEntryId: entryIds.at(-1),
      message: { role: "custom", customType: "command", content: "help output", display: true },
    }]);
    const localPlan = partitionTranscriptPlan(local.messages, buildTranscriptRenderPlan(local.messages));
    assert.equal(summarizeFinishedTurns(localPlan.main, local.messages, null, results, "/repo", snapshot, local.entryIds).size, 1,
      "a tab-local command result must not hide the persisted request's card");
    assert.equal(summarizeFinishedTurns(main, messages, null, results, "/repo", snapshot, [...entryIds.slice(0, -1), "newer-entry"]).size, 0,
      "a different/newer request end cannot inherit this snapshot");
    const reopened = [{ name: "work", tasks: [{ content: "finish", status: "blocked", blocker: "external" }] }];
    const newerMessages = [...messages.slice(0, -1), { ...messages.at(-1), trackerTodos: [...(messages.at(-1).trackerTodos ?? []), reopened] }];
    const current = [...summarizeFinishedTurns(main, newerMessages, null, results, "/repo", snapshot, entryIds).values()][0];
    assert.deepEqual(current.remaining, [{ phase: "work", content: "finish", status: "blocked", blocker: "external" }],
      "a tracker-only edit after the answer wins even though the visible entry ID did not change");
  }
});
