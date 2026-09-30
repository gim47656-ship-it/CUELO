import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const [lessons, plan] = await Promise.all([import("./turn-saved-lessons.ts"), import("./transcript-plan.ts")]);
  return { ...lessons, ...plan };
}

function user(text) {
  return { role: "user", content: text };
}

function assistant(content) {
  return { role: "assistant", content, model: "m", provider: "p" };
}

function text(value) {
  return { type: "text", text: value };
}

function call(id, toolName, input) {
  return { type: "toolCall", toolCallId: id, toolName, input };
}

function result(id, isError = false) {
  return { role: "toolResult", toolCallId: id, content: [text(isError ? "failed" : "ok")], isError };
}

function resultsOf(messages) {
  return new Map(messages.filter((m) => m.role === "toolResult").map((m) => [m.toolCallId, m]));
}

test("lists only saves whose result arrived without an error", async () => {
  const { extractTurnSavedLessons } = await loadSubject();
  const blocks = [
    call("ok", "learn", { memory: "  restart   after deploy ", skill: { action: "create", name: "deploy-check" } }),
    call("failed", "learn", { memory: "rejected lesson" }),
    call("pending", "learn", { memory: "no result yet" }),
    call("skill", "manage_skill", { action: "update", name: "release-notes" }),
    call("deleted", "manage_skill", { action: "delete", name: "old-skill" }),
    call("other", "bash", { memory: "not a save" }),
  ];
  const results = resultsOf([result("ok"), result("failed", true), result("skill"), result("deleted"), result("other")]);

  assert.deepEqual(extractTurnSavedLessons(blocks, results), [
    { kind: "lesson", memory: "restart after deploy", skill: { action: "create", name: "deploy-check" } },
    { kind: "skill", action: "update", name: "release-notes" },
  ]);
});

test("keeps two lessons that share the preview prefix and lists a repeated save once", async () => {
  const { extractTurnSavedLessons } = await loadSubject();
  const prefix = "x".repeat(160);
  const blocks = [
    call("a", "learn", { memory: `${prefix} first ending` }),
    call("b", "learn", { memory: `${prefix} second ending` }),
    call("c", "learn", { memory: `${prefix}   first   ending` }),
  ];
  const lessons = extractTurnSavedLessons(blocks, resultsOf([result("a"), result("b"), result("c")]));

  assert.deepEqual(lessons, [
    { kind: "lesson", memory: `${prefix}…` },
    { kind: "lesson", memory: `${prefix}…` },
  ]);
});

test("keeps a save made after the turn's last answer and places it after the item before that work", async () => {
  const { buildTranscriptRenderPlan, partitionTranscriptPlan, collectSavedLessonPlacements } = await loadSubject();
  const messages = [
    user("first"),
    assistant([text("Done."), call("a", "learn", { memory: "first lesson" })]),
    result("a"),
    user("second"),
    assistant([text("Deployed.")]),
    assistant([call("b", "learn", { memory: "saved after the answer" })]),
    result("b"),
    assistant([call("c", "learn", { memory: "saved after the answer" })]),
    result("c"),
  ];
  const { main, process } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages));

  // main: [first, "Done.", second, "Deployed."]
  assert.deepEqual([...collectSavedLessonPlacements(main, process, messages, resultsOf(messages))], [
    [1, [{ kind: "lesson", memory: "first lesson" }]],
    [3, [{ kind: "lesson", memory: "saved after the answer" }]],
  ]);
});

// Regression: the card used to attach to the turn's last item, so every later
// answer in the same turn (a long or steered run) carried it further down.
for (const sessionBusy of [false, true]) {
  test(`stays after the saving answer while later answers follow${sessionBusy ? " in the live turn" : ""}`, async () => {
    const { buildTranscriptRenderPlan, partitionTranscriptPlan, collectSavedLessonPlacements } = await loadSubject();
    const messages = [
      user("task"),
      assistant([text("First answer."), call("x", "learn", { memory: "in the answer" })]),
      result("x"),
      assistant([text("Second answer.")]),
      assistant([call("y", "manage_skill", { action: "create", name: "folded-skill" })]),
      result("y"),
      assistant([text("Third answer.")]),
      assistant([text("Fourth answer.")]),
    ];
    const { main, process } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages, { sessionBusy }));
    const answers = main.map((item) => (item.kind === "answer" ? item.blocks[0]?.text : messages[item.idx].content));
    assert.deepEqual(answers, ["task", "First answer.", "Second answer.", "Third answer.", "Fourth answer."]);

    assert.deepEqual([...collectSavedLessonPlacements(main, process, messages, resultsOf(messages))], [
      [1, [{ kind: "lesson", memory: "in the answer" }]],
      [2, [{ kind: "skill", action: "create", name: "folded-skill" }]],
    ]);
  });
}
