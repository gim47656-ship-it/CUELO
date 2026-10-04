import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

/**
 * 새 main 세션이 시작될 때 cwd가 속한 git 저장소의 GitNexus 색인이 HEAD보다 뒤처졌으면
 * `analyze --index-only`를 detached 워커로 한 번 돌린다. 세션 시작은 기다리지 않는다.
 *
 * - 색인(`.gitnexus/meta.json`)이 없는 저장소는 건드리지 않는다. 새 색인은 만들지 않는다.
 * - `--index-only`라 AGENTS.md·CLAUDE.md·`.claude/skills`를 쓰지 않는다. 추적 파일을 더럽히지 않는다.
 * - 이미 설치된 GitNexus만 쓴다: PATH의 `gitnexus`, 없으면 `bun x --no-install gitnexus`(MCP 서버가 쓰는
 *   것과 같은 캐시). `.gitnexus/run.cjs`는 쓰지 않는다. bun 경로에서 run.cjs는 `bunx gitnexus@latest`를 골라
 *   실행 중인 MCP가 쓰는 공용 캐시에 강제 재설치를 시도하기 때문이다.
 * - 서브에이전트 세션은 같은 저장소의 main 세션 아래에서 뜨므로 건너뛴다(중복 점검만 늘어난다).
 * - 저장소당 하나만 돈다: `.gitnexus/autosync.lock`을 O_EXCL로 만들고, 기록된 pid가 죽었거나
 *   너무 오래된 잠금은 회수한다. 실제 색인 쓰기는 GitNexus 자체 단일 작성자 잠금도 함께 지킨다.
 * - Windows의 GitNexus analyze는 색인 DB를 제자리에서 다시 쓴다. MCP 서버가 같은 DB를 열고 있으면
 *   쓰기 도중 충돌할 수 있으므로, 워커가 DB 파일을 공유 없이 열어 보고 다른 프로세스가 쥐고 있으면
 *   이번에는 건너뛴다(다음 세션이 다시 시도한다).
 * - 실패는 세션으로 올리지 않고 gitignore된 `.gitnexus/autosync.log`에만 남긴다.
 */

const LOCK_NAME = "autosync.lock";
const LOG_NAME = "autosync.log";
/** 살아 있는 pid라도 이보다 오래된 잠금은 pid 재사용·고착으로 보고 회수한다. */
const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 10_000;
const LOG_ROTATE_BYTES = 512 * 1024;

export type SyncOutcome =
  | "no-repo"
  | "no-index"
  | "fresh"
  | "locked"
  | "no-runner"
  | "started"
  | "error";

export interface WorkerJob {
  root: string;
  head: string;
  lockPath: string;
  logPath: string;
  token: string;
  /** analyze를 실행할 프로그램과 인자. */
  command: string[];
  /** Windows `.cmd` 실행기처럼 셸이 필요한 경우. */
  shell: boolean;
  /** PATH 앞에 붙일 디렉터리(Windows Git mingw64/bin, FTS 확장의 OpenSSL DLL 위치). */
  pathPrefix?: string;
  /** 다른 프로세스가 열고 있으면 건너뛸 색인 DB 파일(Windows 전용 점검). */
  dbPath?: string;
}

export interface AutoSyncDeps {
  platform: NodeJS.Platform;
  now(): number;
  git(args: string[], cwd: string): Promise<string>;
  which(command: string): string | undefined;
  isAlive(pid: number): boolean;
  /** 워커를 detached로 띄우고 pid를 돌려준다. */
  spawnWorker(job: WorkerJob, nodePath: string): number;
}

interface LockRecord {
  pid: number;
  token: string;
  startedAt: number;
}

function execGit(args: string[], cwd: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: "utf8" }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout.trim());
  });
  return promise;
}

/** Node 파일·프로세스 오류의 errno 코드. 오류 객체 모양이 아니면 undefined. */
function errnoCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/**
 * 워커 본문. `node -e`로 실행되는 독립 스크립트라 확장 모듈을 불러오지 않는다.
 * argv[1]은 WorkerJob JSON이다.
 */
