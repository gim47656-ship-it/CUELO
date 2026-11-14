import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { getLiveSessionWorktreeUses, reserveWorktreeRemoval, startNewRpcSession, type AgentSessionWrapper, type RpcSessionStartOptions } from "../rpc-manager";
import { removedAutoWorktreeRoot, rollbackUnstartedWorktree, selectSessionWorktree, sweepSessionWorktrees, withRepositoryLock, type LiveUse, type Selection } from "./index";
import { findStaleAutoWorktrees, runWorktreeMaintenance, sessionWorktreeRoots } from "./maintenance";
import { listAllSessions } from "../session-reader";

type Started = { session: AgentSessionWrapper; realSessionId: string } & Selection;
const globals = globalThis as typeof globalThis & {
  __cueloWorktreeRequests?: Map<string, { result: Promise<Started>; expires: number }>;
  __cueloResumeWorktrees?: Map<string, string>;
};
const pending = globals.__cueloResumeWorktrees ??= new Map<string, string>();
const host = {
  live: (): LiveUse[] => [...getLiveSessionWorktreeUses(), ...Array.from(pending, ([id, cwd]) => ({ id, cwd }))],
  reserve: reserveWorktreeRemoval,
};
export async function startSessionWithWorktree(
  requestId: string | undefined,
  cwd: string,
  options: RpcSessionStartOptions,
  selection: { issue?: unknown; autoWorktree?: boolean },
): Promise<Started> {
  const requests = globals.__cueloWorktreeRequests ??= new Map();
  for (const [key, entry] of requests) if (entry.expires <= Date.now()) requests.delete(key);
  if (requestId) {
    const prior = requests.get(requestId);
    if (prior) {
      const result = await prior.result;
      if (result.session.isAlive()) return result;
      requests.delete(requestId);
    }
  }
  const result = withRepositoryLock(cwd, async () => {
    const selected = await selectSessionWorktree(cwd, host, selection);
    try {
      const started = await startNewRpcSession(requestId, selected.cwd, options);
      return { ...started, ...selected, cwd: started.session.cwd };
    } catch (error) {
      await rollbackUnstartedWorktree(selected);
      throw error;
    }
  });
  if (requestId) {
    const entry = { result, expires: Date.now() + 10 * 60_000 };
    requests.set(requestId, entry);
    void result.catch(() => { if (requests.get(requestId) === entry) requests.delete(requestId); });
  }
  return result;
}

/** Existing-cwd resumes do not change. The lease bridges selection to runtime registration. */
export async function prepareResumedWorktree(manager: Pick<SessionManager, "getRecordedCwd" | "setCwdWithoutRelocation">): Promise<(() => void) | undefined> {
  const recorded = manager.getRecordedCwd();
  if (!recorded || existsSync(recorded)) return undefined;
  const root = removedAutoWorktreeRoot(recorded);
  if (!root) return undefined;
  return withRepositoryLock(root, async () => {
    const suffix = recorded.slice(`${root}-worktrees${sep}`.length).split(sep).slice(1).join(sep);
    const requested = suffix && existsSync(join(root, suffix)) ? join(root, suffix) : root;
    const selected = await selectSessionWorktree(requested, host);
    const id = `resume:${randomUUID()}`;
    pending.set(id, selected.cwd);
    try { manager.setCwdWithoutRelocation(selected.cwd); }
    catch (error) { pending.delete(id); await rollbackUnstartedWorktree(selected); throw error; }
    return () => { pending.delete(id); };
  });
}

export async function notifySessionWorktreeClosed(cwd: string): Promise<void> {
  try {
    const root = removedAutoWorktreeRoot(cwd) ?? cwd;
    const results = await sweepSessionWorktrees(root, host);
    for (const result of results) if (result.removed || result.reason?.includes("Error")) console.info("[session-worktree]", result);
  } catch (error) {
    console.error("[session-worktree] cleanup failed:", error);
  }
}
export function sweepUnusedSessionWorktrees(cwd: string) {
  return sweepSessionWorktrees(cwd, host);
}

export async function maintainRecordedSessionWorktrees(trigger: "startup" | "morning", dryRun = false): Promise<void> {
  if (dryRun) return;
  try {
    await runWorktreeMaintenance(trigger, host, await listAllSessions());
  } catch (error) { console.error("[session-worktree] maintenance failed:", error); }
}

export async function inspectRecordedStaleWorktrees() {
  const sessions = await listAllSessions();
  const roots = sessionWorktreeRoots([...sessions.map((s) => s.cwd), ...host.live().map((s) => s.cwd)]);
  return findStaleAutoWorktrees(roots, host, sessions);
}
