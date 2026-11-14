import { test } from "node:test";
import assert from "node:assert/strict";
import { dueRunKey, nextRunAt, parseSchedule, runStamp } from "./schedule.ts";
import { extractPostTitle, findTitleHeading, parseRoutinePost, serializeRoutinePost, splitPostDetails } from "./post.ts";
import { writeRoutineFile } from "./store.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEOUL = "Asia/Seoul";
const at = (iso) => new Date(iso);

test("weekly: every listed time is a slot, keyed by the Seoul date", () => {
  const daily = { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], times: ["13:00", "15:00"] };
  // 2026-11-13 13:00 KST is 04:00 UTC; 15:00 KST is 06:00 UTC.
  assert.equal(dueRunKey(daily, SEOUL, at("2026-11-13T04:00:00Z")), "2026-11-13T13:00");
  assert.equal(dueRunKey(daily, SEOUL, at("2026-11-13T04:04:59Z")), "2026-11-13T13:00");
  assert.equal(dueRunKey(daily, SEOUL, at("2026-11-13T06:02:00Z")), "2026-11-13T15:00");
  assert.equal(dueRunKey(daily, SEOUL, at("2026-11-13T03:59:59Z")), null);
});

test("no catch-up: a missed window stays missed", () => {
  const daily = { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], times: ["08:30"] };
  assert.equal(dueRunKey(daily, SEOUL, at("2026-11-12T23:35:00Z")), null);
  assert.equal(dueRunKey(daily, SEOUL, at("2026-11-13T05:00:00Z")), null);
});

test("weekday is read in the routine's timezone, and a window crossing midnight belongs to the day it started", () => {
  // Friday 2026-11-13 08:30 KST is still Thursday in UTC.
  assert.equal(dueRunKey({ kind: "weekly", days: [5], times: ["08:30"] }, SEOUL, at("2026-11-12T23:31:00Z")), "2026-11-13T08:30");
  assert.equal(dueRunKey({ kind: "weekly", days: [4], times: ["08:30"] }, SEOUL, at("2026-11-12T23:31:00Z")), null);
  // 2026-11-14 00:01 KST (Saturday) is still inside Friday's 23:58 window.
  assert.equal(dueRunKey({ kind: "weekly", days: [5], times: ["23:58"] }, SEOUL, at("2026-11-13T15:01:00Z")), "2026-11-13T23:58");
  assert.equal(dueRunKey({ kind: "weekly", days: [6], times: ["23:58"] }, SEOUL, at("2026-11-13T15:01:00Z")), null);
});

test("hourly: every N hours at a minute, aligned to startHour, optionally limited to days", () => {
  const everyHour = { kind: "hourly", everyHours: 1, minute: 39 };
  assert.equal(dueRunKey(everyHour, SEOUL, at("2026-11-13T05:41:00Z")), "2026-11-13T14:39");
  assert.equal(dueRunKey(everyHour, SEOUL, at("2026-11-13T05:44:00Z")), null);
  const every4From1 = { kind: "hourly", everyHours: 4, minute: 20, startHour: 1 };
  // Slots at 01:20, 05:20, 09:20, 13:20, 17:20, 21:20 KST.
  assert.equal(dueRunKey(every4From1, SEOUL, at("2026-11-13T04:20:00Z")), "2026-11-13T13:20");
  assert.equal(dueRunKey(every4From1, SEOUL, at("2026-11-13T05:20:00Z")), null);
  const weekdaysOnly = { kind: "hourly", everyHours: 1, minute: 0, days: [1, 2, 3, 4, 5] };
  assert.equal(dueRunKey(weekdaysOnly, SEOUL, at("2026-11-13T05:00:00Z")), "2026-11-13T14:00"); // Friday
  assert.equal(dueRunKey(weekdaysOnly, SEOUL, at("2026-11-14T05:00:00Z")), null); // Saturday
});

test("once: only its own date and time", () => {
  const once = { kind: "once", date: "2026-11-13", time: "14:39" };
  assert.equal(dueRunKey(once, SEOUL, at("2026-11-13T05:40:00Z")), "2026-11-13T14:39");
  assert.equal(dueRunKey(once, SEOUL, at("2026-11-14T05:40:00Z")), null);
  // A future once slot is its own next run however far away it is; a past one has none.
  assert.equal(nextRunAt({ kind: "once", date: "2026-11-25", time: "09:00" }, SEOUL, at("2026-11-13T06:00:00Z"))?.toISOString(), "2026-11-25T00:00:00.000Z");
  assert.equal(nextRunAt({ kind: "once", date: "2027-07-01", time: "19:00" }, SEOUL, at("2026-11-13T06:00:00Z"))?.toISOString(), "2027-07-01T10:00:00.000Z");
  assert.equal(nextRunAt({ kind: "once", date: "2026-11-01", time: "19:00" }, SEOUL, at("2026-11-13T06:00:00Z")), null);
  assert.equal(nextRunAt(once, SEOUL, at("2026-11-13T05:40:00Z")), null);
  assert.equal(nextRunAt(once, SEOUL, at("2026-11-13T05:00:00Z"))?.toISOString(), "2026-11-13T05:39:00.000Z");
});

