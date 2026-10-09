/**
 * WSL에서 Windows 드라이브(`/mnt/<드라이브>/`) 위 저장소를 어느 git으로 다룰지 정하는 공용 규칙.
 *
 * Linux git은 9p로 파일마다 stat해 3,905개 파일 저장소의 `git status`가 4초 가까이 걸린다(2026-10-09 실측).
 * 같은 저장소를 Windows `git.exe`(interop)에 맡기면 수십 ms다. 그래서 WSL + `/mnt/<드라이브>/` 경로면 Windows git을
 * 쓴다. 단 하나는 예외다: WSL Linux git이 만든 linked worktree는 `.git` 파일에 `gitdir: /mnt/e/...` 같은 Linux 경로를
 * 적어 Windows git이 따라가지 못한다. 그런 worktree는 느려도 Linux git이다.
 *
 * 이 파일은 `lib/wsl-git.ts`(Next 앱)와 같은 규칙의 짝이다. 하네스는 ~/.omp/agent로 복사돼 앱 번들과 분리되므로
 * 한쪽이 다른 쪽을 import할 수 없다. 규칙을 바꿀 때는 두 파일을 함께 바꾼다(`lib/wsl-git.test.mjs`가 두 구현이
 * 같은 판정을 내는지 확인한다).
 */
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

export interface GitExecutor {
  /** execFile에 넘길 실행 파일. */
  command: "git" | "git.exe";
  windows: boolean;
  /**
   * git이 출력한 절대 경로를 호출자가 쓰는 POSIX 경로로 바꾼다. Windows git은 `D:/repo/.git`처럼 쓰므로
   * `/mnt/d/repo/.git`로 돌려놓아야 Linux 쪽 경로와 같은 기준으로 비교된다. Linux git이면 그대로다.
   */
  toPosix(value: string): string;
}

/** WSL이고 `/mnt/<드라이브>` 아래(드라이브 루트 포함) 경로인가. */
export function isWindowsDrivePath(cwd: string): boolean {
  return process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME) && /^\/mnt\/[a-z](?:\/|$)/i.test(cwd);
}

/** `D:/a/b`·`D:\a\b`를 `/mnt/d/a/b`로 바꾼다. 드라이브 문자로 시작하지 않으면 그대로 돌려준다. */
export function windowsPathToPosix(value: string): string {
  const match = /^([A-Za-z]):[\\/]*(.*)$/.exec(value);
  if (!match) return value;
  const rest = match[2].replace(/\\/g, "/").replace(/\/+$/, "");
  return rest ? `/mnt/${match[1].toLowerCase()}/${rest}` : `/mnt/${match[1].toLowerCase()}`;
}

/**
 * 시작 디렉터리에서 위로 올라가 처음 만나는 `.git`이 `gitdir: /...`(POSIX 경로)를 가리키는 파일이면 true다.
 * 2026-10-09 `.worktrees/dart-cron-order`에서 Windows git이 `fatal: not a git repository`로 끝났다.
 */
export async function hasPosixGitdirWorktreeFrom(startDirectory: string): Promise<boolean> {
  let dir = resolve(startDirectory);
  for (;;) {
    const dotGit = join(dir, ".git");
    const info = await stat(dotGit).catch(() => undefined);
    if (info) return info.isFile() && /^gitdir:\s*\//m.test(await readFile(dotGit, "utf8"));
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** 대상 파일마다 위로 올라가 POSIX gitdir worktree에 속한 파일이 하나라도 있으면 true다. */
export async function hasPosixGitdirWorktree(cwd: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    if (await hasPosixGitdirWorktreeFrom(dirname(resolve(cwd, file)))) return true;
  }
  return false;
}

/**
 * WSL + `/mnt/<드라이브>/` + POSIX gitdir worktree가 아님 → Windows 쪽에서 다룬다. finalizer와 git 실행기가 같은 판정을 쓴다.
 * `files`가 없으면 `cwd` 디렉터리 자체에서 위로 올라가며 보고, 있으면 파일마다 부모 디렉터리에서 올라간다.
 */
export async function usesWindowsDriveRepo(cwd: string, files?: string[]): Promise<boolean> {
  if (!isWindowsDrivePath(cwd)) return false;
  return !(await (files ? hasPosixGitdirWorktree(cwd, files) : hasPosixGitdirWorktreeFrom(cwd)));
}

const LINUX_GIT: GitExecutor = { command: "git", windows: false, toPosix: (value) => value };
const WINDOWS_GIT: GitExecutor = { command: "git.exe", windows: true, toPosix: windowsPathToPosix };

let windowsGitProbe: { path: string; found: boolean } | undefined;

/** interop이 꺼져 PATH에 git.exe가 없으면 Linux git으로 남긴다. PATH가 바뀌면 다시 본다. */
function hasWindowsGit(): boolean {
  const path = process.env.PATH ?? "";
  if (windowsGitProbe?.path !== path) {
    windowsGitProbe = { path, found: path.split(delimiter).some((dir) => dir && existsSync(join(dir, "git.exe"))) };
  }
  return windowsGitProbe.found;
}

/**
 * `directory`(git을 실행할 cwd)에서 쓸 git을 고른다. Windows git은 호출자의 cwd 옵션으로 실행한다.
 * WSL interop이 `/mnt/<드라이브>` cwd를 Windows 경로로 넘기므로 경로 인자를 따로 바꿀 필요가 없다.
 */
export async function selectGitExecutor(directory: string): Promise<GitExecutor> {
  if (!hasWindowsGit()) return LINUX_GIT;
  // `.git` 파일을 읽지 못하는 등 판정을 못 하면 어느 git이든 열 수 있는 Linux git으로 남긴다.
  return (await usesWindowsDriveRepo(directory).catch(() => false)) ? WINDOWS_GIT : LINUX_GIT;
}
