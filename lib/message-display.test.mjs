import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./message-display.ts");
}

function assistant(content) {
  return {
    role: "assistant",
    provider: "test",
    model: "test-model",
    content,
  };
}

test("splits blocks into ordered answer and process runs", async () => {
  const { splitAssistantBlockRuns } = await loadSubject();
  const message = assistant([
    { type: "text", text: "I will inspect the repo first." },
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    { type: "text", text: "Final answer" },
    { type: "image", source: { type: "url", url: "https://example.com/final.png" } },
  ]);

  const runs = splitAssistantBlockRuns(message, { isStreaming: false });

  assert.deepEqual(runs.map((run) => run.kind), ["answer", "process", "answer"]);
  assert.deepEqual(runs[0].blocks.map((block) => block.text), ["I will inspect the repo first."]);
  assert.deepEqual(runs[1].blocks.map((block) => block.type), ["thinking", "toolCall"]);
  assert.deepEqual(runs[2].blocks.map((block) => block.type), ["text", "image"]);
});

test("treats blank text as process so it never becomes an answer", async () => {
  const { splitAssistantBlockRuns } = await loadSubject();
  const message = assistant([
    { type: "text", text: "   " },
    { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
  ]);

  const runs = splitAssistantBlockRuns(message, { isStreaming: false });

  assert.deepEqual(runs.map((run) => run.kind), ["process"]);
  assert.deepEqual(runs[0].blocks.map((block) => block.type), ["text", "toolCall"]);
});

test("drops empty thinking blocks after completion", async () => {
  const { getDisplayableAssistantBlocks, splitAssistantBlockRuns } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["text"],
  );
  assert.deepEqual(
    splitAssistantBlockRuns(message, { isStreaming: false }).map((run) => run.kind),
    ["answer"],
  );
});

test("keeps empty thinking while streaming", async () => {
  const { splitAssistantBlockRuns } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "" },
    { type: "text", text: "Partial answer" },
  ]);

  const runs = splitAssistantBlockRuns(message, { isStreaming: true });

  assert.deepEqual(runs.map((run) => run.kind), ["process", "answer"]);
  assert.deepEqual(runs[0].blocks.map((block) => block.type), ["thinking"]);
});

test("keeps deferred historical thinking placeholders", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "", deferred: true },
    { type: "text", text: "Final answer" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { isStreaming: false }).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("returns completed provider errors even when the message has no content", async () => {
  const { getAssistantErrorMessage } = await loadSubject();
  const message = {
    ...assistant([]),
    stopReason: "error",
    errorMessage: "OpenAI API error (403): request forbidden",
  };

  assert.equal(
    getAssistantErrorMessage(message),
    "OpenAI API error (403): request forbidden",
  );
  assert.equal(getAssistantErrorMessage(message, { isStreaming: true }), null);
});

test("falls back when a provider error has no message", async () => {
  const { getAssistantErrorMessage } = await loadSubject();

  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "error" }),
    "Unknown provider error",
  );
  assert.equal(
    getAssistantErrorMessage({ ...assistant([]), stopReason: "stop" }),
    null,
  );
});

test("drops thinking blocks entirely when hideThinkingBlock is set", async () => {
  const { getDisplayableAssistantBlocks, isHiddenAssistantBlock, splitAssistantBlockRuns } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "toolCall", toolCallId: "call-1", name: "read", arguments: {} },
    { type: "text", text: "done" },
  ]);

  assert.deepEqual(
    getDisplayableAssistantBlocks(message, { hideThinking: true }).map((block) => block.type),
    ["toolCall", "text"],
  );
  assert.deepEqual(
    splitAssistantBlockRuns(message, { hideThinking: true })
      .filter((run) => run.kind === "process")
      .flatMap((run) => run.blocks)
      .map((block) => block.type),
    ["toolCall"],
  );
  assert.equal(isHiddenAssistantBlock({ type: "thinking", thinking: "deferred", deferred: true }, { hideThinking: true }), true);
});

test("keeps thinking blocks when the setting is off", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([
    { type: "thinking", thinking: "work through it" },
    { type: "text", text: "done" },
  ]);
  assert.deepEqual(
    getDisplayableAssistantBlocks(message).map((block) => block.type),
    ["thinking", "text"],
  );
});

test("hides an assistant message whose only content is thinking", async () => {
  const { getDisplayableAssistantBlocks } = await loadSubject();
  const message = assistant([{ type: "thinking", thinking: "work through it" }]);
  assert.equal(getDisplayableAssistantBlocks(message, { hideThinking: true }).length, 0);
  assert.equal(getDisplayableAssistantBlocks(message).length, 1);
});
