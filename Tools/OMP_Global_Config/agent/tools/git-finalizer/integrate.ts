/**
 * git_integrate: 세션 하나가 linked worktree의 자기 브랜치(wt/<주제>)를 게시 대상(기본 main) 위로 rebase해
 * fast-forward로 게시한다. 같은 저장소에서 여러 세션이 비슷한 파일을 고쳐도 각자 worktree에서 일하고, 합칠 때만
 * 저장소 잠금(git_finalize와 같은 이름의 mutex) 아래에서 한 줄로 선다.
 *
 * - start: fetch → rebase(자기 worktree 안에서만) → checks → 잠금 안에서 다시 fetch·push. 대상이 그새 움직였으면 다시 rebase한다.
 * - 충돌: rebase를 멈춘 채 두고 충돌 파일·양쪽 커밋 의도를 돌려준다. 세션이 파일을 고쳐 continue하거나 abort한다.
 * - source manifest(Tools/CUELO_Setup/files/source-integrity.json) 충돌은 합친 추적 내용으로 다시 만들어 자동으로 넘긴다.
 * - 잠금은 fetch와 게시 구간에만 잡는다. rebase·checks 동안 다른 세션의 git_finalize·git_integrate를 막지 않는다.
 */
import type { CustomTool, CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { vmCopyHint } from "../vm-build/hint";
import { fileURLToPath } from "node:url";
import { matchBlockedCommand } from "../../extensions/command-guard/matcher";
import { CrossReviewRefusal, DELETED_BLOB, ledgerPath, runGate, spawnExec } from "../../extensions/lib/cross-review";
import { FinalizeChecksRefusal, finalizeChecksNote, runFinalizeChecks, type FinalizeChecksResult } from "../../extensions/lib/finalize-checks";
import { SlopGateRefusal, mergeGateBlobs, runSlopGate, slopLedgerPath } from "../../extensions/lib/slop-gate";
import type { ToolApi } from "./index";
import { PublicationRefusal, publicationRefusalResult } from "./refusal";
import { isWindowsDrivePath } from "./wsl-git";
import { syncBehindUpstream } from "./sync-upstream";

const lockScriptPath = fileURLToPath(new URL("./integrate-lock.ps1", import.meta.url));
const syncCheckoutPath = fileURLToPath(new URL("./sync-checkout.ts", import.meta.url));
const powerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";
export const MANIFEST_PATH = "Tools/CUELO_Setup/files/source-integrity.json";
const HELPER_PATH = "Tools/CUELO_Setup/files/source-build-helper.js";
const RUNTIME_MANIFEST_PATH = "Tools/CUELO_Setup/files/runtime-integrity.json";
const STATE_FILE = "git-integrate.json";
/** 게시 뒤 로컬 세션 브랜치를 지운 worktree의 기록(그 git dir 안). 같은 세션이 다시 작업하면 이 이름으로 브랜치를 다시 붙인다. */
const RETIRED_FILE = "git-integrate-retired.json";
/** finalizer.ps1은 잠금을 120초 기다린다. 멈춘 호출이 그보다 오래 잡지 않도록 보유자가 100초 뒤 스스로 놓는다. */
const LOCK_MAX_HOLD_SECONDS = 100;
/** 잠금 안의 fetch·push는 보유자가 놓기 10초 전에 끊는다. 잠금이 풀린 뒤에 게시가 이어지지 않게 한다. */
const LOCKED_WORK_MS = (LOCK_MAX_HOLD_SECONDS - 10) * 1000;
const LOCK_WAIT_SECONDS = 300;
/** 게시 직전 대상이 움직여 다시 rebase하는 횟수 상한. 넘으면 rebase된 브랜치를 두고 멈춘다. */
const MAX_TARGET_MOVES = 3;
const GIT_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 30 * 60_000;
const shellArg = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

interface Run { code: number; stdout: string; stderr: string }

class IntegrateFailure extends Error {
  constructor(stage: string, detail: string) {
    super(`git_integrate failed at ${stage}: ${detail}`);
  }
}

class IntegrateRefusal extends PublicationRefusal {
  constructor(stage: string, detail: string, by = stage) {
    super(by, `git_integrate failed at ${stage}: ${detail}`, stage);
  }
}

const gitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", LC_ALL: "C",
});

