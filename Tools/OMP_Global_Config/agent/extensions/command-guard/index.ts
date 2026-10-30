import { execFile } from "node:child_process";
import { appendFileSync, existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import {
  characterTarget,
  confirmCharacterIntent,
  malformedSummonMarkerReason,
  parseCharacterSummonMarker,
  parseCharacterIntent,
  parseCharacterSummonDirectives,
  rewriteTaskInputForCharacterSummon,
  type CharacterAlias,
} from "../character-voice";
import { resolvePreparedTaskInput } from "../lib/prepared-task";
import { onSessionLifecycle } from "../lib/session-identity";
import { selectGitExecutor, type GitExecutor } from "../../tools/git-finalizer/wsl-git";
import { defaultExec as egoBrowserExec } from "../../tools/ego-browser/index";

import { isNotRepositoryDiagnostic, matchBlockedCommand } from "./matcher";
import { interopHint, windowsOutputCommand } from "./interop-hint";
import { matchPowerShellSyntax } from "./powershell-syntax";
import {
  bindSpawnAliases,
  bindTaskGuardSession,
  bindWriterOwners,
  claimSharedWriters,
  createEgoLiteProbe,
  createOwnershipState,
  createTaskGuardState,
  createWriterClaimState,
  decideOwnerWrite,
  dropOwnedChildren,
  hasUnreportedChildren,
  matchBlockedEvalModelBridge,
  matchRelayBrowserOpen,
  noteUserRedirect,
  noteUserRequestText,
  readCancelledChildIds,
  readSettledTaskIds,
  readSpawnProgress,
  registerSpawnedMakers,
  releaseCancelledSpawns,
  noteOwnershipWrites,
  OWNERSHIP_MAIN_WRITER,
  reportOwnedChildren,
  reserveTaskCall,
  reservedMakers,
  resetOwnershipState,
  resetTaskGuardState,
  resetWriterClaimState,
  settleSharedWriters,
  settleTaskCall,
  stripScopePrefix,
  unbindTaskGuardSession,
  unbindWriterOwners,
  writerOwnersOf,
  type EvalCallInput,
  type MakerSpawn,
  type OwnershipOutsideRow,
  type OwnershipState,
  type RunningTaskJob,
  type TaskCallInput,
  type TaskCallOutcome,
  type TaskJobRow,
  type TreeSnapshot,
  type WriterOwnerView,
} from "./task-guard";

/** WSL에서 Windows 실행 파일을 부를 수 있는지(binfmt interop 등록). Windows 출력 변환을 이때만 붙인다. */
const WSL_INTEROP = process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");

/** ego lite 설치 여부(프로세스당 한 번). `browser.open`이 든 eval 셀에서만 묻는다. */
const egoLiteAvailable = createEgoLiteProbe(egoBrowserExec);

/** eval이 자동으로 고르는 관리 Python 환경(코어 `getPythonEnvDir()` 기본값). WSL(Linux)에만 안내한다. */
function managedPythonPath(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const python = join(homedir(), ".omp", "python-env", "bin", "python");
  return existsSync(python) ? python : undefined;
}

function normalizeRepositoryPath(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
}

/** git status/hash-object가 주는 상대경로를 소유 판정과 같은 기준으로 정규화한다. */
function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** 이벤트 컨텍스트의 세션 cwd. CUELO처럼 process.cwd()가 세션 cwd가 아닐 수 있어 우선한다. */
function eventSessionCwd(ctx: { cwd?: string } | undefined): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? resolve(ctx.cwd) : process.cwd();
}

/**
 * 세션이 소유한 task job(running+recent)을 읽는다. 조회 API가 없거나 실패하면 undefined로 두어 등록 여부를
 * 모르는 것으로 다룬다. 빈 registry로 간주하면 실제로 등록된 child의 예약을 해제할 수 있다.
 */
function readTaskJobRegistry(ctx: unknown): TaskJobRow[] | undefined {
  if (!ctx || typeof ctx !== "object" || !("getAsyncJobSnapshot" in ctx)) return undefined;
  const read = ctx.getAsyncJobSnapshot;
  if (typeof read !== "function") return undefined;
  let snapshot: unknown;
  try {
    snapshot = read.call(ctx, { recentLimit: Number.MAX_SAFE_INTEGER });
  } catch {
    return undefined;
  }
  if (!snapshot || typeof snapshot !== "object" || !("running" in snapshot) || !("recent" in snapshot)) {
    return undefined;
  }
  if (!Array.isArray(snapshot.running) || !Array.isArray(snapshot.recent)) return undefined;
  const rows: TaskJobRow[] = [];
  for (const job of [...snapshot.running, ...snapshot.recent]) {
    if (!job || typeof job !== "object" || !("type" in job) || job.type !== "task") continue;
    if (!("id" in job) || typeof job.id !== "string") continue;
    if (!("startTime" in job) || typeof job.startTime !== "number") continue;
    const agentId = "agentId" in job && typeof job.agentId === "string" ? job.agentId : undefined;
    rows.push({ id: job.id, startTime: job.startTime, ...(agentId ? { agentId } : {}) });
  }
  return rows;
}

/**
 * 세션이 소유한 실행 중 task job만 읽는다. core snapshot은 소유 세션 기준이라 child가 아니라 부모 ctx로 읽어야 한다.
 * 조회 API가 없거나 실패하면 undefined(소유자 미상)이며, 빈 목록으로 대신하지 않는다.
 */
function readRunningTaskJobs(ctx: unknown): RunningTaskJob[] | undefined {
  if (!ctx || typeof ctx !== "object" || !("getAsyncJobSnapshot" in ctx)) return undefined;
  const read = ctx.getAsyncJobSnapshot;
  if (typeof read !== "function") return undefined;
  let snapshot: unknown;
  try {
    snapshot = read.call(ctx, { recentLimit: 0 });
  } catch {
    return undefined;
  }
  if (!snapshot || typeof snapshot !== "object" || !("running" in snapshot) || !Array.isArray(snapshot.running)) {
    return undefined;
  }
  const jobs: RunningTaskJob[] = [];
  for (const job of snapshot.running) {
    if (!job || typeof job !== "object" || !("type" in job) || job.type !== "task") continue;
    if (!("id" in job) || typeof job.id !== "string" || !job.id) continue;
    const agentId = "agentId" in job && typeof job.agentId === "string" && job.agentId ? job.agentId : undefined;
    jobs.push({ id: job.id, ...(agentId ? { agentId } : {}) });
  }
  return jobs;
}

/** edit·write 대상. core가 edit 이벤트 입력에 hashline 헤더를 풀어 `path`(한 파일)·`paths`(여러 파일)로 넣는다. */
function writeTargets(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const raw: unknown[] = [...(Array.isArray(record.paths) ? record.paths : []), record.path];
  return [...new Set(raw.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : [])))];
}

/**
 * OwnershipGuard의 `outside=none`이 아닌 완료 보고를 한 줄씩 덧붙이는 기록. 실행 프로필의 agent 루트
 * (routing-ledger.jsonl·steering-gate-miss.jsonl과 같은 자리)에 둔다. 원장 레코드 종류는 늘리지 않는다.
 */
export const OWNERSHIP_OUTSIDE_LOG_PATH = join(import.meta.dir, "..", "..", "ownership-outside.jsonl");

export interface CommandGuardDeps {
  /** 범위 밖 변경 기록 파일. 테스트만 바꾼다. 기본은 OWNERSHIP_OUTSIDE_LOG_PATH다. */
  ownershipOutsideLog?: string;
}

/**
 * bash 도구의 `cwd` 인자를 코어 bash와 같은 규칙으로 푼다. WSL에서 `E:/x`·`E:\x`는 코어가
 * `/mnt/e/x`에서 실행하므로, `path.resolve`로 `<세션 cwd>/E:/x`를 만들면 없는 경로의 저장소를
 * 증명하지 못해 다른 저장소의 git까지 막는다. 첫 판정 전에 명령을 동기적으로 읽어야 하므로 sync다.
 */
function bashToolCwd(sessionCwd: string, inputCwd: string): string {
  try {
    return resolve(resolveToCwd(inputCwd, sessionCwd));
  } catch {
    // 내부 URL 등 코어가 거절한 cwd는 기존 판정으로 넘긴다.
    return resolve(sessionCwd, inputCwd);
  }
}

