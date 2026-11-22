import { spawn, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterChildShellEnv } from "@oh-my-pi/pi-utils";

/** A repository opts in by defining this script in the worktree's package.json. */
export const PREPARE_SCRIPT = "prepare:worktree";
export const PREPARE_LOG = "cuelo-prepare.log";
export const PREPARE_STATUS = "cuelo-prepare.json";
export const PREPARE_STATUS_ENV = "CUELO_WORKTREE_PREPARE_STATUS";

type StartedPrepareState = { state: "running" | "done" | "failed"; step?: string; startedAt: string; finishedAt?: string; exitCode?: number | null; error?: string };
export type PrepareState = StartedPrepareState | { state: "held"; reason: "project-trust" };
export type PrepareChild = { once(event: "error", listener: (error: Error) => void): unknown; once(event: "exit", listener: (code: number | null) => void): unknown; unref(): void };
export type Spawner = (command: string, args: string[], options: SpawnOptions) => PrepareChild;

export function hasPrepareScript(worktree: string): boolean {
  try {
    const scripts = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"))?.scripts;
    return typeof scripts?.[PREPARE_SCRIPT] === "string";
  } catch { return false; }
}

export function holdWorktreePrepare(gitDir: string): void {
  const status: PrepareState = { state: "held", reason: "project-trust" };
  writeFileSync(join(gitDir, PREPARE_STATUS), JSON.stringify(status), { flag: "wx" });
}

export function isWorktreePrepareHeld(gitDir: string): boolean {
  try {
    const status = JSON.parse(readFileSync(join(gitDir, PREPARE_STATUS), "utf8"));
    return status?.state === "held" && status?.reason === "project-trust";
  } catch { return false; }
}

/**
 * Start the repository's `prepare:worktree` script detached to install dependencies Git does not
 * carry. Its log and status live in the worktree's private Git directory and are removed with it.
 * The caller verifies checkout trust immediately before invoking. Never waits for the script.
 * The status file is written here as running, and as failed when the launch itself fails or the child
 * exits non-zero without having reported. A script that wants a result surviving a server restart
 * writes its own final state to the file named by CUELO_WORKTREE_PREPARE_STATUS (bin/prepare-worktree.js does).
 */
export async function startWorktreePrepare(worktree: string, gitDir: string | undefined, spawner: Spawner = spawn as Spawner): Promise<boolean> {
  if (!gitDir || !hasPrepareScript(worktree)) return false;
  const statusPath = join(gitDir, PREPARE_STATUS);
  const status: StartedPrepareState = { state: "running", startedAt: new Date().toISOString() };
  const write = (next: PrepareState) => { try { writeFileSync(statusPath, JSON.stringify(next)); } catch (error) { console.error("[session-worktree] prepare status not written:", error); } };
  // The script reports its own step; the supervisor only closes a status the script left running.
  const finish = (code: number | null, error?: string) => {
    let current = status;
    try {
      const reported: PrepareState | null = JSON.parse(readFileSync(statusPath, "utf8"));
      if (reported && reported.state !== "held") current = reported;
    } catch { /* no status yet: report from the launch record */ }
    if (current.state === "done" || current.state === "failed") return;
    write({ ...current, state: code === 0 ? "done" : "failed", exitCode: code, ...(error ? { error } : {}), finishedAt: new Date().toISOString() });
  };
  try {
    mkdirSync(gitDir, { recursive: true });
    let log: number;
    try {
      // The log is also the once-only launch claim, including across server processes.
      log = openSync(join(gitDir, PREPARE_LOG), "ax");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try {
      writeFileSync(statusPath, JSON.stringify(status));
      const env = { ...filterChildShellEnv(process.env, worktree), [PREPARE_STATUS_ENV]: statusPath } as unknown as NodeJS.ProcessEnv;
      const child = spawner("bun", ["run", PREPARE_SCRIPT], { cwd: worktree, env, detached: true, stdio: ["ignore", log, log] });
      child.once("error", (error: Error) => finish(null, error.message));
      child.once("exit", (code: number | null) => finish(code));
      child.unref();
    } finally { closeSync(log); }
    return true;
  } catch (error) {
    console.error("[session-worktree] prepare:worktree not started:", error);
    finish(null, error instanceof Error ? error.message : String(error));
    return false;
  }
}
