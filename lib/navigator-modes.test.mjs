import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildPrioritySessionGroups,
  formatPriorityDateLabel,
  isTemporaryProjectPath,
  parseStoredNavigatorMode,
  PRIORITY_RECENT_SESSION_LIMIT,
  PRIORITY_REFRESH_MS,
  prioritySessionProjectName,
  prioritySessionTitle,
} = await jiti.import("./navigator-modes.ts");

function session(id, modified, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: `/work/${id}`,
    created: modified,
    modified,
    messageCount: 1,
    firstMessage: `message ${id}`,
    ...overrides,
  };
}

test("restores a native mode and migrates the former priority toggle", () => {
  assert.equal(parseStoredNavigatorMode("priority", "0"), "priority");
  assert.equal(parseStoredNavigatorMode("gpt6", "1"), "projects");
  assert.equal(parseStoredNavigatorMode("files", "0"), "projects");
  assert.equal(parseStoredNavigatorMode("unknown", "1"), "priority");
  assert.equal(parseStoredNavigatorMode(null, "0"), "projects");
  assert.equal(PRIORITY_REFRESH_MS, 15_000);
});

test("groups running sessions first and sorts every group by modified descending", () => {
  const now = new Date(2026, 7, 24, 12, 0, 0);
  const sessions = [
    session("today-old", "2026-08-24T08:00:00.000Z"),
    session("running-old", "2026-08-22T08:00:00.000Z"),
    session("yesterday", "2026-08-23T08:00:00.000Z"),
    session("running-new", "2026-08-24T09:00:00.000Z"),
    session("today-new", "2026-08-24T10:00:00.000Z"),
    session("transient", "2026-08-24T11:00:00.000Z", { transient: true }),
  ];

  const groups = buildPrioritySessionGroups(
    sessions,
    new Set(["running-old", "running-new"]),
    now,
    "en",
  );

  assert.equal(groups[0].key, "priority");
  assert.deepEqual(groups[0].sessions.map(({ id }) => id), ["running-new", "running-old"]);
  assert.deepEqual(groups[1].sessions.map(({ id }) => id), ["today-new", "today-old"]);
  assert.deepEqual(groups[2].sessions.map(({ id }) => id), ["yesterday"]);
  assert.equal(groups.flatMap(({ sessions: rows }) => rows).some(({ id }) => id === "transient"), false);
});

test("keeps pinned sessions above running and date groups without duplicates", () => {
  const now = new Date(2026, 7, 24, 12, 0, 0);
  const sessions = [
    session("running", "2026-08-24T10:00:00.000Z"),
    session("pinned-old", "2026-08-22T08:00:00.000Z"),
    session("today", "2026-08-24T09:00:00.000Z"),
    session("pinned-running", "2026-08-23T08:00:00.000Z"),
  ];

  const groups = buildPrioritySessionGroups(
    sessions,
    new Set(["running", "pinned-running"]),
    now,
    "en",
    "Running",
    new Set(["pinned-old", "pinned-running"]),
    "Pinned",
  );

  assert.deepEqual(groups.map(({ key }) => key), ["pinned", "priority", "2026-08-24"]);
  assert.deepEqual(groups[0].sessions.map(({ id }) => id), ["pinned-running", "pinned-old"]);
  assert.deepEqual(groups[1].sessions.map(({ id }) => id), ["running"]);
  assert.equal(
    groups.flatMap(({ sessions: rows }) => rows).filter(({ id }) => id === "pinned-running").length,
    1,
  );
});

