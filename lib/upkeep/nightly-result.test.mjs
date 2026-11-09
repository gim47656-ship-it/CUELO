import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NIGHTLY_RESULT_FILE, inspectNightlyResult, parseNightlyResult, readLastAssistant, writeNightlyResult,
} from "./nightly-result.ts";
import { planMorningRun } from "./morning.ts";

const NOW = "2026-11-09T05:00:00.000Z";
const state = (worktree, extra = {}) => ({ date: "2026-11-09", sessionId: "11111111-2222-3333-4444-555555555555", worktree, startedAt: "2026-11-08T19:00:00.000Z", ...extra });

/** 작업 사본 하나를 origin/main이 있는 상태로 만들고, 그 사본 경로를 돌려준다. */
function repoWithWorktree(root) {
  const git = (cwd, args) => execFileSync("git", args, {
    cwd, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  git(root, ["clone", "-q", remote, main]);
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, ["add", "a.txt"]);
  git(main, ["commit", "-qm", "base"]);
  git(main, ["push", "-q", "origin", "main"]);
  const worktree = join(root, "wt");
  git(main, ["worktree", "add", "-q", "-b", "wt/nightly-20261109", worktree]);
  return { git, main, worktree };
}

/** 마지막 assistant 메시지가 담긴 세션 기록 파일. */
function sessionFile(root, { stopReason = "stop", errorMessage, text = "밤사이 작업했습니다." } = {}) {
  const path = join(root, `session-${stopReason}.jsonl`);
  const lines = [
    { type: "session", id: "S", cwd: "/x" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "야간 작업" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text }], stopReason, ...(errorMessage ? { errorMessage } : {}) } },
  ];
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return path;
}

