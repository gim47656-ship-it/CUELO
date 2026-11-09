import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNightlyCoreUpdate } from "./nightly-core.ts";
import { nightlyStateAfterRun, planNightlyRun, readNightlyState, writeNightlyState } from "./nightly.ts";
import { planInboxRun } from "./nightly-inbox.ts";

const NOW = new Date("2026-11-08T19:30:00.000Z");
const PREVIOUS = { date: "2026-11-08", sessionId: "previous", worktree: "/work", startedAt: "2026-11-07T19:00:00.000Z", performanceReviewDate: "2026-11-08" };
const NO_ISSUES = { status: "ok", repo: "gim47656-ship-it/CUELO", issues: [], partial: false };
const report = () => {
  const value = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
  for (const section of value.sections) for (const metric of section.metrics) if (metric.status === "problem") metric.status = "watch";
  return value;
};

function sourceFixture(t, version = "18.18.3") {
  const root = mkdtempSync(join(tmpdir(), "nightly-core-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
  git(["init", "-q", "-b", "main"]);
  const commit = (value) => {
    writeFileSync(join(root, "package.json"), JSON.stringify({ cueloBuild: { coreVersion: value } }));
    git(["add", "package.json"]);
    git(["commit", "-qm", "fixture pin"]);
    return git(["rev-parse", "HEAD"]);
  };
  return { root, git, commit, sha: commit(version) };
}
const npm = (version) => async () => Response.json({ version });

test("stable npm discovery distinguishes newer, equal, older, prerelease and malformed", async (t) => {
  const { root } = sourceFixture(t);
  for (const [latest, status] of [["18.18.4", "newer"], ["18.19.0", "newer"], ["19.0.0", "newer"], ["18.18.3", "current"], ["18.18.2", "ahead"], ["18.18.4-beta.1", "unavailable"], ["18.18.4junk", "unavailable"], ["v18.18.4", "unavailable"], ["018.18.4", "unavailable"], [null, "unavailable"]]) {
    const found = await collectNightlyCoreUpdate(root, ["HEAD"], npm(latest));
    assert.equal(found.status, status, String(latest));
    const planned = planNightlyRun({ ...report(), repoCwd: root }, PREVIOUS, NOW, [], [], found);
    assert.equal(planned.action, status === "newer" ? "run" : "skip", String(latest));
    if (status === "newer") assert.deepEqual(planned.jobs.coreUpgrade, { from: "18.18.3", to: latest });
  }
});

test("source ref, not host metadata or dirty checkout, owns the version", async (t) => {
  const { root, sha, commit, git } = sourceFixture(t, "18.17.9");
  const head = commit("18.18.3");
  git(["branch", "wt/nightly-20261109", sha]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ cueloBuild: { coreVersion: "999.0.0" } }));
  const cloud = await collectNightlyCoreUpdate(root, [sha], npm("18.18.3"));
  assert.deepEqual(cloud, { status: "newer", current: "18.17.9", latest: "18.18.3", sourceRef: sha, sourceSha: sha });
  const retry = await collectNightlyCoreUpdate(root, ["refs/heads/wt/nightly-20261109", "HEAD"], npm("18.18.3"));
  assert.equal(retry.current, "18.17.9");
  const local = await collectNightlyCoreUpdate(root, ["refs/heads/wt/nightly-20261110", "HEAD"], npm("18.18.3"));
  assert.equal(local.status, "current");
  assert.equal(local.sourceSha, head);
});

test("unavailable lookup never means current or suppresses existing nightly work", async (t) => {
  const { root } = sourceFixture(t);
  for (const fetcher of [async () => { throw new DOMException("timeout", "TimeoutError"); }, async () => new Response("", { status: 503 }), async () => new Response("not json"), async () => Response.json([])]) {
    const found = await collectNightlyCoreUpdate(root, ["HEAD"], fetcher);
    assert.equal(found.status, "unavailable");
    const inbox = planInboxRun([], PREVIOUS, NOW, [], root, null, NO_ISSUES, null, new Set(), found);
    assert.equal(inbox.action, "run");
    assert.equal(inbox.jobs.improvementReview, true);
    assert.equal(inbox.jobs.issueLookup, "ok");
    assert.equal(inbox.jobs.coreUpgrade, undefined);
    assert.equal(inbox.coreUpdate.status, "unavailable");
    const local = planNightlyRun({ ...report(), repoCwd: root }, null, NOW, [], [], found);
    assert.equal(local.action, "run");
    assert.equal(local.jobs.weeklyReview, true);
    assert.equal(local.jobs.coreUpgrade, undefined);
  }
});

test("missing or invalid source pin cannot dispatch a core upgrade", async (t) => {
  assert.equal((await collectNightlyCoreUpdate(null, ["HEAD"], npm("99.0.0"))).status, "unavailable");
  for (const value of [null, "18.18.3-beta.1", "broken"]) {
    const { root } = sourceFixture(t, value);
    const found = await collectNightlyCoreUpdate(root, ["missing-ref"], npm("99.0.0"));
    assert.equal(found.status, "unavailable");
    assert.equal((await collectNightlyCoreUpdate(root, ["HEAD"], npm("99.0.0"))).status, "unavailable");
  }
});

test("one core job shares existing accepted-run state and per-day/running guards in both modes", async (t) => {
  const { root } = sourceFixture(t);
  const found = await collectNightlyCoreUpdate(root, ["HEAD"], npm("18.19.0"));
  const local = (state, now = NOW, running = []) => planNightlyRun({ ...report(), repoCwd: root }, state, now, running, [], found);
  const inbox = (state, now = NOW, running = []) => planInboxRun([], state, now, running, root, null, NO_ISSUES, null, new Set(), found);
  for (const plan of [local, inbox]) {
    const first = plan(PREVIOUS);
    assert.equal(first.action, "run");
    assert.deepEqual(first.jobs.coreUpgrade, { from: "18.18.3", to: "18.19.0" });
    writeNightlyState(root, nightlyStateAfterRun(first, PREVIOUS, "accepted", "/work/nightly", NOW.toISOString()));
    const state = readNightlyState(root);
    assert.deepEqual(plan(state), { action: "skip", reason: "already-ran-today" });
    assert.deepEqual(plan(state, new Date("2026-11-09T19:30:00.000Z"), ["accepted"]), { action: "skip", reason: "previous-still-running" });
  }
});

test("linked worktree discovery uses the main root HEAD that addWorktree starts from", async (t) => {
  const { root, commit, git } = sourceFixture(t, "18.17.9");
  git(["branch", "linked-pin"]);
  const mainSha = commit("18.18.3");
  const linked = join(root, "linked");
  git(["worktree", "add", "-q", linked, "linked-pin"]);
  const found = await collectNightlyCoreUpdate(linked, ["HEAD"], npm("18.18.3"));
  assert.equal(found.status, "current");
  assert.equal(found.current, "18.18.3");
  assert.equal(found.sourceSha, mainSha);
});