function run(command: string, args: string[], cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; env?: NodeJS.ProcessEnv; group?: boolean } = {}): Promise<Run> {
  options.signal?.throwIfAborted();
  const { promise, resolve: done, reject } = Promise.withResolvers<Run>();
  const group = options.group === true && process.platform !== "win32";
  const child = spawn(command, args, { cwd, env: options.env ?? gitEnv(), stdio: ["ignore", "pipe", "pipe"], detached: group });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  // 검사 명령은 하위 프로세스를 띄우므로 프로세스 그룹째 끝낸다.
  const kill = () => {
    try {
      if (group && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL");
    } catch {} // 이미 끝난 프로세스(그룹)다(ESRCH).
  };
  let timedOut = false;
  const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, options.timeoutMs) : undefined;
  options.signal?.addEventListener("abort", kill, { once: true });
  // 이미 끊긴 신호에는 abort 이벤트가 다시 오지 않는다.
  if (options.signal?.aborted) kill();
  child.on("error", (error) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
    reject(error);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
    if (options.signal?.aborted) reject(options.signal.reason);
    else if (timedOut) reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`));
    else done({ code: code ?? (signal ? 128 : 1), stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
  });
  return promise;
}

interface Repo {
  root: string;
  gitDir: string;
  commonDir: string;
  statePath: string;
  signal?: AbortSignal;
}

async function git(repo: Repo, args: string[]): Promise<Run> {
  // fetch·push는 전송 하위 프로세스(upload-pack·ssh)를 띄운다. 끊을 때 그룹째 끝내야 그 출력 파이프가 닫혀 호출이 바로 돌아온다.
  return run("git", args, repo.root, { signal: repo.signal, timeoutMs: GIT_TIMEOUT_MS, group: true });
}

async function gitOk(repo: Repo, stage: string, args: string[]): Promise<string> {
  const out = await git(repo, args);
  if (out.code !== 0) throw new IntegrateFailure(stage, `git ${args.join(" ")} exited ${out.code}: ${(out.stderr || out.stdout).trim()}`);
  return out.stdout.trim();
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  });
}

/** git이 돌려준 두 디렉터리가 같은가(끝 구분자 무시, Windows는 대소문자 무시). */
function samePath(a: string, b: string): boolean {
  const [left, right] = [a, b].map((path) => path.replace(/[\\/]+$/, ""));
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function openRepo(cwd: string, signal?: AbortSignal): Promise<Repo> {
  const probe = (args: string[]) => run("git", args, cwd, { signal, timeoutMs: GIT_TIMEOUT_MS });
  const top = await probe(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) {
    const detail = `${cwd} is not inside a git work tree: ${top.stderr.trim()}`;
    if (top.stderr.includes("not a git repository")) throw new IntegrateRefusal("preflight", detail, "repository");
    throw new IntegrateFailure("preflight", detail);
  }
  const root = top.stdout.trim();
  const repo: Repo = { root, gitDir: "", commonDir: "", statePath: "", signal };
  repo.gitDir = await gitOk(repo, "preflight", ["rev-parse", "--absolute-git-dir"]);
  repo.commonDir = await gitOk(repo, "preflight", ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  // WSL의 /mnt 저장소는 git_finalize가 Windows PowerShell(Global\ mutex)로 잠근다. Linux pwsh 잠금과 겹치지 않으므로 받지 않는다.
  if (isWindowsDrivePath(root) || isWindowsDrivePath(repo.commonDir)) {
    throw new IntegrateRefusal("preflight", "repositories on a Windows drive (/mnt/<drive>) are not supported; git_finalize locks them through Windows PowerShell, which this tool cannot share.", "repository");
  }
  if (samePath(repo.gitDir, repo.commonDir)) {
    throw new IntegrateRefusal("preflight", `${root} is the repository's main checkout. git_integrate runs only in a linked worktree on the session's own branch (create one from the CUELO sidebar); the main checkout publishes with git_finalize.`, "repository");
  }
  repo.statePath = resolve(root, await gitOk(repo, "preflight", ["rev-parse", "--git-path", STATE_FILE]));
  return repo;
}

async function rebaseInProgress(repo: Repo): Promise<boolean> {
  return (await exists(join(repo.gitDir, "rebase-merge"))) || (await exists(join(repo.gitDir, "rebase-apply")));
}

async function readRebaseHead(repo: Repo): Promise<string> {
  let name: string;
  try {
    name = await readFile(join(repo.gitDir, "rebase-merge", "head-name"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(await exists(join(repo.gitDir, "rebase-apply")))) throw error;
    name = await readFile(join(repo.gitDir, "rebase-apply", "head-name"), "utf8");
  }
  if (!name.trim()) throw new IntegrateFailure("preflight", "the paused rebase has an empty head-name");
  return name.trim();
}

async function resolveRemote(repo: Repo, branch: string): Promise<string> {
  const configured = (await git(repo, ["config", "--get", `branch.${branch}.remote`])).stdout.trim();
  if (configured === ".") throw new IntegrateRefusal("preflight", `branch ${branch} tracks the local repository and has no pushable remote.`, "repository");
  if (configured) return configured;
  const remotes = (await gitOk(repo, "preflight", ["remote"])).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (remotes.includes("origin")) return "origin";
  if (remotes.length === 1) return remotes[0];
  throw new IntegrateRefusal("preflight", remotes.length === 0 ? "the repository has no remote." : `branch ${branch} has no tracked remote and the repository has several: ${remotes.join(", ")}.`, "repository");
}

interface State {
  version: 1;
  branch: string;
  origHead: string;
  remote: string;
  target: string;
  oldBase: string;
  onto: string;
  previousTarget: string;
  checks: string[];
  moves: number;
  /** 지금 멈춘 rebase 단계에서 충돌했거나 세션이 푼 경로. continue가 충돌 표시를 보고 게이트에 넘긴다. */
  pending: string[];
  /** 이 단계가 멈췄을 때 index가 HEAD와 다르던 경로와 그 blob. continue는 그 뒤 stage가 바뀐 경로도 푼 것으로 본다. */
  stagedAtStop: Record<string, string>;
  /** 지금 단계에서 source manifest가 충돌했다. continue가 rebase를 잇기 직전에 다시 만든다. */
  pendingManifest: boolean;
}

/** index가 HEAD와 다른 경로와 그 index blob. 충돌 중인 경로는 "unmerged"다. */
async function stagedBlobs(repo: Repo): Promise<Record<string, string>> {
  const parts = (await gitOk(repo, "conflict", ["diff", "--cached", "--raw", "-z", "--no-renames", "--no-abbrev", "HEAD"])).split("\0");
  const blobs: Record<string, string> = {};
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index].split(" ");
    if (meta.length < 5) continue;
    blobs[parts[index + 1]] = meta[4].startsWith("U") ? "unmerged" : meta[3];
  }
  return blobs;
}

/** 남은 충돌 표시가 있는 경로. 표시 길이는 경로마다 `conflict-marker-size` 속성을 따른다(기본 7). */
async function pathsWithMarkers(repo: Repo, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const attrs = (await gitOk(repo, "conflict", ["check-attr", "-z", "conflict-marker-size", "--", ...paths])).split("\0");
  const size = new Map<string, number>();
  for (let index = 0; index + 2 < attrs.length; index += 3) {
    const value = Number.parseInt(attrs[index + 2], 10);
    size.set(attrs[index], Number.isInteger(value) && value > 0 ? value : 7);
  }
  const marked: string[] = [];
  for (const path of paths) {
    const text = await readFile(join(repo.root, ...path.split("/")), "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR" && error.code !== "EISDIR") throw error;
      return undefined;
    });
    const n = size.get(path) ?? 7;
    if (text !== undefined && new RegExp(`^(?:<{${n}}|>{${n}}|\\|{${n}})(?: |$)`, "m").test(text)) marked.push(path);
  }
  return marked;
}

async function readState(repo: Repo, allowCorrupt = false): Promise<State | undefined> {
  const raw = await readFile(repo.statePath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (raw === undefined) return undefined;
  try {
    const state = JSON.parse(raw) as State;
    if (state?.version === 1) return state;
    throw new IntegrateFailure("preflight", `unsupported paused state at ${repo.statePath}`);
  } catch (error) {
    if (allowCorrupt && error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const saveState = (repo: Repo, state: State) => writeFile(repo.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
const clearState = (repo: Repo) => rm(repo.statePath, { force: true });

/**
 * integrate-lock.ps1을 띄워 finalizer와 같은 mutex를 잡는다. `release`가 놓는다. 부모가 죽으면 입력이 닫혀 보유자가 놓는다.
 * `lost`는 놓기 전에 보유자가 끝났을 때(상한 초과·외부 종료) 끊긴다.
 */
async function acquireLock(repo: Repo, remote: string, upstreamRef: string): Promise<{ release: () => Promise<void>; lost: AbortSignal }> {
  repo.signal?.throwIfAborted();
  const child = spawn(powerShell, [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", lockScriptPath, "-Repository", repo.root, "-Remote", remote,
    "-UpstreamRef", upstreamRef, "-WaitSeconds", String(LOCK_WAIT_SECONDS), "-MaxHoldSeconds", String(LOCK_MAX_HOLD_SECONDS),
  ], { cwd: repo.root, env: gitEnv(), stdio: ["pipe", "pipe", "pipe"] });
  const kill = () => child.kill("SIGKILL");
  repo.signal?.addEventListener("abort", kill, { once: true });
  if (repo.signal?.aborted) kill();
  const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
  const lost = new AbortController();
  let releasing = false;
  child.on("close", () => {
    if (!releasing) lost.abort();
    markClosed();
  });
  // 보유자가 먼저 끝났으면 입력을 닫을 때 EPIPE가 난다. 보유자가 없어진 것이므로 잠금을 잃은 것으로 본다.
  child.stdin.on("error", () => lost.abort());
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const { promise: firstLine, resolve: gotLine } = Promise.withResolvers<string>();
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    const end = buffer.indexOf("\n");
    if (end >= 0) gotLine(buffer.slice(0, end));
  });
  child.on("close", () => gotLine(buffer));
  child.on("error", (error) => gotLine(JSON.stringify({ locked: false, error: error.message })));
  const first = await firstLine;
  let reply: { locked?: boolean; error?: string } | undefined;
  try { reply = JSON.parse(first.trim()); } catch {}
  if (reply?.locked !== true || repo.signal?.aborted) {
    kill();
    repo.signal?.removeEventListener("abort", kill);
    await closed;
    repo.signal?.throwIfAborted();
    throw new IntegrateFailure("lock", reply?.error || stderr.trim() || first.trim() || "the lock holder exited without a reply");
  }
  const release = async () => {
    releasing = true;
    repo.signal?.removeEventListener("abort", kill);
    child.stdin.end();
    const timer = setTimeout(kill, 10_000);
    await closed;
    clearTimeout(timer);
  };
  return { release, lost: lost.signal };
}

/**
 * 잠금 안에서 body를 돌린다. body가 받는 Repo의 git 호출은 보유자가 놓기 전(LOCKED_WORK_MS)이나 보유자가 먼저 끝나면 끊긴다.
 * 그래서 잠금이 풀린 뒤에 fetch·push가 이어지지 않는다. 끝까지 마친 body의 결과는 그대로 쓴다(push는 force가 아니어서
 * 잠금 없이도 다른 세션의 커밋을 덮지 못한다).
 */
async function withLock<T>(repo: Repo, remote: string, upstreamRef: string, body: (locked: Repo) => Promise<T>): Promise<T> {
  const lock = await acquireLock(repo, remote, upstreamRef);
  const deadline = AbortSignal.timeout(LOCKED_WORK_MS);
  const signal = AbortSignal.any([deadline, lock.lost, ...(repo.signal ? [repo.signal] : [])]);
  try {
    return await body({ ...repo, signal });
  } catch (error) {
    if (!repo.signal?.aborted && (deadline.aborted || lock.lost.aborted)) {
      const why = deadline.aborted ? `the work under the repository lock ran past ${LOCKED_WORK_MS / 1000}s` : "the lock holder exited early";
      throw new IntegrateFailure("lock", `${why} and was stopped; a push already in flight may or may not have reached ${remote} ${upstreamRef}. Call git_integrate again (it starts from the remote state). ${error instanceof Error ? error.message : String(error)}`);
    }
    throw error;
  } finally {
    await lock.release();
  }
}

async function fetchTarget(repo: Repo, state: Pick<State, "remote" | "target">): Promise<string> {
  await gitOk(repo, "fetch", ["fetch", "--no-tags", state.remote, `refs/heads/${state.target}`]);
  return gitOk(repo, "fetch", ["rev-parse", "FETCH_HEAD"]);
}

const isAncestor = async (repo: Repo, older: string, newer: string) => (await git(repo, ["merge-base", "--is-ancestor", older, newer])).code === 0;

/** 충돌한 경로와 그 종류. rebase 중 stage 2는 대상(onto) 쪽, stage 3은 다시 얹는 세션 커밋 쪽이다. */
async function unmergedPaths(repo: Repo): Promise<Map<string, string>> {
  const out = await gitOk(repo, "conflict", ["ls-files", "-u", "-z"]);
  const stages = new Map<string, Set<string>>();
  for (const entry of out.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const path = entry.slice(tab + 1);
    const stage = entry.slice(0, tab).split(" ")[2];
    if (!stages.has(path)) stages.set(path, new Set());
    stages.get(path)!.add(stage);
  }
  const kinds = new Map<string, string>();
  for (const [path, set] of stages) {
    const has = (stage: string) => set.has(stage);
    kinds.set(path, has("2") && has("3") ? (has("1") ? "both-modified" : "both-added")
      : has("2") ? (has("1") ? "deleted-by-session" : "added-by-target")
      : has("1") ? "deleted-by-target" : "added-by-session");
  }
  return kinds;
}

/**
 * source manifest를 합친 추적 내용으로 다시 만든다. helper의 create-manifest는 작업 폴더의 바이트를 해시하므로 작업 폴더에서 돌리면
 * 추적하지 않는 파일·덜 정리된 변경이 섞일 수 있다. 그래서 index(충돌을 푼 내용)를 임시 폴더로 꺼내 그 트리에서 만든다.
 * 다른 경로의 충돌이 남아 있으면 부르지 않는다(호출자가 확인한다).
 */
async function regenerateManifest(repo: Repo): Promise<void> {
  // manifest 자리의 충돌 단계를 하나로 접는다. 내용은 곧 새로 만든 것으로 바꾼다.
  await gitOk(repo, "manifest", ["add", "--", MANIFEST_PATH]);
  const tree = await mkdtemp(join(tmpdir(), "omp-git-integrate-tree-"));
  const outDir = await mkdtemp(join(tmpdir(), "omp-git-integrate-manifest-"));
  try {
    await gitOk(repo, "manifest", ["checkout-index", "-a", "-f", `--prefix=${tree}/`]);
    const output = join(outDir, "source-integrity.json");
    const helper = join(tree, ...HELPER_PATH.split("/"));
    const made = await run("node", [helper, "create-manifest", tree, join(tree, ...RUNTIME_MANIFEST_PATH.split("/")), "--output", output],
      join(tree, "Tools", "CUELO_Setup"), { signal: repo.signal, timeoutMs: GIT_TIMEOUT_MS, env: process.env });
    if (made.code !== 0) throw new IntegrateFailure("manifest", `source manifest regeneration exited ${made.code}: ${(made.stderr || made.stdout).trim()}`);
    await copyFile(output, join(repo.root, ...MANIFEST_PATH.split("/")));
    await gitOk(repo, "manifest", ["add", "--", MANIFEST_PATH]);
  } finally {
    await Promise.all([rm(tree, { recursive: true, force: true }), rm(outDir, { recursive: true, force: true })]);
  }
}

interface StepResult { done: true } 
interface ConflictStop { done: false; conflicts: Map<string, string> }

/**
 * 멈춘 rebase를 끝까지 잇는다. manifest만 남은 충돌은 다시 만들어 넘기고, 세션이 풀어야 할 충돌이 나오면 멈춘다.
 * 이미 푼 단계는 호출자가 stage·게이트를 마친 뒤 `rebase --continue` 한 번을 맡긴다.
 */
async function driveRebase(repo: Repo, state: State, first: "continue" | "inspect"): Promise<StepResult | ConflictStop> {
  let step: "continue" | "inspect" = first;
  for (;;) {
    if (step === "continue") {
      // 푼 결과가 새 기준과 같으면(대상에 이미 들어간 변경) 그 커밋은 비었다. git은 continue를 거절하므로 건너뛴다.
      const empty = (await git(repo, ["diff", "--cached", "--quiet", "HEAD"])).code === 0;
      const rebaseHead = ["rev-parse", "-q", "--verify", "REBASE_HEAD"];
      const before = (await git(repo, rebaseHead)).stdout.trim();
      const next = await git(repo, ["-c", "core.editor=true", "rebase", empty ? "--skip" : "--continue"]);
      if (!(await rebaseInProgress(repo))) {
        if (next.code !== 0) throw new IntegrateFailure("rebase", `git rebase ended with ${next.code}: ${(next.stderr || next.stdout).trim()}`);
        return { done: true };
      }
      if ((await git(repo, rebaseHead)).stdout.trim() === before && (await unmergedPaths(repo)).size === 0) {
        throw new IntegrateFailure("rebase", `git rebase could not continue (exit ${next.code}); the resolved step is still staged: ${(next.stderr || next.stdout).trim()}`);
      }
      state.pending = [];
      state.pendingManifest = false;
    }
    const conflicts = await unmergedPaths(repo);
    if (conflicts.has(MANIFEST_PATH) && (await exists(join(repo.root, ...HELPER_PATH.split("/"))))) {
      state.pendingManifest = true;
      if (conflicts.size === 1) {
        await regenerateManifest(repo);
        await saveState(repo, state);
        step = "continue";
        continue;
      }
      conflicts.delete(MANIFEST_PATH);
    }
    if (conflicts.size === 0) {
      await saveState(repo, state);
      throw new IntegrateFailure("rebase", "git rebase stopped without conflicts; inspect the worktree, then call git_integrate with action abort.");
    }
    // 멈춘 자리의 충돌 경로와 index를 남긴다. 세션이 continue 전에 직접 stage해도 continue가 그 경로를 놓치지 않는다.
    state.pending = [...conflicts.keys()];
    state.stagedAtStop = await stagedBlobs(repo);
    await saveState(repo, state);
    return { done: false, conflicts };
  }
}

/** 대상 위로 rebase를 시작한다. 시작조차 못 하면(덮어쓸 추적 안 된 파일 등) 되돌리고 상태를 지운 뒤 실패로 알린다. */
async function startRebase(repo: Repo, state: State, onto: string): Promise<StepResult | ConflictStop> {
  state.oldBase = await gitOk(repo, "rebase", ["merge-base", "HEAD", onto]);
  state.onto = onto;
  state.pending = [];
  state.pendingManifest = false;
  await saveState(repo, state);
  // 백엔드를 merge로 정한다(설정 rebase.backend=apply면 멈춘 상태가 rebase-apply에 남아 이 도구가 읽는 자리와 다르다).
  const rebased = await git(repo, ["-c", "core.editor=true", "rebase", "--merge", "--no-autosquash", "--no-autostash", "--no-update-refs", onto]);
  if (rebased.code === 0 && !(await rebaseInProgress(repo))) return { done: true };
  if ((await rebaseInProgress(repo)) && (await unmergedPaths(repo)).size > 0) return driveRebase(repo, state, "inspect");
  if (await rebaseInProgress(repo)) await git(repo, ["rebase", "--abort"]);
  const head = await gitOk(repo, "rebase", ["rev-parse", "HEAD"]);
  await clearState(repo);
  throw new IntegrateFailure("rebase", `git rebase onto ${onto} failed (exit ${rebased.code}) and was rolled back${head === state.origHead ? "" : ` (HEAD is ${head}, expected ${state.origHead})`}: ${(rebased.stderr || rebased.stdout).trim()}`);
}

async function conflictResult(repo: Repo, state: State, conflicts: Map<string, string>) {
  const paths = [...conflicts.keys()];
  const shown = await gitOk(repo, "conflict", ["show", "-s", "--format=%H%x00%s%x00%b", "REBASE_HEAD"]);
  const [sha, subject, body] = shown.split("\0");
  const log = await gitOk(repo, "conflict", ["log", "-n", "20", "--format=%H%x00%s", `${state.oldBase}..${state.onto}`, "--", ...paths]);
  const targetCommits = log.split("\n").filter(Boolean).map((line) => {
    const [targetSha, targetSubject] = line.split("\0");
    return { sha: targetSha, subject: targetSubject };
  });
  const read = async (name: string) => Number((await readFile(join(repo.gitDir, "rebase-merge", name), "utf8").catch(() => "")).trim()) || undefined;
  const step = { current: await read("msgnum"), total: await read("end") };
  const lines = [
    `git_integrate stopped on a conflict while replaying ${state.branch} onto ${state.remote} refs/heads/${state.target} (commit ${step.current ?? "?"} of ${step.total ?? "?"}). Nothing was pushed; the rebase is paused in this worktree.`,
    "Conflicted paths:",
    ...paths.map((path) => `- ${path} (${conflicts.get(path)})`),
    `Session commit being replayed: ${sha.slice(0, 12)} ${subject}${body?.trim() ? `\n  ${body.trim().replace(/\n/g, "\n  ")}` : ""}`,
    targetCommits.length > 0 ? `Target commits since the old base that touch these paths:\n${targetCommits.map((commit) => `- ${commit.sha.slice(0, 12)} ${commit.subject}`).join("\n")}` : "No target commit since the old base touches these paths by name.",
    ...(state.pendingManifest ? [`${MANIFEST_PATH} also conflicted; it is regenerated from the resolved content on continue.`] : []),
    "Next: edit each conflicted file so it keeps both intents and has no conflict markers. Rewrite shared notes (HANDOFF.md, doc/README.md, CHANGELOG.md) for the combined state rather than keeping both texts. Run the cross_review/slop_check the resolved files need, then call git_integrate with action continue. To give up, call git_integrate with action abort. Do not run git rebase, merge, add or commit yourself.",
  ];
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      ok: false, stage: "conflict", branch: state.branch, remote: state.remote, upstreamRef: `refs/heads/${state.target}`,
      conflicts: paths.map((path) => ({ path, kind: conflicts.get(path) })), replaying: { sha, subject, body: body?.trim() ?? "" },
      targetCommits, step, manifestRegenerates: state.pendingManifest,
    },
  };
}

function screenChecks(checks: string[], root: string): void {
  for (const command of checks) {
    if (!command.trim()) throw new IntegrateRefusal("preflight", "checks must not contain an empty command.", "finalize-checks");
    const reason = matchBlockedCommand(command, { cwd: root, isSessionRepository: () => true });
    if (reason) throw new IntegrateRefusal("preflight", `check command refused by the command guard: ${command} (${reason})`, "command-guard");
  }
}

async function runChecks(repo: Repo, checks: string[]): Promise<{ command: string; seconds: number }[]> {
  const ran: { command: string; seconds: number }[] = [];
  for (const command of checks) {
    const started = performance.now();
    const [shell, args] = process.platform === "win32" ? [powerShell, ["-NoProfile", "-Command", command]] : ["bash", ["-c", command]];
    const out = await run(shell, args, repo.root, { signal: repo.signal, timeoutMs: CHECK_TIMEOUT_MS, env: process.env, group: true });
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    if (out.code !== 0) {
      const tail = `${out.stdout}${out.stderr ? `\n${out.stderr}` : ""}`.trim().split(/\r?\n/).slice(-30).join("\n").slice(-4000);
      throw new IntegrateFailure("checks", `\`${command}\` exited ${out.code} after ${seconds}s on the rebased branch; nothing was pushed. Fix it with a new commit on this branch (git_finalize), then call git_integrate again.\n${tail}`);
    }
    ran.push({ command, seconds });
  }
  return ran;
}