/**
 * terminal id가 가리키는 현재 미보고 entry key를 await 전에 고정한다. 같은 child 이름을 다시 써도
 * reportOwnedChildren에 exact key를 넘기므로 먼저 끝난 capture가 새 항목을 소비하지 않는다.
 */
function exactUnreportedOwnedChildKeys(
  state: OwnershipState,
  ids: readonly string[],
): string[] {
  const keys: string[] = [];
  const selected = new Set<string>();
  for (const id of ids) {
    let foundKey: string | undefined;
    let foundOrder = Number.POSITIVE_INFINITY;
    for (const [key, entry] of state.entries) {
      if (entry.reported || (key !== id && !entry.aliases.includes(id))) continue;
      if (entry.startOrder >= foundOrder) continue;
      foundKey = key;
      foundOrder = entry.startOrder;
    }
    if (!foundKey || selected.has(foundKey)) continue;
    selected.add(foundKey);
    keys.push(foundKey);
  }
  return keys;
}

/** await 전후의 maker 예약이 같은지 확인해 재사용된 toolCallId나 rollback된 예약을 구분한다. */
function sameMakerReservation(
  expected: readonly MakerSpawn[],
  actual: MakerSpawn[] | undefined,
): actual is MakerSpawn[] {
  if (!actual || actual.length !== expected.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (
      !left ||
      !right ||
      left.name !== right.name ||
      left.index !== right.index ||
      left.isolated !== right.isolated ||
      left.ownedPaths.length !== right.ownedPaths.length
    ) {
      return false;
    }
    for (let pathIndex = 0; pathIndex < left.ownedPaths.length; pathIndex += 1) {
      if (left.ownedPaths[pathIndex] !== right.ownedPaths[pathIndex]) return false;
    }
  }
  return true;
}

