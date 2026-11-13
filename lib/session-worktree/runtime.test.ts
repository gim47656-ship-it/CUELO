import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSessionWrapper, getLiveSessionWorktreeUses } from "../rpc-manager";
import { prepareResumedWorktree, notifySessionWorktreeClosed } from "./runtime";
import { checkoutIsBusy, selectSessionWorktree, withRepositoryLock } from "./index";
const roots: string[] = [];
const savedRegistry = globalThis.__ompSessions;
afterEach(() => { globalThis.__ompSessions = savedRegistry; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cuelo-worktree-runtime-")); roots.push(root);
  const main = join(root, "repo"); mkdirSync(main);
  git(root, "init", "-q", "--bare", "--initial-branch=main", join(root, "origin.git"));
  git(main, "init", "-q", "--initial-branch=main"); git(main, "config", "user.name", "Test"); git(main, "config", "user.email", "test@example.invalid");
  writeFileSync(join(main, "base"), "base"); git(main, "add", "."); git(main, "commit", "-qm", "base");
  git(main, "remote", "add", "origin", join(root, "origin.git")); git(main, "push", "-qu", "origin", "main");
  return { root, main };
}
function wrapper(id: string, cwd: string, jobs: unknown[] = []) {
  return { isAlive: () => true, sessionId: id, cwd, inner: { asyncJobManager: { getRunningJobs: () => jobs, hasPendingDeliveries: () => false, waitForAll: async () => {} } } };
}
test("live snapshot includes idle sessions, actual job cwd, Maker cwd and starting leases", () => {
  const root = "/tmp/cu-worktree-helper";
  globalThis.__ompSessions = new Map([["parent", wrapper("parent", "/tmp/elsewhere", [{ id: "job", process: { cwd: `${root}/build` } }, { id: "fallback-job" }]) as never]]);
  const registry = AgentRegistry.global(); const id = `worktree-maker-${randomUUID()}`;
  const ref = registry.register({ id, displayName: id, kind: "sub", status: "running", session: { sessionManager: { getCwd: () => root }, isStreaming: true } as never });
  try {
    const uses = getLiveSessionWorktreeUses();
    expect(uses).toContainEqual({ id: "parent", cwd: "/tmp/elsewhere" });
    expect(uses).toContainEqual({ id: "job", cwd: `${root}/build` });
    expect(uses).toContainEqual({ id: "fallback-job", cwd: "/tmp/elsewhere" });
    expect(uses).toContainEqual({ id, cwd: root });
    expect(checkoutIsBusy(root, uses)).toBe(true);
  } finally { registry.unregister(id, ref); }
});
test("existing-cwd resumes and missing manual worktree resumes stay unchanged", async () => {
  const f = fixture(); let changed = false;
  const manager = { getRecordedCwd: () => f.main, setCwdWithoutRelocation: () => { changed = true; } };
  expect(await prepareResumedWorktree(manager)).toBeUndefined();
  manager.getRecordedCwd = () => `${f.main}-worktrees/wt-user`;
  expect(await prepareResumedWorktree(manager)).toBeUndefined(); expect(changed).toBe(false);
});
test("missing auto resume returns to main unless main is busy; parallel resumes are isolated", async () => {
  const f = fixture(); globalThis.__ompSessions = new Map();
  const recorded = `${f.main}-worktrees/wt-issue-7`;
  let cwd = "";
  const release = await prepareResumedWorktree({ getRecordedCwd: () => recorded, setCwdWithoutRelocation: (value) => { cwd = value; } });
  expect(cwd).toBe(f.main);
  let second = "";
  const releaseSecond = await prepareResumedWorktree({ getRecordedCwd: () => recorded, setCwdWithoutRelocation: (value) => { second = value; } });
  expect(second).toMatch(/-worktrees\/wt-s-\d{8}-[a-f0-9]{8}$/);
  release?.(); releaseSecond?.();
});
test("close notification sweeps a landed tree and leaves live trees alone", async () => {
  const f = fixture(); globalThis.__ompSessions = new Map();
  const selected = await selectSessionWorktree(f.main, { live: () => [], reserve: () => ({ busy: [], release() {} }) }, { issue: "#7" });
  writeFileSync(join(selected.cwd, "own"), "own"); git(selected.cwd, "add", "."); git(selected.cwd, "commit", "-qm", "own"); git(selected.cwd, "push", "-q", "origin", "HEAD:main");
  globalThis.__ompSessions.set("live", wrapper("live", selected.cwd) as never);
  await notifySessionWorktreeClosed(selected.cwd); expect(existsSync(selected.cwd)).toBe(true);
  globalThis.__ompSessions.clear(); await notifySessionWorktreeClosed(selected.cwd);
  expect(existsSync(selected.cwd)).toBe(false);
});
test("destroy calls cleanup after removing registry state, non-blocking and without propagating errors", async () => {
  const f = fixture(); globalThis.__ompSessions = new Map();
  const selected = await selectSessionWorktree(f.main, { live: () => [], reserve: () => ({ busy: [], release() {} }) }, { issue: "#7" });
  writeFileSync(join(selected.cwd, "own"), "own"); git(selected.cwd, "add", "."); git(selected.cwd, "commit", "-qm", "own"); git(selected.cwd, "push", "-q", "origin", "HEAD:main");
  // Exercise the real wrapper's teardown; only its SDK/session collaborators are fixture values.
  const inner = { settings: { get: () => undefined }, sessionManager: { getCwd: () => selected.cwd, getSessionId: () => "destroy-test" }, dispose() {}, isBashRunning: false };
  const bus = { on: () => () => {}, subscribe: () => () => {} };
  const session = new AgentSessionWrapper(inner as never, bus as never);
  session.onDestroy(() => { globalThis.__ompSessions?.delete("destroy-test"); });
  globalThis.__ompSessions.set("destroy-test", session);
  const { promise: removed, resolve: onRemoved } = Promise.withResolvers<void>();
  const watcher = watch(`${f.main}-worktrees`, () => { if (!existsSync(selected.cwd)) onRemoved(); });
  try {
    expect(() => session.destroy()).not.toThrow();
    expect(globalThis.__ompSessions.has("destroy-test")).toBe(false);
    await removed;
  } finally { watcher.close(); }
  await withRepositoryLock(f.main, async () => {});
  expect(existsSync(selected.cwd)).toBe(false);
});
