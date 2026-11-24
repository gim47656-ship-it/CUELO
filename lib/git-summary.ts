import { execFile } from "child_process";
import { promisify } from "util";
import { selectGitExecutor, type GitExecutor } from "./wsl-git";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const RECENT_COMMIT_LIMIT = 5;

export interface GitSummaryCommit {
  hash: string;
  shortHash: string;
  subject: string;
  /** ISO 8601 committer date. */
  committedAt: string;
}

export interface GitSummaryResponse {
  isGitRepository: boolean;
  repositoryRoot: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  commits: GitSummaryCommit[];
}

const NOT_A_REPOSITORY: GitSummaryResponse = {
  isGitRepository: false,
  repositoryRoot: null,
  branch: null,
  detached: false,
  upstream: null,
  ahead: null,
  behind: null,
  commits: [],
};

async function git(executor: GitExecutor, cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(executor.command, args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

/** git이 정상 종료하며 0이 아닌 상태를 낸 경우(종료 코드가 숫자). 시간 초과는 killed, 실행 실패는 문자열 코드다. */
function isGitExitStatus(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("killed" in error && error.killed === true) return false;
  return "code" in error && typeof error.code === "number";
}

/**
 * 예상된 거절(분리된 HEAD, 추적 브랜치 없음, 커밋 없는 저장소, 저장소 아님)은 값 없음으로 읽는다.
 * 시간 초과나 git 실행 실패는 던져서 호출자가 '읽지 못함'으로 보이게 한다.
 */
async function gitOrNull(executor: GitExecutor, cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(executor, cwd, args);
  } catch (error) {
    if (isGitExitStatus(error)) return null;
    throw error;
  }
}

/** 필드는 NUL로 나눈다. 커밋 메시지에는 NUL이 들어갈 수 없고 %s(제목)에는 줄바꿈이 없다. */
function parseCommits(output: string | null): GitSummaryCommit[] {
  if (!output) return [];
  return output.split("\n").flatMap((line) => {
    const fields = line.split("\0");
    if (fields.length !== 4) return [];
    const [hash, shortHash, committedAt, subject] = fields;
    if (!/^[0-9a-f]{40,64}$/.test(hash) || !hash.startsWith(shortHash) || !shortHash || !committedAt) return [];
    return [{ hash, shortHash, committedAt, subject }];
  });
}

function parseAheadBehind(output: string | null): { ahead: number | null; behind: number | null } {
  const match = output ? /^(\d+)\s+(\d+)\s*$/.exec(output) : null;
  if (!match) return { ahead: null, behind: null };
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

export interface GitSummaryOptions {
  /** 찾은 저장소 root를 보여도 되는지. 허용 범위 밖 상위 저장소의 기록을 내보내지 않게 한다. */
  isRootAllowed?: (repositoryRoot: string) => boolean;
}

/**
 * 새 세션 인스펙터의 저장소 요약: 브랜치, 추적 브랜치와의 앞섬·뒤처짐, 최근 커밋 5개.
 * 앞섬·뒤처짐은 이미 받아 둔 로컬 추적 ref로만 센다. 원격에 묻지 않는다(fetch 없음).
 */
export async function getGitSummary(cwd: string, options: GitSummaryOptions = {}): Promise<GitSummaryResponse> {
  const executor = await selectGitExecutor(cwd);
  const root = await gitOrNull(executor, cwd, ["rev-parse", "--show-toplevel"]);
  // 경로 끝의 공백·CR은 경로의 일부일 수 있으므로 git이 붙인 LF 하나만 뗀다.
  const repositoryRoot = root ? executor.toPosix(root.replace(/\n$/, "")) : "";
  if (!repositoryRoot) return { ...NOT_A_REPOSITORY, commits: [] };
  if (options.isRootAllowed && !options.isRootAllowed(repositoryRoot)) return { ...NOT_A_REPOSITORY, commits: [] };

  const [branchOutput, upstreamOutput, countsOutput, logOutput] = await Promise.all([
    gitOrNull(executor, cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    gitOrNull(executor, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
    gitOrNull(executor, cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
    gitOrNull(executor, cwd, [
      "log",
      `--max-count=${RECENT_COMMIT_LIMIT}`,
      "--no-show-signature",
      "--format=%H%x00%h%x00%cI%x00%s",
    ]),
  ]);

  const branch = branchOutput?.trim() || null;
  const upstream = upstreamOutput?.trim() || null;
  const { ahead, behind } = upstream ? parseAheadBehind(countsOutput) : { ahead: null, behind: null };

  return {
    isGitRepository: true,
    repositoryRoot,
    branch,
    detached: branch === null,
    upstream,
    ahead,
    behind,
    commits: parseCommits(logOutput),
  };
}