/**
 * rebase로 바뀐 세션 브랜치를 그 원격 브랜치(git_finalize가 게시한 upstream)에도 맞춘다. 다음 git_finalize의 ancestry 확인이
 * 옛 원격 tip 때문에 막히지 않게 하려는 것이다. 원격 tip이 시작 때 HEAD의 조상일 때만(=세션이 올린 것뿐일 때만) lease로 바꾼다.
 */
async function syncSessionBranch(repo: Repo, state: State, tip: string): Promise<string> {
  // 세션 브랜치 자신의 원격 사본(같은 이름, git_finalize가 처음 push하며 거는 upstream)만 맞춘다. 다른 브랜치를 따라가면 손대지 않는다.
  const own = `refs/heads/${state.branch}`;
  const merge = (await git(repo, ["config", "--get", `branch.${state.branch}.merge`])).stdout.trim();
  if (merge !== own) return merge ? `the session branch tracks ${merge}, not its own ${own}; left unchanged` : "the session branch has no upstream";
  const head = await gitOk(repo, "branch-sync", ["rev-parse", "HEAD"]);
  if (head !== tip) return `HEAD is ${head}, not the rebased ${tip}; the remote copy was left unchanged`;
  const branchRemote = (await git(repo, ["config", "--get", `branch.${state.branch}.remote`])).stdout.trim() || state.remote;
  const line = await git(repo, ["ls-remote", "--refs", branchRemote, merge]);
  const remoteSha = line.stdout.trim().split(/\s+/)[0] ?? "";
  if (line.code !== 0 || !remoteSha) return `${branchRemote} ${merge} was not found`;
  if (remoteSha === head) return `${branchRemote} ${merge} already matches`;
  if (!(await isAncestor(repo, remoteSha, state.origHead))) return `${branchRemote} ${merge} has commits this worktree did not start from; left unchanged`;
  const pushed = await git(repo, ["push", `--force-with-lease=${merge}:${remoteSha}`, branchRemote, `${head}:${merge}`]);
  return pushed.code === 0 ? `updated ${branchRemote} ${merge} to ${head}` : `could not update ${branchRemote} ${merge}: ${(pushed.stderr || pushed.stdout).trim()}`;
}