test("limits completed priority rows while retaining every pinned and running session", () => {
  const now = new Date(2026, 7, 24, 12, 0, 0);
  const completed = Array.from({ length: 15 }, (_, index) => (
    session(`completed-${index}`, new Date(Date.UTC(2026, 7, 24, 10 - index)).toISOString())
  ));
  const sessions = [
    ...completed,
    session("running-old", "2026-08-01T08:00:00.000Z"),
    session("pinned-old", "2026-07-01T08:00:00.000Z"),
  ];

  const groups = buildPrioritySessionGroups(
    sessions,
    new Set(["running-old"]),
    now,
    "en",
    "Running",
    new Set(["pinned-old"]),
    "Pinned",
  );
  const rows = groups.flatMap(({ sessions: groupSessions }) => groupSessions);
  const completedRows = rows.filter(({ id }) => id.startsWith("completed-"));

  assert.equal(PRIORITY_RECENT_SESSION_LIMIT, 10);
  assert.equal(completedRows.length, PRIORITY_RECENT_SESSION_LIMIT);
  assert.deepEqual(
    completedRows.map(({ id }) => id),
    completed.slice(0, PRIORITY_RECENT_SESSION_LIMIT).map(({ id }) => id),
  );
  assert.equal(rows.some(({ id }) => id === "running-old"), true);
  assert.equal(rows.some(({ id }) => id === "pinned-old"), true);
});

test("formats today, yesterday, recent weekdays, and older dates by locale", () => {
  const now = new Date(2026, 7, 24, 12, 0, 0);
  assert.equal(formatPriorityDateLabel("2026-08-24", now, "en"), "today");
  assert.equal(formatPriorityDateLabel("2026-08-23", now, "en"), "yesterday");
  assert.equal(formatPriorityDateLabel("2026-08-20", now, "en"), "Thursday");
  assert.match(formatPriorityDateLabel("2026-08-01", now, "en"), /Aug 1/);
});

test("keeps legacy priority row titles and project basenames", () => {
  const value = session("123456789", "2026-08-24T08:00:00.000Z", {
    cwd: "C:\\work\\omp-web",
    name: "  Native   priority\nview  ",
  });
  assert.equal(prioritySessionTitle(value), "Native priority view");
  assert.equal(prioritySessionProjectName(value.cwd), "omp-web");
});

test("separates only roots, the temp tree and the OMP profile from work folders", () => {
  for (const temporary of [
    "C:\\",
    "E:/",
    "/",
    "C:\\Users\\user\\AppData\\Local\\Temp",
    "C:\\Users\\user\\AppData\\Local\\Temp\\omp-relay-session-Ab12Cd",
    "c:/users/user/appdata/local/temp/ompscope_1786928052656",
    "C:\\tmp",
    "E:\\tmp\\harness-yield-relay-20260912\\sessprobe",
    "C:\\Users\\user\\.omp\\agent",
    "/tmp/probe",
    "/var/tmp/probe",
    "/private/tmp/probe",
    "/home/x/.omp",
    "C:/Users/user/.omp",
    // eval 하네스는 실제 작업 폴더를 scratch 폴더 아래에 둔다(2026-09-25 사이드바 오염 실사례).
    "C:/Users/user/omp-cwd-20260924/oe-oe-mega-r1/mega-six/cuelo_anthropic_claude-opus-5-5_high/project",
    "C:\\Users\\user\\omp-cwd-20260924\\oe-x\\normal-ownedpaths\\none_x_x\\Tools\\OMP_Global_Config\\agent",
  ]) {
    assert.equal(isTemporaryProjectPath(temporary), true, temporary);
  }

  for (const work of [
    "E:\\Projects\\Tools",
    "E:\\Projects\\tmp",
    "E:\\Projects\\node_modules\\pkg",
    "C:\\Users\\user\\Documents\\ccrs-dashboard",
    "C:\\Users\\user\\Documents\\Codex\\outputs",
    "C:\\Windows\\System32",
    "/home/x/work/project",
    // 임시·profile 이름과 앞부분만 같은 이웃 디렉터리는 정상 프로젝트다.
    "C:\\Users\\user\\AppData\\Local\\TempArchive\\proj",
    "C:\\Users\\user\\AppData\\Local\\Temperature",
    "E:\\temperature\\proj",
    "E:\\tmpdata\\proj",
    "E:\\Projects\\.omp",
    "E:\\Projects\\.omp\\cache",
    "/srv/home/project",
    "",
  ]) {
    assert.equal(isTemporaryProjectPath(work), false, work);
  }
});
