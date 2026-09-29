import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeProjectTrust,
  isProjectTrustRevokedFor,
  reconcileProjectTrust,
  requestProjectTrustChange,
  type ProjectTrustHost,
  type ProjectTrustSession,
} from "./project-trust-lifecycle";
import { canonicalProjectKey, getProjectTrustStatus, setProjectTrust } from "./project-trust";
import { AgentSessionWrapper, notifyRunningChange, projectTrustHost } from "./rpc-manager";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";

let root = "";
let cwd = "";
let agentDir = "";
const previousUpdateRoot = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
const previousRegistry = globalThis.__ompSessions;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cuelo-trust-lifecycle-"));
  cwd = join(root, "project");
  agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".omp", "extensions"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  // `notifyRunningChange` records running sessions for the updater; keep it in the fixture.
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = join(root, "external-update");
  globalThis.__cueloProjectTrustChanges = undefined;
  globalThis.__cueloProjectTrustErrors = undefined;
  globalThis.__ompSessions = new Map();
});

afterEach(() => {
  for (const session of globalThis.__ompSessions?.values() ?? []) session.destroy();
  globalThis.__ompSessions = previousRegistry;
  globalThis.__cueloProjectTrustChanges = undefined;
  globalThis.__cueloProjectTrustErrors = undefined;
  if (previousUpdateRoot === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previousUpdateRoot;
  rmSync(root, { recursive: true, force: true });
});

type FakeState = { running: boolean; background: boolean; closing: boolean; shutdowns: number; watched: number };

function fakeHost() {
  const sessions: ProjectTrustSession[] = [];
  const starting = new Set<string>();
  const host: ProjectTrustHost = {
    sessions: () => sessions,
    isStarting: (key) => starting.has(key),
  };
  const add = (sessionCwd: string, options: { loaded?: boolean; running?: boolean; background?: boolean } = {}) => {
    const state: FakeState = {
      running: options.running ?? false,
      background: options.background ?? false,
      closing: false,
      shutdowns: 0,
      watched: 0,
    };
    const session: ProjectTrustSession = {
      cwd: sessionCwd,
      projectCodeLoaded: options.loaded ?? false,
      isRunning: () => state.running,
      isSafelyIdle: () => !state.running && !state.background && !state.closing,
      watchBackgroundWork: () => { state.watched += 1; },
      beginClose: ({ onlyWhenIdle }) => {
        if (onlyWhenIdle && !state.closing && state.running) return false;
        state.closing = true;
        return true;
      },
      cancelClose: () => { state.closing = false; },
      shutdown: async () => {
        state.shutdowns += 1;
        sessions.splice(sessions.indexOf(session), 1);
      },
    };
    sessions.push(session);
    return state;
  };
  return { host, add, starting };
}

test("a grant requested while a session runs waits, then applies once every session is safely idle", async () => {
  const { host, add } = fakeHost();
  const busy = add(cwd, { running: true });
  const idle = add(cwd);

  const scheduled = requestProjectTrustChange(host, cwd, agentDir, "grant");
  expect(scheduled.pending).toBe("grant");
  expect(scheduled.trusted).toBe(false);
  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);
  expect(busy.closing || idle.closing).toBe(false);

  busy.running = false;
  reconcileProjectTrust(host);
  await Promise.resolve();

  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(true);
  expect([busy.shutdowns, idle.shutdowns]).toEqual([1, 1]);
  expect(describeProjectTrust(host, cwd, agentDir).pending).toBeNull();
});

test("a pending grant waits for background work and for sessions still starting", () => {
  const { host, add, starting } = fakeHost();
  const session = add(cwd, { background: true });
  starting.add(canonicalProjectKey(cwd));

  requestProjectTrustChange(host, cwd, agentDir, "grant");
  starting.clear();
  reconcileProjectTrust(host);
  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);
  expect(session.watched).toBeGreaterThan(0);

  session.background = false;
  reconcileProjectTrust(host);
  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(true);
});

test("a session opened through another path to the project blocks the grant like the canonical one", () => {
  const link = join(root, "project-link");
  symlinkSync(cwd, link, "junction");
  const { host, add } = fakeHost();
  const busy = add(link, { running: true });

  requestProjectTrustChange(host, cwd, agentDir, "grant");
  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);
  busy.running = false;
  reconcileProjectTrust(host);
  expect(getProjectTrustStatus(link, agentDir).trusted).toBe(true);
  expect(busy.shutdowns).toBe(1);
});

test("cancelling a scheduled grant leaves the project restricted", () => {
  const { host, add } = fakeHost();
  const busy = add(cwd, { running: true });
  requestProjectTrustChange(host, cwd, agentDir, "grant");

  expect(requestProjectTrustChange(host, cwd, agentDir, "cancel").pending).toBeNull();
  busy.running = false;
  reconcileProjectTrust(host);
  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);
  expect(busy.shutdowns).toBe(0);
});

