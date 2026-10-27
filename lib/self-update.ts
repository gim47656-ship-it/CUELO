import { spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { CueloUpdateResponse } from "@/lib/api-types";
import { canonicalVersion, getCueloUpdateStatus } from "@/lib/omp-updates";

/**
 * Self-update (`POST /api/updates/apply`). The server, never the browser, decides what to install:
 * the newest release reported by `lib/omp-updates.ts`, and only when it is newer than this build.
 * The browser sends no command, path, package spec, tag or revision.
 */

export type SelfUpdateMode = "npm" | "source" | "wsl";

/** Phases a detached worker writes; the last four are terminal. */
export type SelfUpdatePhase =
  | "starting"
  | "fetching"
  | "installing"
  | "building"
  | "restarting"
  | "done"
  | "handed-off"
  | "restart-required"
  | "failed";

const TERMINAL_PHASES: readonly SelfUpdatePhase[] = ["done", "handed-off", "restart-required", "failed"];

export function isTerminalPhase(phase: string): boolean {
  return (TERMINAL_PHASES as readonly string[]).includes(phase);
}

export interface SelfUpdateJob {
  schemaVersion: 1;
  mode: SelfUpdateMode;
  phase: SelfUpdatePhase;
  currentVersion: string;
  targetVersion: string;
  /** What source mode checked out, or the npm spec it installed. */
  targetRef: string | null;
  pid: number | null;
  supervisorPid: number | null;
  relaunchedPid: number | null;
  startedAt: string;
  updatedAt: string;
  error: string | null;
  logPath: string;
}

export interface SelfUpdateModeInfo {
  mode: SelfUpdateMode | null;
  supported: boolean;
  /** Why the mode is unsupported, or why detection is uncertain. English, shown as-is. */
  reason: string | null;
}

export interface SelfUpdateState {
  job: SelfUpdateJob | null;
  running: boolean;
  mode: SelfUpdateModeInfo;
  runningVersion: string;
}

export type SelfUpdateStartResult =
  | { state: "started" | "running"; job: SelfUpdateJob }
  | { state: "unsupported"; mode: SelfUpdateModeInfo }
  | { state: "up-to-date"; currentVersion: string }
  | { state: "error"; error: string };

const JOB_FILE = "job.json";
const LOCK_FILE = "update.lock";
const PLAN_FILE = "plan.json";
const LOG_FILE = "update.log";
const SUPERVISOR_FILE = "supervisor.json";

/** `~/.cuelo/self-update`, or `CUELO_SELF_UPDATE_DIR` (tests and isolated trees). */
export function resolveSelfUpdateDir(env: Record<string, string | undefined> = process.env): string {
  const configured = env.CUELO_SELF_UPDATE_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".cuelo", "self-update");
}

/**
 * The tree this server runs from: its own working directory, where `next start` was launched and
 * where its `.next` lives. `CUELO_DIR` is only a fallback, because a development server started
 * inside a CUELO session inherits that variable from the service it came from and is not that
 * service's tree.
 */
function resolveAppRoot(env: Record<string, string | undefined>): string {
  const cwd = resolve(process.cwd());
  if (existsSync(join(cwd, "package.json"))) return cwd;
  return resolve(env.CUELO_DIR?.trim() || cwd);
}

