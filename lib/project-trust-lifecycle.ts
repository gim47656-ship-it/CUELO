import { invalidateModelsCache } from "./models-cache";
import { canonicalProjectKey, getProjectTrustStatus, setProjectTrust, trustProject } from "./project-trust";
import type { ProjectTrustAction, ProjectTrustState } from "./api-types";

/**
 * Applying a project trust change to running sessions.
 *
 * A session reads the trust store once, when it starts, so a stored decision
 * and what live sessions actually run can differ. Changes move the two back
 * together without interrupting work and without ever trusting more than the
 * user approved:
 *
 * - A grant is held in memory until no session for the project is starting and
 *   every live one is safely idle. Then, in one synchronous step, each session
 *   is reserved for closing (so no new turn can start on it), the grant is
 *   written, and the sessions shut down; the next request recreates them with
 *   project code loaded. A restart drops the held grant — the project stays
 *   restricted and the user approves again. A failed write keeps it restricted
 *   and is reported instead of retried.
 * - A revoke is written immediately, so new sessions and a restart are already
 *   restricted. Sessions that loaded project code before it keep running their
 *   current work and are retired one by one as each reaches a safe idle.
 *
 * `reconcileProjectTrust` runs from the registry's running-state notification;
 * with nothing recorded it returns after one map lookup.
 */

export interface ProjectTrustSession {
  readonly cwd: string;
  /** Whether this session started with the project's own code loaded. */
  readonly projectCodeLoaded: boolean;
  isRunning(): boolean;
  /** Idle and holding no work a shutdown would cancel. */
  isSafelyIdle(): boolean;
  /** Ask to be notified again once background work that blocks a safe idle settles. */
  watchBackgroundWork(): void;
  beginClose(options: { onlyWhenIdle?: boolean }): boolean;
  cancelClose(): void;
  shutdown(): Promise<void>;
}

export interface ProjectTrustHost {
  sessions(): Iterable<ProjectTrustSession>;
  /** Whether a session for this canonical project key is between reading trust and registering. */
  isStarting(key: string): boolean;
}

interface TrustChange {
  agentDir: string;
  /** A grant waiting for the project to go idle. */
  grant: boolean;
}

declare global {
  var __cueloProjectTrustChanges: Map<string, TrustChange> | undefined;
  var __cueloProjectTrustErrors: Map<string, string> | undefined;
}

function changes(): Map<string, TrustChange> {
  globalThis.__cueloProjectTrustChanges ??= new Map();
  return globalThis.__cueloProjectTrustChanges;
}

function errors(): Map<string, string> {
  globalThis.__cueloProjectTrustErrors ??= new Map();
  return globalThis.__cueloProjectTrustErrors;
}

export class ProjectTrustNotRequiredError extends Error {
  constructor() {
    super("This project has no resources that require trust");
  }
}

function sessionsFor(host: ProjectTrustHost, key: string): ProjectTrustSession[] {
  return [...new Set(host.sessions())].filter((session) => canonicalProjectKey(session.cwd) === key);
}

function logShutdownFailure(error: unknown): void {
  console.error(
    "[cuelo] failed to shut down a session after a project trust change:",
    error instanceof Error ? error.message : error,
  );
}