async function gitCommonDirectory(directory: string): Promise<string | undefined> {
  try {
    const git = await selectGitExecutor(directory);
    const output = await runGit(
      git,
      directory,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    const commonDirectory = output?.trim();
    // Windows git은 `D:/repo/.git`을 돌려준다. Linux git 쪽 `/mnt/d/repo/.git`과 같은 키가 되게 되돌린다.
    return commonDirectory ? normalizeRepositoryPath(git.toPosix(commonDirectory)) : undefined;
  } catch {
    return undefined;
  }
}

// common-dir 조회 promise는 디렉터리별로 공유한다. CUELO처럼 한 프로세스가 여러 세션을 띄우면
// process.cwd()는 세션 cwd가 아니므로, 세션 저장소는 이벤트마다 ctx.cwd로 판정한다.
// 실패는 현재 판정에서 보수적으로 차단하되 영구 negative cache로 남기지 않는다.
const commonDirectoryCache = new Map<string, Promise<string | undefined>>();

function cachedCommonDirectory(directory: string): Promise<string | undefined> {
  const cacheKey = normalizeRepositoryPath(directory);
  const cached = commonDirectoryCache.get(cacheKey);
  if (cached) return cached;
  const pending = gitCommonDirectory(directory);
  commonDirectoryCache.set(cacheKey, pending);
  void pending.then((commonDirectory) => {
    if (commonDirectory === undefined && commonDirectoryCache.get(cacheKey) === pending) {
      commonDirectoryCache.delete(cacheKey);
    }
  });
  return pending;
}

/**
 * 대상 디렉터리가 세션 저장소인지 가르는 판정과, 그 판정이 증명하지 못해 차단으로 기운 대상(세션이나 대상의 common-dir을
 * 얻지 못함). 후자만 outsideRepositoryMatcher가 "어느 저장소에도 속하지 않음"을 따로 확인한다.
 */
async function repositoryMatcher(
  sessionCwd: string,
  targetDirectories: readonly string[],
): Promise<{ isSessionRepository: (directory: string) => boolean; unproven: string[] }> {
  const targets = new Map<string, string>();
  for (const directory of targetDirectories) {
    const normalized = normalizeRepositoryPath(directory);
    if (!targets.has(normalized)) targets.set(normalized, directory);
  }
  const sessionPending = cachedCommonDirectory(sessionCwd);
  const targetEntries = [...targets.entries()];
  const targetPending = targetEntries.map(([, directory]) => cachedCommonDirectory(directory));
  const [sessionCommonDirectory, targetCommonDirectories] = await Promise.all([
    sessionPending,
    Promise.all(targetPending),
  ]);
  const resolvedTargets = new Map(
    targetEntries.map(([normalized], index) => [normalized, targetCommonDirectories[index]]),
  );
  const unproven = targetEntries.flatMap(([, directory], index) =>
    !sessionCommonDirectory || !targetCommonDirectories[index] ? [directory] : [],
  );
  const isSessionRepository = (directory: string): boolean => {
    if (!directory) return true;
    const normalized = normalizeRepositoryPath(directory);
    // 1차 target 수집 뒤 입력이 달라져 미리 확인하지 않은 directory가 나타나도 허용하지 않는다.
    if (!resolvedTargets.has(normalized)) return true;
    const commonDirectory = resolvedTargets.get(normalized);
    // 세션 또는 대상의 common-dir을 증명할 수 없으면 같은 저장소로 보고 차단한다.
    return (
      !sessionCommonDirectory ||
      !commonDirectory ||
      commonDirectory === sessionCommonDirectory
    );
  };
  return { isSessionRepository, unproven };
}

/**
 * Linux git 호출 대상 디렉터리마다 하네스가 Windows `git.exe`로 다룰 저장소인지 미리 판정한다. 판정은
 * git_finalize·앱·소유권 스냅샷과 같은 `selectGitExecutor`다. 1차 수집에 없던 디렉터리는 막지 않는다.
 */
async function windowsGitMatcher(targetDirectories: readonly string[]): Promise<(directory: string) => boolean> {
  const verdicts = new Map<string, boolean>();
  await Promise.all(
    [...new Set(targetDirectories)].map(async (directory) => {
      verdicts.set(directory, (await selectGitExecutor(directory)).windows);
    }),
  );
  return (directory) => verdicts.get(directory) === true;
}

/** 아직 없을 수 있는 경로의 가장 가까운 기존 조상 폴더(자기 자신 포함). 없으면 undefined. */
function nearestExistingDirectory(path: string): string | undefined {
  let current = resolve(path);
  for (;;) {
    try {
      if (statSync(current).isDirectory()) return current;
    } catch {
      // 없는 경로는 조상으로 올라간다.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * 대상 디렉터리(아직 없을 수 있다)가 git이 찾는 어느 저장소에도 속하지 않는지. 가장 가까운 기존 조상에서 git 자신의 저장소
 * 탐색을 돌려 "not a git repository"로 끝날 때만 참이다. git 실행 실패·시간 초과·다른 오류는 증명이 아니므로 거짓(차단)이다.
 * 같은 탐색을 실제 명령의 git도 하므로, 참이면 그 위치의 git add·commit은 세션 저장소에 닿지 못한다.
 */
async function outsideRepositoryMatcher(targetDirectories: readonly string[]): Promise<(directory: string) => boolean> {
  const verdicts = new Map<string, boolean>();
  await Promise.all(
    [...new Set(targetDirectories)].map(async (directory) => {
      const ancestor = nearestExistingDirectory(directory);
      if (!ancestor) return;
      const git = await selectGitExecutor(ancestor);
      const { promise, resolve: settle } = Promise.withResolvers<boolean>();
      execFile(
        git.command,
        ["rev-parse", "--git-dir"],
        {
          cwd: ancestor,
          encoding: "utf8",
          windowsHide: true,
          timeout: GIT_SPAWN_TIMEOUT_MS,
          env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" },
        },
        (error, _stdout, stderr) => settle(Boolean(error) && isNotRepositoryDiagnostic(String(stderr))),
      );
      verdicts.set(directory, await promise);
    }),
  );
  return (directory) => verdicts.get(directory) === true;
}

/**
 * 대상 디렉터리(아직 없을 수 있다)의 실제 경로가 임시 루트(os.tmpdir()·/tmp) 아래이고 세션 cwd·세션 작업 트리와 겹치지 않는지.
 * 기존 조상의 realpath로 보므로 /tmp 아래 심볼릭 링크가 세션 저장소를 가리키면 임시로 보지 않는다. 세션 cwd가 저장소의
 * 하위 폴더일 때 같은 작업 트리의 다른 폴더를 임시로 보지 않도록 작업 트리 root(`sessionRoot`)도 함께 지킨다. root를
 * 알아내지 못했으면(`undefined`) 무엇도 임시로 보지 않는다. `null`은 세션이 어느 저장소에도 속하지 않음이 증명된 경우다.
 */
function temporaryDirectoryMatcher(sessionCwd: string, sessionRoot: string | null | undefined): (directory: string) => boolean {
  if (sessionRoot === undefined) return () => false;
  const real = (path: string): string | undefined => {
    const ancestor = nearestExistingDirectory(path);
    if (!ancestor) return undefined;
    try {
      return join(realpathSync(ancestor), relative(ancestor, resolve(path)));
    } catch {
      return undefined;
    }
  };
  const roots = [...new Set([tmpdir(), "/tmp"].flatMap((root) => (existsSync(root) ? [real(root)] : [])))].filter(
    (root): root is string => root !== undefined,
  );
  const protectedPaths = [sessionCwd, ...(sessionRoot ? [sessionRoot] : [])].map((path) => real(path) ?? resolve(path));
  const within = (path: string, base: string) => path === base || path.startsWith(`${base}${sep}`);
  return (directory) => {
    const path = real(directory);
    if (!path || protectedPaths.some((session) => within(path, session) || within(session, path))) return false;
    return roots.some((root) => path.startsWith(`${root}${sep}`));
  };
}

/**
 * 세션 cwd가 속한 작업 트리의 root. git이 "not a git repository"로 끝나면 `null`(지킬 작업 트리 없음), 그 밖의 실패·
 * 시간 초과·work tree 아님은 `undefined`(알 수 없음: 임시 면제를 쓰지 않는다)다.
 */
async function sessionWorktreeRoot(sessionCwd: string): Promise<string | null | undefined> {
  const git = await selectGitExecutor(sessionCwd);
  const { promise, resolve: settle } = Promise.withResolvers<string | null | undefined>();
  execFile(
    git.command,
    ["rev-parse", "--show-toplevel"],
    {
      cwd: sessionCwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_SPAWN_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: "C", LANG: "C", LANGUAGE: "C" },
    },
    (error, stdout, stderr) => {
      if (error) return settle(isNotRepositoryDiagnostic(String(stderr)) ? null : undefined);
      const root = String(stdout).trim();
      settle(root && isAbsolute(root) ? root : undefined);
    },
  );
  return promise;
}

/**
 * git 호출 하나의 상한. 각 child callback을 기다리는 extension handler의 상한은 기본 30초이므로
 * 세 순차 호출의 최악값을 그 아래로 둔다. 비동기 child를 써 대기 중 JS event loop는 계속 돈다.
 */
const GIT_SPAWN_TIMEOUT_MS = 5000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function runGit(git: GitExecutor, directory: string, args: string[], input?: string): Promise<string | undefined> {
  const { promise, resolve: resolveOutput } = Promise.withResolvers<string | undefined>();
  const child = execFile(
    // /mnt/<드라이브> 저장소는 Windows git이 훨씬 빠르다(9p stat). 판정은 git_finalize·앱과 같다.
    git.command,
    args,
    {
      cwd: directory,
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_SPAWN_TIMEOUT_MS,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
    },
    (error, stdout) => {
      resolveOutput(error || typeof stdout !== "string" ? undefined : stdout);
    },
  );
  // hash-object만 stdin을 읽는다. 조기 종료(EPIPE)는 callback error와 같은 unobserved 경계다.
  child.stdin?.on("error", () => {});
  if (input === undefined) child.stdin?.end();
  else child.stdin?.end(input);
  return promise;
}

/**
 * 세션 cwd의 working tree 스냅샷: 정규화된 cwd 기준 상대경로 → 내용 지문(삭제·부재는 undefined).
 *
 * `git status --porcelain`의 경로는 cwd가 아니라 저장소 root 기준이다(세션 cwd가 저장소
 * 하위 디렉터리일 때가 이 워크스페이스의 기본형이다). 그래서 `rev-parse --show-prefix`로
 * cwd→root 접두사를 얻어 pathspec `-- .`로 session cwd 전체를 스캔하고, 돌려받은 경로에서
 * 접두사를 떼어 스냅샷 키를 cwd 기준으로 맞춘다. `hash-object --stdin-paths`는 반대로 stdin
 * 경로를 저장소 root 기준으로 여므로(실측) 해싱 입력에는 접두사가 붙은 원래 경로를 쓴다.
 *
 * 경로 목록만으로는 부족하다: spawn 전부터 dirty였던 파일은 그대로 dirty이므로 내용 지문이
 * 바뀌었는지까지 봐야 한다. git을 쓸 수 없거나 어느 한 호출이라도 실패·타임아웃·출력 상한에
 * 걸리면 undefined를 돌려 호출부가 추정 대신 `outside=unobserved`로 남기게 한다.
 */
async function takeTreeSnapshot(directory: string): Promise<TreeSnapshot | undefined> {
  try {
    const git = await selectGitExecutor(directory);
    const prefixOutput = await runGit(git, directory, ["rev-parse", "--show-prefix"]);
    if (prefixOutput === undefined) return undefined;
    const scope = prefixOutput.trim().replace(/\\/g, "/");

    const statusOutput = await runGit(
      git,
      directory,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
    );
    if (statusOutput === undefined) return undefined;

    const entries: Array<{ path: string; relative: string; deleted: boolean }> = [];
    const tokens = statusOutput.split("\0");
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token.length < 4) continue;
      const code = token.slice(0, 2);
      const path = token.slice(3);
      if (!path) continue;
      // -z 형식에서 rename/copy 항목은 다음 토큰이 원본 경로다.
      if (code.includes("R") || code.includes("C")) index += 1;
      // scope 접두사는 stripScopePrefix가 소유 판정과 같은 대소문자 무시 기준으로 비교한다.
      // `-- .`로 좁힌 결과인데도 접두사가 안 맞으면 관측을 신뢰할 수 없으므로 항목을 버리지
      // 않고 undefined(unobserved)로 만들어, 빈 스냅샷이 outside=none으로 보이는 것을 막는다.
      const relative = stripScopePrefix(path, scope);
      if (relative === undefined) return undefined;
      if (!relative) continue;
      entries.push({ path, relative, deleted: code.includes("D") });
    }

    const fingerprint = new Map<string, string | undefined>();
    const hashedPaths = entries.filter((entry) => !entry.deleted).map((entry) => entry.path);
    if (hashedPaths.length > 0) {
      const hashOutput = await runGit(
        git,
        directory,
        ["hash-object", "--stdin-paths", "--no-filters"],
        hashedPaths.join("\n") + "\n",
      );
      if (hashOutput === undefined) return undefined;
      const hashLines = hashOutput.split("\n");
      if (hashLines.length < hashedPaths.length) return undefined;
      hashedPaths.forEach((path, position) => fingerprint.set(path, hashLines[position]));
    }
    // 삭제된 경로는 지문이 없다. 다시 나타나면 해시와 비교돼 변경으로 잡힌다.
    for (const entry of entries) {
      if (entry.deleted) fingerprint.set(entry.path, undefined);
    }
    const snapshot = new Map<string, string | undefined>();
    for (const entry of entries) {
      snapshot.set(normalizeRelativePath(entry.relative), fingerprint.get(entry.path));
    }
    return snapshot;
  } catch {
    return undefined;
  }
}

type EvalLanguage = "js" | "py";

type ParsedCall = {
  args: string[];
  end: number;
};

/** 주석과 공백을 건너뛴 다음 코드 위치를 돌려준다. */
function nextCodeIndex(code: string, start: number, language: EvalLanguage): number {
  let index = start;
  for (;;) {
    while (index < code.length && /\s/.test(code[index]!)) index += 1;
    if (language === "js" && code.startsWith("//", index)) {
      const newline = code.indexOf("\n", index + 2);
      index = newline < 0 ? code.length : newline + 1;
      continue;
    }
    if (language === "js" && code.startsWith("/*", index)) {
      const close = code.indexOf("*/", index + 2);
      return close < 0 ? code.length : nextCodeIndex(code, close + 2, language);
    }
    if (language === "py" && code[index] === "#") {
      const newline = code.indexOf("\n", index + 1);
      index = newline < 0 ? code.length : newline + 1;
      continue;
    }
    return index;
  }
}

/** 문자열 리터럴 하나를 닫는 따옴표 뒤까지 건너뛴다. 닫히지 않으면 코드 끝을 돌려준다. */
function skipStringLiteral(code: string, start: number, language: EvalLanguage): number {
  const quote = code[start]!;
  const triple = language === "py" && code.slice(start, start + 3) === quote.repeat(3);
  const delimiter = triple ? quote.repeat(3) : quote;
  let index = start + delimiter.length;
  while (index < code.length) {
    if (code[index] === "\\") {
      index += 2;
      continue;
    }
    if (code.startsWith(delimiter, index)) return index + delimiter.length;
    index += 1;
  }
  return code.length;
}

/** JS 정규식 리터럴을 건너뛴다. 호출처럼 보이는 정규식 본문을 코드로 오인하지 않게 한다. */
function skipRegexLiteral(code: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < code.length) {
    const char = code[index]!;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < code.length && /[A-Za-z]/.test(code[index]!)) index += 1;
      return index;
    }
    index += 1;
  }
  return code.length;
}

