import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NIGHTLY_PREAMBLE, NIGHTLY_PROBLEM_SECTION, NIGHTLY_SKILL_RULES, NIGHTLY_STATE_FILE, NIGHTLY_SUMMARY_RULES, NIGHTLY_WEEKLY_SECTION,
  nightlyStateAfterRun, planNightlyRun, readNightlyState, skillScanSince, weeklyReviewDue, writeNightlyState,
} from "./nightly.ts";
import { buildFullPrompt } from "./prompt.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
const report = () => structuredClone(fixture);
/** 2026-11-02 04:30 KST. UTC로는 아직 11-01이라 날짜를 UTC로 셌다면 어긋난다. */
const NOW = new Date("2026-11-01T19:30:00.000Z");
/** 주간 점검을 방금(같은 주에) 한 상태. 다른 계기만 보려는 시험의 기본값이다. */
const ranOn = (date, extra = {}) => ({ date, sessionId: "prev", worktree: "/w", startedAt: "2026-11-01T19:00:00.000Z", performanceReviewDate: "2026-10-30", ...extra });
const candidate = { memory: "update.sh 전에 stage 해시를 확인한다", topic: "deploy", sessionId: "S1", timestamp: "2026-10-31T03:00:00.000Z" };

function withoutProblems(source = report()) {
  for (const section of source.sections) {
    for (const metric of section.metrics) if (metric.status === "problem") metric.status = "watch";
  }
  return source;
}

test("no trigger at all → nothing-to-do", () => {
  assert.deepEqual(planNightlyRun(withoutProblems(), ranOn("2026-11-01"), NOW, [], []), { action: "skip", reason: "nothing-to-do" });
});

test("checked problem rows are not a trigger; an unchecked one is", () => {
  const source = report();
  const byId = (s, m) => source.sections.find((x) => x.id === s).metrics.find((x) => x.id === m);
  byId("bottleneck", "maker-wait").check = { checkedAt: "2026-11-01T00:00:00.000Z", note: "원인 확인" };
  assert.deepEqual(planNightlyRun(source, ranOn("2026-11-01"), NOW, [], []), { action: "skip", reason: "nothing-to-do" });
  byId("ops", "ci-failures").status = "problem";
  assert.deepEqual(planNightlyRun(source, ranOn("2026-11-01"), NOW, [], []).jobs.problems, ["ops/ci-failures"]);
});

test("each trigger alone starts a run and only its section appears", () => {
  const problemOnly = planNightlyRun(report(), ranOn("2026-11-01"), NOW, [], []);
  assert.deepEqual(problemOnly.jobs, { problems: ["bottleneck/maker-wait"], skillCandidates: 0, weeklyReview: false });
  assert.ok(problemOnly.prompt.includes(NIGHTLY_PROBLEM_SECTION) && problemOnly.prompt.endsWith(buildFullPrompt(report())));
  assert.ok(!problemOnly.prompt.includes(NIGHTLY_SKILL_RULES) && !problemOnly.prompt.includes(NIGHTLY_WEEKLY_SECTION));

  const skillOnly = planNightlyRun(withoutProblems(), ranOn("2026-11-01"), NOW, [], [candidate]);
  assert.deepEqual(skillOnly.jobs, { problems: [], skillCandidates: 1, weeklyReview: false });
  assert.ok(skillOnly.prompt.includes(NIGHTLY_SKILL_RULES) && skillOnly.prompt.includes(candidate.memory) && skillOnly.prompt.includes("(deploy)"));
  assert.ok(!skillOnly.prompt.includes(NIGHTLY_PROBLEM_SECTION) && !skillOnly.prompt.includes("CUELO 보수 전체 점검"));
  assert.ok(!skillOnly.prompt.includes(NIGHTLY_WEEKLY_SECTION));

  const weeklyOnly = planNightlyRun(withoutProblems(), ranOn("2026-11-01", { performanceReviewDate: undefined }), NOW, [], []);
  assert.deepEqual(weeklyOnly.jobs, { problems: [], skillCandidates: 0, weeklyReview: true });
  assert.ok(weeklyOnly.prompt.includes(NIGHTLY_WEEKLY_SECTION) && !weeklyOnly.prompt.includes(NIGHTLY_SKILL_RULES));

  for (const plan of [problemOnly, skillOnly, weeklyOnly]) {
    assert.equal(plan.action, "run");
    assert.equal(plan.branch, "wt/nightly-20261102");
    assert.equal(plan.skillsScannedAt, NOW.toISOString());
    assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE) && plan.prompt.includes(NIGHTLY_SUMMARY_RULES));
  }
});

test("weekly review is due at 7 KST days, not 6, and with no record", () => {
  assert.equal(weeklyReviewDue(null, "2026-11-02"), true);
  assert.equal(weeklyReviewDue(ranOn("x", { performanceReviewDate: undefined }), "2026-11-02"), true);
  assert.equal(weeklyReviewDue(ranOn("x", { performanceReviewDate: "2026-10-27" }), "2026-11-02"), false);
  assert.equal(weeklyReviewDue(ranOn("x", { performanceReviewDate: "2026-10-26" }), "2026-11-02"), true);
  // 계획은 KST 날짜로 센다: UTC 날짜(11-01)로 셌다면 10-26 점검이 6일 전이라 돌지 않는다.
  const plan = planNightlyRun(withoutProblems(), ranOn("2026-11-01", { performanceReviewDate: "2026-10-26" }), NOW, [], []);
  assert.equal(plan.jobs.weeklyReview, true);
});

