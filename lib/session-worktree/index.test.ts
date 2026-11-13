import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkoutIsBusy, parseIssue, removedAutoWorktreeRoot, rollbackUnstartedWorktree, selectSessionWorktree, sweepSessionWorktrees, withRepositoryLock, type LiveUse, type WorktreeHost } from "./index";
import { addWorktree, removeWorktree } from "../worktree";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cuelo-worktree-test-")); roots.push(root);
  const main = join(root, "repo"); mkdirSync(main);
  const remote = join(root, "origin.git");
  git(root, "init", "-q", "--bare", "--initial-branch=main", remote);
  git(main, "init", "-q", "--initial-branch=main");
  git(main, "config", "user.name", "Worktree Test"); git(main, "config", "user.email", "test@example.invalid");
  writeFileSync(join(main, "base.txt"), "base\n"); git(main, "add", "."); git(main, "commit", "-qm", "base");
  git(main, "remote", "add", "origin", remote); git(main, "push", "-qu", "origin", "main");
  const uses: LiveUse[] = [];
  const host: WorktreeHost = { live: () => uses, reserve: () => ({ busy: [], release() {} }) };
  return { root, main, remote, host, uses };
}
async function auto(f: ReturnType<typeof fixture>, issue = "#7") {
  return selectSessionWorktree(f.main, f.host, { issue });
}
function ownCommit(path: string) {
  writeFileSync(join(path, `${randomUUID()}.txt`), "own\n"); git(path, "add", "."); git(path, "commit", "-qm", "own");
}
function land(path: string) { git(path, "push", "-q", "origin", "HEAD:main"); }

