import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as morning from "./morning.ts";
import { inspectNightlyResult, parseNightlyResult, writeNightlyResult } from "./nightly-result.ts";
import { activeCheckMarks, CHECK_MARKS_FILE, readCheckMarks, setCheckMark } from "./checks.ts";
import { activeFixMarks, FIX_MARKS_FILE, readFixMarks, setFixMark } from "./fixes.ts";
import { applyCheckMarks, applyFixMarks, memorySection } from "./collect.ts";
import { scanSessions } from "./sessions.ts";
import { bundleProblems } from "./nightly-inbox.ts";

const START = "2026-11-10T19:00:00.000Z";
const CHECKED = "2026-11-10T20:00:00.000Z";
const FINISHED = "2026-11-10T21:00:00.000Z";
const NOW = new Date("2026-11-11T01:00:00.000Z");
const INSTALLED = "2026-11-11T00:00:00.000Z";
const outcome = (source, metricId = "memory-export-failures", extra = {}) => ({
  source, metricId, checkedAt: CHECKED, disposition: "checked", note: `reviewed ${source}`,
  evidence: "https://github.com/example/repo/commit/abc#diff-1", ...extra,
});
const result = (source = "home", outcomes = [outcome(source)], extra = {}) => ({
  version: 2, source, date: "2026-11-11", sessionId: "nightly-session", branch: "wt/nightly-20261111", worktree: "/fixture/wt",
  startedAt: START, finishedAt: FINISHED, outcome: "clean", leftovers: [], leftoverCount: 0, unpushed: [], summary: "reviewed", warnings: [], outcomes, ...extra,
});
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "nightly-board-"));
  return Promise.resolve().then(() => run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}
function importTo(root, payload, options = {}) {
  const agentDir = join(root, options.source ?? "home", ".omp", "agent");
  mkdirSync(agentDir, { recursive: true });
  return morning.importNightlyOutcomes({ agentDir, state: morning.readMorningState(agentDir), result: payload, now: NOW,
    env: { CUELO_NIGHTLY_SOURCE: options.source ?? "home" }, ...options });
}
function installedEnv(root, overrides = {}) {
  const requestId = "a".repeat(32), stageHash = "b".repeat(64);
  const external = join(root, "external-update");
  mkdirSync(join(external, "results"), { recursive: true });
  writeFileSync(join(external, "results", `${requestId}.json`), JSON.stringify({
    schemaVersion: 2, requestId, stageHash, success: true, status: "succeeded",
    deployment: { completed: true, writeSafe: true, completedAtUtc: INSTALLED, requestId, stageHash,
      service: { ready: true, exact: true, requestId, stageHash } }, ...overrides,
  }));
  return { CUELO_NIGHTLY_SOURCE: "home", CUELO_DEPLOY_REQUEST_ID: requestId, CUELO_DEPLOY_STAGE_HASH: stageHash,
    CUELO_EXTERNAL_UPDATE_ROOT: external, NEXT_PUBLIC_APP_VERSION: "0.10.201" };
}

