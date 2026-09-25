import assert from "node:assert/strict";
import { test } from "node:test";
import { codexNotificationEvents } from "./codex-adapter";

test("Codex app-server notifications map to stable runtime events", () => {
  assert.deepEqual(codexNotificationEvents("item/agentMessage/delta", { delta: "hello" }), [
    { type: "text_delta", text: "hello" },
  ]);
  assert.deepEqual(codexNotificationEvents("item/reasoning/summaryTextDelta", { delta: "thinking" }), [
    { type: "reasoning_delta", text: "thinking" },
  ]);
  assert.deepEqual(codexNotificationEvents("item/started", {
    item: { id: "item-1", type: "commandExecution", command: "echo hi", cwd: "/work" },
  }), [{ type: "tool_started", id: "item-1", name: "command", input: { command: "echo hi", cwd: "/work" } }]);
  assert.deepEqual(codexNotificationEvents("item/completed", {
    item: { id: "item-1", type: "commandExecution", status: "failed", aggregatedOutput: "denied" },
  }), [{ type: "tool_completed", id: "item-1", output: "denied", isError: true }]);
  assert.deepEqual(codexNotificationEvents("item/completed", {
    item: { type: "fileChange", changes: [{ path: "/work/hello.txt" }] },
  }), [{ type: "file_changed", path: "/work/hello.txt" }]);
  assert.deepEqual(codexNotificationEvents("thread/tokenUsage/updated", {
    tokenUsage: { last: { inputTokens: 9, cachedInputTokens: 3, cacheWriteInputTokens: 2, outputTokens: 4 } },
  }), [{ type: "usage", input: 9, cachedInput: 3, cacheWrite: 2, output: 4 }]);
  assert.deepEqual(codexNotificationEvents("turn/completed", { turn: { status: "interrupted" } }), [
    { type: "turn_completed", stopReason: "aborted", text: "" },
  ]);
  assert.deepEqual(codexNotificationEvents("unhandled/event", {}), []);
});
