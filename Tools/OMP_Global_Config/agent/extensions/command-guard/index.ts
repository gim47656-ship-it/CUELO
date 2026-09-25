import { execFile } from "node:child_process";
import { resolve } from "node:path";

import { isToolCallEventType, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  CHARACTER_TARGETS,
  parseCharacterIntent,
  parseCharacterSummonDirectives,
  rewriteTaskInputForCharacterSummon,
  type CharacterAlias,
} from "../character-voice";
import { resolvePreparedTaskInput } from "../lib/prepared-task";

import { matchBlockedCommand } from "./matcher";
import {
  bindSpawnAliases,
  createOwnershipState,
  createTaskGuardState,
  dropOwnedChildren,
  hasUnreportedChildren,
  matchBlockedEvalModelBridge,
  noteUserRedirect,
  readCancelledJobIds,
  readSettledTaskIds,
  readSpawnProgress,
  registerSpawnedMakers,
  releaseCancelledSpawns,
  reportOwnedChildren,
  reserveTaskCall,
  reservedMakers,
  resetOwnershipState,
  resetTaskGuardState,
  rollbackTaskCall,
  stripScopePrefix,
  type EvalCallInput,
  type MakerSpawn,
  type OwnershipState,
  type TaskCallInput,
  type TreeSnapshot,
} from "./task-guard";

function normalizeRepositoryPath(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
}

/** git status/hash-object가 주는 상대경로를 소유 판정과 같은 기준으로 정규화한다. */
function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

/** 이벤트 컨텍스트의 세션 cwd. OMPWEB처럼 process.cwd()가 세션 cwd가 아닐 수 있어 우선한다. */
function eventSessionCwd(ctx: { cwd?: string } | undefined): string {
  return typeof ctx?.cwd === "string" && ctx.cwd ? resolve(ctx.cwd) : process.cwd();
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
    const output = await runGit(
      directory,
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    );
    const commonDirectory = output?.trim();
    return commonDirectory ? normalizeRepositoryPath(commonDirectory) : undefined;
  } catch {
    return undefined;
  }
}

// common-dir 조회 promise는 디렉터리별로 공유한다. OMPWEB처럼 한 프로세스가 여러 세션을 띄우면
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

