import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runResolve, runReview, spawnExec } from "../../extensions/lib/cross-review";
import { createRoutingLedger, readCrossReviewRecords } from "../../extensions/lib/routing-ledger";
import { appendSlopRecord, readSlopRecords, runSlopGate, sha256 } from "../../extensions/lib/slop-gate";
import { finalizeTool as factory, hasPosixGitdirWorktree, windowsDrivePaths } from "./index";
import { selectGitExecutor, windowsPathToPosix } from "./wsl-git";

const scriptPath = fileURLToPath(new URL("./finalizer.ps1", import.meta.url));
const powerShell = process.platform === "win32" ? "powershell.exe" : "pwsh";

const tempRoots: string[] = [];
// 각 테스트는 PowerShell 5.1 기동과 bare remote push를 실제로 한다. GitHub Windows 러너에서 평소 2~7초지만
// 느린 순간 20초까지 걸려 15초 제한을 넘긴 적이 있다(run 36151513593).
const TEST_TIMEOUT_MS = 60_000;

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface FinalizerOutput {
  ok: boolean;
  stage: string;
  error?: string;
  commitSha?: string;
  resumedPush?: boolean;
  outsideCwdReason?: string;
  leftoverScope?: string;
  leftoverTotal?: number;
  leftoverFiles?: string[];
}

function run(command: string, args: string[], cwd?: string): CommandResult {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function git(cwd: string, args: string[], expectedCode = 0): string {
  const result = run("git", args, cwd);
  expect(result.code, result.stderr || result.stdout).toBe(expectedCode);
  return result.stdout;
}

async function createRepository(tempParent = tmpdir()): Promise<{ root: string; remote: string; work: string }> {
  const root = await mkdtemp(join(tempParent, "omp-finalizer-test-"));
  tempRoots.push(root);
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  await mkdir(work);
  expect(run("git", ["init", "--bare", remote]).code).toBe(0);
  expect(run("git", ["init", "--initial-branch=main"], work).code).toBe(0);
  git(work, ["config", "user.name", "OMP Finalizer Test"]);
  git(work, ["config", "user.email", "omp-finalizer@example.invalid"]);
  await writeFile(join(work, "a.txt"), "base-a\n");
  await writeFile(join(work, "b.txt"), "base-b\n");
  git(work, ["add", "--", "a.txt", "b.txt"]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "-u", "origin", "main"]);
  return { root, remote, work };
}

async function createAdditionalRepository(
  root: string,
  name: string,
): Promise<{ remote: string; work: string }> {
  const remote = join(root, `${name}-remote.git`);
  const work = join(root, name);
  await mkdir(work);
  expect(run("git", ["init", "--bare", remote]).code).toBe(0);
  expect(run("git", ["init", "--initial-branch=main"], work).code).toBe(0);
  git(work, ["config", "user.name", "OMP Finalizer Test"]);
  git(work, ["config", "user.email", "omp-finalizer@example.invalid"]);
  await writeFile(join(work, "a.txt"), `base-${name}-a\n`);
  await writeFile(join(work, "b.txt"), `base-${name}-b\n`);
  git(work, ["add", "--", "a.txt", "b.txt"]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "-u", "origin", "main"]);
  return { remote, work };
}

async function createManifestRepository() {
  const repository = await createRepository();
  const { work } = repository;
  const helper = join(work, "Tools", "CUELO_Setup", "files");
  await mkdir(helper, { recursive: true });
  await writeFile(join(helper, "source-build-helper.js"), "// fixture helper\n");
  await writeFile(join(work, "package.json"), JSON.stringify({ files: ["Tools/runtime/entry.js"] }));
  await mkdir(join(work, "Tools", "runtime"), { recursive: true });
  await writeFile(join(work, "Tools", "runtime", "entry.js"), "runtime\n");
  const sourceHash = (text: string) =>
    createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
  const manifestPath = join(helper, "source-integrity.json");
  await writeFile(manifestPath, JSON.stringify({
    files: {
      "a.txt": sourceHash("base-a\n"),
      "b.txt": sourceHash("base-b\n"),
      "package.json": sourceHash(JSON.stringify({ files: ["Tools/runtime/entry.js"] })),
      "Tools/runtime/entry.js": sourceHash("runtime\n"),
    },
  }));
  git(work, ["add", "--", "package.json", "Tools"]);
  git(work, ["commit", "-m", "manifest fixture"]);
  git(work, ["push"]);
  return { ...repository, manifestPath };
}

// 도구 스키마 선언이 체인(`.optional()`)을 쓰므로 어느 호출이든 자기 자신을 돌려주는 값으로 받는다.
const schemaNode: object = new Proxy(function node() {}, { get: () => schemaNode, apply: () => schemaNode });

async function startTool(
  work: string,
  files: string[],
  extra: Record<string, unknown> = {},
  artifactsDir?: string,
): Promise<{ error?: Error; output?: unknown }> {
  const pi = {
    cwd: work,
    zod: { object: () => ({}), array: () => schemaNode, string: () => schemaNode, boolean: () => schemaNode },
    exec: async (command: string, args: string[], options: { cwd: string }) => run(command, args, options.cwd),
  };
  const tool = factory(pi as never);
  try {
    const ctx = artifactsDir ? { sessionManager: { getArtifactManager: () => ({ dir: artifactsDir }) } } : {};
    return { output: await tool.execute("fixture", { files, message: "manifest case", ...extra }, undefined, ctx as never, new AbortController().signal) };
  } catch (error) {
    return { error: error as Error };
  }
}

async function getUnusedDriveLetter(): Promise<string> {
  for (let code = "Z".charCodeAt(0); code >= "T".charCodeAt(0); code -= 1) {
    const drive = `${String.fromCharCode(code)}:`;
    try {
      await access(`${drive}\\`);
    } catch {
      return drive;
    }
  }
  throw new Error("No unused drive letter is available for the drive-root repository test.");
}

