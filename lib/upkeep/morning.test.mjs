import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MORNING_STATE_FILE, collectCloudChanges, morningStateAfterRun, parseSkillNames, planMorningRun, readMorningState, writeMorningState,
} from "./morning.ts";
import { MORNING_PREAMBLE } from "./morning-prompt.ts";

/** 2026-11-04 06:00 KST */
const NOW = new Date("2026-11-03T21:00:00.000Z");
const commit = { sha: "a".repeat(40), committedAt: "2026-11-04T04:30:00+09:00", subject: "fix: nightly", records: ["doc/history/2026/11/04-x/main.md"] };
const noRelease = { current: "0.10.136", latest: "0.10.136", available: false };
const newRelease = { current: "0.10.136", latest: "0.10.137", available: true };
const reported = (extra = {}) => ({ sessionId: "prev", startedAt: "2026-11-03T20:00:00.000Z", reportedSha: "b".repeat(40), releaseVersion: "0.10.136", ...extra });
const input = (extra = {}) => ({
  repoCwd: "/repo", originHead: "c".repeat(40), base: { sha: "b".repeat(40), kind: "reported" }, cloudCommits: [], skills: [], release: noRelease, state: reported(), runningSessionIds: [], now: NOW, ...extra,
});

test("nothing new → skip", () => {
  assert.deepEqual(planMorningRun(input()), { action: "skip", reason: "nothing-new" });
  // 이미 알린 릴리스는 다시 계기가 되지 않는다(설치가 실패해도 2시간마다 되풀이하지 않게).
  assert.deepEqual(planMorningRun(input({ release: newRelease, state: reported({ releaseVersion: "0.10.137" }) })), { action: "skip", reason: "nothing-new" });
  // 릴리스를 확인하지 못한 것만으로는 열지 않는다.
  assert.deepEqual(planMorningRun(input({ release: null })), { action: "skip", reason: "nothing-new" });
});

test("each trigger alone starts a report session", () => {
  assert.deepEqual(planMorningRun(input({ cloudCommits: [commit] })).triggers, { cloudCommits: 1, skills: 0, release: null, nightly: null });
  assert.deepEqual(planMorningRun(input({ skills: ["deploy-check"] })).triggers, { cloudCommits: 0, skills: 1, release: null, nightly: null });
  assert.deepEqual(planMorningRun(input({ release: newRelease })).triggers, { cloudCommits: 0, skills: 0, release: "0.10.137", nightly: null });
  assert.deepEqual(planMorningRun(input({ release: newRelease, state: null })).triggers, { cloudCommits: 0, skills: 0, release: "0.10.137", nightly: null });
});

test("guards: no repo, previous session still running", () => {
  assert.deepEqual(planMorningRun(input({ cloudCommits: [commit], repoCwd: null })), { action: "skip", reason: "no-repo" });
  assert.deepEqual(planMorningRun(input({ cloudCommits: [commit], runningSessionIds: ["prev"] })), { action: "skip", reason: "previous-still-running" });
  assert.equal(planMorningRun(input({ cloudCommits: [commit], runningSessionIds: ["other"] })).action, "run");
  // 상태 기록에 실패했어도 이 서버가 연 세션이 돌고 있으면 하나 더 열지 않는다.
  assert.deepEqual(planMorningRun(input({ cloudCommits: [commit], state: null, acceptedSessionId: "S9", runningSessionIds: ["S9"] })), { action: "skip", reason: "previous-still-running" });
});

test("run plan targets the main checkout and the prompt carries the facts", () => {
  const plan = planMorningRun(input({ cloudCommits: [commit], skills: ["deploy-check"], release: newRelease, warnings: ["git fetch origin에 실패"] }));
  assert.equal(plan.repoCwd, "/repo");
  assert.equal(plan.sessionName, "클라우드 변경 보고 2026-11-04 06:00");
  assert.ok(plan.prompt.startsWith(MORNING_PREAMBLE));
  for (const part of [`origin/main ${"b".repeat(40)} 뒤`, "aaaaaaaaaaaa", "doc/history/2026/11/04-x/main.md", "- deploy-check", "새 버전 있음: 실행 중 0.10.136, 최신 공개 릴리스 0.10.137", "git fetch origin에 실패"]) {
    assert.ok(plan.prompt.includes(part), part);
  }
  assert.ok(planMorningRun(input({ skills: ["s"] })).prompt.includes("새 버전 없음"));
  assert.ok(planMorningRun(input({ skills: ["s"], base: { sha: "d".repeat(40), kind: "deployed" } })).prompt.includes(`이 PC에 배포한 ${"d".repeat(40)} 뒤`));
  assert.ok(planMorningRun(input({ skills: ["s"], base: null })).prompt.includes("비교할 기준이 없어 최근 며칠"));
});

