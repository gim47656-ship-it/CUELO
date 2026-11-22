import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { requestProjectTrustChange } from "../project-trust-lifecycle";
import { getProjectTrustStatus, listProjectTrustDecisions, setProjectTrust } from "../project-trust";
import { AgentSessionWrapper, getLiveSessionWorktreeUses } from "../rpc-manager";
import { prepareResumedWorktree, notifySessionWorktreeClosed, startSessionWithWorktree } from "./runtime";
import { checkoutIsBusy, selectSessionWorktree, withRepositoryLock } from "./index";
import { PREPARE_LOG, PREPARE_STATUS } from "./prepare";
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
function addPrepare(main: string) {
  writeFileSync(join(main, "package.json"), JSON.stringify({ scripts: { "prepare:worktree": "echo prepared >> prepare-marker" } }));
  mkdirSync(join(main, "src"));
  writeFileSync(join(main, "src", "tracked"), "");
  git(main, "add", "."); git(main, "commit", "-qm", "prepare"); git(main, "push", "-q");
}
function prepareStatusPath(cwd: string) {
  return join(git(cwd, "rev-parse", "--absolute-git-dir"), PREPARE_STATUS);
}
async function expectPrepared(cwd: string) {
  const status = prepareStatusPath(cwd);
  const { promise, resolve } = Promise.withResolvers<string>();
  const observe = () => {
    if (!existsSync(status)) return;
    const contents = readFileSync(status, "utf8");
    if (contents.includes('"state":"done"') || contents.includes('"state":"failed"')) resolve(contents);
  };
  const watcher = watch(dirname(status), { persistent: false }, observe);
  try {
    observe();
    expect(JSON.parse(await promise)).toMatchObject({ state: "done" });
    expect(readFileSync(join(cwd, "prepare-marker"), "utf8")).toBe("prepared\n");
  } finally { watcher.close(); }
}
function wrapper(id: string, cwd: string, jobs: unknown[] = []) {
  return { isAlive: () => true, sessionId: id, cwd, inner: { asyncJobManager: { getRunningJobs: () => jobs, hasPendingDeliveries: () => false, waitForAll: async () => {} } } };
}
test("live snapshot includes idle sessions, actual job cwd, Maker cwd and starting leases", () => {
  const root = "/tmp/cu-worktree-helper";
  globalThis.__ompSessions = new Map([["parent", wrapper("parent", "/tmp/elsewhere", [{ id: "job", process: { cwd: `${root}/build` } }, { id: "fallback-job" }]) as never]]);
  const registry = AgentRegistry.global(); const id = `worktree-maker-${randomUUID()}`;
  const ref = registry.register({ id, displayName: id, kind: "sub", status: "running", session: { sessionManager: { getCwd: () => root }, isStreaming: true, isRunActive: true, runStartedAt: Date.now() } as never });
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
test("an untrusted resumed worktree holds its only executable resource until the checkout grant applies", async () => {
  const f = fixture(); addPrepare(f.main);
  const agentDir = join(f.root, "agent"); mkdirSync(agentDir);
  const previousAgentDir = getAgentDir(); setAgentDir(agentDir);
  globalThis.__ompSessions = new Map([["main", wrapper("main", f.main) as never]]);
  let cwd = "";
  let release: (() => void) | undefined;
  let starting = false;
  const trustHost = { sessions: () => [], isStarting: () => starting };
  const settings = Settings.isolated();
  try {
    release = await prepareResumedWorktree({
      getRecordedCwd: () => `${f.main}-worktrees/wt-issue-7`,
      setCwdWithoutRelocation: (value) => { cwd = value; },
    });
    expect(cwd).toMatch(/-worktrees\/wt-s-\d{8}-[a-f0-9]{8}$/);
    const statusPath = prepareStatusPath(cwd);
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ state: "held" });
    expect(existsSync(join(cwd, "prepare-marker"))).toBe(false);
    expect(existsSync(join(git(cwd, "rev-parse", "--absolute-git-dir"), PREPARE_LOG))).toBe(false);

    expect(requestProjectTrustChange(trustHost, join(cwd, "src"), agentDir, "grant", settings).trusted).toBe(true);
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ state: "held" });
    starting = true;
    expect(requestProjectTrustChange(trustHost, cwd, agentDir, "grant", settings)).toMatchObject({ pending: "grant", trusted: false });
    expect(JSON.parse(readFileSync(statusPath, "utf8"))).toMatchObject({ state: "held" });
    requestProjectTrustChange(trustHost, cwd, agentDir, "cancel", settings);
    starting = false;
    expect(requestProjectTrustChange(trustHost, cwd, agentDir, "grant", settings)).toMatchObject({ requiresTrust: true, trusted: true });
    await expectPrepared(cwd);
    const finished = readFileSync(statusPath, "utf8");
    requestProjectTrustChange(trustHost, cwd, agentDir, "revoke", settings);
    requestProjectTrustChange(trustHost, cwd, agentDir, "grant", settings);
    expect(readFileSync(statusPath, "utf8")).toBe(finished);
    expect(readFileSync(join(cwd, "prepare-marker"), "utf8")).toBe("prepared\n");
  } finally { release?.(); setAgentDir(previousAgentDir); }
});
test("a worktree picked for a resumed session takes the trusted checkout's approval", async () => {
  const f = fixture(); addPrepare(f.main); globalThis.__ompSessions = new Map();
  const agentDir = join(f.root, "agent"); mkdirSync(agentDir);
  writeFileSync(join(agentDir, "cuelo-trusted-projects.json"), JSON.stringify({ [realpathSync(f.main)]: true }));
  const previousAgentDir = getAgentDir(); setAgentDir(agentDir);
  const releases: Array<(() => void) | undefined> = [];
  try {
    const recorded = `${f.main}-worktrees/wt-issue-7`;
    let first = "", second = "";
    releases.push(await prepareResumedWorktree({ getRecordedCwd: () => recorded, setCwdWithoutRelocation: (value) => { first = value; } }));
    releases.push(await prepareResumedWorktree({ getRecordedCwd: () => recorded, setCwdWithoutRelocation: (value) => { second = value; } }));
    expect(first).toBe(f.main);
    expect(listProjectTrustDecisions(agentDir)[realpathSync(second)]).toBe(true);
    await expectPrepared(second);
  } finally { for (const release of releases) release?.(); setAgentDir(previousAgentDir); }
});
test("a new session prepares at the trusted checkout root without approving nested extensions", async () => {
  const f = fixture(); addPrepare(f.main);
  const nested = join(f.main, "src");
  const extensions = join(nested, ".omp", "extensions");
  mkdirSync(extensions, { recursive: true });
  writeFileSync(join(extensions, "local.ts"), "export default () => {};\n");
  git(f.main, "add", "."); git(f.main, "commit", "-qm", "nested extensions"); git(f.main, "push", "-q");
  const agentDir = join(f.root, "agent");
  setProjectTrust(f.main, agentDir, true);
  const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
  authStorage.keys.setRuntime("anthropic", "fixture-key-no-network");
  const settings = Settings.isolated({
    "memory.backend": "off", "tools.commands": false, "skills.enabled": false, "includeWorkspaceTree": false,
  });
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
  const previousAgentDir = getAgentDir(); setAgentDir(agentDir);
  const previousRuntime = globalThis.__ompRuntimePromise;
  const previousUpdateRoot = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = join(f.root, "external-update");
  globalThis.__ompRuntimePromise = Promise.resolve({ agentDir, settings, authStorage, modelRegistry });
  globalThis.__ompSessions = new Map();
  let session: AgentSessionWrapper | undefined;
  try {
    expect(getProjectTrustStatus(nested, agentDir, settings).trusted).toBe(false);
    const started = await startSessionWithWorktree(undefined, nested, {
      initialModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" },
    }, { autoWorktree: true });
    session = started.session;
    const worktree = started.created!.path;
    expect(started.cwd).toBe(join(worktree, "src"));
    expect(getProjectTrustStatus(worktree, agentDir, settings)).toEqual({ requiresTrust: true, trusted: true });
    expect(session.projectCodeLoaded).toBe(false);
    await expectPrepared(worktree);
  } finally {
    try { await session?.shutdown(); }
    finally {
      globalThis.__ompRuntimePromise = previousRuntime;
      setAgentDir(previousAgentDir);
      if (previousUpdateRoot === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
      else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previousUpdateRoot;
      authStorage.close();
    }
  }
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
