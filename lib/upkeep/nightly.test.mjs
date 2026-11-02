import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NIGHTLY_PREAMBLE, NIGHTLY_STATE_FILE, planNightlyRun, readNightlyState, writeNightlyState } from "./nightly.ts";
import { buildFullPrompt } from "./prompt.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
const report = () => structuredClone(fixture);
/** 2026-11-02 04:30 KST. UTC로는 아직 11-01이라 날짜를 UTC로 셌다면 어긋난다. */
const NOW = new Date("2026-11-01T19:30:00.000Z");
const ranOn = (date, sessionId = "prev") => ({ date, sessionId, worktree: "/w", startedAt: "2026-11-01T19:00:00.000Z" });

function mapProblems(source, change) {
  for (const section of source.sections) {
    for (const metric of section.metrics) if (metric.status === "problem") change(metric);
  }
  return source;
}

test("skips without a problem row; watch rows do not trigger", () => {
  const source = mapProblems(report(), (metric) => { metric.status = "watch"; });
  assert.deepEqual(planNightlyRun(source, null, NOW, []), { action: "skip", reason: "no-problem" });
});

test("skips when every problem row carries a check mark", () => {
  const source = mapProblems(report(), (metric) => { metric.check = { checkedAt: "2026-11-01T00:00:00.000Z", note: null }; });
  assert.deepEqual(planNightlyRun(source, null, NOW, []), { action: "skip", reason: "no-problem" });
});

test("skips a second run on the same KST date and runs on the next one", () => {
  assert.deepEqual(planNightlyRun(report(), ranOn("2026-11-02"), NOW, []), { action: "skip", reason: "already-ran-today" });
  // 전날(KST) 실행은 막지 않는다. UTC 날짜(11-01)로 셌다면 여기서 건너뛴다.
  assert.equal(planNightlyRun(report(), ranOn("2026-11-01"), NOW, []).action, "run");
});

test("skips while the previous nightly session is still running", () => {
  assert.deepEqual(planNightlyRun(report(), ranOn("2026-11-01", "prev"), NOW, ["other", "prev"]), { action: "skip", reason: "previous-still-running" });
  assert.equal(planNightlyRun(report(), ranOn("2026-11-01", "prev"), NOW, ["other"]).action, "run");
});

test("plans a run with the loop preamble and the full upkeep prompt", () => {
  const source = report();
  const checked = source.sections.flatMap((s) => s.metrics.map((m) => [s.id, m])).find(([, m]) => m.status === "problem");
  const plan = planNightlyRun(source, null, NOW, []);
  assert.equal(plan.action, "run");
  assert.equal(plan.date, "2026-11-02");
  assert.equal(plan.branch, "wt/nightly-20261102");
  assert.equal(plan.repoCwd, source.repoCwd);
  assert.ok(plan.problems.includes(`${checked[0]}/${checked[1].id}`));
  assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE));
  assert.ok(plan.prompt.endsWith(buildFullPrompt(source)));
  for (const rule of [
    "사람 없이 시작", "Nightly self-improvement loop", "`문제` 행을 먼저", "이 worktree에서만", "집중 검사",
    "patch 버전", "`cuelo-release-deploy`", "node files/set-release-version.js x.y.z", "버전을 올린 다음에 `cross_review`",
    "`git_integrate`(대상 main)", "공개 CI", "update.sh를 실행하지 않고", "서버를 재시작하지 않고", "~/cuelo-run",
    "`ask`를 쓰지 않습니다", "보류 목록", "한국어로 짧게 요약", "push한 SHA",
  ]) {
    assert.ok(NIGHTLY_PREAMBLE.includes(rule), rule);
  }
});

test("a checked problem row is not a trigger while an unchecked one still is", () => {
  const source = report();
  const byId = (sectionId, metricId) => source.sections.find((s) => s.id === sectionId).metrics.find((m) => m.id === metricId);
  byId("bottleneck", "maker-wait").check = { checkedAt: "2026-11-01T00:00:00.000Z", note: "원인 확인" };
  byId("ops", "ci-failures").status = "problem";
  assert.deepEqual(planNightlyRun(source, null, NOW, []).problems, ["ops/ci-failures"]);
});

test("skips without a repository path", () => {
  const source = report();
  source.repoCwd = null;
  assert.deepEqual(planNightlyRun(source, null, NOW, []), { action: "skip", reason: "no-repo" });
});

test("state round-trips and a damaged record refuses to plan", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-state-"));
  try {
    assert.equal(readNightlyState(dir), null);
    writeNightlyState(dir, ranOn("2026-11-02", "s1"));
    assert.deepEqual(readNightlyState(dir), ranOn("2026-11-02", "s1"));
    writeFileSync(join(dir, NIGHTLY_STATE_FILE), "{\"date\":1}");
    assert.throws(() => readNightlyState(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
