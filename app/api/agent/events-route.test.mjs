import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createMessageUpdateCoalescer, toToolProgressEvent } = await jiti.import("../../../lib/rpc-manager.ts");


test("agent SSE coalesces cumulative message updates and flushes before ordered events", async () => {
  const emitted = [];
  const coalescer = createMessageUpdateCoalescer((event) => emitted.push(event));

  coalescer.push({ type: "message_update", message: { id: "first" } });
  coalescer.push({ type: "message_update", message: { id: "latest" } });
  assert.deepEqual(emitted, []);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(emitted, [{ type: "message_update", message: { id: "latest" } }]);

  coalescer.push({ type: "message_update", message: { id: "before-end" } });
  coalescer.push({ type: "message_end", message: { id: "complete" } });
  assert.deepEqual(emitted.slice(1), [
    { type: "message_update", message: { id: "before-end" } },
    { type: "message_end", message: { id: "complete" } },
  ]);

  coalescer.push({ type: "message_update", message: { id: "dropped" } });
  coalescer.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(emitted.length, 3);
});


test("tool progress reaches the client as one compact line without args or cumulative output", () => {
  const output = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n");
  assert.deepEqual(
    toToolProgressEvent({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: { command: "x".repeat(10_000) }, partialResult: { content: [{ type: "text", text: `${output}\n\n` }], details: { output } } }),
    { type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", text: "line 1999" },
  );
  const long = toToolProgressEvent({ type: "tool_execution_update", toolCallId: "call-2", toolName: "cross_review", partialResult: { content: [{ type: "text", text: "w".repeat(1000) }] } });
  assert.equal(long.text.length, 240);
  // A terminal-card update carries only details: nothing to show, so nothing is sent.
  assert.equal(toToolProgressEvent({ type: "tool_execution_update", toolCallId: "call-3", toolName: "bash", partialResult: { content: [], details: { terminalId: "t" } } }), null);
});

test("agent SSE keeps only the latest progress per tool and flushes it before the tool's end", () => {
  const emitted = [];
  const coalescer = createMessageUpdateCoalescer((event) => emitted.push(event));
  const progress = (toolCallId, text) => ({ type: "tool_execution_update", toolCallId, toolName: "cross_review", text });

  coalescer.push(progress("a", "a waiting"));
  coalescer.push(progress("b", "b waiting"));
  coalescer.push(progress("a", "a answered"));
  assert.deepEqual(emitted, []);
  coalescer.flush();
  assert.deepEqual(emitted, [progress("b", "b waiting"), progress("a", "a answered")]);

  coalescer.push(progress("b", "b timed out"));
  coalescer.push({ type: "tool_execution_end", toolCallId: "b" });
  assert.deepEqual(emitted.slice(2), [progress("b", "b timed out"), { type: "tool_execution_end", toolCallId: "b" }]);

  coalescer.push(progress("a", "dropped"));
  coalescer.close();
  coalescer.flush();
  assert.equal(emitted.length, 4);
});