test("state after run records origin/main and release; unknown values keep the previous ones", () => {
  const plan = planMorningRun(input({ skills: ["s"], release: newRelease }));
  assert.deepEqual(morningStateAfterRun(plan, reported(), "S2", "2026-11-03T21:00:01.000Z"),
    { sessionId: "S2", startedAt: "2026-11-03T21:00:01.000Z", reportedSha: "c".repeat(40), releaseVersion: "0.10.137" });
  const blind = planMorningRun(input({ skills: ["s"], originHead: null, release: null }));
  assert.deepEqual(morningStateAfterRun(blind, reported(), "S3", "t"), { sessionId: "S3", startedAt: "t", reportedSha: "b".repeat(40), releaseVersion: "0.10.136" });
  assert.deepEqual(morningStateAfterRun(blind, null, "S4", "t"), { sessionId: "S4", startedAt: "t" });
});

test("state file round trip; a broken file throws instead of reporting blindly", () => {
  const dir = mkdtempSync(join(tmpdir(), "morning-state-"));
  try {
    assert.equal(readMorningState(dir), null);
    writeMorningState(dir, reported());
    assert.deepEqual(readMorningState(dir), reported());
    writeMorningState(dir, reported({ nightlyResultAt: "2026-11-09T04:10:00.000Z" }));
    assert.equal(readMorningState(dir).nightlyResultAt, "2026-11-09T04:10:00.000Z");
    for (const broken of [{ sessionId: 1 }, { sessionId: "", startedAt: "2026-11-03T20:00:00Z" }, { sessionId: "S", startedAt: "invalid" },
      { sessionId: "S", startedAt: "2026-11-03T20:00:00Z", reportedSha: "not-a-sha" }, { sessionId: "S", startedAt: "2026-11-03T20:00:00Z", releaseVersion: "" },
      { sessionId: "S", startedAt: "2026-11-03T20:00:00Z", nightlyResultAt: "어제" }]) {
      writeFileSync(join(dir, MORNING_STATE_FILE), JSON.stringify(broken));
      assert.throws(() => readMorningState(dir), /not a morning report record/, JSON.stringify(broken));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skill names from the request body are filtered and deduplicated", () => {
  assert.deepEqual(parseSkillNames(["a-skill", "a-skill", "../etc", "Bad", 3, "b.c_d"]), ["a-skill", "b.c_d"]);
  assert.deepEqual(parseSkillNames("a-skill"), []);
});

const nightlyResult = (extra = {}) => ({
  version: 1, date: "2026-11-09", sessionId: "nightly-session", branch: "wt/nightly-20261109",
  worktree: "/data/cuelo/CUELO-private-worktrees/wt-nightly-20261109",
  startedAt: "2026-11-08T19:00:00.000Z", finishedAt: "2026-11-09T04:10:00.000Z", outcome: "held",
  leftovers: [" M lib/upkeep/morning.ts", "?? .audit/nightly-20261109.tsv"], leftoverCount: 7,
  unpushed: ["fix: 보고 순서 정리"], summary: "고친 파일을 커밋했지만 검토가 한도에 걸렸습니다.",
  warnings: [], ...extra,
});

test("a held nightly result starts a report on its own and carries the outcome section", () => {
  // 게시된 커밋도 스킬도 새 릴리스도 없어도 계기가 된다.
  const plan = planMorningRun(input({ nightlyResult: nightlyResult() }));
  assert.equal(plan.action, "run");
  assert.deepEqual(plan.triggers, { cloudCommits: 0, skills: 0, release: null, nightly: "held" });
  assert.equal(plan.nightlyResultAt, "2026-11-09T04:10:00.000Z");
  for (const part of [
    "## 클라우드 야간 실행 결과",
    "보류: 게시하지 못한 작업이 클라우드 작업 사본에 남아 있습니다",
    "실행 날짜: 2026-11-09",
    "남은 파일 7개 (앞 2개만 적음)",
    " M lib/upkeep/morning.ts",
    "origin/main에 없는 커밋 1개",
    "fix: 보고 순서 정리",
    "cuelo-nightly-run.sh --resume <session-id>",
    "클라우드에서 가져온 단순 자료",
    "nightly-session",
    "고친 파일을 커밋했지만 검토가 한도에 걸렸습니다.",
  ]) {
    assert.ok(plan.prompt.includes(part), part);
  }
  // 세션 요약은 바깥 글이라 울타리 안에 둔다.
  assert.match(plan.prompt, /```text\n고친 파일을 커밋했지만 검토가 한도에 걸렸습니다\.\n```/);
});

test("the same result is reported once; a clean one never triggers", () => {
  const result = nightlyResult();
  assert.deepEqual(planMorningRun(input({ nightlyResult: result, state: reported({ nightlyResultAt: result.finishedAt }) })), { action: "skip", reason: "nothing-new" });
  // 깨끗하게 끝난 실행은 게시된 실행과 같아 알리지 않는다.
  assert.deepEqual(planMorningRun(input({ nightlyResult: nightlyResult({ outcome: "clean" }) })), { action: "skip", reason: "nothing-new" });
  for (const outcome of ["interrupted", "failed"]) {
    assert.deepEqual(planMorningRun(input({ nightlyResult: nightlyResult({ outcome }) })).triggers.nightly, outcome);
  }
  // 모양이 맞지 않으면 없는 것으로 본다.
  for (const broken of [null, "x", { ...result, version: 2 }, { ...result, outcome: "unknown" }, { ...result, finishedAt: "어제" }, { ...result, leftovers: "없음" }]) {
    assert.deepEqual(planMorningRun(input({ nightlyResult: broken })), { action: "skip", reason: "nothing-new" }, JSON.stringify(broken));
  }
});

test("state after run records the nightly result time and keeps the previous one otherwise", () => {
  const plan = planMorningRun(input({ nightlyResult: nightlyResult() }));
  assert.deepEqual(morningStateAfterRun(plan, reported(), "S1", "t"),
    { sessionId: "S1", startedAt: "t", reportedSha: "c".repeat(40), releaseVersion: "0.10.136", nightlyResultAt: "2026-11-09T04:10:00.000Z" });
  // 다른 계기로 연 보고는 지난 결과 시각을 그대로 잇는다(같은 결과를 다시 알리지 않게).
  const other = planMorningRun(input({ skills: ["s"], state: reported({ nightlyResultAt: "2026-11-09T04:10:00.000Z" }) }));
  assert.equal(morningStateAfterRun(other, reported({ nightlyResultAt: "2026-11-09T04:10:00.000Z" }), "S2", "t").nightlyResultAt, "2026-11-09T04:10:00.000Z");
});

test("cloud changes: merged nightly branch commits after 03:00 KST of its date, minus the baseline", async () => {
  const root = mkdtempSync(join(tmpdir(), "morning-git-"));
  const git = (cwd, args, date) => execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  }).trim();
  const commitFile = (cwd, file, date) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), date);
    git(cwd, ["add", file]);
    git(cwd, ["commit", "-qm", `change ${file}`], date);
    return git(cwd, ["rev-parse", "HEAD"]);
  };
  try {
    const remote = join(root, "remote.git"), work = join(root, "work"), pc = join(root, "pc");
    git(root, ["init", "-q", "--bare", "-b", "main", remote]);
    git(root, ["clone", "-q", remote, work]);
    git(work, ["checkout", "-qb", "main"]);
    // 03:00 KST 전 PC 커밋(전날 밤, 그날 새벽)은 야간 브랜치에 들어 있어도 클라우드 것이 아니다.
    commitFile(work, "a.txt", "2026-11-03T23:00:00+09:00");
    const home = commitFile(work, "a2.txt", "2026-11-04T01:00:00+09:00");
    git(work, ["push", "-q", "origin", "main"]);
    git(work, ["checkout", "-qb", "wt/nightly-20261104"]);
    const nightly = commitFile(work, "doc/history/2026/11/04-x/main.md", "2026-11-04T04:30:00+09:00");
    git(work, ["push", "-q", "origin", "wt/nightly-20261104"]);
    git(work, ["checkout", "-q", "main"]);
    git(work, ["merge", "-q", "--ff-only", "wt/nightly-20261104"]);
    git(work, ["push", "-q", "origin", "main"]);
    // main에 게시되지 않은 야간 브랜치는 세지 않는다.
    git(work, ["checkout", "-qb", "wt/nightly-20261105"]);
    commitFile(work, "b.txt", "2026-11-05T04:30:00+09:00");
    git(work, ["push", "-q", "origin", "wt/nightly-20261105"]);
    git(root, ["clone", "-q", remote, pc]);

    const none = { reported: null, deployed: null };
    const first = await collectCloudChanges(pc, none, NOW);
    assert.equal(first.originHead, nightly);
    assert.equal(first.base, null);
    assert.deepEqual(first.commits.map((c) => [c.sha, c.records]), [[nightly, ["doc/history/2026/11/04-x/main.md"]]]);
    assert.match(first.warnings.join("\n"), /기준 커밋이 없어 최근 3일/);
    const reportedHome = await collectCloudChanges(pc, { reported: home, deployed: null }, NOW);
    assert.deepEqual([reportedHome.base, reportedHome.commits.map((c) => c.sha), reportedHome.warnings], [{ sha: home, kind: "reported" }, [nightly], []]);
    assert.deepEqual((await collectCloudChanges(pc, { reported: nightly, deployed: null }, NOW)).commits, []);
    // 지난 보고 커밋이 없으면 배포한 리비전을 기준으로 삼는다(이미 설치한 야간 커밋은 다시 알리지 않는다).
    const lost = await collectCloudChanges(pc, { reported: "f".repeat(40), deployed: nightly.slice(0, 12) }, NOW);
    assert.deepEqual([lost.base, lost.commits], [{ sha: nightly.slice(0, 12), kind: "deployed" }, []]);
    assert.match(lost.warnings.join("\n"), /지난 보고 커밋 ffffffffffff을 이 저장소에서 찾지 못했습니다/);
    // 기준이 전혀 없으면 최근 3일 안의 야간 브랜치만 보고, 기준이 있으면 날짜와 관계없이 본다.
    const late = new Date("2026-11-08T00:00:00+09:00");
    assert.deepEqual((await collectCloudChanges(pc, none, late)).commits, []);
    assert.deepEqual((await collectCloudChanges(pc, { reported: home, deployed: null }, late)).commits.map((c) => c.sha), [nightly]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
