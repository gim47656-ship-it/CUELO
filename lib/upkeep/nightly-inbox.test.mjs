import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DREAMING_LEDGER_PATH, DREAMING_WINDOW_MS, parseDreamingLedger } from "./dreaming.ts";
import { parseHandoff } from "./handoff.ts";
import { nightlyBranchRetained } from "./criteria.ts";
import { modelErrorFrom } from "./model-errors.ts";
import { collectPluginEvents } from "./plugin-events.ts";
import { scanSessions } from "./sessions.ts";
import { nightlyStateAfterRun, NIGHTLY_PREAMBLE, NIGHTLY_STATE_FILE, readNightlyState, writeNightlyState } from "./nightly.ts";
import {
  buildNightlyExport, createNightlyBranch, exportContextLoad, IMPROVEMENT_REVIEW_BLOCK, INBOX_SUMMARY_RULES, nightlySourceName, planInboxRun, rankToolFailures, readCloudHandoffs,
  pruneMergedNightlyBranches, pruneNightlyWorktrees, readNightlyInbox, sanitizeSource,
} from "./nightly-inbox.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
/** 2026-11-02 04:30 KST */
const NOW = new Date("2026-11-01T19:30:00.000Z");
const REPO = "/data/cuelo/workspace/CUELO-private";
const OUTBOX = "/data/cuelo/nightly-outbox";
const recent = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
const ranYesterday = (sources) => ({ date: "2026-11-01", sessionId: "prev", worktree: "/w", startedAt: recent(24), regressionReviewDate: "2026-10-31", sources });
const weeklyDone = { performanceReviewDate: "2026-10-31" };
/** 열린 이슈가 없던 조회. 이슈와 상관없는 시험의 기본값이다. */
const NO_ISSUES = { status: "ok", repo: "gim47656-ship-it/CUELO", issues: [], partial: false };

function bundle(source, { problems = [], candidates = [], failures = [], generatedAt = recent(1), skillUsage = { rows: [], unused: [] }, excerpts = [] } = {}) {
  return { version: 2, source, generatedAt, problems, skillCandidates: candidates, toolFailures: failures, skillUsage, failureExcerpts: excerpts };
}
const cand = (sessionId, memory, hoursAgo = 5) => ({ memory, topic: "deploy", sessionId, timestamp: recent(hoursAgo), kind: "learned" });

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
  assert.equal(exported.version, 2);
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
    writeFileSync(join(dir, "v3.json"), JSON.stringify({ ...bundle("v3"), version: 3 }));
    writeFileSync(join(dir, "notes.txt"), "ignored");
    const { bundles, skipped } = readNightlyInbox(dir, NOW);
    assert.deepEqual(bundles.map((b) => b.source), ["home"]);
    assert.deepEqual(skipped, [
      { file: "broken.json", reason: "unreadable" },
      { file: "office.json", reason: "stale" },
      { file: "other.json", reason: "invalid" },
      { file: "v3.json", reason: "invalid" },
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
  ], state, NOW, [], REPO, OUTBOX, NO_ISSUES);
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.sources.map((s) => [s.source, s.jobs]), [
    ["home", { problems: ["bottleneck/maker-wait"], skillCandidates: 1, weeklyReview: false, pluginReview: true }],
    ["office", { problems: [], skillCandidates: 0, weeklyReview: true, pluginReview: true }],
  ]);
  assert.deepEqual(plan.jobs, { problems: ["home:bottleneck/maker-wait"], skillCandidates: 1, weeklyReview: true, handoff: [], issueLookup: "ok", issues: [], improvementReview: true, pluginReview: true });
  const [, home, office] = plan.prompt.split(/^# (?=home$|office$)/m);
  assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE) && plan.prompt.endsWith(INBOX_SUMMARY_RULES));
  assert.ok(home.includes("## 보수 점검판 문제 행") && home.includes("집 요령") && !home.includes("## 주간 성능 점검"));
  assert.ok(office.includes("## 주간 성능 점검") && office.includes("1. bash: exit N (7건)") && !office.includes("## 절차서"));
  assert.ok(!office.includes("cuelo-tool-failure-aggregation"));
  assert.ok(plan.prompt.includes("출처(PC)마다 절을 나눠"));
  assert.ok(plan.prompt.includes(`${OUTBOX}/<출처>/<스킬 이름>/`) && plan.prompt.includes("manifest.json"));
});

