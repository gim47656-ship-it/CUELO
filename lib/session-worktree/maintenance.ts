import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { checkoutIsBusy, retiredAutoBranch, sweepSessionWorktrees, type LiveUse, type WorktreeHost } from "./index";
import { listWorktrees } from "../worktree";

const exec = promisify(execFile);
export const STALE_AUTO_WORKTREE_MS = 3 * 86_400_000;
// Covers the deploy drain and delayed tab reopening without retaining abandoned trees for days.
const STARTUP_RECENT_MS = 60 * 60_000;
export type RecordedWorktreeSession = { id: string; cwd: string; path: string; modified: string };
export type StaleAutoWorktree = { path: string; branch: string; lastActive: number; changedFiles: string[]; changedCount: number; unmergedCommits: number };
const autoName = /^wt-(?:s-\d{8}-[a-f0-9]{8}|issue-[1-9]\d*(?:-[a-f0-9]{8})?)$/;

// Bounded by recorded/live session cwds, not a recursive scan of the user's disk.
export function sessionWorktreeRoots(cwds: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const cwd of new Set(cwds.map((cwd) => resolve(cwd)))) {
    let path = cwd;
    try {
      if (statSync(`${path}-worktrees`, { throwIfNoEntry: false })?.isDirectory()) roots.add(path);
    } catch (error) { console.error("[session-worktree] root discovery failed:", path, error); }
    while (dirname(path) !== path) {
      const parent = dirname(path);
      if (parent.endsWith("-worktrees") && autoName.test(basename(path))) {
        roots.add(parent.slice(0, -"-worktrees".length));
        break;
      }
      path = parent;
    }
  }
  return [...roots];
}

function readPendingResumeIds(): Set<string> {
  const root = resolve(process.env.CUELO_EXTERNAL_UPDATE_ROOT?.trim() || join(homedir(), ".omp", "external-update"));
  try {
    const value = JSON.parse(readFileSync(join(root, "interrupts", "pending-resume.json"), "utf8").replace(/^\uFEFF/, ""));
    if (!Array.isArray(value.sessionIds) || !value.sessionIds.every((id: unknown) => typeof id === "string")) throw new Error("Invalid pending-resume sessionIds");
    return new Set(value.sessionIds);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error; // A failed protection snapshot must never become an empty protection list.
  }
}

export async function pendingResumeIds(): Promise<Set<string>> {
  return readPendingResumeIds();
}