export const WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const job = JSON.parse(process.argv[1]);
const log = (line) => { try { fs.appendFileSync(job.logPath, new Date().toISOString() + " " + line + "\n"); } catch {} };
const release = () => {
  try {
    const rec = JSON.parse(fs.readFileSync(job.lockPath, "utf8"));
    if (rec.token === job.token) fs.unlinkSync(job.lockPath);
  } catch {}
};
const dbInUse = () => {
  if (!job.dbPath) return false;
  try {
    // libuv UV_FS_O_EXLOCK: share mode 0으로 연다. 다른 프로세스 핸들이 있으면 EBUSY.
    fs.closeSync(fs.openSync(job.dbPath, fs.constants.O_RDONLY | 0x10000000));
    return false;
  } catch (error) {
    return error.code === "EBUSY" || error.code === "EPERM";
  }
};
const readLastCommit = () => {
  try { return JSON.parse(fs.readFileSync(job.root + "/.gitnexus/meta.json", "utf8")).lastCommit; } catch { return undefined; }
};
(async () => {
  try {
    if (dbInUse()) {
      log("skip: index DB is open by another process (e.g. a GitNexus MCP reader); next session retries");
      return;
    }
    const env = { ...process.env };
    if (job.pathPrefix) {
      const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
      env[key] = job.pathPrefix + (process.platform === "win32" ? ";" : ":") + (env[key] || "");
    }
    const out = fs.openSync(job.logPath, "a");
    const started = Date.now();
    log("start: " + job.command.join(" ") + " (head " + job.head.slice(0, 12) + ")");
    const code = await new Promise((resolve) => {
      const child = spawn(job.command[0], job.command.slice(1), {
        cwd: job.root, env, stdio: ["ignore", out, out], windowsHide: true, shell: job.shell,
      });
      child.on("error", (error) => { log("spawn error: " + error.message); resolve(-1); });
      child.on("exit", (exitCode, signal) => resolve(exitCode === null ? "signal " + signal : exitCode));
    });
    fs.closeSync(out);
    const indexed = readLastCommit();
    log("end: exit=" + code + " seconds=" + ((Date.now() - started) / 1000).toFixed(1) +
      " lastCommit=" + String(indexed).slice(0, 12) + (indexed === job.head ? " (matches head)" : " (differs from head)"));
  } catch (error) {
    log("worker error: " + (error && error.message ? error.message : String(error)));
  } finally {
    release();
  }
})();
`;

function spawnDetachedWorker(job: WorkerJob, nodePath: string): number {
  const child = spawn(nodePath, ["-e", WORKER_SOURCE, JSON.stringify(job)], {
    cwd: job.root,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error("worker spawn returned no pid");
  return child.pid;
}

export const defaultDeps: AutoSyncDeps = {
  platform: process.platform,
  now: () => Date.now(),
  git: execGit,
  which: (command) => Bun.which(command) ?? undefined,
  isAlive: processAlive,
  spawnWorker: spawnDetachedWorker,
};

function appendLog(logPath: string, now: number, line: string): void {
  try {
    if ((fs.statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) > LOG_ROTATE_BYTES)
      fs.renameSync(logPath, `${logPath}.1`);
    fs.appendFileSync(logPath, `${new Date(now).toISOString()} ${line}\n`);
  } catch {
    // 로그 실패도 세션으로 올리지 않는다.
  }
}

/** JSON 파일을 읽어 객체면 돌려준다. 없거나 깨졌으면 undefined. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 없거나 깨진 파일은 호출자가 판단한다.
  }
  return undefined;
}

function readLock(lockPath: string): LockRecord | undefined {
  const record = readJsonObject(lockPath);
  const { pid, token, startedAt } = record ?? {};
  if (typeof pid === "number" && Number.isInteger(pid) && typeof token === "string" && typeof startedAt === "number")
    return { pid, token, startedAt };
  return undefined;
}

function writeLockAtomically(lockPath: string, record: LockRecord): void {
  const temp = `${lockPath}.${record.token}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record));
  fs.renameSync(temp, lockPath);
}

/** O_EXCL로 잠금을 만든다. 죽었거나 오래된 잠금은 한 번 회수한다. 잡지 못하면 false. */
function acquireLock(lockPath: string, token: string, deps: AutoSyncDeps, logPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, startedAt: deps.now() } satisfies LockRecord));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    if (attempt > 0) return false;
    const holder = readLock(lockPath);
    const stale = !holder || !deps.isAlive(holder.pid) || deps.now() - holder.startedAt > LOCK_MAX_AGE_MS;
    if (!stale) return false;
    // 회수 직전에 같은 잠금인지 다시 확인해 방금 다른 세션이 새로 잡은 잠금을 지우지 않는다.
    const again = readLock(lockPath);
    if (holder && again?.token !== holder.token) return false;
    appendLog(logPath, deps.now(), `reclaim stale lock (pid ${holder?.pid ?? "unreadable"})`);
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
  return false;
}

