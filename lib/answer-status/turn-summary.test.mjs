import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { collectTurnBlocks, placeTurnSummaries, summarizeTurn } = await jiti.import("./turn-summary.ts");

const call = (toolCallId, toolName, input) => ({ type: "toolCall", toolCallId, toolName, input });
const result = (toolCallId, toolName, textValue, details, isError = false) => ({
  role: "toolResult", toolCallId, toolName, isError, details, content: [{ type: "text", text: textValue }],
});

test("summarizes the files written and the check commands actually run, with their exit codes", () => {
  const blocks = [
    call("w", "write", { path: "src/a.ts" }),
    call("e", "edit", { path: "src/b.ts" }),
    call("ok", "bash", { command: "bun run typecheck" }),
    call("bad", "bash", { command: "bun test lib/x.test.mjs" }),
    call("plain", "bash", { command: "git status --short" }),
    call("bg", "bash", { command: "bun run build" }),
    call("noexit", "bash", { command: "bunx eslint components" }),
    call("crash", "bash", { command: "bun run lint" }),
  ];
  const toolResults = new Map([
    ["w", result("w", "write", "ok")],
    ["e", result("e", "edit", "ok", undefined, true)],
    ["ok", result("ok", "bash", "Command exited with code 0", { exitCode: 0 })],
    ["bad", result("bad", "bash", "1 fail\n\nCommand exited with code 1")],
    ["plain", result("plain", "bash", "Command exited with code 0", { exitCode: 0 })],
    ["bg", result("bg", "bash", "Backgrounded as job bg_3")],
    ["crash", result("crash", "bash", "spawn failed", undefined, true)],
  ]);
  const summary = summarizeTurn(blocks, toolResults, "D:/repo");
  assert.deepEqual(summary.files.map((file) => file.filePath), ["D:/repo/src/a.ts"]);
  assert.deepEqual(summary.checks.map((check) => [check.command, check.state, check.exitCode]), [
    ["bun run typecheck", "passed", 0],
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
