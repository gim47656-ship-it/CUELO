import { afterEach, expect, test } from "bun:test";
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectSessionWorktree, type LiveUse, type WorktreeHost } from "./index";
import { findStaleAutoWorktrees, pendingResumeIds, runWorktreeMaintenance, sessionWorktreeRoots, type RecordedWorktreeSession } from "./maintenance";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const out = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (out.exitCode) throw new Error(out.stderr.toString());
  return out.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cuelo-maintenance-")); roots.push(root);
  const main = join(root, "repo"); mkdirSync(main);
  git(root, "init", "-q", "--bare", "--initial-branch=main", join(root, "origin.git"));
  git(main, "init", "-q", "--initial-branch=main"); git(main, "config", "user.name", "Test"); git(main, "config", "user.email", "test@example.invalid");
  writeFileSync(join(main, ".gitignore"), "node_modules/\n"); git(main, "add", "."); git(main, "commit", "-qm", "base");
  git(main, "remote", "add", "origin", join(root, "origin.git")); git(main, "push", "-qu", "origin", "main");
  const uses: LiveUse[] = [];
  const host: WorktreeHost = { live: () => uses, reserve: () => ({ busy: [], release() {} }) };
  const sessions: RecordedWorktreeSession[] = [];
  const create = async () => {
    const selected = await selectSessionWorktree(main, host, { autoWorktree: true });
    const path = join(root, `session-${sessions.length}.jsonl`); writeFileSync(path, "fixture");
    sessions.push({ id: `session-${sessions.length}`, cwd: selected.cwd, path, modified: new Date().toISOString() });
    return selected.cwd;
  };
  return { root, main, host, uses, sessions, create };
}

test("morning removes merged ignored-only trees, retains dirty/unmerged/live/pending trees, and dryRun is inert", async () => {
  const f = fixture();
  const clean = await f.create();
  writeFileSync(join(clean, "landed"), "landed"); git(clean, "add", "."); git(clean, "commit", "-qm", "landed"); git(clean, "push", "-q", "origin", "HEAD:main");
  mkdirSync(join(clean, "node_modules")); writeFileSync(join(clean, "node_modules", "ignored"), "ignored");
  const dirty = await f.create(); writeFileSync(join(dirty, "uncommitted"), "keep");
  const unmerged = await f.create(); writeFileSync(join(unmerged, "own"), "own"); git(unmerged, "add", "."); git(unmerged, "commit", "-qm", "own");
  const live = await f.create(); f.uses.push({ id: "live", cwd: join(live, "nested") });
  const pending = await f.create();
  const options = { pendingIds: new Set([f.sessions.at(-1)!.id]) };
  await runWorktreeMaintenance("morning", f.host, f.sessions, { ...options, dryRun: true });
  expect(existsSync(clean)).toBe(true);
  await runWorktreeMaintenance("morning", f.host, f.sessions, options);
  expect(existsSync(clean)).toBe(false);
  for (const path of [dirty, unmerged, live, pending]) expect(existsSync(path)).toBe(true);
});

test("startup protects recent session files and old pending sessions; old abandoned merged trees are removed", async () => {
  const f = fixture();
  const old = await f.create(); const pending = await f.create(); const recent = await f.create();
  const ago = new Date(Date.now() - 2 * 3_600_000);
  for (const session of f.sessions.slice(0, 2)) utimesSync(session.path, ago, ago);
  await runWorktreeMaintenance("startup", f.host, f.sessions, { pendingIds: new Set([f.sessions[1].id]) });
  expect(existsSync(old)).toBe(false); expect(existsSync(pending)).toBe(true); expect(existsSync(recent)).toBe(true);
  // The same recent closed session is not protected by morning's 2-hour cleanup.
  await runWorktreeMaintenance("morning", f.host, f.sessions, { pendingIds: new Set([f.sessions[1].id]) });
  expect(existsSync(recent)).toBe(false);
});

test("one broken project logs its failure and does not stop later project sweeps", async () => {
  const f = fixture(); const clean = await f.create();
  const errors: unknown[][] = []; const original = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    const broken = { id: "bad", cwd: join(f.root, "missing-worktrees", "wt-s-20260101-12345678"), path: "missing", modified: "" };
    await runWorktreeMaintenance("morning", f.host, [broken, ...f.sessions], { pendingIds: new Set() });
  } finally { console.error = original; }
  expect(errors.length).toBe(1); expect(existsSync(clean)).toBe(false);
  expect(sessionWorktreeRoots([clean, join(clean, "subdir"), "/unrelated"])).toEqual([f.main]);
});