function isRegexStart(previousLexeme: string | undefined): boolean {
  return (
    previousLexeme === undefined ||
    /^(?:[=(:,!&|?+*%^~<>{}\[\];-]|return|case|throw|else|do|typeof|instanceof|in|of|yield|await)$/.test(
      previousLexeme,
    )
  );
}

/**
 * 괄호·중괄호·대괄호 내부를 최상위 쉼표로 나눈다. 문자열과 주석은 구문으로 세지 않는다.
 * 닫는 기호가 어긋나거나 없으면 undefined로 fail closed한다.
 */
function readDelimitedParts(
  code: string,
  openIndex: number,
  language: EvalLanguage,
): ParsedCall | undefined {
  const closeFor: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const first = code[openIndex]!;
  const firstClose = closeFor[first];
  if (!firstClose) return undefined;
  const stack = [firstClose];
  const args: string[] = [];
  let partStart = openIndex + 1;
  let index = partStart;
  let previousLexeme: string | undefined = first;
  while (index < code.length) {
    const char = code[index]!;
    if (char === "'" || char === '"' || (language === "js" && char === "`")) {
      index = skipStringLiteral(code, index, language);
      previousLexeme = "string";
      continue;
    }
    if (language === "js" && code.startsWith("//", index)) {
      const newline = code.indexOf("\n", index + 2);
      index = newline < 0 ? code.length : newline + 1;
      continue;
    }
    if (language === "js" && code.startsWith("/*", index)) {
      const close = code.indexOf("*/", index + 2);
      if (close < 0) return undefined;
      index = close + 2;
      continue;
    }
    if (language === "py" && char === "#") {
      const newline = code.indexOf("\n", index + 1);
      index = newline < 0 ? code.length : newline + 1;
      continue;
    }
    if (language === "js" && char === "/" && code[index + 1] !== "/" && code[index + 1] !== "*" && isRegexStart(previousLexeme)) {
      index = skipRegexLiteral(code, index);
      previousLexeme = "regex";
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(code.slice(index));
      if (!match) return undefined;
      previousLexeme = match[0];
      index += match[0].length;
      continue;
    }
    if (char in closeFor) {
      stack.push(closeFor[char]!);
      previousLexeme = char;
      index += 1;
      continue;
    }
    if (char === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) {
        const last = code.slice(partStart, index).trim();
        if (last || args.length > 0) args.push(last);
        return { args, end: index + 1 };
      }
      previousLexeme = char;
      index += 1;
      continue;
    }
    if (char === ")" || char === "}" || char === "]") return undefined;
    if (char === "," && stack.length === 1) {
      args.push(code.slice(partStart, index).trim());
      partStart = index + 1;
    }
    if (!/\s/.test(char)) previousLexeme = char;
    index += 1;
  }
  return undefined;
}

/** 최상위 키-값 구분자를 한 번만 허용해 좌우를 나눈다. */
function splitTopLevel(
  source: string,
  delimiter: ":" | "=",
  language: EvalLanguage,
): [string, string] | undefined {
  const wrapped = readDelimitedParts(`(${source})`, 0, language);
  if (!wrapped || wrapped.args.length !== 1) return undefined;
  let index = 0;
  const stack: string[] = [];
  const closeFor: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "'" || char === '"' || (language === "js" && char === "`")) {
      index = skipStringLiteral(source, index, language);
      continue;
    }
    if (char in closeFor) stack.push(closeFor[char]!);
    else if (char === stack.at(-1)) stack.pop();
    else if (char === delimiter && stack.length === 0) {
      if (source[index + 1] === delimiter) {
        index += 2;
        continue;
      }
      return [source.slice(0, index).trim(), source.slice(index + 1).trim()];
    }
    index += 1;
  }
  return undefined;
}

