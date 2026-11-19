import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import turnCheckpoint from "../turn-checkpoint";
import { listCheckpoints, restoreCheckpoint, snapshotTurn } from "../lib/turn-checkpoint-git";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8", env: { ...process.env, GIT_INDEX_FILE: undefined, LC_ALL: "C", LANGUAGE: "C" },
  }).trim();
}
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "cuelo-turn-test-")); roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test"); git(root, "config", "user.email", "test@localhost");
  await writeFile(join(root, ".gitignore"), "ignored/\n*.secret\n");
  await writeFile(join(root, "file.txt"), "base\n");
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  return root;
}
async function indexBytes(root: string) { return readFile(git(root, "rev-parse", "--path-format=absolute", "--git-path", "index")); }
interface TestResult { isError?: boolean; details?: { checkpoints?: unknown[]; code?: string } }
interface TestTool { name: string; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: ExtensionContext): Promise<TestResult> }
function harness(root: string, id = "session-one", kind = "main") {
  const handlers: Record<string, (event: object, ctx: ExtensionContext) => Promise<void>> = {};
  const tools: Record<string, TestTool> = {};
  const notes: unknown[] = [];
  const pi = { zod: z, on: (name: string, fn: (event: object, ctx: ExtensionContext) => Promise<void>) => { handlers[name] = fn; }, registerTool: (tool: TestTool) => { tools[tool.name] = tool; }, logger: { debug: (...args: unknown[]) => notes.push(args) } };
  turnCheckpoint(pi as unknown as ExtensionAPI);
  const ctx = { cwd: root, agent: { kind }, sessionManager: { getSessionId: () => id } } as unknown as ExtensionContext;
  return { handlers, ctx, notes, tool: (params: unknown) => tools.checkpoint_restore.execute("test", params, undefined, undefined, ctx) };
}

async function withGitFailure(root: string, body: string, run: () => Promise<void>): Promise<void> {
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = join(root, ".git", "shim"); await mkdir(bin);
  await writeFile(join(bin, "git"), `#!/bin/sh\n${body}\nexec '${realGit}' "$@"\n`); await chmod(join(bin, "git"), 0o755);
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  try { await run(); } finally { process.env.PATH = oldPath; }
}