test("producer captures only this execution's explicit outcomes and returns only each PC's rows", () => fixture(async (root) => {
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env,
    GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" } }).trim();
  const remote = join(root, "remote.git"), worktree = join(root, "worktree");
  git(root, ["init", "-q", "--bare", "-b", "main", remote]);
  git(root, ["clone", "-q", remote, worktree]);
  writeFileSync(join(worktree, "base"), "base");
  git(worktree, ["add", "base"]); git(worktree, ["commit", "-qm", "base"]); git(worktree, ["push", "-q", "origin", "main"]);
  const state = { date: "2026-11-11", sessionId: "nightly-session", worktree, startedAt: START, sources: { home: {}, office: {} } };
  const audit = join(worktree, ".audit"); mkdirSync(audit);
  const artifact = join(audit, "nightly-outcomes-2026-11-11.json");
  const rows = [outcome("home"), outcome("office", "purpose:draft")];
  writeFileSync(artifact, JSON.stringify({ version: 1, sessionId: state.sessionId, outcomes: rows }));
  const sessionFile = join(root, "session.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "message", timestamp: FINISHED, message: { role: "assistant", content: "reviewed", stopReason: "stop" } }) + "\n");
  const inspected = await inspectNightlyResult({ state, sessionFile, interrupted: false });
  assert.deepEqual(inspected.outcomes, rows, "the old summary-only producer drops explicit metric outcomes");
  const inbox = join(root, "inbox"), outbox = join(root, "outbox"); mkdirSync(inbox);
  for (const source of ["home", "office"]) writeFileSync(join(inbox, `${source}.json`), "{}");
  writeNightlyResult(outbox, inbox, inspected);
  for (const source of ["home", "office"]) {
    const returned = parseNightlyResult(JSON.parse(readFileSync(join(outbox, source, "nightly-result.json"), "utf8")));
    assert.equal(returned.source, source);
    assert.deepEqual(returned.outcomes, rows.filter((row) => row.source === source));
    importTo(root, returned, { source });
    const marks = readCheckMarks(join(root, source, ".omp/agent"));
    assert.deepEqual(Object.keys(marks), [source === "home" ? "memory-export-failures" : "purpose:draft"]);
  }
  for (const bad of [
    { version: 1, sessionId: "old-session", outcomes: rows },
    { version: 1, sessionId: state.sessionId, outcomes: [outcome("home", "memory-export-failures", { checkedAt: "2026-11-09T01:00:00Z" })] },
  ]) {
    writeFileSync(artifact, JSON.stringify(bad));
    assert.deepEqual((await inspectNightlyResult({ state, sessionFile, interrupted: false })).outcomes, []);
  }
}));

test("explicit native IDs attach checks without altering verdict; wrong-source, legacy and dry runs do not mark", () => fixture(async (root) => {
  const scan = await scanSessions(join(root, "missing"), NOW.getTime());
  const section = memorySection(scan, []);
  const metric = section.metrics.find((row) => row.id === "memory-export-failures");
  metric.status = "problem";
  const bundle = bundleProblems({ sections: [section] });
  assert.equal(bundle[0].id, "memory/memory-export-failures");
  const nativeId = bundle[0].id.slice(bundle[0].id.indexOf("/") + 1);
  importTo(root, result("home", [outcome("home", nativeId)]));
  const agentDir = join(root, "home/.omp/agent");
  applyCheckMarks([section], activeCheckMarks(agentDir, NOW.getTime()));
  assert.equal(metric.status, "problem");
  assert.deepEqual(metric.check, { checkedAt: CHECKED, note: "reviewed home" });
  assert.equal(section.status, "unknown", "the checked problem no longer leads the remaining unmeasured rows");
  const before = readFileSync(join(agentDir, CHECK_MARKS_FILE), "utf8");
  importTo(root, result("office", [outcome("office", "purpose:draft")]));
  importTo(root, { ...result(), version: 1, source: undefined, outcomes: undefined });
  importTo(root, result("home", [outcome("home", "purpose:draft")]), { dryRun: true });
  importTo(root, { ...result(), outcomes: [outcome("office")] });
  importTo(root, { ...result(), outcomes: [outcome("home", "memory/memory-export-failures")] });
  assert.equal(readFileSync(join(agentDir, CHECK_MARKS_FILE), "utf8"), before);
}));

test("repeated and older pulls preserve timestamps and newer user marks, including after TTL pruning", () => fixture(async (root) => {
  importTo(root, result());
  const agentDir = join(root, "home/.omp/agent");
  const before = readFileSync(join(agentDir, CHECK_MARKS_FILE), "utf8");
  importTo(root, result(), { now: new Date(NOW.getTime() + 60_000) });
  assert.equal(readFileSync(join(agentDir, CHECK_MARKS_FILE), "utf8"), before);
  setCheckMark(agentDir, "memory-export-failures", NOW, "manual newer");
  importTo(root, result("home", [outcome("home", "memory-export-failures", { checkedAt: "2026-11-10T19:30:00Z" })]));
  assert.equal(readCheckMarks(agentDir)["memory-export-failures"].note, "manual newer");
  activeCheckMarks(agentDir, NOW.getTime() + 8 * 86_400_000);
  importTo(root, result(), { now: new Date(NOW.getTime() + 8 * 86_400_000) });
  assert.deepEqual(readCheckMarks(agentDir), {});
}));

test("fixed stays pending through report skips and promotes only at a matching local installation boundary", () => fixture(async (root) => {
  const payload = result("home", [outcome("home", "memory-export-failures", { disposition: "fixed", requiredVersion: "0.10.201" })]);
  const first = importTo(root, payload, { release: { current: "0.10.200", latest: "0.10.201", available: true } });
  const agentDir = join(root, "home/.omp/agent");
  assert.deepEqual(readFixMarks(agentDir), {});
  assert.equal(readCheckMarks(agentDir)["memory-export-failures"].at, CHECKED);
  assert.equal(first.state.nightlyImport.outcomes[0].evidence, payload.outcomes[0].evidence);
  const plan = morning.planMorningRun({ repoCwd: null, originHead: null, base: null, cloudCommits: [], skills: [],
    release: null, state: first.state, runningSessionIds: [], now: NOW });
  assert.equal(plan.action, "skip");
  const env = installedEnv(root);
  importTo(root, null, { env, release: { current: "0.10.201", latest: null, available: false } });
  assert.deepEqual(readFixMarks(agentDir), {}, "no published release evidence yet");
  importTo(root, null, { env: { ...env, CUELO_DEPLOY_STAGE_HASH: "c".repeat(64) }, release: { current: "0.10.201", latest: "0.10.201", available: false } });
  assert.deepEqual(readFixMarks(agentDir), {}, "receipt must match this runtime");
  importTo(root, null, { env, release: { current: "0.10.201", latest: "0.10.201", available: false } });
  assert.deepEqual(readFixMarks(agentDir), { "memory-export-failures": INSTALLED });
  assert.deepEqual(readCheckMarks(agentDir), {}, "promotion removes only its own pending check so the row is observed");
  const scan = await scanSessions(join(root, "missing"), NOW.getTime(), [Date.parse(INSTALLED)]);
  const sections = [memorySection(scan, [])];
  await applyFixMarks(sections, scan, activeFixMarks(agentDir, NOW.getTime() - 7 * 86_400_000), { agentDir, now: NOW.getTime(), handoffs: [] });
  const row = sections[0].metrics.find((metric) => metric.id === "memory-export-failures");
  assert.equal(row.status, "unknown"); assert.equal(row.fix.observing, true); assert.equal(row.fix.markedAt, INSTALLED);
  setFixMark(agentDir, "memory-export-failures", NOW);
  importTo(root, payload, { env, release: { current: "0.10.201", latest: "0.10.201", available: false } });
  assert.equal(readFixMarks(agentDir)["memory-export-failures"], NOW.toISOString());
}));

test("malformed stores stay byte-for-byte intact and malformed fixed records cannot import", () => fixture(async (root) => {
  for (const file of [CHECK_MARKS_FILE, FIX_MARKS_FILE, morning.MORNING_STATE_FILE]) {
    const separate = join(root, file), agentDir = join(separate, "home/.omp/agent"); mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, file), "{ broken");
    assert.throws(() => importTo(separate, result()));
    assert.equal(readFileSync(join(agentDir, file), "utf8"), "{ broken");
  }
  for (const extra of [{ disposition: "fixed" }, { disposition: "fixed", requiredVersion: "tomorrow" },
    { checkedAt: "2026-11-12T00:00:00Z" }, { note: "x".repeat(301) }, { evidence: "" }]) {
    assert.equal(parseNightlyResult(result("home", [outcome("home", "memory-export-failures", extra)])), null);
  }
}));

