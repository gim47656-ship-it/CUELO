import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { buildRunPrelude, buildRunTurns, loadRunWindow, pageRunTurns, readRunWindow, runEntryText } from "./run-xray-turns";

// GitHub 토큰 모양(ghp_ + 36자). 실제 토큰이 아니다.
const FAKE_TOKEN = `ghp_${"A1b2C3d4E5".repeat(3)}abcdef`;

const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-10-18T00:00:00.000Z");

function user(id: string, at: number, text: string) {
  return { type: "message", id, timestamp: iso(at), message: { role: "user", content: [{ type: "text", text }], timestamp: at } };
}

function assistant(id: string, at: number, end: number, calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>, active?: string[]) {
  return {
    type: "message",
    id,
    timestamp: iso(end),
    message: {
      role: "assistant",
      model: "claude-test",
      stopReason: calls.length > 0 ? "toolUse" : "stop",
      timestamp: at,
      usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 115, cost: { total: 0.01 } },
      ...(active ? { requestControls: { tools: { active }, effort: { topLevel: "high" } } } : {}),
      content: [{ type: "text", text: "ok" }, ...calls.map((call) => ({ type: "toolCall", ...call }))],
    },
  };
}

function start(id: string, callId: string, at: number) {
  return { type: "custom", customType: "tool_execution_start", id, timestamp: iso(at), data: { toolCallId: callId, startedAt: iso(at) } };
}

function result(id: string, callId: string, toolName: string, at: number, text: string, isError = false, details?: unknown) {
  return {
    type: "message",
    id,
    timestamp: iso(at),
    message: { role: "toolResult", toolCallId: callId, toolName, isError, timestamp: at, content: [{ type: "text", text }], ...(details ? { details } : {}) },
  };
}

function injection(id: string, at: number, customType: string, content: string, display = false) {
  return { type: "custom_message", customType, content, display, id, timestamp: iso(at) };
}

function lines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n");
}

test("an advisory recorded between a tool call and its result lands on the next request, and late ones trail", () => {
  const built = buildRunTurns([
    user("u1", T0, "fix it"),
    assistant("a1", T0 + 10, T0 + 500, [{ id: "c1", name: "bash", arguments: { command: "bun test" } }]),
    start("s1", "c1", T0 + 510),
    injection("j1", T0 + 520, "jev-runtime-advisory", "[JevRuntime:pre-retry] do not retry blindly"),
    result("r1", "c1", "bash", T0 + 900, "1 fail\nCommand exited with code 1", true),
    { type: "message", id: "d1", timestamp: iso(T0 + 905), message: { role: "developer", content: [{ type: "text", text: "[edit-lessons] one memory" }] } },
    assistant("a2", T0 + 910, T0 + 1500, []),
    injection("k1", T0 + 1600, "korean-reply-guard", "reply in Korean"),
  ]);
  expect(built.turns.map((turn) => turn.before.map((event) => event.entryId))).toEqual([["u1"], ["j1", "d1"]]);
  expect(built.turns[1].before.map((event) => event.source)).toEqual(["jev-runtime-advisory", "edit-lessons"]);
  expect(built.trailing.map((event) => event.entryId)).toEqual(["k1"]);
  expect(built.counts).toEqual({
    turns: 2,
    injections: 3,
    bySource: { "jev-runtime-advisory": 1, "edit-lessons": 1, "korean-reply-guard": 1 },
    toolCalls: 1,
    toolFailures: 1,
  });
  expect(built.turns[0].durationMs).toBe(490);
  expect(built.turns[1].before[0].hiddenFromChat).toBe(true);
});

