import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

/**
 * 공용 루틴 저장소의 git 동기화. 이 서버 안의 모든 git 작업(읽기 동기화, 루틴 저장, 글 올리기)은 잠금 하나를
 * 차례로 지난다. 받기는 `pull --rebase --autostash`, 충돌로 멈춘 rebase는 되돌리고 오류로 보여 준다. 올리기가
 * 거절되면 한 번 더 받아서 다시 올리고, 그래도 안 되면(오프라인 포함) 커밋을 남겨 다음 동기화 때 올린다.
 * 강제 push는 하지 않는다.
 */

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const ERROR_LIMIT = 400;

export interface RoutineSyncState {
  syncing: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
  /** 아직 원격에 올리지 못한 커밋 수. 추적 브랜치가 없으면 null. */
  pending: number | null;
}

interface GitHolder {
  chain: Promise<unknown>;
  state: RoutineSyncState;
  lastAttemptAt: number;
}

declare global {
  var __cueloRoutineGit: GitHolder | undefined;
}

function holder(): GitHolder {
  globalThis.__cueloRoutineGit ??= {
    chain: Promise.resolve(),
    state: { syncing: false, lastSyncAt: null, lastError: null, pending: null },
    lastAttemptAt: 0,
  };
  return globalThis.__cueloRoutineGit;
}

export function getRoutineSyncState(): RoutineSyncState {
  return { ...holder().state };
}

function withGitLock<T>(task: () => Promise<T>): Promise<T> {
  const h = holder();
  const run = h.chain.then(task, task);
  h.chain = run.catch(() => undefined);
  return run;
}

function errorText(error: unknown): string {
  const failure = error as { stderr?: string; message?: string };
  const text = (failure.stderr?.trim() || failure.message || String(error)).replace(/\s+/g, " ").trim();
  return text.length > ERROR_LIMIT ? `${text.slice(0, ERROR_LIMIT)}…` : text;
}

async function git(dir: string, args: string[]): Promise<string> {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
  return (await exec("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, env })).stdout;
}

async function hasUpstream(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    return true;
  } catch {
    return false;
  }
}

async function rebaseInProgress(dir: string): Promise<boolean> {
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const path = (await git(dir, ["rev-parse", "--git-path", name])).trim();
    if (existsSync(isAbsolute(path) ? path : join(dir, path))) return true;
  }
  return false;
}

/**
 * 받아 와서 로컬 커밋을 그 위로 옮긴다. 이미 누가 rebase를 하는 중이면 손대지 않고 멈춘다(그 사람이 풀던 충돌을
 * 되돌리지 않는다). 이번 받기가 충돌로 멈춘 rebase만 되돌린다.
 */
async function pullRebase(dir: string): Promise<void> {
  if (await rebaseInProgress(dir)) throw new Error("작업 사본에서 rebase가 진행 중이라 받아 오지 않았습니다. 그 rebase를 끝내면 다시 동기화합니다.");
  try {
    await git(dir, ["pull", "--rebase", "--autostash", "--quiet"]);
  } catch (error) {
    const message = errorText(error);
    if (await rebaseInProgress(dir).catch(() => false)) {
      await git(dir, ["rebase", "--abort"]).catch(() => undefined);
      throw new Error(`받아 오기가 충돌해 되돌렸습니다: ${message}`);
    }
    throw new Error(`받아 오지 못했습니다: ${message}`);
  }
}

async function countPending(dir: string): Promise<number> {
  return Number((await git(dir, ["rev-list", "--count", "@{u}..HEAD"])).trim()) || 0;
}

async function pushPending(dir: string): Promise<void> {
  if ((await countPending(dir)) === 0) return;
  try {
    await git(dir, ["push", "--quiet"]);
  } catch {
    // 다른 PC가 먼저 올렸을 수 있다: 한 번 더 받아서 다시 올린다.
    await pullRebase(dir);
    try {
      await git(dir, ["push", "--quiet"]);
    } catch (error) {
      throw new Error(`올리지 못했습니다(커밋은 남겨 두고 다음 동기화 때 다시 올립니다): ${errorText(error)}`);
    }
  }
}