function resolveRunner(deps: AutoSyncDeps): { command: string[]; shell: boolean; nodePath: string } | undefined {
  // 워커 스크립트는 node로 돈다.
  const nodePath = deps.which("node");
  if (!nodePath) return undefined;
  const installed = deps.which("gitnexus");
  if (installed) {
    const shell = deps.platform === "win32" && /\.(cmd|bat)$/i.test(installed);
    return { command: [shell ? `"${installed}"` : installed, "analyze", "--index-only"], shell, nodePath };
  }
  // --no-install: 캐시에 없으면 내려받지 않고 바로 실패한다.
  const bun = deps.which("bun");
  if (bun) return { command: [bun, "x", "--no-install", "gitnexus", "analyze", "--index-only"], shell: false, nodePath };
  return undefined;
}

/** Windows에서 FTS 확장이 찾는 OpenSSL DLL이 있는 Git `mingw64/bin`. */
async function gitDllDir(root: string, deps: AutoSyncDeps): Promise<string | undefined> {
  if (deps.platform !== "win32") return undefined;
  try {
    const execPath = await deps.git(["--exec-path"], root);
    const bin = path.resolve(execPath, "..", "..", "bin");
    return fs.existsSync(path.join(bin, "libssl-3-x64.dll")) ? bin : undefined;
  } catch {
    return undefined;
  }
}

export async function syncGitNexusIndex(cwd: string, deps: AutoSyncDeps = defaultDeps): Promise<SyncOutcome> {
  let root: string;
  try {
    root = path.resolve(await deps.git(["rev-parse", "--show-toplevel"], cwd));
  } catch {
    return "no-repo";
  }
  const storage = path.join(root, ".gitnexus");
  const metaPath = path.join(storage, "meta.json");
  if (!fs.existsSync(metaPath)) return "no-index";
  const logPath = path.join(storage, LOG_NAME);
  try {
    const lastCommit = readJsonObject(metaPath)?.lastCommit;
    const head = await deps.git(["rev-parse", "HEAD"], root);
    if (lastCommit === head) return "fresh";
    const runner = resolveRunner(deps);
    if (!runner) {
      appendLog(logPath, deps.now(), "skip: no node or GitNexus runner available");
      return "no-runner";
    }
    const lockPath = path.join(storage, LOCK_NAME);
    const token = randomUUID();
    if (!acquireLock(lockPath, token, deps, logPath)) return "locked";
    const job: WorkerJob = {
      root,
      head,
      lockPath,
      logPath,
      token,
      command: runner.command,
      shell: runner.shell,
      pathPrefix: await gitDllDir(root, deps),
      dbPath: deps.platform === "win32" ? path.join(storage, "lbug") : undefined,
    };
    let pid: number;
    try {
      pid = deps.spawnWorker(job, runner.nodePath);
    } catch (error) {
      fs.rmSync(lockPath, { force: true });
      throw error;
    }
    // 잠금 소유자를 실제 워커로 넘겨 이 세션이 끝나도 워커가 사는 동안 잠금이 유지되게 한다.
    // 워커가 이미 끝나 잠금을 지웠다면 되살리지 않는다.
    if (readLock(lockPath)?.token === token) writeLockAtomically(lockPath, { pid, token, startedAt: deps.now() });
    appendLog(logPath, deps.now(), `spawned worker pid ${pid} (index ${String(lastCommit).slice(0, 12)} -> head ${head.slice(0, 12)})`);
    return "started";
  } catch (error) {
    appendLog(logPath, deps.now(), `error: ${error instanceof Error ? error.message : String(error)}`);
    return "error";
  }
}

export function createGitNexusAutoSync(deps: AutoSyncDeps = defaultDeps) {
  return function gitnexusAutoSync(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.agent?.kind === "sub") return;
      // 기다리지 않는다. 결과와 실패는 저장소 `.gitnexus/autosync.log`에만 남는다.
      void syncGitNexusIndex(ctx.cwd, deps).catch(() => undefined);
    });
  };
}

export default createGitNexusAutoSync();
