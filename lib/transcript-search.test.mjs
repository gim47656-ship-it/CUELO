import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { searchTranscripts, buildSnippet } = await import("./transcript-search.ts");

function message(id, role, content, timestamp = "2026-09-30T00:00:00.000Z") {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp, message: { role, content } });
}

function writeSession(dir, name, lines) {
  const path = join(dir, `${name}.jsonl`);
  writeFileSync(path, `${[JSON.stringify({ type: "session", id: name }), ...lines].join("\n")}\n`);
  return path;
}

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "transcript-search-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const LIMITS = { maxMs: 60_000, maxBytes: 1024 * 1024 * 1024, maxHits: 50, maxHitsPerSession: 3 };

test("searches user and assistant text newest-first, not thinking or tool output", () => withDir(async (dir) => {
  const older = writeSession(dir, "older", [message("u1", "user", "Where is the Deploy script?")]);
  const newer = writeSession(dir, "newer", [
    message("a1", "assistant", [
      { type: "thinking", thinking: "deploy in thinking only" },
      { type: "toolCall", id: "t", name: "bash", arguments: { command: "deploy" } },
    ]),
    JSON.stringify({ type: "message", id: "r1", message: { role: "toolResult", content: [{ type: "text", text: "deploy output" }] } }),
    message("a2", "assistant", [{ type: "text", text: "Run the deploy step after the build." }]),
  ]);
  const result = await searchTranscripts([
    { id: "older", path: older, modified: "2026-09-01T00:00:00.000Z" },
    { id: "newer", path: newer, modified: "2026-09-02T00:00:00.000Z" },
  ], "DEPLOY", LIMITS);

  assert.deepEqual(result.hits.map((hit) => [hit.sessionId, hit.entryId, hit.role]), [
    ["newer", "a2", "assistant"],
    ["older", "u1", "user"],
  ]);
  assert.equal(result.truncated, null);
  assert.equal(result.scannedSessions, 2);
  const hit = result.hits[0];
  assert.equal(hit.snippet.slice(hit.matchStart, hit.matchStart + 6).toLowerCase(), "deploy");
}));

test("drops hits in history the latest compaction replaced and counts them", () => withDir(async (dir) => {
  const path = writeSession(dir, "compacted", [
    message("old", "user", "alpha before compaction"),
    message("kept", "user", "alpha kept after compaction point"),
    JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "kept", summary: "alpha summary" }),
    message("new", "assistant", [{ type: "text", text: "alpha after" }]),
  ]);
  const result = await searchTranscripts([{ id: "s", path, modified: "2026-09-02T00:00:00.000Z" }], "alpha", LIMITS);

  assert.deepEqual(result.hits.map((hit) => hit.entryId), ["kept", "new"]);
  assert.equal(result.compactedHits, 1);
}));

test("compacted matches do not spend the per-session quota of retained messages", () => withDir(async (dir) => {
  const path = writeSession(dir, "quota", [
    message("o1", "user", "alpha old 1"),
    message("o2", "user", "alpha old 2"),
    message("o3", "user", "alpha old 3"),
    message("kept", "user", "alpha retained before marker"),
    message("kept2", "assistant", [{ type: "text", text: "no match here" }]),
    JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "kept", summary: "s" }),
    message("new", "assistant", [{ type: "text", text: "alpha after" }]),
  ]);
  const result = await searchTranscripts([{ id: "s", path, modified: "2026-09-02T00:00:00.000Z" }], "alpha", LIMITS);

  assert.deepEqual(result.hits.map((hit) => hit.entryId), ["kept", "new"]);
  assert.equal(result.compactedHits, 3);
}));

test("a match skipped while old history filled the quota is found when the marker frees it, and the cap still holds", () => withDir(async (dir) => {
  const lines = [1, 2, 3].map((n) => message(`o${n}`, "user", `alpha old ${n}`));
  lines.push(message("k1", "user", "alpha k1"), message("k2", "user", "alpha k2"), message("k3", "user", "alpha k3"), message("k4", "user", "alpha k4"));
  lines.push(
    JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "k1", summary: "s" }),
    message("n1", "user", "alpha n1"),
  );
  const path = writeSession(dir, "quota2", lines);
  const result = await searchTranscripts([{ id: "s", path, modified: "2026-09-02T00:00:00.000Z" }], "alpha", LIMITS);

  assert.deepEqual(result.hits.map((hit) => hit.entryId), ["k1", "k2", "k3"]);
}));