async function repositoryMatcher(
  sessionCwd: string,
  targetDirectories: readonly string[],
): Promise<(directory: string) => boolean> {
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
  return (directory: string): boolean => {
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
}

/**
 * git 호출 하나의 상한. 각 child callback을 기다리는 extension handler의 상한은 기본 30초이므로
 * 세 순차 호출의 최악값을 그 아래로 둔다. 비동기 child를 써 대기 중 JS event loop는 계속 돈다.
 */
const GIT_SPAWN_TIMEOUT_MS = 5000;
const GIT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function runGit(directory: string, args: string[], input?: string): Promise<string | undefined> {
  const { promise, resolve: resolveOutput } = Promise.withResolvers<string | undefined>();
  const child = execFile(
    "git",
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
    const prefixOutput = await runGit(directory, ["rev-parse", "--show-prefix"]);
    if (prefixOutput === undefined) return undefined;
    const scope = prefixOutput.trim().replace(/\\/g, "/");

    const statusOutput = await runGit(
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
export default function commandGuard(pi: ExtensionAPI): void {
  const taskGuard = createTaskGuardState();
  const ownership = createOwnershipState();
  const summonCalls = new Map<string, CharacterAlias[]>();
  let pendingSummons: CharacterAlias[] = [];
  let ownershipGeneration = 0;

  /**
   * 한 terminal event의 exact child들은 스냅샷 하나를 공유한다. await 중 reset되거나 다른
   * terminal 경계가 먼저 같은 child를 소비했으면 새 상태를 건드리지 않고 남은 exact child만 보고한다.
   */
  const reportPendingOwnedChildren = async (
    ids: readonly string[],
    ctx: { cwd?: string } | undefined,
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
    return reportOwnedChildren(ownership, stillPendingKeys, tree);
  };

  pi.on("session_start", () => {
    ownershipGeneration += 1;
    resetTaskGuardState(taskGuard);
    resetOwnershipState(ownership);
    summonCalls.clear();
    pendingSummons = [];
  });

  // 실제 사용자 입력 하나를 budget 단위로 본다. extension 내부 주입은 같은 요청의
  // 연속이므로 reset하지 않는다. OMPWEB은 RPC 입력이므로 interactive와 rpc를 모두 포함한다.
  pi.on("input", (event) => {
    if (event.source !== "interactive" && event.source !== "rpc") return;
    ownershipGeneration += 1;
    resetTaskGuardState(taskGuard);
    resetOwnershipState(ownership);
    summonCalls.clear();
    const intent = parseCharacterIntent(event.text);
    pendingSummons =
      intent?.kind === "summon" ? intent.aliases : parseCharacterSummonDirectives(event.text);
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
    pendingSummons = intent?.kind === "summon" ? intent.aliases : [];
    noteUserRedirect(taskGuard);
  });

  pi.on("tool_call", async (event, ctx) => {
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
      }
      // task guard의 metadata 파생이 character summon brief보다 나중에 적용돼야 둘 다 보존된다.
      if (decision.input) return { input: decision.input };
      if (guardedInput !== event.input) return { input: guardedInput };
      return;
    }

    const pendingCapable = pendingSummons.filter((alias) => CHARACTER_TARGETS[alias].toolCapable);
    const pendingWebOnly = pendingSummons.filter((alias) => !CHARACTER_TARGETS[alias].toolCapable);

    if (pendingWebOnly.length > 0) {
      if (isToolCallEventType("read", event)) {
        const path = typeof event.input.path === "string" ? event.input.path : "";
        if (path === "rule://web6-consult" || path === "skill://web6-consult") return;
      }
      if (isToolCallEventType<"eval", EvalCallInput>("eval", event)) {
        const code = typeof event.input.code === "string" ? event.input.code : "";
        const target = CHARACTER_TARGETS["SHION(시온)"].model;
        if (!code.includes("SHION(시온)") || !code.includes("character-voice")) {
          return {
            block: true,
            reason:
              "[CharacterSummonGuard] effective prompt에 SHION(시온)의 `<character-voice>` block을 넣어야 합니다.",
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
        pendingSummons = pendingSummons.filter((alias) => CHARACTER_TARGETS[alias].toolCapable);
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
      const reason = matchBlockedEvalModelBridge(event.input);
      if (reason) return { block: true, reason };
      return;
    }

    if (!isToolCallEventType("bash", event)) return;

    const sessionCwd = eventSessionCwd(ctx);
    const cwd =
      typeof event.input.cwd === "string" ? resolve(sessionCwd, event.input.cwd) : sessionCwd;
    const targetDirectories: string[] = [];
    const collectTarget = (directory: string): boolean => {
      targetDirectories.push(directory);
      return true;
    };
    const preliminaryReason = matchBlockedCommand(event.input.command, {
      cwd,
      isSessionRepository: collectTarget,
    });
    if (targetDirectories.length === 0) {
      if (preliminaryReason) return { block: true, reason: preliminaryReason };
      return;
    }
    const isSessionRepository = await repositoryMatcher(sessionCwd, targetDirectories);
    const reason = matchBlockedCommand(event.input.command, {
      cwd,
      isSessionRepository,
    });
    if (reason) return { block: true, reason };
  });

  // preflight를 통과했지만 실제 task tool 자체가 실패한 경우에는 예약한 spawn budget을 되돌리고
  // 뜨지도 않은 child의 ownership 추적도 버린다. `write proc://<id>/kill`로 발주를 되돌린 경우에도 런타임이
  // 취소를 확인한 child만 상한 안에서 환불하며, 취소된 child도 트리가 바뀌었으면 보고한다.
  pi.on("tool_result", async (event, ctx) => {
    const claimedAliases = summonCalls.get(event.toolCallId);
    if (claimedAliases) {
      summonCalls.delete(event.toolCallId);
      if (event.isError) {
        // tool-capable child가 실제로 뜨지 못했으면 첫 행동 계약을 다시 요구한다.
        // 반면 SHION은 검증된 exact WEB6 eval을 실제 호출한 것으로 상담 시도가 끝난다.
        // provider/model 오류까지 pending으로 되돌리면 read/todo/진단을 전부 막아 원인 확인도
        // 사용자의 원래 작업 재개도 불가능해진다.
        const retryableAliases = claimedAliases.filter((alias) => CHARACTER_TARGETS[alias].toolCapable);
        pendingSummons = [
          ...retryableAliases,
          ...pendingSummons.filter((alias) => !retryableAliases.includes(alias)),
        ];
      }
    }
    if (event.toolName === "task") {
      const makers = reservedMakers(taskGuard, event.toolCallId);
      if (event.isError) {
        rollbackTaskCall(taskGuard, event.toolCallId);
        if (makers) dropOwnedChildren(ownership, event.toolCallId, makers);
        return;
      }
      if (!makers || makers.length === 0) return;
      const progress = readSpawnProgress(event.details);
      // 이름 없는 spawn은 이 결과의 progress id를 별칭으로 연결해야 나중에 완료를 되찾을 수 있다.
      bindSpawnAliases(ownership, event.toolCallId, makers, progress);
      const settled = progress
        .filter((row) => row.status && row.status !== "running" && row.status !== "pending")
        .map((row) => row.id);
      if (settled.length === 0 || !hasUnreportedChildren(ownership)) return;
      const lines = await reportPendingOwnedChildren(settled, ctx);
      if (lines.length === 0) return;
      return { content: [...event.content, { type: "text", text: lines.join("\n") }] };
    }

    if (event.isError) return;
    const path = typeof event.input.path === "string" ? event.input.path.trim() : "";
    // 18.3.0 write/read 결과의 proc:// details는 선언 타입에 없으므로 unknown으로 좁힌다.
    const details: unknown = event.details;
    const proc = details && typeof details === "object" && "proc" in details ? details.proc : undefined;
    let cancelled: string[] = [];
    let jobDetails: unknown;
    if (event.toolName === "write" && /^proc:\/\/[^/?#]+\/kill$/.test(path)) {
      cancelled = readCancelledJobIds(details);
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
}
