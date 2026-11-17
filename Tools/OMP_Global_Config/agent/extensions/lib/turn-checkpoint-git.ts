import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, mkdtemp, readdir, rm, rmdir, symlink, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PREFIX = "refs/cuelo/checkpoints/";
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
export interface Checkpoint { ref: string; commit: string; tree: string; turn: number; phase: "pre" | "post" }
export interface CheckpointOptions { timeoutMs?: number; keep?: number }
export class CheckpointError extends Error {
  constructor(public readonly code: string, message: string, public readonly changedFiles: string[] = []) { super(message); }
}

// Git subprocesses must never inherit a caller's alternate repository/index or run hooks/fsmonitor.
function gitEnv(index?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  return { ...env, LC_ALL: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...(index ? { GIT_INDEX_FILE: index } : {}) };
}
class Git {
  readonly signal: AbortSignal;
  constructor(public cwd: string, timeoutMs: number) { this.signal = AbortSignal.timeout(timeoutMs); }
  run(args: string[], index?: string, input?: string, allowedExitCode?: number): Promise<string> {
    this.signal.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const child = execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", ...args], {
      cwd: this.cwd, env: gitEnv(index), signal: this.signal, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (!error || (allowedExitCode !== undefined && error.code === allowedExitCode)) resolve(stdout);
      else reject(new CheckpointError(stderr.includes("does not have a commit checked out") ? "unsupported" : "git_failed", stderr.trim() || error.message));
    });
    child.stdin?.on("error", () => {}); // EPIPE is reported by the process callback.
    child.stdin?.end(input);
    return promise;
  }
}
function namespace(sessionId: string): string {
  if (!sessionId) throw new CheckpointError("session_missing", "A session id is required.");
  // Ref-name encoding is collision-free for ordinary session ids; long ids use a digest at the artifact boundary.
  const encoded = Buffer.from(sessionId).toString("hex");
  return PREFIX + (encoded.length <= 160 ? encoded : createHash("sha256").update(sessionId).digest("hex")) + "/turn/";
}
async function repository(git: Git): Promise<void> {
  git.cwd = (await git.run(["rev-parse", "--show-toplevel"])).trim();
}
async function checkpoints(git: Git, sessionId: string): Promise<Checkpoint[]> {
  const prefix = namespace(sessionId);
  const output = await git.run(["for-each-ref", "--format=%(refname) %(objectname) %(tree)", prefix]);
  const result: Checkpoint[] = [];
  for (const line of output.trim().split("\n")) {
    const [ref, commit, tree] = line.split(" ");
    const match = ref?.slice(prefix.length).match(/^(\d+)\/(pre|post)$/);
    if (match) result.push({ ref, commit, tree, turn: Number(match[1]), phase: match[2] as "pre" | "post" });
  }
  result.sort((a, b) => a.turn - b.turn || (a.phase === b.phase ? 0 : a.phase === "pre" ? -1 : 1));
  if (result.length) {
    const root = (await git.run(["show", "-s", "--format=%B", result.at(-1)!.commit])).trim();
    if (root !== JSON.stringify({ cwd: git.cwd })) throw new CheckpointError("different_worktree", "This session's checkpoints belong to a different worktree.");
  }
  return result;
}
async function boundedTree(git: Git, index: string): Promise<string> {
  const gitDir = (await git.run(["rev-parse", "--absolute-git-dir"])).trim();
  const commonDir = (await git.run(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const realIndex = join(gitDir, "index");
  let copied = false;
  try {
    const info = await lstat(realIndex);
    await copyFile(realIndex, index);
    // Preserve Git's racy-clean boundary: round the copied timestamp down, never up.
    await utimes(index, info.atime, Math.floor(info.mtimeMs) / 1000);
    copied = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const head = (await git.run(["rev-parse", "--verify", "--quiet", "HEAD"], undefined, undefined, 1)).trim();
    await git.run(["read-tree", head || "--empty"], index);
  }
  if (copied) {
    const shared = new Map<string, string>();
    for (const dir of new Set([gitDir, commonDir])) {
      for (const name of await readdir(dir)) {
        if (/^sharedindex\.[0-9a-f]+$/.test(name)) shared.set(name, join(dir, name));
      }
    }
    if (shared.size) {
      // Reading a split index freshens sharedindex.*. Unsplit only private copies;
      // use an empty worktree so racy-index checks cannot invoke content filters.
      const privateDir = await mkdtemp(join(dirname(index), "git-"));
      await copyFile(join(gitDir, "HEAD"), join(privateDir, "HEAD"));
      await copyFile(join(commonDir, "config"), join(privateDir, "config"));
      for (const name of ["objects", "refs", "packed-refs"]) {
        const source = join(commonDir, name);
        if (await stat(source)) await symlink(source, join(privateDir, name));
      }
      for (const [name, source] of shared) {
        git.signal.throwIfAborted();
        await copyFile(source, join(privateDir, name));
      }
      const empty = join(privateDir, "empty-worktree");
      await mkdir(empty);
      const before = await lstat(index);
      await git.run(["-C", empty, `--git-dir=${privateDir}`, `--work-tree=${empty}`, "update-index", "--no-split-index"], index);
      await utimes(index, before.atime, Math.floor(before.mtimeMs) / 1000);
    }
  }
  // Clear stat-only differences before applying the delta budget; exit 1 means
  // genuinely modified or missing files remain, not a refresh failure.
  await git.run(["update-index", "--refresh"], index, undefined, 1);
  const [tracked, untracked] = await Promise.all([
    git.run(["diff-files", "--name-only", "--no-renames", "-z"], index),
    git.run(["ls-files", "--others", "--exclude-standard", "-z"], index),
  ]);
  const files = new Set((tracked + untracked).split("\0").filter(Boolean));
  if (files.size > MAX_FILES) throw new CheckpointError("too_large", `Checkpoint skipped: more than ${MAX_FILES} changed/new files.`);
  let bytes = 0;
  for (const file of files) {
    git.signal.throwIfAborted();
    try { bytes += (await lstat(join(git.cwd, file))).size; }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    if (bytes > MAX_BYTES) throw new CheckpointError("too_large", "Checkpoint skipped: more than 64 MiB of changed/new files.");
  }
  if (files.size) {
    const seed = index + ".seed";
    await copyFile(index, seed);
    const conflicts = (await git.run(["ls-files", "--unmerged", "-z"], index)).split("\0").filter(Boolean);
    if (conflicts.length) {
      const paths = [...new Set(conflicts.map(line => line.slice(line.indexOf("\t") + 1)))];
      await git.run(["update-index", "--force-remove", "-z", "--stdin"], seed, paths.join("\0") + "\0");
    }
    const before = (await git.run(["write-tree"], seed)).trim();
    await git.run(["add", "-A", "--", "."], index);
    const after = (await git.run(["write-tree"], index)).trim();
    // A build/editor may create files after the first listing. Validate the
    // actual staged delta before publishing any ref, using immutable blob sizes.
    const changes = (await git.run(["diff-tree", "--no-commit-id", "--raw", "--no-renames", "--no-abbrev", "-r", "-z", before, after], index)).split("\0").filter(Boolean);
    if (changes.length / 2 > MAX_FILES) throw new CheckpointError("too_large", `Checkpoint skipped: more than ${MAX_FILES} staged delta files.`);
    const blobs: string[] = [];
    for (let i = 0; i < changes.length; i += 2) {
      const fields = changes[i].split(" ");
      if (fields[1] !== "000000" && fields[1] !== "160000") blobs.push(fields[3]);
    }
    if (blobs.length) {
      const sizes = await git.run(["cat-file", "--batch-check=%(objectsize)"], index, blobs.join("\n") + "\n");
      if (sizes.trim().split("\n").reduce((sum, value) => sum + Number(value), 0) > MAX_BYTES) {
        throw new CheckpointError("too_large", "Checkpoint skipped: more than 64 MiB of staged delta files.");
      }
    }
    return after;
  }
  const tree = (await git.run(["write-tree"], index)).trim();
  return tree;
}
async function temporary<T>(fn: (index: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "cuelo-turn-checkpoint-"));
  try { return await fn(join(dir, "index")); }
  finally { await rm(dir, { recursive: true, force: true }); }
}
async function save(git: Git, sessionId: string, tree: string, turn: number, phase: "pre" | "post", keep: number): Promise<Checkpoint> {
  // Parentless commits make expired snapshots reclaimable by ordinary git gc.
  const args = ["-c", "user.name=CUELO Checkpoint", "-c", "user.email=checkpoint@localhost", "commit-tree", tree];
  const commit = (await git.run(args, undefined, JSON.stringify({ cwd: git.cwd }) + "\n")).trim();
  const ref = `${namespace(sessionId)}${turn}/${phase}`;
  const all = await checkpoints(git, sessionId);
  const turns = [...new Set([...all.map((entry) => entry.turn), turn])].sort((a, b) => a - b);
  const expired = new Set(turns.slice(0, Math.max(0, turns.length - keep)));
  const deletes = all.filter((entry) => expired.has(entry.turn)).map((entry) => `delete ${entry.ref} ${entry.commit}\n`).join("");
  // Creation and pruning are one ref transaction, never a partially published baseline.
  await git.run(["update-ref", "--stdin"], undefined, `create ${ref} ${commit}\n${deletes}`);
  return { ref, commit, tree, turn, phase };
}
export async function listCheckpoints(cwd: string, sessionId: string): Promise<Checkpoint[]> {
  const git = new Git(cwd, 2000);
  await repository(git);
  return checkpoints(git, sessionId);
}
export async function snapshotTurn(cwd: string, sessionId: string, phase: "pre" | "post", turn?: number, options: CheckpointOptions = {}): Promise<{ turn: number; checkpoint?: Checkpoint }> {
  const git = new Git(cwd, options.timeoutMs ?? 2000);
  await repository(git);
  const all = await checkpoints(git, sessionId);
  const previous = all.at(-1);
  const number = turn ?? (previous?.turn ?? 0) + 1;
  return temporary(async (index) => {
    const tree = await boundedTree(git, index);
    if (tree === previous?.tree) return { turn: number };
    return { turn: number, checkpoint: await save(git, sessionId, tree, number, phase, options.keep ?? 100) };
  });
}
async function entries(git: Git, tree: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const line of (await git.run(["ls-tree", "-rz", tree])).split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    result.set(line.slice(tab + 1), line.slice(0, tab));
  }
  return result;
}
async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return undefined; throw error; }
}
// Refuse obstructions (including ignored files) before the first unlink/checkout.
async function preflight(root: string, current: Map<string, string>, target: Map<string, string>): Promise<void> {
  const inspectDirectory = async (relative: string): Promise<void> => {
    let owned = false;
    for (const child of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = `${relative}/${child.name}`;
      if (child.isDirectory()) { await inspectDirectory(path); owned = true; }
      else if (!current.has(path)) throw new CheckpointError("obstruction", `Restore would overwrite an ignored or unowned path: ${path}`);
      else owned = true;
    }
    if (!owned) throw new CheckpointError("obstruction", `Restore would overwrite an unowned empty directory: ${relative}`);
  };
  for (const path of new Set([...current.keys(), ...target.keys()])) {
    if ((current.get(path)?.startsWith("160000 ") || target.get(path)?.startsWith("160000 ")) && current.get(path) !== target.get(path)) {
      throw new CheckpointError("gitlink_change", `Restore would change a nested repository: ${path}`);
    }
    if (current.get(path) === target.get(path)) continue;
    let parent = dirname(path);
    while (true) {
      const info = await stat(join(root, parent));
      if (info?.isDirectory()) {
        try { await access(join(root, parent), constants.W_OK | constants.X_OK); }
        catch { throw new CheckpointError("obstruction", `Restore parent is not writable: ${parent}`); }
      }
      if (parent === ".") break;
      parent = dirname(parent);
    }
  }
  for (const [path, mode] of target) {
    if (mode.startsWith("160000 ")) continue;
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      const info = await stat(join(root, parent));
      if (info && !info.isDirectory()) {
        if (!current.has(parent) || target.has(parent)) throw new CheckpointError("obstruction", `Restore parent is not a directory: ${parent}`);
        break; // This tracked file/symlink will be unlinked, not traversed.
      }
    }
    // Do not lstat through a tracked symlink that is about to become a directory.
    const blockedParent = parts.slice(0, -1).some((_part, i) => current.has(parts.slice(0, i + 1).join("/")));
    if (blockedParent) continue;
    const info = await stat(join(root, path));
    if (info?.isDirectory()) await inspectDirectory(path);
    else if (info && !current.has(path)) throw new CheckpointError("obstruction", `Restore would overwrite an ignored or unowned path: ${path}`);
  }
}