test("only the latest compaction decides visibility when an earlier one already pruned", () => withDir(async (dir) => {
  const path = writeSession(dir, "two", [
    message("a", "user", "alpha a"),
    message("b", "user", "alpha b"),
    message("c", "user", "alpha c"),
    message("d", "user", "alpha d"),
    JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "c", summary: "s" }),
    message("e", "user", "alpha e"),
    JSON.stringify({ type: "compaction", id: "c2", firstKeptEntryId: "d", summary: "s" }),
    message("f", "user", "alpha f"),
  ]);
  const result = await searchTranscripts([{ id: "s", path, modified: "2026-09-02T00:00:00.000Z" }], "alpha", LIMITS);

  assert.deepEqual(result.hits.map((hit) => hit.entryId), ["d", "e", "f"]);
}));

test("a retained match before the marker still ranks first when post-marker matches refill the quota", () => withDir(async (dir) => {
  const path = writeSession(dir, "refill", [
    message("o1", "user", "alpha old 1"),
    message("o2", "user", "alpha old 2"),
    message("o3", "user", "alpha old 3"),
    message("kept", "user", "alpha retained before marker"),
    JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "kept", summary: "s" }),
    message("n1", "user", "alpha n1"),
    message("n2", "user", "alpha n2"),
    message("n3", "user", "alpha n3"),
  ]);
  const result = await searchTranscripts([{ id: "s", path, modified: "2026-09-02T00:00:00.000Z" }], "alpha", LIMITS);

  assert.deepEqual(result.hits.map((hit) => hit.entryId), ["kept", "n1", "n2"]);
  assert.equal(result.compactedHits, 3);
}));

test("a later compaction keeping earlier history neither hides nor miscounts the hits it gives back", () => withDir(async (dir) => {
  const path = writeSession(dir, "backup", [
    message("a", "user", "alpha a"),
    message("b", "user", "alpha b"),
    JSON.stringify({ type: "compaction", id: "c1", firstKeptEntryId: "b", summary: "s" }),
    message("c", "user", "alpha c"),
    JSON.stringify({ type: "compaction", id: "c2", firstKeptEntryId: "a", summary: "s" }),
  ]);
  const result = await searchTranscripts([{ id: "s", path, modified: "2026-09-02T00:00:00.000Z" }], "alpha", LIMITS);

  assert.deepEqual(result.hits.map((hit) => hit.entryId), ["a", "b", "c"]);
  assert.equal(result.compactedHits, 0);
}));

test("reports the budget that cut the scan short", () => withDir(async (dir) => {
  const sessions = [0, 1, 2].map((n) => ({
    id: `s${n}`,
    path: writeSession(dir, `s${n}`, [message(`m${n}a`, "user", "needle one"), message(`m${n}b`, "user", "needle two")]),
    modified: `2026-09-0${n + 1}T00:00:00.000Z`,
  }));

  const byResults = await searchTranscripts(sessions, "needle", { ...LIMITS, maxHits: 3 });
  assert.equal(byResults.hits.length, 3);
  assert.equal(byResults.truncated, "results");

  const perSession = await searchTranscripts(sessions, "needle", { ...LIMITS, maxHitsPerSession: 1 });
  assert.deepEqual(perSession.hits.map((hit) => hit.sessionId), ["s2", "s1", "s0"]);

  let clock = 0;
  const byTime = await searchTranscripts(sessions, "needle", { ...LIMITS, maxMs: 10 }, () => (clock += 6));
  assert.equal(byTime.truncated, "time");
  assert.ok(byTime.scannedSessions < sessions.length);

  const byBytes = await searchTranscripts(sessions, "needle", { ...LIMITS, maxBytes: 1 });
  assert.equal(byBytes.truncated, "bytes");
  assert.equal(byBytes.scannedSessions, 1);
}));

test("matches a needle JSON would escape and ignores queries shorter than two characters", () => withDir(async (dir) => {
  const path = writeSession(dir, "quoted", [message("q", "user", 'say "hi" to it')]);
  const sessions = [{ id: "q", path, modified: "2026-09-02T00:00:00.000Z" }];

  assert.deepEqual((await searchTranscripts(sessions, '"hi"', LIMITS)).hits.map((hit) => hit.entryId), ["q"]);
  assert.equal((await searchTranscripts(sessions, "s", LIMITS)).scannedSessions, 0);
}));

test("builds a one-line excerpt around the match", () => {
  const long = `${"a ".repeat(60)}TARGET\n\nword ${"b ".repeat(80)}`;
  const excerpt = buildSnippet(long, "target");
  assert.ok(excerpt.snippet.startsWith("…") && excerpt.snippet.endsWith("…"));
  assert.equal(excerpt.snippet.slice(excerpt.matchStart, excerpt.matchStart + 6), "TARGET");
  assert.ok(!excerpt.snippet.includes("\n"));
});