/** `name` from the tree's package.json, or null when it cannot be read. */
function readPackageName(appRoot: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { name?: unknown };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

interface DetectInput {
  appRoot: string;
  homeDir: string;
  cgroupText: string;
  /** `CUELO_DIST_DIR` of the running server; `.next` when unset. */
  distDir?: string;
  exists?: (path: string) => boolean;
}

/**
 * Which install this server belongs to, from explicit evidence only.
 *
 * WSL ops mode needs all three: the server runs inside the `cuelo-<port>` unit, that unit's tree is
 * this very tree, and the tree ships `update.sh`. A development server started inside a CUELO
 * session lives in the same cgroup but is a different tree, so it is not a service update; and the
 * service path is never reimplemented here because `update.sh` owns its staged build, drain and
 * rollback.
 */
export function detectInstallMode(input: DetectInput): SelfUpdateModeInfo {
  const exists = input.exists ?? existsSync;
  const serviceRoot = join(input.homeDir, "cuelo-run");
  const updateScript = join(serviceRoot, "Tools", "CUELO_Setup", "wsl", "update.sh");
  const inServiceUnit = /(?:^|\/)cuelo-\d+\.service(?:\/|$)/m.test(input.cgroupText);
  if (inServiceUnit && resolve(input.appRoot) === resolve(serviceRoot) && exists(updateScript)) {
    return { mode: "wsl", supported: true, reason: null };
  }

  // The build Next actually serves (`CUELO_DIST_DIR` in an isolated tree, `.next` otherwise) is what
  // an update replaces. Without one this is a development server, and rebuilding its dist dir would
  // break it while it runs.
  const distDir = input.distDir?.trim() || ".next";
  const hasBuild = exists(join(input.appRoot, distDir, "BUILD_ID"));

  const sourceCheckout = exists(join(input.appRoot, ".git"))
    && exists(join(input.appRoot, "bun.lock"))
    && exists(join(input.appRoot, "app", "layout.tsx"));
  if (sourceCheckout) {
    return hasBuild
      ? { mode: "source", supported: true, reason: null }
      : { mode: "source", supported: false, reason: "this source checkout has no production build; it is a development server, so its dist dir must not be rebuilt under it" };
  }

  // An npm install is the packed package in a directory named after it: `npm install -g cuelo` puts
  // it in `…/node_modules/cuelo`. A downloaded source zip or a project-local copy is neither, and
  // `npm install -g` would replace a different tree than the one serving this page.
  const isNpmLayout = hasBuild
    && exists(join(input.appRoot, "install.mjs"))
    && basename(input.appRoot) === "cuelo"
    && readPackageName(input.appRoot) === "cuelo";
  if (isNpmLayout) return { mode: "npm", supported: true, reason: null };

  return {
    mode: null,
    supported: false,
    reason: inServiceUnit
      ? `the systemd unit was found but this server does not run from ${serviceRoot}`
      : "this CUELO install was not recognised (no production build of a source checkout or npm package, and no WSL service tree)",
  };
}

/** Detection for the running server, reading its own cgroup without spawning anything. */
export function probeInstallMode(env: Record<string, string | undefined> = process.env): SelfUpdateModeInfo {
  let cgroupText = "";
  try {
    cgroupText = readFileSync("/proc/self/cgroup", "utf8");
  } catch {
    // Not Linux, or /proc is not mounted: no service unit to find.
  }
  return detectInstallMode({
    appRoot: resolveAppRoot(env),
    homeDir: env.HOME?.trim() || homedir(),
    cgroupText,
    distDir: env.CUELO_DIST_DIR,
  });
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function normalizeJob(raw: unknown): SelfUpdateJob | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const phase = typeof value.phase === "string" ? value.phase : "";
  const mode = value.mode === "npm" || value.mode === "source" || value.mode === "wsl" ? value.mode : null;
  if (!phase || !mode) return null;
  return {
    schemaVersion: 1,
    mode,
    phase: phase as SelfUpdatePhase,
    currentVersion: typeof value.currentVersion === "string" ? value.currentVersion : "unknown",
    targetVersion: typeof value.targetVersion === "string" ? value.targetVersion : "unknown",
    targetRef: typeof value.targetRef === "string" ? value.targetRef : null,
    pid: typeof value.pid === "number" ? value.pid : null,
    supervisorPid: typeof value.supervisorPid === "number" ? value.supervisorPid : null,
    relaunchedPid: typeof value.relaunchedPid === "number" ? value.relaunchedPid : null,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date(0).toISOString(),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
    error: typeof value.error === "string" ? value.error : null,
    logPath: typeof value.logPath === "string" ? value.logPath : join(resolveSelfUpdateDir(), LOG_FILE),
  };
}

/** A malformed lock older than this is treated as abandoned (a worker writes it within milliseconds). */
const LOCK_ABANDON_MS = 10 * 60_000;
/** A handed-off job has no worker left; this long after hand-off it is no longer assumed to run. */
const HANDOFF_ASSUMED_RUNNING_MS = 30 * 60_000;

/**
 * Whether the transient unit a WSL hand-off created still runs. `update.sh` owns its own build and
 * rollback, so this is the only signal that it is still working; when the answer is unavailable the
 * hand-off is assumed to run for a bounded window instead of allowing a second `update.sh`.
 */
function handoffRunning(unit: string, updatedAt: string): boolean {
  const result = spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8", timeout: 3000 });
  const state = (result.stdout ?? "").trim();
  if (state) return state === "active" || state === "activating" || state === "reloading" || state === "deactivating";
  const since = Date.parse(updatedAt);
  return Number.isFinite(since) && Date.now() - since < HANDOFF_ASSUMED_RUNNING_MS;
}

/**
 * Whether a recorded job still owns the lock. A dead worker's job is reported, not "running": the
 * worker rewrites `update.lock` with its own pid as soon as it starts, so a worker that died leaves a
 * lock whose pid is gone rather than the still-live server that spawned it.
 */
export function readSelfUpdateJob(
  dir: string,
  isProcessAlive: (pid: number) => boolean = isAlive,
  unitRunning: (unit: string, updatedAt: string) => boolean = handoffRunning,
): {
  job: SelfUpdateJob | null;
  running: boolean;
} {
  const job = normalizeJob(readJson<unknown>(join(dir, JOB_FILE)));
  if (!job) return { job: null, running: false };
  // A WSL hand-off keeps the lock while update.sh works, even though this process is gone.
  if (job.phase === "handed-off") return { job, running: job.targetRef ? unitRunning(job.targetRef, job.updatedAt) : false };
  if (isTerminalPhase(job.phase)) return { job, running: false };
  const holder = readJson<{ pid?: unknown }>(join(dir, LOCK_FILE));
  const pid = typeof holder?.pid === "number" ? holder.pid : job.pid;
  return { job, running: pid !== null && isProcessAlive(pid) };
}

export function readSelfUpdateState(dir: string = resolveSelfUpdateDir()): SelfUpdateState {
  const { job, running } = readSelfUpdateJob(dir);
  return {
    job,
    running,
    mode: probeInstallMode(),
    runningVersion: canonicalVersion(process.env.NEXT_PUBLIC_APP_VERSION) ?? "unknown",
  };
}

interface SupervisorRecord {
  schemaVersion: 1;
  pid: number;
  command: string;
  args: string[];
  cwd: string;
}

/** `--home`/`--port-base` from the recorded argv, so the relaunch and the port probe use the same values. */
function supervisorOption(args: string[], flag: string): string | null {
  const at = args.lastIndexOf(flag);
  const value = at >= 0 ? args[at + 1] : undefined;
  return value && !value.startsWith("--") ? value : null;
}

/**
 * `--home` exactly as the supervisor was started with it, made absolute. The supervisor resolved a
 * relative value against the directory it was started from, and the worker runs `install.mjs setup`
 * with `cwd` set to the checkout, so it has to be resolved here or the build would write to a
 * different profile. No value is invented when the start had none: that would move a custom
 * PI_CODING_AGENT_DIR to a plain `~/.omp/agent`.
 */
function recordedHome(record: SupervisorRecord | null): string | null {
  const value = record ? supervisorOption(record.args, "--home") : null;
  if (!value) return null;
  return isAbsolute(value) ? value : resolve(record ? record.cwd : process.cwd(), value);
}

function readSupervisor(dir: string): SupervisorRecord | null {
  const value = readJson<Record<string, unknown>>(join(dir, SUPERVISOR_FILE));
  if (!value || typeof value.command !== "string" || !Array.isArray(value.args)) return null;
  const args = value.args.filter((arg): arg is string => typeof arg === "string");
  if (typeof value.pid !== "number" || typeof value.cwd !== "string") return null;
  return { schemaVersion: 1, pid: value.pid, command: value.command, args, cwd: value.cwd };
}

function writeLock(dir: string): (() => void) | null {
  const file = join(dir, LOCK_FILE);
  try {
    const fd = openSync(file, "wx");
    writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return null;
  }
  return () => {
    rmSync(file, { force: true });
  };
}

/**
 * Remove a lock only when its holder is provably gone, so a crashed worker cannot block every later
 * attempt. A live holder keeps the lock even when the job record reads terminal or unreadable: the
 * worker writes the phase and then releases, so there is a moment where a finished job still owns a
 * lock, and a second worker taking it there would run beside the first. A WSL hand-off keeps its
 * lock through `update.sh` because the job still reports running.
 */
function clearStaleLock(dir: string, unitRunning?: (unit: string, updatedAt: string) => boolean): void {
  if (readSelfUpdateJob(dir, isAlive, unitRunning).running) return;
  const file = join(dir, LOCK_FILE);
  const holder = readJson<{ pid?: unknown }>(file);
  if (!holder || typeof holder.pid !== "number") {
    // Unreadable or malformed: the live holder may be mid-write, so this is not provably gone. Only
    // an old lock is treated as abandoned.
    const age = Date.now() - (statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < LOCK_ABANDON_MS) return;
  } else if (holder.pid === process.pid || isAlive(holder.pid)) {
    // Our own server between `writeLock` and the worker's claim, or a worker still running.
    return;
  }
  rmSync(file, { force: true });
}

interface StartOptions {
  env?: Record<string, string | undefined>;
  dir?: string;
  status?: (options: { currentAppVersion: string }) => Promise<CueloUpdateResponse>;
  /** Overridable for tests: returns the worker pid. */
  spawnWorker?: (planPath: string, dir: string) => number;
  mode?: SelfUpdateModeInfo;
  /** Whether a hand-off's transient unit still runs; `systemctl --user is-active` by default. */
  unitRunning?: (unit: string, updatedAt: string) => boolean;
}

function defaultSpawnWorker(planPath: string, dir: string, env: Record<string, string | undefined>): number {
  const source = join(resolveAppRoot(env), "bin", "self-update.js");
  // Run a copy outside the package tree: `npm install -g cuelo@<v>` rewrites the directory this
  // script lives in while it runs, and the copy keeps the worker independent of that swap.
  const script = join(dir, "worker.js");
  copyFileSync(source, script);
  // Plain Node on purpose: the worker outlives this server, and Bun's module resolution changes
  // when `npm install -g` replaces the package tree underneath a running process.
  const nodeBin = env.CUELO_SELF_UPDATE_NODE?.trim() || "node";
  const log = openSync(join(dir, LOG_FILE), "a");
  try {
    const child = spawn(nodeBin, [script, planPath], {
      cwd: resolveAppRoot(env),
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...env, CUELO_SELF_UPDATE_DIR: dir } as unknown as NodeJS.ProcessEnv,
    });
    child.unref();
    if (!child.pid) throw new Error(`could not start ${nodeBin} ${script}`);
    return child.pid;
  } finally {
    closeSync(log);
  }
}