function reconcileKey(host: ProjectTrustHost, key: string, change: TrustChange): void {
  const sessions = sessionsFor(host, key);
  const stored = getProjectTrustStatus(key, change.agentDir);

  // Sessions still running project code the user no longer trusts: retire each
  // one the moment it is idle; the rest finish what they are doing first.
  let loadedLeft = false;
  for (const session of sessions) {
    if (stored.trusted || !session.projectCodeLoaded) continue;
    if (session.isSafelyIdle() && session.beginClose({ onlyWhenIdle: true })) {
      void session.shutdown().catch(logShutdownFailure);
    } else {
      loadedLeft = true;
      session.watchBackgroundWork();
    }
  }

  if (change.grant) {
    if (!stored.requiresTrust || stored.trusted) {
      changes().delete(key);
      return;
    }
    if (host.isStarting(key)) return;
    const blocked = sessions.filter((session) => !session.isSafelyIdle());
    if (blocked.length > 0) {
      for (const session of blocked) session.watchBackgroundWork();
      return;
    }
    const reserved: ProjectTrustSession[] = [];
    for (const session of sessions) {
      if (!session.beginClose({ onlyWhenIdle: true })) {
        for (const held of reserved) held.cancelClose();
        return;
      }
      reserved.push(session);
    }
    changes().delete(key);
    try {
      trustProject(key, change.agentDir);
    } catch (error) {
      for (const held of reserved) held.cancelClose();
      errors().set(key, error instanceof Error ? error.message : String(error));
      return;
    }
    invalidateModelsCache();
    for (const session of reserved) void session.shutdown().catch(logShutdownFailure);
    return;
  }

  // A session that read the old approval may still be registering; keep the
  // record so `isProjectTrustRevokedFor` can refuse it.
  if (!loadedLeft && !host.isStarting(key)) changes().delete(key);
}

let reconciling = false;

export function reconcileProjectTrust(host: ProjectTrustHost): void {
  const pending = changes();
  if (pending.size === 0 || reconciling) return;
  reconciling = true;
  try {
    for (const [key, change] of [...pending]) {
      try {
        reconcileKey(host, key, change);
      } catch (error) {
        console.error(
          "[cuelo] failed to apply a project trust change:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  } finally {
    reconciling = false;
  }
}

/**
 * True when a session that started with project code loaded must not be
 * registered because the approval was revoked while it was starting.
 */
export function isProjectTrustRevokedFor(cwd: string): boolean {
  const pending = changes();
  if (pending.size === 0) return false;
  const change = pending.get(canonicalProjectKey(cwd));
  return change !== undefined && !getProjectTrustStatus(cwd, change.agentDir).trusted;
}

export function describeProjectTrust(host: ProjectTrustHost, cwd: string, agentDir: string): ProjectTrustState {
  const key = canonicalProjectKey(cwd);
  const stored = getProjectTrustStatus(cwd, agentDir);
  const sessions = sessionsFor(host, key);
  const loaded = sessions.filter((session) => session.projectCodeLoaded).length;
  const error = errors().get(key);
  let pending: ProjectTrustState["pending"] = null;
  if (changes().get(key)?.grant) pending = "grant";
  else if (stored.requiresTrust && !stored.trusted && loaded > 0) pending = "revoke";
  return {
    ...stored,
    pending,
    runtime: {
      sessions: sessions.length,
      running: sessions.filter((session) => session.isRunning()).length,
      projectCodeLoaded: loaded,
    },
    ...(error ? { error } : {}),
  };
}

/**
 * Record an explicit decision and apply as much of it as is safe now.
 * `cancel` withdraws a grant that has not been applied; withdrawing a revoke
 * is a new grant and needs its own confirmation.
 */
export function requestProjectTrustChange(
  host: ProjectTrustHost,
  cwd: string,
  agentDir: string,
  action: ProjectTrustAction,
): ProjectTrustState {
  const key = canonicalProjectKey(cwd);
  const pending = changes();
  errors().delete(key);
  if (action === "grant") {
    if (!getProjectTrustStatus(cwd, agentDir).requiresTrust) throw new ProjectTrustNotRequiredError();
    pending.set(key, { agentDir, grant: true });
  } else if (action === "revoke") {
    pending.delete(key);
    setProjectTrust(cwd, agentDir, false);
    invalidateModelsCache();
    pending.set(key, { agentDir, grant: false });
  } else if (pending.get(key)?.grant) {
    pending.set(key, { agentDir, grant: false });
  }
  const change = pending.get(key);
  if (change) {
    reconciling = true;
    try {
      reconcileKey(host, key, change);
    } finally {
      reconciling = false;
    }
  }
  return describeProjectTrust(host, cwd, agentDir);
}