test("a restart forgets a grant that was never applied", () => {
  const { host, add } = fakeHost();
  add(cwd, { running: true });
  requestProjectTrustChange(host, cwd, agentDir, "grant");

  globalThis.__cueloProjectTrustChanges = undefined;
  const fresh = fakeHost();
  expect(describeProjectTrust(fresh.host, cwd, agentDir)).toMatchObject({ trusted: false, pending: null });
});

test("a grant that cannot be written stays restricted, releases the sessions, and reports why", () => {
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "");
  const unwritable = join(blocker, "agent");
  const { host, add } = fakeHost();
  const session = add(cwd);

  const state = requestProjectTrustChange(host, cwd, unwritable, "grant");
  expect(state).toMatchObject({ trusted: false, pending: null });
  expect(state.error).toBeTruthy();
  expect(session).toMatchObject({ closing: false, shutdowns: 0 });

  reconcileProjectTrust(host);
  expect(session.shutdowns).toBe(0);
});

test("a revoke is stored at once while running sessions keep their work until they are idle", async () => {
  setProjectTrust(cwd, agentDir, true);
  const { host, add } = fakeHost();
  const running = add(cwd, { loaded: true, running: true });
  const idle = add(cwd, { loaded: true });

  const state = requestProjectTrustChange(host, cwd, agentDir, "revoke");
  expect(state.trusted).toBe(false);
  expect(JSON.parse(readFileSync(join(agentDir, "cuelo-trusted-projects.json"), "utf8")))
    .toEqual({ [canonicalProjectKey(cwd)]: false });
  expect(idle.shutdowns).toBe(1);
  expect(running).toMatchObject({ closing: false, shutdowns: 0 });
  expect(state).toMatchObject({ pending: "revoke", runtime: { sessions: 1, running: 1, projectCodeLoaded: 1 } });

  running.running = false;
  reconcileProjectTrust(host);
  expect(running.shutdowns).toBe(1);
  expect(describeProjectTrust(host, cwd, agentDir).pending).toBeNull();
});

test("a session that read the approval before a revoke is refused while it registers", () => {
  setProjectTrust(cwd, agentDir, true);
  const { host, starting } = fakeHost();
  starting.add(canonicalProjectKey(cwd));

  requestProjectTrustChange(host, cwd, agentDir, "revoke");
  expect(isProjectTrustRevokedFor(cwd)).toBe(true);

  starting.clear();
  reconcileProjectTrust(host);
  expect(isProjectTrustRevokedFor(cwd)).toBe(false);
});

function makeWrapper(inner: Record<string, unknown>): AgentSessionWrapper {
  const wrapper = new AgentSessionWrapper({
    sessionId: "trust-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: undefined,
    sessionManager: { getEntries: () => [], getCwd: () => cwd },
    abort: async () => {},
    abortBash: () => {},
    dispose: async () => {},
    ...inner,
  } as never, { on: () => () => {} } as never);
  globalThis.__ompSessions?.set("trust-session", wrapper);
  return wrapper;
}

test("the end of a real prompt wakes the pending grant through the running-state notification", async () => {
  const release = Promise.withResolvers<void>();
  const wrapper = makeWrapper({ prompt: () => release.promise });

  await wrapper.send({ type: "prompt", message: "keep working" });
  expect(wrapper.isRunning()).toBe(true);
  expect(requestProjectTrustChange(projectTrustHost, cwd, agentDir, "grant").pending).toBe("grant");

  release.resolve();
  await release.promise;
  await Promise.resolve();

  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(true);
  await expect(wrapper.send({ type: "prompt", message: "late" })).rejects.toThrow(/Session is closing|not alive/i);
});

test("a background job that finishes without waking a turn still releases the pending grant", async () => {
  const manager = new AsyncJobManager({ maxRunningJobs: 4 });
  const job = Promise.withResolvers<string>();
  manager.register("bash", "long build", () => job.promise);
  const wrapper = makeWrapper({ asyncJobManager: manager });

  expect(wrapper.isRunning()).toBe(false);
  expect(wrapper.isSafelyIdle()).toBe(false);
  requestProjectTrustChange(projectTrustHost, cwd, agentDir, "grant");
  notifyRunningChange();
  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(false);

  job.resolve("done");
  await manager.waitForAll();
  for (let turn = 0; turn < 5 && !getProjectTrustStatus(cwd, agentDir).trusted; turn += 1) await Promise.resolve();

  expect(getProjectTrustStatus(cwd, agentDir).trusted).toBe(true);
  await manager.dispose({ timeoutMs: 1_000 });
});