test("stale detection lists dirty and own-unmerged idle auto trees only, without modifying the index", async () => {
  const f = fixture();
  const dirty = await f.create(); writeFileSync(join(dirty, "old.txt"), "keep");
  const fresh = await f.create(); writeFileSync(join(fresh, "fresh.txt"), "fresh");
  const live = await f.create(); writeFileSync(join(live, "live.txt"), "live"); f.uses.push({ id: "live", cwd: live });
  const committed = await f.create(); writeFileSync(join(committed, "own.txt"), "own"); git(committed, "add", "."); git(committed, "commit", "-qm", "own");
  const now = Date.now() + 4 * 86_400_000;
  utimesSync(join(fresh, "fresh.txt"), new Date(now), new Date(now));
  const result = await findStaleAutoWorktrees([f.main], f.host, f.sessions, now);
  expect(result.warnings).toEqual([]);
  expect(result.worktrees.map((tree) => tree.path).sort()).toEqual([dirty, committed].sort());
  expect(result.worktrees.find((tree) => tree.path === dirty)).toMatchObject({ changedCount: 1, changedFiles: ["old.txt"], unmergedCommits: 0 });
  expect(result.worktrees.find((tree) => tree.path === committed)).toMatchObject({ changedCount: 0, unmergedCommits: 1 });
  expect(existsSync(dirty)).toBe(true); expect(existsSync(committed)).toBe(true);
});

test("R1-ANT-1/R1-ADV-1: unmarked auto-named worktrees are skipped, not unreadable", async () => {
  const f = fixture();
  git(f.main, "worktree", "add", "-b", "wt/issue-5", join(f.root, "manual"));
  const result = await findStaleAutoWorktrees([f.main], f.host, [], Date.now());
  expect(result).toEqual({ worktrees: [], warnings: [] });
});

test("R2-ANT-1: replacing a tracked directory with a file remains readable", async () => {
  const f = fixture(); const tree = await f.create();
  mkdirSync(join(tree, "dir")); writeFileSync(join(tree, "dir", "a"), "tracked");
  git(tree, "add", "."); git(tree, "commit", "-qm", "nested");
  rmSync(join(tree, "dir"), { recursive: true }); writeFileSync(join(tree, "dir"), "replacement");
  const result = await findStaleAutoWorktrees([f.main], f.host, f.sessions, Date.now() + 4 * 86_400_000);
  expect(result.warnings).toEqual([]);
  expect(result.worktrees.map((entry) => entry.path)).toEqual([tree]);
});

test("pending-resume reader uses existing queue and fails closed on an unreadable protection snapshot", async () => {
  const f = fixture(); const previous = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = f.root;
  try {
    expect(await pendingResumeIds()).toEqual(new Set());
    mkdirSync(join(f.root, "interrupts"));
    const path = join(f.root, "interrupts", "pending-resume.json");
    writeFileSync(path, JSON.stringify({ sessionIds: ["pending"] }));
    expect(await pendingResumeIds()).toEqual(new Set(["pending"]));
    writeFileSync(path, "invalid");
    await expect(pendingResumeIds()).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT; else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previous;
  }
});

test("R1-OAI-1: main-only session history still discovers orphaned automatic worktrees", async () => {
  const f = fixture(); const clean = await f.create();
  f.sessions[0].cwd = f.main;
  await runWorktreeMaintenance("morning", f.host, f.sessions, { pendingIds: new Set() });
  expect(existsSync(clean)).toBe(false);
  const dirty = await f.create(); writeFileSync(join(dirty, "keep"), "uncommitted");
  f.sessions[1].cwd = f.main;
  const roots = sessionWorktreeRoots([f.main]);
  expect(roots).toEqual([f.main]);
  const stale = await findStaleAutoWorktrees(roots, f.host, f.sessions, Date.now() + 4 * 86_400_000);
  expect(stale.worktrees.map((tree) => tree.path)).toEqual([dirty]);
});

