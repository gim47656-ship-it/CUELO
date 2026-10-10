import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createSessionRecallTool, SESSION_RECALL_LIMITS, SESSION_RECALL_TOOL_NAME } = await import("./session-recall.ts");
const { searchTranscripts } = await import("./transcript-search.ts");
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const { toolWireSchema } = await import("@oh-my-pi/pi-ai/utils/schema/wire");

const PROJECT = "/work/alpha";
const OTHER = "/work/beta";

let clock = 0;
/** Each message gets its own timestamp unless a copy needs the original's. */
function message(id, parentId, role, text, timestamp = new Date(Date.UTC(2026, 9, 1) + 1000 * ++clock).toISOString()) {
  const content = role === "user" ? text : [{ type: "text", text }];
  return JSON.stringify({ type: "message", id, parentId, timestamp, message: { role, content } });
}

function compaction(id, parentId, firstKeptEntryId) {
  return JSON.stringify({
    type: "compaction",
    id,
    parentId,
    timestamp: "2026-10-01T01:00:00.000Z",
    summary: "summary mentions the correction too",
    firstKeptEntryId,
    tokensBefore: 1000,
  });
}

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "session-recall-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

/** A saved session file plus the row the session list would give for it. */
function saved(dir, id, lines, { projectRoot = PROJECT, cwd = projectRoot, modified = "2026-10-02T00:00:00.000Z" } = {}) {
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${[JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: modified }), ...lines].join("\n")}\n`);
  return { path, id, cwd, projectRoot, created: modified, modified, messageCount: lines.length, firstMessage: "" };
}

/** The calling session: a real in-memory SessionManager with `build(manager)` appended. */
function liveSession(build = () => {}) {
  const manager = SessionManager.inMemory(PROJECT);
  build(manager);
  return manager;
}

function deps(sessions, { archived = [], limits = {}, now = Date.now } = {}) {
  return {
    listSessions: async () => sessions,
    archivedIds: () => new Set(archived),
    projectRootOf: async () => PROJECT,
    now,
    limits: { ...SESSION_RECALL_LIMITS, ...limits },
  };
}

async function call(current, params, options) {
  const tool = createSessionRecallTool(options);
  const result = await tool.execute("call-1", params, undefined, { sessionManager: current }, undefined);
  const text = result.content[0].text;
  return { text, body: JSON.parse(text), details: result.details };
}

async function rejects(current, params, options, pattern) {
  const tool = createSessionRecallTool(options);
  await assert.rejects(() => tool.execute("call-1", params, undefined, { sessionManager: current }, undefined), pattern);
}

test("F1: a correction the current session compacted away is found, while the UI search still leaves it out", () => withDir(async (dir) => {
  const ids = {};
  const current = liveSession((m) => {
    ids.first = m.appendMessage({ role: "user", content: "deploy to the staging cluster", timestamp: 1 });
    ids.fix = m.appendMessage({ role: "user", content: "correction: deploy to the canary cluster, not staging", timestamp: 2 });
    ids.kept = m.appendMessage({ role: "user", content: "now continue the deploy on that cluster", timestamp: 3 });
    m.appendCompaction("summary: deploy cluster", undefined, ids.kept, 1000);
    m.appendMessage({ role: "assistant", content: [{ type: "text", text: "deploy continues" }], timestamp: 4 });
  });
  const { body } = await call(current, { query: "deploy cluster" }, deps([]));
  assert.equal(body.status, "complete");
  assert.deepEqual(body.hits.map((hit) => [hit.entryId, hit.compacted, hit.currentSession]), [
    [ids.first, true, true],
    [ids.fix, true, true],
  ]);
  // The kept message is still in the model's context, so it is neither searched nor returned.
  assert.equal(body.inContextHits, 0);
  assert.match(body.note, /not a current instruction or approval/);

  // Ctrl+K's contract for the same history in a saved file stays as it was.
  const file = saved(dir, "ui", [
    message("u1", null, "user", "deploy to the staging cluster"),
    message("u2", "u1", "user", "correction: deploy to the canary cluster"),
    message("u3", "u2", "user", "now continue"),
    compaction("c1", "u3", "u3"),
  ]);
  const ui = await searchTranscripts([file], "canary");
  assert.equal(ui.hits.length, 0);
  assert.equal(ui.compactedHits, 1);
  const other = await call(liveSession(), { query: "canary" }, deps([file]));
  assert.deepEqual(other.body.hits.map((hit) => [hit.entryId, hit.compacted]), [["u2", true]]);
}));

test("F2: abandoned branches are counted but never returned, in search or as an anchor", () => withDir(async (dir) => {
  // u2 was abandoned: the branch continued from u1 to u3, the last entry.
  const file = saved(dir, "branchy", [
    message("u1", null, "user", "start the rollout"),
    message("u2", "u1", "user", "rollback everything now"),
    message("u3", "u1", "user", "keep the rollout going"),
  ]);
  const options = deps([file]);
  const { body } = await call(liveSession(), { query: "rollback" }, options);
  assert.deepEqual(body.hits, []);
  assert.equal(body.offBranchHits, 1);
  await rejects(liveSession(), { session_id: "branchy", entry_id: "u2" }, options, /abandoned branch/);
  const read = await call(liveSession(), { session_id: "branchy", entry_id: "u3", radius: 2 }, options);
  assert.deepEqual(read.body.entries.map((entry) => entry.entryId), ["u1", "u3"]);

  // The calling session's own abandoned branch is refused the same way.
  let abandoned;
  const current = liveSession((m) => {
    const root = m.appendMessage({ role: "user", content: "first", timestamp: 1 });
    abandoned = m.appendMessage({ role: "user", content: "rollback branch", timestamp: 2 });
    m.branch(root);
    m.appendMessage({ role: "user", content: "other branch", timestamp: 3 });
  });
  await rejects(current, { session_id: current.getSessionId(), entry_id: abandoned }, options, /abandoned branch/);
}));

test("F3: other projects and archived sessions need explicit arguments and carry labels", () => withDir(async (dir) => {
  const worktree = saved(dir, "wt", [message("w1", null, "user", "budget figure from the worktree")], {
    cwd: `${PROJECT}-worktrees/feature`,
    modified: "2026-10-03T00:00:00.000Z",
  });
  const foreign = saved(dir, "foreign", [message("f1", null, "user", "budget figure elsewhere")], { projectRoot: OTHER });
  const shelved = saved(dir, "shelved", [message("a1", null, "user", "budget figure archived")]);
  const options = deps([worktree, foreign, shelved], { archived: ["shelved"] });

  const narrow = await call(liveSession(), { query: "budget figure" }, options);
  assert.deepEqual(narrow.body.hits.map((hit) => hit.entryId), ["w1"]);
  assert.deepEqual(narrow.body.excludedSessions, { archived: 1, otherProjects: 1 });
  assert.equal(narrow.body.hits[0].project, undefined);

  const wide = await call(liveSession(), { query: "budget figure", scope: "all_projects", include_archived: true }, options);
  const byId = Object.fromEntries(wide.body.hits.map((hit) => [hit.entryId, hit]));
  assert.deepEqual(Object.keys(byId).sort(), ["a1", "f1", "w1"]);
  assert.equal(byId.f1.project, OTHER);
  assert.equal(byId.w1.project, PROJECT);
  assert.equal(byId.a1.archived, true);
  assert.equal(byId.f1.archived, undefined);

  await rejects(liveSession(), { session_id: "foreign", entry_id: "f1" }, options, /another project; pass scope/);
  await rejects(liveSession(), { session_id: "shelved", entry_id: "a1" }, options, /archived; pass include_archived/);
  const read = await call(liveSession(), { session_id: "foreign", entry_id: "f1", scope: "all_projects" }, options);
  assert.equal(read.body.project, OTHER);
  assert.equal(read.body.entries[0].anchor, true);
}));

test("F4: a deleted file is reported without its path and is not recreated; torn lines are counted", () => withDir(async (dir) => {
  const gone = saved(dir, "gone", [message("g1", null, "user", "vanishing words")]);
  rmSync(gone.path);
  const torn = saved(dir, "torn", [
    message("t1", null, "user", "vanishing words survive"),
    "{\"type\":\"message\",\"id\":\"bad\"",
    message("t2", "t1", "assistant", "after the torn line"),
  ]);
  // An unterminated last line is an append still in progress, not a malformed record.
  writeFileSync(torn.path, `${readFileSync(torn.path, "utf8")}{"type":"message","id":"tail","parentId":"t2"`);
  const bytes = readFileSync(torn.path);
  const options = deps([gone, torn]);

  const { body } = await call(liveSession(), { query: "vanishing" }, options);
  assert.deepEqual(body.hits.map((hit) => hit.entryId), ["t1"]);
  assert.equal(body.unreadableSessions, 1);
  // A skipped session makes the search partial, not an exhaustive "nothing there".
  assert.equal(body.status, "partial");
  assert.deepEqual(body.incomplete, ["unreadable"]);
  assert.equal(body.malformedRecords, 1);
  const read = await call(liveSession(), { session_id: "torn", entry_id: "t1", radius: 1 }, options);
  assert.deepEqual(read.body.entries.map((entry) => entry.entryId), ["t1", "t2"]);
  assert.equal(read.body.malformedRecords, 1);
  const error = await createSessionRecallTool(options)
    .execute("c", { session_id: "gone", entry_id: "g1" }, undefined, { sessionManager: liveSession() }, undefined)
    .catch((caught) => caught);
  assert.match(error.message, /no longer available/);
  assert.equal(error.message.includes(dir), false);
  assert.equal(existsSync(gone.path), false);
  assert.deepEqual(readFileSync(torn.path), bytes);
}));

test("F5: bad anchors and incompatible arguments are refused instead of guessed", () => withDir(async (dir) => {
  const a = saved(dir, "a", [
    message("a1", null, "user", "alpha words"),
    JSON.stringify({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-10-01T00:00:09.000Z", message: { role: "toolResult", content: [{ type: "text", text: "tool output" }] } }),
  ]);
  const b = saved(dir, "b", [message("b1", null, "user", "beta words")]);
  const options = deps([a, b]);
  const current = liveSession((m) => m.appendMessage({ role: "user", content: "still in context", timestamp: 1 }));
  const inContext = current.getBranch()[0].id;

  await rejects(current, { session_id: "a", entry_id: "nope" }, options, /not found in that session/);
  await rejects(current, { session_id: "a", entry_id: "b1" }, options, /not found in that session/);
  await rejects(current, { session_id: "a", entry_id: "r1" }, options, /user or assistant message/);
  await rejects(current, { session_id: current.getSessionId(), entry_id: inContext }, options, /still in your current context/);
  await rejects(current, { session_id: "missing", entry_id: "a1" }, options, /not a saved session/);
  await rejects(current, { query: "alpha", session_id: "a", entry_id: "a1" }, options, /not both/);
  await rejects(current, { session_id: "a" }, options, /both session_id and entry_id/);
  await rejects(current, { session_id: "a", entry_id: "a1", radius: 9 }, options, /radius must be an integer from 0 to 8/);
  await rejects(current, { session_id: "a", entry_id: "a1", radius: -1 }, options, /radius must be an integer/);
  await rejects(current, { session_id: "a", entry_id: "a1", radius: 1.5 }, options, /Invalid session_recall arguments|radius must be an integer/);
  await rejects(current, { query: "x" }, options, /at least 2 characters/);
  await rejects(current, { query: "x".repeat(201) }, options, /limited to 200 characters/);
  await rejects(current, {}, options, /Pass query to search/);
  await rejects(current, { scope: "everywhere", query: "alpha" }, options, /Invalid session_recall arguments/);
}));

test("F6: results, bytes and the serialized response stay within their limits and say so", () => withDir(async (dir) => {
  const sessions = [];
  for (let n = 0; n < 6; n++) {
    sessions.push(saved(dir, `s${n}`, [
      message("m1", null, "user", `limit marker one ${n}`),
      message("m2", "m1", "user", `limit marker two ${n}`),
      message("m3", "m2", "user", `limit marker three ${n}`),
    ], { modified: `2026-10-0${n + 1}T00:00:00.000Z` }));
  }
  const many = await call(liveSession(), { query: "limit marker" }, deps(sessions));
  assert.equal(many.body.hits.length, 8);
  assert.equal(many.body.status, "partial");
  assert.deepEqual(many.body.incomplete, ["per_session", "results"]);
  // Newest session first, its latest two messages, listed oldest first.
  assert.deepEqual(many.body.hits.slice(0, 2).map((hit) => [hit.sessionId, hit.entryId]), [["s5", "m2"], ["s5", "m3"]]);
  assert.ok(many.body.perSessionCapped >= 4);

  const tiny = await call(liveSession(), { query: "limit marker" }, deps(sessions, { limits: { maxBytes: 10 } }));
  assert.deepEqual(tiny.body.hits, []);
  assert.deepEqual(tiny.body.incomplete, ["bytes"]);
  assert.match(tiny.body.note, /does not show the text was never said/);

  const long = "x".repeat(10_000);
  const lines = [message("l0", null, "user", `anchor text ${long}`)];
  for (let n = 1; n <= 17; n++) lines.push(message(`l${n}`, `l${n - 1}`, n % 2 ? "assistant" : "user", `${n} ${long}`));
  const big = saved(dir, "big", lines);
  const read = await call(liveSession(), { session_id: "big", entry_id: "l8", radius: 8 }, deps([big]));
  assert.ok(read.text.length <= 24_000, `response is ${read.text.length} characters`);
  assert.deepEqual(read.body.incomplete, ["output"]);
  assert.match(read.body.note, /Incomplete \(output\)/);
  assert.ok(read.body.omittedEntries > 0);
  const anchor = read.body.entries.find((entry) => entry.anchor);
  assert.equal(anchor.entryId, "l8");
  assert.equal(anchor.text.length, 4_001);
  assert.ok(read.body.entries.every((entry) => entry.clipped && entry.chars > 10_000));
  assert.ok(read.body.entries.filter((entry) => !entry.anchor).every((entry) => entry.text.length === 1_501));
}));

test("F6: an index the time budget cut short returns no unverified hits", () => withDir(async (dir) => {
  const lines = [];
  for (let n = 0; n < 40; n++) lines.push(message(`e${n}`, n ? `e${n - 1}` : null, "user", `slow words ${n}`));
  const slow = saved(dir, "slow", lines);
  let tick = 0;
  const { body } = await call(liveSession(), { query: "slow words" }, deps([slow], { now: () => tick++, limits: { maxMs: 12 } }));
  assert.deepEqual(body.hits, []);
  assert.deepEqual(body.incomplete, ["time"]);
  assert.ok(body.unverifiedHits > 0);
  assert.match(body.note, /withheld because their branch could not be checked/);
}));

test("F6: the calling session's in-memory history obeys the same byte and output limits", async () => {
  const long = "y".repeat(10_000);
  const ids = [];
  const current = liveSession((m) => {
    for (let n = 0; n < 17; n++) ids.push(m.appendMessage({ role: "user", content: `needle ${n} ${long}`, timestamp: n }));
    const kept = m.appendMessage({ role: "user", content: "kept", timestamp: 99 });
    m.appendCompaction("summary", undefined, kept, 1000);
  });
  const self = current.getSessionId();

  // Scanned newest first: the third 10 KB message no longer fits 25 KB.
  const search = await call(current, { query: "needle" }, deps([], { limits: { maxBytes: 25_000 } }));
  assert.deepEqual(search.body.hits.map((hit) => hit.entryId), [ids[15], ids[16]]);
  assert.deepEqual(search.body.incomplete, ["bytes"]);

  const wide = await call(current, { session_id: self, entry_id: ids[8], radius: 8 }, deps([]));
  assert.ok(wide.text.length <= 24_000, `response is ${wide.text.length} characters`);
  assert.deepEqual(wide.body.incomplete, ["output"]);
  assert.ok(wide.body.omittedEntries > 0);
  assert.equal(wide.body.entries.find((entry) => entry.anchor).entryId, ids[8]);

  // Nearest first: the anchor, then the message before it; the one after no longer fits.
  const narrow = await call(current, { session_id: self, entry_id: ids[8], radius: 8 }, deps([], { limits: { maxBytes: 25_000 } }));
  assert.deepEqual(narrow.body.entries.map((entry) => entry.entryId), [ids[7], ids[8]]);
  assert.deepEqual(narrow.body.incomplete, ["bytes"]);
});

test("F7: fork copies come back once, context copies not at all, and neither eats the per-session limit", () => withDir(async (dir) => {
  const at = (second) => `2026-09-20T00:00:${String(second).padStart(2, "0")}.000Z`;
  const older = saved(dir, "older", [
    message("o0", null, "user", "shared plan unique to older", at(1)),
    message("o1", "o0", "user", "shared plan origin", at(2)),
    message("d1", "o1", "user", "shared plan copied one", at(3)),
    message("d2", "d1", "user", "shared plan copied two", at(4)),
  ], { modified: "2026-10-01T00:00:00.000Z" });
  // A fork keeps ids and timestamps; it adds its own message after the copy.
  const fork = saved(dir, "fork", [
    message("o1", null, "user", "shared plan origin", at(2)),
    message("f1", "o1", "user", "shared plan fork only", at(5)),
  ], { modified: "2026-10-02T00:00:00.000Z" });
  // The same 8-hex id by chance in an unrelated session is not a copy.
  const stranger = saved(dir, "stranger", [message("o1", null, "user", "shared plan stranger", at(9))], {
    modified: "2026-09-30T00:00:00.000Z",
  });
  // d1 and d2 are in the caller's context with the same id, timestamp and role.
  const contextEntries = readFileSync(older.path, "utf8").trim().split("\n").slice(3).map((line) => JSON.parse(line));
  const caller = {
    getSessionId: () => "caller",
    getSessionFile: () => undefined,
    getCwd: () => PROJECT,
    getEntry: () => undefined,
    getBranch: () => contextEntries,
  };
  const { body } = await call(caller, { query: "shared plan" }, deps([older, fork, stranger]));
  // Capping before dedup would keep only d1 and d2 of "older" and then drop both, losing o0.
  assert.deepEqual(body.hits.map((hit) => [hit.sessionId, hit.entryId]), [
    ["fork", "o1"],
    ["fork", "f1"],
    ["older", "o0"],
    ["stranger", "o1"],
  ]);
  assert.equal(body.inContextHits, 2);
  assert.equal(body.duplicateHits, 1);
  assert.equal(body.perSessionCapped, 0);
  assert.equal(body.status, "complete");
}));

test("F8: credentials are masked before text is cut, and a credential query is refused", () => withDir(async (dir) => {
  const anthropic = `sk-ant-api03-${"Ab3dE".repeat(10)}`;
  const github = `ghp_${"a1B2c3D4e5".repeat(4)}`;
  const leaky = saved(dir, "leaky", [
    message("k1", null, "user", `use key ${anthropic} for the canary deploy`),
    message("k2", "k1", "assistant", `noted, token ${github} also set for canary`),
  ]);
  const options = deps([leaky]);
  const search = await call(liveSession(), { query: "canary" }, options);
  assert.equal(search.body.hits.length, 2);
  assert.ok(search.body.redacted >= 2);
  const read = await call(liveSession(), { session_id: "leaky", entry_id: "k1", radius: 1 }, options);
  for (const text of [search.text, read.text]) {
    assert.equal(text.includes(anthropic), false);
    assert.equal(text.includes(github), false);
    assert.equal(text.includes("Ab3dEAb3dE"), false);
  }
  assert.match(read.body.entries[0].text, /\[REDACTED\]/);
  await rejects(liveSession(), { query: github }, options, /looks like a credential/);
}));

test("R1: one byte budget covers both passes of a read, so a reread it cannot afford is partial", () => withDir(async (dir) => {
  const lines = [];
  for (let n = 0; n < 30; n++) lines.push(message(`c${n}`, n ? `c${n - 1}` : null, "user", `two pass words ${n}`));
  const file = saved(dir, "two-pass", lines);
  const size = statSync(file.path).size;
  // The index fits; the reread for the last message would need the file again.
  const short = await call(liveSession(), { session_id: "two-pass", entry_id: "c29", radius: 1 }, deps([file], { limits: { maxBytes: size + 100 } }));
  assert.deepEqual(short.body.entries, []);
  assert.deepEqual(short.body.incomplete, ["bytes"]);
  assert.ok(short.body.scannedBytes <= size + 100, `read ${short.body.scannedBytes} bytes`);
  const full = await call(liveSession(), { session_id: "two-pass", entry_id: "c29", radius: 1 }, deps([file], { limits: { maxBytes: 2 * size } }));
  assert.deepEqual(full.body.entries.map((entry) => entry.entryId), ["c28", "c29"]);
  assert.deepEqual(full.body.incomplete, []);
}));

test("R2: a session rewritten while it is read is withheld, in search and in read", () => withDir(async (dir) => {
  const lines = [];
  for (let n = 0; n < 40; n++) lines.push(message(`w${n}`, n ? `w${n - 1}` : null, "user", `moving words ${n}`));
  const moving = saved(dir, "moving", lines, { modified: "2026-10-05T00:00:00.000Z" });
  const steady = saved(dir, "steady", [message("s1", null, "user", "moving words steady")], { modified: "2026-10-01T00:00:00.000Z" });
  const original = readFileSync(moving.path, "utf8");
  // The stream asks the clock once per record: rewrite in place (same inode, new size) on the `at`-th reading.
  const rewriteAt = (at) => {
    let calls = 0;
    return () => {
      if (++calls === at) writeFileSync(moving.path, `${original}${message("w40", "w39", "user", "appended")}\n`);
      return 0;
    };
  };

  const search = await call(liveSession(), { query: "moving words" }, deps([moving, steady], { now: rewriteAt(20) }));
  assert.deepEqual(search.body.hits.map((hit) => hit.sessionId), ["steady"]);
  assert.deepEqual(search.body.incomplete, ["changed"]);
  assert.ok(search.body.unverifiedHits > 0);

  writeFileSync(moving.path, original);
  // An undisturbed read of the last message streams the file twice; rewrite halfway through the second pass.
  let calls = 0;
  const request = { session_id: "moving", entry_id: "w39", radius: 1 };
  const clean = await call(liveSession(), request, deps([moving, steady], { now: () => (calls++, 0) }));
  assert.deepEqual(clean.body.entries.map((entry) => entry.entryId), ["w38", "w39"]);
  const read = await call(liveSession(), request, deps([moving, steady], { now: rewriteAt(calls - 20) }));
  assert.deepEqual(read.body.entries, []);
  assert.deepEqual(read.body.incomplete, ["changed"]);
  assert.match(read.body.note, /changed while it was read/);
}));

test("R3: an unreadable archive list discloses nothing instead of reading as nothing archived", () => withDir(async (dir) => {
  const file = saved(dir, "plain", [message("p1", null, "user", "registry words")]);
  const broken = {
    ...deps([file]),
    archivedIds: () => {
      throw new Error(`EACCES: ${join(dir, "cuelo-archived.json")}`);
    },
  };
  const error = await createSessionRecallTool(broken)
    .execute("c", { query: "registry words" }, undefined, { sessionManager: liveSession() }, undefined)
    .catch((caught) => caught);
  assert.match(error.message, /archived-session list could not be read/);
  assert.equal(error.message.includes(dir), false);
  await rejects(liveSession(), { session_id: "plain", entry_id: "p1" }, broken, /archived-session list could not be read/);
}));

test("R4: an archived calling session follows the same archive rule as any other", async () => {
  const ids = {};
  const current = liveSession((m) => {
    ids.old = m.appendMessage({ role: "user", content: "archived words early", timestamp: 1 });
    ids.kept = m.appendMessage({ role: "user", content: "kept in context", timestamp: 2 });
    m.appendCompaction("summary", undefined, ids.kept, 10);
  });
  const self = current.getSessionId();
  const options = deps([], { archived: [self] });
  const hidden = await call(current, { query: "archived words" }, options);
  assert.deepEqual(hidden.body.hits, []);
  assert.deepEqual(hidden.body.excludedSessions, { archived: 1, otherProjects: 0 });
  await rejects(current, { session_id: self, entry_id: ids.old }, options, /This session is archived/);

  const shown = await call(current, { query: "archived words", include_archived: true }, options);
  assert.deepEqual(shown.body.hits.map((hit) => [hit.entryId, hit.archived]), [[ids.old, true]]);
  const read = await call(current, { session_id: self, entry_id: ids.old, include_archived: true }, options);
  assert.deepEqual(read.body.entries.map((entry) => entry.entryId), [ids.old]);
  // The neighbour after the compaction is still in context: left out and counted.
  assert.equal(read.body.inContextEntries, 1);
});

test("R5: another session's window leaves out copies still in the caller's context", () => withDir(async (dir) => {
  const at = (second) => `2026-09-21T00:00:0${second}.000Z`;
  const shared = [message("p1", null, "user", "shared start", at(1)), message("p2", "p1", "assistant", "shared reply", at(2))];
  const parent = saved(dir, "parent", [
    ...shared,
    message("p3", "p2", "user", "parent only question", at(3)),
    message("p4", "p3", "assistant", "parent only answer", at(4)),
  ]);
  // The caller was forked after p2, so p1 and p2 are copies in its context.
  const contextEntries = shared.map((line) => JSON.parse(line));
  const caller = {
    getSessionId: () => "caller",
    getSessionFile: () => undefined,
    getCwd: () => PROJECT,
    getEntry: () => undefined,
    getBranch: () => contextEntries,
  };
  const read = await call(caller, { session_id: "parent", entry_id: "p3", radius: 2 }, deps([parent]));
  assert.deepEqual(read.body.entries.map((entry) => entry.entryId), ["p3", "p4"]);
  assert.equal(read.body.inContextEntries, 2);
  await rejects(caller, { session_id: "parent", entry_id: "p2" }, deps([parent]), /still in your current context/);
}));

test("R6: time spent listing sessions counts against the per-call budget", () => withDir(async (dir) => {
  const file = saved(dir, "slow", [message("s1", null, "user", "listing words")]);
  // The clock starts with the call; listing alone uses up the whole budget.
  const slowListing = () => {
    let elapsed = 0;
    return {
      ...deps([file], { now: () => elapsed }),
      listSessions: async () => {
        elapsed = SESSION_RECALL_LIMITS.maxMs;
        return [file];
      },
    };
  };
  const search = await call(liveSession(), { query: "listing words" }, slowListing());
  assert.deepEqual(search.body.hits, []);
  assert.deepEqual(search.body.incomplete, ["time"]);
  assert.equal(search.body.scannedSessions, 0);
  const read = await call(liveSession(), { session_id: "slow", entry_id: "s1" }, slowListing());
  assert.deepEqual(read.body.entries, []);
  assert.deepEqual(read.body.incomplete, ["time"]);
}));

test("the wire schema offers exactly the six documented arguments", () => {
  const tool = createSessionRecallTool(deps([]));
  assert.equal(tool.name, SESSION_RECALL_TOOL_NAME);
  assert.equal(tool.approval, "read");
  const wire = toolWireSchema(tool);
  assert.equal(wire.type, "object");
  assert.deepEqual(Object.keys(wire.properties).sort(), ["entry_id", "include_archived", "query", "radius", "scope", "session_id"]);
  assert.deepEqual(wire.required ?? [], []);
  assert.deepEqual(wire.properties.scope.enum, ["project", "all_projects"]);
  assert.equal(wire.properties.radius.type, "integer");
});