async function startFinalizer(
  root: string,
  work: string,
  name: string,
  files: string[],
  message: string,
  extra: Record<string, unknown> = {},
): Promise<{ result: CommandResult; output: FinalizerOutput }> {
  const request = join(root, `${name}.json`);
  await writeFile(request, JSON.stringify({ cwd: work, files, message, ...extra }), "utf8");
  const process = Bun.spawn({
    cmd: [powerShell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Request", request],
    cwd: work,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
  const line = result.stdout.split(/\r?\n/).filter(Boolean).at(-1);
  if (!line) throw new Error(`Finalizer returned no JSON. stderr=${result.stderr}`);
  return { result, output: JSON.parse(line) as FinalizerOutput };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("git finalizer", () => {
  test("rejects an unrequested dependency before commit and publishes its self-contained control", async () => {
    const { root, remote, work } = await createRepository(homedir());
    const artifacts = join(root, "artifacts");
    await writeFile(join(work, "app.mjs"), "export {};\n");
    await writeFile(join(work, ".finalize-checks.json"), JSON.stringify({
      version: 1, checks: [{ name: "candidate smoke", paths: ["app.mjs"], command: [process.execPath, "app.mjs"] }],
    }));
    git(work, ["add", "--", "app.mjs", ".finalize-checks.json"]);
    git(work, ["commit", "-m", "configure candidate smoke"]);
    git(work, ["push"]);
    const head = git(work, ["rev-parse", "HEAD"]);
    const beforeWorktrees = git(work, ["worktree", "list", "--porcelain"]);

    await writeFile(join(work, "app.mjs"), 'import "./dep.mjs";\n');
    await writeFile(join(work, "dep.mjs"), "export {};\n");
    const refused = await startTool(work, ["app.mjs"], {}, artifacts);
    expect(refused.error?.message).toMatch(/git_finalize failed at finalize-checks: candidate smoke exited 1/);
    expect(refused.error?.message).toContain("dep.mjs");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(head);
    expect(git(work, ["worktree", "list", "--porcelain"])).toBe(beforeWorktrees);

    const passed = await startTool(work, ["app.mjs", "dep.mjs"], {}, artifacts);
    expect(passed.error).toBeUndefined();
    expect(passed.output).toMatchObject({ details: { stage: "complete" } });
    const commit = git(work, ["rev-parse", "HEAD"]);
    expect(commit).not.toBe(head);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(commit);
    expect(git(work, ["show", "--format=", "--name-only", "HEAD"]).split("\n")).toEqual(["app.mjs", "dep.mjs"]);
  }, TEST_TIMEOUT_MS);

  test("configured publication check refuses false before commit and pushes after true", async () => {
    const { root, remote, work } = await createRepository(homedir());
    const artifactsDir = join(root, "artifacts");
    const command = 'const fs = require("node:fs"); if (fs.readFileSync("a.txt", "utf8").trim() !== "to publish" || fs.readFileSync("b.txt", "utf8").trim() !== "base-b") process.exit(1)';
    await writeFile(join(work, ".finalize-checks.json"), JSON.stringify({
      version: 1, checks: [{ name: "fixture", paths: ["a.txt"], command: [process.execPath, "-e", command] }],
    }));
    git(work, ["add", "--", ".finalize-checks.json"]);
    git(work, ["commit", "-m", "configure checks"]);
    git(work, ["push"]);
    const head = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "broken\n");
    await writeFile(join(work, "b.txt"), "other session WIP\n");
    const failed = await startTool(work, ["a.txt"], {}, artifactsDir);
    expect(failed.error?.message).toContain("git_finalize failed at finalize-checks: fixture exited 1");
    expect(failed.error?.message).toContain("b.txt");
    expect(failed.error?.message).toContain("isolated publication candidate");
    const log = failed.error?.message.match(/^Full log: (.+)$/m)?.[1];
    expect(log).toBeDefined();
    expect(await readFile(log!, "utf8")).toBe("");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(head);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");

    await writeFile(join(work, "a.txt"), "to publish\n");
    const passed = await startTool(work, ["a.txt"], {}, artifactsDir);
    expect(passed.error).toBeUndefined();
    expect(passed.output).toMatchObject({
      details: { stage: "complete" },
      content: [{ text: expect.stringMatching(/fixture ran \(\d+(?:\.\d+)?s\)/) }],
    });
    const commit = git(work, ["rev-parse", "HEAD"]);
    expect(commit).not.toBe(head);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(commit);
    expect(git(work, ["show", "--format=", "--name-only", "HEAD"])).toBe("a.txt");
    expect(await readFile(join(work, "b.txt"), "utf8")).toBe("other session WIP\n");
  }, TEST_TIMEOUT_MS);

  test("commits only declared files and preserves unrelated dirty files", async () => {
    const { root, remote, work } = await createRepository();
    await writeFile(join(work, "a.txt"), "changed-a\n");
    await writeFile(join(work, "unrelated.txt"), "keep-local\n");

    const { result, output } = await startFinalizer(root, work, "single", ["a.txt"], "change a");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
    expect(git(work, ["status", "--short"])).toBe("?? unrelated.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("refuses to commit a file whose staged blob differs from the one the cross-review gate checked", async () => {
    const { root, remote, work } = await createRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "reviewed-a\n");
    const checked = git(work, ["hash-object", "a.txt"]);
    await writeFile(join(work, "a.txt"), "edited-after-the-gate\n");

    const stale = await startFinalizer(root, work, "gate-stale", ["a.txt"], "must fail", { gateBlobs: { "a.txt": checked } });
    expect(stale.result.code).toBe(1);
    expect(stale.output.stage).toBe("cross-review-verify");
    expect(stale.output.error).toContain("a.txt changed after the review check");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await Bun.file(join(work, "a.txt")).text()).toBe("edited-after-the-gate\n");

    const current = git(work, ["hash-object", "a.txt"]);
    const fresh = await startFinalizer(root, work, "gate-fresh", ["a.txt"], "matches", { gateBlobs: { "a.txt": current } });
    expect(fresh.result.code, fresh.result.stderr || fresh.result.stdout).toBe(0);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(fresh.output.commitSha!);
  }, TEST_TIMEOUT_MS);

  test("refuses a path the cross-review gate never checked and a file that was clean at the gate but changed before staging", async () => {
    const { root, remote, work } = await createRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    const cleanBlob = git(work, ["hash-object", "a.txt"]);
    await writeFile(join(work, "a.txt"), "changed-after-clean-gate\n");
    await writeFile(join(work, "b.txt"), "also-changed\n");

    const clean = await startFinalizer(root, work, "gate-clean-then-changed", ["a.txt"], "must fail", { gateBlobs: { "a.txt": cleanBlob } });
    expect(clean.result.code).toBe(1);
    expect(clean.output.stage).toBe("cross-review-verify");
    expect(clean.output.error).toContain("a.txt changed after the review check");

    const unchecked = await startFinalizer(root, work, "gate-unchecked", ["a.txt", "b.txt"], "must fail", {
      gateBlobs: { "a.txt": git(work, ["hash-object", "a.txt"]) },
    });
    expect(unchecked.result.code).toBe(1);
    expect(unchecked.output.stage).toBe("cross-review-verify");
    expect(unchecked.output.error).toContain("b.txt was not part of the change set the gate checked");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
  }, TEST_TIMEOUT_MS);

  test("stops before push when a commit hook rewrites a gated file, keeping the local commit", async () => {
    const { root, remote, work } = await createRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "reviewed-a\n");
    const checked = git(work, ["hash-object", "a.txt"]);
    const hook = join(work, ".git", "hooks", "pre-commit");
    await writeFile(hook, "#!/bin/sh\necho rewritten-by-hook >> a.txt\ngit add a.txt\n");
    await chmod(hook, 0o755);

    const { result, output } = await startFinalizer(root, work, "gate-hook", ["a.txt"], "hook rewrites", { gateBlobs: { "a.txt": checked } });
    expect(result.code).toBe(1);
    expect(output.stage).toBe("cross-review-verify");
    expect(output.error).toContain("holds a different blob for a.txt");
    expect(output.error).toContain("NOT pushed");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
    expect(git(work, ["rev-parse", "HEAD"])).toBe(output.commitSha!);
    expect(output.commitSha).not.toBe(before);
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === "win32")("preserves distinct case-sensitive file names", async () => {
    const { root, work } = await createRepository();
    await writeFile(join(work, "a.txt"), "lowercase\n");
    await writeFile(join(work, "A.txt"), "uppercase\n");
    const { result, output } = await startFinalizer(root, work, "case-sensitive", ["a.txt", "A.txt"], "two different files");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!]).split("\n").sort()).toEqual(["A.txt", "a.txt"]);
  }, TEST_TIMEOUT_MS);

  test("keeps ordinary repositories without a source helper unchanged", async () => {
    const { work, remote } = await createRepository();
    await writeFile(join(work, "a.txt"), "changed-without-helper\n");

    const { error, output } = await startTool(work, ["a.txt"]);
    expect(error).toBeUndefined();
    expect(output).toBeDefined();
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(git(work, ["rev-parse", "HEAD"]));
  }, TEST_TIMEOUT_MS);

  test("exports memories before the commit and carries the changed transport in it", async () => {
    const { work, remote } = await createRepository();
    const syncDir = join(work, "Tools", "OMP_Global_Config", "memory-sync");
    await mkdir(syncDir, { recursive: true });
    await writeFile(join(syncDir, "sync.ts"),
      "const [mode, root] = process.argv.slice(2);\n"
      + "if (mode !== 'export') process.exit(2);\n"
      + "await Bun.write(root + '/Tools/OMP_Global_Config/memory-sync/memories.jsonl', 'lesson-from-this-pc\\n');\n");
    await writeFile(join(work, "a.txt"), "changed-with-memory\n");

    const { error, output } = await startTool(work, ["a.txt"]);
    expect(error).toBeUndefined();
    const sha = git(work, ["rev-parse", "HEAD"]);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(sha);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split(/\r?\n/).sort())
      .toEqual(["Tools/OMP_Global_Config/memory-sync/memories.jsonl", "a.txt"]);
    expect(JSON.stringify(output)).toContain("memories.jsonl");
  }, TEST_TIMEOUT_MS);

  test("still commits the requested files when the memory export fails", async () => {
    const { work } = await createRepository();
    const syncDir = join(work, "Tools", "OMP_Global_Config", "memory-sync");
    await mkdir(syncDir, { recursive: true });
    await writeFile(join(syncDir, "sync.ts"), "console.error('bank locked'); process.exit(1);\n");
    await writeFile(join(work, "a.txt"), "changed-memory-fails\n");

    const { error, output } = await startTool(work, ["a.txt"]);
    expect(error).toBeUndefined();
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])).toBe("a.txt");
    expect(JSON.stringify(output)).toContain("bank locked");
  }, TEST_TIMEOUT_MS);

  test("names the error line of a crashed memory export instead of the runtime banner", async () => {
    const { work } = await createRepository();
    const syncDir = join(work, "Tools", "OMP_Global_Config", "memory-sync");
    await mkdir(syncDir, { recursive: true });
    await writeFile(join(syncDir, "sync.ts"), "throw new Error('bank schema mismatch');\n");
    await writeFile(join(work, "a.txt"), "changed-memory-crashes\n");

    const { error, output } = await startTool(work, ["a.txt"]);
    expect(error).toBeUndefined();
    const text = JSON.stringify(output);
    expect(text).toContain("기억 export 실패(커밋은 진행): error: bank schema mismatch");
    expect(text).not.toContain("Bun v");
  }, TEST_TIMEOUT_MS);

  test("exports memories from a linked worktree without node_modules through the main checkout's sync script", async () => {
    const { root, work } = await createRepository();
    const syncDir = join(work, "Tools", "OMP_Global_Config", "memory-sync");
    await mkdir(syncDir, { recursive: true });
    // Like the real sync.ts, the script reaches its dependency through the checkout's node_modules, which a new worktree lacks.
    await writeFile(join(syncDir, "sync.ts"),
      "import { line } from '../../../node_modules/memory-dep/index.ts';\n"
      + "const [mode, root] = process.argv.slice(2);\n"
      + "if (mode !== 'export') process.exit(2);\n"
      + "await Bun.write(root + '/Tools/OMP_Global_Config/memory-sync/memories.jsonl', line);\n");
    git(work, ["add", "--", "Tools/OMP_Global_Config/memory-sync/sync.ts"]);
    git(work, ["commit", "-m", "sync script"]);
    await mkdir(join(work, "node_modules", "memory-dep"), { recursive: true });
    await writeFile(join(work, "node_modules", "memory-dep", "index.ts"), "export const line = 'lesson-from-a-worktree\\n';\n");
    const linked = join(root, "work-worktrees", "wt-a");
    git(work, ["worktree", "add", "-b", "wt/a", linked]);
    await writeFile(join(linked, "a.txt"), "changed-in-worktree\n");

    const { error, output } = await startTool(linked, ["a.txt"]);
    expect(error).toBeUndefined();
    expect(JSON.stringify(output)).not.toContain("기억 export 실패");
    expect(git(linked, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split(/\r?\n/).sort())
      .toEqual(["Tools/OMP_Global_Config/memory-sync/memories.jsonl", "a.txt"]);
    expect(await readFile(join(linked, "Tools", "OMP_Global_Config", "memory-sync", "memories.jsonl"), "utf8")).toBe("lesson-from-a-worktree\n");
    await expect(access(join(syncDir, "memories.jsonl"))).rejects.toThrow();
  }, TEST_TIMEOUT_MS);

  test("notes a source commit with no HANDOFF.md up to the repository root and stays quiet once one exists", async () => {
    const { work, remote } = await createRepository();
    await mkdir(join(work, "proj", "src"), { recursive: true });
    await writeFile(join(work, "proj", "src", "Main.vb"), "first\n");

    const first = await startTool(work, ["proj/src/Main.vb"]);
    expect(first.error).toBeUndefined();
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(git(work, ["rev-parse", "HEAD"]));
    expect(JSON.stringify(first.output)).toContain("`proj/src`에서 저장소 루트까지 HANDOFF.md가 없다");

    await writeFile(join(work, "proj", "src", "Main.vb"), "second\n");
    await writeFile(join(work, "proj", "HANDOFF.md"), "# proj\n");
    const withProjectHandoff = await startTool(work, ["proj/src/Main.vb", "proj/HANDOFF.md"]);
    expect(withProjectHandoff.error).toBeUndefined();
    expect(JSON.stringify(withProjectHandoff.output)).not.toContain("HANDOFF 확인");

    await mkdir(join(work, "other"), { recursive: true });
    await writeFile(join(work, "other", "tool.ts"), "export {};\n");
    await writeFile(join(work, "HANDOFF.md"), "# root\n");
    const withRootHandoff = await startTool(work, ["other/tool.ts", "HANDOFF.md"]);
    expect(withRootHandoff.error).toBeUndefined();
    expect(JSON.stringify(withRootHandoff.output)).not.toContain("HANDOFF 확인");
  }, TEST_TIMEOUT_MS);

  test("judges doc/ and document or image files against the target repository root, not the cwd or request text", async () => {
    const { root, work } = await createRepository();
    await mkdir(join(work, "assets"), { recursive: true });
    await writeFile(join(work, "assets", "app.ico"), "icon\n");
    await writeFile(join(work, "README.rst"), "readme\n");
    const docsOnly = await startTool(work, ["assets/app.ico", "README.rst"]);
    expect(docsOnly.error).toBeUndefined();
    expect(JSON.stringify(docsOnly.output)).not.toContain("HANDOFF 확인");

    await mkdir(join(work, "doc"), { recursive: true });
    await writeFile(join(work, "doc", "example.ts"), "export const example = 1;\n");
    const insideDoc = await startTool(join(work, "doc"), ["example.ts"]);
    expect(insideDoc.error).toBeUndefined();
    expect(JSON.stringify(insideDoc.output)).not.toContain("HANDOFF 확인");

    await mkdir(join(root, "doc"));
    const sibling = await createAdditionalRepository(root, "doc/core");
    await mkdir(join(sibling.work, "src"));
    await writeFile(join(sibling.work, "src", "main.ts"), "export const core = 1;\n");
    const underDocAncestor = await startTool(work, ["../doc/core/src/main.ts"], { outsideCwdReason: "user named the doc/core repo" });
    expect(underDocAncestor.error).toBeUndefined();
    expect(git(sibling.work, ["--git-dir", sibling.remote, "rev-parse", "refs/heads/main"])).toBe(git(sibling.work, ["rev-parse", "HEAD"]));
    expect(JSON.stringify(underDocAncestor.output)).toContain("`../doc/core/src`에서 저장소 루트까지 HANDOFF.md가 없다");
  }, TEST_TIMEOUT_MS);

  test("rejects a changed source without the manifest before invoking finalizer", async () => {
    const { work, remote } = await createManifestRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "changed-a\r\n");

    const { error } = await startTool(work, ["a.txt"]);
    expect(error?.message).toContain("source-integrity.json");
    expect(error?.message).toContain("node files/source-build-helper.js create-manifest ../.. files/runtime-integrity.json --output files/source-integrity.json");
    expect(error?.message).toContain("node files/source-build-helper.js verify-source ../.. files/source-integrity.json files/runtime-integrity.json");
    expect(error?.message).toContain("Tools/CUELO_Setup");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
  }, TEST_TIMEOUT_MS);

  // 매니페스트를 실제로 다시 쓰는 작은 헬퍼: create-manifest는 고정 목록의 LF 해시를 쓰고, verify-source는 exit 코드만 정한다.
  async function installRegeneratingHelper(work: string, failure?: string) {
    const helper = join(work, "Tools", "CUELO_Setup", "files", "source-build-helper.js");
    await writeFile(helper, failure ?? [
      'const fs = require("fs"); const crypto = require("crypto");',
      'const [command, root, , , out] = process.argv.slice(2);',
      'if (command === "verify-source") process.exit(0);',
      'const files = {};',
      'for (const name of ["a.txt", "b.txt", "package.json", "Tools/runtime/entry.js"]) {',
      '  files[name] = crypto.createHash("sha256").update(fs.readFileSync(root + "/" + name, "utf8").replace(/\\r\\n/g, "\\n")).digest("hex");',
      '}',
      'fs.writeFileSync(out, JSON.stringify({ files }));',
      '',
    ].join("\n"));
    git(work, ["add", "--", "Tools/CUELO_Setup/files/source-build-helper.js"]);
    git(work, ["commit", "-m", "helper"]);
    git(work, ["push"]);
  }

  test("regenerates a stale source manifest and commits it with the requested file, including from a nested cwd", async () => {
    const { root, work, remote } = await createManifestRepository();
    await installRegeneratingHelper(work);
    const manifest = "Tools/CUELO_Setup/files/source-integrity.json";
    await writeFile(join(work, "a.txt"), "changed-a\n");

    const first = await startTool(work, ["a.txt"]);
    expect(first.error).toBeUndefined();
    expect(JSON.stringify(first.output)).toContain("다시 만들어 이번 커밋에 포함했다");
    const sha = git(work, ["rev-parse", "HEAD"]);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split(/\r?\n/).sort()).toEqual(["Tools/CUELO_Setup/files/source-integrity.json", "a.txt"]);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(sha);
    const committed = JSON.parse(git(work, ["show", `HEAD:${manifest}`])) as { files: Record<string, string> };
    expect(committed.files["a.txt"]).toBe(createHash("sha256").update("changed-a\n").digest("hex"));
    expect(git(work, ["status", "--short"])).toBe("");

    // 매니페스트가 cwd 밖(Tools/runtime 아래 세션)이어도 직접 만든 매니페스트는 사용자 지시 없이 들어간다.
    await writeFile(join(work, ".finalize-checks.json"), JSON.stringify({ version: 1, checks: [{
      name: "regenerated manifest", paths: [manifest], command: [process.execPath, "-e",
        'if (require("node:fs").readFileSync("Tools/runtime/entry.js", "utf8").trim() === "runtime-broken") process.exit(7)'],
    }] }));
    git(work, ["add", "--", ".finalize-checks.json"]);
    git(work, ["commit", "-m", "configure manifest check"]);
    git(work, ["push"]);
    const configHead = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "Tools", "runtime", "entry.js"), "runtime-broken\n");
    const refused = await startTool(join(work, "Tools", "runtime"), ["entry.js"], {}, join(root, "artifacts"));
    expect(refused.error?.message).toContain("git_finalize failed at finalize-checks: regenerated manifest exited 7");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(configHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(configHead);
    await writeFile(join(work, "Tools", "runtime", "entry.js"), "runtime-changed\n");
    expect(await readFile(join(work, manifest), "utf8")).toBe(git(work, ["show", `HEAD:${manifest}`]));
    const nested = await startTool(join(work, "Tools", "runtime"), ["entry.js"]);
    expect(nested.error).toBeUndefined();
    const nestedSha = git(work, ["rev-parse", "HEAD"]);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", nestedSha]).split(/\r?\n/).sort()).toEqual([manifest, "Tools/runtime/entry.js"]);
    expect(root).toBeTruthy();
  }, TEST_TIMEOUT_MS);

  test("keeps the stale-manifest error with the command output when regeneration fails", async () => {
    const { work, remote } = await createManifestRepository();
    await installRegeneratingHelper(work, 'console.error("boom from helper"); process.exit(3);\n');
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "changed-a\n");

    const { error } = await startTool(work, ["a.txt"]);
    expect(error?.message).toContain("source manifest is stale for a.txt");
    expect(error?.message).toContain("node files/source-build-helper.js create-manifest ../.. files/runtime-integrity.json --output files/source-integrity.json");
    expect(error?.message).toContain("Automatic regeneration failed");
    expect(error?.message).toContain("boom from helper");
    expect(error?.message).toContain("previous manifest was restored");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
  }, TEST_TIMEOUT_MS);

  test("restores the previous manifest and reports both helper streams when verify-source fails after create-manifest rewrote it", async () => {
    const { work } = await createManifestRepository();
    await installRegeneratingHelper(work, [
      'const fs = require("fs"); const [command, , , , out] = process.argv.slice(2);',
      'if (command === "verify-source") { console.log("bad entry"); console.error("verification failed"); process.exit(3); }',
      'fs.writeFileSync(out, "REPLACED");',
      '',
    ].join("\n"));
    const manifestFile = join(work, "Tools", "CUELO_Setup", "files", "source-integrity.json");
    const original = await readFile(manifestFile, "utf8");
    await writeFile(manifestFile, original.replace(/}$/, ',"localEdit":true}'));
    const edited = await readFile(manifestFile, "utf8");
    await writeFile(join(work, "a.txt"), "changed-a\n");

    const { error } = await startTool(work, ["a.txt"]);
    expect(error?.message).toContain("source manifest is stale for a.txt");
    expect(error?.message).toContain("verification failed");
    expect(error?.message).toContain("bad entry");
    expect(await readFile(manifestFile, "utf8")).toBe(edited);
  }, TEST_TIMEOUT_MS);

  test("reports both a stale manifest and an unauthorized file without regenerating", async () => {
    const { work } = await createManifestRepository();
    await installRegeneratingHelper(work);
    const session = join(work, "session");
    await mkdir(session);
    const manifestFile = join(work, "Tools", "CUELO_Setup", "files", "source-integrity.json");
    const before = await readFile(manifestFile, "utf8");
    await writeFile(join(work, "Tools", "runtime", "entry.js"), "runtime-changed\n");
    const head = git(work, ["rev-parse", "HEAD"]);

    const { error } = await startTool(session, ["../Tools/runtime/entry.js"]);
    expect(error?.message).toContain("source manifest is stale for Tools/runtime/entry.js");
    expect(error?.message).toContain("File path escapes the session cwd: ../Tools/runtime/entry.js");
    expect(error?.message).toContain("pass it as outsideCwdReason");
    expect(error?.message).toContain("cross_review");
    expect(error?.message).toContain(".finalize-checks.json");
    expect(await readFile(manifestFile, "utf8")).toBe(before);
    expect(git(work, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
  }, TEST_TIMEOUT_MS);

  test("allows a source and its matching manifest in the same commit", async () => {
    const { work, manifestPath } = await createManifestRepository();
    await writeFile(join(work, "a.txt"), "changed-a\n");
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { files: Record<string, string> };
    manifest.files["a.txt"] = createHash("sha256").update("changed-a\n").digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));

    const { error, output } = await startTool(work, ["a.txt", "Tools/CUELO_Setup/files/source-integrity.json"]);
    expect(error).toBeUndefined();
    expect(output).toBeDefined();
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]).split(/\r?\n/).sort()).toEqual([
      "Tools/CUELO_Setup/files/source-integrity.json", "a.txt",
    ]);
  }, TEST_TIMEOUT_MS);

  test("rejects a committed manifest that misses a new source or holds a stale hash", async () => {
    const { work, remote, manifestPath } = await createManifestRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    const manifestFile = "Tools/CUELO_Setup/files/source-integrity.json";
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { files: Record<string, string> };
    manifest.files["a.txt"] = createHash("sha256").update("changed-a\n").digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(work, "a.txt"), "changed-a\n");
    await writeFile(join(work, "new.txt"), "new source\n");

    const missing = await startTool(work, ["a.txt", "new.txt", manifestFile]);
    expect(missing.error?.message).toContain("source manifest is missing new.txt");
    expect(missing.error?.message).toContain("git add -N new.txt");

    await writeFile(join(work, "a.txt"), "edited-after-manifest\n");
    const stale = await startTool(work, ["a.txt", manifestFile]);
    expect(stale.error?.message).toContain("source manifest is stale for a.txt");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
  }, TEST_TIMEOUT_MS);

  test("requires a deleted source to leave the committed manifest", async () => {
    const { work, manifestPath } = await createManifestRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    const manifestFile = "Tools/CUELO_Setup/files/source-integrity.json";
    await rm(join(work, "b.txt"));

    const listed = await startTool(work, ["b.txt", manifestFile]);
    expect(listed.error?.message).toContain("source manifest still lists deleted b.txt");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);

    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { files: Record<string, string> };
    delete manifest.files["b.txt"];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const removed = await startTool(work, ["b.txt", manifestFile]);
    expect(removed.error).toBeUndefined();
    expect(git(work, ["ls-files", "--", "b.txt"])).toBe("");
  }, TEST_TIMEOUT_MS);

  test("compares source hashes after CRLF normalization", async () => {
    const { work, manifestPath } = await createManifestRepository();
    const manifest = JSON.parse(await Bun.file(manifestPath).text()) as { files: Record<string, string> };
    manifest.files["a.txt"] = createHash("sha256").update("updated-a\n").digest("hex");
    await writeFile(manifestPath, JSON.stringify(manifest));
    git(work, ["add", "--", "Tools/CUELO_Setup/files/source-integrity.json"]);
    git(work, ["commit", "-m", "prepare normalized source hash"]);
    git(work, ["push"]);
    await writeFile(join(work, "a.txt"), "updated-a\r\n");

    const { error, output } = await startTool(work, ["a.txt"]);
    expect(error).toBeUndefined();
    expect(output).toBeDefined();
  }, TEST_TIMEOUT_MS);

  test("ignores mismatched source files outside the requested list", async () => {
    const { work } = await createManifestRepository();
    await writeFile(join(work, "a.txt"), "another-writer\n");
    await writeFile(join(work, "Tools", "CUELO_Setup", "notes.txt"), "repository-only\n");

    const { error, output } = await startTool(work, ["Tools/CUELO_Setup/notes.txt"]);
    expect(error).toBeUndefined();
    expect(output).toBeDefined();
    expect(git(work, ["status", "--short"])).toContain("M a.txt");
  }, TEST_TIMEOUT_MS);

  test("detects a packaged Tools source path but permits repository-only Tools", async () => {
    const { work, remote } = await createManifestRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "Tools", "runtime", "entry.js"), "changed-runtime\n");
    const blocked = await startTool(work, ["Tools/runtime/entry.js"]);
    expect(blocked.error?.message).toContain("source-integrity.json");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);

    await writeFile(join(work, "Tools", "CUELO_Setup", "notes.txt"), "repository-only\n");
    const allowed = await startTool(work, ["Tools/CUELO_Setup/notes.txt"]);
    expect(allowed.error).toBeUndefined();
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(git(work, ["rev-parse", "HEAD"]));
  }, TEST_TIMEOUT_MS);

  test("accepts a direct repository-root file from a nested cwd and preserves unrelated dirty state", async () => {
    const { root, remote, work } = await createRepository();
    const nested = join(work, "project");
    await mkdir(nested);
    await writeFile(join(work, "a.txt"), "changed-root-a\n");
    await writeFile(join(work, "b.txt"), "keep-local-b\n");

    const { result, output } = await startFinalizer(root, nested, "root-file", ["../a.txt"], "change root file");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
    expect(git(work, ["status", "--short"])).toBe("M b.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform !== "win32")("accepts a direct file when the repository root is a mapped drive root", async () => {
    const { root, remote, work } = await createRepository();
    const drive = await getUnusedDriveLetter();
    const mappedRoot = `${drive}\\`;
    const nested = `${mappedRoot}project`;
    expect(run("subst.exe", [drive, work]).code).toBe(0);
    try {
      await mkdir(join(work, "project"));
      await writeFile(join(work, "a.txt"), "changed-drive-root-a\n");

      const { result, output } = await startFinalizer(root, nested, "drive-root-file", ["../a.txt"], "change drive root file");
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(output.ok).toBe(true);
      expect(output.stage).toBe("complete");
      expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
      expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
      expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
    } finally {
      run("subst.exe", [drive, "/d"]);
    }
  }, TEST_TIMEOUT_MS);

  test("finalizes an exact file in a distinct sibling repository from a nested cwd", async () => {
    const { root, remote, work } = await createRepository();
    const external = await createAdditionalRepository(root, "external");
    const nested = join(work, "project");
    await mkdir(nested);
    await writeFile(join(work, "b.txt"), "keep-current-dirty\n");
    await writeFile(join(external.work, "a.txt"), "changed-external-a\n");
    await writeFile(join(external.work, "b.txt"), "keep-external-dirty\n");
    const currentHead = git(work, ["rev-parse", "HEAD"]);
    const currentStatus = git(work, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      nested,
      "external-sibling",
      ["../../external/a.txt"],
      "change external file",
      { outsideCwdReason: "user asked to commit the external repo file" },
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(external.work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
    expect(git(external.work, ["--git-dir", external.remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
    expect(git(external.work, ["status", "--short"])).toBe("M b.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], external.work).code).toBe(0);
    expect(git(work, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(currentHead);
    expect(git(work, ["status", "--short"])).toBe(currentStatus);
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("finalizes a deleted file in a distinct sibling repository from a nested cwd", async () => {
    const { root, work } = await createRepository();
    const external = await createAdditionalRepository(root, "external");
    const nested = join(work, "project");
    await mkdir(nested);
    await rm(join(external.work, "a.txt"));
    await writeFile(join(external.work, "b.txt"), "keep-external-dirty\n");

    const { result, output } = await startFinalizer(
      root,
      nested,
      "external-deleted",
      ["../../external/a.txt"],
      "delete external file",
      { outsideCwdReason: "user asked to delete the external repo file" },
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(external.work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
    expect(git(external.work, ["--git-dir", external.remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
    expect(git(external.work, ["status", "--short"])).toBe("M b.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], external.work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("rejects a sibling-project file from a nested cwd without changing repository state", async () => {
    const { root, remote, work } = await createRepository();
    const project = join(work, "project");
    const sibling = join(work, "sibling");
    await mkdir(project);
    await mkdir(sibling);
    await writeFile(join(sibling, "file.txt"), "base-sibling\n");
    git(work, ["add", "--", "sibling/file.txt"]);
    git(work, ["commit", "-m", "add sibling file"]);
    git(work, ["push"]);
    await writeFile(join(sibling, "file.txt"), "changed-sibling\n");
    const beforeHead = git(work, ["rev-parse", "HEAD"]);
    const beforeIndex = git(work, ["diff", "--cached", "--name-only"]);
    const beforeStatus = git(work, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      project,
      "sibling-file",
      ["../sibling/file.txt"],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("File path escapes the session cwd");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(beforeHead);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe(beforeIndex);
    expect(git(work, ["status", "--short"])).toBe(beforeStatus);
  }, TEST_TIMEOUT_MS);

  test("rejects a same-repository file outside the session cwd without outsideCwdReason, then allows it with the reason", async () => {
    const { root, remote, work } = await createRepository();
    const project = join(work, "project");
    await mkdir(project);
    await mkdir(join(work, "sibling"));
    await writeFile(join(work, "sibling", "file.txt"), "base-sibling\n");
    git(work, ["add", "--", "sibling/file.txt"]);
    git(work, ["commit", "-m", "add sibling file"]);
    git(work, ["push"]);
    await writeFile(join(work, "sibling", "file.txt"), "changed-sibling\n");
    const beforeHead = git(work, ["rev-parse", "HEAD"]);

    for (const [name, extra] of [["no-reason", {}], ["blank-reason", { outsideCwdReason: "   " }]] as const) {
      const rejected = await startFinalizer(root, project, name, ["../sibling/file.txt"], "must fail", extra);
      expect(rejected.result.code).toBe(1);
      expect(rejected.output.stage).toBe("repository");
      expect(rejected.output.error).toContain("File path escapes the session cwd");
      expect(rejected.output.error).toContain("outsideCwdReason");
      expect(rejected.output.error).toContain("explicit instruction");
      expect(git(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    }

    const allowed = await startFinalizer(root, project, "with-reason", ["../sibling/file.txt"], "sibling change", {
      outsideCwdReason: "  user asked to commit the sibling folder  ",
    });
    expect(allowed.result.code, allowed.result.stderr || allowed.result.stdout).toBe(0);
    expect(allowed.output.outsideCwdReason).toBe("user asked to commit the sibling folder");
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", allowed.output.commitSha!])).toBe("sibling/file.txt");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(allowed.output.commitSha!);
  }, TEST_TIMEOUT_MS);

  test("a session inside its own linked worktree may commit any folder of that worktree, but not another worktree, without a reason", async () => {
    const { root, work } = await createRepository();
    const linked = join(root, "linked");
    const other = join(root, "other-linked");
    git(work, ["worktree", "add", "-b", "linked-branch", linked]);
    git(work, ["worktree", "add", "-b", "other-branch", other]);
    await mkdir(join(linked, "project"));
    await mkdir(join(linked, "sibling"));
    await writeFile(join(linked, "sibling", "file.txt"), "base-sibling\n");
    git(linked, ["add", "--", "sibling/file.txt"]);
    git(linked, ["commit", "-m", "sibling file"]);
    await writeFile(join(linked, "sibling", "file.txt"), "changed-sibling\n");
    await writeFile(join(other, "a.txt"), "changed-other-a\n");
    const otherHead = git(other, ["rev-parse", "HEAD"]);

    const rejected = await startFinalizer(root, join(linked, "project"), "other-worktree", ["../../other-linked/a.txt"], "must fail");
    expect(rejected.result.code).toBe(1);
    expect(rejected.output.error).toContain("outsideCwdReason");
    expect(git(other, ["rev-parse", "HEAD"])).toBe(otherHead);

    const allowed = await startFinalizer(root, join(linked, "project"), "own-worktree", ["../sibling/file.txt"], "sibling change");
    expect(allowed.result.code, allowed.result.stderr || allowed.result.stdout).toBe(0);
    expect(allowed.output.outsideCwdReason).toBeUndefined();
    expect(git(linked, ["diff-tree", "--no-commit-id", "--name-only", "-r", allowed.output.commitSha!])).toBe("sibling/file.txt");
  }, TEST_TIMEOUT_MS);

  test("the finalizer exempts only the source manifest from the cwd boundary even when a request names other generated files", async () => {
    const { root, work } = await createRepository();
    const project = join(work, "project");
    await mkdir(project);
    await mkdir(join(work, "sibling"));
    await writeFile(join(work, "sibling", "file.txt"), "base-sibling\n");
    git(work, ["add", "--", "sibling/file.txt"]);
    git(work, ["commit", "-m", "add sibling file"]);
    git(work, ["push"]);
    await writeFile(join(work, "sibling", "file.txt"), "changed-sibling\n");
    const beforeHead = git(work, ["rev-parse", "HEAD"]);

    const { result, output } = await startFinalizer(root, project, "generated-spoof", ["../sibling/file.txt"], "must fail", { generatedFiles: ["sibling/file.txt"] });
    expect(result.code).toBe(1);
    expect(output.error).toContain("outsideCwdReason");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
  }, TEST_TIMEOUT_MS);

  test("a different repository outside the session cwd needs outsideCwdReason, one inside the cwd does not", async () => {
    const { root, work } = await createRepository();
    const external = await createAdditionalRepository(root, "external");
    const project = join(work, "project");
    await mkdir(project);
    await writeFile(join(external.work, "a.txt"), "changed-external-a\n");
    const externalHead = git(external.work, ["rev-parse", "HEAD"]);

    const rejected = await startFinalizer(root, project, "external-no-reason", ["../../external/a.txt"], "must fail");
    expect(rejected.result.code).toBe(1);
    expect(rejected.output.stage).toBe("repository");
    expect(rejected.output.error).toContain("outsideCwdReason");
    expect(git(external.work, ["rev-parse", "HEAD"])).toBe(externalHead);

    const allowed = await startFinalizer(root, project, "external-reason", ["../../external/a.txt"], "external change", {
      outsideCwdReason: "user named the external repo",
    });
    expect(allowed.result.code, allowed.result.stderr || allowed.result.stdout).toBe(0);
    expect(allowed.output.outsideCwdReason).toBe("user named the external repo");

    // 같은 저장소가 아니어도 cwd 안의 중첩 저장소는 지시 없이 통과한다.
    const inner = await createAdditionalRepository(work, "inner-repo");
    await writeFile(join(inner.work, "a.txt"), "changed-inner-a\n");
    const nested = await startFinalizer(root, work, "inner-no-reason", ["inner-repo/a.txt"], "inner change");
    expect(nested.result.code, nested.result.stderr || nested.result.stdout).toBe(0);
    expect(nested.output.outsideCwdReason).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  test("a direct repository-root child stays allowed from a nested cwd without a reason", async () => {
    const { root, work } = await createRepository();
    const project = join(work, "project");
    await mkdir(project);
    await writeFile(join(work, "a.txt"), "changed-root-a\n");

    const { result, output } = await startFinalizer(root, project, "root-child", ["../a.txt"], "root child");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.outsideCwdReason).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  test("outsideCwdReason lets a cwd outside any repository commit one repository file but never an escape from the repository", async () => {
    const { root, work } = await createRepository();
    const session = join(root, "session");
    await mkdir(session);
    await writeFile(join(work, "a.txt"), "changed-a\n");
    await writeFile(join(root, "stray.txt"), "not-in-a-repo\n");

    const escape = await startFinalizer(root, session, "no-repo-escape", ["../stray.txt"], "must fail", { outsideCwdReason: "user said so" });
    expect(escape.result.code).toBe(1);
    expect(escape.output.error).not.toContain("outsideCwdReason");

    const rejected = await startFinalizer(root, session, "no-repo-no-reason", ["../work/a.txt"], "must fail");
    expect(rejected.result.code).toBe(1);
    expect(rejected.output.error).toContain("outsideCwdReason");

    const allowed = await startFinalizer(root, session, "no-repo-reason", ["../work/a.txt"], "outside change", { outsideCwdReason: "user named the work repo" });
    expect(allowed.result.code, allowed.result.stderr || allowed.result.stdout).toBe(0);
    expect(allowed.output.outsideCwdReason).toBe("user named the work repo");
  }, TEST_TIMEOUT_MS);

  describe("leftover file notice", () => {
    async function seedDocs(work: string) {
      await mkdir(join(work, "docs"), { recursive: true });
      await writeFile(join(work, "docs", "a.txt"), "doc-a\n");
      await writeFile(join(work, "docs", "b.txt"), "doc-b\n");
      git(work, ["add", "--", "docs"]);
      git(work, ["commit", "-m", "docs"]);
      git(work, ["push"]);
    }

    test("lists untracked and modified files left under the committed folder but not the committed file or files elsewhere", async () => {
      const { root, work } = await createRepository();
      await seedDocs(work);
      await writeFile(join(work, "docs", "a.txt"), "changed-a\n");
      await writeFile(join(work, "docs", "b.txt"), "changed-b\n");
      await mkdir(join(work, "docs", "qa"));
      await writeFile(join(work, "docs", "qa", "1.txt"), "qa-1\n");
      await writeFile(join(work, "docs", "qa", "2.txt"), "qa-2\n");
      await writeFile(join(work, "elsewhere.txt"), "outside-scope\n");
      await writeFile(join(work, ".gitignore"), "docs/ignored.txt\n");
      await writeFile(join(work, "docs", "ignored.txt"), "ignored\n");

      const { result, output } = await startFinalizer(root, work, "leftover", ["docs/a.txt"], "docs a");
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(output.leftoverScope).toBe("docs");
      expect(output.leftoverTotal).toBe(3);
      expect(output.leftoverFiles).toEqual(["modified: docs/b.txt", "untracked: docs/qa/1.txt", "untracked: docs/qa/2.txt"]);
      expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    }, TEST_TIMEOUT_MS);

    test("lists a tracked file that is staged but not committed", async () => {
      const { root, work } = await createRepository();
      await seedDocs(work);
      await writeFile(join(work, "docs", "a.txt"), "changed-a\n");
      await writeFile(join(work, "docs", "b.txt"), "changed-b\n");
      // post-commit hook가 다른 파일을 stage해 두는 상황: 커밋 뒤 index에 남는 변경.
      const hook = join(work, ".git", "hooks", "post-commit");
      await writeFile(hook, "#!/bin/sh\ngit add -- docs/b.txt\n");
      await chmod(hook, 0o755);

      const { result, output } = await startFinalizer(root, work, "leftover-staged", ["docs/a.txt"], "docs a");
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(git(work, ["diff", "--cached", "--name-only"])).toBe("docs/b.txt");
      expect(output.leftoverFiles).toEqual(["staged: docs/b.txt"]);
      expect(output.leftoverTotal).toBe(1);
    }, TEST_TIMEOUT_MS);

    test("falls back to the session cwd when the committed paths share only the repository root, and skips when the cwd is the root", async () => {
      const { root, work } = await createRepository();
      const project = join(work, "project");
      await mkdir(project);
      await writeFile(join(project, "new.txt"), "new\n");
      await writeFile(join(work, "top.txt"), "top\n");
      await writeFile(join(work, "a.txt"), "changed-a\n");

      const fromProject = await startFinalizer(root, project, "root-fallback", ["../a.txt"], "root a");
      expect(fromProject.result.code, fromProject.result.stderr || fromProject.result.stdout).toBe(0);
      expect(fromProject.output.leftoverScope).toBe("project");
      expect(fromProject.output.leftoverFiles).toEqual(["untracked: project/new.txt"]);

      await writeFile(join(work, "b.txt"), "changed-b\n");
      const fromRoot = await startFinalizer(root, work, "root-skip", ["b.txt"], "root b");
      expect(fromRoot.result.code, fromRoot.result.stderr || fromRoot.result.stdout).toBe(0);
      expect(fromRoot.output.leftoverScope).toBeUndefined();
      expect(fromRoot.output.leftoverFiles).toBeUndefined();
    }, TEST_TIMEOUT_MS);

    test("checks the whole tree when the cwd is the root of the session's own linked worktree", async () => {
      const { root, work } = await createRepository();
      const linked = join(root, "linked");
      git(work, ["worktree", "add", "-b", "linked-branch", linked]);
      await mkdir(join(linked, "site"));
      await mkdir(join(linked, "docs", "shots"), { recursive: true });
      await writeFile(join(linked, "site", "index.html"), "page\n");
      await writeFile(join(linked, "docs", "record.md"), "record\n");
      await writeFile(join(linked, "docs", "shots", "home.png"), "png\n");

      const { result, output } = await startFinalizer(root, linked, "linked-root", ["site/index.html", "docs/record.md"], "site and record");
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(output.leftoverScope).toBe(".");
      expect(output.leftoverFiles).toEqual(["untracked: docs/shots/home.png"]);
    }, TEST_TIMEOUT_MS);

    test("finds the shared folder of several committed files and a root ancestor independent of file order", async () => {
      const { root, work } = await createRepository();
      await seedDocs(work);
      await writeFile(join(work, "docs", "a.txt"), "changed-a\n");
      await writeFile(join(work, "docs", "b.txt"), "changed-b\n");
      await writeFile(join(work, "docs", "orphan.txt"), "orphan\n");
      const same = await startFinalizer(root, work, "leftover-two", ["docs/a.txt", "docs/b.txt"], "docs both");
      expect(same.result.code, same.result.stderr || same.result.stdout).toBe(0);
      expect(same.output.leftoverScope).toBe("docs");
      expect(same.output.leftoverFiles).toEqual(["untracked: docs/orphan.txt"]);

      // 루트 파일이 앞에 와도 공통 상위는 저장소 루트라 cwd(루트)면 안내를 건너뛴다.
      await writeFile(join(work, "a.txt"), "changed-root-a\n");
      await writeFile(join(work, "docs", "a.txt"), "changed-a-again\n");
      const mixed = await startFinalizer(root, work, "leftover-mixed", ["a.txt", "docs/a.txt"], "mixed");
      expect(mixed.result.code, mixed.result.stderr || mixed.result.stdout).toBe(0);
      expect(mixed.output.leftoverScope).toBeUndefined();
    }, TEST_TIMEOUT_MS);

    test("caps the list at 20 entries with the total count", async () => {
      const { root, work } = await createRepository();
      await seedDocs(work);
      await writeFile(join(work, "docs", "a.txt"), "changed-a\n");
      for (let index = 0; index < 22; index += 1) await writeFile(join(work, "docs", `extra-${String(index).padStart(2, "0")}.txt`), "x\n");

      const { result, output } = await startFinalizer(root, work, "leftover-cap", ["docs/a.txt"], "docs a");
      expect(result.code, result.stderr || result.stdout).toBe(0);
      expect(output.leftoverTotal).toBe(22);
      expect(output.leftoverFiles).toHaveLength(20);
    }, TEST_TIMEOUT_MS);

    test("the tool output says the leftover files were not committed and shows the outside-cwd reason", async () => {
      const { root, work } = await createRepository();
      await seedDocs(work);
      process.env.OMP_CROSS_REVIEW_LEDGER = join(root, "ledger.jsonl");
      await writeFile(join(work, "docs", "a.txt"), "changed-a\n");
      await writeFile(join(work, "docs", "orphan.txt"), "orphan\n");

      const done = await startTool(work, ["docs/a.txt"]);
      expect(done.error).toBeUndefined();
      const text = JSON.stringify(done.output);
      expect(text).toContain("이번 커밋에 포함되지 않음");
      expect(text).toContain("untracked: docs/orphan.txt");

      await mkdir(join(work, "project"));
      await mkdir(join(work, "other"));
      await writeFile(join(work, "other", "o.txt"), "o\n");
      git(work, ["add", "--", "other/o.txt"]);
      git(work, ["commit", "-m", "other"]);
      git(work, ["push"]);
      await writeFile(join(work, "other", "o.txt"), "o2\n");
      const outside = await startTool(join(work, "project"), ["../other/o.txt"], { outsideCwdReason: "user said to commit other" });
      expect(outside.error).toBeUndefined();
      expect(JSON.stringify(outside.output)).toContain("user said to commit other");
    }, TEST_TIMEOUT_MS);
  });

  test("rejects a linked worktree as the same repository from a nested cwd", async () => {
    const { root, remote, work } = await createRepository();
    const project = join(work, "project");
    const linked = join(root, "linked-worktree");
    await mkdir(project);
    git(work, ["worktree", "add", "-b", "linked-branch", linked]);
    await writeFile(join(linked, "a.txt"), "changed-linked-a\n");
    const currentHead = git(work, ["rev-parse", "HEAD"]);
    const linkedHead = git(linked, ["rev-parse", "HEAD"]);
    const currentStatus = git(work, ["status", "--short"]);
    const linkedStatus = git(linked, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      project,
      "linked-worktree",
      ["../../linked-worktree/a.txt"],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("File path escapes the session cwd");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(currentHead);
    expect(git(linked, ["rev-parse", "HEAD"])).toBe(linkedHead);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(linked, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(work, ["status", "--short"])).toBe(currentStatus);
    expect(git(linked, ["status", "--short"])).toBe(linkedStatus);
  }, TEST_TIMEOUT_MS);

  test("finalizes a linked worktree inside the session cwd on its own branch", async () => {
    const { root, remote, work } = await createRepository();
    const linked = join(work, ".worktrees", "inner");
    git(work, ["worktree", "add", "-b", "inner-branch", linked]);
    await writeFile(join(linked, "a.txt"), "changed-inner-a\n");
    const mainHead = git(work, ["rev-parse", "HEAD"]);

    const { result, output } = await startFinalizer(root, work, "inner-worktree", [".worktrees/inner/a.txt"], "inner change");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(git(linked, ["rev-parse", "HEAD"])).toBe(output.commitSha!);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/inner-branch"])).toBe(output.commitSha!);
    expect(git(work, ["rev-parse", "HEAD"])).toBe(mainHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(mainHead);
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === "win32")("detects a worktree whose .git file points at a Linux path", async () => {
    const { work } = await createRepository();
    git(work, ["worktree", "add", "-b", "posix-branch", join(work, ".worktrees", "posix")]);
    expect(await hasPosixGitdirWorktree(work, [".worktrees/posix/a.txt", ".worktrees/posix/new/dir/file.txt"])).toBe(true);
    expect(await hasPosixGitdirWorktree(work, ["a.txt", "missing/dir/file.txt"])).toBe(false);
  }, TEST_TIMEOUT_MS);

  test("discovers one nested repository from a deleted target and preserves unrelated dirty state", async () => {
    const { root, remote, work } = await createRepository();
    await rm(join(work, "a.txt"));
    await writeFile(join(work, "b.txt"), "keep-local-b\n");

    const { result, output } = await startFinalizer(
      root,
      root,
      "nested-repository",
      ["work/a.txt"],
      "delete nested file",
    );
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
    expect(git(work, ["status", "--short"])).toBe("M b.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("rejects a parent escape while discovering a repository below the session cwd", async () => {
    const { root, remote, work } = await createRepository();
    const session = join(root, "session");
    await mkdir(session);
    await writeFile(join(work, "a.txt"), "changed-a\n");
    const beforeHead = git(work, ["rev-parse", "HEAD"]);
    const beforeIndex = git(work, ["diff", "--cached", "--name-only"]);
    const beforeStatus = git(work, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      session,
      "parent-escape",
      ["../work/a.txt"],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("File path escapes the session cwd");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(beforeHead);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe(beforeIndex);
    expect(git(work, ["status", "--short"])).toBe(beforeStatus);
  }, TEST_TIMEOUT_MS);

  test("rejects targets from different repositories below the session cwd without changing either repository", async () => {
    const { root, remote, work } = await createRepository();
    const remote2 = join(root, "remote2.git");
    const work2 = join(root, "work2");
    await mkdir(work2);
    expect(run("git", ["init", "--bare", remote2]).code).toBe(0);
    expect(run("git", ["init", "--initial-branch=main"], work2).code).toBe(0);
    git(work2, ["config", "user.name", "OMP Finalizer Test"]);
    git(work2, ["config", "user.email", "omp-finalizer@example.invalid"]);
    await writeFile(join(work2, "a.txt"), "base-2-a\n");
    git(work2, ["add", "--", "a.txt"]);
    git(work2, ["commit", "-m", "base"]);
    git(work2, ["remote", "add", "origin", remote2]);
    git(work2, ["push", "-u", "origin", "main"]);
    await writeFile(join(work, "a.txt"), "changed-1-a\n");
    await writeFile(join(work2, "a.txt"), "changed-2-a\n");
    const beforeHead = git(work, ["rev-parse", "HEAD"]);
    const beforeHead2 = git(work2, ["rev-parse", "HEAD"]);
    const beforeIndex = git(work, ["diff", "--cached", "--name-only"]);
    const beforeIndex2 = git(work2, ["diff", "--cached", "--name-only"]);
    const beforeStatus = git(work, ["status", "--short"]);
    const beforeStatus2 = git(work2, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      root,
      "mixed-repositories",
      ["work/a.txt", "work2/a.txt"],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("Files belong to different repositories");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(beforeHead);
    expect(git(work2, ["rev-parse", "HEAD"])).toBe(beforeHead2);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(beforeHead);
    expect(git(work2, ["--git-dir", remote2, "rev-parse", "refs/heads/main"])).toBe(beforeHead2);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe(beforeIndex);
    expect(git(work2, ["diff", "--cached", "--name-only"])).toBe(beforeIndex2);
    expect(git(work, ["status", "--short"])).toBe(beforeStatus);
    expect(git(work2, ["status", "--short"])).toBe(beforeStatus2);
  }, TEST_TIMEOUT_MS);

  test("rejects two distinct external repositories before changing either repository", async () => {
    const { root, remote, work } = await createRepository();
    const external1 = await createAdditionalRepository(root, "external-1");
    const external2 = await createAdditionalRepository(root, "external-2");
    const nested = join(work, "project");
    await mkdir(nested);
    await writeFile(join(work, "b.txt"), "keep-current-dirty\n");
    await writeFile(join(external1.work, "a.txt"), "changed-external-1-a\n");
    await writeFile(join(external2.work, "a.txt"), "changed-external-2-a\n");
    const currentHead = git(work, ["rev-parse", "HEAD"]);
    const externalHead1 = git(external1.work, ["rev-parse", "HEAD"]);
    const externalHead2 = git(external2.work, ["rev-parse", "HEAD"]);
    const currentStatus = git(work, ["status", "--short"]);
    const externalStatus1 = git(external1.work, ["status", "--short"]);
    const externalStatus2 = git(external2.work, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      nested,
      "two-external-repositories",
      ["../../external-1/a.txt", "../../external-2/a.txt"],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("Files belong to different repositories");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(currentHead);
    expect(git(external1.work, ["rev-parse", "HEAD"])).toBe(externalHead1);
    expect(git(external1.work, ["--git-dir", external1.remote, "rev-parse", "refs/heads/main"])).toBe(externalHead1);
    expect(git(external2.work, ["rev-parse", "HEAD"])).toBe(externalHead2);
    expect(git(external2.work, ["--git-dir", external2.remote, "rev-parse", "refs/heads/main"])).toBe(externalHead2);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(external1.work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(external2.work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(work, ["status", "--short"])).toBe(currentStatus);
    expect(git(external1.work, ["status", "--short"])).toBe(externalStatus1);
    expect(git(external2.work, ["status", "--short"])).toBe(externalStatus2);
  }, TEST_TIMEOUT_MS);

  test("rejects a current-and-external repository mix before changing either repository", async () => {
    const { root, remote, work } = await createRepository();
    const external = await createAdditionalRepository(root, "external");
    const nested = join(work, "project");
    await mkdir(nested);
    await writeFile(join(work, "a.txt"), "changed-current-a\n");
    await writeFile(join(external.work, "a.txt"), "changed-external-a\n");
    const currentHead = git(work, ["rev-parse", "HEAD"]);
    const externalHead = git(external.work, ["rev-parse", "HEAD"]);
    const currentStatus = git(work, ["status", "--short"]);
    const externalStatus = git(external.work, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      nested,
      "current-external-mix",
      ["../a.txt", "../../external/a.txt"],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("Files belong to different repositories");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(currentHead);
    expect(git(external.work, ["rev-parse", "HEAD"])).toBe(externalHead);
    expect(git(external.work, ["--git-dir", external.remote, "rev-parse", "refs/heads/main"])).toBe(externalHead);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(external.work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(work, ["status", "--short"])).toBe(currentStatus);
    expect(git(external.work, ["status", "--short"])).toBe(externalStatus);
  }, TEST_TIMEOUT_MS);

  test("rejects an absolute external-repository target without changing either repository", async () => {
    const { root, remote, work } = await createRepository();
    const external = await createAdditionalRepository(root, "external");
    const nested = join(work, "project");
    await mkdir(nested);
    await writeFile(join(work, "b.txt"), "keep-current-dirty\n");
    await writeFile(join(external.work, "a.txt"), "changed-external-a\n");
    const currentHead = git(work, ["rev-parse", "HEAD"]);
    const externalHead = git(external.work, ["rev-parse", "HEAD"]);
    const currentStatus = git(work, ["status", "--short"]);
    const externalStatus = git(external.work, ["status", "--short"]);

    const { result, output } = await startFinalizer(
      root,
      nested,
      "absolute-external",
      [join(external.work, "a.txt")],
      "must fail",
    );
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("repository");
    expect(output.error).toContain("Absolute file path is not allowed");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(currentHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(currentHead);
    expect(git(external.work, ["rev-parse", "HEAD"])).toBe(externalHead);
    expect(git(external.work, ["--git-dir", external.remote, "rev-parse", "refs/heads/main"])).toBe(externalHead);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(external.work, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(work, ["status", "--short"])).toBe(currentStatus);
    expect(git(external.work, ["status", "--short"])).toBe(externalStatus);
  }, TEST_TIMEOUT_MS);

  test("refuses an existing shared index without changing it", async () => {
    const { root, work } = await createRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "staged-a\n");
    git(work, ["add", "--", "a.txt"]);

    const { result, output } = await startFinalizer(root, work, "staged", ["a.txt"], "must fail");
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("index-preflight");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["diff", "--cached", "--name-only"])).toBe("a.txt");
  }, TEST_TIMEOUT_MS);

  test("publishes an untracked branch and records its tracking configuration", async () => {
    const { root, remote, work } = await createRepository();
    const mainHead = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-b", "feature"]);
    expect(run("git", ["config", "--get", "branch.feature.remote"], work).code).toBe(1);
    await writeFile(join(work, "a.txt"), "feature-a\n");
    await writeFile(join(work, "b.txt"), "keep-local-b\n");

    const { result, output } = await startFinalizer(root, work, "first-publish", ["a.txt"], "publish feature");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("a.txt");
    expect(git(work, ["rev-parse", `${output.commitSha}^`])).toBe(mainHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/feature"])).toBe(output.commitSha!);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(mainHead);
    expect(git(work, ["config", "--get", "branch.feature.remote"])).toBe("origin");
    expect(git(work, ["config", "--get", "branch.feature.merge"])).toBe("refs/heads/feature");
    expect(git(work, ["status", "--short"])).toBe("M b.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("retries the first publication of a new branch whose push failed after the commit", async () => {
    const { root, remote, work } = await createRepository();
    const mainHead = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-b", "feature"]);
    const hook = join(remote, "hooks", "pre-receive");
    await writeFile(hook, "#!/bin/sh\necho 'Internal Server Error' >&2\nexit 1\n");
    await chmod(hook, 0o755);
    await writeFile(join(work, "a.txt"), "feature-a\n");
    const failed = await startFinalizer(root, work, "first-publish-fails", ["a.txt"], "publish feature");
    expect(failed.result.code).toBe(1);
    expect(failed.output.stage).toBe("push");
    expect(run("git", ["--git-dir", remote, "rev-parse", "--verify", "refs/heads/feature"], work).code).not.toBe(0);
    await rm(hook);

    const { result, output } = await startFinalizer(root, work, "first-publish-retry", ["a.txt"], "publish feature");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.resumedPush).toBe(true);
    expect(output.commitSha).toBe(failed.output.commitSha!);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/feature"])).toBe(failed.output.commitSha!);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(mainHead);
    expect(git(work, ["config", "--get", "branch.feature.merge"])).toBe("refs/heads/feature");

    // 원격 main에 이미 있는 파일만 넘기는 새 브랜치는 보낼 커밋이 없으므로 거절한다.
    git(work, ["checkout", "-b", "empty", "main"]);
    const empty = await startFinalizer(root, work, "nothing-to-publish", ["b.txt"], "must fail");
    expect(empty.result.code).toBe(1);
    expect(empty.output.stage).toBe("stage");
  }, TEST_TIMEOUT_MS);

  test("publishes a configured upstream ref that does not exist on the remote yet", async () => {
    const { root, remote, work } = await createRepository();
    const mainHead = git(work, ["rev-parse", "HEAD"]);
    git(work, ["checkout", "-b", "feature"]);
    git(work, ["config", "branch.feature.remote", "origin"]);
    git(work, ["config", "branch.feature.merge", "refs/heads/release/feature"]);
    await writeFile(join(work, "a.txt"), "release-a\n");

    const { result, output } = await startFinalizer(root, work, "absent-upstream-ref", ["a.txt"], "publish release ref");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/release/feature"])).toBe(output.commitSha!);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(mainHead);
    expect(git(work, ["config", "--get", "branch.feature.merge"])).toBe("refs/heads/release/feature");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("finalizes on top of a local commit that is ahead of the upstream", async () => {
    const { root, remote, work } = await createRepository();
    await writeFile(join(work, "a.txt"), "outgoing-a\n");
    git(work, ["add", "--", "a.txt"]);
    git(work, ["commit", "-m", "local outgoing"]);
    const outgoing = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "b.txt"), "pending-b\n");

    const { result, output } = await startFinalizer(root, work, "ahead", ["b.txt"], "change b");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(output.ok).toBe(true);
    expect(output.stage).toBe("complete");
    expect(git(work, ["rev-parse", `${output.commitSha}^`])).toBe(outgoing);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", output.commitSha!])).toBe("b.txt");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(output.commitSha!);
    expect(git(work, ["status", "--short"])).toBe("");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("refuses a diverged branch and preserves both the local and remote state", async () => {
    const { root, remote, work } = await createRepository();
    const clone = join(root, "clone");
    expect(run("git", ["clone", "--branch", "main", remote, clone]).code).toBe(0);
    git(clone, ["config", "user.name", "OMP Finalizer Test"]);
    git(clone, ["config", "user.email", "omp-finalizer@example.invalid"]);
    await writeFile(join(clone, "a.txt"), "remote-side-a\n");
    git(clone, ["add", "--", "a.txt"]);
    git(clone, ["commit", "-m", "remote side"]);
    git(clone, ["push"]);
    const remoteHead = git(clone, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "local-side-a\n");
    git(work, ["add", "--", "a.txt"]);
    git(work, ["commit", "-m", "local side"]);
    const localHead = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "b.txt"), "pending-b\n");

    const { result, output } = await startFinalizer(root, work, "diverged", ["b.txt"], "must fail");
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("fetch");
    expect(output.error).toContain("behind or diverged");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(localHead);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(remoteHead);
    expect(git(work, ["status", "--short"])).toBe("M b.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("reports an unreachable remote without touching the index or the worktree", async () => {
    const { root, work } = await createRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    git(work, ["remote", "set-url", "origin", join(root, "missing.git")]);
    await writeFile(join(work, "a.txt"), "pending-a\n");

    const { result, output } = await startFinalizer(root, work, "unreachable-remote", ["a.txt"], "must fail");
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("remote-probe");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["status", "--short"])).toBe("M a.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("preserves the exact name of a sole mixed-case remote on first publication", async () => {
    const { root, remote, work } = await createRepository();
    git(work, ["remote", "rename", "origin", "temporary"]);
    git(work, ["remote", "rename", "temporary", "Origin"]);
    git(work, ["checkout", "-b", "feature"]);
    await writeFile(join(work, "a.txt"), "mixed-case-remote\n");

    const { result, output } = await startFinalizer(root, work, "mixed-case", ["a.txt"], "publish feature");
    expect(result.code, result.stderr || result.stdout).toBe(0);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/feature"])).toBe(output.commitSha!);
    expect(git(work, ["config", "--get", "branch.feature.remote"])).toBe("Origin");
  }, TEST_TIMEOUT_MS);

  test("refuses an untracked branch when the remote choice is ambiguous", async () => {
    const { root, work } = await createRepository();
    const second = join(root, "second.git");
    expect(run("git", ["init", "--bare", second]).code).toBe(0);
    git(work, ["remote", "rename", "origin", "primary"]);
    git(work, ["remote", "add", "secondary", second]);
    git(work, ["checkout", "-b", "feature"]);
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "pending-a\n");

    const { result, output } = await startFinalizer(root, work, "ambiguous-remote", ["a.txt"], "must fail");
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("remote");
    expect(output.error).toContain("multiple remotes");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", second, "for-each-ref", "--format=%(refname)"])).toBe("");
    expect(git(work, ["status", "--short"])).toBe("M a.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("rolls back only its staging when the declared path set does not match", async () => {
    const { root, work } = await createRepository();
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "a.txt"), "changed-a\n");

    const { result, output } = await startFinalizer(root, work, "scope", ["a.txt", "b.txt"], "must fail");
    expect(result.code).toBe(1);
    expect(output.ok).toBe(false);
    expect(output.stage).toBe("stage");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["status", "--short"])).toBe("M a.txt");
    expect(run("git", ["diff", "--cached", "--quiet", "--exit-code"], work).code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test("pushes the existing commit when a retry follows a commit whose push failed", async () => {
    const { root, remote, work } = await createRepository();
    const hook = join(remote, "hooks", "pre-receive");
    const commitButFailPush = async (file: string, name: string) => {
      await writeFile(hook, "#!/bin/sh\necho 'Internal Server Error' >&2\nexit 1\n");
      await chmod(hook, 0o755);
      const before = git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"]);
      await writeFile(join(work, file), `changed-${file}\n`);
      const failed = await startFinalizer(root, work, name, [file], `change ${file}`);
      expect(failed.result.code).toBe(1);
      expect(failed.output.stage).toBe("push");
      expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
      await rm(hook);
      return failed.output.commitSha!;
    };

    // 같은 파일로 다시 부르면 새 커밋 없이 남은 커밋을 보낸다.
    const first = await commitButFailPush("a.txt", "push-fails");
    const resumed = await startFinalizer(root, work, "push-retry", ["a.txt"], "change a.txt");
    expect(resumed.result.code, resumed.result.stderr || resumed.result.stdout).toBe(0);
    expect(resumed.output.resumedPush).toBe(true);
    expect(resumed.output.commitSha).toBe(first);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(first);

    // 재시도에 새 변경(예: 기억 transport)이 붙으면 그것만 새로 커밋해 함께 보낸다.
    const second = await commitButFailPush("b.txt", "push-fails-again");
    await writeFile(join(work, "c.txt"), "new-c\n");
    const mixed = await startFinalizer(root, work, "mixed-retry", ["b.txt", "c.txt"], "add c");
    expect(mixed.result.code, mixed.result.stderr || mixed.result.stdout).toBe(0);
    expect(mixed.output.resumedPush).toBe(true);
    expect(git(work, ["rev-parse", `${mixed.output.commitSha}^`])).toBe(second);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", mixed.output.commitSha!])).toBe("c.txt");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(mixed.output.commitSha!);

    // 이미 원격에 올라간 깨끗한 파일은 여전히 거절한다.
    const pushed = await startFinalizer(root, work, "nothing-pending", ["a.txt"], "must fail");
    expect(pushed.result.code).toBe(1);
    expect(pushed.output.stage).toBe("stage");
  }, TEST_TIMEOUT_MS);

  test("serializes two finalizers for one repository and upstream", async () => {
    const { root, remote, work } = await createRepository();
    await writeFile(join(work, "a.txt"), "parallel-a\n");
    await writeFile(join(work, "b.txt"), "parallel-b\n");

    const results = await Promise.all([
      startFinalizer(root, work, "parallel-a", ["a.txt"], "change a"),
      startFinalizer(root, process.platform === "win32" ? work.toUpperCase() : work, "parallel-b", ["b.txt"], "change b"),
    ]);
    for (const item of results) {
      expect(item.result.code, item.result.stderr || item.result.stdout).toBe(0);
      expect(item.output.ok).toBe(true);
    }

    const remoteHead = git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"]);
    expect(remoteHead).toBe(git(work, ["rev-parse", "HEAD"]));
    expect(git(work, ["rev-list", "--count", "HEAD"])).toBe("3");
    const commits = git(work, ["log", "-2", "--format=%H"]).split(/\r?\n/);
    const changed = commits.map((sha) => git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).sort();
    expect(changed).toEqual(["a.txt", "b.txt"]);
  }, TEST_TIMEOUT_MS);
});

describe("WSL drive git executor selection", () => {
  test("windowsPathToPosix converts only drive-letter paths", () => {
    expect(windowsPathToPosix("D:/repo/.git")).toBe("/mnt/d/repo/.git");
    expect(windowsPathToPosix("E:\\a\\b\\")).toBe("/mnt/e/a/b");
    expect(windowsPathToPosix("C:/")).toBe("/mnt/c");
    expect(windowsPathToPosix("D:/한글/파일.txt")).toBe("/mnt/d/한글/파일.txt");
    expect(windowsPathToPosix("/mnt/d/repo/.git")).toBe("/mnt/d/repo/.git");
    expect(windowsPathToPosix("relative/path")).toBe("relative/path");
  });

  describe.skipIf(process.platform !== "linux")("on Linux", () => {
    const saved = { wsl: process.env.WSL_DISTRO_NAME, path: process.env.PATH };
    afterEach(() => {
      if (saved.wsl === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = saved.wsl;
      process.env.PATH = saved.path;
    });

    async function pathWithGitExe(): Promise<string> {
      const directory = await mkdtemp(join(tmpdir(), "omp-fake-gitexe-"));
      tempRoots.push(directory);
      await writeFile(join(directory, "git.exe"), "");
      return `${directory}:${saved.path}`;
    }

    test("uses Windows git only for WSL drive paths and maps its output back to POSIX", async () => {
      process.env.WSL_DISTRO_NAME = "Ubuntu-Test";
      process.env.PATH = await pathWithGitExe();

      const drive = await selectGitExecutor("/mnt/d/none/repo");
      expect(drive.command).toBe("git.exe");
      expect(drive.toPosix("D:/none/repo/.git")).toBe("/mnt/d/none/repo/.git");
      expect((await selectGitExecutor("/mnt/d")).command).toBe("git.exe");

      for (const directory of ["/mnt/dd/repo", "/mnt/wsl/repo", "/tmp/repo", "/home/user/repo"]) {
        const executor = await selectGitExecutor(directory);
        expect(executor.command, directory).toBe("git");
        expect(executor.toPosix("D:/none/repo/.git")).toBe("D:/none/repo/.git");
      }
    });

    test("keeps Linux git outside WSL and when git.exe is not on PATH", async () => {
      process.env.PATH = await pathWithGitExe();
      delete process.env.WSL_DISTRO_NAME;
      expect((await selectGitExecutor("/mnt/d/none/repo")).command).toBe("git");

      process.env.WSL_DISTRO_NAME = "Ubuntu-Test";
      process.env.PATH = "/usr/bin:/bin";
      expect((await selectGitExecutor("/mnt/d/none/repo")).command).toBe("git");
    });

    test("runs the finalizer on the Windows side only when the target files are on a drive, not just the cwd", async () => {
      process.env.WSL_DISTRO_NAME = "Ubuntu-Test";
      const converted: string[] = [];
      const exec = async (_command: string, args: string[]) => {
        converted.push(args[1]);
        return { code: 0, stdout: `F:\\converted\\${converted.length}`, stderr: "" };
      };

      // cwd는 Windows 사본, 대상은 WSL ext4 원본: Windows git이 열 수 없으니 Linux 쪽으로 남는다.
      const ext4 = await windowsDrivePaths("/mnt/f/none/CUELO", ["../../../../home/user/src/repo/a.txt"], ["/mnt/f/none/CUELO"], exec);
      expect(ext4).toBeUndefined();
      expect(converted).toEqual([]);

      const drive = await windowsDrivePaths("/mnt/f/none/CUELO", ["a.txt"], ["/mnt/f/none/CUELO"], exec);
      expect(drive).toEqual(["F:\\converted\\1"]);
    });
  });
});

const wipe = "import { rmSync } from \"node:fs\";\nexport const wipe = (path: string) => rmSync(path, { recursive: true });\n";

async function reviewAndResolve(work: string, ledger: string, files: string[]) {
  const store = createRoutingLedger(ledger);
  const deps = {
    cwd: work, sessionId: "gate-test", mainModel: "anthropic/claude-opus-5-5", exec: spawnExec(),
    readAll: () => readCrossReviewRecords(ledger), append: (record: Parameters<typeof store.append>[0]) => store.append(record),
    snapshotRoot: join(dirname(ledger), "snapshots"),
    complete: async () => ({ model: "openai-codex/gpt-6-astra", text: "{\"findings\":[]}" }),
  };
  const review = await runReview({ files, acceptance: "must not delete", authors: ["main"] }, deps, new AbortController().signal);
  return runResolve({ reviewId: review.reviewId, resolutions: [] }, deps);
}

describe("cross-family review gate", () => {
  const savedLedger = process.env.OMP_CROSS_REVIEW_LEDGER;
  afterEach(() => {
    if (savedLedger === undefined) delete process.env.OMP_CROSS_REVIEW_LEDGER;
    else process.env.OMP_CROSS_REVIEW_LEDGER = savedLedger;
  });

  test("refuses a marker-hitting code change, passes after review+resolve, and never gates docs", async () => {
    const { root, work, remote } = await createRepository();
    const ledger = join(root, "ledger.jsonl");
    process.env.OMP_CROSS_REVIEW_LEDGER = ledger;
    const before = git(work, ["rev-parse", "HEAD"]);

    await writeFile(join(work, "wipe.ts"), wipe);
    const refused = await startTool(work, ["wipe.ts"]);
    expect(refused.error?.message).toContain("git_finalize failed at cross-review");
    expect(refused.error?.message).toContain("marker deletion at L2");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);

    const resolved = await reviewAndResolve(work, ledger, ["wipe.ts"]);
    expect(resolved.pass).toBe(true);
    const passed = await startTool(work, ["wipe.ts"]);
    expect(passed.error).toBeUndefined();
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(git(work, ["rev-parse", "HEAD"]));

    await writeFile(join(work, "a.txt"), "docs-only change with rm -rf and password\n");
    const docs = await startTool(work, ["a.txt"]);
    expect(docs.error).toBeUndefined();
  }, TEST_TIMEOUT_MS);

  test("a reviewed code file and the generated memory transport are committed together under the locked blob check", async () => {
    const { root, work, remote } = await createRepository();
    const ledger = join(root, "ledger.jsonl");
    process.env.OMP_CROSS_REVIEW_LEDGER = ledger;
    const syncDir = join(work, "Tools", "OMP_Global_Config", "memory-sync");
    await mkdir(syncDir, { recursive: true });
    await writeFile(join(syncDir, "sync.ts"),
      "const [mode, root] = process.argv.slice(2);\n"
      + "if (mode !== 'export') process.exit(2);\n"
      + "await Bun.write(root + '/Tools/OMP_Global_Config/memory-sync/memories.jsonl', 'lesson-from-this-pc\\n');\n");
    await writeFile(join(work, "wipe.ts"), wipe);
    expect((await reviewAndResolve(work, ledger, ["wipe.ts"])).pass).toBe(true);

    const { error, output } = await startTool(work, ["wipe.ts"]);
    expect(error).toBeUndefined();
    const sha = git(work, ["rev-parse", "HEAD"]);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(sha);
    expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split(/\r?\n/).sort())
      .toEqual(["Tools/OMP_Global_Config/memory-sync/memories.jsonl", "wipe.ts"]);
    expect(JSON.stringify(output)).toContain("memories.jsonl");
  }, TEST_TIMEOUT_MS);

  test("a recorded waiver lets the commit through; declared high-risk gates plain code", async () => {
    const { root, work } = await createRepository();
    process.env.OMP_CROSS_REVIEW_LEDGER = join(root, "ledger.jsonl");
    await writeFile(join(work, "plain.ts"), "export const one = 1;\n");
    const declared = await startTool(work, ["plain.ts"], { crossReviewHighRisk: ["plain.ts"] });
    expect(declared.error?.message).toContain("declared high-risk");
    const waived = await startTool(work, ["plain.ts"], { crossReviewHighRisk: ["plain.ts"], crossReviewWaiver: "user approved skipping review" });
    expect(waived.error).toBeUndefined();
    expect(readCrossReviewRecords(join(root, "ledger.jsonl"))).toMatchObject([{ type: "cross-review-waiver", reason: "user approved skipping review" }]);
  }, TEST_TIMEOUT_MS);
});

describe("AI-slop gate", () => {
  const savedLedger = process.env.OMP_SLOP_GATE_LEDGER;
  afterEach(() => {
    if (savedLedger === undefined) delete process.env.OMP_SLOP_GATE_LEDGER;
    else process.env.OMP_SLOP_GATE_LEDGER = savedLedger;
  });
  const readme = "# 소개\n\n저장 버튼을 누르면 파일이 내려받기 폴더에 들어간다.\n";

  function passFor(ledger: string, abs: string, content: string): void {
    appendSlopRecord(ledger, { type: "slop-pass", path: abs, sha256: sha256(content), reviewedAt: "2026-10-26T00:00:00Z", model: "fake/reviewer", reviewId: "slop-test", findings: [] });
  }

  /** The slop gate covers public artifacts only: the work tree gets a root .publicignore (as CUELO-private has), so its README/docs are public. */
  async function publicRepository() {
    const repository = await createRepository();
    await writeFile(join(repository.work, ".publicignore"), "/private/\n");
    return repository;
  }

  test("refuses a visible artifact without a pass, commits it after the pass, and refuses again once a byte changes", async () => {
    const { root, work, remote } = await publicRepository();
    const ledger = join(root, "slop.jsonl");
    process.env.OMP_SLOP_GATE_LEDGER = ledger;
    const before = git(work, ["rev-parse", "HEAD"]);

    await writeFile(join(work, "page.html"), readme);
    const refused = await startTool(work, ["page.html"]);
    expect(refused.error?.message).toContain("git_finalize failed at slop-gate");
    expect(refused.error?.message).toContain("- page.html");
    expect(refused.error?.message).toContain("slop_check");
    expect(git(work, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);

    passFor(ledger, join(work, "page.html"), readme);
    const passed = await startTool(work, ["page.html"]);
    expect(passed.error).toBeUndefined();
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(git(work, ["rev-parse", "HEAD"]));

    await writeFile(join(work, "page.html"), `${readme}한 줄을 더했다.\n`);
    const stale = await startTool(work, ["page.html"]);
    expect(stale.error?.message).toContain("failed at slop-gate");
    expect(stale.error?.message).toContain("older version");
  }, TEST_TIMEOUT_MS);

  test("never gates code, tests, internal records or data files, and the gate hands finalizer the blob of the checked bytes", async () => {
    const { root, work } = await publicRepository();
    process.env.OMP_SLOP_GATE_LEDGER = join(root, "slop.jsonl");
    await mkdir(join(work, "doc", "history"), { recursive: true });
    await writeFile(join(work, "doc", "history", "record.md"), "내부 기록\n");
    await writeFile(join(work, "HANDOFF.md"), "# handoff\n");
    await writeFile(join(work, "README.md"), readme);
    await writeFile(join(work, "a.txt"), "data change\n");
    const internal = await startTool(work, ["doc/history/record.md", "HANDOFF.md", "README.md", "a.txt"]);
    expect(internal.error).toBeUndefined();

    await writeFile(join(work, "b.txt"), "plain data\n");
    await writeFile(join(work, "guide.html"), readme);
    passFor(join(root, "slop.jsonl"), join(work, "guide.html"), readme);
    const outcome = await runSlopGate({ cwd: work, files: ["guide.html", "b.txt"], ledgerPath: join(root, "slop.jsonl") });
    expect(outcome.artifacts).toEqual([{ path: "guide.html", sha256: sha256(readme) }]);
    expect(outcome.gateBlobs).toEqual({ "guide.html": git(work, ["hash-object", "guide.html"]), "b.txt": git(work, ["hash-object", "b.txt"]) });
  }, TEST_TIMEOUT_MS);

  test("a mixed commit keeps the cross-review gate in force: reviewed code and a passed document are committed together, and an unreviewed code file is still refused at cross-review", async () => {
    const { root, work, remote } = await publicRepository();
    const slopLedger = join(root, "slop.jsonl");
    const crossLedger = join(root, "cross.jsonl");
    process.env.OMP_SLOP_GATE_LEDGER = slopLedger;
    const savedCross = process.env.OMP_CROSS_REVIEW_LEDGER;
    process.env.OMP_CROSS_REVIEW_LEDGER = crossLedger;
    try {
      await writeFile(join(work, "wipe.ts"), wipe);
      await writeFile(join(work, "page.html"), readme);
      passFor(slopLedger, join(work, "page.html"), readme);
      const refused = await startTool(work, ["wipe.ts", "page.html"]);
      expect(refused.error?.message).toContain("failed at cross-review");

      expect((await reviewAndResolve(work, crossLedger, ["wipe.ts"])).pass).toBe(true);
      const passed = await startTool(work, ["wipe.ts", "page.html"]);
      expect(passed.error).toBeUndefined();
      const sha = git(work, ["rev-parse", "HEAD"]);
      expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(sha);
      expect(git(work, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha]).split(/\r?\n/).sort()).toEqual(["page.html", "wipe.ts"]);
    } finally {
      if (savedCross === undefined) delete process.env.OMP_CROSS_REVIEW_LEDGER;
      else process.env.OMP_CROSS_REVIEW_LEDGER = savedCross;
    }
  }, TEST_TIMEOUT_MS);

  test("a recorded waiver lets the commit through and names the files and hashes in the ledger", async () => {
    const { root, work } = await publicRepository();
    const ledger = join(root, "slop.jsonl");
    process.env.OMP_SLOP_GATE_LEDGER = ledger;
    await writeFile(join(work, "page.html"), readme);
    const waived = await startTool(work, ["page.html"], { slopGateWaiver: "user approved skipping the slop check" });
    expect(waived.error).toBeUndefined();
    expect(readSlopRecords(ledger)).toMatchObject([{ type: "slop-waiver", reason: "user approved skipping the slop check", files: [{ path: "page.html", sha256: sha256(readme) }] }]);
  }, TEST_TIMEOUT_MS);

  test("a pass for the content does not cover a file whose bytes differ at the lock: the blob check still refuses", async () => {
    const { root, remote, work } = await publicRepository();
    const ledger = join(root, "slop.jsonl");
    process.env.OMP_SLOP_GATE_LEDGER = ledger;
    const before = git(work, ["rev-parse", "HEAD"]);
    await writeFile(join(work, "page.html"), readme);
    passFor(ledger, join(work, "page.html"), readme);
    const outcome = await runSlopGate({ cwd: work, files: ["page.html"], ledgerPath: ledger });
    await writeFile(join(work, "page.html"), `${readme}게이트 뒤에 바뀐 줄\n`);
    const { result, output } = await startFinalizer(root, work, "slop-late-change", ["page.html"], "late change", { gateBlobs: outcome.gateBlobs });
    expect(result.code).toBe(1);
    expect(output.stage).toBe("cross-review-verify");
    expect(output.error).toContain("page.html changed after the review check");
    expect(git(work, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).toBe(before);
  }, TEST_TIMEOUT_MS);
});
