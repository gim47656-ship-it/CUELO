import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

function writableDriveBase() {
  if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME) return undefined;
  if (spawnSync("which", ["git.exe"]).status !== 0) return undefined;
  for (const base of ["/mnt/c/Users/Public", "/mnt/d", "/mnt/e", "/mnt/f"]) {
    try {
      rmSync(mkdtempSync(path.join(base, "cuelo-git-changes-probe-")), { recursive: true });
      return base;
    } catch {
      // 다음 drive를 본다.
    }
  }
  return undefined;
}

const driveBase = writableDriveBase();

function createChangedRepository(base) {
  const root = realpathSync(mkdtempSync(path.join(base, "cuelo-git-changes-")));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  mkdirSync(path.join(root, "a"));
  mkdirSync(path.join(root, "b"));
  writeFileSync(path.join(root, "a", "x.txt"), "x\n");
  writeFileSync(path.join(root, "b", "y.txt"), "y\n");
  git("init", "--quiet");
  git("add", "--", ".");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "init");
  writeFileSync(path.join(root, "a", "x.txt"), "x\nchanged\n");
  writeFileSync(path.join(root, "a", "한글.txt"), "new\n");
  writeFileSync(path.join(root, "b", "y.txt"), "y\nchanged\n");
  writeFileSync(path.join(root, "root.txt"), "root\n");
  return root;
}

const repositoryCases = [
  ["ext4/tmp repository", () => tmpdir()],
  ["WSL drive repository (Windows git)", () => driveBase],
];

for (const [label, base] of repositoryCases) {
  test(`git changes for ${label} scope status to the session cwd and report POSIX paths`, { skip: !base() }, async () => {
    const { getGitStatus, getGitFileDiff } = await import("./git-changes.ts");
    const root = createChangedRepository(base());
    try {
      const subdirectory = await getGitStatus(path.join(root, "a"));
      assert.equal(subdirectory.isGitRepository, true);
      assert.equal(subdirectory.repositoryRoot, root);
      assert.deepEqual(
        subdirectory.files.map((file) => [file.filePath, file.status]).sort(),
        [
          [path.join(root, "a", "x.txt"), "modified"],
          [path.join(root, "a", "한글.txt"), "untracked"],
        ].sort(),
      );
      // x.txt에 한 줄 추가 + 한글.txt 한 줄. b/y.txt와 root.txt는 cwd 밖이라 세지 않는다.
      assert.equal(subdirectory.additions, 2);
      assert.equal(subdirectory.deletions, 0);

      const whole = await getGitStatus(root);
      assert.deepEqual(
        whole.files.map((file) => path.relative(root, file.filePath)).sort(),
        [path.join("a", "x.txt"), path.join("a", "한글.txt"), path.join("b", "y.txt"), "root.txt"].sort(),
      );

      const diff = await getGitFileDiff(path.join(root, "a"), path.join(root, "a", "x.txt"));
      assert.equal(diff.supported, true);
      assert.match(diff.patch, /\+changed/);
      // cwd 밖 파일의 diff는 예전처럼 저장소 전체 status로 찾는다.
      const outside = await getGitFileDiff(path.join(root, "a"), path.join(root, "b", "y.txt"));
      assert.equal(outside.supported, true);
      assert.match(outside.patch, /\+changed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
