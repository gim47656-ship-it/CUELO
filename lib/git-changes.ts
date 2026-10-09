import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";
import { selectGitExecutor, type GitExecutor } from "./wsl-git";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(
  executor: GitExecutor,
  cwd: string,
  args: string[],
  maxBuffer = GIT_STATUS_MAX_BUFFER,
): Promise<string> {
  const { stdout } = await execFileAsync(executor.command, args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(executor: GitExecutor, cwd: string): Promise<string | null> {
  try {
    // Windows git은 `D:/repo`를 돌려준다. 호출자가 비교하는 POSIX 경로로 되돌린다.
    const root = executor.toPosix((await git(executor, cwd, ["rev-parse", "--show-toplevel"])).trim());
    return root || null;
  } catch {
    return null;
  }
}

function isWithinPath(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

/**
 * 세션 cwd로 좁히는 pathspec. cwd가 저장소 root이면 ".", 하위 디렉터리이면 literal 상대경로다.
 * cwd가 root 밖으로 풀리면(symlink·대소문자 차이) undefined다. 하위 디렉터리 세션이 저장소 전체를
 * 훑지 않게 하려는 것이다. 9p 위 큰 저장소에서는 이 차이가 곧 응답 시간이다.
 */
function cwdPathspec(repositoryRoot: string, cwd: string): string | undefined {
  const relative = toGitPath(path.relative(repositoryRoot, cwd));
  if (relative === "") return ".";
  if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return undefined;
  return `:(literal)${relative}`;
}

async function readStatusEntries(
  executor: GitExecutor,
  repositoryRoot: string,
  pathspec?: string,
): Promise<GitPorcelainEntry[]> {
  const output = await git(executor, repositoryRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    ...(pathspec && pathspec !== "." ? ["--", pathspec] : []),
  ]);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(
  executor: GitExecutor,
  repositoryRoot: string,
  pathspec: string | undefined,
): Promise<{ additions: number; deletions: number }> {
  if (!pathspec) return { additions: 0, deletions: 0 };
  try {
    const output = await git(executor, repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

function countUntrackedTextLines(filePath: string): number {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return 0;
    const content = fs.readFileSync(filePath);
    if (hasNullByte(content) || content.length === 0) return 0;
    const text = content.toString("utf8");
    return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  } catch {
    return 0;
  }
}

export async function getGitStatus(cwd: string): Promise<GitStatusResponse> {
  const executor = await selectGitExecutor(cwd);
  const repositoryRoot = await findRepositoryRoot(executor, cwd);
  if (!repositoryRoot) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  const pathspec = cwdPathspec(repositoryRoot, cwd);
  const [entries, trackedLineStats] = await Promise.all([
    readStatusEntries(executor, repositoryRoot, pathspec),
    readTrackedLineStats(executor, repositoryRoot, pathspec),
  ]);
  const files = entries.flatMap((entry): GitFileStatus[] => {
    const filePath = path.resolve(repositoryRoot, entry.path);
    if (!isWithinPath(cwd, filePath)) return [];
    const classified = classifyGitStatus(entry);
    return [{
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    }];
  });
  const untrackedAdditions = files.reduce(
    (total, file) => total + (file.status === "untracked" ? countUntrackedTextLines(file.filePath) : 0),
    0,
  );

  return {
    isGitRepository: true,
    repositoryRoot,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  executor: GitExecutor,
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(executor, repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  const executor = await selectGitExecutor(cwd);
  const repositoryRoot = await findRepositoryRoot(executor, cwd);
  if (!repositoryRoot || !isWithinPath(repositoryRoot, filePath)) return { supported: false };

  const resolvedFilePath = path.resolve(filePath);
  const relativePath = toGitPath(path.relative(repositoryRoot, resolvedFilePath));
  // cwd 밖 파일은 cwd pathspec에 걸리지 않으므로 그때만 저장소 전체를 본다.
  const pathspec = isWithinPath(cwd, resolvedFilePath) ? cwdPathspec(repositoryRoot, cwd) : undefined;
  const entries = await readStatusEntries(executor, repositoryRoot, pathspec);
  const entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(executor, repositoryRoot, relativePath, entry.originalPath);
    if (!patch?.includes("\n@@ ")) return { supported: false };
    return { supported: true, status, patch };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedFilePath);
  } catch {
    return { supported: false };
  }
  if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false };

  const currentBuffer = fs.readFileSync(resolvedFilePath);
  if (hasNullByte(currentBuffer)) return { supported: false };
  const newContent = currentBuffer.toString("utf8");

  let patch: string;
  if (status === "untracked") {
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(executor, repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.includes("\n@@ ")) return { supported: false };
  return { supported: true, status, patch };
}
