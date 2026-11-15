import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { threadState, pendingReplies, parseReplyBody, reserveReplyWrite, releaseReplyWrite, pendingReplyWrites } from "./reply";
import { waitingAnswer, parseRoutinePost, serializeRoutinePost, type RoutinePost } from "./post";
import { scheduledRun, dueRunKey, ROUTINE_TIMEZONE } from "./schedule";
import { parseRoutineDraft, defaultRoutineHost } from "./draft";
import { listPosts, readReplies, writePostFile, writeReplyFile, writeRoutineFile, type Routine } from "./store";

import { routinePushItems } from "./notifications";
const routine: Routine = { id: "test", name: "Test", host: "cloud", enabled: true, schedule: { kind: "hourly", everyHours: 1, minute: 0 }, timezone: ROUTINE_TIMEZONE, prompt: "Only what I said", cwd: null, model: null, createdAt: "2026-11-14T00:00:00Z", updatedAt: "2026-11-14T00:00:00Z" };
const post: RoutinePost = { title: "Question", routineId: "test", host: "cloud", status: "waiting", startedAt: routine.createdAt, finishedAt: routine.createdAt, sessionId: "session", body: "Which?" };

test("waiting marker is exact, stripped once, and status round trips; unknown remains failed", () => {
  assert.deepEqual(waitingAnswer("[답 필요]\r\nWhich?"), { status: "waiting", body: "Which?" });
  assert.equal(waitingAnswer(" [답 필요]\nWhich?").status, "ok");
  assert.equal(waitingAnswer("text\n[답 필요]").status, "ok");
  assert.equal(parseRoutinePost(serializeRoutinePost(post))?.status, "waiting");
  assert.equal(parseRoutinePost(serializeRoutinePost(post).replace('status: "waiting"', 'status: "future"'))?.status, "failed");
});

test("reply storage, thread states and containment match the API contract", () => {
  const dir = mkdtempSync(join(tmpdir(), "routine-thread-"));
  const outside = mkdtempSync(join(tmpdir(), "routine-outside-"));
  try {
    writeRoutineFile(dir, routine);
    const file = writePostFile(dir, routine.id, "20261114T0900", "cloud", post).split("/").at(-1)!;
    assert.equal(listPosts(dir, routine.id)[0].thread, "waiting");
    const user = writeReplyFile(dir, routine.id, file, { author: "user", host: "home", createdAt: "2026-11-15T00:00:00Z", body: "This" }).reply;
    assert.equal(listPosts(dir, routine.id)[0].thread, "pending");
    assert.deepEqual(pendingReplies([user]), [user]);
    assert.deepEqual(pendingReplies([user], [user.file]), []);
    const agent = writeReplyFile(dir, routine.id, file, { author: "agent", host: "cloud", createdAt: "2026-11-15T00:01:00Z", body: "Done", status: "ok", sessionId: "session", replyTo: [user.file] }).reply;
    const replies = readReplies(dir, routine.id, file);
    assert.deepEqual(replies, [user, agent]);
    assert.equal(listPosts(dir, routine.id)[0].replyCount, 2);
    const notices = routinePushItems(dir, Date.parse("2026-11-15T00:02:00Z"));
    assert.equal(notices.some((item) => item.key === `test/${file}`), false);
    assert.equal(notices.length, 1);
    assert.equal(notices[0].payload.body, "Done");
    assert.equal(threadState("ok", []), "none");
    assert.equal(threadState("ok", replies), "answered");
    assert.equal(threadState("ok", [user, { ...agent, status: "waiting" }]), "waiting");
    // A user reply arriving during execution is not swallowed by the later agent timestamp.
    const concurrent = { ...user, file: "other-user.md" };
    assert.deepEqual(pendingReplies([user, concurrent, agent]), [concurrent]);
    assert.equal(threadState("ok", [user, concurrent, agent]), "pending");
    assert.deepEqual(pendingReplies([user, concurrent, { ...agent, replyTo: undefined }]), []);
    symlinkSync(outside, join(dir, "routines", "test", "replies", "20261114T0901-cloud"));
    assert.deepEqual(readReplies(dir, "test", "20261114T0901-cloud.md"), []);
  } finally { rmSync(dir, { recursive: true }); rmSync(outside, { recursive: true }); }
});