/** 게시 뒤 지우는 세션 브랜치: `wt/<topic>`이되 아침 보고가 읽는 야간 브랜치(`wt/nightly-*`, 보통 `wt/nightly-YYYYMMDD`)는 뺀다. */
const retirableBranch = (branch: string) => branch.startsWith("wt/") && !branch.startsWith("wt/nightly-");

/**
 * 대상에 게시를 마친 `wt/<topic>` 세션 브랜치의 원격 사본을 지운다(2026-11-06 사용자 결정: 병합된 원격 `wt/*`가 게시마다 하나씩
 * 남았다). `wt/nightly-YYYYMMDD`는 각 PC의 아침 보고가 읽으므로 야간 정리의 보존 기간에 맡기고 지금처럼 맞추기만 한다. 원격 tip이
 * 이 worktree가 시작한 HEAD나 게시한 커밋의 조상일 때만(=다른 곳에서 올린 커밋이 없을 때만) lease를 걸고 지운다.
 * `gone`은 원격 사본이 이제 없는가(지웠거나 처음부터 없었다)다. 로컬 브랜치는 그때만 정리한다.
 */
async function retireSessionBranch(repo: Repo, state: State, pushed: string): Promise<{ note: string; gone: boolean }> {
  if (!retirableBranch(state.branch)) return { note: await syncSessionBranch(repo, state, pushed), gone: false };
  const own = `refs/heads/${state.branch}`;
  const merge = (await git(repo, ["config", "--get", `branch.${state.branch}.merge`])).stdout.trim();
  if (merge && merge !== own) return { note: `the session branch tracks ${merge}, not its own ${own}; left unchanged`, gone: false };
  if (!merge) {
    // upstream 없이 같은 이름으로 올려 둔 사본은 이 worktree의 것인지 모르므로 지우지 않는다(로컬도 남긴다).
    const probe = await git(repo, ["ls-remote", "--refs", state.remote, own]);
    const absent = probe.code === 0 && !probe.stdout.trim();
    return { note: absent ? "the session branch has no upstream and no remote copy" : `the session branch has no upstream; ${state.remote} ${own} was left unchanged`, gone: absent };
  }
  const branchRemote = (await git(repo, ["config", "--get", `branch.${state.branch}.remote`])).stdout.trim() || state.remote;
  const line = await git(repo, ["ls-remote", "--refs", branchRemote, merge]);
  const remoteSha = line.stdout.trim().split(/\s+/)[0] ?? "";
  if (line.code !== 0) return { note: `could not read ${branchRemote} ${merge}: ${(line.stderr || line.stdout).trim()}`, gone: false };
  if (!remoteSha) return { note: `${branchRemote} ${merge} was not found`, gone: true };
  if (!(await isAncestor(repo, remoteSha, pushed)) && !(await isAncestor(repo, remoteSha, state.origHead))) {
    return { note: `${branchRemote} ${merge} has commits this worktree did not start from; left unchanged`, gone: false };
  }
  const deleted = await git(repo, ["push", `--force-with-lease=${merge}:${remoteSha}`, branchRemote, `:${merge}`]);
  return deleted.code === 0
    ? { note: `deleted ${branchRemote} ${merge} (its work is in ${state.target})`, gone: true }
    : { note: `could not delete ${branchRemote} ${merge}: ${(deleted.stderr || deleted.stdout).trim()}`, gone: false };
}

