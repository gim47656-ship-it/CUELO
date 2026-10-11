import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionWrapper, reserveWorktreeRemoval } from "./rpc-manager";

let root = "";
let worktree = "";
const previousUpdateRoot = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
const previousRegistry = globalThis.__ompSessions;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cuelo-worktree-removal-"));
  worktree = join(root, "repo-worktrees", "feature");
  mkdirSync(join(worktree, "src"), { recursive: true });
  mkdirSync(join(root, "repo-worktrees", "feature-2"), { recursive: true });
  // `notifyRunningChange` records running sessions for the updater; keep it in the fixture.
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = join(root, "external-update");
  globalThis.__ompSessions = new Map();
  globalThis.__ompRemovingWorktrees = undefined;
});

afterEach(() => {
  for (const session of globalThis.__ompSessions?.values() ?? []) session.destroy();
  globalThis.__ompSessions = previousRegistry;
  globalThis.__ompRemovingWorktrees = undefined;
  if (previousUpdateRoot === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previousUpdateRoot;
  rmSync(root, { recursive: true, force: true });
});

function addSession(id: string, cwd: string, prompt: () => Promise<void>): AgentSessionWrapper {
  const wrapper = new AgentSessionWrapper({
    sessionId: id,
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
    prompt,
  } as never, { on: () => () => {} } as never);
  globalThis.__ompSessions?.set(id, wrapper);
  return wrapper;
}

test("refuses removal while a session under the worktree is still working, then allows it once idle", async () => {
  const release = Promise.withResolvers<void>();
  const siblingWork = Promise.withResolvers<void>();
  const wrapper = addSession("inside", join(worktree, "src"), () => release.promise);
  // A busy session in a sibling whose name shares the prefix must not block this worktree.
  const sibling = addSession("sibling", join(root, "repo-worktrees", "feature-2"), () => siblingWork.promise);
  await sibling.send({ type: "prompt", message: "keep working" });

  await wrapper.send({ type: "prompt", message: "keep working" });
  const blocked = reserveWorktreeRemoval(worktree);
  expect(blocked.busy).toEqual(["inside"]);
  expect(globalThis.__ompRemovingWorktrees?.size ?? 0).toBe(0);

  release.resolve();
  await release.promise;
  await Promise.resolve();
  expect(wrapper.isSafelyIdle()).toBe(true);
  const reservation = reserveWorktreeRemoval(worktree);
  expect(reservation.busy).toEqual([]);
  expect(globalThis.__ompRemovingWorktrees?.size).toBe(1);
  reservation.release();
  expect(globalThis.__ompRemovingWorktrees?.size).toBe(0);
});