describe("turn checkpoints", () => {
  test("lifecycle captures changed turns, ignores unchanged turns, preserves staged index/HEAD/branches", async () => {
    const root = await repo();
    await writeFile(join(root, "file.txt"), "staged\n"); git(root, "add", "file.txt");
    await writeFile(join(root, "file.txt"), "working\n");
    const beforeIndex = await indexBytes(root), head = git(root, "rev-parse", "HEAD"), branches = git(root, "show-ref", "--heads");
    const h = harness(root);
    await h.handlers.turn_start({}, h.ctx);
    const baseline = await listCheckpoints(root, "session-one");
    expect(baseline).toHaveLength(1); expect(baseline[0].phase).toBe("pre");
    await h.handlers.turn_end({}, h.ctx);
    expect(await listCheckpoints(root, "session-one")).toHaveLength(1);
    await h.handlers.turn_start({}, h.ctx);
    await writeFile(join(root, "file.txt"), "changed\n");
    await writeFile(join(root, "new.txt"), "untracked\n");
    await mkdir(join(root, "ignored")); await writeFile(join(root, "ignored", "private"), "secret");
    await h.handlers.turn_end({}, h.ctx);
    const all = await listCheckpoints(root, "session-one");
    expect(all.map((cp) => [cp.turn, cp.phase])).toEqual([[1, "pre"], [2, "post"]]);
    expect(git(root, "show", `${all[1].ref}:new.txt`)).toBe("untracked");
    expect(git(root, "ls-tree", "-r", "--name-only", all[1].ref)).not.toContain("private");
    expect(await indexBytes(root)).toEqual(beforeIndex);
    expect(git(root, "show", ":file.txt")).toBe("staged");
    expect(git(root, "rev-parse", "HEAD")).toBe(head); expect(git(root, "show-ref", "--heads")).toBe(branches);
    expect(h.notes).toHaveLength(0);
  });

  test("restore overlays tracked/untracked files without changing index, and remains restorable", async () => {
    const root = await repo();
    await writeFile(join(root, "untracked.txt"), "keep me");
    const first = (await snapshotTurn(root, "restore", "pre")).checkpoint!;
    await writeFile(join(root, "file.txt"), "later");
    await rm(join(root, "untracked.txt")); await writeFile(join(root, "added.txt"), "remove me");
    const second = (await snapshotTurn(root, "restore", "post")).checkpoint!;
    const before = await indexBytes(root), head = git(root, "rev-parse", "HEAD");
    await restoreCheckpoint(root, "restore", first.turn, "pre");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe("keep me");
    expect(await Bun.file(join(root, "added.txt")).exists()).toBe(false);
    expect(await indexBytes(root)).toEqual(before); expect(git(root, "rev-parse", "HEAD")).toBe(head);
    await restoreCheckpoint(root, "restore", second.turn);
    expect(await readFile(join(root, "added.txt"), "utf8")).toBe("remove me");
  });

  test("stale_diff reports changed files and leaves the checkout untouched", async () => {
    const root = await repo(); await snapshotTurn(root, "stale", "post");
    await writeFile(join(root, "file.txt"), "human edit"); await writeFile(join(root, "new.txt"), "human new");
    await expect(restoreCheckpoint(root, "stale", 1)).rejects.toMatchObject({ code: "stale_diff", changedFiles: ["file.txt", "new.txt"] });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("human edit");
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("human new");
  });

  test("prunes to the last 100 turns and namespaces sessions", async () => {
    const root = await repo();
    let expired = "";
    for (let i = 1; i <= 102; i++) {
      await writeFile(join(root, "file.txt"), String(i));
      const saved = await snapshotTurn(root, "prune", "post");
      if (i === 1) expired = saved.checkpoint!.commit;
    }
    const all = await listCheckpoints(root, "prune");
    expect(all).toHaveLength(100); expect(all[0].turn).toBe(3); expect(all.at(-1)!.turn).toBe(102);
    expect(git(root, "rev-list", "--count", all.at(-1)!.ref)).toBe("1");
    expect(git(root, "fsck", "--unreachable", "--no-reflogs")).toContain(`unreachable commit ${expired}`);
    await snapshotTurn(root, "another", "post"); expect(await listCheckpoints(root, "another")).toHaveLength(1);
    expect(await listCheckpoints(root, "prune")).toHaveLength(100);
  }, 30_000);

  test("worktree refs share the common dir but another checkout cannot restore them", async () => {
    const root = await repo(), worktree = join(root, "linked");
    git(root, "worktree", "add", "-qb", "linked", worktree);
    const cp = (await snapshotTurn(worktree, "linked-session", "post")).checkpoint!;
    expect(git(root, "rev-parse", cp.ref)).toBe(cp.commit);
    await expect(restoreCheckpoint(root, "linked-session", cp.turn)).rejects.toMatchObject({ code: "different_worktree" });
    await writeFile(join(worktree, "file.txt"), "linked"); await snapshotTurn(worktree, "linked-session", "post");
    await restoreCheckpoint(worktree, "linked-session", cp.turn);
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("base\n");
    const main = (await snapshotTurn(root, "main-session", "post")).checkpoint!;
    await writeFile(join(root, "file.txt"), "outer edit"); await snapshotTurn(root, "main-session", "post");
    await restoreCheckpoint(root, "main-session", main.turn);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(worktree, "file.txt"), "utf8")).toBe("base\n");
    await writeFile(join(worktree, "file.txt"), "nested commit"); git(worktree, "add", "."); git(worktree, "commit", "-qm", "nested");
    await snapshotTurn(root, "main-session", "post");
    await expect(restoreCheckpoint(root, "main-session", main.turn)).rejects.toMatchObject({ code: "gitlink_change" });
  });

  test("file/directory transitions restore and ignored obstructions refuse before mutation", async () => {
    const root = await repo();
    await mkdir(join(root, "dir")); await writeFile(join(root, "dir", "child"), "child");
    const first = (await snapshotTurn(root, "transition", "post")).checkpoint!;
    await rm(join(root, "dir"), { recursive: true }); await writeFile(join(root, "dir"), "file");
    await snapshotTurn(root, "transition", "post");
    await restoreCheckpoint(root, "transition", first.turn);
    expect(await readFile(join(root, "dir", "child"), "utf8")).toBe("child");
    await writeFile(join(root, "dir", "private.secret"), "private");
    const index = await indexBytes(root);
    await expect(restoreCheckpoint(root, "transition", 2)).rejects.toMatchObject({ code: "obstruction" });
    expect(await readFile(join(root, "dir", "child"), "utf8")).toBe("child");
    expect(await readFile(join(root, "dir", "private.secret"), "utf8")).toBe("private"); expect(await indexBytes(root)).toEqual(index);
  });

  test("symlink parents are replaced without traversing an external target", async () => {
    const root = await repo(), external = await mkdtemp(join(tmpdir(), "cuelo-external-")); roots.push(external);
    await writeFile(join(external, "child"), "external");
    await mkdir(join(root, "dir")); await writeFile(join(root, "dir", "child"), "checkpoint");
    const first = (await snapshotTurn(root, "symlink", "post")).checkpoint!;
    await rm(join(root, "dir"), { recursive: true }); await symlink(external, join(root, "dir"));
    await snapshotTurn(root, "symlink", "post"); await restoreCheckpoint(root, "symlink", first.turn);
    expect(await readFile(join(root, "dir", "child"), "utf8")).toBe("checkpoint");
    expect(await readFile(join(external, "child"), "utf8")).toBe("external");
  });

  test("Main-only tool lists/restores; Makers are refused; non-git cwd is quietly skipped", async () => {
    const root = await repo(), h = harness(root);
    await h.handlers.turn_start({}, h.ctx); await writeFile(join(root, "file.txt"), "tool edit"); await h.handlers.turn_end({}, h.ctx);
    expect((await h.tool({ action: "list" })).details?.checkpoints).toHaveLength(2);
    const result = await h.tool({ action: "restore", turn: 1, phase: "pre" });
    expect(result.isError).toBeUndefined(); expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
    expect((await harness(root, "session-one", "sub").tool({ action: "restore", turn: 1 })).details?.code).toBe("main_only");
    const outside = await mkdtemp(join(tmpdir(), "cuelo-not-git-")); roots.push(outside);
    const other = harness(outside); await other.handlers.turn_end({}, other.ctx); expect(other.notes).toHaveLength(1);
  });

  test("timeout skips snapshots without creating refs", async () => {
    const root = await repo();
    await expect(snapshotTurn(root, "timeout", "post", undefined, { timeoutMs: 1 })).rejects.toBeDefined();
    expect(await listCheckpoints(root, "timeout")).toHaveLength(0);
  });

  test("read-only parent refuses before any deletion (R1-ANT-1)", async () => {
    const root = await repo(); await snapshotTurn(root, "permissions", "post");
    await writeFile(join(root, "a.txt"), "do not delete");
    await mkdir(join(root, "ro")); await writeFile(join(root, "ro", "x.txt"), "locked");
    await snapshotTurn(root, "permissions", "post"); await chmod(join(root, "ro"), 0o555);
    try {
      await expect(restoreCheckpoint(root, "permissions", 1)).rejects.toMatchObject({ code: "obstruction" });
      expect(await readFile(join(root, "a.txt"), "utf8")).toBe("do not delete");
    } finally { await chmod(join(root, "ro"), 0o755); }
  });

  test("unowned empty directory refuses before any deletion (R1-ADV-1)", async () => {
    const root = await repo(); await writeFile(join(root, "d"), "target"); await snapshotTurn(root, "empty-dir", "post");
    await rm(join(root, "d")); await mkdir(join(root, "d")); await writeFile(join(root, "a.txt"), "do not delete");
    await snapshotTurn(root, "empty-dir", "post");
    await expect(restoreCheckpoint(root, "empty-dir", 1)).rejects.toMatchObject({ code: "obstruction" });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("do not delete");
  });

  test("checkout failure after deletion recovers the original tree (R1-ANT-1)", async () => {
    const root = await repo();
    await writeFile(join(root, ".gitattributes"), "file.txt filter=probe\n");
    git(root, "config", "filter.probe.clean", "cat");
    git(root, "config", "filter.probe.required", "true");
    git(root, "config", "filter.probe.smudge", 'n=$(cat .git/probe-count 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > .git/probe-count; if [ "$n" = 2 ]; then exit 1; fi; cat');
    await snapshotTurn(root, "recovery", "post");
    await writeFile(join(root, "file.txt"), "later"); await writeFile(join(root, "a.txt"), "recover me");
    await snapshotTurn(root, "recovery", "post");
    const index = await indexBytes(root);
    await expect(restoreCheckpoint(root, "recovery", 1)).rejects.toMatchObject({ code: "restore_failed" });
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("later");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("recover me");
    expect(await indexBytes(root)).toEqual(index);
    expect(await listCheckpoints(root, "recovery")).toHaveLength(2);
  });

  test("rollback never traverses surviving symlink parents (R2-ANT-1)", async () => {
    const root = await repo(), external = await mkdtemp(join(tmpdir(), "cuelo-outside-")); roots.push(external);
    await writeFile(join(external, "file.txt"), "external");
    await mkdir(join(root, "link")); await writeFile(join(root, "link", "file.txt"), "inside");
    const target = (await snapshotTurn(root, "rollback-link", "post")).checkpoint!;
    await rm(join(root, "link"), { recursive: true }); await symlink(external, join(root, "link"));
    await snapshotTurn(root, "rollback-link", "post");
    await withGitFailure(root, `case " $* " in *" read-tree ${target.tree} "*) n=$(cat .git/counter 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > .git/counter; if [ "$n" = 2 ]; then exit 1; fi ;; esac`, async () => {
      await expect(restoreCheckpoint(root, "rollback-link", 1)).rejects.toMatchObject({ code: "restore_failed" });
      expect(await readFile(join(external, "file.txt"), "utf8")).toBe("external");
    });
  });

  test("unchanged files in readonly directories are untouched (R2-ANT-2 R2-ADV-1)", async () => {
    const root = await repo(); await mkdir(join(root, "ro", "sub"), { recursive: true }); await writeFile(join(root, "ro", "sub", "keep.txt"), "keep");
    await snapshotTurn(root, "readonly-unchanged", "post"); await writeFile(join(root, "file.txt"), "later");
    await snapshotTurn(root, "readonly-unchanged", "post"); await chmod(join(root, "ro"), 0o555);
    try {
      await restoreCheckpoint(root, "readonly-unchanged", 1);
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
      expect(await readFile(join(root, "ro", "sub", "keep.txt"), "utf8")).toBe("keep");
    } finally { await chmod(join(root, "ro"), 0o755); }
  });

  test("baseline save failure recovers the original tree (R2-ANT-3)", async () => {
    const root = await repo(); await snapshotTurn(root, "save-failure", "post");
    await writeFile(join(root, "file.txt"), "later"); await snapshotTurn(root, "save-failure", "post");
    await withGitFailure(root, 'case " $* " in *" commit-tree "*) exit 1 ;; esac', async () => {
      await expect(restoreCheckpoint(root, "save-failure", 1)).rejects.toMatchObject({ code: "restore_failed" });
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("later");
      expect(await listCheckpoints(root, "save-failure")).toHaveLength(2);
    });
  });

  test("unborn nested repository produces a typed skip (R2-ANT-4)", async () => {
    const root = await repo(); await mkdir(join(root, "sub")); git(join(root, "sub"), "init", "-q");
    await expect(snapshotTurn(root, "unborn", "pre")).rejects.toMatchObject({ code: "unsupported" });
    expect(await listCheckpoints(root, "unborn")).toHaveLength(0);
  });

  test("read-only ancestor refuses in preflight, not after unlink (R3-ADV-2)", async () => {
    const root = await repo(); await mkdir(join(root, "ro", "sub"), { recursive: true });
    await writeFile(join(root, "ro", "sub", "keep.txt"), "keep"); await snapshotTurn(root, "ancestor", "post");
    await writeFile(join(root, "ro", "sub", "del.txt"), "retain on refusal"); await snapshotTurn(root, "ancestor", "post");
    await chmod(join(root, "ro"), 0o555);
    try {
      await expect(restoreCheckpoint(root, "ancestor", 1)).rejects.toMatchObject({ code: "obstruction" });
      expect(await readFile(join(root, "ro", "sub", "del.txt"), "utf8")).toBe("retain on refusal");
    } finally { await chmod(join(root, "ro"), 0o755); }
  });

  test("unchanged long paths do not exceed argv limits (R3-ANT-1 R3-ADV-1)", async () => {
    const root = await repo();
    const relative = Array.from({ length: 15 }, (_, i) => `d${i}-${"x".repeat(180)}`).join("/");
    await mkdir(join(root, relative), { recursive: true });
    for (let batch = 0; batch < 9; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, relative, `f${batch * 100 + i}`), "x")));
    }
    await snapshotTurn(root, "long-paths", "post", undefined, { timeoutMs: 30_000 });
    await writeFile(join(root, "file.txt"), "later");
    await snapshotTurn(root, "long-paths", "post", undefined, { timeoutMs: 30_000 });
    await restoreCheckpoint(root, "long-paths", 1);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
    expect(await readFile(join(root, relative, "f899"), "utf8")).toBe("x");
    // R4-ANT-1: git exits before consuming the multi-MiB stdin payload.
    await writeFile(join(root, "file.txt"), "later");
    await snapshotTurn(root, "long-paths", "post", undefined, { timeoutMs: 30_000 });
    await withGitFailure(root, 'case " $* " in *" update-index --force-remove "*) exit 1 ;; esac', async () => {
      await expect(restoreCheckpoint(root, "long-paths", 1)).rejects.toMatchObject({ code: "restore_incomplete" });
      expect(await readFile(join(root, "file.txt"), "utf8")).toBe("later");
    });
  }, 30_000);

  test("large tracked tree snapshots a small delta without touching its index (TC-1)", async () => {
    const root = await repo(); await mkdir(join(root, "large"));
    for (let batch = 0; batch < 110; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(root, "large", `f${batch * 100 + i}`), "tracked")));
    }
    git(root, "add", "."); git(root, "commit", "-qm", "large tracked tree");
    const index = await indexBytes(root);
    const touched = new Date(Date.now() + 3600_000);
    for (let batch = 0; batch < 110; batch++) {
      await Promise.all(Array.from({ length: 100 }, (_, i) => utimes(join(root, "large", `f${batch * 100 + i}`), touched, touched)));
    }
    await writeFile(join(root, "large", "f0"), "small edit"); await writeFile(join(root, "new.txt"), "small new");
    const saved = await snapshotTurn(root, "large-tree", "post");
    expect(saved.checkpoint).toBeDefined();
    expect(git(root, "show", `${saved.checkpoint!.ref}:large/f0`)).toBe("small edit");
    expect(git(root, "show", `${saved.checkpoint!.ref}:new.txt`)).toBe("small new");
    expect((await snapshotTurn(root, "large-tree", "post")).checkpoint).toBeUndefined();
    expect(await indexBytes(root)).toEqual(index);
  }, 30_000);

  test("split index fallback leaves the real index and sharedindex unchanged (TC-1)", async () => {
    const root = await repo(); git(root, "config", "core.splitIndex", "true"); git(root, "update-index", "--split-index");
    const shared = git(root, "rev-parse", "--path-format=absolute", "--shared-index-path");
    const before = await readFile(shared), info = await lstat(shared), index = await indexBytes(root);
    const sharedNames = (await readdir(dirname(shared))).filter(name => name.startsWith("sharedindex.")).sort();
    const clean = (await snapshotTurn(root, "split-index", "post")).checkpoint!;
    await restoreCheckpoint(root, "split-index", clean.turn);
    expect((await lstat(shared)).mtimeMs).toBe(info.mtimeMs);
    await writeFile(join(root, "file.txt"), "human change");
    await expect(restoreCheckpoint(root, "split-index", clean.turn)).rejects.toMatchObject({ code: "stale_diff" });
    expect((await lstat(shared)).mtimeMs).toBe(info.mtimeMs);
    await writeFile(join(root, "file.txt"), "split edit");
    const cp = (await snapshotTurn(root, "split-index", "post")).checkpoint!;
    expect(git(root, "show", `${cp.ref}:file.txt`)).toBe("split edit");
    expect(await indexBytes(root)).toEqual(index); expect(await readFile(shared)).toEqual(before);
    expect((await lstat(shared)).mtimeMs).toBe(info.mtimeMs);
    expect((await readdir(dirname(shared))).filter(name => name.startsWith("sharedindex.")).sort()).toEqual(sharedNames);
  });

  test("absent index falls back to HEAD and literal delta names without creating a real index (TC-1)", async () => {
    const root = await repo(), index = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index");
    await rm(index); await writeFile(join(root, ":(glob)*"), "literal path");
    const cp = (await snapshotTurn(root, "no-index", "post")).checkpoint!;
    expect(git(root, "show", `${cp.ref}::(glob)*`)).toBe("literal path");
    expect(git(root, "show", `${cp.ref}:file.txt`)).toBe("base");
    expect(await Bun.file(index).exists()).toBe(false);
  });

  test("delta byte budget still refuses oversized changed files (TC-1)", async () => {
    const root = await repo(); await writeFile(join(root, "oversized"), ""); await truncate(join(root, "oversized"), 65 * 1024 * 1024);
    await expect(snapshotTurn(root, "oversized-delta", "post")).rejects.toMatchObject({ code: "too_large" });
    expect(await listCheckpoints(root, "oversized-delta")).toHaveLength(0);
  });

  test("filters and conditional config keep the real Git directory (TC-1 review)", async () => {
    const root = await repo(), gitDir = git(root, "rev-parse", "--absolute-git-dir");
    await writeFile(join(root, ".gitattributes"), "file.txt filter=location\n");
    git(root, "config", "filter.location.clean", 'printf "%s" "$GIT_DIR" > captured.secret; cat');
    await writeFile(join(root, "file.txt"), "filter edit");
    await writeFile(join(gitDir, "conditional.cfg"), `[core]\nexcludesFile = ${join(gitDir, "conditional-excludes")}\n`);
    await writeFile(join(gitDir, "conditional-excludes"), "conditional.log\n");
    git(root, "config", `includeIf.gitdir:${gitDir}.path`, join(gitDir, "conditional.cfg"));
    await writeFile(join(root, "conditional.log"), "ignored through includeIf");
    const cp = (await snapshotTurn(root, "filter-config", "post")).checkpoint!;
    const captured = await readFile(join(root, "captured.secret"), "utf8");
    expect(captured === "" || resolve(root, captured) === gitDir).toBe(true);
    expect(git(root, "ls-tree", "-r", "--name-only", cp.ref)).not.toContain("conditional.log");
  });

  test("committed directory replacement and vanishing untracked files snapshot safely (TC-1 review)", async () => {
    const root = await repo(); await mkdir(join(root, "dir")); await writeFile(join(root, "dir", "child"), "child");
    git(root, "add", "."); git(root, "commit", "-qm", "tracked directory");
    await rm(join(root, "dir"), { recursive: true }); await writeFile(join(root, "dir"), "replacement");
    await writeFile(join(root, "new.txt"), "vanishing");
    await withGitFailure(root, 'case " $* " in *" add "*) rm -f new.txt ;; esac', async () => {
      const cp = (await snapshotTurn(root, "replacement", "post")).checkpoint!;
      expect(git(root, "show", `${cp.ref}:dir`)).toBe("replacement");
      expect(git(root, "ls-tree", "-r", "--name-only", cp.ref)).not.toContain("new.txt");
    });
  });

  test("split conversion retains stat cache and user flags without running clean filters (TC-1 review)", async () => {
    const root = await repo(); await mkdir(join(root, "cache"));
    for (let i = 0; i < 20; i++) await writeFile(join(root, "cache", `f${i}`), "cached");
    await writeFile(join(root, ".gitattributes"), "cache/* filter=counter\n");
    git(root, "config", "filter.counter.clean", "echo x >> captured.secret; cat");
    // Racy-clean entries legitimately need content checks, even without split
    // indexes. Give this cache-reuse fixture stable pre-index file timestamps.
    const stable = new Date(Date.now() - 60_000);
    for (let i = 0; i < 20; i++) await utimes(join(root, "cache", `f${i}`), stable, stable);
    git(root, "add", "."); git(root, "commit", "-qm", "filter cache");
    git(root, "update-index", "--assume-unchanged", "cache/f0"); git(root, "update-index", "--skip-worktree", "cache/f1");
    git(root, "config", "core.splitIndex", "true"); git(root, "update-index", "--split-index");
    const index = await indexBytes(root);
    await writeFile(join(root, "captured.secret"), "");
    await writeFile(join(root, "cache", "f0"), "flagged edit"); await writeFile(join(root, "cache", "f1"), "flagged edit");
    const cp = (await snapshotTurn(root, "split-cache", "post")).checkpoint!;
    expect(await readFile(join(root, "captured.secret"), "utf8")).toBe("");
    expect(git(root, "show", `${cp.ref}:cache/f0`)).toBe("cached");
    expect(git(root, "show", `${cp.ref}:cache/f1`)).toBe("cached");
    expect(await indexBytes(root)).toEqual(index);
  });

  test("late oversized files cannot bypass the delta budget (TC-1 review)", async () => {
    const root = await repo(); await writeFile(join(root, "new.txt"), "trigger");
    await withGitFailure(root, 'case " $* " in *" add "*) truncate -s 70M late.bin ;; esac', async () => {
      await expect(snapshotTurn(root, "late-size", "post", undefined, { timeoutMs: 30_000 })).rejects.toMatchObject({ code: "too_large" });
      expect(await listCheckpoints(root, "late-size")).toHaveLength(0);
    });
  });

  test("unmerged source index stays untouched while resolved working files are snapshotted (TC-1 review)", async () => {
    const root = await repo(), blob = git(root, "rev-parse", "HEAD:file.txt");
    execFileSync("git", ["update-index", "--index-info"], { cwd: root, input: `0 ${"0".repeat(blob.length)}\tfile.txt\n` + [1, 2, 3].map(stage => `100644 ${blob} ${stage}\tfile.txt\n`).join("") });
    const index = await indexBytes(root); await writeFile(join(root, "file.txt"), "resolved");
    const cp = (await snapshotTurn(root, "unmerged", "post")).checkpoint!;
    expect(git(root, "show", `${cp.ref}:file.txt`)).toBe("resolved");
    expect(await indexBytes(root)).toEqual(index);
  });

  test("racy same-size split-index edits use the original index timestamp (TC-1 R3-ANT-1)", async () => {
    const root = await repo(), file = join(root, "file.txt"), stamp = 1_700_000_000;
    git(root, "config", "core.trustctime", "false");
    await writeFile(file, "aaaa"); await utimes(file, stamp, stamp); git(root, "add", "file.txt");
    git(root, "config", "core.splitIndex", "true"); git(root, "update-index", "--split-index");
    const realIndex = git(root, "rev-parse", "--path-format=absolute", "--git-path", "index");
    await utimes(realIndex, stamp, stamp);
    const index = await indexBytes(root);
    await writeFile(file, "bbbb"); await utimes(file, stamp, stamp);
    const cp = (await snapshotTurn(root, "racy-split", "post")).checkpoint!;
    expect(git(root, "show", `${cp.ref}:file.txt`)).toBe("bbbb");
    expect(await indexBytes(root)).toEqual(index);
    expect(Math.floor((await lstat(realIndex)).mtimeMs / 1000)).toBe(stamp);
  });
});