interface Retired { branch: string; tip: string }

const retiredPath = async (cwd: string, signal?: AbortSignal) => {
  const out = await run("git", ["rev-parse", "--path-format=absolute", "--git-path", RETIRED_FILE], cwd, { signal, timeoutMs: GIT_TIMEOUT_MS });
  return out.code === 0 ? out.stdout.trim() : undefined;
};

/**
 * 원격 사본이 없어진 세션 브랜치의 로컬 브랜치도 지운다(2026-11-14 사용자 요구 「메인에합치고 원격정리하면 로컬브랜치도같이안보이게」:
 * GitHub Desktop이 로컬 브랜치를 모두 보여 줘 끝난 wt 브랜치가 남았다). 세션은 이 worktree에서 계속 돌 수 있으므로 폴더는 두고
 * HEAD만 떼어 낸다. `git branch -d`는 쓰지 않는다: upstream이 지워진 뒤에는 HEAD를 기준으로 병합 여부를 보는데 떼어 낸 HEAD가 곧
 * 그 tip이라 늘 통과하고, `branch.<이름>.*` 설정(CUELO 자동 worktree의 정리 소유 기록 포함)까지 지운다. 그래서 tip이 게시한 커밋의
 * 조상인지 직접 보고, 그 tip일 때만 ref를 지운다(`update-ref -d <ref> <tip>`). 설정은 남아 다시 붙일 때와 CUELO 정리가 쓴다.
 */
async function retireLocalBranch(repo: Repo, state: State, pushed: string): Promise<string> {
  const ref = `refs/heads/${state.branch}`;
  if ((await git(repo, ["symbolic-ref", "-q", "HEAD"])).stdout.trim() !== ref) return `the local branch was kept: HEAD is not on ${state.branch}`;
  const tip = await gitOk(repo, "branch-retire", ["rev-parse", ref]);
  if (!(await isAncestor(repo, tip, pushed))) return `the local branch was kept: ${state.branch} (${tip}) has commits that are not in ${state.target}`;
  const marker = await retiredPath(repo.root, repo.signal);
  if (!marker) return "the local branch was kept: the worktree's git path could not be resolved";
  // 다시 붙일 단서를 먼저 남긴다. 그 뒤 단계가 실패하면 브랜치로 되돌리고 기록을 지운다.
  try {
    await writeFile(marker, `${JSON.stringify({ branch: state.branch, tip } satisfies Retired)}\n`, "utf8");
  } catch (error) {
    return `the local branch was kept: could not write ${marker}: ${error instanceof Error ? error.message : String(error)}`;
  }
  // 같은 커밋에서 HEAD만 떼고 붙이므로 작업 트리·index는 그대로다. checkout 대신 hook을 돌리지 않는 plumbing을 써서, hook 실패가
  // "HEAD가 바뀌었는데 실패로 보이는" 상태를 만들지 않게 한다(종료 코드가 곧 HEAD·ref의 상태다).
  const detached = await git(repo, ["update-ref", "--no-deref", "-m", "git_integrate: detach after publishing", "HEAD", tip]);
  if (detached.code !== 0) {
    await rm(marker, { force: true });
    return `the local branch was kept: git update-ref --no-deref HEAD exited ${detached.code}: ${(detached.stderr || detached.stdout).trim()}`;
  }
  const deleted = await git(repo, ["update-ref", "-d", ref, tip]);
  if (deleted.code !== 0) {
    const back = await git(repo, ["symbolic-ref", "-m", "git_integrate: keep the session branch", "HEAD", ref]);
    if (back.code === 0) await rm(marker, { force: true });
    return `the local branch was kept: git update-ref -d exited ${deleted.code}: ${(deleted.stderr || deleted.stdout).trim()}`
      + (back.code === 0 ? "" : `; HEAD stays detached at ${tip} and git_finalize or git_integrate re-attaches ${state.branch}`);
  }
  return `removed the local branch ${state.branch}; this worktree stays at ${tip} with a detached HEAD (git_finalize and git_integrate re-create the branch here when you continue)`;
}

/**
 * git_integrate가 로컬 세션 브랜치를 지운 worktree에서 다시 작업하면 같은 이름의 브랜치를 HEAD에 다시 만든다(작업 파일은 그대로).
 * HEAD가 떼어 낸 tip에서 이어진 경우만이다. 브랜치에 있거나 기록이 없으면 아무것도 하지 않는다(`none`). `unchanged`는 HEAD가 그
 * tip 그대로여서(=게시할 새 커밋이 없다) `keepWhenUnchanged`로 다시 만들지 않은 경우다.
 */
export async function reattachRetiredBranch(cwd: string, options: { signal?: AbortSignal; keepWhenUnchanged?: boolean } = {}): Promise<{ status: "none" | "attached" | "unchanged" | "blocked"; note?: string; branch?: string }> {
  const probe = (args: string[]) => run("git", args, cwd, { signal: options.signal, timeoutMs: GIT_TIMEOUT_MS });
  const branchStatus = await probe(["symbolic-ref", "-q", "HEAD"]);
  if (branchStatus.code === 0) return { status: "none" };
  if (branchStatus.code !== 1) throw new IntegrateFailure("branch-reattach", branchStatus.stderr.trim() || `git symbolic-ref exited ${branchStatus.code}`);
  const marker = await retiredPath(cwd, options.signal);
  if (!marker) throw new IntegrateFailure("branch-reattach", "could not resolve the retired branch record path");
  const raw = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (raw === undefined) return { status: "none" };
  const recorded = JSON.parse(raw) as Retired;
  if (typeof recorded?.branch !== "string" || typeof recorded.tip !== "string") {
    throw new IntegrateFailure("branch-reattach", `invalid retired branch record at ${marker}`);
  }
  const { branch, tip } = recorded;
  if (!branch.startsWith("wt/") || (await probe(["check-ref-format", "--branch", branch])).code !== 0) return { status: "blocked", note: `the retired branch record names ${JSON.stringify(branch)}; HEAD was left detached` };
  const current = await probe(["rev-parse", "--verify", "HEAD"]);
  if (current.code !== 0) throw new IntegrateFailure("branch-reattach", current.stderr.trim() || `git rev-parse exited ${current.code}`);
  const head = current.stdout.trim();
  if (head === tip && options.keepWhenUnchanged) return { status: "unchanged", branch, note: `HEAD is still the retired ${branch} tip ${tip}, which is already published` };
  const ancestry = await probe(["merge-base", "--is-ancestor", tip, head]);
  if (ancestry.code === 1) return { status: "blocked", branch, note: `HEAD ${head} does not continue the retired ${branch} tip ${tip}; check out a branch first` };
  if (ancestry.code !== 0) throw new IntegrateFailure("branch-reattach", ancestry.stderr.trim() || `git merge-base exited ${ancestry.code}`);
  // 작업 파일과 index는 그대로 두고 ref만 만든다. 빈 옛 값은 "아직 없을 때만 만든다"이고, HEAD 붙이기도 hook을 돌리지 않는다.
  options.signal?.throwIfAborted();
  const update = (args: string[]) => run("git", args, cwd, { timeoutMs: GIT_TIMEOUT_MS });
  const created = await update(["update-ref", "-m", "git_integrate: re-create the retired session branch", `refs/heads/${branch}`, head, ""]);
  if (created.code !== 0) throw new IntegrateFailure("branch-reattach", `could not re-create ${branch}: ${(created.stderr || created.stdout).trim()}`);
  const attached = await update(["symbolic-ref", "-m", "git_integrate: re-attach the session branch", "HEAD", `refs/heads/${branch}`]);
  if (attached.code !== 0) {
    const undone = await update(["update-ref", "-d", `refs/heads/${branch}`, head]);
    throw new IntegrateFailure("branch-reattach", `could not attach HEAD to ${branch}: ${(attached.stderr || attached.stdout).trim()}`
      + (undone.code === 0 ? "; the new branch was rolled back" : `; could not roll back ${branch} at ${head}: ${(undone.stderr || undone.stdout).trim()}`));
  }
  await rm(marker, { force: true });
  options.signal?.throwIfAborted();
  return { status: "attached", branch, note: `re-created ${branch} at ${head} (git_integrate had removed it after publishing)` };
}

