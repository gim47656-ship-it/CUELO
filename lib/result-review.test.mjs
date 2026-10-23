import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  forgetSessions,
  isResultToCheck,
  markSessionOpened,
  parseResultReviewState,
  RESULT_REVIEW_MAX_ENTRIES,
  resultReviewToStore,
  serializeResultReviewState,
} = await jiti.import("./result-review.ts");

const T0 = Date.parse("2026-10-23T09:00:00.000Z");
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const session = (id, minutes, overrides = {}) => ({
  path: `/s/${id}.jsonl`, id, cwd: "/w", created: at(0), modified: at(minutes), messageCount: 2, firstMessage: id, ...overrides,
});
const none = new Set();

test("a first-time browser counts only activity after it started tracking", () => {
  const state = parseResultReviewState(null, T0 + 10 * 60_000);
  assert.equal(isResultToCheck(session("old", 5), none, state), false);
  assert.equal(isResultToCheck(session("new", 15), none, state), true);
});

test("opening a session clears it until it has newer activity", () => {
  let state = parseResultReviewState(null, T0);
  const done = session("a", 20);
  assert.equal(isResultToCheck(done, none, state), true);
  state = markSessionOpened(state, done, T0 + 21 * 60_000);
  assert.equal(isResultToCheck(done, none, state), false);
  assert.equal(isResultToCheck(session("a", 30), none, state), true);
});

test("a running session is never a result to check, and neither is a transient one", () => {
  const state = parseResultReviewState(null, T0);
  assert.equal(isResultToCheck(session("r", 20), new Set(["r"]), state), false);
  assert.equal(isResultToCheck(session("t", 20, { transient: true }), none, state), false);
});

test("a server clock ahead of the browser does not re-flag a session just opened", () => {
  let state = parseResultReviewState(null, T0);
  const ahead = session("a", 60);
  state = markSessionOpened(state, ahead, T0 + 30 * 60_000);
  assert.equal(isResultToCheck(ahead, none, state), false);
});

test("marking an older time keeps the same state object", () => {
  const state = markSessionOpened(parseResultReviewState(null, T0), session("a", 10), T0 + 20 * 60_000);
  assert.equal(markSessionOpened(state, session("a", 5), T0 + 15 * 60_000), state);
});

test("round-trips through storage, drops broken entries and keeps the newest when over the cap", () => {
  const restored = parseResultReviewState(JSON.stringify({ since: T0, opened: { a: T0 + 1, b: "x" } }), T0 + 99);
  assert.deepEqual(restored, { since: T0, opened: { a: T0 + 1 } });
  assert.deepEqual(parseResultReviewState("{not json", T0 + 5), { since: T0 + 5, opened: {} });

  const opened = {};
  for (let index = 0; index < RESULT_REVIEW_MAX_ENTRIES + 2; index += 1) opened[`s${index}`] = T0 + index;
  const kept = JSON.parse(serializeResultReviewState({ since: T0, opened })).opened;
  assert.equal(Object.keys(kept).length, RESULT_REVIEW_MAX_ENTRIES);
  assert.equal(kept.s0, undefined);
  assert.equal(kept.s1, undefined);
  assert.equal(kept[`s${RESULT_REVIEW_MAX_ENTRIES + 1}`], T0 + RESULT_REVIEW_MAX_ENTRIES + 1);
});

test("forgetting deleted sessions removes only their entries", () => {
  const state = { since: T0, opened: { a: 1, b: 2 } };
  assert.deepEqual(forgetSessions(state, ["a", "z"]), { since: T0, opened: { b: 2 } });
  assert.equal(forgetSessions(state, ["z"]), state);
});

test("two tabs writing in turn keep each other's opened sessions", () => {
  // Tab A started earlier and opened s1; tab B, loaded from the same storage, then opened s2 and wrote.
  const tabA = { since: T0, opened: { s1: T0 + 5_000 } };
  const storedByB = serializeResultReviewState({ since: T0 + 1_000, opened: { s1: T0 + 2_000, s2: T0 + 9_000 } });
  const written = parseResultReviewState(resultReviewToStore(storedByB, tabA, T0 + 10_000), T0 + 10_000);
  assert.deepEqual(written, { since: T0, opened: { s1: T0 + 5_000, s2: T0 + 9_000 } });
});
