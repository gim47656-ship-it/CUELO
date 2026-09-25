import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  SIDE_CHAT_CHAR_LIMIT,
  SIDE_CHAT_INDEX_KEY,
  SIDE_CHAT_LOG_PREFIX,
  SIDE_CHAT_MAX_AGE_MS,
  SideChatNdjsonParser,
  createSideChatHistoryStore,
  createHanseSideChatClient,
} = await jiti.import("./hanse-sidechat-client.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    get length() {
      return values.size;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

test("bounds each session to 40 turns and 120000 characters", () => {
  const store = createSideChatHistoryStore(createStorage(), { now: () => 100 });
  for (let index = 0; index < 45; index += 1) {
    store.append("session-a", { q: `q-${index}`, a: `a-${index}`, at: index });
  }
  const turnBounded = store.read("session-a");
  assert.equal(turnBounded.length, 40);
  assert.equal(turnBounded[0].q, "q-5");

  for (let index = 0; index < 40; index += 1) {
    store.append("session-b", { q: "q".repeat(2_000), a: "a".repeat(2_000), at: index });
  }
  const charBounded = store.read("session-b");
  const chars = charBounded.reduce((total, turn) => total + turn.q.length + turn.a.length, 0);
  assert.ok(chars <= SIDE_CHAT_CHAR_LIMIT);
  assert.equal(charBounded.at(-1).at, 39);
});

test("keeps only the 20 most recently touched parent sessions", () => {
  const storage = createStorage();
  let clock = 0;
  const store = createSideChatHistoryStore(storage, { now: () => ++clock });
  for (let index = 0; index < 21; index += 1) {
    store.append(`session-${index}`, { q: "q", a: "a", at: clock });
  }

  const index = JSON.parse(storage.getItem(SIDE_CHAT_INDEX_KEY));
  assert.equal(index.length, 20);
  assert.equal(storage.getItem(`${SIDE_CHAT_LOG_PREFIX}session-0`), null);
  assert.deepEqual(store.read("session-0"), []);
  assert.equal(store.read("session-20").length, 1);
});

test("sends only the last six turns and clears only the selected session", () => {
  const store = createSideChatHistoryStore(createStorage(), { now: () => 100 });
  for (let index = 0; index < 8; index += 1) {
    store.append("session-a", { q: `q-${index}`, a: `a-${index}`, at: index });
  }
  store.append("session-b", { q: "other", a: "kept", at: 1 });

  assert.deepEqual(store.history("session-a").map((turn) => turn.q), ["q-2", "q-3", "q-4", "q-5", "q-6", "q-7"]);
  store.clear("session-a");
  assert.deepEqual(store.read("session-a"), []);
  assert.equal(store.read("session-b")[0].a, "kept");
});

test("cleans missing and seven-day-old sessions only from a complete census", () => {
  const storage = createStorage();
  let clock = 0;
  const store = createSideChatHistoryStore(storage, { now: () => clock });
  store.append("old", { q: "q", a: "a", at: 0 });
  store.append("current", { q: "q", a: "a", at: 0 });
  store.append("missing", { q: "q", a: "a", at: 0 });
  clock = SIDE_CHAT_MAX_AGE_MS + 1;

  store.cleanup({ sessions: [{ id: "old", modified: 0 }, { id: "current", modified: 0 }], complete: false }, "current");
  assert.equal(store.read("missing").length, 1);

  store.cleanup({ sessions: [{ id: "old", modified: 0 }, { id: "current", modified: 0 }], complete: true }, "current");
  assert.deepEqual(store.read("old"), []);
  assert.deepEqual(store.read("missing"), []);
  assert.equal(store.read("current").length, 1);

  // 신규 세션/아직 갱신되지 않은 목록: 지금 열려 있는 세션이 완전한 census에 없더라도
  // 그 이력은 지워지지 않고, 보호되지 않은 나머지 orphan 로그만 정리된다.
  store.append("race", { q: "race-q", a: "race-a", at: 0 });
  storage.setItem(`${SIDE_CHAT_LOG_PREFIX}unindexed`, JSON.stringify({ updatedAt: 0, entries: [{ q: "q", a: "a", at: 0 }] }));
  store.cleanup({ sessions: [{ id: "current", modified: clock }], complete: true }, "race");
  assert.equal(store.read("race").length, 1);
  assert.equal(store.read("race")[0].q, "race-q");
  assert.notEqual(storage.getItem(`${SIDE_CHAT_LOG_PREFIX}race`), null);
  assert.equal(storage.getItem(`${SIDE_CHAT_LOG_PREFIX}unindexed`), null);
  assert.equal(store.read("current").length, 1);
});

test("uses the in-memory copy when persistence fails and stored data is stale", () => {
  const key = `${SIDE_CHAT_LOG_PREFIX}session-a`;
  const values = new Map([[key, JSON.stringify({ updatedAt: 1, entries: [{ q: "old", a: "old", at: 1 }] })]]);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(name) { return values.get(name) ?? null; },
    setItem() {
      const error = new Error("full");
      error.name = "QuotaExceededError";
      throw error;
    },
    removeItem(name) { values.delete(name); },
  };
  const store = createSideChatHistoryStore(storage, { now: () => 2 });
  store.append("session-a", { q: "new", a: "answer", at: 2 });
  assert.deepEqual(store.read("session-a").map((turn) => turn.q), ["old", "new"]);
});

test("parses split NDJSON records and a final line without a newline", () => {
  const parser = new SideChatNdjsonParser();
  assert.deepEqual(parser.push('{"t":"d","v":"hel'), []);
  assert.deepEqual(parser.push('lo"}\n{"t":"m","v":"provider/model"}\n{"t":"done","v":"hello"}'), [
    { t: "d", v: "hello" },
    { t: "m", v: "provider/model" },
  ]);
  assert.deepEqual(parser.finish(), [{ t: "done", v: "hello" }]);
});

test("preserves UTF-8 characters split across byte chunks", () => {
  const bytes = new TextEncoder().encode('{"t":"d","v":"한글"}\n');
  const split = bytes.indexOf(0xed) + 1;
  const parser = new SideChatNdjsonParser();
  assert.deepEqual(parser.push(bytes.slice(0, split)), []);
  assert.deepEqual(parser.push(bytes.slice(split)), [{ t: "d", v: "한글" }]);
  assert.deepEqual(parser.finish(), []);
});

test("surfaces malformed NDJSON as an explicit stream error", () => {
  const parser = new SideChatNdjsonParser();
  parser.push("not-json");
  assert.throws(() => parser.finish(), (error) => error?.kind === "stream");
});

test("posts side chat through the same-origin route while preserving endpoint injection", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method });
    return new Response('{\"t\":\"done\",\"v\":\"answer\"}\n', {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  };
  const request = {
    sessionPath: "C:/sessions/session.jsonl",
    question: "question",
    history: [],
  };

  await createHanseSideChatClient(fetchImpl).ask(request);
  await createHanseSideChatClient(fetchImpl, "/test-sidechat").ask(request);

  assert.deepEqual(calls, [
    { url: "/api/sidecars/sidechat/ask", method: "POST" },
    { url: "/test-sidechat", method: "POST" },
  ]);
});