test("worktree leftovers decide held; only the untracked .audit log is ignored", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const { worktree } = repoWithWorktree(root);
    const clean = await inspectNightlyResult({ state: state(worktree), interrupted: false });
    assert.deepEqual([clean.outcome, clean.leftoverCount, clean.unpushed], ["clean", 0, []]);

    mkdirSync(join(worktree, ".audit"), { recursive: true });
    writeFileSync(join(worktree, ".audit", "nightly-20261109.tsv"), "ts\tphase\n");
    const auditOnly = await inspectNightlyResult({ state: state(worktree), interrupted: false });
    assert.equal(auditOnly.outcome, "clean");

    // 추적하는 파일을 고친 사본은 보류다.
    writeFileSync(join(worktree, "a.txt"), "changed\n");
    const tracked = await inspectNightlyResult({ state: state(worktree), interrupted: false });
    assert.equal(tracked.outcome, "held");
    assert.equal(tracked.leftoverCount, 1);
    assert.match(tracked.leftovers[0], /a\.txt/);

    // 추적하지 않는 파일 하나도 보류다(.audit 밖).
    writeFileSync(join(worktree, "a.txt"), "a\n");
    writeFileSync(join(worktree, "new.txt"), "n\n");
    const untracked = await inspectNightlyResult({ state: state(worktree), interrupted: false });
    assert.equal(untracked.outcome, "held");
    assert.match(untracked.leftovers[0], /new\.txt/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit not in origin/main is held even after it is pushed to a wt branch", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const { git, worktree } = repoWithWorktree(root);
    writeFileSync(join(worktree, "b.txt"), "b\n");
    git(worktree, ["add", "b.txt"]);
    git(worktree, ["commit", "-qm", "고친 것"]);
    git(worktree, ["push", "-q", "origin", "wt/nightly-20261109"]);
    const pushed = await inspectNightlyResult({ state: state(worktree), interrupted: false });
    assert.deepEqual([pushed.outcome, pushed.leftoverCount, pushed.unpushed], ["held", 0, ["고친 것"]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted wins over held, a missing worktree is failed, and a session error is failed", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const { worktree } = repoWithWorktree(root);
    writeFileSync(join(worktree, "a.txt"), "changed\n");
    const interrupted = await inspectNightlyResult({ state: state(worktree), interrupted: true });
    assert.equal(interrupted.outcome, "interrupted");

    const missing = await inspectNightlyResult({ state: state(join(root, "gone")), interrupted: false });
    assert.equal(missing.outcome, "failed");
    assert.match(missing.error, /작업 사본을 찾지 못했습니다/);

    // 작업 사본이 깨끗해도 세션의 마지막 답이 오류면 실패다. 남은 변경이 있으면 그쪽(보류)이 먼저다.
    const failed = await inspectNightlyResult({
      state: state(worktree), sessionFile: sessionFile(root, { stopReason: "error", errorMessage: "429 rate_limit_error" }), interrupted: false,
    });
    assert.equal(failed.outcome, "held");
    writeFileSync(join(worktree, "a.txt"), "a\n");
    const cleanSession = await inspectNightlyResult({
      state: state(worktree), sessionFile: sessionFile(root, { stopReason: "error", errorMessage: "429 rate_limit_error" }), interrupted: false,
    });
    assert.deepEqual([cleanSession.outcome, cleanSession.error], ["failed", "429 rate_limit_error"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the last assistant message is read from the tail of the session file", () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const path = sessionFile(root, { stopReason: "error", errorMessage: "usage limit", text: "남은 일을 마쳤습니다." });
    assert.deepEqual(readLastAssistant(path), { text: "남은 일을 마쳤습니다.", stopReason: "error", errorMessage: "usage limit", timestamp: null });
    assert.equal(readLastAssistant(join(root, "missing.jsonl")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one result file per inbox source, atomic and private", () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const inbox = join(root, "inbox"), outbox = join(root, "outbox");
    mkdirSync(inbox, { recursive: true });
    for (const name of ["home.json", "office-2.json", "Bad Name.json", "notes.txt"]) writeFileSync(join(inbox, name), "{}");
    mkdirSync(join(inbox, "nested"), { recursive: true });
    const result = {
      version: 1, date: "2026-11-09", sessionId: "S", branch: "wt/nightly-20261109", worktree: "/wt",
      startedAt: "2026-11-08T19:00:00.000Z", finishedAt: NOW, outcome: "held",
      leftovers: [" M a.txt"], leftoverCount: 1, unpushed: [], summary: "요약", warnings: [],
    };
    assert.deepEqual(writeNightlyResult(outbox, inbox, result), { written: ["home", "office-2"], failed: [] });
    for (const source of ["home", "office-2"]) {
      const file = join(outbox, source, NIGHTLY_RESULT_FILE);
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), result);
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.throws(() => statSync(join(outbox, "Bad Name.json")), /ENOENT/);
    // 받은편지함 폴더가 없으면 아무것도 쓰지 않는다(클라우드가 받은 기록 없이 결과만 만들지 않게).
    assert.deepEqual(writeNightlyResult(outbox, join(root, "no-inbox"), result), { written: [], failed: [] });
    // 출처 폴더가 밖을 가리키는 심볼릭 링크면 그 출처에는 쓰지 않는다.
    rmSync(join(outbox, "office-2"), { recursive: true, force: true });
    symlinkSync("/etc", join(outbox, "office-2"));
    assert.deepEqual(writeNightlyResult(outbox, inbox, result), { written: ["home"], failed: ["office-2"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a result this module writes is always one it can read back", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const { git, worktree } = repoWithWorktree(root);
    // 아주 긴 요약과 긴 파일 이름도 상한 때문에 「다시 읽을 수 없는 파일」이 되지 않는다.
    writeFileSync(join(worktree, "a.txt"), "changed\n");
    writeFileSync(join(worktree, `${"n".repeat(200)}.txt`), "x\n");
    const last = { type: "message", timestamp: "2026-11-09T04:00:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "가".repeat(7000) }], stopReason: "stop" } };
    const path = join(root, "long.jsonl");
    writeFileSync(path, `${JSON.stringify({ type: "session", id: "S", cwd: "/x" })}\n${JSON.stringify(last)}\n`);
    const result = await inspectNightlyResult({ state: state(worktree), sessionFile: path, interrupted: false });
    assert.equal(result.outcome, "held");
    assert.ok(result.summary.length <= 6000);
    assert.ok(Math.max(...result.leftovers.map((line) => line.length)) <= 300);
    assert.deepEqual(parseNightlyResult(JSON.parse(JSON.stringify(result))), result);
    // finishedAt은 세션의 마지막 답 시각이라 같은 실행을 다시 알려도 같은 값이다(중복 보고를 막는 열쇠).
    assert.equal(result.finishedAt, "2026-11-09T04:00:00.000Z");
    const again = await inspectNightlyResult({ state: state(worktree), sessionFile: path, interrupted: false });
    assert.equal(again.finishedAt, result.finishedAt);
    git(worktree, ["checkout", "--", "a.txt"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing worktree with a long path still produces a result this module can read back", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-long-"));
  try {
    const inbox = join(root, "inbox"), outbox = join(root, "outbox");
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "home.json"), "{}\n");
    // 300자 대조군, 400자 한도의 경계 바로 아래·위(383/384), 공개 이슈 #80의 재현 길이(430), worktree 필드가 허용하는
    // 최대 길이(500).
    for (const length of [300, 383, 384, 430, 500]) {
      let parent = join(root, `nested-${length}`);
      mkdirSync(parent, { recursive: true });
      while (length - parent.length - 1 > 200) {
        parent = join(parent, "a".repeat(150));
        mkdirSync(parent, { recursive: true });
      }
      const worktree = join(parent, "w".repeat(length - parent.length - 1));
      assert.equal(worktree.length, length);
      // 정확한 경로가 이 파일 시스템에서 유효한지 확인한 다음, 방금 만든 빈 폴더만 지워 이미 없는 작업 사본을 만든다.
      mkdirSync(worktree);
      rmSync(worktree, { recursive: true, force: true });
      const result = await inspectNightlyResult({ state: state(worktree), sessionFile: null, interrupted: false });
      assert.equal(result.outcome, "failed");
      assert.match(result.error, /작업 사본을 찾지 못했습니다/);
      assert.ok(result.error.length <= 400, `${length}: ${result.error.length}자`);
      // 표시용 오류만 줄고 독립 worktree 필드는 500자 계약대로 원래 경로를 지킨다.
      assert.equal(result.worktree, worktree);
      assert.deepEqual(writeNightlyResult(outbox, inbox, result), { written: ["home"], failed: [] });
      const raw = JSON.parse(readFileSync(join(outbox, "home", NIGHTLY_RESULT_FILE), "utf8"));
      assert.deepEqual(parseNightlyResult(raw), result);
      // 실제 소비자(아침 planner)가 이 결과로 보고를 연다. 다른 계기는 두지 않는다.
      const plan = planMorningRun({
        repoCwd: root, originHead: null, base: null, cloudCommits: [], skills: [],
        release: { current: "0.10.181", latest: "0.10.181", available: false },
        state: null, runningSessionIds: [], now: new Date(NOW), nightlyResult: raw,
      });
      assert.equal(plan.action, "run");
      assert.equal(plan.triggers.nightly, "failed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("without a session file the same run keeps one identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    const { worktree } = repoWithWorktree(root);
    writeFileSync(join(worktree, "a.txt"), "changed\n");
    // 세션 기록을 읽을 수 없어도 보류로 남고, 두 번 불러도 같은 끝 시각이라 아침 보고가 중복으로 열리지 않는다.
    const first = await inspectNightlyResult({ state: state(worktree), sessionFile: null, interrupted: false });
    const second = await inspectNightlyResult({ state: state(worktree), sessionFile: null, interrupted: true });
    assert.equal(first.outcome, "held");
    assert.deepEqual([first.finishedAt, second.finishedAt], ["2026-11-08T19:00:00.000Z", "2026-11-08T19:00:00.000Z"]);
    assert.match(first.warnings.join("\n"), /실행 시작 시각을 결과 시각으로 썼습니다/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an inspection that cannot see origin/main is not reported as clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "nightly-result-"));
  try {
    // origin 원격이 없는 사본: 게시 여부를 알 수 없으므로 깨끗하다고 말하지 않는다(그러면 유일한 계기가 사라진다).
    const local = join(root, "local");
    execFileSync("git", ["init", "-q", "-b", "main", local], { encoding: "utf8" });
    const git = (args) => execFileSync("git", args, {
      cwd: local, encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    writeFileSync(join(local, "a.txt"), "a\n");
    git(["add", "a.txt"]);
    git(["commit", "-qm", "base"]);
    const result = await inspectNightlyResult({ state: state(local), sessionFile: sessionFile(root), interrupted: false });
    assert.equal(result.outcome, "failed");
    assert.match(result.error, /origin\/main을 찾지 못해/);
    assert.ok(parseNightlyResult(JSON.parse(JSON.stringify(result))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an untrusted result file is validated before it reaches the prompt", () => {
  const good = {
    version: 1, date: "2026-11-09", sessionId: "S", branch: "wt/nightly-20261109", worktree: "/wt",
    startedAt: "2026-11-08T19:00:00.000Z", finishedAt: "2026-11-09T05:00:00.000Z", outcome: "interrupted",
    leftovers: [], leftoverCount: 0, unpushed: [], summary: "요약", warnings: ["w"],
  };
  assert.deepEqual(parseNightlyResult(good), good);
  for (const broken of [
    null, "x", [], { ...good, version: 2 }, { ...good, outcome: "unknown" }, { ...good, finishedAt: "yesterday" },
    { ...good, startedAt: undefined }, { ...good, leftoverCount: -1 }, { ...good, leftoverCount: 1.5 },
    { ...good, leftovers: "M a.txt" }, { ...good, leftovers: ["x".repeat(400)] }, { ...good, summary: "s".repeat(6001) },
    { ...good, error: 5 }, { ...good, sessionId: "" },
  ]) {
    assert.equal(parseNightlyResult(broken), null, JSON.stringify(broken));
  }
  // 오류 문구와 경고는 선택이다.
  assert.equal(parseNightlyResult({ ...good, error: "429" }).error, "429");
  assert.deepEqual(parseNightlyResult({ ...good, warnings: undefined }).warnings, []);
});