// Real SDK loader/runner, isolated HOME and agent DB; no provider or network call.
const SDK_DEMO = String.raw`
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.CP_ROOT, work = process.env.CP_WORK, agentDir = join(root, "agent");
await mkdir(agentDir, { recursive: true });
const auth = await AuthStorage.create(join(agentDir, "agent.db"));
const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
registry.registerProvider("local-test", { baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", api: "openai-completions",
  models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
const errors = [];
const { session } = await createAgentSession({ cwd: work, agentDir, model: registry.find("local-test", "test"), modelRegistry: registry,
  sessionManager: SessionManager.create(work, join(root, "sessions")), settings: Settings.isolated({ tools: { approvalMode: "yolo" } }),
  additionalExtensionPaths: [process.env.CP_EXTENSION], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
  skipPythonPreflight: true, skills: [], rules: [], contextFiles: [], toolNames: ["checkpoint_restore"] });
await initializeExtensions(session, { reportSendError: (action, error) => errors.push(action + ": " + error.message), reportRuntimeError: error => errors.push(String(error.error ?? error)) });
const runner = session.extensionRunner;
const tool = runner.getLoadedExtensions().flatMap(ext => [...ext.tools.values()]).find(item => item.definition.name === "checkpoint_restore").definition;
const call = args => tool.execute("demo", args, undefined, undefined, runner.createContext());
const event = type => runner.emit({ type, turnIndex: 0, timestamp: Date.now(), toolResults: [], message: { role: "assistant", content: [] } });
await event("turn_start");
await writeFile(join(work, "file.txt"), "SDK edit");
await event("turn_end");
const listed = await call({ action: "list" });
await writeFile(join(work, "file.txt"), "human stale edit");
const stale = await call({ action: "restore", turn: 1, phase: "pre" });
await writeFile(join(work, "file.txt"), "SDK edit");
const restored = await call({ action: "restore", turn: 1, phase: "pre" });
const restoredText = await readFile(join(work, "file.txt"), "utf8");
const nonGit = join(root, "non-git"); await mkdir(nonGit);
await session.sessionManager.moveTo(nonGit);
await event("turn_start"); await event("turn_end");
console.log("SDK_DEMO " + JSON.stringify({ kind: runner.createContext().agent.kind, listed, stale, restored, restoredText, errors }));
await session.dispose();
process.exit(0);
`;