/** 받기와 올리기. 잠금 밖에서 부르면 잠금을 잡는다. 결과는 상태로만 남긴다. */
async function syncLocked(dir: string): Promise<void> {
  const h = holder();
  h.state.syncing = true;
  h.lastAttemptAt = Date.now();
  try {
    if (!(await hasUpstream(dir))) {
      h.state.pending = null;
      throw new Error("현재 브랜치에 추적하는 원격 브랜치가 없어 동기화하지 않았습니다.");
    }
    await pullRebase(dir);
    await pushPending(dir);
    h.state.lastSyncAt = new Date().toISOString();
    h.state.lastError = null;
  } catch (error) {
    h.state.lastError = error instanceof Error ? error.message : String(error);
  } finally {
    h.state.pending = await countPending(dir).catch(() => h.state.pending);
    h.state.syncing = false;
  }
}

export function syncRoutineRepo(dir: string): Promise<void> {
  return withGitLock(() => syncLocked(dir));
}

/** 화면 읽기가 부르는 백그라운드 동기화. 최근에 시도했거나 진행 중이면 건너뛴다. */
export function requestRoutineSync(dir: string, minIntervalMs = 30_000): void {
  const h = holder();
  if (h.state.syncing || Date.now() - h.lastAttemptAt < minIntervalMs) return;
  h.lastAttemptAt = Date.now();
  h.state.syncing = true;
  void syncRoutineRepo(dir);
}

async function commitIdentity(dir: string): Promise<string[]> {
  const email = await git(dir, ["config", "user.email"]).catch(() => "");
  return email.trim() ? [] : ["-c", "user.name=CUELO", "-c", "user.email=cuelo@localhost"];
}

/**
 * 받아 온 뒤 `mutate`로 파일을 바꾸고, 그 경로만 커밋해 올린다. 받기·올리기 실패는 상태에 남기고 로컬 커밋은
 * 유지한다(다음 동기화 때 올린다). 파일 변경이나 커밋 자체가 실패하면 예외를 던진다.
 */
export function commitRoutineChange<T>(dir: string, message: string, mutate: () => { paths: string[]; result: T }): Promise<T> {
  return withGitLock(async () => {
    const h = holder();
    h.state.syncing = true;
    const upstream = await hasUpstream(dir);
    let pullError: string | null = null;
    if (upstream) {
      try {
        await pullRebase(dir);
      } catch (error) {
        pullError = error instanceof Error ? error.message : String(error);
      }
    }
    try {
      // 남의 rebase 도중에 커밋하면 그 rebase에 섞인다. 그동안은 쓰지 않는다.
      if (await rebaseInProgress(dir)) throw new Error(pullError ?? "작업 사본에서 rebase가 진행 중이라 저장하지 않았습니다.");
      const { paths, result } = mutate();
      // 경로 없이 `git add -A --`를 부르면 작업 사본 전체가 담긴다. 바꾼 파일이 없으면 커밋하지 않는다.
      if (paths.length > 0) {
        await git(dir, ["add", "-A", "--", ...paths]);
        const staged = (await git(dir, ["diff", "--cached", "--name-only", "--", ...paths])).trim();
        if (staged) await git(dir, [...(await commitIdentity(dir)), "commit", "--quiet", "-m", message, "--", ...paths]);
      }
      if (upstream) {
        try {
          await pushPending(dir);
          if (!pullError) h.state.lastSyncAt = new Date().toISOString();
          h.state.lastError = pullError;
        } catch (error) {
          h.state.lastError = error instanceof Error ? error.message : String(error);
        }
      } else {
        h.state.lastError = "현재 브랜치에 추적하는 원격 브랜치가 없어 커밋만 남겼습니다.";
      }
      return result;
    } finally {
      h.state.pending = upstream ? await countPending(dir).catch(() => h.state.pending) : null;
      h.state.syncing = false;
    }
  });
}