describe("session worktree selection", () => {
  test("counts checkout sessions, nested Makers/jobs, not sibling worktrees", () => {
    expect(checkoutIsBusy("/tmp/project", [{ id: "session", cwd: "/tmp/project" }])).toBe(true);
    expect(checkoutIsBusy("/tmp/project", [{ id: "maker", cwd: "/tmp/project/src" }])).toBe(true);
    expect(checkoutIsBusy("/tmp/project", [{ id: "job", cwd: "/tmp/project/build" }])).toBe(true);
    expect(checkoutIsBusy("/tmp/project", [{ id: "other", cwd: "/tmp/project-worktrees/wt-other" }])).toBe(false);
    expect(checkoutIsBusy("/tmp/project", [{ id: "prefix", cwd: "/tmp/project2" }])).toBe(false);
  });
  test("parses issue numbers, rejects malformed or foreign repository URLs", () => {
    expect(parseIssue("#123", "git@github.com:owner/repo.git")).toBe(123);
    expect(parseIssue("https://github.com/OWNER/repo/issues/7", "https://github.com/owner/repo.git")).toBe(7);
    for (const bad of ["#0", "#-1", "#1.5", "issues/7", "https://github.com/owner/repo/pull/7", "9007199254740992"]) expect(() => parseIssue(bad, "")).toThrow();
    expect(() => parseIssue("https://github.com/foreign/repo/issues/7", "git@github.com:owner/repo.git")).toThrow("different repository");
  });
  test("leaves a first session, opt out, non git and explicit linked cwd unchanged", async () => {
    const f = fixture();
    expect((await selectSessionWorktree(f.main, f.host)).cwd).toBe(f.main);
    f.uses.push({ id: "A", cwd: f.main });
    expect((await selectSessionWorktree(f.main, f.host, { autoWorktree: false })).cwd).toBe(f.main);
    expect((await selectSessionWorktree(f.root, f.host)).cwd).toBe(f.root);
    const work = await auto(f);
    expect((await selectSessionWorktree(work.cwd, f.host)).cwd).toBe(work.cwd);
    expect(git(f.main, "branch", "--show-current")).toBe("main");
  });
  test("isolates second checkout starts, including a nested requested cwd", async () => {
    const f = fixture(); f.uses.push({ id: "A", cwd: f.main });
    mkdirSync(join(f.main, "src"));
    const selected = await selectSessionWorktree(join(f.main, "src"), f.host);
    expect(selected.worktree?.branch).toMatch(/^wt\/s-\d{8}-[a-f0-9]{8}$/);
    expect(selected.cwd).toBe(`${f.main}-worktrees/${selected.worktree!.branch.replaceAll("/", "-")}`);
    expect(git(selected.cwd, "rev-parse", "HEAD")).toBe(git(f.main, "rev-parse", "HEAD"));
    expect(selected.worktree?.missingSubdirectory).toBe("src");
  });
  test("preserves a tracked requested subdirectory in the isolated checkout", async () => {
    const f = fixture(); f.uses.push({ id: "A", cwd: f.main });
    mkdirSync(join(f.main, "src")); writeFileSync(join(f.main, "src", "tracked"), "tracked");
    git(f.main, "add", "."); git(f.main, "commit", "-qm", "subdir"); git(f.main, "push", "-q");
    const selected = await selectSessionWorktree(join(f.main, "src"), f.host);
    expect(selected.cwd).toBe(join(selected.created!.path, "src"));
    expect(selected.worktree?.missingSubdirectory).toBeUndefined();
  });
  test("reuses unused issue checkout and suffixes live collisions", async () => {
    const f = fixture(); const first = await auto(f);
    expect(first.worktree?.branch).toBe("wt/issue-7");
    expect((await auto(f)).cwd).toBe(first.cwd);
    f.uses.push({ id: "issue", cwd: first.cwd });
    const second = await auto(f);
    expect(second.worktree?.branch).toMatch(/^wt\/issue-7-[a-f0-9]{8}$/);
    expect(second.cwd).not.toBe(first.cwd);
  });
  test("serializes simultaneous main and issue decisions until registration", async () => {
    const f = fixture();
    const start = (issue?: string) => withRepositoryLock(f.main, async () => {
      const selected = await selectSessionWorktree(f.main, f.host, { issue });
      f.uses.push({ id: String(f.uses.length), cwd: selected.cwd });
      return selected;
    });
    const pair = await Promise.all([start(), start()]);
    expect(pair.filter((item) => item.cwd === f.main)).toHaveLength(1);
    expect(new Set(pair.map((item) => item.cwd)).size).toBe(2);
    const issues = await Promise.all([start("#9"), start("#9")]);
    expect(new Set(issues.map((item) => item.cwd)).size).toBe(2);
  });
  test("falls back to the local default branch when fetching fails", async () => {
    const f = fixture(); git(f.main, "remote", "set-url", "origin", join(f.root, "absent.git"));
    const selected = await auto(f);
    expect(selected.worktree).toMatchObject({ branch: "wt/issue-7", fallback: true, base: "main" });
    expect(git(selected.cwd, "rev-parse", "HEAD")).toBe(git(f.main, "rev-parse", "main"));
  });
});
describe("automatic cleanup", () => {
  test("removes only a clean merged auto tree with its own commits, then its branch", async () => {
    const f = fixture(); const selected = await auto(f); ownCommit(selected.cwd); land(selected.cwd);
    const results = await sweepSessionWorktrees(f.main, f.host);
    expect(results).toEqual([{ path: selected.cwd, branch: "wt/issue-7", removed: true }]);
    expect(existsSync(selected.cwd)).toBe(false);
    expect(git(f.main, "branch", "--list", "wt/issue-7")).toBe("");
  });
  test("MAIN-1: removes a clean unused no-commit checkout and branch without a fetch", async () => {
    const f = fixture();
    const landed = await auto(f, "#1"); ownCommit(landed.cwd); land(landed.cwd);
    const empty = await auto(f, "#2");
    expect(git(empty.cwd, "rev-parse", "HEAD")).not.toBe(git(f.main, "rev-parse", "HEAD"));
    git(f.main, "remote", "set-url", "origin", join(f.root, "absent.git"));
    const result = (await sweepSessionWorktrees(f.main, f.host)).find((item) => item.path === empty.cwd);
    expect(result).toEqual({ path: empty.cwd, branch: "wt/issue-2", removed: true });
    expect(existsSync(empty.cwd)).toBe(false);
    expect(git(f.main, "branch", "--list", "wt/issue-2")).toBe("");
  });
  test("MAIN-1: no-commit checkouts with untracked or ignored files or live use stay", async () => {
    const f = fixture();
    writeFileSync(join(f.main, ".gitignore"), ".env\n"); git(f.main, "add", "."); git(f.main, "commit", "-qm", "ignore"); git(f.main, "push", "-q");
    const untracked = await auto(f, "#1"); writeFileSync(join(untracked.cwd, "notes"), "keep");
    const ignored = await auto(f, "#2"); writeFileSync(join(ignored.cwd, ".env"), "keep");
    const live = await auto(f, "#3"); f.uses.push({ id: "live-empty", cwd: live.cwd });
    const results = await sweepSessionWorktrees(f.main, f.host);
    expect(results.find((item) => item.path === untracked.cwd)?.reason).toBe("dirty");
    expect(results.find((item) => item.path === ignored.cwd)?.reason).toBe("dirty");
    expect(results.find((item) => item.path === live.cwd)?.reason).toBe("live");
    for (const item of [untracked, ignored, live]) expect(existsSync(item.cwd)).toBe(true);
  });
  test("MAIN-1: no-commit cleanup keeps reservation and late HEAD/status protections", async () => {
    for (const change of ["reservation", "head", "untracked"]) {
      const f = fixture(); const empty = await auto(f);
      f.host.reserve = () => {
        if (change === "head") ownCommit(empty.cwd);
        if (change === "untracked") writeFileSync(join(empty.cwd, "late"), "keep");
        return { busy: change === "reservation" ? ["starting"] : [], release() {} };
      };
      const [result] = await sweepSessionWorktrees(f.main, f.host);
      expect(result.removed).toBe(false);
      expect(result.reason).toBe(change === "reservation" ? "live" : change === "head" ? "head-changed" : "dirty");
      expect(existsSync(empty.cwd)).toBe(true);
    }
  });
  test("keeps unmerged, dirty, live and user-created trees", async () => {
    const f = fixture();
    const unmerged = await auto(f, "#2"); ownCommit(unmerged.cwd);
    const dirty = await auto(f, "#3"); ownCommit(dirty.cwd); land(dirty.cwd); writeFileSync(join(dirty.cwd, "untracked"), "keep");
    const live = await auto(f, "#4"); ownCommit(live.cwd); land(live.cwd); f.uses.push({ id: "live", cwd: live.cwd });
    const user = await addWorktree(f.main, "wt/issue-5");
    const results = await sweepSessionWorktrees(f.main, f.host);
    expect(results.find((item) => item.path === unmerged.cwd)?.reason).toBe("unmerged");
    expect(results.find((item) => item.path === dirty.cwd)?.reason).toBe("dirty");
    expect(results.find((item) => item.path === live.cwd)?.reason).toBe("live");
    expect(results.some((item) => item.path === user.path)).toBe(false);
    for (const path of [unmerged.cwd, dirty.cwd, live.cwd, user.path]) expect(existsSync(path)).toBe(true);
  });
  test("removes folder but reports branch retained when branch -d refuses", async () => {
    const f = fixture(); const selected = await auto(f); ownCommit(selected.cwd); land(selected.cwd);
    const alias = join(f.root, "alias");
    git(f.main, "worktree", "add", "--force", alias, "wt/issue-7");
    const [result] = await sweepSessionWorktrees(f.main, f.host);
    expect(result).toMatchObject({ removed: true, branchKept: true });
    expect(existsSync(selected.cwd)).toBe(false);
    expect(git(f.main, "branch", "--list", "wt/issue-7")).toContain("wt/issue-7");
    git(f.main, "worktree", "remove", alias);
    const manual = await addWorktree(f.main, "wt/issue-7");
    expect(await sweepSessionWorktrees(f.main, f.host)).toEqual([]);
    expect(existsSync(manual.path)).toBe(true);
  });
  test("a removal reservation can veto cleanup after the live snapshot", async () => {
    const f = fixture(); const selected = await auto(f); ownCommit(selected.cwd); land(selected.cwd);
    f.host.reserve = () => ({ busy: ["starting"], release() {} });
    expect((await sweepSessionWorktrees(f.main, f.host))[0].reason).toBe("live");
    expect(existsSync(selected.cwd)).toBe(true);
  });
  test("infers missing auto worktrees only", async () => {
    const f = fixture();
    expect(removedAutoWorktreeRoot(`${f.main}-worktrees/wt-s-20261113-1234abcd`)).toBe(f.main);
    expect(removedAutoWorktreeRoot(`${f.main}-worktrees/wt-issue-7`)).toBe(f.main);
    expect(removedAutoWorktreeRoot(`${f.main}-worktrees/wt-user`)).toBeUndefined();
    const selected = await auto(f); expect(removedAutoWorktreeRoot(selected.cwd)).toBeUndefined();
  });
});

