import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 하네스(~/.omp/agent로 복사)와 앱은 번들이 달라 같은 규칙을 파일 둘로 둔다. 같은 입력에 같은 판정을 내는지 본다.
const implementations = {
  app: await import("./wsl-git.ts"),
  harness: await import("../Tools/OMP_Global_Config/agent/tools/git-finalizer/wsl-git.ts"),
};

function writableDriveBase() {
  if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME) return undefined;
  if (spawnSync("which", ["git.exe"]).status !== 0) return undefined;
  for (const base of ["/mnt/c/Users/Public", "/mnt/d", "/mnt/e", "/mnt/f"]) {
    try {
      rmSync(mkdtempSync(join(base, "cuelo-wsl-git-probe-")), { recursive: true });
      return base;
    } catch {
      // 다음 drive를 본다.
    }
  }
  return undefined;
}

const driveBase = writableDriveBase();

function withEnv(values, run) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return run().finally(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

for (const [name, subject] of Object.entries(implementations)) {
  test(`${name}: converts Windows drive paths to POSIX and leaves other paths alone`, () => {
    assert.equal(subject.windowsPathToPosix("D:/repo/.git"), "/mnt/d/repo/.git");
    assert.equal(subject.windowsPathToPosix("E:\\a\\b\\"), "/mnt/e/a/b");
    assert.equal(subject.windowsPathToPosix("C:/"), "/mnt/c");
    assert.equal(subject.windowsPathToPosix("D:/한글/파일.txt"), "/mnt/d/한글/파일.txt");
    assert.equal(subject.windowsPathToPosix("/mnt/d/repo"), "/mnt/d/repo");
    assert.equal(subject.windowsPathToPosix("relative/path"), "relative/path");
  });

  test(`${name}: picks Windows git only for WSL drive paths with git.exe on PATH`, { skip: process.platform !== "linux" }, async () => {
    const bin = mkdtempSync(join(tmpdir(), "cuelo-fake-gitexe-"));
    try {
      writeFileSync(join(bin, "git.exe"), "");
      const withGitExe = `${bin}:${process.env.PATH}`;
      await withEnv({ WSL_DISTRO_NAME: "Ubuntu-Test", PATH: withGitExe }, async () => {
        assert.equal((await subject.selectGitExecutor("/mnt/d/none/repo")).command, "git.exe");
        assert.equal((await subject.selectGitExecutor("/mnt/d")).command, "git.exe");
        for (const directory of ["/mnt/dd/repo", "/mnt/wsl/repo", "/tmp/repo", "/home/user/repo"]) {
          assert.equal((await subject.selectGitExecutor(directory)).command, "git", directory);
        }
        assert.equal((await subject.selectGitExecutor("/mnt/d/none/repo")).toPosix("D:/none/repo/.git"), "/mnt/d/none/repo/.git");
        assert.equal((await subject.selectGitExecutor("/tmp/repo")).toPosix("D:/none/repo/.git"), "D:/none/repo/.git");
      });
      await withEnv({ WSL_DISTRO_NAME: undefined, PATH: withGitExe }, async () => {
        assert.equal((await subject.selectGitExecutor("/mnt/d/none/repo")).command, "git");
      });
      await withEnv({ WSL_DISTRO_NAME: "Ubuntu-Test", PATH: "/usr/bin:/bin" }, async () => {
        assert.equal((await subject.selectGitExecutor("/mnt/d/none/repo")).command, "git");
      });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test(`${name}: keeps Linux git for a POSIX-gitdir linked worktree on a drive`, { skip: !driveBase }, async () => {
    const root = mkdtempSync(join(driveBase, "cuelo-wsl-git-"));
    try {
      const main = join(root, "main");
      const linked = join(root, "linked");
      mkdirSync(main);
      const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
      git(main, "init", "--quiet");
      git(main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init");
      git(main, "worktree", "add", "--quiet", "-b", "linked", linked);
      mkdirSync(join(linked, "sub"));

      assert.equal((await subject.selectGitExecutor(main)).command, "git.exe");
      assert.equal((await subject.selectGitExecutor(linked)).command, "git");
      assert.equal((await subject.selectGitExecutor(join(linked, "sub"))).command, "git");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// worktree 조회는 Windows git으로 읽되 POSIX 경로로 돌려주고, Linux git이 등록한 worktree를 prunable로 잃지 않아야 한다.
test("worktree listing on a WSL drive repository returns POSIX paths for Windows- and Linux-registered worktrees", { skip: !driveBase }, async () => {
  const { listWorktrees, resolveProject, invalidateProjectCache } = await import("./worktree.ts");
  const root = realpathSync(mkdtempSync(join(driveBase, "cuelo-worktree-")));
  try {
    const main = join(root, "main");
    const linuxWorktree = join(root, "linux-wt");
    const windowsWorktree = join(root, "windows-wt");
    mkdirSync(main);
    const run = (command, cwd, ...args) => execFileSync(command, args, { cwd, stdio: "pipe" });
    run("git", main, "init", "--quiet", "-b", "main");
    run("git", main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "init");
    run("git", main, "worktree", "add", "--quiet", "-b", "linux-branch", linuxWorktree);
    run("git.exe", main, "worktree", "add", "--quiet", "-b", "windows-branch", windowsWorktree.replace(/^\/mnt\/(\w)\//, (_, d) => `${d.toUpperCase()}:/`));

    invalidateProjectCache();
    const expected = [
      { path: main, branch: "main", isMain: true },
      { path: linuxWorktree, branch: "linux-branch", isMain: false },
      { path: windowsWorktree, branch: "windows-branch", isMain: false },
    ];
    assert.deepEqual(await listWorktrees(main), expected);
    assert.deepEqual(await resolveProject(main), { projectRoot: main, branch: "main", isWorktree: false, isTopLevel: true });
    assert.deepEqual(await resolveProject(windowsWorktree), { projectRoot: main, branch: "windows-branch", isWorktree: true, isTopLevel: true });
    // POSIX gitdir worktree는 Linux git으로 열린다.
    assert.deepEqual(await resolveProject(linuxWorktree), { projectRoot: main, branch: "linux-branch", isWorktree: true, isTopLevel: true });
  } finally {
    invalidateProjectCache();
    rmSync(root, { recursive: true, force: true });
  }
});