test("multi-run history is pruned without replay and more than 100 pending metrics remain readable", () => fixture(async (root) => {
  for (let page = 0; page < 2; page++) {
    const rows = Array.from({ length: 60 }, (_, i) => outcome("home", `purpose:history-${page}-${i}`));
    importTo(root, result("home", rows, { finishedAt: new Date(Date.parse(FINISHED) + page * 1000).toISOString() }));
  }
  const agentDir = join(root, "home/.omp/agent");
  assert.equal(morning.readMorningState(agentDir).nightlyImport.outcomes.length, 120);
  const later = new Date(NOW.getTime() + 8 * 86_400_000);
  activeCheckMarks(agentDir, later.getTime());
  importTo(root, null, { now: later });
  assert.equal(morning.readMorningState(agentDir).nightlyImport.outcomes.length, 0);
  importTo(root, result("home", [outcome("home", "purpose:history-0-0")]), { now: later });
  assert.deepEqual(readCheckMarks(agentDir), {});
  const pendingRoot = join(root, "pending");
  for (let page = 0; page < 2; page++) {
    const rows = Array.from({ length: 60 }, (_, i) => outcome("home", `purpose:pending-${page}-${i}`, { disposition: "fixed", requiredVersion: "0.10.201" }));
    importTo(pendingRoot, result("home", rows, { finishedAt: new Date(Date.parse(FINISHED) + page * 1000).toISOString() }));
  }
  importTo(pendingRoot, null, { now: later });
  assert.equal(morning.readMorningState(join(pendingRoot, "home/.omp/agent")).nightlyImport.outcomes.length, 120);
}));