test("next run follows the schedule in the routine's timezone", () => {
  const daily = { kind: "weekly", days: [0, 1, 2, 3, 4, 5, 6], times: ["13:00", "15:00"] };
  assert.equal(nextRunAt(daily, SEOUL, at("2026-11-13T04:00:30Z"))?.toISOString(), "2026-11-13T06:00:00.000Z");
  assert.equal(nextRunAt(daily, SEOUL, at("2026-11-13T07:00:00Z"))?.toISOString(), "2026-11-14T04:00:00.000Z");
  const every4From1 = { kind: "hourly", everyHours: 4, minute: 20, startHour: 1 };
  assert.equal(nextRunAt(every4From1, SEOUL, at("2026-11-13T04:21:00Z"))?.toISOString(), "2026-11-13T08:20:00.000Z");
});

test("schedule parsing rejects malformed shapes", () => {
  assert.equal(typeof parseSchedule({ kind: "weekly", days: [], times: ["09:00"] }), "string");
  assert.equal(typeof parseSchedule({ kind: "hourly", everyHours: 13, minute: 0 }), "string");
  assert.equal(typeof parseSchedule({ kind: "once", date: "2026-13-01", time: "09:00" }), "string");
  assert.deepEqual(parseSchedule({ kind: "weekly", days: [3, 1, 1], times: ["15:00", "13:00"] }), { kind: "weekly", days: [1, 3], times: ["13:00", "15:00"] });
});

test("run stamp uses the routine's local time", () => {
  assert.deepEqual(runStamp(at("2026-11-12T23:30:12Z"), SEOUL), { display: "2026-11-13 08:30", file: "20261113T0830" });
});

test("post serialize/parse round trip keeps meta and body", () => {
  const post = {
    title: "[갤] 따옴표 \"와\" 콜론: 그리고 ---",
    routineId: "r-20261113-abc123",
    host: "cuelo-home",
    status: "timeout",
    startedAt: "2026-11-12T23:30:00.000Z",
    finishedAt: "2026-11-13T00:30:00.000Z",
    sessionId: "01a1d335-cfd6-7600-8824-848c47b7aef8",
    body: "# [갤] 제목\n\n본문 첫 줄\n둘째 줄\n\n---\n\n## 댓글\n\n↳ **글쓴이**\n답글",
  };
  const text = serializeRoutinePost(post);
  assert.ok(text.startsWith("---\ntitle: "));
  assert.deepEqual(parseRoutinePost(text), post);
  assert.deepEqual(parseRoutinePost(serializeRoutinePost({ ...post, sessionId: null })), { ...post, sessionId: null });
});

test("parse rejects a file without front matter and reads unknown status as failed", () => {
  assert.equal(parseRoutinePost("# 그냥 markdown"), null);
  const parsed = parseRoutinePost("---\ntitle: \"t\"\nroutineId: \"r\"\nstatus: \"weird\"\n---\n\nbody");
  assert.equal(parsed?.status, "failed");
  assert.equal(parsed?.body, "body");
});

test("title is the first top-level heading outside code fences, else name + time", () => {
  const answer = "```md\n# 코드 안 제목\n```\n\n## 소제목\n\n# [AI노동갤] 진짜 제목 #\n\n# 두 번째";
  assert.equal(extractPostTitle(answer, "AI 일상갤", "2026-11-13 08:30"), "[AI노동갤] 진짜 제목");
  assert.equal(extractPostTitle("## 소제목만\n본문", "AI 일상갤", "2026-11-13 08:30"), "AI 일상갤 2026-11-13 08:30");
  assert.equal(extractPostTitle(`# ${"가".repeat(300)}`, "n", "t").length, 200);
});

test("a shorter fence line inside a longer fence does not close it", () => {
  const body = ["````markdown", "```", "# Title", "```", "````", "", "# Title", "Text"].join("\n");
  assert.deepEqual(findTitleHeading(body), { index: 6, text: "Title" });
});

test("details split at the first ## 자세히 heading outside code fences", () => {
  const body = ["# 제목", "짧은 본문임", "```md", "## 자세히", "```", "끝", "", "## 자세히", "", "| 표 |", "## 자세히", "둘째"].join("\n");
  assert.deepEqual(splitPostDetails(body), {
    summary: ["# 제목", "짧은 본문임", "```md", "## 자세히", "```", "끝"].join("\n"),
    details: ["| 표 |", "## 자세히", "둘째"].join("\n"),
  });
  assert.deepEqual(splitPostDetails("본문만\n## 자세히 보기\n표"), { summary: "본문만", details: "표" });
  assert.deepEqual(splitPostDetails("## 자세히히\n본문"), { summary: "## 자세히히\n본문", details: null });
  assert.deepEqual(splitPostDetails("요약\n## 자세히: 근거\n상세"), { summary: "요약", details: "상세" });
  assert.deepEqual(splitPostDetails("본문\n## 자세히\n\n"), { summary: "본문", details: null });
});

test("writing through a dangling routine.json symlink is refused", () => {
  const root = mkdtempSync(join(tmpdir(), "routines-link-"));
  try {
    const repo = join(root, "repo");
    const id = "r-20261113-12345678";
    mkdirSync(join(repo, "routines", id), { recursive: true });
    const outside = join(root, "outside.json");
    symlinkSync(outside, join(repo, "routines", id, "routine.json"));
    const routine = { id, name: "n", enabled: false, schedule: { kind: "once", date: "2026-12-01", time: "09:00" }, timezone: SEOUL, host: "h", prompt: "p", cwd: null, createdAt: "2026-11-13T00:00:00.000Z", updatedAt: "2026-11-13T00:00:00.000Z" };
    assert.throws(() => writeRoutineFile(repo, routine), /outside the repository/);
    assert.equal(existsSync(outside), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
