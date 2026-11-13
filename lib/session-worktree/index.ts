import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { addWorktree, listWorktrees, removeWorktree, type WorktreeInfo } from "../worktree";

const exec = promisify(execFile);
async function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout, maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } });
  return stdout.trim();
}
async function optionalGit(cwd: string, args: string[]): Promise<string | undefined> {
  try { return await git(cwd, args); } catch { return undefined; }
}
export interface LiveUse { id: string; cwd: string }
export interface WorktreeHost {
  live(): LiveUse[];
  reserve(path: string): { busy: string[]; release(): void };
}
export interface Selection {
  cwd: string;
  worktree?: { branch: string; base: string; fallback: boolean; missingSubdirectory?: string };
  created?: { root: string; branch: string; path: string; base: string; baseRef: string; pathWasAbsent: boolean };
}
type State = { locks: Map<string, Promise<void>> };
const globalState = globalThis as typeof globalThis & { __cueloSessionWorktrees?: State };
const state = globalState.__cueloSessionWorktrees ??= { locks: new Map() };

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}
export function checkoutIsBusy(checkout: string, uses: readonly LiveUse[]): boolean {
  const root = canonical(checkout);
  return uses.some(({ cwd }) => {
    const rel = relative(root, canonical(cwd));
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  });
}
async function repository(cwd: string) {
  try {
    const out = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--git-dir", "--show-toplevel"]);
    const [common, own, top] = out.split("\n");
    const main = (await listWorktrees(cwd))[0]?.path;
    if (!main) return undefined;
    return { common: canonical(common), main: canonical(main), top: canonical(top), linked: canonical(common) !== canonical(own) };
  } catch { return undefined; }
}
export async function withRepositoryLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const repo = await repository(cwd);
  if (!repo) return action();
  const previous = state.locks.get(repo.common) ?? Promise.resolve();
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const tail = previous.then(() => held);
  state.locks.set(repo.common, tail);
  await previous;
  try { return await action(); } finally {
    release();
    if (state.locks.get(repo.common) === tail) state.locks.delete(repo.common);
  }
}
function githubRepo(remote: string): string | undefined {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(remote)?.[1].toLowerCase();
}
export function parseIssue(input: unknown, origin: string): number | undefined {
  if (input === undefined || input === "") return undefined;
  if (typeof input !== "string") throw new Error("Issue must be #123 or a GitHub issue URL");
  const text = input.trim();
  let digits = /^#?([1-9]\d*)$/.exec(text)?.[1];
  if (!digits) {
    const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/i.exec(text);
    if (!match) throw new Error("Issue must be #123 or a GitHub issue URL");
    if (match[1].toLowerCase() !== githubRepo(origin)) throw new Error("The issue URL belongs to a different repository than origin");
    digits = match[2];
  }
  const issue = Number(digits);
  if (!Number.isSafeInteger(issue)) throw new Error("Invalid issue number");
  return issue;
}
async function defaultBranch(cwd: string): Promise<string> {
  const head = await optionalGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^refs\/remotes\/origin\//, "");
  const remote = await optionalGit(cwd, ["ls-remote", "--symref", "origin", "HEAD"]);
  const ref = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(remote ?? "")?.[1];
  if (ref) return ref;
  for (const name of ["main", "master"]) {
    if (await optionalGit(cwd, ["rev-parse", "--verify", `refs/heads/${name}`])) return name;
  }
  if (!(await optionalGit(cwd, ["remote", "get-url", "origin"]))) {
    const local = await optionalGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
    if (local) return local;
  }
  throw new Error("Cannot determine the repository default branch");
}
async function freshBase(cwd: string) {
  const target = await defaultBranch(cwd);
  let fallback = false;
  try { await git(cwd, ["fetch", "--no-tags", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`]); }
  catch { fallback = true; }
  const ref = fallback ? `refs/heads/${target}` : `refs/remotes/origin/${target}`;
  const base = await git(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return { target, base, fallback };
}
const autoBranch = /^wt\/(?:s-\d{8}-[a-f0-9]{8}|issue-[1-9]\d*(?:-[a-f0-9]{8})?)$/;
const configKey = (branch: string, key: string) => `branch.${branch}.cuelo-${key}`;

function pathIsMissing(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

/** Caller holds the repository lock; reserve runtime use before repairing Git's registration. */
async function clearMissingRegistration(root: string, tree: WorktreeInfo, host: WorktreeHost) {
  if (tree.isMain || !tree.branch || !autoBranch.test(tree.branch)
    || resolve(tree.path) !== join(`${root}-worktrees`, tree.branch.replaceAll("/", "-"))) return "protected-path";
  if (checkoutIsBusy(tree.path, host.live())) return "live";
  const reservation = host.reserve(tree.path);
  try {
    if (reservation.busy.length || checkoutIsBusy(tree.path, host.live())) return "live";
    const current = (await listWorktrees(root, { includeMissing: true })).find((entry) => entry.path === tree.path);
    if (!current || current.isMain || current.branch !== tree.branch) return "registration-changed";
    if (current.locked) return "locked";
    if (checkoutIsBusy(tree.path, host.live())) return "live";
    // lstat fails closed on errors and treats even dangling symlinks as present.
    // No await between this final absence check and the targeted Git invocation.
    if (!pathIsMissing(tree.path)) return "path-reappeared";
    await git(root, ["worktree", "remove", tree.path]);
    return "removed";
  } finally { reservation.release(); }
}

/** Caller holds the repo lock through runtime registration, not just checkout creation. */
export async function selectSessionWorktree(cwd: string, host: WorktreeHost, options: { issue?: unknown; autoWorktree?: boolean } = {}): Promise<Selection> {
  const repo = await repository(cwd);
  if (!repo || repo.linked || options.autoWorktree === false) {
    if (options.issue !== undefined && options.issue !== "") throw new Error("Issue starts require a main Git checkout with automatic worktrees enabled");
    return { cwd };
  }
  const origin = await optionalGit(cwd, ["remote", "get-url", "origin"]) ?? "";
  const issue = parseIssue(options.issue, origin);
  if (!issue && !checkoutIsBusy(repo.top, host.live())) return { cwd };
  const subdirectory = relative(repo.top, canonical(cwd));
  const inRequestedDirectory = (selected: Selection): Selection => {
    if (!subdirectory) return selected;
    const nested = join(selected.cwd, subdirectory);
    if (existsSync(nested)) return { ...selected, cwd: nested };
    return { ...selected, worktree: selected.worktree ? { ...selected.worktree, missingSubdirectory: subdirectory } : undefined };
  };
  const short = () => randomUUID().replaceAll("-", "").slice(0, 8);
  let branch = issue ? `wt/issue-${issue}` : `wt/s-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${short()}`;
  const trees = await listWorktrees(repo.main, { includeMissing: true });
  let existing = trees.find((tree) => tree.branch === branch);
  const reusable = existing && existsSync(existing.path);
  if (existing && !reusable && await clearMissingRegistration(repo.main, existing, host) === "removed") existing = undefined;
  if (existing && reusable && !checkoutIsBusy(existing.path, host.live())) {
    const base = await optionalGit(repo.main, ["config", "--get", configKey(branch, "base")]);
    return inRequestedDirectory({ cwd: existing.path, worktree: { branch, base: base ?? "existing branch", fallback: false } });
  }
  if (existing) branch += `-${short()}`;
  while (await optionalGit(repo.main, ["show-ref", "--verify", `refs/heads/${branch}`])) {
    // A branch without a checkout can be reused for an issue, but never adopted as auto-owned.
    if (issue && !existing && branch === `wt/issue-${issue}`) {
      const tree = await addWorktree(repo.main, branch);
      return inRequestedDirectory({ cwd: tree.path, worktree: { branch, base: "existing branch", fallback: false } });
    }
    branch = issue ? `wt/issue-${issue}-${short()}` : `wt/s-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${short()}`;
  }
  const base = await freshBase(repo.main);
  await git(repo.main, ["branch", "--no-track", branch, base.base]);
  const path = join(`${repo.main}-worktrees`, branch.replaceAll("/", "-"));
  const created = { root: repo.main, branch, path, base: base.base,
    baseRef: base.fallback ? `refs/heads/${base.target}` : `refs/remotes/origin/${base.target}`, pathWasAbsent: !existsSync(path) };
  try {
    const tree = await addWorktree(repo.main, branch);
    await git(repo.main, ["config", configKey(branch, "base"), base.base]);
    await git(repo.main, ["config", configKey(branch, "base-ref"), created.baseRef]);
    await git(repo.main, ["config", configKey(branch, "path"), tree.path]);
    await git(repo.main, ["config", configKey(branch, "target"), base.target]);
    return inRequestedDirectory({ cwd: tree.path, worktree: { branch, base: base.fallback ? base.target : `origin/${base.target}`, fallback: base.fallback },
      created });
  } catch (error) {
    await rollbackUnstartedWorktree({ cwd: path, created });
    throw error;
  }
}

/** Roll back only the fresh, unchanged allocation of a failed start, never an existing issue tree. */
export async function rollbackUnstartedWorktree(selection: Selection): Promise<void> {
  const created = selection.created;
  if (!created) return;
  try {
    if (created.pathWasAbsent && existsSync(created.path)) {
      if (await git(created.path, ["branch", "--show-current"]) !== created.branch) return;
      if (await git(created.path, ["rev-parse", "HEAD"]) !== created.base) return;
      if (await git(created.path, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"])) return;
      await removeWorktree(created.root, created.path);
    }
    if (await optionalGit(created.root, ["rev-parse", `refs/heads/${created.branch}`]) === created.base) {
      await git(created.root, ["-c", `branch.${created.branch}.remote=.`, "-c", `branch.${created.branch}.merge=${created.baseRef}`, "branch", "-d", created.branch]);
    }
  } catch (error) { console.error("[session-worktree] failed-start allocation retained:", error); }
}
export interface SweepResult { path: string; branch: string; removed: boolean; branchKept?: boolean; reason?: string }
export async function sweepSessionWorktrees(cwd: string, host: WorktreeHost): Promise<SweepResult[]> {
  return withRepositoryLock(cwd, async () => {
    const repo = await repository(cwd);
    if (!repo || canonical(repo.main) === canonical(join(homedir(), "cuelo-run"))) return [];
    const results: SweepResult[] = [];
    const fetched = new Map<string, boolean>();
    for (const tree of await listWorktrees(repo.main, { includeMissing: true })) {
      const branch = tree.branch;
      if (tree.isMain || !branch || !autoBranch.test(branch)) continue;
      const base = await optionalGit(repo.main, ["config", "--get", configKey(branch, "base")]);
      const ownedPath = await optionalGit(repo.main, ["config", "--get", configKey(branch, "path")]);
      const target = await optionalGit(repo.main, ["config", "--get", configKey(branch, "target")]);
      const baseRef = await optionalGit(repo.main, ["config", "--get", configKey(branch, "base-ref")]) ?? `refs/remotes/origin/${target}`;
      if (!base || ownedPath !== tree.path || !target) continue;
      const result: SweepResult = { path: tree.path, branch, removed: false };
      results.push(result);
      try {
      if (checkoutIsBusy(tree.path, host.live())) { result.reason = "live"; continue; }
      if (pathIsMissing(tree.path)) {
        const repair = await clearMissingRegistration(repo.main, tree, host);
        if (repair === "removed") {
          result.removed = true; result.branchKept = true; result.reason = "missing-registration";
          for (const key of ["base", "base-ref", "path", "target"]) {
            try { await git(repo.main, ["config", "--unset-all", configKey(branch, key)]); }
            catch (error) { if ((error as { code?: number }).code !== 5) throw error; }
          }
        } else result.reason = repair;
        continue;
      }
      // 무시 파일(node_modules, 빌드 결과 등)만 남은 워크트리도 지운다(2026-11-14 사용자 결정 「무시 파일째 지운다」). 추적 파일 수정과 무시 대상이 아닌 새 파일은 그대로 막는다.
      if (await git(tree.path, ["status", "--porcelain", "--untracked-files=all"])) { result.reason = "dirty"; continue; }
      const tip = await git(tree.path, ["rev-parse", "HEAD"]);
      const untouched = tip === base;
      if (!untouched) {
        if (Number(await git(tree.path, ["rev-list", "--count", `${base}..HEAD`])) === 0) { result.reason = "no-own-commits"; continue; }
        if (!fetched.has(target)) {
          try { await git(repo.main, ["fetch", "--no-tags", "origin", `+refs/heads/${target}:refs/remotes/origin/${target}`]); fetched.set(target, true); }
          catch { fetched.set(target, false); }
        }
        if (!fetched.get(target)) { result.reason = "fetch-failed"; continue; }
        if (await optionalGit(repo.main, ["merge-base", "--is-ancestor", tip, `refs/remotes/origin/${target}`]) === undefined) { result.reason = "unmerged"; continue; }
      }
      const reservation = host.reserve(tree.path);
      if (reservation.busy.length || checkoutIsBusy(tree.path, host.live())) { reservation.release(); result.reason = "live"; continue; }
      try {
        if (await git(tree.path, ["rev-parse", "HEAD"]) !== tip) { result.reason = "head-changed"; continue; }
        if (await git(tree.path, ["status", "--porcelain", "--untracked-files=all"])) { result.reason = "dirty"; continue; }
        await removeWorktree(repo.main, tree.path);
        result.removed = true;
        try {
          await git(repo.main, ["-c", `branch.${branch}.remote=${untouched ? "." : "origin"}`,
            "-c", `branch.${branch}.merge=${untouched ? baseRef : `refs/heads/${target}`}`, "branch", "-d", branch]);
        }
        catch (error) { result.branchKept = true; result.reason = String(error); }
      } catch (error) { result.reason = String(error); }
      finally { reservation.release(); }
      } catch (error) { result.reason = String(error); }
    }
    return results;
  });
}
export function removedAutoWorktreeRoot(cwd: string): string | undefined {
  if (existsSync(cwd)) return undefined;
  let candidate = resolve(cwd);
  while (dirname(candidate) !== candidate) {
    const parent = dirname(candidate);
    if (parent.endsWith("-worktrees") && /^wt-(?:s-\d{8}-[a-f0-9]{8}|issue-[1-9]\d*(?:-[a-f0-9]{8})?)$/.test(basename(candidate))) {
      if (existsSync(candidate)) return undefined;
      const root = parent.slice(0, -"-worktrees".length);
      return existsSync(join(root, ".git")) ? root : undefined;
    }
    candidate = parent;
  }
  return undefined;
}