test("a published fix inspected after installation uses the older real receipt and the running release.current", () => fixture(async (root) => {
  const installedAt = "2026-11-10T19:30:00.000Z";
  const env = installedEnv(root);
  delete env.NEXT_PUBLIC_APP_VERSION;
  const receiptPath = join(env.CUELO_EXTERNAL_UPDATE_ROOT, "results", `${env.CUELO_DEPLOY_REQUEST_ID}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.deployment.completedAtUtc = installedAt;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const payload = result("home", [outcome("home", "compactions", { disposition: "fixed", requiredVersion: "0.10.201" })]);
  importTo(root, payload, { env, release: { current: "0.10.200", latest: "0.10.201", available: true } });
  const agentDir = join(root, "home/.omp/agent");
  assert.deepEqual(readFixMarks(agentDir), {});
  importTo(root, null, { env, release: { current: "0.10.201", latest: "0.10.201", available: false } });
  assert.deepEqual(readFixMarks(agentDir), { compactions: installedAt });
}));

test("noncanonical checked times clear pending checks and promotion cannot move a user's later fix backward", () => fixture(async (root) => {
  const env = installedEnv(root);
  const receiptPath = join(env.CUELO_EXTERNAL_UPDATE_ROOT, "results", `${env.CUELO_DEPLOY_REQUEST_ID}.json`);
  const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
  receipt.deployment.completedAtUtc = "2026-11-10T19:30:00Z";
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const payload = result("home", [outcome("home", "compactions", { checkedAt: "2026-11-11T05:00:00+09:00", disposition: "fixed", requiredVersion: "0.10.201" })]);
  importTo(root, payload);
  const agentDir = join(root, "home/.omp/agent");
  setFixMark(agentDir, "compactions", new Date("2026-11-10T19:45:00Z"));
  importTo(root, null, { env, release: { current: "0.10.201", latest: "0.10.201", available: false } });
  assert.deepEqual(readCheckMarks(agentDir), {});
  assert.equal(readFixMarks(agentDir).compactions, "2026-11-10T19:45:00.000Z");
}));

test("held or interrupted work cannot turn a same-number unrelated installed release into a fix", () => fixture(async (root) => {
  for (const runOutcome of ["held", "interrupted", "failed"]) {
    const separate = join(root, runOutcome), env = installedEnv(separate);
    importTo(separate, result("home", [outcome("home", "compactions", { disposition: "fixed", requiredVersion: "0.10.201" })], { outcome: runOutcome, leftoverCount: 1, unpushed: ["unpublished work"] }));
    importTo(separate, null, { env, release: { current: "0.10.201", latest: "0.10.201", available: false } });
    const agentDir = join(separate, "home/.omp/agent");
    assert.deepEqual(readFixMarks(agentDir), {});
    assert.equal(readCheckMarks(agentDir).compactions.at, CHECKED);
  }
}));

test("a failed re-review cannot erase a published pending fix", () => fixture(async (root) => {
  const fixed = outcome("home", "compactions", { disposition: "fixed", requiredVersion: "0.10.201" });
  importTo(root, result("home", [fixed]));
  importTo(root, result("home", [{ ...fixed, checkedAt: "2026-11-10T20:00:01Z" }], { finishedAt: "2026-11-10T21:00:01Z", outcome: "held", leftoverCount: 1 }));
  const env = installedEnv(root);
  importTo(root, null, { env, release: { current: "0.10.201", latest: "0.10.201", available: false } });
  assert.equal(readFixMarks(join(root, "home/.omp/agent")).compactions, INSTALLED);
}));