test("probe R1-ANT-6: submodule isolation stays in the submodule repository", async () => {
  const superproject = fixture(); const source = fixture();
  git(superproject.main, "-c", "protocol.file.allow=always", "submodule", "add", source.remote, "sub");
  const sub = join(superproject.main, "sub");
  superproject.uses.push({ id: "sub-session", cwd: sub });
  const selected = await selectSessionWorktree(sub, superproject.host);
  expect(selected.cwd.startsWith(`${sub}-worktrees/`), JSON.stringify({ selected, probe: git(sub, "rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"), trees: git(sub, "worktree", "list", "--porcelain") })).toBe(true);
  expect(git(superproject.main, "branch", "--list", "wt/*")).toBe("");
  expect(git(selected.cwd, "rev-parse", "--git-common-dir")).toBe(git(sub, "rev-parse", "--git-common-dir"));
});
test("probe R1-ANT-7: git_finalize publishes the auto branch, never origin/main", async () => {
  const f = fixture(); const selected = await auto(f);
  const before = git(f.main, "rev-parse", "origin/main");
  writeFileSync(join(selected.cwd, "publication.txt"), "session change");
  const request = join(f.root, "finalize.json");
  writeFileSync(request, JSON.stringify({ cwd: selected.cwd, message: "test: worktree publication", files: ["publication.txt"] }));
  const script = join(process.cwd(), "Tools/OMP_Global_Config/agent/tools/git-finalizer/finalizer.ps1");
  const result = Bun.spawnSync(["pwsh", "-NoProfile", "-File", script, "-Request", request], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
  expect(git(f.main, "ls-remote", "origin", "refs/heads/main").split(/\s/)[0]).toBe(before);
  expect(git(selected.cwd, "config", "--get", "branch.wt/issue-7.merge")).toBe("refs/heads/wt/issue-7");
  expect(git(f.main, "ls-remote", "origin", "refs/heads/wt/issue-7").split(/\s/)[0]).toBe(git(selected.cwd, "rev-parse", "HEAD"));
}, 30_000);
test("probe R1-ANT-8: late untracked/ignored writes and changed HEAD prevent cleanup", async () => {
  for (const change of ["untracked", "ignored", "head"]) {
    const f = fixture(); const selected = await auto(f); ownCommit(selected.cwd); land(selected.cwd);
    if (change === "ignored") {
      writeFileSync(join(selected.cwd, ".gitignore"), ".env\n"); git(selected.cwd, "add", "."); git(selected.cwd, "commit", "-qm", "ignore"); land(selected.cwd);
    }
    f.host.reserve = () => {
      if (change === "head") ownCommit(selected.cwd);
      else writeFileSync(join(selected.cwd, change === "ignored" ? ".env" : "late-file"), "preserve");
      return { busy: [], release() {} };
    };
    const [result] = await sweepSessionWorktrees(f.main, f.host);
    expect(result.removed).toBe(false); expect(existsSync(selected.cwd)).toBe(true);
    expect(result.reason).toBe(change === "head" ? "head-changed" : "dirty");
  }
});
test("probe R1-ANT-1: a huge dirty status cannot abort cleanup for other worktrees", async () => {
  const f = fixture(); const dirty = await auto(f, "#8");
  for (let i = 0; i < 12000; i++) writeFileSync(join(dirty.cwd, `${i}-${"x".repeat(100)}`), "keep");
  const clean = await auto(f); ownCommit(clean.cwd); land(clean.cwd);
  const results = await sweepSessionWorktrees(f.main, f.host);
  expect(results.find((item) => item.path === dirty.cwd)?.removed).toBe(false);
  expect(results.find((item) => item.path === clean.cwd)?.removed).toBe(true);
  expect(existsSync(dirty.cwd)).toBe(true);
});
test("an origin-less trunk uses the local branch; no-default cases fail closed", async () => {
  const f = fixture(); git(f.main, "remote", "remove", "origin"); git(f.main, "branch", "-m", "trunk");
  f.uses.push({ id: "A", cwd: f.main });
  const selected = await selectSessionWorktree(f.main, f.host);
  expect(selected.worktree).toMatchObject({ fallback: true, base: "trunk" });
});
test("failed-start rollback removes only its fresh unchanged allocation", async () => {
  const f = fixture(); const selected = await auto(f);
  await rollbackUnstartedWorktree(selected);
  expect(existsSync(selected.cwd)).toBe(false);
  expect(git(f.main, "branch", "--list", "wt/issue-7")).toBe("");
  const existing = await auto(f);
  const reused = await auto(f);
  await rollbackUnstartedWorktree(reused);
  expect(existsSync(existing.cwd)).toBe(true);
  const modified = await auto(f, "#9");
  writeFileSync(join(modified.cwd, "preserve"), "keep");
  await rollbackUnstartedWorktree(modified);
  expect(existsSync(modified.cwd)).toBe(true);
});
test("R2-ANT-1: missing nested cwd does not imply its existing auto checkout was removed", async () => {
  const f = fixture(); const selected = await auto(f);
  expect(removedAutoWorktreeRoot(join(selected.cwd, "gone"))).toBeUndefined();
  expect(removedAutoWorktreeRoot(`${f.main}-worktrees/wt-issue-9/packages/app`)).toBe(f.main);
});
test("R2-ANT-2: failed creation cannot roll back a manual sanitized-path collision", async () => {
  const f = fixture(); const manual = await addWorktree(f.main, "wt-issue-7");
  await expect(auto(f)).rejects.toThrow("Directory already exists");
  expect(existsSync(manual.path)).toBe(true);
  expect(git(manual.path, "branch", "--show-current")).toBe("wt-issue-7");
  expect(git(f.main, "branch", "--list", "wt/issue-7")).toBe("");
});
test("R2-ANT-3: failed-start branch rollback works when origin has advanced past main", async () => {
  const f = fixture(); const first = await auto(f, "#1"); ownCommit(first.cwd); land(first.cwd);
  const second = await auto(f, "#2");
  expect(git(second.cwd, "rev-parse", "HEAD")).not.toBe(git(f.main, "rev-parse", "HEAD"));
  await rollbackUnstartedWorktree(second);
  expect(existsSync(second.cwd)).toBe(false);
  expect(git(f.main, "branch", "--list", "wt/issue-2")).toBe("");
});
test("R3-ANT-1: a failed post-checkout hook rolls back its fresh clean checkout", async () => {
  const f = fixture();
  const hook = join(f.main, ".git", "hooks", "post-checkout");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n"); chmodSync(hook, 0o755);
  await expect(auto(f)).rejects.toThrow();
  expect(existsSync(`${f.main}-worktrees/wt-issue-7`)).toBe(false);
  expect(git(f.main, "branch", "--list", "wt/issue-7")).toBe("");
});
test("MAIN-1 review R1-ANT-1: removal from its own cwd clears all ownership keys", async () => {
  const f = fixture(); const selected = await auto(f);
  await removeWorktree(selected.cwd, selected.cwd);
  for (const key of ["base", "base-ref", "path", "target"]) {
    const value = Bun.spawnSync(["git", "config", "--get", `branch.wt/issue-7.cuelo-${key}`], { cwd: f.main, stdout: "pipe" });
    expect(value.exitCode).toBe(1);
  }
  git(f.main, "worktree", "add", selected.cwd, "wt/issue-7");
  expect(await sweepSessionWorktrees(f.main, f.host)).toEqual([]);
  expect(existsSync(selected.cwd)).toBe(true);
});
test("MAIN-1 review R1-ANT-2: production checkout exclusion protects untouched trees", async () => {
  const f = fixture(); const production = join(f.root, "cuelo-run");
  renameSync(f.main, production);
  const selected = await selectSessionWorktree(production, f.host, { issue: "#7" });
  // Bun caches the OS home at startup; set the fixture HOME on a fresh process.
  const script = `const { sweepSessionWorktrees } = await import(${JSON.stringify(join(process.cwd(), "lib/session-worktree/index.ts"))});
    const result = await sweepSessionWorktrees(${JSON.stringify(production)}, { live: () => [], reserve: () => ({ busy: [], release() {} }) });
    console.log(JSON.stringify(result));`;
  const child = Bun.spawnSync([process.execPath, "--no-install", "-e", script], { env: { ...process.env, HOME: f.root }, stdout: "pipe", stderr: "pipe" });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(JSON.parse(child.stdout.toString())).toEqual([]);
  expect(existsSync(selected.cwd)).toBe(true);
});
