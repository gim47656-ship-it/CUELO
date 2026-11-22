import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREPARE_LOG, PREPARE_STATUS, PREPARE_STATUS_ENV, startWorktreePrepare, type PrepareChild, type Spawner } from "./prepare";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tree(scripts?: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "cuelo-prepare-test-")); roots.push(root);
  const worktree = join(root, "tree"); mkdirSync(worktree);
  const gitDir = join(root, "gitdir");
  if (scripts) writeFileSync(join(worktree, "package.json"), JSON.stringify({ scripts }));
  return { worktree, gitDir };
}
function fakeSpawner() {
  const calls: { command: string; args: string[]; cwd?: string | URL; env?: NodeJS.ProcessEnv; detached?: boolean }[] = [];
  const listeners = new Map<string, (...args: never[]) => void>();
  let unrefs = 0;
  const child: PrepareChild = {
    once(event: string, listener: (...args: never[]) => void) { listeners.set(event, listener); return child; },
    unref() { unrefs++; },
  } as PrepareChild;
  const spawner: Spawner = (command, args, options) => { calls.push({ command, args, cwd: options.cwd, env: options.env, detached: options.detached }); return child; };
  return { spawner, calls, exit: (code: number | null) => (listeners.get("exit") as (code: number | null) => void)(code), unrefs: () => unrefs };
}
const status = (gitDir: string) => JSON.parse(readFileSync(join(gitDir, PREPARE_STATUS), "utf8"));

describe("worktree prepare convention", () => {
  test("script present: starts bun run prepare:worktree detached in the worktree, logs outside the checkout", async () => {
    const t = tree({ "prepare:worktree": "node prep.js" }); const fake = fakeSpawner();
    expect(await startWorktreePrepare(t.worktree, t.gitDir, fake.spawner)).toBe(true);
    expect(await startWorktreePrepare(t.worktree, t.gitDir, fake.spawner)).toBe(false);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({ command: "bun", args: ["run", "prepare:worktree"], cwd: t.worktree, detached: true });
    expect(fake.calls[0].env?.[PREPARE_STATUS_ENV]).toBe(join(t.gitDir, PREPARE_STATUS));
    expect(fake.unrefs()).toBe(1);
    expect(existsSync(join(t.gitDir, PREPARE_LOG))).toBe(true);
    expect(existsSync(join(t.worktree, PREPARE_LOG))).toBe(false);
    expect(status(t.gitDir).state).toBe("running");
  });
  test("agent shells do not inherit the Next server env", async () => {
    const t = tree({ "prepare:worktree": "x" }); const fake = fakeSpawner();
    const saved = { runtime: process.env.NEXT_RUNTIME, priv: process.env.__NEXT_PRIVATE_ORIGIN };
    process.env.NEXT_RUNTIME = "nodejs"; process.env.__NEXT_PRIVATE_ORIGIN = "http://x";
    try { await startWorktreePrepare(t.worktree, t.gitDir, fake.spawner); }
    finally {
      for (const [key, value] of [["NEXT_RUNTIME", saved.runtime], ["__NEXT_PRIVATE_ORIGIN", saved.priv]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    expect(fake.calls[0].env).not.toHaveProperty("NEXT_RUNTIME");
    expect(fake.calls[0].env).not.toHaveProperty("__NEXT_PRIVATE_ORIGIN");
  });
  test("script absent, no scripts, broken package.json or no git dir: nothing starts", async () => {
    const fake = fakeSpawner();
    const none = tree(); const other = tree({ build: "x" }); const broken = tree(); writeFileSync(join(broken.worktree, "package.json"), "{");
    for (const t of [none, other, broken]) expect(await startWorktreePrepare(t.worktree, t.gitDir, fake.spawner)).toBe(false);
    const withScript = tree({ "prepare:worktree": "x" });
    expect(await startWorktreePrepare(withScript.worktree, undefined, fake.spawner)).toBe(false);
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(join(none.gitDir, PREPARE_STATUS))).toBe(false);
  });
  test("supervisor records a crash only when the script did not report its own result", async () => {
    const crashed = tree({ "prepare:worktree": "x" }); const a = fakeSpawner();
    await startWorktreePrepare(crashed.worktree, crashed.gitDir, a.spawner); a.exit(3);
    expect(status(crashed.gitDir)).toMatchObject({ state: "failed", exitCode: 3 });
    const reported = tree({ "prepare:worktree": "x" }); const b = fakeSpawner();
    await startWorktreePrepare(reported.worktree, reported.gitDir, b.spawner);
    writeFileSync(join(reported.gitDir, PREPARE_STATUS), JSON.stringify({ state: "failed", step: "install", exitCode: 1 }));
    b.exit(1);
    expect(status(reported.gitDir)).toEqual({ state: "failed", step: "install", exitCode: 1 });
  });
  test("a spawn that throws never fails the caller", async () => {
    const t = tree({ "prepare:worktree": "x" });
    expect(await startWorktreePrepare(t.worktree, t.gitDir, () => { throw new Error("no bun"); })).toBe(false);
    expect(status(t.gitDir)).toMatchObject({ state: "failed", error: "no bun" });
    expect(typeof status(t.gitDir).finishedAt).toBe("string");
  });
});