test("R1-OAI-2: a resume queued during removal reservation protects the checkout", async () => {
  const f = fixture(); const clean = await f.create();
  const previous = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = f.root;
  mkdirSync(join(f.root, "interrupts"));
  const reserve = f.host.reserve;
  let reserved = false;
  f.host.reserve = (path) => {
    reserved = true;
    writeFileSync(join(f.root, "interrupts", "pending-resume.json"), JSON.stringify({ sessionIds: [f.sessions[0].id] }));
    return reserve(path);
  };
  try {
    await runWorktreeMaintenance("morning", f.host, f.sessions);
    expect(reserved).toBe(true);
    expect(existsSync(clean)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT; else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previous;
  }
});

for (const removed of ["file", "directory"]) test(`R1-OAI-3: fresh unstaged ${removed} deletion uses its nearest remaining parent`, async () => {
  const f = fixture(); const tree = await f.create();
  mkdirSync(join(tree, "nested")); writeFileSync(join(tree, "nested", "tracked"), "tracked");
  git(tree, "add", "."); git(tree, "commit", "-qm", "nested");
  const now = Date.now() + 4 * 86_400_000;
  const target = removed === "file" ? join(tree, "nested", "tracked") : join(tree, "nested");
  rmSync(target, { recursive: removed === "directory" });
  const parent = removed === "file" ? join(tree, "nested") : tree;
  utimesSync(parent, new Date(now), new Date(now));
  const stale = await findStaleAutoWorktrees([f.main], f.host, f.sessions, now);
  expect(stale.warnings).toEqual([]);
  expect(stale.worktrees).toEqual([]);
});

test("round3 R1-ANT-3: an unmapped pending override protects every candidate and logs once", async () => {
  const f = fixture(); const first = await f.create(); const second = await f.create();
  const errors: unknown[][] = []; const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    await runWorktreeMaintenance("morning", f.host, f.sessions, { pendingIds: new Set(["missing-session"]) });
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(true);
    expect(errors.length).toBe(1);
  } finally { console.error = originalError; }
});

test("round3 R1-OAI-1: a late-created pending session missing from the snapshot retains its worktree", async () => {
  const f = fixture(); const first = await f.create();
  const snapshot = f.sessions.slice();
  const late = await f.create(); const lateId = f.sessions[1].id;
  const previousRoot = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  const originalError = console.error; const errors: unknown[][] = [];
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = f.root;
  console.error = (...args) => { errors.push(args); };
  mkdirSync(join(f.root, "interrupts"));
  const reserve = f.host.reserve;
  f.host.reserve = (path) => {
    writeFileSync(join(f.root, "interrupts", "pending-resume.json"), JSON.stringify({ sessionIds: [lateId] }));
    return reserve(path);
  };
  try {
    await runWorktreeMaintenance("morning", f.host, snapshot);
    expect(existsSync(first)).toBe(true);
    expect(existsSync(late)).toBe(true);
    expect(errors.length).toBe(1);
  } finally {
    console.error = originalError;
    if (previousRoot === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT; else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previousRoot;
  }
});

test("round3 R1-OAI-2: changed symlink activity uses the link timestamp, not its external target", async () => {
  const f = fixture(); const tree = await f.create();
  const target = join(f.root, "external"); writeFileSync(target, "outside");
  const link = join(tree, "changed-link"); symlinkSync(target, link);
  const now = Date.now() + 4 * 86_400_000;
  lutimesSync(link, new Date(now), new Date(now));
  const freshLink = await findStaleAutoWorktrees([f.main], f.host, f.sessions, now);
  expect(freshLink.warnings).toEqual([]);
  expect(freshLink.worktrees).toEqual([]);
  lutimesSync(link, new Date(now - 4 * 86_400_000), new Date(now - 4 * 86_400_000));
  utimesSync(target, new Date(now), new Date(now));
  const oldLink = await findStaleAutoWorktrees([f.main], f.host, f.sessions, now);
  expect(oldLink.warnings).toEqual([]);
  expect(oldLink.worktrees.map((entry) => entry.path)).toEqual([tree]);
});

test("round3 R1-OAI-2: a replacement directory symlink cannot import external descendant activity", async () => {
  const f = fixture(); const tree = await f.create();
  mkdirSync(join(tree, "nested")); writeFileSync(join(tree, "nested", "tracked"), "tracked");
  git(tree, "add", "."); git(tree, "commit", "-qm", "nested");
  rmSync(join(tree, "nested"), { recursive: true });
  const outside = join(f.root, "outside"); mkdirSync(outside); writeFileSync(join(outside, "tracked"), "outside");
  symlinkSync(outside, join(tree, "nested"));
  const now = Date.now() + 4 * 86_400_000;
  utimesSync(join(outside, "tracked"), new Date(now), new Date(now));
  const stale = await findStaleAutoWorktrees([f.main], f.host, f.sessions, now);
  expect(stale.warnings).toEqual([]);
  expect(stale.worktrees.map((entry) => entry.path)).toEqual([tree]);
});