// lstat on the leaf alone follows intermediate symlinks. Check each parent first,
// including during rollback when the forward overlay may only have partially run.
async function safeOverlayPath(root: string, relative: string): Promise<boolean> {
  const parts = relative.split("/");
  for (let i = 1; i < parts.length; i++) {
    const info = await stat(join(root, ...parts.slice(0, i)));
    if (!info?.isDirectory()) return false;
  }
  return true;
}

async function overlay(git: Git, index: string, from: Map<string, string>, to: Map<string, string>, tree: string): Promise<void> {
  await git.run(["read-tree", tree], index);
  // Only changed ordinary files are materialized. Unchanged read-only paths and gitlinks stay untouched.
  const excluded = [...to].filter(([path, value]) => value.startsWith("160000 ") || from.get(path) === value).map(([path]) => path);
  if (excluded.length) await git.run(["update-index", "--force-remove", "-z", "--stdin"], index, excluded.join("\0") + "\0");
  for (const [path, mode] of from) {
    if (!mode.startsWith("160000 ") && !to.has(path) && await safeOverlayPath(git.cwd, path)) {
      const info = await stat(join(git.cwd, path));
      if (info && !info.isDirectory()) await unlink(join(git.cwd, path));
    }
  }
  const parents = new Set<string>();
  for (const [path, mode] of from) {
    if (mode.startsWith("160000 ") || to.has(path)) continue;
    let parent = dirname(path);
    while (parent !== ".") { parents.add(parent); parent = dirname(parent); }
  }
  for (const path of [...parents].sort((a, b) => b.length - a.length)) {
    if (!await safeOverlayPath(git.cwd, path)) continue;
    try { await rmdir(join(git.cwd, path)); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
  await git.run(["checkout-index", "--all", "--force"], index);
}

export async function restoreCheckpoint(cwd: string, sessionId: string, turn: number, phase: "pre" | "post" = "post"): Promise<Checkpoint> {
  // Restore is explicit, not on the latency-sensitive lifecycle path.
  const git = new Git(cwd, 30_000);
  await repository(git);
  const all = await checkpoints(git, sessionId);
  const latest = all.at(-1);
  const target = all.find((entry) => entry.turn === turn && entry.phase === phase);
  if (!latest || !target) throw new CheckpointError("not_found", "No matching checkpoint in this session.");
  return temporary(async (index) => {
    const currentTree = await boundedTree(git, index);
    if (currentTree !== latest.tree) {
      const changed = (await git.run(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", latest.tree, currentTree], index)).split("\0").filter(Boolean);
      throw new CheckpointError("stale_diff", `stale_diff: checkout changed since the latest checkpoint: ${changed.join(", ")}`, changed);
    }
    const current = await entries(git, currentTree);
    const desired = await entries(git, target.tree);
    await preflight(git.cwd, current, desired);
    await git.run(["read-tree", target.tree], index);
    const gitlinks = [...desired].filter(([, value]) => value.startsWith("160000 ")).map(([path]) => path);
    if (gitlinks.length) await git.run(["update-index", "--force-remove", "-z", "--stdin"], index, gitlinks.join("\0") + "\0");
    // Materialize first so a filter/checkout failure is discovered before any working-tree deletion.
    const preview = join(dirname(index), "preview");
    await mkdir(preview);
    await git.run(["checkout-index", "--all", "--force", `--prefix=${preview}/`], index);
    // Check again after preflight, before the first destructive operation.
    await temporary(async (probe) => {
      if (await boundedTree(git, probe) !== currentTree) throw new CheckpointError("stale_diff", "stale_diff: checkout changed during restore preflight.");
    });
    try {
      await overlay(git, index, current, desired, target.tree);
      // Publishing the restored baseline belongs to the same recoverable operation.
      return await save(new Git(git.cwd, 30_000), sessionId, target.tree, latest.turn + 1, "post", 100);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // The original latest ref remains a recovery point even if the filesystem prevents rollback.
      const recovery = new Git(git.cwd, 30_000);
      try {
        await overlay(recovery, index, desired, current, latest.tree);
        if (await boundedTree(recovery, index) !== currentTree) throw new Error("recovered tree does not match");
      } catch (rollback) {
        throw new CheckpointError("restore_incomplete", `Restore failed (${reason}); automatic recovery failed (${String(rollback)}). Recovery checkpoint: ${latest.ref}`);
      }
      throw new CheckpointError("restore_failed", `Restore failed (${reason}); original checkout recovered from ${latest.ref}.`);
    }
  });
}