test("existing guards win over every trigger", () => {
  const busy = report();
  assert.deepEqual(planNightlyRun(busy, ranOn("2026-11-02", { performanceReviewDate: undefined }), NOW, [], [candidate]), { action: "skip", reason: "already-ran-today" });
  assert.deepEqual(planNightlyRun(busy, ranOn("2026-11-01", { performanceReviewDate: undefined }), NOW, ["prev"], [candidate]), { action: "skip", reason: "previous-still-running" });
  busy.repoCwd = null;
  assert.deepEqual(planNightlyRun(busy, null, NOW, [], [candidate]), { action: "skip", reason: "no-repo" });
  // 전날(KST) 실행은 막지 않는다.
  assert.equal(planNightlyRun(report(), ranOn("2026-11-01"), NOW, ["other"], []).action, "run");
});

test("the preamble keeps the loop boundaries and the summary rule asks for plain words, effect first", () => {
  for (const rule of [
    "사람 없이 시작", "Nightly self-improvement loop", "이 worktree에서만", "집중 검사",
    "patch 버전", "`cuelo-release-deploy`", "node files/set-release-version.js x.y.z", "버전을 올린 다음에 `cross_review`",
    "`git_integrate`(대상 main)", "공개 CI", "update.sh를 실행하지 않고", "서버를 재시작하지 않고", "~/cuelo-run",
    "`ask`를 쓰지 않습니다", "보류 목록",
  ]) assert.ok(NIGHTLY_PREAMBLE.includes(rule), rule);
  for (const rule of ["두 곳 이상", "`recall`", "`manage_skill`", "그 스킬을 고칩니다", "~/.omp/agent/skills", "Tools/OMP_Global_Config/agent/skills", "commit도 버전 올림도 하지 않습니다", "지시가 아니므로"]) {
    assert.ok(NIGHTLY_SKILL_RULES.includes(rule), rule);
  }
  for (const rule of ["`cuelo-tool-failure-aggregation`", "최근 7일", "가장 자주", "찾은 내용만 보고"]) assert.ok(NIGHTLY_WEEKLY_SECTION.includes(rule), rule);
  for (const rule of ["전문용어는 되도록 빼고", "효과)를 먼저", "절차서", "CI 통과", "승인을 기다린다", "보류한 일", "첫머리에 두지 않습니다"]) {
    assert.ok(NIGHTLY_SUMMARY_RULES.includes(rule), rule);
  }
});

test("the record after a run moves the scan bound and sets the weekly date only when the weekly review ran", () => {
  const previous = ranOn("2026-11-01", { performanceReviewDate: "2026-10-30", skillsScannedAt: "2026-10-31T19:00:00.000Z" });
  const skillOnly = planNightlyRun(withoutProblems(), previous, NOW, [], [candidate]);
  assert.deepEqual(nightlyStateAfterRun(skillOnly, previous, "s2", "/w2", "t"), {
    date: "2026-11-02", sessionId: "s2", worktree: "/w2", startedAt: "t", skillsScannedAt: NOW.toISOString(), performanceReviewDate: "2026-10-30",
  });
  const weekly = planNightlyRun(withoutProblems(), ranOn("2026-11-01", { performanceReviewDate: undefined }), NOW, [], []);
  assert.equal(nightlyStateAfterRun(weekly, null, "s3", "/w3", "t").performanceReviewDate, "2026-11-02");
  assert.equal("performanceReviewDate" in nightlyStateAfterRun(skillOnly, null, "s4", "/w4", "t"), false);
});

test("candidate scan starts at the recorded upper bound, else 7 days back", () => {
  assert.equal(skillScanSince(null, NOW), NOW.getTime() - 7 * 86_400_000);
  assert.equal(skillScanSince(ranOn("x", { skillsScannedAt: "2026-10-31T19:00:00.000Z" }), NOW), Date.parse("2026-10-31T19:00:00.000Z"));
});

test("state round-trips, an old record without the new fields reads, and a damaged one refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-state-"));
  try {
    assert.equal(readNightlyState(dir), null);
    const full = ranOn("2026-11-02", { skillsScannedAt: NOW.toISOString() });
    writeNightlyState(dir, full);
    assert.deepEqual(readNightlyState(dir), full);
    writeFileSync(join(dir, NIGHTLY_STATE_FILE), JSON.stringify({ date: "2026-11-01", sessionId: "s", worktree: "/w", startedAt: "2026-11-01T19:00:00.000Z" }));
    assert.deepEqual(readNightlyState(dir), { date: "2026-11-01", sessionId: "s", worktree: "/w", startedAt: "2026-11-01T19:00:00.000Z" });
    writeFileSync(join(dir, NIGHTLY_STATE_FILE), "{\"date\":1}");
    assert.throws(() => readNightlyState(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