/**
 * Start one update, or report the one already running. Returns after the detached worker is
 * spawned; progress is read from `job.json`, never from this request.
 */
export async function startSelfUpdate(options: StartOptions = {}): Promise<SelfUpdateStartResult> {
  const env = options.env ?? process.env;
  const dir = options.dir ?? resolveSelfUpdateDir(env);
  const mode = options.mode ?? probeInstallMode(env);
  if (!mode.supported || !mode.mode) return { state: "unsupported", mode };
  const installMode = mode.mode;

  mkdirSync(dir, { recursive: true });
  const existing = readSelfUpdateJob(dir, isAlive, options.unitRunning);
  if (existing.running && existing.job) return { state: "running", job: existing.job };
  clearStaleLock(dir, options.unitRunning);

  const currentAppVersion = env.NEXT_PUBLIC_APP_VERSION ?? "";
  let status: CueloUpdateResponse;
  try {
    status = options.status
      ? await options.status({ currentAppVersion })
      : await getCueloUpdateStatus();
  } catch (error) {
    return { state: "error", error: error instanceof Error ? error.message : String(error) };
  }
  if (!status.updateAvailable || !status.latestRelease) {
    return { state: "up-to-date", currentVersion: status.currentAppVersion };
  }

  const releaseLock = writeLock(dir);
  if (!releaseLock) {
    // Someone holds the lock. Report the job only when it is actually running; a finished job next to
    // a live lock means a worker is between writing its outcome and releasing, and calling that
    // "running" would leave the button disabled on nothing.
    const held = readSelfUpdateJob(dir, isAlive, options.unitRunning);
    if (held.running && held.job) return { state: "running", job: held.job };
    return { state: "error", error: `another update holds ${join(dir, LOCK_FILE)}` };
  }

  const appRoot = resolveAppRoot(env);
  const supervisor = installMode === "wsl" ? null : readSupervisor(dir);
  // R1-ANT-1: only the process that started *this* server may be stopped. `install.mjs start` exports
  // its own pid as CUELO_SUPERVISOR_PID; a record naming anything else belongs to another instance
  // (or a stale file), so the update reports instead of killing an unrelated process.
  const ownSupervisorPid = Number.parseInt(env.CUELO_SUPERVISOR_PID ?? "", 10);
  const trusted = supervisor !== null && Number.isInteger(ownSupervisorPid) && supervisor.pid === ownSupervisorPid
    ? supervisor
    : null;
  const targetVersion = status.latestRelease.version;
  const now = new Date().toISOString();
  const job: SelfUpdateJob = {
    schemaVersion: 1,
    mode: installMode,
    phase: "starting",
    currentVersion: status.currentAppVersion,
    targetVersion,
    targetRef: null,
    pid: null,
    supervisorPid: supervisor?.pid ?? null,
    relaunchedPid: null,
    startedAt: now,
    updatedAt: now,
    error: null,
    logPath: join(dir, LOG_FILE),
  };
  writeFileSync(join(dir, JOB_FILE), `${JSON.stringify(job, null, 2)}\n`);
  const plan = {
    schemaVersion: 1,
    mode: installMode,
    appRoot,
    selfUpdateDir: dir,
    currentVersion: status.currentAppVersion,
    targetVersion,
    tagName: status.latestRelease.tagName,
    logPath: join(dir, LOG_FILE),
    nodeBin: env.CUELO_SELF_UPDATE_NODE?.trim() || "node",
    distDir: env.CUELO_DIST_DIR?.trim() || null,
    npmBin: env.CUELO_NPM_BIN?.trim() || (process.platform === "win32" ? "npm.cmd" : "npm"),
    // R1-ANT-11: `--home` is carried over only when the supervisor was started with one; inventing
    // `--home $HOME` would move a custom PI_CODING_AGENT_DIR to a plain profile.
    home: recordedHome(trusted),
    webPort: Number.parseInt(
      (trusted ? supervisorOption(trusted.args, "--port-base") : null) ?? env.PORT ?? "",
      10,
    ) || 30141,
    supervisor: trusted,
    wsl: installMode === "wsl"
      ? {
        script: join(env.HOME?.trim() || homedir(), "cuelo-run", "Tools", "CUELO_Setup", "wsl", "update.sh"),
        distro: env.WSL_DISTRO_NAME ?? null,
        port: Number.parseInt(env.PORT ?? "", 10) || 30141,
      }
      : null,
  };
  const planPath = join(dir, PLAN_FILE);
  writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  try {
    const spawnWorker = options.spawnWorker ?? ((planFile: string, jobDir: string) => defaultSpawnWorker(planFile, jobDir, env));
    const pid = spawnWorker(planPath, dir);
    const started: SelfUpdateJob = { ...job, pid, updatedAt: new Date().toISOString() };
    writeFileSync(join(dir, JOB_FILE), `${JSON.stringify(started, null, 2)}\n`);
    return { state: "started", job: started };
  } catch (error) {
    releaseLock();
    const message = error instanceof Error ? error.message : String(error);
    writeFileSync(join(dir, JOB_FILE), `${JSON.stringify({ ...job, phase: "failed", error: message, updatedAt: new Date().toISOString() }, null, 2)}\n`);
    return { state: "error", error: message };
  }
}
