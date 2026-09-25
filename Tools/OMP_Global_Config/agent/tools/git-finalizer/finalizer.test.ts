import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./finalizer.ps1", import.meta.url));
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

async function createRepository(): Promise<{ root: string; remote: string; work: string }> {
  const root = await mkdtemp(join(tmpdir(), "omp-finalizer-test-"));
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
): Promise<{ result: CommandResult; output: FinalizerOutput }> {
  const request = join(root, `${name}.json`);
  await writeFile(request, JSON.stringify({ cwd: work, files, message }), "utf8");
  const process = Bun.spawn({
    cmd: ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Request", request],
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

describe.skipIf(process.platform !== "win32")("git finalizer", () => {
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

  test("accepts a direct file when the repository root is a mapped drive root", async () => {
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

  test("serializes two finalizers for one repository and upstream", async () => {
    const { root, remote, work } = await createRepository();
    await writeFile(join(work, "a.txt"), "parallel-a\n");
    await writeFile(join(work, "b.txt"), "parallel-b\n");

    const results = await Promise.all([
      startFinalizer(root, work, "parallel-a", ["a.txt"], "change a"),
      startFinalizer(root, work.toUpperCase(), "parallel-b", ["b.txt"], "change b"),
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