test("tool timing comes from the start record and errors split into failed, no match, cancelled and missing", () => {
  const built = buildRunTurns([
    assistant("a1", T0, T0 + 100, [
      { id: "fail", name: "bash", arguments: { command: "bun test" } },
      { id: "nomatch", name: "bash", arguments: { command: "grep -n foo bar.ts" } },
      { id: "skip", name: "read", arguments: { path: "x" } },
      { id: "lost", name: "edit", arguments: { path: "y" } },
      { id: "fine", name: "read", arguments: { path: "z" } },
    ]),
    start("s1", "fail", T0 + 200),
    result("r1", "fail", "bash", T0 + 1450, "error: boom\nCommand exited with code 2", true),
    start("s2", "nomatch", T0 + 210),
    result("r2", "nomatch", "bash", T0 + 260, "Command exited with code 1", true),
    result("r3", "skip", "read", T0 + 270, "skipped", true, { __synthetic: true }),
    start("s4", "lost", T0 + 280),
    result("r5", "fine", "read", T0 + 300, "12345"),
  ]);
  const calls = Object.fromEntries(built.turns[0].toolCalls.map((call) => [call.toolCallId, call]));
  expect(calls.fail).toMatchObject({ status: "failed", durationMs: 1250, startedAt: T0 + 200, resultEntryId: "r1" });
  expect(calls.nomatch).toMatchObject({ status: "noMatch", durationMs: 50 });
  expect(calls.skip).toMatchObject({ status: "cancelled", durationMs: null });
  expect(calls.lost).toMatchObject({ status: "missing", durationMs: null, resultChars: null, startedAt: T0 + 280 });
  expect(calls.fine).toMatchObject({ status: "ok", durationMs: null, resultChars: 5 });
  expect(built.counts.toolFailures).toBe(1);
});