test("global weekly regression neither doubles nor starves with staggered source reviews", () => {
  const command = `node '${join(homedir(), "cuelo-run/Tools/OMP_Global_Config/evals/outcome/run-revision-compare.mjs").replace(/'/g, "'\\''")}' --weekly --budget 2`;
  const sources = { home: weeklyDone, office: { performanceReviewDate: "2026-10-28" } };
  const first = planInboxRun([bundle("home"), bundle("office")], { ...ranYesterday(sources), regressionReviewDate: undefined }, NOW, [], REPO, OUTBOX, NO_ISSUES);
  assert.equal(first.prompt.split(command).length - 1, 1);
  assert.equal(first.jobs.regressionReview, true);
  const after = nightlyStateAfterRun(first, ranYesterday(sources), "s", "/w", "t");
  assert.equal(after.regressionReviewDate, "2026-11-02");
  const staggered = { ...after, sources: { home: { performanceReviewDate: "2026-11-02" }, office: { performanceReviewDate: "2026-10-28" } } };
  const threeDays = planInboxRun([bundle("home"), bundle("office")], staggered, new Date("2026-11-05T00:00:00Z"), [], REPO, OUTBOX, NO_ISSUES);
  assert.equal(threeDays.jobs.weeklyReview, true);
  assert.equal(threeDays.jobs.regressionReview, undefined);
  assert.equal(threeDays.prompt.includes(command), false);
  const shifted = { ...staggered, sources: { home: { performanceReviewDate: "2026-11-07" }, office: { performanceReviewDate: "2026-11-08" } } };
  const sevenDays = planInboxRun([bundle("home"), bundle("office")], shifted, new Date("2026-11-09T00:00:00Z"), [], REPO, OUTBOX, NO_ISSUES);
  assert.equal(sevenDays.jobs.weeklyReview, false);
  assert.equal(sevenDays.jobs.regressionReview, true);
  assert.equal(sevenDays.prompt.split(command).length - 1, 1);
  assert.equal((sevenDays.prompt.match(/^# 주간 회귀 측정$/gm) ?? []).length, 1);
});

test("a host without the regression runner gets no weekly regression command and keeps it due", () => {
  const sources = { home: weeklyDone, office: { performanceReviewDate: "2026-10-28" } };
  const previous = { ...ranYesterday(sources), regressionReviewDate: undefined };
  const plan = planInboxRun([bundle("home"), bundle("office")], previous, NOW, [], REPO, OUTBOX, NO_ISSUES, null, null, null, false);
  assert.equal(plan.action, "run");
  assert.equal(plan.jobs.regressionReview, undefined);
  assert.equal(plan.prompt.includes("run-revision-compare.mjs"), false);
  assert.equal(plan.prompt.includes("# 주간 회귀 측정"), false);
  assert.equal(nightlyStateAfterRun(plan, previous, "s", "/w", "t").regressionReviewDate, undefined);
});

test("inbox plan requires the same dated trail and review, retaining source attribution", () => {
  const { prompt } = planInboxRun([bundle("home"), bundle("office")], null, NOW, [], REPO, OUTBOX, NO_ISSUES);
  assert.ok(prompt.includes(".audit/nightly-2026-11-02.tsv"));
  assert.ok(prompt.includes("ts\\tphase\\tdecision\\twhy\\tevidence\\tresult"));
  for (const requirement of [
    /append-only/, /행 수정·삭제는 하지 않습니다/, /방향 전환.*정정 행/,
    /evidence가 열리며.*뒷받침/, /테스트 명령과 exit code/,
    /rule:\/\/rule-enforcement/, /enforcer 수준/,
    /git_finalize.*files.*\.audit\/.*절대 넣지/,
    /cross_review.*references.*결정 기록/, /다른 계열 reviewer.*cross_review/,
    /acceptance.*근거가 약하거나 없는.*건너뛴 검증.*위험한 선택/,
    /skippedReferences/, /검토 없음: 기록이 리뷰에 실리지 않음/,
    /코드가 바뀌지 않았으면.*이유/, /맨 마지막.*「주의할 점」/,
    /검토: <reviewer model>/, /검토 없음: <reason>/,
    /지적마다.*행 번호/, /「없음」/, /기록 경로도 이 절/,
    /항상 커밋할 파일만 명시한.*files/, /일괄 staging은 하지/,
    /cross_review.*부르기 전과 아침 요약 전에.*자체 감사/,
    /복사본을 만들거나.*우회하지/, /머리글을 1행/,
    /마지막 행 번호.*이후 추가한 행.*미검토/,
    /phase에는 출처와 작업 단계/, /지적의 출처와 행 번호/,
  ]) assert.match(prompt, requirement);
});

test("updated home and office exports keep separately fenced original evidence, overlap and ledger", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-dreaming-fixture-"));
  const correction = "정정: 이 PC는 읽기 전용입니다.\n````\n# 다른 출처 아님";
  const sid = "00000000-0000-4000-8000-000000000002";
  const e = (entryId, quote, extra = {}) => ({ sessionId: sid, entryId, at: recent(6), kind: "user", quote, ...extra });
  const seen = `home/${sid}/00000001`;
  const home = { from: new Date(Date.parse(recent(1)) - DREAMING_WINDOW_MS).toISOString(), partial: false, events: [
    e("00000001", "OLD_ALREADY_HANDLED"), e("00000002", correction),
  ] };
  const office = { from: recent(10), partial: true, events: [
    e("00000001", "fatal: cannot fast-forward", { kind: "failed-command", command: "git pull --ff-only" }),
  ] };
  try {
    for (const [source, dreaming, hoursAgo] of [["home", home, 1], ["office", office, 4]]) {
      const exported = buildNightlyExport({ source, now: new Date(recent(hoursAgo)), report: { ...fixture, sections: [] }, skillCandidates: [], errorsBySignature: {}, dreaming });
      writeFileSync(join(dir, `${source}.json`), JSON.stringify(exported));
    }
    const { bundles, skipped } = readNightlyInbox(dir, NOW);
    assert.deepEqual(skipped, []);
    const read = { items: [], base: null, dreamingLedger: parseDreamingLedger(`${seen}\n`) };
    const state = ranYesterday({ home: weeklyDone, office: weeklyDone, offline: weeklyDone });
    const plan = planInboxRun(bundles, state, NOW, [], REPO, OUTBOX, NO_ISSUES, read);
    assert.ok(plan.sources.every(({ jobs }) => !jobs.problems.length && !jobs.skillCandidates && !jobs.weeklyReview));
    const [, homeBlock, officeBlock] = plan.prompt.split(/^# (?=home$|office$)/m);
    assert.match(plan.prompt, /야간 드리밍.*세션 원문과 문서 대조/);
    for (const part of ["HANDOFF.md", "doc/cuelo-*-reference.md", "AGENTS.md", "`memory_edit`", "가설 / 원문 확인 필요", "직접 반박하거나 대체할 때만", "교정 및 근거 기록과 같은 게시", "묶음이 없는 출처: offline"]) assert.ok(plan.prompt.includes(part), part);
    for (const policy of [
      /사실 보존:.*원문에서.*초안의 사실 목록과.*원문을 그대로 두고/,
      /`AGENTS\.md`.*`RULES\.md`.*`APPEND_SYSTEM\.md`.*규칙 색인.*주입된 기억 발췌.*변경 전후 UTF-8 바이트와 로컬 토큰.*이 worktree의 문서와 규칙 미러만.*읽고 재기만/,
      /처음 다루는 밤에는.*비공개 작업 기록에 제안으로만.*변경 전 문장.*조치와 이유.*출처\/세션 ID\/항목 ID.*`learn`이나 `memory_edit`로.*완료로 넣지 않습니다/,
      /다음 야간 실행부터.*앞선 야간 실행이 `origin\/main`에 게시한 제안.*현재 기억의 ID, 범위, 변경 전 문장과 상태.*여전히 맞을 때만.*달라졌으면 적용하지 않습니다.*문서 교정에는 이 대기 규칙을 적용하지 않습니다/,
      /`hypothesis`로 기록된 뒤 30일.*`kind: evidence`로 새 기억을 기록.*새 기억 ID를 받은 뒤에만.*`invalidate`.*나이만으로 없애지 않고/,
      /경로, 버전, 파일 존재만 반복하는 기억.*규칙과 검증 근거를 보존/,
      /기록 두 곳 이상.*단일 문서의 요약본을 만들지.*하루 최대 한 페이지, 페이지당 UTF-8 4 KiB와 로컬 토큰 800개/,
    ]) assert.match(plan.prompt, policy);
    assert.ok(!plan.prompt.includes("OLD_ALREADY_HANDLED"));
    assert.ok(homeBlock.includes(JSON.stringify(correction)));
    assert.match(homeBlock, /^`````jsonl$/m);
    assert.doesNotMatch(homeBlock, /fatal: cannot fast-forward/);
    assert.match(officeBlock, /"command":"git pull --ff-only"/);
    assert.match(officeBlock, /fatal: cannot fast-forward/);
    assert.match(officeBlock, /지난 야간 실행부터.*확인하지 못했습니다/);
    assert.match(officeBlock, /마지막 업로드가 2시간보다 오래됐습니다/);
    assert.match(officeBlock, /아래 목록을 전체 기록으로 보지 않습니다/);
    assert.doesNotMatch(officeBlock, /정정: 이 PC는/);

    const noLedger = planInboxRun(bundles, state, NOW, [], REPO, OUTBOX, NO_ISSUES, { ...read, dreamingLedger: null });
    assert.match(noLedger.prompt, /최신 게시 원장을 확인하지 못해 이 자료로 교정하지 않습니다/);
    assert.doesNotMatch(noLedger.prompt, /fatal: cannot fast-forward|정정: 이 PC는/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a procedure seen once in each of two sources is listed per source and never counted across them", () => {
  const plan = planInboxRun([bundle("home", { candidates: [cand("H1", "같은 요령")] }), bundle("office", { candidates: [cand("O1", "같은 요령")] })], ranYesterday({ home: weeklyDone, office: weeklyDone }), NOW, [], REPO, OUTBOX, NO_ISSUES);
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
  const plan = planInboxRun(bundles, state, NOW, [], REPO, OUTBOX, NO_ISSUES);
  assert.deepEqual(plan.sources.map((s) => [s.source, s.jobs.skillCandidates]), [["home", 0], ["office", 1]]);
  const after = nightlyStateAfterRun(plan, state, "s", "/w2", "t");
  assert.deepEqual(after.sources, {
    home: { skillsScannedAt: recent(1), performanceReviewDate: "2026-10-31" },
    office: { skillsScannedAt: recent(2), performanceReviewDate: "2026-10-31" },
    lab,
  });
  // 주간 점검은 맡긴 출처만 날짜가 바뀐다.
  const weekly = planInboxRun([bundle("home"), bundle("office")], ranYesterday({ home: weeklyDone }), NOW, [], REPO, OUTBOX, NO_ISSUES);
  const next = nightlyStateAfterRun(weekly, ranYesterday({ home: weeklyDone }), "s", "/w", "t").sources;
  assert.equal(next.home.performanceReviewDate, "2026-10-31");
  assert.equal(next.office.performanceReviewDate, "2026-11-02");
});

test("with no maintenance work and no issues the cloud still plans the daily existing-feature review; guards still win", () => {
  const idle = ranYesterday({ home: { ...weeklyDone } });
  for (const [index, plan] of [planInboxRun([bundle("home")], idle, NOW, [], REPO, OUTBOX, NO_ISSUES), planInboxRun([], null, NOW, [], REPO, OUTBOX, NO_ISSUES)].entries()) {
    assert.equal(plan.action, "run");
    assert.deepEqual(plan.jobs, { problems: [], skillCandidates: 0, weeklyReview: false, ...(index === 1 ? { regressionReview: true } : {}), handoff: [], issueLookup: "ok", issues: [], improvementReview: true, pluginReview: true });
    assert.ok(plan.prompt.includes(IMPROVEMENT_REVIEW_BLOCK));
  }
  // 할 일 없는 출처도 읽은 상한은 옮긴다.
  assert.deepEqual(planInboxRun([bundle("home")], idle, NOW, [], REPO, OUTBOX, NO_ISSUES).sources.map((s) => s.source), ["home"]);
  const busy = [bundle("home", { candidates: [cand("H1", "x")] })];
  assert.deepEqual(planInboxRun(busy, idle, NOW, [], null, OUTBOX, NO_ISSUES), { action: "skip", reason: "no-repo" });
  assert.deepEqual(planInboxRun(busy, { ...idle, date: "2026-11-02" }, NOW, [], REPO, OUTBOX, NO_ISSUES), { action: "skip", reason: "already-ran-today" });
  assert.deepEqual(planInboxRun(busy, idle, NOW, ["prev"], REPO, OUTBOX, NO_ISSUES), { action: "skip", reason: "previous-still-running" });
});

test("without an outbox the prompt says skills must be reported by name", () => {
  const plan = planInboxRun([bundle("home", { candidates: [cand("H1", "x")] })], ranYesterday({ home: weeklyDone }), NOW, [], REPO, null, NO_ISSUES);
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

const HANDOFF = [
  "## 관찰 대기",
  "- **클라우드 야간 깨우기 관찰(11-01 점검, 클라우드 점검):** 03:40 깨우기 뒤 04:00 실행이 돌았는지 journal로 본다.",
  "  - 이틀 연속 돌면 닫는다.",
  "- **사무실 PC 관찰(11-01 점검):** 사무실 PC에서 확인한다.",
  "- **클라우드 CI 관찰(11-03 점검, 클라우드 점검):** 아직 기한 전이다.",
  "- 클라우드 점검 메모(11-01 점검): 굵은 제목이 아니다.",
].join("\n");

test("only overdue items marked 클라우드 점검 are picked, and one of them alone starts a run", () => {
  const items = parseHandoff(HANDOFF, "HANDOFF.md", NOW);
  const plan = planInboxRun([], null, NOW, [], REPO, OUTBOX, NO_ISSUES, { items, base: { ref: "origin/main", sha: "0123456789abcdef" } });
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.jobs, { problems: [], skillCandidates: 0, weeklyReview: false, regressionReview: true, handoff: ["HANDOFF.md 「클라우드 야간 깨우기 관찰(11-01 점검, 클라우드 점검)」"], issueLookup: "ok", issues: [], improvementReview: true, pluginReview: true });
  assert.deepEqual(plan.base, { ref: "origin/main", sha: "0123456789abcdef" });
  const block = plan.prompt.slice(plan.prompt.indexOf("# 저장소 HANDOFF 클라우드 점검"));
  assert.ok(block.includes("origin/main `01234567`"), block);
  assert.ok(block.includes("journal로 본다.\n  - 이틀 연속 돌면 닫는다."), "the item's original text, continuation lines included");
  assert.ok(!block.includes("사무실 PC 관찰") && !block.includes("클라우드 CI 관찰") && !block.includes("굵은 제목이 아니다"));
  for (const instruction of [/원문에 적힌 조건과 기준으로만/, /journalctl/, /끝났으면 항목을 정리/, /제목의 점검일을 다음 점검일로/, /추측해 판정하지 않습니다/, /git_integrate/, /「HANDOFF 점검」 절/]) {
    assert.match(block, instruction);
  }
  assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE) && plan.prompt.endsWith(INBOX_SUMMARY_RULES));
  // 기한 전이거나 표시 없는 항목은 맡기지 않고, 맡길 항목이 있어도 기존 가드가 이긴다.
  const notYet = items.filter((item) => !item.ref.title.startsWith("클라우드 야간"));
  const withoutDue = planInboxRun([], null, NOW, [], REPO, OUTBOX, NO_ISSUES, { items: notYet, base: null });
  assert.deepEqual(withoutDue.jobs.handoff, []);
  assert.ok(!withoutDue.prompt.includes("# 저장소 HANDOFF 클라우드 점검"));
  for (const path of ["HANDOFF.md", "Tools/CUELO_Setup/HANDOFF.md", "Tools/OMP_Global_Config/HANDOFF.md"]) assert.ok(withoutDue.prompt.includes(`\`${path}\``));
  assert.match(withoutDue.prompt, /표시가 없는 항목/);
  const instructions = withoutDue.prompt.slice(withoutDue.prompt.indexOf("# 남은 HANDOFF 항목 분류"), withoutDue.prompt.indexOf("# 기존 기능 개선 점검"));
  for (const rule of [/이미 게시한 측정 기록.*설치 영수증/, /같은 자료가 거듭 빠져.*비식별 집계/, /수집기.*내보내기.*직접 구현/, /수집부터 클라우드가 묶음을 읽는 경로까지 검증/, /필드가 없을 때 0건 또는 성공으로 읽지/, /원본 로그.*보내거나 권한을 넓히지/, /다음 정기 동기화.*실제 출처/, /사용자 결정.*실제 장비.*별도 승인/]) assert.match(instructions, rule);
  assert.match(block, /PC에서 생긴 기록이라는 이유만으로 넘기지는 않습니다/);
  // 표시 없는 기한 지난 행은 경로와 제목 한 줄씩만 싣는다. 클라우드 점검 행과 기한 전 행은 여기 싣지 않는다.
  const overdueStart = plan.prompt.indexOf("# 남은 HANDOFF 항목 분류");
  const overdueSection = plan.prompt.slice(overdueStart, plan.prompt.indexOf("\n# ", overdueStart));
  assert.match(overdueSection, /점검일이 지난 행 2개.*① 닫기.*② .*③ .*사용자 결정 대기.*다시 깨우고.*보류/);
  assert.ok(overdueSection.includes("\n- HANDOFF.md 「사무실 PC 관찰(11-01 점검)」"), overdueSection);
  assert.ok(!overdueSection.includes("사무실 PC에서 확인한다") && !overdueSection.includes("깨우기 관찰") && !overdueSection.includes("클라우드 CI 관찰"));
  const fromHead = planInboxRun([], null, NOW, [], REPO, OUTBOX, NO_ISSUES, { items, base: null });
  assert.equal(fromHead.base, null);
  assert.ok(fromHead.prompt.includes("시작한 커밋(저장소 작업 사본)"));
  assert.deepEqual(planInboxRun([], { ...ranYesterday({}), date: "2026-11-02" }, NOW, [], REPO, OUTBOX, NO_ISSUES, { items, base: null }), { action: "skip", reason: "already-ran-today" });
  assert.deepEqual(planInboxRun([], ranYesterday({}), NOW, ["prev"], REPO, OUTBOX, NO_ISSUES, { items, base: null }), { action: "skip", reason: "previous-still-running" });
});

test("cloud HANDOFF is read from fetched origin/main, the nightly branch starts there, and HEAD is the fallback", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-handoff-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  try {
    const remote = join(root, "remote.git"), pc = join(root, "pc"), cloud = join(root, "cloud");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, pc);
    git(pc, "checkout", "-qb", "main");
    writeFileSync(join(pc, "HANDOFF.md"), "## 관찰 대기\n- **옛 항목(11-01 점검):** 표시 없음\n");
    git(pc, "add", "HANDOFF.md");
    git(pc, "commit", "-qm", "old");
    git(pc, "push", "-q", "origin", "main");
    git(root, "clone", "-q", remote, cloud);
    assert.deepEqual((await readCloudHandoffs(cloud, NOW)).dreamingLedger, new Set());
    // 클라우드 사본을 만든 뒤 PC가 표시한 항목을 게시한다. 클라우드 HEAD는 아직 옛 커밋이다.
    writeFileSync(join(pc, "HANDOFF.md"), HANDOFF);
    const processed = "home/00000000-0000-4000-8000-000000000001/00000001";
    mkdirSync(join(pc, "doc/history"), { recursive: true });
    writeFileSync(join(pc, DREAMING_LEDGER_PATH), `${processed}\n`);
    git(pc, "add", DREAMING_LEDGER_PATH);
    git(pc, "commit", "-qam", "mark");
    git(pc, "push", "-q", "origin", "main");
    const published = git(pc, "rev-parse", "HEAD");

    const read = await readCloudHandoffs(cloud, NOW);
    assert.deepEqual(read.base, { ref: "origin/main", sha: published });
    assert.deepEqual(read.dreamingLedger, new Set([processed]));
    const plan = planInboxRun([], null, NOW, [], cloud, OUTBOX, NO_ISSUES, read);
    assert.deepEqual(plan.jobs.handoff, ["HANDOFF.md 「클라우드 야간 깨우기 관찰(11-01 점검, 클라우드 점검)」"]);
    // 같은 날 시작에 실패해 남은 브랜치가 옛 HEAD에 있으면 잃을 커밋이 없으므로 base로 옮긴다.
    git(cloud, "branch", plan.branch, "HEAD");
    assert.equal(await createNightlyBranch(cloud, plan.branch, plan.base.sha), "moved");
    assert.equal(git(cloud, "rev-parse", plan.branch), published);
    assert.equal(await createNightlyBranch(cloud, plan.branch, plan.base.sha), "reused");
    assert.equal(await createNightlyBranch(cloud, "wt/fresh", plan.base.sha), "created");
    assert.equal(git(cloud, "rev-parse", "wt/fresh"), published);
    // base에 없는 커밋이 있는 브랜치는 덮지 않는다.
    git(cloud, "checkout", "-qb", "wt/side");
    writeFileSync(join(cloud, "side.txt"), "x");
    git(cloud, "add", "side.txt");
    git(cloud, "commit", "-qm", "side");
    git(cloud, "checkout", "-q", "main");
    await assert.rejects(createNightlyBranch(cloud, "wt/side", plan.base.sha), /has commits not in/);

    // A malformed ledger is not an empty ledger; unrelated nightly work can continue.
    writeFileSync(join(pc, DREAMING_LEDGER_PATH), "malformed\n");
    git(pc, "commit", "-qam", "malformed ledger");
    git(pc, "push", "-q", "origin", "main");
    const malformed = await readCloudHandoffs(cloud, NOW);
    assert.equal(malformed.dreamingLedger, null);
    assert.ok(malformed.warnings.some((warning) => warning.includes("드리밍 원장")));

    // origin이 없으면 worktree가 시작할 HEAD 커밋을 읽는다. 커밋하지 않은 작업 사본의 수정은 worktree에 없으므로 읽지 않는다.
    git(cloud, "remote", "remove", "origin");
    writeFileSync(join(cloud, "HANDOFF.md"), HANDOFF);
    const local = await readCloudHandoffs(cloud, NOW);
    assert.deepEqual(local.base, { ref: "HEAD", sha: git(cloud, "rev-parse", "HEAD") });
    assert.equal(local.dreamingLedger, null);
    assert.notEqual(local.base.sha, published);
    assert.deepEqual(local.items.map((item) => item.ref.title), ["옛 항목(11-01 점검)"]);
    assert.deepEqual(planInboxRun([], null, NOW, [], cloud, OUTBOX, NO_ISSUES, local).jobs.handoff, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("merged remote nightly branches past retention are deleted, while kept, recent, unmerged and other branches stay", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-prune-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  const heads = (remote) => git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").sort();
  try {
    const remote = join(root, "remote.git"), pc = join(root, "pc"), cloud = join(root, "cloud");
    git(root, "init", "-q", "--bare", "-b", "main", remote);
    git(root, "clone", "-q", remote, pc);
    git(pc, "checkout", "-qb", "main");
    const commit = (file) => {
      writeFileSync(join(pc, file), file);
      git(pc, "add", file);
      git(pc, "commit", "-qm", file);
    };
    commit("a.txt");
    // 병합된 야간 브랜치(지난 것, 도는 세션 것, 보존 기간 안의 것, 날짜를 못 읽는 이름 셋, 야간 이름을 꼬리에 단 다른 브랜치),
    // 병합된 다른 wt 브랜치, 병합되지 않은 지난 야간 브랜치.
    const odd = ["wt/nightly-not-a-date", "wt/nightly-20261399", "wt/nightly-20260230", "wt/nightly-topic/wt/nightly-20261103"];
    for (const branch of ["wt/nightly-20261103", "wt/nightly-20261103-inbox", "wt/nightly-20261104", "wt/nightly-20261108", ...odd, "wt/topic"]) git(pc, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
    git(pc, "checkout", "-qb", "wt/nightly-20261102");
    commit("unmerged.txt");
    git(pc, "push", "-q", "origin", "wt/nightly-20261102");
    git(pc, "checkout", "-q", "main");
    commit("b.txt");
    git(pc, "push", "-q", "origin", "main");
    git(root, "clone", "-q", remote, cloud);

    const read = await readCloudHandoffs(cloud, NOW);
    /** 2026-11-12 12:00 KST */
    const later = new Date("2026-11-12T03:00:00.000Z");
    const pruned = await pruneMergedNightlyBranches(cloud, read.base.sha, new Set(["wt/nightly-20261104"]), later);
    assert.deepEqual(pruned, { deleted: ["wt/nightly-20261103", "wt/nightly-20261103-inbox"], warnings: [] });
    assert.deepEqual(heads(remote), ["main", "wt/nightly-20261102", "wt/nightly-20261104", "wt/nightly-20261108", ...odd, "wt/topic"].sort());
    // 보존 기간은 브랜치 날짜 KST 00:00부터 7일이다.
    assert.equal(nightlyBranchRetained("origin/wt/nightly-20261105", Date.parse("2026-11-11T23:59:59+09:00")), true);
    assert.equal(nightlyBranchRetained("origin/wt/nightly-20261105", Date.parse("2026-11-12T00:00:00+09:00")), false);
    assert.equal(nightlyBranchRetained("origin/wt/topic", later.getTime()), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * 수동 worktree 삭제의 예약(`reserveWorktreeRemoval`)을 대신한다. `busy`는 그 경로를 쓰는 세션 id다. 풀 때 사본이 아직
 * 있었는지 남겨, 예약이 삭제가 끝날 때까지 잡혀 있었는지 본다.
 */
const reservations = (busy = new Map()) => {
  const held = new Set(), existedAtRelease = new Map();
  const reserve = (path) => {
    if (busy.has(path)) return { busy: [busy.get(path)], release: () => assert.fail(`busy ${path} released`) };
    held.add(path);
    return { busy: [], release: () => { held.delete(path); existedAtRelease.set(path, existsSync(path)); } };
  };
  return { reserve, held, existedAtRelease };
};

test("finished nightly worktrees are removed with their audit log kept, while running, today's, unmerged, edited, colliding and other worktrees stay", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-wt-prune-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  try {
    const repo = join(root, "CUELO-private"), trees = `${repo}-worktrees`, archive = join(root, "nightly-audit");
    git(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "a");
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    git(repo, "add", "a.txt", ".gitignore");
    git(repo, "commit", "-qm", "a");
    const add = (branch) => {
      const path = join(trees, branch.replaceAll("/", "-"));
      git(repo, "worktree", "add", "-q", "-b", branch, path);
      return path;
    };
    const audit = (path, name, text) => {
      mkdirSync(join(path, ".audit"), { recursive: true });
      writeFileSync(join(path, ".audit", name), text);
    };
    // 끝난 사본: 결정 기록과 무시되는 의존성 폴더만 남았다.
    const done = add("wt/nightly-20261103");
    audit(done, "nightly-2026-11-03.tsv", "ts\tphase\n");
    mkdirSync(join(done, "node_modules"));
    writeFileSync(join(done, "node_modules", "x.js"), "x");
    // 보관 위치에 같은 이름이 이미 있는 사본: 덮지도 지우지도 않는다.
    const collide = add("wt/nightly-20261102");
    audit(collide, "nightly-2026-11-02.tsv", "new\n");
    mkdirSync(join(archive, "wt-nightly-20261102"), { recursive: true });
    writeFileSync(join(archive, "wt-nightly-20261102", "nightly-2026-11-02.tsv"), "older\n");
    // 끝난 사본이지만 다른 세션(재개한 세션·background job이 남은 세션)이 그 경로를 쓰고 있다(공개 이슈 #69).
    const inUse = add("wt/nightly-20261101");
    audit(inUse, "nightly-2026-11-01.tsv", "in use\n");
    const running = add("wt/nightly-20261104");
    const edited = add("wt/nightly-20261105");
    writeFileSync(join(edited, "a.txt"), "changed");
    const unmerged = add("wt/nightly-20261106");
    writeFileSync(join(unmerged, "b.txt"), "b");
    git(unmerged, "add", "b.txt");
    git(unmerged, "commit", "-qm", "b");
    const today = add("wt/nightly-20261107");
    const recoveredToday = add("wt/nightly-20261107-inbox");
    const topic = add("wt/topic");
    const base = git(repo, "rev-parse", "main");

    /** 2026-11-07 04:00 KST */
    const guard = reservations(new Map([[inUse, "older-active"]]));
    const result = await pruneNightlyWorktrees(repo, base, new Set(["wt/nightly-20261104"]), new Date("2026-11-06T19:00:00.000Z"), guard.reserve);
    assert.deepEqual(result.removed, [done]);
    assert.deepEqual(result.warnings.map((w) => w.split("를 ")[0]).sort(), [collide, edited, inUse].sort());
    assert.match(result.warnings.find((w) => w.startsWith(inUse)), /older-active/);
    assert.equal(existsSync(done), false);
    for (const kept of [collide, running, edited, unmerged, today, recoveredToday, topic, inUse]) assert.equal(existsSync(kept), true, kept);
    assert.equal(readFileSync(join(edited, "a.txt"), "utf8"), "changed");
    assert.equal(readFileSync(join(archive, "wt-nightly-20261103", "nightly-2026-11-03.tsv"), "utf8"), "ts\tphase\n");
    assert.equal(readFileSync(join(archive, "wt-nightly-20261102", "nightly-2026-11-02.tsv"), "utf8"), "older\n");
    assert.equal(readFileSync(join(collide, ".audit", "nightly-2026-11-02.tsv"), "utf8"), "new\n");
    // 쓰는 세션이 있는 사본은 결정 기록도 옮기지 않는다.
    assert.equal(readFileSync(join(inUse, ".audit", "nightly-2026-11-01.tsv"), "utf8"), "in use\n");
    assert.equal(existsSync(join(archive, "wt-nightly-20261101")), false);
    // 예약은 지운 사본에선 삭제가 끝난 뒤에, 건너뛴 사본에선 건너뛸 때 모두 풀린다.
    assert.equal(guard.held.size, 0);
    assert.equal(guard.existedAtRelease.get(done), false);
    for (const skipped of [collide, edited]) assert.equal(guard.existedAtRelease.get(skipped), true, skipped);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worktree cleanup never touches the main checkout or a tracked .audit edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-wt-main-"));
  const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  try {
    const repo = join(root, "CUELO-private");
    git(root, "init", "-q", "-b", "main", repo);
    mkdirSync(join(repo, ".audit"));
    writeFileSync(join(repo, ".audit", "log"), "tracked\n");
    git(repo, "add", ".audit/log");
    git(repo, "commit", "-qm", "a");
    const base = git(repo, "rev-parse", "main");
    const old = join(`${repo}-worktrees`, "wt-nightly-20261101");
    git(repo, "worktree", "add", "-q", "-b", "wt/nightly-20261101", old);
    writeFileSync(join(old, ".audit", "log"), "edited\n");
    // 고친 것은 없지만 `.audit`을 추적하는 사본도 남긴다.
    const clean = join(`${repo}-worktrees`, "wt-nightly-20261102");
    git(repo, "worktree", "add", "-q", "-b", "wt/nightly-20261102", clean);
    // 메인 체크아웃이 지난 야간 브랜치에 있고 추적 안 한 결정 기록이 있다.
    git(repo, "switch", "-qc", "wt/nightly-20261001");
    writeFileSync(join(repo, ".audit", "mine.tsv"), "main\n");

    const result = await pruneNightlyWorktrees(repo, base, new Set(), new Date("2026-11-07T00:00:00.000Z"), reservations().reserve);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.warnings.map((w) => w.split("를 ")[0]), [old, clean]);
    assert.equal(readFileSync(join(old, ".audit", "log"), "utf8"), "edited\n");
    assert.equal(readFileSync(join(clean, ".audit", "log"), "utf8"), "tracked\n");
    assert.equal(readFileSync(join(repo, ".audit", "mine.tsv"), "utf8"), "main\n");
    assert.equal(existsSync(join(root, "nightly-audit")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("context load survives export and inbox reading; a missing or malformed field reads as unmeasured, not zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "nightly-context-load-"));
  try {
    const injected = { "goal-lane": { count: 4, size: 400, repeats: 2, repeatSize: 200 }, "todo-nudge": { count: 10, size: 900, repeats: 0, repeatSize: 0 } };
    for (let i = 1; i <= 199; i++) injected[`k${String(i).padStart(3, "0")}`] = { count: 1, size: 10, repeats: 0, repeatSize: 0 };
    const scan = { contextLoad: { injected, reads: { count: 50, size: 5000, repeats: 5, repeatSize: 600 } }, windows: [{ turns: 20 }], scannedFiles: 3, warnings: [] };
    // 세션 디렉터리를 읽지 못한 스캔은 0건 집계가 아니라 집계 없음이다.
    assert.equal(exportContextLoad({ ...scan, scannedFiles: 0, warnings: ["세션 디렉터리를 읽지 못했습니다."] }), undefined);
    const exported = buildNightlyExport({ source: "home", now: NOW, report: fixture, skillCandidates: [], errorsBySignature: {}, contextLoad: exportContextLoad(scan) });
    const load = exported.contextLoad;
    assert.deepEqual([load.injected.length, load.injected[0].kind, load.injected[1].kind, load.rest], [200, "todo-nudge", "goal-lane", { kinds: 1, count: 1, size: 10, repeats: 0, repeatSize: 0 }]);
    assert.equal(load.injected.reduce((n, r) => n + r.count, load.rest.count), 213);
    writeFileSync(join(dir, "home.json"), JSON.stringify(exported));
    writeFileSync(join(dir, "office.json"), JSON.stringify(bundle("office", { generatedAt: NOW.toISOString() })));
    const valid = { turns: 5, partial: false, injected: [], rest: { kinds: 0, count: 0, size: 0, repeats: 0, repeatSize: 0 }, reads: { count: 0, size: 0, repeats: 0, repeatSize: 0 } };
    const broken = {
      lab: { ...valid, reads: undefined },
      laba: { ...valid, injected: [{ kind: "x" }] },
      labb: { ...valid, partial: "bad" },
      labc: { ...valid, reads: { count: 1, size: 1, repeats: 2, repeatSize: 0 } },
      // 집계로는 나올 수 없는 조합: 종류 0개인데 건수, 반복 0건인데 반복 크기, 같은 종류 두 줄.
      labd: { ...valid, rest: { kinds: 0, count: 1, size: 1, repeats: 0, repeatSize: 0 } },
      labe: { ...valid, reads: { count: 1, size: 5, repeats: 0, repeatSize: 5 } },
      labf: { ...valid, injected: [{ kind: "x", count: 1, size: 1, repeats: 0, repeatSize: 0 }, { kind: "x", count: 1, size: 1, repeats: 0, repeatSize: 0 }] },
      // 하나뿐인 read가 반복인데 반복 크기가 전체와 다름, 0바이트 read, 반복 아닌 read가 0바이트.
      labg: { ...valid, reads: { count: 1, size: 10, repeats: 1, repeatSize: 2 } },
      labh: { ...valid, reads: { count: 1, size: 0, repeats: 0, repeatSize: 0 } },
      labi: { ...valid, reads: { count: 2, size: 5, repeats: 1, repeatSize: 5 } },
    };
    for (const [source, contextLoad] of Object.entries(broken)) writeFileSync(join(dir, `${source}.json`), JSON.stringify({ ...bundle(source, { generatedAt: NOW.toISOString() }), contextLoad }));
    const { bundles } = readNightlyInbox(dir, NOW);
    assert.deepEqual(bundles.map((b) => [b.source, b.contextLoad?.reads.repeats ?? null]), [["home", 5], ...Object.keys(broken).map((s) => [s, null]), ["office", null]]);
    const prompt = planInboxRun(bundles, ranYesterday({}), NOW, [], REPO, OUTBOX, NO_ISSUES).prompt;
    assert.match(prompt, /read 결과: 50건, 요청 100건당 250\.0건, 5,000바이트\. 그중 반복 5건, 600바이트/);
    assert.match(prompt, /주입 `goal-lane`: 4건, 요청 100건당 20\.0건, 400자\. 그중 반복 2건, 200자/);
    assert.match(prompt, /그 밖의 주입 191종 합계: 191건, 요청 100건당 955\.0건, 1,910자\. 그중 반복 0건, 0자/);
    assert.equal(prompt.match(/이 묶음에는 집계가 없습니다/g)?.length, 11);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model error counts go from a PC session scan through the inbox into the prompt per source; missing or malformed counts read as unmeasured", async () => {
  const sessions = mkdtempSync(join(tmpdir(), "nightly-model-errors-sessions-"));
  const inbox = mkdtempSync(join(tmpdir(), "nightly-model-errors-inbox-"));
  try {
    const reply = (id, hoursAgo, extra = {}) => ({ type: "message", id, timestamp: recent(hoursAgo), message: { role: "assistant", content: [], provider: "openai-codex", model: "gpt-6.2-sol", stopReason: "stop", ...extra } });
    mkdirSync(join(sessions, "cwd"), { recursive: true });
    writeFileSync(join(sessions, "cwd", "s.jsonl"), [
      { type: "session", id: "S", timestamp: recent(30) },
      reply("a1", 29), reply("e1", 28, { stopReason: "error", errorMessage: "400 Unsupported parameter: system" }),
      reply("e2", 27, { stopReason: "error", errorMessage: "CodexWhitespaceToolCallLoopError: stalled" }), reply("a2", 26),
    ].map((row) => JSON.stringify(row)).join("\n"));
    const scan = await scanSessions(sessions, NOW.getTime(), [], [], true);
    const home = buildNightlyExport({ source: "home", now: NOW, report: fixture, skillCandidates: [], errorsBySignature: {}, modelErrors: scan.modelErrors });
    writeFileSync(join(inbox, "home.json"), JSON.stringify(home));
    // 예전 판 PC의 묶음에는 필드가 없다.
    writeFileSync(join(inbox, "office.json"), JSON.stringify(bundle("office", { generatedAt: NOW.toISOString() })));
    const from = new Date(modelErrorFrom(NOW.getTime())).toISOString();
    const to = NOW.toISOString();
    const day = { day: "2026-10-30", assistant: 3, codex: 2, systemParam: 0, whitespace: 1, whitespaceRecovered: 1, whitespaceUnrecovered: 0, whitespacePending: 0 };
    const yearOn = (iso) => new Date(Date.parse(iso) + 365 * 86_400_000).toISOString();
    const sources = {
      // 측정은 했지만 Codex 응답이 없고 일부 파일을 읽지 못한 PC.
      quiet: { from, to, partial: true, days: [] },
      // Codex 응답이 있는 날 다음 날에 응답이 없으면, 그날은 0건이 아니라 관찰 없음이다.
      pair: { from, to, partial: false, days: [{ ...day, day: "2026-10-29" }, { ...day, day: "2026-10-30", codex: 0, whitespace: 0, whitespaceRecovered: 0 }] },
      laba: { from, to, partial: false, days: [{ ...day, whitespaceRecovered: 0 }] },
      labb: { from, to, partial: false, days: [{ ...day, codex: 4 }] },
      labc: { from, to, partial: false, days: [{ ...day, day: "2026-09-01" }] },
      labd: { from, to, partial: false, days: [day, day] },
      labe: { from, to, partial: "no", days: [] },
      labf: { from: yearOn(from), to: yearOn(to), partial: false, days: [] },
      labg: { from: new Date(NOW.getTime() - 60_000).toISOString(), to, partial: false, days: [] },
      labh: { from, to, partial: false, days: [], extra: 1 },
      labi: { from, to, partial: false, days: [{ ...day, extra: 1 }] },
      labj: { from, to, partial: false, days: [{ ...day, assistant: 1, codex: 0, whitespace: 0, whitespaceRecovered: 0, systemParam: 1 }] },
      labk: { from: "2026-10-19T00:00:00Z", to, partial: false, days: [] },
    };
    for (const [source, modelErrors] of Object.entries(sources)) writeFileSync(join(inbox, `${source}.json`), JSON.stringify({ ...bundle(source, { generatedAt: NOW.toISOString() }), modelErrors }));
    const { bundles } = readNightlyInbox(inbox, NOW);
    assert.deepEqual(bundles.filter((b) => b.modelErrors).map((b) => [b.source, b.modelErrors.days.length]), [["home", 1], ["pair", 2], ["quiet", 0]]);
    const prompt = planInboxRun(bundles, ranYesterday({}), NOW, [], REPO, OUTBOX, NO_ISSUES).prompt;
    const block = (source) => { const start = prompt.indexOf(`# ${source}\n`); return prompt.slice(start, prompt.indexOf("\n# ", start + 1)); };
    assert.match(block("home"), /  - 10-31: assistant 응답 4건 중 Codex 4건, `Unsupported parameter: system` 거절 1건, 공백 스트림 오류 1건\(다음 사람 요청 전 복구 1, 사람 요청이 먼저 옴 0, 결말 없음 0\)/);
    assert.match(block("home"), /  - 10-30: assistant 응답 0건, Codex 응답 없음\(관찰 없음\)/);
    assert.match(block("pair"), /  - 10-29: assistant 응답 3건 중 Codex 2건, .* 공백 스트림 오류 1건\(다음 사람 요청 전 복구 1,/);
    assert.match(block("pair"), /  - 10-30: assistant 응답 3건, Codex 응답 없음\(관찰 없음\)/);
    assert.match(block("quiet"), /일부만 측정/);
    assert.equal(block("quiet").match(/Codex 응답 없음\(관찰 없음\)/g)?.length, 14);
    assert.equal(prompt.match(/집계를 보내기 전 판이거나 모양이 틀린 집계/g)?.length, 12);
  } finally {
    rmSync(sessions, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("cache ledger break counts go from a PC session scan through the inbox into the prompt per source; missing or malformed counts read as unmeasured", async () => {
  const sessions = mkdtempSync(join(tmpdir(), "nightly-prefix-breaks-sessions-"));
  const inbox = mkdtempSync(join(tmpdir(), "nightly-prefix-breaks-inbox-"));
  try {
    const brk = (id, hoursAgo, data) => ({ type: "custom", id, timestamp: recent(hoursAgo), customType: "prompt-prefix-break", data: { v: 1, wire: "anthropic", ...data } });
    const rows = [
      { type: "session", id: "S", timestamp: recent(30) },
      brk("b1", 29, { prev: "x [한국어 번역]\n안녕", cur: "x plain" }),
      brk("b2", 28, { prev: "a", cur: "b" }),
      brk("b3", 27, { prev: "[한국어 번역] a", cur: "[한국어 번역] b" }),
      brk("b4", 26, { wire: "responses", prev: "[한국어 번역]", cur: "c" }),
      brk("b5", 24 * 20, { prev: "[한국어 번역]", cur: "c" }),
      // A non-custom row carrying the same fields is not a ledger break.
      { ...brk("m1", 25, { prev: "[한국어 번역]", cur: "c" }), type: "message" },
    ];
    mkdirSync(join(sessions, "cwd", "S"), { recursive: true });
    writeFileSync(join(sessions, "cwd", "s.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
    // 하위 세션 사본의 같은 기록(id와 시각)은 한 번만 센다.
    writeFileSync(join(sessions, "cwd", "S", "child.jsonl"), [{ type: "session", id: "C", timestamp: recent(29), parentSession: "S" }, rows[1]].map((row) => JSON.stringify(row)).join("\n"));
    const scan = await scanSessions(sessions, NOW.getTime(), [], [], true);
    assert.deepEqual(scan.prefixBreaks.days.map(({ anthropic, translation }) => [anthropic, translation]), [[3, 1]]);
    const home = buildNightlyExport({ source: "home", now: NOW, report: fixture, skillCandidates: [], errorsBySignature: {}, prefixBreaks: scan.prefixBreaks });
    writeFileSync(join(inbox, "home.json"), JSON.stringify(home));
    // 예전 판 PC의 묶음에는 필드가 없다.
    writeFileSync(join(inbox, "office.json"), JSON.stringify(bundle("office", { generatedAt: NOW.toISOString() })));
    const from = new Date(modelErrorFrom(NOW.getTime())).toISOString();
    const to = NOW.toISOString();
    const broken = {
      laba: { from, to, partial: false, days: [{ day: "2026-10-30", anthropic: 1, translation: 2 }] },
      labb: { from, to, partial: false, days: [{ day: "2026-10-30", anthropic: 0, translation: 0 }] },
      labc: { from, to, partial: false, days: [{ day: "2026-09-01", anthropic: 1, translation: 0 }] },
      labd: { from, to, partial: false, days: [{ day: "2026-10-30", anthropic: 1, translation: 0, extra: 1 }] },
    };
    for (const [source, prefixBreaks] of Object.entries(broken)) writeFileSync(join(inbox, `${source}.json`), JSON.stringify({ ...bundle(source, { generatedAt: NOW.toISOString() }), prefixBreaks }));
    const { bundles } = readNightlyInbox(inbox, NOW);
    assert.deepEqual(bundles.filter((b) => b.prefixBreaks).map((b) => b.source), ["home"]);
    const prompt = planInboxRun(bundles, ranYesterday({}), NOW, [], REPO, OUTBOX, NO_ISSUES).prompt;
    const block = (source) => { const start = prompt.indexOf(`# ${source}\n`); return prompt.slice(start, prompt.indexOf("\n# ", start + 1)); };
    assert.match(block("home"), /## 캐시 장부 끊김 집계[\s\S]*  - \d\d-\d\d: 끊김 3건, 그중 번역 끼어들기 1건/);
    assert.equal(block("home").match(/끊김 기록 없음/g)?.length, 13);
    assert.equal(prompt.match(/끊김 집계를 싣기 전 판이거나 모양이 틀린 집계/g)?.length, 5);
  } finally {
    rmSync(sessions, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  }
});

test("plugin event counts go from a PC profile through the inbox into the prompt per source without session ids or text; missing or malformed counts read as unmeasured", async () => {
  const agent = mkdtempSync(join(tmpdir(), "nightly-plugin-events-agent-"));
  const inbox = mkdtempSync(join(tmpdir(), "nightly-plugin-events-inbox-"));
  try {
    const line = (row) => `${JSON.stringify(row)}\n`;
    writeFileSync(join(agent, "cuelo-screen-fast-path-events.jsonl"), [
      line({ at: recent(24 * 20), event: "blocked", target: "/tmp/secret-shot.png", question: "where do I click SECRETWORD" }),
      line({ at: recent(5), event: "blocked", target: "/tmp/a.png", question: "click position" }),
      line({ at: recent(4), event: "allowed", target: "/tmp/a.png", question: "q", after: {} }),
      "not json\n",
      line({ at: recent(3), event: "Has Space", question: "x" }),
      // 종류 자리에 든 세션 id나 16진 id 모양은 종류로 내보내지 않는다.
      line({ at: recent(3), event: "00000000-0000-4000-8000-000000000001" }),
      line({ at: recent(3), event: "deadbeef-cafe" }),
      " \t\n",
      // 집계 시각 뒤에 붙은 줄은 기간에 넣지 않고 읽지 못한 줄로 센다.
      line({ at: new Date(NOW.getTime() + 1000).toISOString(), event: "blocked" }),
      // 쓰는 중인 마지막 조각은 세지 않는다.
      JSON.stringify({ at: recent(1), event: "blocked" }),
    ].join(""));
    writeFileSync(join(agent, "cuelo-recheck-hint-events.jsonl"), line({ ts: recent(2), sessionId: "01a1-session-id", kind: "remind-turn-end", items: [{ command: "bun test" }] }));
    writeFileSync(join(agent, "cuelo-empty-events.jsonl"), "");
    writeFileSync(join(agent, "other-events.jsonl"), line({ at: recent(1), kind: "x" }));
    // 읽지 못한 파일은 건너뛰고 일부만 측정으로 표시한다.
    mkdirSync(join(agent, "cuelo-broken-events.jsonl"));
    // 다른 곳을 가리키는 링크는 이 PC 프로필의 기록으로 세지 않는다.
    symlinkSync(join(agent, "cuelo-recheck-hint-events.jsonl"), join(agent, "cuelo-link-events.jsonl"));
    // 64KiB 조각 경계를 여러 번 넘는 파일과 1MiB를 넘는 한 줄(읽지 못한 줄 하나로 센다).
    writeFileSync(join(agent, "cuelo-big-events.jsonl"), [
      ...Array.from({ length: 3000 }, () => line({ at: recent(6), kind: "reset" })),
      `${"x".repeat(1_100_000)}\n`,
      line({ at: recent(6), kind: "advice" }),
    ].join(""));
    const events = await collectPluginEvents(agent, NOW);
    assert.equal(await collectPluginEvents(join(agent, "missing"), NOW), undefined);
    const home = buildNightlyExport({ source: "home", now: NOW, report: fixture, skillCandidates: [], errorsBySignature: {}, pluginEvents: events });
    const text = JSON.stringify(home);
    for (const leaked of ["SECRETWORD", "secret-shot", "01a1-session-id", "bun test", "click position", "00000000-0000", "deadbeef"]) assert.equal(text.includes(leaked), false, leaked);
    writeFileSync(join(inbox, "home.json"), text);
    // 예전 판 PC의 묶음에는 필드가 없다.
    writeFileSync(join(inbox, "office.json"), JSON.stringify(bundle("office", { generatedAt: NOW.toISOString() })));
    const to = NOW.toISOString();
    const from = new Date(NOW.getTime() - 14 * 86_400_000).toISOString();
    const file = { plugin: "errexit-reset", first: recent(30), last: recent(2), kinds: [{ kind: "reset", total: 3, recent: 3 }], unreadable: 0 };
    const sources = {
      none: { from, to, partial: false, plugins: [] },
      laba: { from, to, partial: false, plugins: [{ ...file, kinds: [{ kind: "reset", total: 1, recent: 2 }] }] },
      labb: { from, to, partial: false, plugins: [{ ...file, first: null }] },
      labc: { from, to, partial: false, plugins: [{ ...file, first: recent(1), last: recent(2) }] },
      labd: { from, to, partial: false, plugins: [file, file] },
      labe: { from, to, partial: false, plugins: [{ ...file, plugin: "../x" }] },
      labf: { from, to, partial: false, plugins: [{ ...file, kinds: [{ kind: "free text here", total: 1, recent: 1 }] }] },
      labg: { from, to, partial: false, plugins: [{ ...file, sessionId: "s" }] },
      labh: { from: new Date(NOW.getTime() - 86_400_000).toISOString(), to, partial: false, plugins: [] },
      labi: { from, to, partial: false, plugins: [{ ...file, kinds: [] }] },
      labj: { from, to, partial: false, plugins: [{ ...file, first: recent(400), last: recent(400), kinds: [{ kind: "reset", total: 1, recent: 1 }] }] },
      labk: { from, to, partial: false, plugins: [{ ...file, kinds: [{ kind: "reset", total: 3, recent: 2 }] }] },
      labl: { from: new Date(NOW.getTime() - 14 * 86_400_000 - 1).toISOString(), to: new Date(NOW.getTime() - 1).toISOString(), partial: false, plugins: [] },
      labm: { from, to, partial: false, plugins: [{ ...file, last: new Date(NOW.getTime() + 1000).toISOString() }] },
      labn: { from, to, partial: false, plugins: [{ ...file, kinds: [{ kind: "deadbeef-cafe", total: 3, recent: 3 }] }] },
      gone: { from, to, partial: true, plugins: [] },
      labo: { from, to, partial: false, plugins: [{ ...file, first: recent(3), last: recent(2), kinds: [{ kind: "reset", total: 1, recent: 1 }] }] },
    };
    for (const [source, pluginEvents] of Object.entries(sources)) writeFileSync(join(inbox, `${source}.json`), JSON.stringify({ ...bundle(source, { generatedAt: NOW.toISOString() }), pluginEvents }));
    const { bundles } = readNightlyInbox(inbox, NOW);
    assert.deepEqual(bundles.filter((b) => b.pluginEvents).map((b) => [b.source, b.pluginEvents.plugins.map((p) => p.plugin)]), [["gone", []], ["home", ["big", "empty", "recheck-hint", "screen-fast-path"]], ["none", []]]);
    assert.deepEqual(bundles.find((b) => b.source === "home").pluginEvents.plugins.find((p) => p.plugin === "big").kinds, [{ kind: "reset", total: 3000, recent: 3000 }, { kind: "advice", total: 1, recent: 1 }]);
    assert.equal(bundles.find((b) => b.source === "home").pluginEvents.plugins.find((p) => p.plugin === "big").unreadable, 1);
    const screen = bundles.find((b) => b.source === "home").pluginEvents.plugins.find((p) => p.plugin === "screen-fast-path");
    assert.deepEqual(screen, { plugin: "screen-fast-path", first: recent(24 * 20), last: recent(4), kinds: [{ kind: "blocked", total: 2, recent: 1 }, { kind: "allowed", total: 1, recent: 1 }], unreadable: 6 });
    assert.equal(bundles.find((b) => b.source === "home").pluginEvents.partial, true);
    const prompt = planInboxRun(bundles, ranYesterday({}), NOW, [], REPO, OUTBOX, NO_ISSUES).prompt;
    const block = (source) => { const start = prompt.indexOf(`# ${source}\n`); return prompt.slice(start, prompt.indexOf("\n# ", start + 1)); };
    assert.match(block("home"), /- `screen-fast-path`: 첫 기록 10-12 19:30, 마지막 11-01 15:30; `blocked` 전체 2건\(최근 1건\), `allowed` 전체 1건\(최근 1건\); 종류나 시각을 읽지 못한 줄 6개/);
    assert.match(block("home"), /- `empty`: 읽은 기록 없음/);
    assert.match(block("home"), /일부만 측정/);
    assert.match(block("none"), /이벤트 파일이 하나도 없습니다\. 표본 없음으로 둡니다/);
    assert.match(block("gone"), /읽은 이벤트 파일이 없습니다\. 읽지 못한 파일이 있어 미측정으로 둡니다/);
    assert.doesNotMatch(block("gone"), /이벤트 파일이 하나도 없습니다/);
    assert.equal(prompt.match(/이 묶음에는 플러그인 이벤트 집계가 없습니다/g)?.length, 16);
  } finally {
    rmSync(agent, { recursive: true, force: true });
    rmSync(inbox, { recursive: true, force: true });
  }
});
