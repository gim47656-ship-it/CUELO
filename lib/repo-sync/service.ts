import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { writePrivateFileAtomicSync } from "../atomic-file";
import { readBusySnapshots } from "./busy-files";

export const ACCOUNT = "gim47656-ship-it";
export type Repo = { name: string; isPrivate: boolean; isFork: boolean; isArchived: boolean; defaultBranchRef: { name: string } | null };
export type Reason = "dirty" | "diverged" | "ahead" | "detached" | "other-branch" | "untracked" | "busy" | "unknown-idle" | "server-auth" | "git-lock" | "fetch-error" | "ff-error";
export type Result = { name: string; path: string; outcome: "updated" | "current" | "skipped"; reason?: Reason; before?: string; after?: string; lastSuccess?: string; skipCount: number };
export type CloneAttempt = { status: "running" | "done" | "failed"; startedAt: string; error?: "auth" | "clone" | "interrupted" };
export type SyncState = {
  version: 1; lastRun?: string; accountStatus: "ok" | "auth" | "error" | "uninitialized";
  repos: Repo[]; results: Result[]; decisions: Record<string, "clone" | "decline">;
  clones: Record<string, CloneAttempt>; unresolvedRunningIds: number;
};
export type Options = { home?: string; server?: string };
export class SyncError extends Error {
  constructor(message: string, public status = 409) { super(message); }
}
const validName = (name: string) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && name !== "." && name !== "..";
const homeOf = (o: Options) => o.home ?? homedir();
const statePath = (o: Options) => join(homeOf(o), ".omp/agent/repo-sync.json");
const initial = (): SyncState => ({ version: 1, accountStatus: "uninitialized", repos: [], results: [], decisions: {}, clones: {}, unresolvedRunningIds: 0 });
export function readState(o: Options = {}): SyncState {
  try { return JSON.parse(readFileSync(statePath(o), "utf8")) as SyncState; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return initial(); throw e; }
}
function save(state: SyncState, o: Options) {
  mkdirSync(dirname(statePath(o)), { recursive: true, mode: 0o700 });
  writePrivateFileAtomicSync(statePath(o), JSON.stringify(state, null, 2) + "\n");
}
export async function command(args: string[], cwd?: string, timeout = 60_000): Promise<string> {
  const { promise, resolve: accept, reject } = Promise.withResolvers<string>();
  const child = spawn(args[0], args.slice(1), { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  const timer = timeout > 0 ? setTimeout(() => child.kill("SIGTERM"), timeout) : undefined;
  child.stdout.on("data", (b) => { out += b; });
  child.stderr.on("data", (b) => { err += b; });
  child.on("error", reject);
  child.on("close", (code) => { clearTimeout(timer); if (code === 0) accept(out.trim()); else reject(new Error(err || `Command exited ${code}`)); });
  return promise;
}
// flock is released by the kernel even if Bun exits; no stale PID lock removal.
export async function withLock<T>(o: Options, work: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(statePath(o)), { recursive: true, mode: 0o700 });
  const lock = spawn("flock", ["-n", statePath(o) + ".lock", "sh", "-c", "printf ready; cat >/dev/null"], { stdio: ["pipe", "pipe", "ignore"] });
  const acquired = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  lock.once("error", acquired.reject);
  lock.stdout.once("data", () => acquired.resolve());
  lock.once("close", () => { acquired.reject(new SyncError("Repository sync already running")); closed.resolve(); });
  await acquired.promise;
  try { return await work(); }
  finally { lock.stdin.end(); await closed.promise; }
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
export function originName(url: string): string | null {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)gim47656-ship-it\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url);
  return match && validName(match[1]) ? match[1] : null;
}
export async function discover(o: Options = {}): Promise<{ name: string; path: string }[]> {
  const home = homeOf(o), src = join(home, "src");
  const entries = exists(src) ? readdirSync(src).map((n) => join(src, n)) : [];
  entries.push(join(home, "cuelo-routines"));
  const found: { name: string; path: string }[] = [];
  const installs = [resolve(home, "cuelo-run"), resolve(home, "app"), process.env.CUELO_APP_DIR, ...readBusySnapshots(join(home, ".omp/agent")).map((s) => s.appDir)]
    .filter((p): p is string => !!p).map((p) => { try { return realpathSync(p); } catch { return resolve(p); } });
  for (const path of entries) {
    // A .git file is a linked worktree/submodule, not an independently owned clone.
    if (!exists(path) || !lstatSync(path).isDirectory() || !exists(join(path, ".git")) || !lstatSync(join(path, ".git")).isDirectory()) continue;
    if (installs.includes(realpathSync(path)) || realpathSync(path) !== resolve(path)) continue;
    try {
      const name = originName(await command(["git", "remote", "get-url", "origin"], path));
      if (name) found.push({ name, path });
    } catch { /* Not a usable origin; leave this directory alone. */ }
  }
  return found;
}
export function resolveBusy(ids: string[], sessions: { id: string; cwd?: string }[]) {
  let unresolved = 0;
  const cwds: string[] = [];
  for (const id of ids) {
    const session = sessions.find((s) => s.id === id) ?? sessions.find((s) => id.startsWith(s.id + "."));
    if (session?.cwd) {
      try { cwds.push(realpathSync(session.cwd)); } catch { unresolved++; }
    } else unresolved++;
  }
  return { cwds, unresolved };
}
export async function busyState(o: Options = {}): Promise<{ cwds: string[]; unresolved: number; known: boolean; reason?: "server-auth" | "unknown-idle" }> {
  const base = o.server ?? "http://127.0.0.1:30141";
  const port = Number(new URL(base).port || (new URL(base).protocol === "https:" ? 443 : 80));
  const snapshots = readBusySnapshots(join(homeOf(o), ".omp/agent"));
  const cwds = [...new Set(snapshots.flatMap((s) => s.cwds))];
  const unresolved = snapshots.reduce((n, s) => n + s.unresolved, 0);
  let auth = false;
  let runningRead = false;
  try {
    const get = async (path: string) => {
      const res = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
      if ([401, 403, 503].includes(res.status)) auth = true;
      if (!res.ok) throw new Error("Session request failed");
      return res.json();
    };
    const running = await get("/api/agent/running") as { runningSessionIds: string[] };
    if (!Array.isArray(running.runningSessionIds)) throw new Error("Missing running IDs");
    runningRead = true;
    let resolved = { cwds: [] as string[], unresolved: 0 };
    if (running.runningSessionIds.length) {
      const list = await get("/api/sessions?archived=0") as { sessions: { id: string; cwd?: string }[] };
      const archived = await get("/api/sessions?archived=1") as { sessions: { id: string; cwd?: string }[] };
      resolved = resolveBusy(running.runningSessionIds, [...list.sessions, ...archived.sessions]);
    }
    return { cwds: [...cwds, ...resolved.cwds], unresolved: unresolved + resolved.unresolved, known: unresolved + resolved.unresolved === 0 };
  } catch {
    if (auth && !runningRead && snapshots.some((s) => s.port === port)) return { cwds, unresolved, known: unresolved === 0 };
    return { cwds, unresolved: unresolved || -1, known: false, reason: unresolved ? "unknown-idle" : auth ? "server-auth" : "unknown-idle" };
  }
}
function inside(root: string, cwd: string) {
  const rel = relative(root, cwd);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !rel.startsWith("/"));
}
function hasGitLock(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((e) => e.name.endsWith(".lock") || (e.isDirectory() && hasGitLock(join(dir, e.name))));
}
export async function syncClone(repo: { name: string; path: string }, defaultBranch: string | undefined, o: Options = {}): Promise<Result> {
  const result: Result = { ...repo, outcome: "skipped", skipCount: 0 };
  const skip = (reason: Reason) => ({ ...result, reason });
  const git = (...args: string[]) => command(["git", ...args], repo.path);
  const safety = async (): Promise<Reason | undefined> => {
    if (hasGitLock(join(repo.path, ".git"))) return "git-lock";
    const busy = await busyState(o);
    if (busy.cwds.some((cwd) => inside(realpathSync(repo.path), cwd))) return "busy";
    if (!busy.known) return busy.reason ?? "unknown-idle";
    if (await git("status", "--porcelain")) return "dirty";
    const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD").catch(() => "");
    if (!branch) return "detached";
    if (!defaultBranch || branch !== defaultBranch) return "other-branch";
    if (await git("rev-parse", "--abbrev-ref", "@{upstream}").catch(() => "") !== `origin/${branch}`) return "untracked";
    return undefined;
  };
  const first = await safety();
  if (first) return skip(first);
  try { await git("fetch", "origin"); } catch { return skip("fetch-error"); }
  const again = await safety();
  if (again) return skip(again);
  result.before = await git("rev-parse", "HEAD");
  const [ahead, behind] = (await git("rev-list", "--left-right", "--count", "HEAD...@{upstream}")).split(/\s+/).map(Number);
  if (ahead && behind) return skip("diverged");
  if (ahead) return skip("ahead");
  if (behind) {
    try { await command(["git", "-c", "core.hooksPath=/dev/null", "merge", "--ff-only", "--no-edit", "@{upstream}"], repo.path, 0); }
    catch { return skip("ff-error"); }
  }
  result.after = await git("rev-parse", "HEAD");
  return { ...result, outcome: behind ? "updated" : "current", lastSuccess: new Date().toISOString() };
}
async function refreshAccount(state: SyncState) {
  try {
    state.repos = JSON.parse(await command(["gh", "repo", "list", ACCOUNT, "--limit", "10000", "--json", "name,isPrivate,isFork,isArchived,defaultBranchRef"])) as Repo[];
    state.repos = state.repos.filter((r) => validName(r.name));
    state.accountStatus = "ok";
  } catch {
    state.accountStatus = await command(["gh", "auth", "status", "--hostname", "github.com"]).then(() => "error" as const, () => "auth" as const);
  }
}
export async function runSync(o: Options = {}) {
  return withLock(o, async () => {
    const state = readState(o);
    await refreshAccount(state);
    const busy = await busyState(o);
    state.unresolvedRunningIds = busy.unresolved;
    const results: Result[] = [];
    for (const clone of await discover(o)) {
      const old = state.results.find((r) => r.path === clone.path);
      const meta = state.repos.find((r) => r.name.toLowerCase() === clone.name.toLowerCase());
      let result: Result;
      try { result = await syncClone(clone, meta?.defaultBranchRef?.name, o); }
      catch { result = { ...clone, outcome: "skipped", reason: "fetch-error", skipCount: 0 }; }
      result.skipCount = result.outcome === "skipped" ? (old?.skipCount ?? 0) + 1 : 0;
      result.lastSuccess ??= old?.lastSuccess;
      results.push(result);
    }
    state.results = results;
    state.lastRun = new Date().toISOString();
    for (const [name, attempt] of Object.entries(state.clones)) {
      if (results.some((r) => r.name.toLowerCase() === name.toLowerCase())) { delete state.clones[name]; continue; }
      if (attempt.status === "running") {
        attempt.status = "failed"; attempt.error = "interrupted";
        try { rmdirSync(join(homeOf(o), "src", name)); } catch { /* Only discard an empty reservation, never partial contents. */ }
      }
    }
    save(state, o);
    return state;
  });
}
export async function getState(o: Options = {}) {
  const state = readState(o);
  const cloned = new Set((await discover(o)).map((r) => r.name.toLowerCase()));
  return { ...state, uncloned: state.repos.filter((r) => !cloned.has(r.name.toLowerCase())) };
}
export async function decide(name: string, action: "decline" | "undecline" | "clone", o: Options = {}) {
  return withLock(o, async () => {
    const state = readState(o);
    if (!validName(name) || !state.repos.some((r) => r.name === name)) throw new SyncError("Repository not in account list", 400);
    if (action !== "clone") {
      if (action === "decline") state.decisions[name] = "decline";
      else { delete state.decisions[name]; delete state.clones[name]; }
      save(state, o);
      return;
    }
    const path = join(homeOf(o), "src", name);
    if (exists(path)) throw new SyncError("Clone destination already exists");
    if ((await discover(o)).some((r) => r.name.toLowerCase() === name.toLowerCase())) throw new SyncError("Repository already cloned");
    // mkdir is our reservation: gh accepts an empty directory, competing requests cannot claim it.
    mkdirSync(dirname(path), { recursive: true });
    mkdirSync(path);
    state.decisions[name] = "clone";
    state.clones[name] = { status: "running", startedAt: new Date().toISOString() };
    save(state, o);
    try {
      await command(["gh", "repo", "clone", `${ACCOUNT}/${name}`, path], undefined, 300_000);
      state.clones[name].status = "done";
    } catch (error) {
      try { rmdirSync(path); } catch { /* Preserve any partial checkout; never delete its contents. */ }
      state.clones[name].status = "failed";
      state.clones[name].error = /401|403|authentication|credentials|auth login/i.test(String(error)) ? "auth" : await command(["gh", "auth", "status", "--hostname", "github.com"]).then(() => "clone" as const, () => "auth" as const);
      if (state.clones[name].error === "auth") state.accountStatus = "auth";
    }
    save(state, o);
  });
}
