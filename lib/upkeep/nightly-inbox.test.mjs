import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightlyStateAfterRun, NIGHTLY_PREAMBLE, NIGHTLY_STATE_FILE, readNightlyState, writeNightlyState } from "./nightly.ts";
import {
  buildNightlyExport, INBOX_SUMMARY_RULES, nightlySourceName, planInboxRun, rankToolFailures, readNightlyInbox, sanitizeSource,
} from "./nightly-inbox.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
/** 2026-11-02 04:30 KST */
const NOW = new Date("2026-11-01T19:30:00.000Z");
const REPO = "/data/cuelo/workspace/CUELO-private";
const OUTBOX = "/data/cuelo/nightly-outbox";
const recent = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
const ranYesterday = (sources) => ({ date: "2026-11-01", sessionId: "prev", worktree: "/w", startedAt: recent(24), sources });
const weeklyDone = { performanceReviewDate: "2026-10-31" };

function bundle(source, { problems = [], candidates = [], failures = [], generatedAt = recent(1) } = {}) {
  return { version: 1, source, generatedAt, problems, skillCandidates: candidates, toolFailures: failures };
}
const cand = (sessionId, memory, hoursAgo = 5) => ({ memory, topic: "deploy", sessionId, timestamp: recent(hoursAgo) });

test("source names are sanitized, with env, label and hostname in that order", () => {
  assert.equal(sanitizeSource("KYS PC_01!"), "kys-pc-01");
  assert.equal(sanitizeSource("!!!"), null);
  assert.equal(nightlySourceName({ CUELO_NIGHTLY_SOURCE: "Home", CUELO_INSTANCE_LABEL: "x" }, "h"), "home");
  assert.equal(nightlySourceName({ CUELO_INSTANCE_LABEL: "Office 2" }, "h"), "office-2");
  assert.equal(nightlySourceName({}, "KYS-Mint"), "kys-mint");
});

test("export keeps the unchecked problem rows, masks text and ranks failures most frequent first", () => {
  const report = structuredClone(fixture);
  const maker = report.sections.find((s) => s.id === "bottleneck").metrics.find((m) => m.id === "maker-wait");
  maker.note = "token=ghp_secretsecret1234 leaked";
  report.sections.find((s) => s.id === "ops").metrics.find((m) => m.id === "ci-failures").status = "problem";
  report.sections.find((s) => s.id === "ops").metrics.find((m) => m.id === "ci-failures").check = { checkedAt: recent(2), note: null };
  const errors = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`bash: error N case ${i}`, i + 1]));
  errors["read: path <p> api_key=sk-abcdef0123456789 missing"] = 100;
  const exported = buildNightlyExport({
    source: "home", now: NOW, report,
    skillCandidates: [{ ...cand("S", "요령 x"), topic: "token=ghp_topicsecret999" }, ...Array.from({ length: 49 }, (_, i) => cand("S", `요령 ${i}`))],
    errorsBySignature: errors,
  });
  assert.equal(exported.version, 1);
  assert.equal(exported.generatedAt, NOW.toISOString());
  assert.deepEqual(exported.problems.map((p) => p.id), ["bottleneck/maker-wait"]);
  assert.ok(!exported.problems[0].summary.includes("ghp_secretsecret1234"), exported.problems[0].summary);
  assert.equal(exported.skillCandidates.length, 40);
  assert.ok(!exported.skillCandidates[0].topic.includes("ghp_topicsecret999"), exported.skillCandidates[0].topic);
  assert.equal(exported.toolFailures.length, 20);
  assert.deepEqual(exported.toolFailures.slice(0, 3).map((f) => [f.tool, f.count]), [["read", 100], ["bash", 25], ["bash", 24]]);
  assert.ok(!exported.toolFailures[0].sample.includes("sk-abcdef0123456789"), exported.toolFailures[0].sample);
  assert.ok(exported.toolFailures.every((f) => f.sample.length <= 201));
  assert.deepEqual(rankToolFailures({ "a: x": 2, "b: y": 2, "c: z": 3 }).map((f) => f.tool), ["c", "a", "b"]);
});

