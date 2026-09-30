import assert from "node:assert/strict";
import test from "node:test";

const { isRunInterrupted } = await import("./run-interruption.ts");

const user = (text) => ({ role: "user", content: text });
const assistant = (content, stopReason) => ({ role: "assistant", content, model: "m", provider: "p", ...(stopReason ? { stopReason } : {}) });
const call = (id) => ({ type: "toolCall", toolCallId: id, toolName: "bash", input: {} });
const result = (id) => ({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }] });
const notice = { role: "custom", customType: "autolearn-saved", content: "saved", display: true };
const shell = { role: "bashExecution", command: "ls", output: "" };

test("a finished turn is not interrupted, even with notices and a user shell command after it", () => {
  assert.equal(isRunInterrupted([user("q"), assistant([call("a")], "toolUse"), result("a"), assistant([{ type: "text", text: "done" }], "stop"), notice, shell]), false);
  assert.equal(isRunInterrupted([user("q"), assistant([], "error")]), false);
  assert.equal(isRunInterrupted([]), false);
});

test("a run the user stopped is not interrupted", () => {
  assert.equal(isRunInterrupted([user("q"), assistant([call("a")], "aborted")]), false);
});

test("a transcript cut off mid-run is interrupted", () => {
  assert.equal(isRunInterrupted([user("q"), assistant([{ type: "text", text: "a" }], "stop"), user("next")]), true, "prompt without a reply");
  assert.equal(isRunInterrupted([user("q"), assistant([call("a")], "toolUse")]), true, "tool call without a result");
  assert.equal(isRunInterrupted([user("q"), assistant([call("a")], "toolUse"), result("a"), notice]), true, "result never answered");
  assert.equal(isRunInterrupted([user("q"), assistant([{ type: "text", text: "partial" }])]), true, "no stop reason");
});
