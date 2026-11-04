import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHandoff } from "./handoff.ts";
import { nightlyStateAfterRun, NIGHTLY_PREAMBLE, NIGHTLY_STATE_FILE, readNightlyState, writeNightlyState } from "./nightly.ts";
import {
  buildNightlyExport, createNightlyBranch, INBOX_SUMMARY_RULES, nightlySourceName, planInboxRun, rankToolFailures, readCloudHandoffs,
  readNightlyInbox, sanitizeSource,
} from "./nightly-inbox.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
/** 2026-11-02 04:30 KST */
const NOW = new Date("2026-11-01T19:30:00.000Z");
const REPO = "/data/cuelo/workspace/CUELO-private";
const OUTBOX = "/data/cuelo/nightly-outbox";
const recent = (hoursAgo) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
const ranYesterday = (sources) => ({ date: "2026-11-01", sessionId: "prev", worktree: "/w", startedAt: recent(24), sources });
const weeklyDone = { performanceReviewDate: "2026-10-31" };

function bundle(source, { problems = [], candidates = [], failures = [], generatedAt = recent(1), skillUsage = { rows: [], unused: [] }, excerpts = [], lab = [] } = {}) {
  return { version: 2, source, generatedAt, problems, skillCandidates: candidates, toolFailures: failures, skillUsage, failureExcerpts: excerpts, labPlugins: lab };
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
  ], state, NOW, [], REPO, OUTBOX);
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.sources.map((s) => [s.source, s.jobs]), [
    ["home", { problems: ["bottleneck/maker-wait"], skillCandidates: 1, weeklyReview: false }],
    ["office", { problems: [], skillCandidates: 0, weeklyReview: true }],
  ]);
  assert.deepEqual(plan.jobs, { problems: ["home:bottleneck/maker-wait"], skillCandidates: 1, weeklyReview: true, handoff: [] });
  const [, home, office] = plan.prompt.split(/^# (?=home$|office$)/m);
  assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE) && plan.prompt.endsWith(INBOX_SUMMARY_RULES));
  assert.ok(home.includes("## 보수 점검판 문제 행") && home.includes("집 요령") && !home.includes("## 주간 성능 점검"));
  assert.ok(office.includes("## 주간 성능 점검") && office.includes("1. bash: exit N (7건)") && !office.includes("## 절차서"));
  assert.ok(!office.includes("cuelo-tool-failure-aggregation"));
  assert.ok(plan.prompt.includes("출처(PC)마다 절을 나눠"));
  assert.ok(plan.prompt.includes(`${OUTBOX}/<출처>/<스킬 이름>/`) && plan.prompt.includes("manifest.json"));
});

test("inbox plan requires the same dated trail and review, retaining source attribution", () => {
  const { prompt } = planInboxRun([bundle("home"), bundle("office")], null, NOW, [], REPO, OUTBOX);
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
  const plan = planInboxRun([], null, NOW, [], REPO, OUTBOX, { items, base: { ref: "origin/main", sha: "0123456789abcdef" } });
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.jobs, { problems: [], skillCandidates: 0, weeklyReview: false, handoff: ["HANDOFF.md 「클라우드 야간 깨우기 관찰(11-01 점검, 클라우드 점검)」"] });
  assert.deepEqual(plan.base, { ref: "origin/main", sha: "0123456789abcdef" });
  const block = plan.prompt.slice(plan.prompt.indexOf("# 저장소 HANDOFF 클라우드 점검"));
  assert.ok(block.includes("origin/main `01234567`"), block);
  assert.ok(block.includes("journal로 본다.\n  - 이틀 연속 돌면 닫는다."), "the item's original text, continuation lines included");
  assert.ok(!block.includes("사무실 PC 관찰") && !block.includes("클라우드 CI 관찰") && !block.includes("굵은 제목이 아니다"));
  for (const instruction of [/원문에 적힌 조건과 기준으로만/, /journalctl/, /끝났으면 항목을 정리/, /제목의 점검일을 다음 점검일로/, /추측해 판정하지 않습니다/, /git_integrate/, /「HANDOFF 점검」 절/]) {
    assert.match(block, instruction);
  }
  assert.ok(plan.prompt.startsWith(NIGHTLY_PREAMBLE) && plan.prompt.endsWith(INBOX_SUMMARY_RULES));
  // 기한 전이거나 표시 없는 항목만 있으면 할 일이 없고, 맡길 항목이 있어도 기존 가드가 이긴다.
  const notYet = items.filter((item) => !item.ref.title.startsWith("클라우드 야간"));
  assert.deepEqual(planInboxRun([], null, NOW, [], REPO, OUTBOX, { items: notYet, base: null }), { action: "skip", reason: "nothing-to-do" });
  const fromHead = planInboxRun([], null, NOW, [], REPO, OUTBOX, { items, base: null });
  assert.equal(fromHead.base, null);
  assert.ok(fromHead.prompt.includes("시작한 커밋(저장소 작업 사본)"));
  assert.deepEqual(planInboxRun([], { ...ranYesterday({}), date: "2026-11-02" }, NOW, [], REPO, OUTBOX, { items, base: null }), { action: "skip", reason: "already-ran-today" });
  assert.deepEqual(planInboxRun([], ranYesterday({}), NOW, ["prev"], REPO, OUTBOX, { items, base: null }), { action: "skip", reason: "previous-still-running" });
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
    // 클라우드 사본을 만든 뒤 PC가 표시한 항목을 게시한다. 클라우드 HEAD는 아직 옛 커밋이다.
    writeFileSync(join(pc, "HANDOFF.md"), HANDOFF);
    git(pc, "commit", "-qam", "mark");
    git(pc, "push", "-q", "origin", "main");
    const published = git(pc, "rev-parse", "HEAD");

    const read = await readCloudHandoffs(cloud, NOW);
    assert.deepEqual(read.base, { ref: "origin/main", sha: published });
    const plan = planInboxRun([], null, NOW, [], cloud, OUTBOX, read);
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

    // origin이 없으면 worktree가 시작할 HEAD 커밋을 읽는다. 커밋하지 않은 작업 사본의 수정은 worktree에 없으므로 읽지 않는다.
    git(cloud, "remote", "remove", "origin");
    writeFileSync(join(cloud, "HANDOFF.md"), HANDOFF);
    const local = await readCloudHandoffs(cloud, NOW);
    assert.deepEqual(local.base, { ref: "HEAD", sha: git(cloud, "rev-parse", "HEAD") });
    assert.notEqual(local.base.sha, published);
    assert.deepEqual(local.items.map((item) => item.ref.title), ["옛 항목(11-01 점검)"]);
    assert.deepEqual(planInboxRun([], null, NOW, [], cloud, OUTBOX, local), { action: "skip", reason: "nothing-to-do" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