test("inbox reading skips broken, stale, misnamed and wrong-version bundles", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-inbox-"));
  try {
    writeFileSync(join(dir, "home.json"), JSON.stringify(bundle("home")));
    writeFileSync(join(dir, "office.json"), JSON.stringify(bundle("office", { generatedAt: recent(9 * 24) })));
    writeFileSync(join(dir, "broken.json"), "{not json");
    writeFileSync(join(dir, "other.json"), JSON.stringify(bundle("home")));
    writeFileSync(join(dir, "v2.json"), JSON.stringify({ ...bundle("v2"), version: 2 }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const { bundles, skipped } = readNightlyInbox(dir, NOW);
    assert.deepEqual(bundles.map((b) => b.source), ["home"]);
    assert.deepEqual(skipped, [
      { file: "broken.json", reason: "unreadable" },
      { file: "office.json", reason: "stale" },
      { file: "other.json", reason: "invalid" },
      { file: "v2.json", reason: "invalid" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two sources get separate blocks with only their own active jobs", () => {
  const state = ranYesterday({ home: { ...weeklyDone }, office: {} });
  const plan = planInboxRun([
    bundle("home", { problems: [{ id: "bottleneck/maker-wait", section: "작업 병목", title: "Maker 대기", summary: "2배" }], candidates: [cand("H1", "집 요령")] }),
    bundle("office", { failures: [{ tool: "bash", key: "k", count: 7, sample: "exit N" }] }),
  ], state, NOW, [], REPO, OUTBOX);
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.sources.map((s) => [s.source, s.jobs]), [
    ["home", { problems: ["bottleneck/maker-wait"], skillCandidates: 1, weeklyReview: false }],
    ["office", { problems: [], skillCandidates: 0, weeklyReview: true }],
  ]);
  assert.deepEqual(plan.jobs, { problems: ["home:bottleneck/maker-wait"], skillCandidates: 1, weeklyReview: true });
  const [, home, office] = plan.prompt.split(/^# (?=home$|office$)/m);
  assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE) && plan.prompt.endsWith(INBOX_SUMMARY_RULES));
  assert.ok(home.includes("## 보수 점검판 문제 행") && home.includes("집 요령") && !home.includes("## 주간 성능 점검"));
  assert.ok(office.includes("## 주간 성능 점검") && office.includes("1. bash: exit N (7건)") && !office.includes("## 절차서"));
  assert.ok(!office.includes("cuelo-tool-failure-aggregation"));
  assert.ok(plan.prompt.includes("출처(PC)마다 절을 나눠"));
  assert.ok(plan.prompt.includes(`${OUTBOX}/<출처>/<스킬 이름>/`) && plan.prompt.includes("manifest.json"));
});

test("a procedure seen once in each of two sources is listed per source and never counted across them", () => {
  const plan = planInboxRun([bundle("home", { candidates: [cand("H1", "같은 요령")] }), bundle("office", { candidates: [cand("O1", "같은 요령")] })],
    ranYesterday({ home: weeklyDone, office: weeklyDone }), NOW, [], REPO, OUTBOX);
  const [, home, office] = plan.prompt.split(/^# (?=home$|office$)/m);
  assert.ok(home.includes("세션 H1") && !home.includes("세션 O1"));
  assert.ok(office.includes("세션 O1") && !office.includes("세션 H1"));
  assert.ok(home.includes("`home` 안의 서로 다른 세션 두 곳 이상") && home.includes("다른 출처에서 본 것은 세지 않습니다"));
});

test("candidate filtering and recorded state are per source", () => {
  // lab은 이번에 묶음을 보내지 않은(꺼진) 출처다. 그 기록은 그대로 남아야 한다.
  const lab = { skillsScannedAt: recent(200), performanceReviewDate: "2026-10-20" };
  const state = ranYesterday({ home: { ...weeklyDone, skillsScannedAt: recent(3) }, office: { ...weeklyDone }, lab });
  const bundles = [bundle("home", { candidates: [cand("H1", "오래된", 5)], generatedAt: recent(1) }), bundle("office", { candidates: [cand("O1", "새것", 5)], generatedAt: recent(2) })];
  const plan = planInboxRun(bundles, state, NOW, [], REPO, OUTBOX);
  assert.deepEqual(plan.sources.map((s) => [s.source, s.jobs.skillCandidates]), [["home", 0], ["office", 1]]);
  const after = nightlyStateAfterRun(plan, state, "s", "/w2", "t");
  assert.deepEqual(after.sources, {
    home: { skillsScannedAt: recent(1), performanceReviewDate: "2026-10-31" },
    office: { skillsScannedAt: recent(2), performanceReviewDate: "2026-10-31" },
    lab,
  });
  // 주간 점검은 맡긴 출처만 날짜가 바뀐다.
  const weekly = planInboxRun([bundle("home"), bundle("office")], ranYesterday({ home: weeklyDone }), NOW, [], REPO, OUTBOX);
  const next = nightlyStateAfterRun(weekly, ranYesterday({ home: weeklyDone }), "s", "/w", "t").sources;
  assert.equal(next.home.performanceReviewDate, "2026-10-31");
  assert.equal(next.office.performanceReviewDate, "2026-11-02");
});

test("nothing-to-do when no source has work; guards still win; no repo means no-repo", () => {
  const idle = ranYesterday({ home: { ...weeklyDone } });
  assert.deepEqual(planInboxRun([bundle("home")], idle, NOW, [], REPO, OUTBOX), { action: "skip", reason: "nothing-to-do" });
  assert.deepEqual(planInboxRun([], null, NOW, [], REPO, OUTBOX), { action: "skip", reason: "nothing-to-do" });
  const busy = [bundle("home", { candidates: [cand("H1", "x")] })];
  assert.deepEqual(planInboxRun(busy, idle, NOW, [], null, OUTBOX), { action: "skip", reason: "no-repo" });
  assert.deepEqual(planInboxRun(busy, { ...idle, date: "2026-11-02" }, NOW, [], REPO, OUTBOX), { action: "skip", reason: "already-ran-today" });
  assert.deepEqual(planInboxRun(busy, idle, NOW, ["prev"], REPO, OUTBOX), { action: "skip", reason: "previous-still-running" });
});

test("without an outbox the prompt says skills must be reported by name", () => {
  const plan = planInboxRun([bundle("home", { candidates: [cand("H1", "x")] })], ranYesterday({ home: weeklyDone }), NOW, [], REPO, null);
  assert.ok(plan.prompt.includes("CUELO_NIGHTLY_OUTBOX_DIR)이 설정되지 않았습니다") && !plan.prompt.includes("manifest.json"));
});

test("per-source state round-trips and a damaged source entry refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-state-"));
  try {
    const state = { ...ranYesterday({ home: { skillsScannedAt: recent(1), performanceReviewDate: "2026-10-31" }, office: {} }), performanceReviewDate: "2026-10-20" };
    writeNightlyState(dir, state);
    assert.deepEqual(readNightlyState(dir), state);
    writeFileSync(join(dir, NIGHTLY_STATE_FILE), JSON.stringify({ ...state, sources: { home: { skillsScannedAt: 5 } } }));
    assert.throws(() => readNightlyState(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
