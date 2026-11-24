import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function commit(cwd, name) {
  writeFileSync(path.join(cwd, `${name}.txt`), `${name}\n`);
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", `add ${name}`);
}

async function withTempDir(run) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "cuelo-git-summary-")));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function loadSubject() {
  return import("./git-summary.ts");
}

test("reports a plain directory as not a repository", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    assert.deepEqual(await getGitSummary(dir), {
      isGitRepository: false,
      repositoryRoot: null,
      branch: null,
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
      commits: [],
    });
  });
});

test("reads an empty repository with no commits", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    git(dir, "init", "-q", "-b", "main");
    assert.deepEqual(await getGitSummary(dir), {
      isGitRepository: true,
      repositoryRoot: dir,
      branch: "main",
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
      commits: [],
    });
  });
});

test("lists at most five recent commits newest first without an upstream", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    git(dir, "init", "-q", "-b", "main");
    for (const name of ["one", "two", "three", "four", "five", "six"]) commit(dir, name);
    const summary = await getGitSummary(dir);
    assert.equal(summary.branch, "main");
    assert.equal(summary.upstream, null);
    assert.equal(summary.ahead, null);
    assert.equal(summary.behind, null);
    assert.deepEqual(summary.commits.map((entry) => entry.subject), [
      "add six", "add five", "add four", "add three", "add two",
    ]);
    const head = git(dir, "rev-parse", "HEAD");
    assert.equal(summary.commits[0].hash, head);
    assert.ok(head.startsWith(summary.commits[0].shortHash));
    assert.ok(!Number.isNaN(Date.parse(summary.commits[0].committedAt)));
  });
});

test("resolves the repository root from a subdirectory cwd", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "root");
    const nested = path.join(dir, "packages", "app");
    mkdirSync(nested, { recursive: true });
    const summary = await getGitSummary(nested);
    assert.equal(summary.repositoryRoot, dir);
    assert.equal(summary.branch, "main");
    assert.equal(summary.commits.length, 1);
  });
});

test("marks a detached HEAD", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "first");
    commit(dir, "second");
    git(dir, "checkout", "-q", "--detach", "HEAD~1");
    const summary = await getGitSummary(dir);
    assert.equal(summary.detached, true);
    assert.equal(summary.branch, null);
    assert.equal(summary.upstream, null);
    assert.equal(summary.commits[0].subject, "add first");
  });
});

test("counts ahead and behind against local tracking refs of a bare remote", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    const remote = path.join(dir, "remote.git");
    const work = path.join(dir, "work");
    const other = path.join(dir, "other");
    git(dir, "init", "-q", "--bare", "-b", "main", remote);
    git(dir, "clone", "-q", remote, work);
    git(work, "checkout", "-q", "-b", "main");
    commit(work, "base");
    git(work, "push", "-q", "-u", "origin", "main");

    const inSync = await getGitSummary(work);
    assert.equal(inSync.upstream, "origin/main");
    assert.equal(inSync.ahead, 0);
    assert.equal(inSync.behind, 0);

    git(dir, "clone", "-q", remote, other);
    commit(other, "theirs");
    git(other, "push", "-q", "origin", "main");
    commit(work, "mine-1");
    commit(work, "mine-2");

    // Not fetched yet: only local tracking refs count, so the remote commit is invisible.
    const beforeFetch = await getGitSummary(work);
    assert.equal(beforeFetch.ahead, 2);
    assert.equal(beforeFetch.behind, 0);

    git(work, "fetch", "-q", "origin");
    const afterFetch = await getGitSummary(work);
    assert.equal(afterFetch.ahead, 2);
    assert.equal(afterFetch.behind, 1);
  });
});

test("keeps a subject containing separator-like control characters as one commit", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "base");
    const subject = "five\x1ex\x1fy\x1fz\x1fextra";
    git(dir, "commit", "-q", "--allow-empty", "-m", subject);
    const summary = await getGitSummary(dir);
    assert.equal(summary.commits.length, 2);
    assert.equal(summary.commits[0].subject, subject);
    assert.equal(summary.commits[1].subject, "add base");
  });
});

test("hides an enclosing repository whose root the caller does not allow", async () => {
  const { getGitSummary } = await loadSubject();
  await withTempDir(async (dir) => {
    git(dir, "init", "-q", "-b", "main");
    commit(dir, "secret");
    const shared = path.join(dir, "shared");
    mkdirSync(shared);
    const summary = await getGitSummary(shared, { isRootAllowed: (root) => root.startsWith(shared) });
    assert.equal(summary.isGitRepository, false);
    assert.deepEqual(summary.commits, []);
  });
});