function isExactStringLiteral(source: string, target: string): boolean {
  const match = /^(['"])([^\\\r\n]*)\1$/.exec(source.trim());
  return match?.[2] === target;
}

function jsCallUsesExactModel(args: string[], target: string): boolean {
  if (args.length < 2) return false;
  const options = args[1]!.trim();
  if (isExactStringLiteral(options, target)) return true;
  if (!options.startsWith("{")) return false;
  const parsed = readDelimitedParts(options, 0, "js");
  if (!parsed || nextCodeIndex(options, parsed.end, "js") !== options.length) return false;
  let modelCount = 0;
  for (const property of parsed.args) {
    if (!property || property.startsWith("...")) return false;
    const pair = splitTopLevel(property, ":", "js");
    if (!pair || !/^[A-Za-z_$][\w$]*$/.test(pair[0])) return false;
    if (pair[0] !== "model") continue;
    modelCount += 1;
    if (!isExactStringLiteral(pair[1], target)) return false;
  }
  return modelCount === 1;
}

function pythonCallUsesExactModel(args: string[], target: string): boolean {
  let modelCount = 0;
  for (const argument of args.slice(1)) {
    if (argument.trimStart().startsWith("**")) return false;
    const pair = splitTopLevel(argument, "=", "py");
    if (!pair || pair[0] !== "model") continue;
    modelCount += 1;
    if (!isExactStringLiteral(pair[1], target)) return false;
  }
  return modelCount === 1;
}

/**
 * 실제 bare completion(...) 호출만 모아 모든 호출의 model 인자가 exact target 리터럴인지 본다.
 * 문자열·주석의 marker, 별도 변수, 객체 spread, computed/duplicate model은 실행값을 정적으로
 * 보장할 수 없으므로 허용 근거로 쓰지 않는다.
 */
function hasOnlyExactCompletionCalls(input: EvalCallInput, target: string): boolean {
  if (typeof input.code !== "string") return false;
  const language: EvalLanguage | undefined =
    input.language === "js" || input.language === "javascript"
      ? "js"
      : input.language === "py" || input.language === "python"
        ? "py"
        : undefined;
  if (!language) return false;

  const code = input.code;
  const exactCalls: boolean[] = [];
  let index = 0;
  let previousLexeme: string | undefined;
  while (index < code.length) {
    const char = code[index]!;
    if (char === "'" || char === '"' || (language === "js" && char === "`")) {
      index = skipStringLiteral(code, index, language);
      previousLexeme = "string";
      continue;
    }
    if (language === "js" && code.startsWith("//", index)) {
      const newline = code.indexOf("\n", index + 2);
      index = newline < 0 ? code.length : newline + 1;
      continue;
    }
    if (language === "js" && code.startsWith("/*", index)) {
      const close = code.indexOf("*/", index + 2);
      if (close < 0) return false;
      index = close + 2;
      continue;
    }
    if (language === "py" && char === "#") {
      const newline = code.indexOf("\n", index + 1);
      index = newline < 0 ? code.length : newline + 1;
      continue;
    }
    if (language === "js" && char === "/" && code[index + 1] !== "/" && code[index + 1] !== "*" && isRegexStart(previousLexeme)) {
      index = skipRegexLiteral(code, index);
      previousLexeme = "regex";
      continue;
    }
    if (!/[A-Za-z_$]/.test(char)) {
      if (!/\s/.test(char)) previousLexeme = char;
      index += 1;
      continue;
    }
    const match = /^[A-Za-z_$][\w$]*/.exec(code.slice(index));
    if (!match) return false;
    const identifier = match[0];
    const identifierEnd = index + identifier.length;
    if (identifier !== "completion") {
      previousLexeme = identifier;
      index = identifierEnd;
      continue;
    }
    const open = nextCodeIndex(code, identifierEnd, language);
    if (code[open] !== "(" || previousLexeme === "." || previousLexeme === "function" || previousLexeme === "def") {
      return false;
    }
    const call = readDelimitedParts(code, open, language);
    if (!call) return false;
    const after = nextCodeIndex(code, call.end, language);
    if (language === "js" && code[after] === "{") return false;
    exactCalls.push(
      language === "js"
        ? jsCallUsesExactModel(call.args, target)
        : pythonCallUsesExactModel(call.args, target),
    );
    previousLexeme = ")";
    index = call.end;
  }
  return exactCalls.length === 1 && exactCalls[0] === true;
}

/**
 * genuine 입력과 사람의 steering은 캐릭터 summon의 첫 관련 행동을 고정한다:
 * tool-capable 캐릭터는 각각 exact marker를 단 task child, SHION은 WEB6 eval이고 task는 금지한다.
 *
 * 그 뒤 기존 task budget/ownership, eval bridge, bash guard를 같은 순서로 적용한다.
 * 이 index.ts만 자동 로드되며 matcher/guard 오류는 잡지 않아 OMP 코어의 fail-closed 동작을 보존한다.
 */
function commandGuardWith(pi: ExtensionAPI, deps: CommandGuardDeps): void {
  const taskGuard = createTaskGuardState();
  const ownership = createOwnershipState();
  const summonCalls = new Map<string, CharacterAlias[]>();
  let pendingSummons: CharacterAlias[] = [];
  let ownershipGeneration = 0;
  // 사용자 문장의 호출 의도는 정규식 후보를 JEV로 확인한다(character-voice confirmCharacterIntent; 같은 문장은 한 번만 판정).
  // 확인 전과 판정 실패 때는 정규식 결과 그대로다. steering의 message_start는 core가 기다리지 않으므로
  // (pi-agent-core agent.ts `#emit`이 listener promise를 기다리지 않는다) tool_call이 판정을 먼저 기다린 뒤 pendingSummons를 읽는다.
  // 판정은 confirmCharacterIntent의 제한 시간(1.5초) 안에 끝난다.
  let summonGeneration = 0;
  let summonDecision: Promise<void> | undefined;
  const decideSummons = (text: string, ctx: ExtensionContext, regexAliases: CharacterAlias[]): Promise<void> => {
    const generation = ++summonGeneration;
    pendingSummons = regexAliases;
    if (regexAliases.length === 0) {
      summonDecision = undefined;
      return Promise.resolve();
    }
    const decision = confirmCharacterIntent(text, ctx).then(
      (confirmed) => {
        if (generation === summonGeneration && confirmed?.kind !== "summon") pendingSummons = [];
      },
      () => undefined,
    );
    summonDecision = decision;
    return decision;
  };
  const ownershipOutsideLog = deps.ownershipOutsideLog ?? OWNERSHIP_OUTSIDE_LOG_PATH;

  // OwnerWriteGuard: 이 세션이 띄운 공유 작업공간 Maker의 쓰기 소유. child 세션은 자기 parentId로 이 view를 찾는다.
  // 실행 중 job은 소유 세션 기준 snapshot에만 보이므로 이 세션이 최근 받은 ctx로 읽는다.
  const writers = createWriterClaimState();
  let ownerCtx: unknown;
  let ownerCwd = "";
  let boundOwnerId = "";
  const writerView: WriterOwnerView = {
    get cwd() {
      return ownerCwd;
    },
    state: writers,
    running: () => readRunningTaskJobs(ownerCtx),
    noteWrite: (writer, paths) => noteOwnershipWrites(ownership, writer, paths),
  };
  const bindWriterView = (ctx: { cwd?: string; agent?: { id?: string } }): void => {
    ownerCtx = ctx;
    ownerCwd = eventSessionCwd(ctx);
    const id = (ctx.agent?.id ?? "").trim();
    if (!id || id === boundOwnerId) return;
    if (boundOwnerId) unbindWriterOwners(boundOwnerId, writerView);
    bindWriterOwners(id, writerView);
    boundOwnerId = id;
  };

  /** 소유 밖 변경·미관측 보고 한 건을 덧붙인다. 진단 기록 실패가 보고 전달을 막지 않는다. */
  const recordOwnershipOutside = (
    row: OwnershipOutsideRow,
    ctx: { sessionManager?: { getSessionId?: () => string } } | undefined,
  ): void => {
    try {
      const sessionId = (ctx?.sessionManager?.getSessionId?.() ?? "").trim();
      appendFileSync(ownershipOutsideLog, `${JSON.stringify({ ts: new Date().toISOString(), sessionId, ...row })}\n`);
    } catch (error) {
      pi.logger?.debug("command-guard: ownership-outside 기록 실패", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** edit·write 대상 중 base 아래 작업 트리 파일을 base 기준 상대경로로. 내부 URL·base 밖 경로는 뺀다. */
  const relativeWriteTargets = (input: unknown, cwd: string, base: string): string[] => {
    const targets: string[] = [];
    for (const path of writeTargets(input)) {
      let absolute: string;
      try {
        absolute = resolveToCwd(path, cwd);
      } catch {
        continue; // agent://·proc:// 같은 내부 URL은 작업 트리 파일이 아니다.
      }
      const rel = relative(base, absolute);
      if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      targets.push(rel);
    }
    return targets;
  };

  /**
   * 공유 작업공간 Maker child의 edit·write가 같은 부모의 다른 활성 Maker 소유 경로를 건드리면 막을 이유를 돌린다.
   * Main·Maker가 아닌 agent·격리 child(부모와 cwd가 다름)는 대상이 아니고, 부모 view나 job snapshot이 없어 소유자를
   * 확정하지 못하면 debug 기록만 남기고 막지 않는다. bash 쓰기는 대상 경로를 믿을 만하게 풀 수 없어 보지 않는다.
   * 막지 않은 쓰기는 부모의 OwnershipGuard 귀속 기록에 남긴다(Main 자신의 쓰기는 이 세션의 기록에 남긴다).
   */
  const ownerWriteBlockReason = (
    toolName: string,
    input: unknown,
    ctx: { cwd?: string; agent?: { kind?: string; id?: string; name?: string; parentId?: string } },
  ): string | undefined => {
    const agent = ctx.agent;
    if (!agent) pi.logger?.debug("command-guard: OwnerWriteGuard 판정 생략(ctx.agent 없음)");
    if (agent?.kind !== "sub") {
      const cwd = eventSessionCwd(ctx);
      noteOwnershipWrites(ownership, OWNERSHIP_MAIN_WRITER, relativeWriteTargets(input, cwd, cwd));
      return undefined;
    }
    if (agent.name !== "maker") return undefined;
    const skip = (why: string, detail?: Record<string, unknown>): undefined => {
      pi.logger?.debug(`command-guard: OwnerWriteGuard 판정 생략(${why})`, { agentId: agent.id, ...detail });
      return undefined;
    };
    const selfId = (agent.id ?? "").trim();
    const parentId = (agent.parentId ?? "").trim();
    if (!selfId || !parentId) return skip("agent id 미상");
    const view = writerOwnersOf(parentId);
    if (!view) return skip("부모 view 없음", { parentId });
    const cwd = eventSessionCwd(ctx);
    if (!view.cwd || normalizeRepositoryPath(cwd) !== normalizeRepositoryPath(view.cwd)) {
      return skip("공유 checkout 아님", { cwd, parentCwd: view.cwd });
    }
    const targets = relativeWriteTargets(input, cwd, view.cwd);
    if (targets.length === 0) return undefined;
    const decision = decideOwnerWrite(view, selfId, targets);
    if (decision?.conflict) {
      const { owner, path } = decision.conflict;
      return (
        `[OwnerWriteGuard] ${path}은(는) 지금 실행 중인 다른 Maker ${owner}의 OWNED_PATHS 안이라 ${toolName}을 막았습니다. ` +
        `직접 고치지 말고 필요한 변경·이유·근거 위치를 write agent://${parentId}로 Main에 보고하세요. ` +
        "자기 OWNED_PATHS 안이나 다른 실행 중 Maker가 소유하지 않은 경로는 그대로 쓸 수 있습니다."
      );
    }
    view.noteWrite?.(selfId, targets);
    if (!decision) return skip("부모 job snapshot 없음", { parentId });
    if (decision.unknown.length > 0) skip("소유 주장 없는 실행 중 child", { unknown: decision.unknown });
    return undefined;
  };

  /**
   * 한 terminal event의 exact child들은 스냅샷 하나를 공유한다. await 중 reset되거나 다른
   * terminal 경계가 먼저 같은 child를 소비했으면 새 상태를 건드리지 않고 남은 exact child만 보고한다.
   */
  const reportPendingOwnedChildren = async (
    ids: readonly string[],
    ctx: { cwd?: string; sessionManager?: { getSessionId?: () => string } } | undefined,
  ): Promise<string[]> => {
    const pendingKeys = exactUnreportedOwnedChildKeys(ownership, ids);
    if (pendingKeys.length === 0) return [];
    const generation = ownershipGeneration;
    const tree = await takeTreeSnapshot(eventSessionCwd(ctx));
    if (generation !== ownershipGeneration) return [];
    const stillPendingKeys = pendingKeys.filter((key) => {
      const entry = ownership.entries.get(key);
      return entry !== undefined && !entry.reported;
    });
    if (stillPendingKeys.length === 0) return [];
    return reportOwnedChildren(ownership, stillPendingKeys, tree, (row) => recordOwnershipOutside(row, ctx));
  };

  // tool-capable child가 실제로 뜨지 못했으면 첫 행동 계약을 다시 요구한다.
  // 반면 SHION은 검증된 exact WEB6 eval을 실제 호출한 것으로 상담 시도가 끝난다.
  // provider/model 오류까지 pending으로 되돌리면 read/todo/진단을 전부 막아 원인 확인도
  // 사용자의 원래 작업 재개도 불가능해진다.
  const restoreRetryableSummons = (claimedAliases: readonly CharacterAlias[]): void => {
    // 모드·roster가 바뀌어 지금 target을 풀 수 없는 alias도 버리지 않는다. 아래 fail-closed 검사가 계속 막는다.
    const retryableAliases = claimedAliases.filter((alias) => characterTarget(alias)?.toolCapable !== false);
    pendingSummons = [
      ...retryableAliases,
      ...pendingSummons.filter((alias) => !retryableAliases.includes(alias)),
    ];
  };

  const unresolvedSummonReason = (aliases: readonly CharacterAlias[]): string =>
    `[CharacterSummonGuard] ${aliases.join(", ")} 호출을 받은 뒤 캐릭터 모드나 roster가 바뀌어 대상 모델을 확인할 수 없습니다. ` +
    "다른 도구나 모델로 우회하지 말고, 사용자에게 모드가 바뀌었다고 알린 뒤 다시 호출을 요청받으세요.";

  /**
   * task 호출 결과를 TaskBudget과 OwnershipGuard에 함께 반영한다. 해제된 항목은 뜨지 않은 child의 임시
   * ownership을 버리고, 뒤늦은 시작 증거로 다시 과금한 항목은 baseline 없이(unobserved) 추적을 되살린다.
   */
  const settleTaskOutcome = (
    toolCallId: string,
    outcome: TaskCallOutcome,
    progress: readonly { index: number; id: string }[],
  ): void => {
    // 쓰기 소유 주장은 요청 경계와 무관하게 이 호출의 결과로 in-flight를 내리고 canonical id를 묶는다.
    settleSharedWriters(writers, toolCallId, progress);
    const before = reservedMakers(taskGuard, toolCallId) ?? [];
    const settlement = settleTaskCall(taskGuard, toolCallId, outcome);
    if (!settlement) return;
    const released = before.filter((maker) => settlement.released.includes(maker.index));
    if (released.length > 0) dropOwnedChildren(ownership, toolCallId, released);
    const after = reservedMakers(taskGuard, toolCallId);
    if (!after) return;
    const recharged = after.filter((maker) => settlement.recharged.includes(maker.index));
    if (recharged.length > 0) registerSpawnedMakers(ownership, toolCallId, recharged, undefined);
    // 이름 없는 spawn은 결과의 progress id를 별칭으로 연결해야 나중에 완료를 되찾을 수 있다.
    bindSpawnAliases(ownership, toolCallId, after, progress);
  };

  // maker_route 준비가 이 session의 TaskGuard 정본 lock을 읽도록 이 인스턴스의 state를 현재 session id에 묶는다.
  // 사본을 만들지 않으므로 취소 환불·정산이 lock을 풀면 준비 쪽도 같은 순간 푼 상태를 본다.
  let boundSessionId = "";
  const bindSession = (ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): void => {
    const id = (ctx?.sessionManager?.getSessionId?.() ?? "").trim();
    if (!id || id === boundSessionId) return;
    if (boundSessionId) unbindTaskGuardSession(boundSessionId, taskGuard);
    bindTaskGuardSession(id, taskGuard, {
      pending: () => pendingSummons,
      claimed: (toolCallId) => summonCalls.has(toolCallId),
    });
    boundSessionId = id;
  };

  // core는 session_start를 런타임 초기화 때만 보내고 /new·resume·fork·reload는 session_switch로 알린다.
  // 다른 session id로 옮겨 가면 이전 session의 budget·lock·소유권·대기 summon을 잇지 않는다. 같은 id의 reload는
  // 같은 요청의 연속이므로 비우지 않는다(요청 경계는 아래 input 이벤트가 이미 소유한다).
  onSessionLifecycle(pi, {
    start(ctx) {
      ownershipGeneration += 1;
      resetTaskGuardState(taskGuard);
      resetOwnershipState(ownership);
      resetWriterClaimState(writers);
      summonCalls.clear();
      pendingSummons = [];
      bindSession(ctx);
    },
  });
  pi.on("session_shutdown", () => {
    if (boundSessionId) unbindTaskGuardSession(boundSessionId, taskGuard);
    boundSessionId = "";
    if (boundOwnerId) unbindWriterOwners(boundOwnerId, writerView);
    boundOwnerId = "";
  });

  // 실제 사용자 입력 하나를 budget 단위로 본다. extension 내부 주입은 같은 요청의
  // 연속이므로 reset하지 않는다. CUELO은 RPC 입력이므로 interactive와 rpc를 모두 포함한다.
  pi.on("input", async (event, ctx) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    bindSession(ctx);
    ownershipGeneration += 1;
    resetTaskGuardState(taskGuard);
    noteUserRequestText(taskGuard, event.text ?? "");
    resetOwnershipState(ownership);
    summonCalls.clear();
    // 다른 input handler가 이미 확인해 routing prompt로 바꾼 문장은 그 지시를 그대로 쓴다.
    const directives = parseCharacterSummonDirectives(event.text);
    if (directives.length > 0) {
      summonGeneration += 1;
      summonDecision = undefined;
      pendingSummons = directives;
      return;
    }
    const intent = parseCharacterIntent(event.text);
    await decideSummons(event.text, ctx, intent?.kind === "summon" ? intent.aliases : []);
  });

  // 사람이 실행 중인 턴에 끼워 넣은 redirect는 모델이 위조할 수 없다. 이때는 deliverable lock만
  // 풀어 새 완료물로 재고정할 수 있게 하고, 비용 상한인 누적 budget은 그대로 유지한다.
  // synthetic 주입과 agent 귀속 메시지는 사용자 redirect가 아니다.
  pi.on("message_start", async (event, ctx) => {
    const message = event.message as {
      role?: string;
      content?: unknown;
      steering?: boolean;
      synthetic?: boolean;
      attribution?: string;
      customType?: string;
      details?: unknown;
    };
    // async-result 주입은 task child의 완료가 Main에 도달하는 가장 이른 자동 관측점이다.
    // 여기서 만든 OwnershipGuard 줄은 다음 턴 경계에 aside로 흘러 모델이 그 턴에 본다.
    if (message.role === "custom" && message.customType === "async-result") {
      if (!hasUnreportedChildren(ownership)) return;
      const settled = readSettledTaskIds(message.details);
      if (settled.length === 0) return;
      // 이미 보고된 child만 담긴 전달에는 git 스냅샷을 뜨지 않는다.
      const lines = await reportPendingOwnedChildren(settled, ctx);
      if (lines.length === 0) return;
      pi.sendMessage(
        {
          customType: "ownership-guard",
          content: lines.join("\n"),
          display: true,
          attribution: "agent",
        },
        { deliverAs: "aside" },
      );
      return;
    }
    if (message.role !== "user" || message.steering !== true) return;
    if (message.synthetic === true || message.attribution === "agent") return;
    const messageText = Array.isArray(message.content)
      ? message.content
          .flatMap((part) => {
            if (
              !part ||
              typeof part !== "object" ||
              !("type" in part) ||
              part.type !== "text" ||
              !("text" in part) ||
              typeof part.text !== "string"
            ) {
              return [];
            }
            return [part.text];
          })
          .join("\n")
      : typeof message.content === "string"
        ? message.content
        : "";
    const intent = parseCharacterIntent(messageText);
    void decideSummons(messageText, ctx, intent?.kind === "summon" ? intent.aliases : []);
    noteUserRedirect(taskGuard);
    noteUserRequestText(taskGuard, messageText);
  });

  pi.on("tool_call", async (event, ctx) => {
    // 기다리는 동안 새 steering이 판정을 바꿔 걸 수 있으므로, 마지막으로 건 판정까지 끝난 뒤에 pendingSummons를 읽는다.
    for (let decision = summonDecision; decision; decision = summonDecision === decision ? undefined : summonDecision) {
      await decision;
    }
    if (isToolCallEventType<"task", TaskCallInput>("task", event)) {
      let canonicalInput: TaskCallInput;
      try {
        canonicalInput = resolvePreparedTaskInput(event.input, ctx.sessionManager.getSessionId());
      } catch (error) {
        return {
          block: true,
          reason:
            error instanceof Error && error.message
              ? error.message
              : "[SpawnGuard] prepared task 입력을 복원할 수 없습니다.",
        };
      }

      // summon 입력 인식 여부와 무관하게, marker를 쓴 task는 exact target이어야 한다.
      const taskTexts = Array.isArray(canonicalInput.tasks)
        ? canonicalInput.tasks.map((item) => (item && typeof item.task === "string" ? item.task : ""))
        : [typeof canonicalInput.task === "string" ? canonicalInput.task : ""];
      for (const text of taskTexts) {
        const malformed = malformedSummonMarkerReason(text);
        if (malformed) return { block: true, reason: malformed };
        // 정확한 marker는 일반 발주의 maker_route 경계를 면제받는 신호다. 사용자가 이번에 요청한 캐릭터의 것이 아니면
        // 모델이 쓴 marker로 그 경계를 건너뛸 수 있으므로 막는다. 일반 구현 발주는 marker 없이 maker_route로 낸다.
        const marked = parseCharacterSummonMarker(text);
        if (marked !== undefined && !pendingSummons.includes(marked)) {
          return {
            block: true,
            reason:
              `[CharacterSummonGuard] character-summon marker ${marked}은 이번 사용자 호출이 요청한 캐릭터가 아니거나 이미 사용됐습니다. ` +
              "marker는 사용자가 캐릭터를 부른 요청에서만 쓰며, 일반 구현 발주는 marker 없이 maker_route로 준비해 내세요.",
          };
        }
      }
      bindSession(ctx);

      const unresolvedSummons = pendingSummons.filter((alias) => characterTarget(alias) === undefined);
      if (unresolvedSummons.length > 0) return { block: true, reason: unresolvedSummonReason(unresolvedSummons) };
      let guardedInput = canonicalInput;
      const claimedAliases: CharacterAlias[] = [];
      if (pendingSummons.length > 0) {
        const rewritten = rewriteTaskInputForCharacterSummon(canonicalInput, pendingSummons);
        if (!rewritten.ok) return { block: true, reason: rewritten.reason };
        guardedInput = rewritten.input;
        claimedAliases.push(...rewritten.claimed);
      }

      const decision = reserveTaskCall(taskGuard, event.toolCallId, guardedInput);
      if (!decision.ok) return { block: true, reason: decision.reason };
      const makers = reservedMakers(taskGuard, event.toolCallId);
      if (claimedAliases.length > 0) {
        pendingSummons = pendingSummons.filter((alias) => !claimedAliases.includes(alias));
        summonCalls.set(event.toolCallId, claimedAliases);
      }
      // spawn 직전 트리 스냅샷을 child별 baseline으로 남긴다. await 중 request reset이나
      // task 실패가 세대 또는 같은 예약을 무효화하면 ownership만 버리는 것으로는 부족하다.
      // core는 queued steer 뒤 non-interruptible task를 계속 실행하므로 stale spawn 자체를 막는다.
      if (makers && makers.length > 0) {
        const generation = ownershipGeneration;
        const snapshot = await takeTreeSnapshot(eventSessionCwd(ctx));
        const currentMakers = reservedMakers(taskGuard, event.toolCallId);
        if (
          generation !== ownershipGeneration ||
          !sameMakerReservation(makers, currentMakers)
        ) {
          return {
            block: true,
            reason:
              "[OwnershipGuard] spawn baseline 대기 중 요청 세대 또는 task 예약이 바뀌어 stale task 실행을 차단했습니다.",
          };
        }
        registerSpawnedMakers(ownership, event.toolCallId, currentMakers, snapshot);
        claimSharedWriters(writers, event.toolCallId, currentMakers);
        bindWriterView(ctx);
      }
      // task guard의 metadata 파생이 character summon brief보다 나중에 적용돼야 둘 다 보존된다.
      if (decision.input) return { input: decision.input };
      if (guardedInput !== event.input) return { input: guardedInput };
      return;
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      const reason = ownerWriteBlockReason(event.toolName, event.input, ctx);
      if (reason) return { block: true, reason };
    }

    // 호출을 받은 뒤 모드·roster가 바뀌어 alias의 target을 더는 풀 수 없으면 우회하지 않고 막는다(다음 사용자 입력이 새로 정한다).
    const unresolvedSummons = pendingSummons.filter((alias) => characterTarget(alias) === undefined);
    if (unresolvedSummons.length > 0) return { block: true, reason: unresolvedSummonReason(unresolvedSummons) };
    const pendingCapable = pendingSummons.filter((alias) => characterTarget(alias)?.toolCapable === true);
    const pendingWebOnly = pendingSummons.filter((alias) => characterTarget(alias)?.toolCapable === false);

    if (pendingWebOnly.length > 0) {
      if (isToolCallEventType("read", event)) {
        const path = typeof event.input.path === "string" ? event.input.path : "";
        if (path === "rule://web6-consult" || path === "skill://web6-consult") return;
      }
      if (isToolCallEventType<"eval", EvalCallInput>("eval", event)) {
        const code = typeof event.input.code === "string" ? event.input.code : "";
        const webAlias = pendingWebOnly[0]!;
        const target = characterTarget(webAlias)!.model;
        if (!code.includes(webAlias) || !code.includes("character-voice")) {
          return {
            block: true,
            reason:
              `[CharacterSummonGuard] effective prompt에 ${webAlias}의 \`<character-voice>\` block을 넣어야 합니다.`,
          };
        }
        if (!hasOnlyExactCompletionCalls(event.input, target)) {
          return {
            block: true,
            reason:
              `[CharacterSummonGuard] 실제 bare completion() 호출이 정확히 한 번 있고 model 인자가 exact target ${target}여야 합니다. ` +
              "비호출 참조·property 호출·복수 호출·prompt/dummy marker·slow/role alias는 WEB6 호출 증거가 아닙니다.",
          };
        }
        const reason = matchBlockedEvalModelBridge(event.input);
        if (reason) return { block: true, reason };
        summonCalls.set(event.toolCallId, [...pendingWebOnly]);
        pendingSummons = pendingSummons.filter((alias) => characterTarget(alias)?.toolCapable !== false);
        return;
      }
    }

    if (pendingCapable.length > 0) {
      return {
        block: true,
        reason:
          `[CharacterSummonGuard] ${pendingCapable.join(", ")} 호출의 첫 관련 행동은 task child여야 합니다. ` +
          "먼저 task를 호출하고, 그 뒤 필요한 도구는 child가 사용하게 하세요.",
      };
    }

    if (pendingWebOnly.length > 0) {
      return {
        block: true,
        reason:
          `[CharacterSummonGuard] ${pendingWebOnly.join(", ")} 호출은 WEB6 상담 준비용 rule 읽기와 eval만 허용합니다. ` +
          "task child나 다른 도구로 우회하지 마세요.",
      };
    }
    if (isToolCallEventType<"eval", EvalCallInput>("eval", event)) {
      const reason = matchBlockedEvalModelBridge(event.input) ?? (await matchRelayBrowserOpen(event.input, egoLiteAvailable));
      if (reason) return { block: true, reason };
      return;
    }

    if (!isToolCallEventType("bash", event)) return;

    const powerShellReason = matchPowerShellSyntax(event.input.command);
    if (powerShellReason) return { block: true, reason: powerShellReason };

    const sessionCwd = eventSessionCwd(ctx);
    const cwd =
      typeof event.input.cwd === "string" ? bashToolCwd(sessionCwd, event.input.cwd) : sessionCwd;
    const targetDirectories: string[] = [];
    const windowsGitTargets: string[] = [];
    let temporaryTargets = false;
    const temporaryRoot = tmpdir();
    // 1차는 대상만 모은다. 저장소 콜백이 true(차단)를 돌려주면 그 세그먼트에서 판정이 끝나 같은 git의
    // Windows git 판정과 뒤 세그먼트의 대상을 놓친다. 그래서 둘 다 false로 끝까지 훑고 2차에서 실제 판정을 쓴다.
    // 임시 작업 트리 면제도 1차에서는 참(면제)으로 두고 끝까지 훑은 뒤 2차에서 실제 경로로 판정한다.
    const preliminaryReason = matchBlockedCommand(event.input.command, {
      cwd,
      temporaryRoot,
      isSessionRepository: (directory) => {
        targetDirectories.push(directory);
        return false;
      },
      usesWindowsGit: (directory) => {
        windowsGitTargets.push(directory);
        return false;
      },
      isTemporaryDirectory: () => {
        temporaryTargets = true;
        return true;
      },
    });
    let reason = preliminaryReason;
    if (targetDirectories.length > 0 || windowsGitTargets.length > 0 || temporaryTargets) {
      const [repository, usesWindowsGit, sessionRoot] = await Promise.all([
        targetDirectories.length > 0
          ? repositoryMatcher(sessionCwd, targetDirectories)
          : { isSessionRepository: (_directory: string) => true, unproven: [] },
        windowsGitMatcher(windowsGitTargets),
        temporaryTargets ? sessionWorktreeRoot(sessionCwd) : undefined,
      ]);
      const { isSessionRepository } = repository;
      // 세션 저장소임을 증명하지 못해 막힐 대상만 git이 "어느 저장소도 아님"을 증명하는지 따로 본다(보통은 git 호출이 늘지 않는다).
      const isOutsideRepository =
        repository.unproven.length > 0 ? await outsideRepositoryMatcher(repository.unproven) : () => false;
      reason = matchBlockedCommand(event.input.command, {
        cwd,
        temporaryRoot,
        isSessionRepository,
        usesWindowsGit,
        isOutsideRepository,
        isTemporaryDirectory: temporaryDirectoryMatcher(sessionCwd, sessionRoot),
      });
    }
    if (reason) return { block: true, reason };
    // 통과한 명령 중 Windows 실행 파일을 부르는 것은 출력이 UTF-8로 오도록 감싸 실행한다(interop-hint.ts).
    const pty = (event.input as { pty?: unknown }).pty === true;
    const command = windowsOutputCommand(event.input.command, { wsl: WSL_INTEROP, pty });
    return command ? { input: { ...event.input, command } } : undefined;
  });

  // 실행된 task 호출(tool_result)과 실행 전에 끝난 호출(tool_execution_end)은 같은 항목 단위 정산을 탄다.
  // 뜨지 않은 child의 예약·임시 ownership은 그 호출 것만 되돌리고, 시작 증거가 있는 child는 오류로 끝나도
  // 유지한다. `write proc://<id>/kill`로 발주를 되돌린 경우에도 런타임이 취소를 확인한 child만 canonical
  // agent id로 찾아 상한 안에서 환불하며, 취소된 child도 트리가 바뀌었으면 보고한다.
  pi.on("tool_result", async (event, ctx) => {
    const claimedAliases = summonCalls.get(event.toolCallId);
    if (claimedAliases) {
      summonCalls.delete(event.toolCallId);
      if (event.isError) restoreRetryableSummons(claimedAliases);
    }
    if (event.toolName === "task") {
      const progress = readSpawnProgress(event.details);
      settleTaskOutcome(
        event.toolCallId,
        { executed: true, isError: event.isError, details: event.details, registry: readTaskJobRegistry(ctx) },
        progress,
      );
      if (event.isError) return;
      const makers = reservedMakers(taskGuard, event.toolCallId);
      if (!makers || makers.length === 0) return;
      const settled = progress
        .filter((row) => row.status && row.status !== "running" && row.status !== "pending")
        .map((row) => row.id);
      if (settled.length === 0 || !hasUnreportedChildren(ownership)) return;
      const lines = await reportPendingOwnedChildren(settled, ctx);
      if (lines.length === 0) return;
      return { content: [...event.content, { type: "text", text: lines.join("\n") }] };
    }

    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      const output = event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      const hint = interopHint(command, output, { managedPython: managedPythonPath() });
      return hint ? { content: [...event.content, { type: "text", text: hint }] } : undefined;
    }
    if (event.isError) return;
    const path = typeof event.input.path === "string" ? event.input.path.trim() : "";
    // 18.3.0 write/read 결과의 proc:// details는 선언 타입에 없으므로 unknown으로 좁힌다.
    const details: unknown = event.details;
    const proc = details && typeof details === "object" && "proc" in details ? details.proc : undefined;
    let cancelled: string[] = [];
    let jobDetails: unknown;
    if (event.toolName === "write" && /^proc:\/\/[^/?#]+\/kill$/.test(path)) {
      cancelled = readCancelledChildIds(details);
      if (cancelled.length > 0) releaseCancelledSpawns(taskGuard, cancelled);
      jobDetails = proc;
    } else if (event.toolName === "wait") {
      jobDetails = details;
    } else if (event.toolName === "read" && path.startsWith("proc://")) {
      jobDetails = proc && typeof proc === "object" && "job" in proc && proc.job ? { jobs: [proc.job] } : proc;
    } else {
      return;
    }
    if (!hasUnreportedChildren(ownership)) return;
    const settled = readSettledTaskIds(jobDetails);
    const ids = [...new Set([...settled, ...cancelled])];
    if (ids.length === 0) return;
    const lines = await reportPendingOwnedChildren(ids, ctx);
    if (lines.length === 0) return;
    return { content: [...event.content, { type: "text", text: lines.join("\n") }] };
  });

  // core는 tool_result 없이 끝난 호출(하류 guard 거절·승인 거부·승인 예외·실행 전 abort·skip)에도
  // tool_execution_end를 낸다. 이때 claim한 summon도 실행되지 않았다. tool_result를 이미 본 호출은
  // summon 기록이 지워졌고 settleTaskCall도 결과를 바꾸지 않는다.
  pi.on("tool_execution_end", (event, ctx) => {
    const claimedAliases = summonCalls.get(event.toolCallId);
    if (claimedAliases) {
      summonCalls.delete(event.toolCallId);
      if (event.isError) restoreRetryableSummons(claimedAliases);
    }
    if (event.toolName !== "task") return;
    const result: unknown = event.result;
    const details = result && typeof result === "object" && "details" in result ? result.details : undefined;
    settleTaskOutcome(
      event.toolCallId,
      { executed: false, isError: event.isError, details, registry: readTaskJobRegistry(ctx) },
      readSpawnProgress(details),
    );
  });
}

export function createCommandGuard(deps: CommandGuardDeps = {}): (pi: ExtensionAPI) => void {
  return (pi) => commandGuardWith(pi, deps);
}

export default createCommandGuard();
