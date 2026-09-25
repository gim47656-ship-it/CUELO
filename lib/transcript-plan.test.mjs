import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./transcript-plan.ts");
}

function user(text) {
  return { role: "user", content: text };
}

function assistant(content, extra = {}) {
  return { role: "assistant", content, model: "m", provider: "p", ...extra };
}

function text(value) {
  return { type: "text", text: value };
}

function toolCall(id) {
  return { type: "toolCall", toolCallId: id, toolName: "bash", input: {} };
}

function shape(plan) {
  return plan.map((item) => (item.kind === "answer"
    ? `answer:${item.blocks.map((block) => block.text ?? block.type).join("|")}`
    : item.kind === "process" ? `process:${item.messageCount}` : `message:${item.idx}`));
}

test("surfaces both conclusions when a turn concludes twice", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    assistant([text("Removing the plugin now."), toolCall("a")]),
    { role: "toolResult", toolCallId: "a", content: [text("ok")] },
    assistant([text("Done. Plugin removed.")]),
  ]);

  assert.deepEqual(shape(plan), [
    "message:0",
    "answer:Removing the plugin now.",
    "process:1",
    "answer:Done. Plugin removed.",
  ]);
});

test("folds only tool calls and thinking, never prose", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    assistant([{ type: "thinking", thinking: "hmm" }, toolCall("a")]),
    assistant([toolCall("b")]),
    assistant([text("Final answer")]),
  ]);

  const [, group] = plan;
  assert.equal(group.kind, "process");
  assert.equal(group.messageCount, 2);
  assert.equal(group.toolCallCount, 2);
  assert.equal(group.turnHasAnswer, true);
  assert.deepEqual(shape(plan), ["message:0", "process:2", "answer:Final answer"]);
});

test("keeps a process-only turn expanded by default", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    assistant([toolCall("a")]),
  ]);

  assert.equal(plan[1].kind, "process");
  assert.equal(plan[1].turnHasAnswer, false);
});

test("splits a message into folded tool calls and a standalone answer", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    assistant([toolCall("a"), text("Answer after the call")]),
  ]);

  const [, group, answer] = plan;
  assert.deepEqual(group.entries, [{ idx: 1, blocks: [toolCall("a")] }]);
  assert.deepEqual(answer.blocks, [text("Answer after the call")]);
});

test("attributes tool calls to the answer that follows them", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    assistant([text("First"), toolCall("a")]),
    assistant([toolCall("b")]),
    assistant([text("Second")]),
  ]);

  const answers = plan.filter((item) => item.kind === "answer");
  assert.deepEqual(answers[0].precedingBlocks, []);
  assert.deepEqual(
    answers[1].precedingBlocks.map((block) => block.toolCallId),
    ["a", "b"],
  );
});

test("renders a provider error as the answer of its turn", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    assistant([toolCall("a")]),
    assistant([], { stopReason: "error", errorMessage: "boom" }),
  ]);

  assert.deepEqual(shape(plan), ["message:0", "process:1", "answer:"]);
  assert.equal(plan[1].turnHasAnswer, true);
});

test("leaves the streaming tail flat", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const messages = [
    user("go"),
    assistant([toolCall("a")]),
    assistant([text("partial")]),
  ];

  assert.deepEqual(
    shape(buildTranscriptRenderPlan(messages, { isStreaming: true })),
    ["message:0", "message:1", "message:2"],
  );
  assert.deepEqual(
    shape(buildTranscriptRenderPlan(messages, { sessionBusy: true })),
    ["message:0", "message:1", "message:2"],
  );
});

test("anchors a post-compaction turn on the compaction summary", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    { role: "custom", customType: "compaction", content: "summary", display: true },
    assistant([toolCall("a")]),
    assistant([text("After compaction")]),
  ]);

  assert.deepEqual(shape(plan), ["message:0", "process:1", "answer:After compaction"]);
});

test("folds custom notices that arrive mid-turn", async () => {
  const { buildTranscriptRenderPlan } = await loadSubject();
  const plan = buildTranscriptRenderPlan([
    user("go"),
    { role: "custom", customType: "notice", content: "job done", display: true },
    assistant([text("Result")]),
  ]);

  assert.deepEqual(plan[1].entries, [{ idx: 1 }]);
  assert.deepEqual(shape(plan), ["message:0", "process:1", "answer:Result"]);
});

test("keeps the conversation free of process items while losing nothing", async () => {
  const { buildTranscriptRenderPlan, partitionTranscriptPlan } = await loadSubject();
  const messages = [
    user("go"),
    assistant([{ type: "thinking", thinking: "hmm" }, text("Removing it."), toolCall("a")]),
    { role: "toolResult", toolCallId: "a", content: [text("ok")] },
    { role: "custom", customType: "notice", content: "job done", display: true },
    assistant([text("Done.")]),
  ];
  const { main, process } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));

  assert.deepEqual(shape(main), ["message:0", "answer:Removing it.", "answer:Done."]);
  assert.equal(main.some((item) => item.kind === "process"), false);
  assert.equal(process.length, 1);
  assert.equal(process[0].anchorIdx, 0);
  // thinking run, toolCall run and the custom notice. The toolResult message is
  // not a plan item of its own - the renderer pairs it with its toolCall.
  assert.deepEqual(process[0].entries.map((entry) => entry.idx), [1, 1, 3]);
  assert.equal(process[0].toolCallCount, 1);
});

test("classifies the streaming tail instead of leaking tool calls into the conversation", async () => {
  const { buildTranscriptRenderPlan, partitionTranscriptPlan } = await loadSubject();
  const messages = [
    user("go"),
    assistant([toolCall("a")]),
    assistant([text("partial")]),
  ];
  const { main, process } = partitionTranscriptPlan(
    messages,
    buildTranscriptRenderPlan(messages, { isStreaming: true }),
  );

  assert.deepEqual(shape(main), ["message:0", "answer:partial"]);
  assert.deepEqual(process.map((group) => group.entries.map((entry) => entry.idx)), [[1]]);
  assert.equal(process[0].toolCallCount, 1);
});

test("keeps a provider error visible in the conversation", async () => {
  const { buildTranscriptRenderPlan, partitionTranscriptPlan } = await loadSubject();
  const messages = [
    user("go"),
    assistant([toolCall("a")], { stopReason: "error", errorMessage: "provider exploded" }),
  ];
  const { main } = partitionTranscriptPlan(
    messages,
    buildTranscriptRenderPlan(messages, { isStreaming: true }),
  );

  assert.equal(main.filter((item) => item.kind === "answer").length, 1);
});

test("routes a shell command the user ran into the work log", async () => {
  const { buildTranscriptRenderPlan, partitionTranscriptPlan } = await loadSubject();
  const messages = [
    user("go"),
    { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0 },
    assistant([text("Done.")]),
  ];
  const { main, process } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));

  assert.deepEqual(shape(main), ["message:0", "answer:Done."]);
  assert.deepEqual(process.map((group) => [group.anchorIdx, group.entries.map((entry) => entry.idx)]), [[0, [1]]]);
});