/**
 * 게시한 뒤 메인 체크아웃이 같은 대상 브랜치에 있으면 git_finalize 앞단과 같은 방식(뒤처지기만 했을 때 fast-forward, 겹치는
 * 커밋 안 한 수정은 충돌 없을 때만 3-way)으로 따라가게 한다(2026-11-14 사용자 목표: 합친 뒤 메인 체크아웃이 main을 받는다).
 * 다른 브랜치·분리된 HEAD·갈라진 이력이면 건드리지 않고 그 이유만 돌려준다.
 */
async function followMainCheckout(repo: Repo, state: State): Promise<string> {
  // -z: 탭·줄바꿈 같은 문자가 든 경로를 git이 따옴표로 감싸 바꾸지 않게 NUL 구분 출력으로 읽는다. 첫 빈 필드까지가 첫 항목(메인 체크아웃)이다.
  const listed = await git(repo, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0) return `could not list worktrees: ${(listed.stderr || listed.stdout).trim()}`;
  const fields = listed.stdout.split("\0");
  const main = fields.slice(0, Math.max(0, fields.indexOf("")));
  const path = main.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
  if (!path || main.includes("bare")) return "the repository has no main checkout";
  const branch = main.find((field) => field.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length);
  if (branch !== state.target) return `${path} is on ${branch ?? "a detached HEAD"}, not ${state.target}; left unchanged`;
  const sync = await syncBehindUpstream(spawnExec(), "git", path);
  if (sync.pulled === 0) return `${path}: ${sync.note ?? "already up to date"}`;
  return `fast-forwarded ${path} by ${sync.pulled} commit(s)` + (sync.merged.length ? `; merged uncommitted edits in ${sync.merged.join(", ")}` : "");
}