export async function runWorktreeMaintenance(
  trigger: "startup" | "morning",
  host: WorktreeHost,
  sessions: readonly RecordedWorktreeSession[],
  options: { dryRun?: boolean; now?: number; pendingIds?: ReadonlySet<string> } = {},
) {
  if (options.dryRun) return [];
  const now = options.now ?? Date.now();
  const protectedUses: LiveUse[] = [];
  const recordedIds = new Set(sessions.map((session) => session.id));
  let protectionIncomplete = false;
  let removing: LiveUse | undefined;
  for (const session of sessions) {
    let recent = false;
    if (trigger === "startup") {
      // File mtime includes the last server generation's final writes, unlike display activity time.
      try { recent = now - (await stat(session.path)).mtimeMs <= STARTUP_RECENT_MS; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (recent) protectedUses.push({ id: session.id, cwd: session.cwd });
  }
  const protectedHost: WorktreeHost = {
    live() {
      // The sweeper calls this again after reserving removal; a deploy can queue a resume mid-sweep.
      let pendingSessions = sessions;
      try {
        const pending = options.pendingIds ?? readPendingResumeIds();
        const missing = [...pending].filter((id) => !recordedIds.has(id));
        if (missing.length) {
          if (!protectionIncomplete) console.error("[session-worktree] unmapped pending sessions; retaining all candidate checkouts:", missing);
          protectionIncomplete = true;
        } else pendingSessions = sessions.filter((session) => pending.has(session.id));
      } catch (error) {
        if (!protectionIncomplete) console.error("[session-worktree] resume protection unreadable; retaining all candidate checkouts:", error);
        protectionIncomplete = true;
      }
      return [...host.live(), ...protectedUses, ...pendingSessions, ...(protectionIncomplete && removing ? [removing] : [])];
    },
    reserve(path) {
      const reservation = host.reserve(path);
      removing = { id: "resume-protection-incomplete", cwd: path };
      return { busy: reservation.busy, release() { removing = undefined; reservation.release(); } };
    },
  };
  const results = [];
  for (const root of sessionWorktreeRoots([...sessions.map((s) => s.cwd), ...host.live().map((s) => s.cwd)])) {
    try {
      await git(root, ["rev-parse", "--git-dir"]);
      const trees = await sweepSessionWorktrees(root, protectedHost);
      results.push({ root, trees });
      for (const tree of trees) if (tree.removed || tree.reason?.includes("Error")) console.info("[session-worktree]", trigger, tree);
    } catch (error) { console.error("[session-worktree] project cleanup failed:", root, error); }
  }
  return results;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
  return stdout;
}
async function mtime(path: string, parentRoot?: string): Promise<number> {
  // Walk from the checkout boundary so even intermediate directory symlinks are never followed.
  let candidate = parentRoot ?? path;
  const parts = parentRoot ? relative(parentRoot, path).split(sep).filter(Boolean) : [];
  let parentMtime = 0;
  for (let depth = 0; ; depth++) {
    try {
      const info = await lstat(candidate);
      if (depth === parts.length) return info.mtimeMs;
      if (!info.isDirectory()) return parentMtime;
      parentMtime = info.mtimeMs;
      candidate = join(candidate, parts[depth]);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
      return parentMtime;
    }
  }
}

function canonicalCwd(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export async function findStaleAutoWorktrees(roots: readonly string[], host: Pick<WorktreeHost, "live">,
  sessions: readonly RecordedWorktreeSession[], now = Date.now()): Promise<{ worktrees: StaleAutoWorktree[]; warnings: string[] }> {
  const worktrees: StaleAutoWorktree[] = [];
  const warnings: string[] = [];
  const sessionsByCwd = new Map<string, { canonical: string; sessions: RecordedWorktreeSession[] }>();
  for (const session of sessions) {
    let group = sessionsByCwd.get(session.cwd);
    if (!group) {
      group = { canonical: canonicalCwd(session.cwd), sessions: [] };
      sessionsByCwd.set(session.cwd, group);
    }
    group.sessions.push(session);
  }
  for (const root of roots) {
    try {
      for (const tree of await listWorktrees(root)) {
        if (tree.isMain || checkoutIsBusy(tree.path, host.live())) continue;
        // git_integrate가 로컬 브랜치를 지워 HEAD만 남은 자동 worktree도 원래 브랜치 이름으로 본다.
        const branch = tree.branch ?? await retiredAutoBranch(root, tree);
        if (!branch || !autoName.test(branch.replaceAll("/", "-"))) continue;
        try {
          const config = async (key: string) => {
            try { return (await git(root, ["config", "--get", `branch.${branch}.cuelo-${key}`])).trim(); }
            catch (error) { if (error && typeof error === "object" && "code" in error && error.code === 1) return undefined; throw error; }
          };
          if (await config("path") !== tree.path) continue;
          const base = await config("base");
          const target = await config("target");
          if (!base || !target) continue;
          const gitPath = async (name: string) => (await git(tree.path, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
          // Read mtimes before status; optional locks are disabled so polling cannot refresh the index.
          let lastActive = Math.max(await mtime(await gitPath("HEAD")), await mtime(await gitPath("index")), await mtime(await gitPath("logs/HEAD")));
          const records = (await git(tree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0");
          const changed: string[] = [];
          for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (!record) continue;
            changed.push(record.slice(3));
            if (record[0] === "R" || record[0] === "C" || record[1] === "R" || record[1] === "C") i++;
          }
          for (const file of changed) lastActive = Math.max(lastActive, await mtime(join(tree.path, file), tree.path));
          const treeCwd = canonicalCwd(tree.path);
          for (const group of sessionsByCwd.values()) {
            const rel = relative(treeCwd, group.canonical);
            if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) continue;
            for (const session of group.sessions) {
              lastActive = Math.max(lastActive, Date.parse(session.modified) || 0, await mtime(session.path));
            }
          }
          const own = Number((await git(tree.path, ["rev-list", "--count", `${base}..HEAD`])).trim());
          let unmergedCommits = 0;
          if (own > 0) {
            // Local remote-tracking snapshot only. Missing upstream is conservatively unmerged.
            try { unmergedCommits = Number((await git(tree.path, ["rev-list", "--count", `refs/remotes/origin/${target}..HEAD`])).trim()); }
            catch { unmergedCommits = own; }
          }
          if ((changed.length || unmergedCommits) && now - lastActive > STALE_AUTO_WORKTREE_MS) {
            worktrees.push({ path: tree.path, branch, lastActive, changedFiles: changed.slice(0, 5), changedCount: changed.length, unmergedCommits });
          }
        } catch (error) { warnings.push(`worktree ${tree.path}: ${String(error)}`); }
      }
    } catch (error) { warnings.push(`worktree ${root}: ${String(error)}`); }
  }
  return { worktrees, warnings };
}