test("secrets in tool arguments and injected text are masked in previews and full text", () => {
  const data = readRunWindow(
    lines([
      user("u1", T0, "go"),
      assistant("a1", T0 + 1, T0 + 2, [{ id: "c1", name: "bash", arguments: { command: `curl -H "Authorization: token ${FAKE_TOKEN}" api` } }]),
      injection("j1", T0 + 3, "jev-runtime-advisory", `leaked ${FAKE_TOKEN} here`),
      assistant("a2", T0 + 4, T0 + 5, []),
    ]),
    { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u1"]) },
  );
  const call = data.built.turns[0].toolCalls[0];
  expect(call.argsPreview).toContain("[REDACTED]");
  expect(call.argsPreview).not.toContain(FAKE_TOKEN);
  const advisory = data.built.turns[1].before[0];
  expect(advisory.preview).toBe("leaked [REDACTED] here");
  const args = runEntryText(data, "a1", "c1");
  expect(args?.text).toContain("[REDACTED]");
  expect(args?.text).not.toContain(FAKE_TOKEN);
  expect(runEntryText(data, "j1", null)?.text).not.toContain(FAKE_TOKEN);
});

test("the parent window stops at the next run and keeps the prompt fingerprint recorded before it", () => {
  const raw = lines([
    { type: "custom", customType: "system-prompt-digest", id: "p0", timestamp: iso(T0 - 10), data: "aaa" },
    user("u0", T0 - 5, "earlier run"),
    injection("x0", T0 - 4, "todo-nudge", "earlier"),
    user("u1", T0, "this run"),
    injection("j1", T0 + 1, "jev-runtime-advisory", "mine"),
    assistant("a1", T0 + 2, T0 + 3, []),
    user("u2", T0 + 10, "next run"),
    injection("x2", T0 + 11, "todo-nudge", "later"),
    assistant("a2", T0 + 12, T0 + 13, []),
  ]);
  const data = readRunWindow(raw, { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u0", "u1", "u2"]) });
  expect(data.built.counts.bySource).toEqual({ "jev-runtime-advisory": 1 });
  expect(data.built.turns.map((turn) => turn.entryId)).toEqual(["a1"]);
  expect(data.priorDigest?.digest).toBe("aaa");
  expect(runEntryText(data, "x2", null)).toBeNull();

  const child = readRunWindow(raw, { kind: "time", start: T0, end: T0 + 10 });
  expect(child.built.turns.map((turn) => turn.entryId)).toEqual(["a1"]);
});

test("paging filters to requests with injections and only the last page carries the trailing items", () => {
  const built = buildRunTurns([
    assistant("a1", T0, T0 + 1, []),
    injection("j1", T0 + 2, "todo-nudge", "n"),
    injection("auto", T0 + 2, "autolearn-saved", "saved", true),
    assistant("a2", T0 + 3, T0 + 4, []),
    assistant("a3", T0 + 5, T0 + 6, []),
    injection("k1", T0 + 7, "korean-reply-guard", "k"),
  ]);
  expect(built.turns[1].before.find((event) => event.entryId === "auto")?.sentToModel).toBe(false);
  const meta = { runId: "s:u", role: "main", roles: ["main"] };
  const filtered = pageRunTurns(built, meta, 0, 10, true);
  expect(filtered.turns.map((turn) => turn.entryId)).toEqual(["a2"]);
  expect(filtered.total).toBe(1);
  const first = pageRunTurns(built, meta, 0, 2, false);
  expect(first.turns.map((turn) => turn.entryId)).toEqual(["a1", "a2"]);
  expect(first.trailing).toEqual([]);
  const last = pageRunTurns(built, meta, 2, 2, false);
  expect(last.turns.map((turn) => turn.entryId)).toEqual(["a3"]);
  expect(last.trailing.map((event) => event.entryId)).toEqual(["k1"]);
});

test("a token inside a customType, developer tag or tool name never reaches the page, prelude or full-text JSON", () => {
  const data = readRunWindow(
    lines([
      user("u1", T0, "go"),
      assistant("a1", T0 + 1, T0 + 2, [{ id: "c1", name: `tool_${FAKE_TOKEN}`, arguments: {} }], [`tool_${FAKE_TOKEN}`]),
      injection("j1", T0 + 3, `hook-${FAKE_TOKEN}`, "plain"),
      { type: "message", id: "d1", timestamp: iso(T0 + 4), message: { role: "developer", content: [{ type: "text", text: `[${FAKE_TOKEN}] note` }] } },
      assistant("a2", T0 + 5, T0 + 6, []),
    ]),
    { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u1"]) },
  );
  const page = JSON.stringify(pageRunTurns(data.built, { runId: "s:u1", role: "main", roles: ["main"] }, 0, 10, false));
  expect(page).not.toContain(FAKE_TOKEN);
  expect(page).toContain("hook-[REDACTED]");
  expect(JSON.stringify(buildRunPrelude(data, { runId: "s:u1", role: "main" }, null, false))).not.toContain(FAKE_TOKEN);
  expect(JSON.stringify(runEntryText(data, "d1", null))).not.toContain(FAKE_TOKEN);
});

test("a boundary line with a different key order still ends the parent window and a reordered digest is still found", () => {
  const raw = lines([
    { id: "p0", type: "custom", customType: "system-prompt-digest", timestamp: iso(T0 - 10), data: "bbb" },
    user("u1", T0, "this run"),
    assistant("a1", T0 + 2, T0 + 3, []),
    { id: "u2", timestamp: iso(T0 + 10), type: "message", message: { role: "user", content: [{ type: "text", text: "next run" }] } },
    assistant("a2", T0 + 12, T0 + 13, []),
  ]);
  const data = readRunWindow(raw, { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u1", "u2"]) });
  expect(data.built.turns.map((turn) => turn.entryId)).toEqual(["a1"]);
  expect(data.priorDigest?.digest).toBe("bbb");
});

test("a boundary or digest line written with spaces after the colons is still recognised", () => {
  const spaced = (record: unknown) => JSON.stringify(record).replace(/":/g, '": ');
  const raw = [
    spaced({ id: "p0", type: "custom", customType: "system-prompt-digest", timestamp: iso(T0 - 10), data: "ccc" }),
    JSON.stringify(user("u1", T0, "this run")),
    JSON.stringify(assistant("a1", T0 + 2, T0 + 3, [])),
    spaced({ id: "u2", timestamp: iso(T0 + 10), type: "message", message: { role: "user", content: [{ type: "text", text: "next run" }] } }),
    JSON.stringify(assistant("a2", T0 + 12, T0 + 13, [])),
  ].join("\n");
  const data = readRunWindow(raw, { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u1", "u2"]) });
  expect(data.built.turns.map((turn) => turn.entryId)).toEqual(["a1"]);
  expect(data.priorDigest?.digest).toBe("ccc");
});

test("the cached parent window shrinks when a run boundary appears later for the same unchanged file", () => {
  const dir = mkdtempSync(join(tmpdir(), "run-xray-turns-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, lines([
      user("u1", T0, "this run"),
      assistant("a1", T0 + 2, T0 + 3, []),
      user("u2", T0 + 10, "next run"),
      assistant("a2", T0 + 12, T0 + 13, []),
    ]));
    const before = loadRunWindow(file, { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u1"]) });
    expect(before.built.turns.map((turn) => turn.entryId)).toEqual(["a1", "a2"]);
    const after = loadRunWindow(file, { kind: "entries", startEntryId: "u1", boundaryIds: new Set(["u1", "u2"]) });
    expect(after.built.turns.map((turn) => turn.entryId)).toEqual(["a1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