async function ensureCleanTracked(repo: Repo, stage: string): Promise<void> {
  const dirty = await gitOk(repo, stage, ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=no"]);
  if (!dirty) return;
  const detail = `tracked changes are present:\n${dirty}`;
  if (stage === "preflight") throw new IntegrateRefusal(stage, detail, "index-preflight");
  throw new IntegrateFailure(stage, detail);
}

type ConfiguredChecksOptions = { sessionManager?: CustomToolContext["sessionManager"]; waiver?: string };

async function restoreAfterConfiguredFailure(repo: Repo, state: State, tested: string, untrackedBefore?: string): Promise<{ restored: boolean; note: string }> {
  // Finish rollback even when cancellation stopped the checks.
  const rollback = { ...repo, signal: undefined };
  const ref = `refs/cuelo/integrate-failed/${state.branch}/${tested}`;
  const stage = "finalize-checks rollback";
  let saved = `Tested commit: ${tested}.`;
  try {
    if (tested !== state.origHead) {
      await gitOk(rollback, stage, ["update-ref", ref, tested]);
      saved = `Rebased commit ${tested} is saved at ${ref}.`;
    }
    const branch = await gitOk(rollback, stage, ["symbolic-ref", "-q", "HEAD"]);
    const head = await gitOk(rollback, stage, ["rev-parse", "HEAD"]);
    if (branch !== `refs/heads/${state.branch}` || head !== tested || await rebaseInProgress(rollback)) {
      return { restored: false, note: `${saved} Branch or HEAD changed during the checks; left the worktree unchanged.` };
    }
    await ensureCleanTracked(rollback, stage);
    const indexFlags = await gitOk(rollback, stage, ["ls-files", "-v", "-z"]);
    if (/(?:^|\0)[Sa-z] /.test(indexFlags)) {
      return { restored: false, note: `${saved} The index hides tracked paths; left the worktree unchanged because rollback could not be verified.` };
    }
    if (untrackedBefore !== undefined && untrackedBefore !== await gitOk(rollback, stage, ["ls-files", "--others", "--exclude-standard", "-z"])) {
      return { restored: false, note: `${saved} The untracked file list changed during the checks; left the worktree unchanged.` };
    }
    if (tested === state.origHead) return { restored: true, note: `No rebase rollback was needed; the starting commit was ${tested}.` };
    await gitOk(rollback, stage, ["reset", "--keep", state.origHead]);
    if ((await gitOk(rollback, stage, ["rev-parse", "HEAD"])) !== state.origHead ||
        (await gitOk(rollback, stage, ["symbolic-ref", "-q", "HEAD"])) !== `refs/heads/${state.branch}`) {
      throw new Error(`HEAD did not return to ${state.origHead}`);
    }
    await ensureCleanTracked(rollback, stage);
    return { restored: true, note: `${saved} Restored ${state.branch} to ${state.origHead}; fix the check and start git_integrate again.` };
  } catch (error) {
    return { restored: false, note: `${saved} Could not restore ${state.branch} to ${state.origHead}; no remote refs changed. ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** rebase가 끝난 브랜치를 검사하고 잠금 안에서 게시한다. 대상이 그새 움직였으면 다시 rebase한다. */
async function checkAndPublish(repo: Repo, state: State, configured: ConfiguredChecksOptions, canRefuse: boolean) {
  for (;;) {
    const tested = await gitOk(repo, "checks", ["rev-parse", "HEAD"]);
    let finalizeChecks: FinalizeChecksResult | undefined;
    let untrackedBefore: string | undefined;
    try {
      finalizeChecks = await runFinalizeChecks({
        root: repo.root, signal: repo.signal, ...configured,
        files: async () => (await gitOk(repo, "finalize-checks", ["diff", "--name-only", "-z", "--no-renames", state.onto, tested])).split("\0").filter(Boolean),
        authorize: async () => {
          await ensureCleanTracked(repo, "finalize-checks");
          untrackedBefore = await gitOk(repo, "finalize-checks", ["ls-files", "--others", "--exclude-standard", "-z"]);
        },
      });
      if (finalizeChecks && !finalizeChecks.waiver) {
        if ((await gitOk(repo, "finalize-checks", ["rev-parse", "HEAD"])) !== tested) throw new Error(`the checks moved HEAD from ${tested}`);
        await ensureCleanTracked(repo, "finalize-checks");
      }
    } catch (error) {
      const recovery = await restoreAfterConfiguredFailure(repo, state, tested, untrackedBefore);
      await clearState(repo);
      const detail = `${error instanceof Error ? error.message : String(error)}\nNothing was pushed. ${recovery.note}`;
      if (canRefuse && recovery.restored && !repo.signal?.aborted && error instanceof FinalizeChecksRefusal) throw new IntegrateRefusal("finalize-checks", detail);
      throw new IntegrateFailure("finalize-checks", detail);
    }
    let ran: { command: string; seconds: number }[];
    try {
      ran = await runChecks(repo, state.checks);
    } catch (error) {
      const note = await syncSessionBranch(repo, state, tested).catch((syncError) => `branch sync failed: ${String(syncError)}`);
      await clearState(repo);
      throw error instanceof Error ? new Error(`${error.message}\nSession branch: ${note}.`) : error;
    }
    if ((await gitOk(repo, "checks", ["rev-parse", "HEAD"])) !== tested) {
      await clearState(repo);
      throw new IntegrateFailure("checks", `the checks moved HEAD from ${tested}; nothing was pushed.`);
    }
    await ensureCleanTracked(repo, "checks").catch(async (error) => { await clearState(repo); throw error; });
    const upstreamRef = `refs/heads/${state.target}`;
    const outcome = await withLock<{ moved: string } | { pushed: string }>(repo, state.remote, upstreamRef, async (locked) => {
      const tip = await fetchTarget(locked, state);
      if (tip !== state.onto) return { moved: tip };
      const pushed = await git(locked, ["push", "--porcelain", state.remote, `${tested}:${upstreamRef}`]);
      if (pushed.code !== 0) {
        const again = await fetchTarget(locked, state);
        if (again !== state.onto) return { moved: again };
        throw new IntegrateFailure("push", `git push exited ${pushed.code}: ${(pushed.stderr || pushed.stdout).trim()}`);
      }
      const remoteLine = await gitOk(locked, "remote-verify", ["ls-remote", "--refs", state.remote, upstreamRef]);
      const remoteSha = remoteLine.split(/\s+/)[0];
      if (remoteSha !== tested) throw new IntegrateFailure("remote-verify", `expected=${tested} actual=${remoteSha}`);
      return { pushed: tested };
    }).catch(async (error) => { await clearState(repo); throw error; });
    if ("moved" in outcome) {
      state.moves += 1;
      if (state.moves > MAX_TARGET_MOVES) {
        const note = await syncSessionBranch(repo, state, tested).catch((syncError) => `branch sync failed: ${String(syncError)}`);
        await clearState(repo);
        throw new IntegrateFailure("target-moved", `${state.remote} ${upstreamRef} moved ${state.moves} times while publishing (now ${outcome.moved}); the branch is left rebased on ${state.onto} and nothing was pushed. Call git_integrate again. Session branch: ${note}.`);
      }
      const replay = await startRebase(repo, state, outcome.moved);
      if (!replay.done) return conflictResult(repo, state, replay.conflicts);
      continue;
    }
    const retired = await retireSessionBranch(repo, state, outcome.pushed).catch((syncError) => ({ note: `branch cleanup failed: ${String(syncError)}`, gone: false }));
    const branchNote = retired.note;
    const localNote = !retirableBranch(state.branch)
      ? "the local branch was kept (only wt/<topic> session branches are removed; wt/nightly-* stays)"
      : retired.gone
        ? await retireLocalBranch(repo, state, outcome.pushed).catch((retireError) => `local branch cleanup failed: ${String(retireError)}`)
        : "the local branch was kept because its remote copy was kept";
    const mainNote = await followMainCheckout(repo, state).catch((syncError) => `main checkout follow failed: ${String(syncError)}`);
    const files = (await gitOk(repo, "complete", ["diff", "--name-only", "-z", "--no-renames", state.previousTarget, outcome.pushed])).split("\0").filter(Boolean);
    await clearState(repo);
    const syncHint = process.platform === "win32" ? "" : `\nWindows 대응 사본이 있으면: bun ${shellArg(syncCheckoutPath)} --source ${shellArg(repo.root)}`
      + ` --target ${shellArg("<대응 Windows 사본의 /mnt 경로>")} --revision ${outcome.pushed} --branch ${shellArg(state.target)}`;
    const vmHint = await vmCopyHint(repo.commonDir.endsWith(".git") ? [repo.root, dirname(repo.commonDir)] : [repo.root], outcome.pushed, { signal: repo.signal });
    return {
      content: [{
        type: "text" as const,
        text: `Integrated ${state.branch} and pushed ${outcome.pushed} to ${state.remote} ${upstreamRef}.`
          + (state.moves > 0 ? ` The target moved ${state.moves} time(s) before the push; the branch was rebased and checked again.` : "")
          + ` Session branch: ${branchNote}.` + ` Local branch: ${localNote}.` + ` Main checkout: ${mainNote}.`
          + (finalizeChecks ? `\n${finalizeChecksNote(finalizeChecks)}` : "") + syncHint + (vmHint ? `\n${vmHint}` : ""),
      }],
      details: {
        ok: true, stage: "complete", commitSha: outcome.pushed, remote: state.remote, upstreamRef, branch: state.branch,
        previousTarget: state.previousTarget, moves: state.moves, checks: ran, branchSync: branchNote, localBranch: localNote, mainCheckout: mainNote,
        ...(finalizeChecks ? { finalizeChecks } : {}),
        ...(files.length <= 1000 ? { files } : { filesTruncated: true }),
      },
    };
  }
}

async function start(repo: Repo, params: { target?: string; checks?: string[] }, configured: ConfiguredChecksOptions) {
  if (await rebaseInProgress(repo)) throw new IntegrateRefusal("preflight", "a rebase is already in progress in this worktree; call git_integrate with action continue or abort.", "repository");
  const branchStatus = await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branchStatus.code !== 0 && branchStatus.code !== 1) throw new IntegrateFailure("preflight", branchStatus.stderr.trim() || `git symbolic-ref exited ${branchStatus.code}`);
  let branch = branchStatus.stdout.trim();
  let attached = false;
  if (!branch) {
    // 앞선 git_integrate가 로컬 세션 브랜치를 지운 worktree다. 새 커밋이 있으면 같은 이름으로 다시 붙이고, 없으면 올릴 것이 없다.
    const reattached = await reattachRetiredBranch(repo.root, { signal: repo.signal, keepWhenUnchanged: true });
    if (reattached.status === "unchanged") {
      return {
        content: [{ type: "text" as const, text: `${reattached.note}; nothing was pushed and the branch was not re-created.` }],
        details: { ok: true, stage: "up-to-date", branch: reattached.branch, detached: true },
      };
    }
    if (reattached.status !== "attached" || !reattached.branch) throw new IntegrateRefusal("preflight", `HEAD is detached; ${reattached.note ?? "check out the session branch first"}.`, "repository");
    branch = reattached.branch;
    attached = true;
  }
  try {
    const target = (params.target ?? "main").trim();
    if ((await git(repo, ["check-ref-format", "--branch", target])).code !== 0 || target.startsWith("-")) throw new IntegrateRefusal("preflight", `invalid target branch ${JSON.stringify(target)}.`, "repository");
    if (branch === target) throw new IntegrateRefusal("preflight", `the worktree is on the target branch ${target}; git_integrate publishes a separate session branch. Use git_finalize on ${target}.`, "repository");
    if (!Array.isArray(params.checks)) throw new IntegrateRefusal("preflight", "checks is required: list the commands (typecheck, tests) that prove the rebased branch, or [] when the change needs none.", "finalize-checks");
    const checks = params.checks.map((command) => command.trim());
    screenChecks(checks, repo.root);
    await ensureCleanTracked(repo, "preflight");
    const remote = await resolveRemote(repo, branch);
    const origHead = await gitOk(repo, "preflight", ["rev-parse", "HEAD"]);
    const upstreamRef = `refs/heads/${target}`;
    const tip = await withLock(repo, remote, upstreamRef, (locked) => fetchTarget(locked, { remote, target }));
    const state: State = {
      version: 1, branch, origHead, remote, target, oldBase: tip, onto: tip, previousTarget: tip, checks, moves: 0, pending: [], stagedAtStop: {}, pendingManifest: false,
    };
    if (await isAncestor(repo, origHead, tip)) {
      return {
        content: [{ type: "text" as const, text: `${branch} has no commit that ${remote} ${upstreamRef} (${tip}) lacks; nothing was pushed.` }],
        details: { ok: true, stage: "up-to-date", remote, upstreamRef, branch, target: tip },
      };
    }
    if (!(await isAncestor(repo, tip, origHead))) {
      const replay = await startRebase(repo, state, tip);
      if (!replay.done) return conflictResult(repo, state, replay.conflicts);
    } else {
      await saveState(repo, state);
    }
    return await checkAndPublish(repo, state, configured, !attached);
  } catch (error) {
    if (attached && error instanceof IntegrateRefusal) throw new Error(`${error.message}\nThe retired branch ${branch} was reattached before the block.`, { cause: error });
    throw error;
  }
}

async function resume(repo: Repo, params: { crossReviewHighRisk?: string[]; crossReviewWaiver?: string; slopGateWaiver?: string }, configured: ConfiguredChecksOptions) {
  const state = await readState(repo);
  if (!state) throw new IntegrateRefusal("preflight", "no git_integrate run is paused in this worktree; call git_integrate with action start.", "repository");
  if (!(await rebaseInProgress(repo))) {
    await clearState(repo);
    throw new IntegrateRefusal("preflight", "the paused rebase is gone (finished or aborted outside git_integrate); call git_integrate with action start again.", "repository");
  }
  const headName = await readRebaseHead(repo);
  if (headName !== `refs/heads/${state.branch}`) throw new IntegrateRefusal("preflight", `the paused rebase belongs to ${headName}, not ${state.branch}; call git_integrate with action abort.`, "repository");
  const conflicts = await unmergedPaths(repo);
  const manifestHandled = state.pendingManifest || (conflicts.has(MANIFEST_PATH) && (await exists(join(repo.root, ...HELPER_PATH.split("/")))));
  // 충돌 밖에서 함께 고친 추적 파일(호출부 맞춤 등)도 이 단계의 해결이다. stage하지 않고 두면 git이 continue를 거절한다.
  const touched = (await gitOk(repo, "conflict", ["diff", "--name-only", "--no-renames", "-z"])).split("\0").filter(Boolean);
  // 멈춘 뒤 세션(또는 편집기)이 직접 stage한 경로도 푼 것이다. 멈춘 때의 index와 blob이 달라진 경로를 모은다.
  const staged = await stagedBlobs(repo);
  const atStop = state.stagedAtStop ?? {};
  const restaged = Object.keys({ ...staged, ...atStop }).filter((path) => staged[path] !== atStop[path]);
  const resolved = [...new Set([...state.pending, ...conflicts.keys(), ...touched, ...restaged])].filter((path) => !(manifestHandled && path === MANIFEST_PATH));
  const marked = await pathsWithMarkers(repo, resolved);
  if (marked.length > 0) throw new IntegrateRefusal("conflict", `conflict markers remain in: ${marked.join(", ")}. Resolve them, then call continue again.`);
  // 지운 것으로 푼 경로(`git rm` 등)는 작업 트리에 없다. `git add`는 그런 경로를 pathspec 오류로 거절하므로 index에서 빼는 것으로 기록한다.
  const present: string[] = [];
  const absent: string[] = [];
  for (const path of resolved) ((await exists(join(repo.root, ...path.split("/")))) ? present : absent).push(path);
  if (present.length > 0) await gitOk(repo, "conflict", ["add", "-A", "--", ...present]);
  if (absent.length > 0) await gitOk(repo, "conflict", ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...absent]);
  state.pending = resolved;
  state.pendingManifest = manifestHandled;
  await saveState(repo, state);
  // 푼 내용은 사람이 새로 쓴 코드다. git_finalize와 같은 게이트를 푼 경로에 건다(HEAD = 새 기준 + 앞서 얹은 커밋과의 차이).
  if (resolved.length > 0) {
    let gateBlobs: Record<string, string> | undefined;
    try {
      gateBlobs = (await runGate({
        cwd: repo.root, files: resolved, highRisk: params.crossReviewHighRisk, waiver: params.crossReviewWaiver,
        ledgerPath: ledgerPath(), exec: spawnExec(repo.signal),
      })).gateBlobs;
    } catch (error) {
      if (error instanceof CrossReviewRefusal) throw new IntegrateRefusal("cross-review", error.message);
      throw new IntegrateFailure("cross-review", error instanceof Error ? error.message : String(error));
    }
    try {
      gateBlobs = mergeGateBlobs(gateBlobs, await runSlopGate({ cwd: repo.root, files: resolved, waiver: params.slopGateWaiver, ledgerPath: slopLedgerPath(), exec: spawnExec(repo.signal) }));
    } catch (error) {
      if (error instanceof SlopGateRefusal) throw new IntegrateRefusal("slop-gate", error.message);
      throw new IntegrateFailure("slop-gate", error instanceof Error ? error.message : String(error));
    }
    // 게이트가 본 바이트가 stage된 바이트와 같아야 한다. 그 사이에 파일이 바뀌었으면 잇지 않는다.
    for (const [path, blob] of Object.entries(gateBlobs ?? {})) {
      const index = await git(repo, ["rev-parse", "-q", "--verify", `:${path}`]);
      const staged = index.code === 0 ? index.stdout.trim() : index.code === 1 && !index.stderr.trim() ? DELETED_BLOB : undefined;
      if (!staged) throw new IntegrateFailure("cross-review", `could not read index blob for ${path}: ${(index.stderr || index.stdout).trim() || `exit ${index.code}`}`);
      if (staged !== blob) throw new IntegrateRefusal("cross-review", `${path} changed after it was staged; call continue again.`);
    }
  }
  if (state.pendingManifest) await regenerateManifest(repo);
  const replay = await driveRebase(repo, state, "continue");
  if (!replay.done) return conflictResult(repo, state, replay.conflicts);
  return checkAndPublish(repo, state, configured, false);
}

async function abort(repo: Repo) {
  const state = await readState(repo, true);
  if (await rebaseInProgress(repo)) {
    const headName = await readRebaseHead(repo);
    await gitOk(repo, "abort", ["rebase", "--abort"]);
    const branch = (await git(repo, ["symbolic-ref", "-q", "HEAD"])).stdout.trim();
    let head = await gitOk(repo, "abort", ["rev-parse", "HEAD"]);
    // 대상이 움직여 다시 rebase하다 멈췄으면 --abort는 앞선 rebase 결과로만 돌아간다. 그 결과는 이 실행이 만든 것이므로 시작 전 HEAD로 마저 되돌린다.
    if (state && state.moves > 0 && branch === `refs/heads/${state.branch}` && head !== state.origHead) {
      await gitOk(repo, "abort", ["reset", "--keep", state.origHead]);
      head = await gitOk(repo, "abort", ["rev-parse", "HEAD"]);
    }
    if (state && (branch !== `refs/heads/${state.branch}` || head !== state.origHead)) {
      throw new IntegrateFailure("abort", `the rebase was aborted but ${branch || "HEAD"} is at ${head}, expected refs/heads/${state.branch} at ${state.origHead}.`);
    }
    await clearState(repo);
    return {
      content: [{ type: "text" as const, text: state
        ? `Aborted the paused rebase; ${branch || headName} is back at ${head}. Nothing was pushed.`
        : `Aborted the paused rebase. Current HEAD: ${head}; original HEAD unknown because the paused integrate state was unavailable, so restoration verification was skipped. Nothing was pushed.` }],
      details: { ok: true, stage: "aborted", branch: branch || headName, head },
    };
  }
  await clearState(repo);
  return {
    content: [{ type: "text" as const, text: "No rebase was in progress in this worktree; nothing changed." }],
    details: { ok: true, stage: "aborted", head: await gitOk(repo, "abort", ["rev-parse", "HEAD"]) },
  };
}

export const integrateTool = (pi: ToolApi): CustomTool<any, any> => ({
  name: "git_integrate",
  label: "Git Integrate",
  description:
    "Publish this session's linked-worktree branch (wt/<topic>) to a target branch (default main) by rebasing it onto the fetched target inside this worktree only and fast-forward pushing it. Commit the work on the branch with git_finalize first. action start (default): refuses the main checkout, the target branch, a detached HEAD it cannot re-attach and tracked uncommitted changes; fetches the target under the repository finalizer lock (shared with git_finalize), rebases, runs `checks` (required: shell commands such as typecheck and tests, [] only when none apply), then re-fetches under the lock and pushes without force; if the target moved it rebases and checks again. After a successful push it deletes the session branch's own remote copy (wt/<topic>; wt/nightly-* is only updated) when that copy holds nothing beyond this worktree's work; once that copy is gone and the local branch tip is in the pushed commit, it also removes the local branch so finished wt branches leave branch lists (GitHub Desktop), detaching HEAD at the pushed commit and keeping the worktree folder and files (wt/nightly-* and non-wt branches stay). Continuing in that worktree needs no git command: git_finalize and git_integrate re-create the same branch at HEAD first (start returns up-to-date without re-creating it when HEAD has no new commit). On a conflict the rebase stays paused and the result lists the conflicted paths, the session commit being replayed and the target commits that touched them: edit the files to keep both intents (rewrite HANDOFF.md, doc/README.md and CHANGELOG.md for the combined state), then call action continue, which refuses leftover conflict markers and applies the git_finalize review gates (crossReviewHighRisk, crossReviewWaiver, slopGateWaiver) to the resolved files. crossReviewWaiver: explicit user instruction OR standing exception when required review failed only on provider rate or usage limits (decision, reviewId, raw errors). Other tracked files you edit or stage while the rebase is paused become part of that step and are gated too. Tools/CUELO_Setup/files/source-integrity.json conflicts are regenerated from the merged tracked content automatically. action abort restores the branch. Failing checks stop before the push. Never run git rebase, merge or pull yourself."
    + " Matching .finalize-checks.json checks run before pushing the rebased tree. finalizeChecksWaiver: explicit user instruction only, for this call.",
  parameters: pi.zod.object({
    action: pi.zod.enum(["start", "continue", "abort"]).optional(),
    target: pi.zod.string().optional(),
    checks: pi.zod.array(pi.zod.string()).optional(),
    crossReviewHighRisk: pi.zod.array(pi.zod.string()).optional(),
    crossReviewWaiver: pi.zod.string().optional(),
    slopGateWaiver: pi.zod.string().optional(),
    finalizeChecksWaiver: pi.zod.string().optional(),
  }),

  async execute(_toolCallId, params, onUpdate, ctx, signal) {
    try {
      signal?.throwIfAborted();
      const action = params.action ?? "start";
      const repo = await openRepo(pi.cwd, signal);
      onUpdate?.({ content: [{ type: "text", text: `git_integrate ${action}: ${repo.root}` }], details: { phase: action } });
      if (action === "abort") return await abort(repo);
      const configured = { sessionManager: ctx?.sessionManager, waiver: params.finalizeChecksWaiver };
      return await (action === "continue" ? resume(repo, params, configured) : start(repo, params, configured));
    } catch (error) {
      if (signal?.aborted && error instanceof PublicationRefusal) signal.throwIfAborted();
      return publicationRefusalResult(error);
    }
  },
});