test("real SDK Main context lists/restores and non-git lifecycle stays quiet (R1-ANT-4)", async () => {
  const work = await repo(), root = await mkdtemp(join(tmpdir(), "cuelo-sdk-demo-")); roots.push(root);
  const home = join(root, "home"); await mkdir(home);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("XDG_") && key !== "PI_CODING_AGENT_DIR" && !key.startsWith("GIT_")));
  const child = Bun.spawn([process.execPath, "-e", SDK_DEMO], {
    cwd: resolve(dirname(import.meta.path), "../../../.."),
    env: { ...inherited, HOME: home, CP_ROOT: root, CP_WORK: work, CP_EXTENSION: resolve(dirname(import.meta.path), "../turn-checkpoint.ts") },
    stdout: "pipe", stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const line = out.split("\n").find(item => item.startsWith("SDK_DEMO "));
  if (code !== 0 || !line) throw new Error(`SDK demo exit ${code}\n${out}\n${err}`);
  const observed = JSON.parse(line.slice(9));
  expect(observed.kind).toBe("main");
  expect(observed.listed.details.checkpoints).toHaveLength(2);
  expect(observed.stale.details.code).toBe("stale_diff");
  expect(observed.restored.isError).toBeUndefined();
  expect(observed.restoredText).toBe("base\n");
  expect(observed.errors).toEqual([]);
  console.log(line);
}, 30_000);