test("reply body validation trims and enforces 1..8000", () => {
  for (const raw of [null, {}, { body: 3 }, { body: "  " }, { body: "a".repeat(8001) }]) assert.ok("error" in parseReplyBody(raw));
  assert.deepEqual(parseReplyBody({ body: " a " }), { body: "a" });
  assert.ok("body" in parseReplyBody({ body: "a".repeat(8000) }));
});

test("catch-up picks only latest missed slot inside two hours and after creation, once included", () => {
  const at = (time: string) => new Date(`2026-11-15T${time}+09:00`);
  const created = at("09:00:00").toISOString();
  const schedule = { kind: "hourly" as const, everyHours: 1, minute: 0 };
  assert.deepEqual(scheduledRun(schedule, ROUTINE_TIMEZONE, created, undefined, at("10:35:00")), { key: "2026-11-15T10:00", trigger: "catch-up" });
  assert.equal(scheduledRun(schedule, ROUTINE_TIMEZONE, created, "2026-11-15T10:00", at("10:35:00")), null);
  assert.equal(scheduledRun(schedule, ROUTINE_TIMEZONE, at("10:01:00").toISOString(), undefined, at("10:35:00")), null);
  const once = { kind: "once" as const, date: "2026-11-15", time: "08:00" };
  assert.equal(scheduledRun(once, ROUTINE_TIMEZONE, created, undefined, at("10:00:01")), null);
  assert.equal(scheduledRun(once, ROUTINE_TIMEZONE, created, undefined, at("10:00:00"))?.trigger, "catch-up");
  assert.equal(dueRunKey(schedule, ROUTINE_TIMEZONE, at("10:04:59")), "2026-11-15T10:00");
  assert.equal(dueRunKey(schedule, ROUTINE_TIMEZONE, at("10:05:00")), null);
  assert.equal(scheduledRun(schedule, ROUTINE_TIMEZONE, created, undefined, at("10:04:59"))?.trigger, "schedule");
});

test("draft validates model JSON and computes host defaults, never accepts model host", () => {
  const routines = [routine, { ...routine, id: "two" }, { ...routine, host: "home", enabled: false }];
  assert.equal(defaultRoutineHost([], "here"), "here");
  const raw = { name: "Task", prompt: "Only what I said", schedule: routine.schedule, host: "invented", oneOff: false };
  assert.equal(parseRoutineDraft(JSON.stringify(raw), routines, "here").draft.host, "cloud");
  const once = parseRoutineDraft(JSON.stringify({ ...raw, oneOff: true }), routines, "here", new Date("2026-11-15T00:23:00Z"));
  assert.equal(once.draft.host, "here");
  assert.deepEqual(once.draft.schedule, { kind: "once", date: "2026-11-15", time: "09:23" });
  assert.equal(once.draft.prompt, raw.prompt);
  for (const value of ["no json", "{}", JSON.stringify({ ...raw, schedule: { kind: "invalid" } }), JSON.stringify({ ...raw, prompt: "" })]) {
    assert.throws(() => parseRoutineDraft(value, routines, "here"));
  }
});

test("concurrent POST reservations are process-global and reference counted", () => {
  assert.equal(pendingReplyWrites, globalThis.__cueloPendingReplyWrites);
  reserveReplyWrite("test/post");
  reserveReplyWrite("test/post");
  releaseReplyWrite("test/post");
  assert.equal(pendingReplyWrites.get("test/post"), 1);
  releaseReplyWrite("test/post");
  assert.equal(pendingReplyWrites.has("test/post"), false);
});
