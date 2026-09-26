import { resolve } from "node:path";

export interface GuardContext {
  /** bash tool_call이 지정한 cwd. 없으면 세션 cwd. */
  cwd?: string;
  /** 주어진 디렉터리가 세션 저장소와 같은 git 저장소인지. 미제공이면 차단. */
  isSessionRepository?: (dir: string) => boolean;
}

type Separator = ";" | "&&" | "||" | "|" | "&" | "\n";

interface ShellToken {
  value: string;
  quoted: boolean;
}

interface ShellSegment {
  tokens: ShellToken[];
  separatorBefore?: Separator;
}

interface Invocation {
  index: number;
  name: string;
}

interface GitInvocation {
  subcommand: string;
  args: string[];
  globalArgs: string[];
}

type StringLookup = Readonly<Record<string, true>>;

const GIT_GLOBAL_OPTIONS_WITH_VALUE: StringLookup = {
  "-c": true,
  "-C": true,
  "--config-env": true,
  "--exec-path": true,
  "--git-dir": true,
  "--namespace": true,
  "--super-prefix": true,
  "--work-tree": true,
};

const CLI_OPTIONS_WITH_VALUE: StringLookup = {
  "--config": true,
  "--cwd": true,
  "--dir": true,
  "--filter": true,
  "--prefix": true,
  "--project": true,
  "--repo": true,
  "--repository": true,
  "--workspace": true,
  "-C": true,
  "-R": true,
  "-c": true,
  "-w": true,
};

const FINALIZER_OWNED_GIT_COMMANDS: StringLookup = {
  add: true,
  commit: true,
  "commit-tree": true,
  push: true,
  "update-ref": true,
};

const DB_CLIENTS: StringLookup = {
  duckdb: true,
  "invoke-sqlcmd": true,
  mariadb: true,
  mysql: true,
  psql: true,
  sqlite3: true,
  sqlcmd: true,
  sqlplus: true,
};

const SQLITE_OPTIONS_WITH_VALUE: StringLookup = {
  "-cmd": true,
  "-init": true,
  "-separator": true,
};

const BROAD_PATHS: StringLookup = {
  "*": true,
  "**": true,
  "**/*": true,
  ".": true,
  "./": true,
  "./*": true,
  "./**": true,
  "./**/*": true,
  "..": true,
  "../": true,
  "../*": true,
  "/": true,
  "/*": true,
  "~": true,
  "~/": true,
  "~/*": true,
  "~/**": true,
  "~/**/*": true,
};

const BROAD_ENVIRONMENT_PATHS: StringLookup = {
  "$HOME": true,
  "$HOME/": true,
  "$HOME/*": true,
  "$HOME/**": true,
  "${HOME}": true,
  "${HOME}/": true,
  "${HOME}/*": true,
  "${HOME}/**": true,
  "$PWD": true,
  "$PWD/": true,
  "$PWD/*": true,
  "$PWD/**": true,
  "${PWD}": true,
  "${PWD}/": true,
  "${PWD}/*": true,
  "${PWD}/**": true,
  "%CD%": true,
  "%CD%/": true,
  "%CD%/*": true,
  "%CD%/**": true,
  "%USERPROFILE%": true,
  "%USERPROFILE%/": true,
  "%USERPROFILE%/*": true,
  "%USERPROFILE%/**": true,
};

const INVOCATION_PREFIXES: StringLookup = {
  "&": true,
  "{": true,
  "}": true,
};

const COMMAND_WRAPPERS: StringLookup = {
  builtin: true,
  command: true,
  nohup: true,
};

const ENV_OPTIONS_WITH_VALUE: StringLookup = {
  "--chdir": true,
  "--unset": true,
  "-C": true,
  "-u": true,
};

const SUDO_OPTIONS_WITH_VALUE: StringLookup = {
  "-C": true,
  "-D": true,
  "-g": true,
  "-h": true,
  "-p": true,
  "-R": true,
  "-T": true,
  "-u": true,
};

const TIME_OPTIONS_WITH_VALUE: StringLookup = {
  "--format": true,
  "--output": true,
  "-f": true,
  "-o": true,
};

const TIMEOUT_OPTIONS_WITH_VALUE: StringLookup = {
  "--kill-after": true,
  "--signal": true,
  "-k": true,
  "-s": true,
};


const REMOVE_ITEM_PATH_OPTIONS: StringLookup = {
  "-literalpath": true,
  "-path": true,
};

const REMOVE_ITEM_OPTIONS_WITH_VALUE: StringLookup = {
  "-credential": true,
  "-exclude": true,
  "-filter": true,
  "-include": true,
  "-stream": true,
};

const PACKAGE_EXECUTORS: StringLookup = {
  bunx: true,
  npx: true,
  pnpx: true,
};

const PACKAGE_MANAGERS: StringLookup = {
  bun: true,
  npm: true,
  pnpm: true,
  yarn: true,
};

const GH_RELEASE_MUTATIONS: StringLookup = {
  create: true,
  delete: true,
  edit: true,
  upload: true,
};

const DEPLOY_TARGET_RUNNERS: StringLookup = {
  just: true,
  make: true,
  task: true,
};

const SCRIPT_INTERPRETERS: StringLookup = {
  bash: true,
  deno: true,
  node: true,
  python: true,
  python3: true,
  sh: true,
  zsh: true,
};

const POWERSHELL_COMMAND_OPTIONS: StringLookup = {
  "-c": true,
  "-command": true,
  "-commandwithargs": true,
};

const REASONS = {
  gitFinalize:
    "자동 staging·commit·push와 ref 갱신은 저장소 잠금과 경로·ancestry 검증을 수행하는 git_finalize 도구로만 실행하세요.",
  gitReset:
    "작업 내용을 파괴할 수 있는 git reset --hard 명령은 정책상 차단됩니다.",
  gitClean:
    "디렉터리를 강제 정리하는 git clean 명령은 정책상 차단됩니다.",
  gitDelete:
    "브랜치·태그를 강제로 삭제하거나 원격 ref를 삭제하는 명령은 정책상 차단됩니다.",
  broadRemove:
    "현재 작업 트리나 루트 경로를 광범위하게 삭제하는 명령은 정책상 차단됩니다.",
  database:
    "실제 데이터베이스 클라이언트로 DROP/TRUNCATE를 실행하는 명령은 정책상 차단됩니다.",
  deploy:
    "배포·게시·릴리스 작업을 실행하는 명령은 정책상 차단됩니다.",
} as const;

function isRedirectionToken(value: string): boolean {
  return /^(?:(?:\d+)?(?:<|>|<<|>>|<<<|<>|>&|<&|>\|)|&>|&>>)$/.test(value);
}

function stripRedirections(tokens: ShellToken[]): ShellToken[] {
  const executable: ShellToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isRedirectionToken(tokens[index].value)) {
      executable.push(tokens[index]);
      continue;
    }
    if (index + 1 < tokens.length && !isRedirectionToken(tokens[index + 1].value)) {
      index += 1;
    }
  }
  return executable;
}

function tokenizeShell(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let tokens: ShellToken[] = [];
  let value = "";
  let tokenStarted = false;
  let tokenQuoted = false;
  let quote: "'" | '"' | undefined;
  let separatorBefore: Separator | undefined;

  const endToken = (): void => {
    if (!tokenStarted) return;
    tokens.push({ value, quoted: tokenQuoted });
    value = "";
    tokenStarted = false;
    tokenQuoted = false;
  };

  const endSegment = (separator: Separator): void => {
    endToken();
    let pushed = false;
    if (tokens.length > 0) {
      const executableTokens = stripRedirections(tokens);
      if (executableTokens.length > 0) {
        segments.push({ tokens: executableTokens, separatorBefore });
        pushed = true;
      }
    }
    tokens = [];
    if (pushed || separatorBefore === undefined) separatorBefore = separator;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    const next = command[index + 1];
    const afterNext = command[index + 2];

    if (
      character === "\\" &&
      (next === "\n" || (next === "\r" && afterNext === "\n")) &&
      quote !== "'"
    ) {
      index += next === "\r" ? 2 : 1;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = undefined;
        tokenQuoted = true;
        continue;
      }

      if (
        quote === '"' &&
        character === "\\" &&
        next !== undefined &&
        (next === '"' || next === "\\" || next === "$" || next === "`")
      ) {
        value += next;
        tokenStarted = true;
        index += 1;
        continue;
      }

      if (quote === '"' && character === "`" && next !== undefined) {
        value += next;
        tokenStarted = true;
        index += 1;
        continue;
      }

      value += character;
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      tokenQuoted = true;
      continue;
    }

    if (character === "\\" && next !== undefined) {
      if (/['";|&#\\()<>]/.test(next)) {
        value += next;
        tokenStarted = true;
        index += 1;
      } else {
        value += character;
        tokenStarted = true;
      }
      continue;
    }

    if (character === "#" && !tokenStarted) {
      while (index + 1 < command.length && command[index + 1] !== "\n") {
        index += 1;
      }
      continue;
    }
    if (character === "&" && next === ">") {
      endToken();
      let operator = "&>";
      index += 1;
      if (command[index + 1] === ">") {
        operator += ">";
        index += 1;
      }
      tokens.push({ value: operator, quoted: false });
      continue;
    }

    if (character === "<" || character === ">") {
      let descriptor = "";
      if (tokenStarted && !tokenQuoted && /^\d+$/.test(value)) {
        descriptor = value;
        value = "";
        tokenStarted = false;
        tokenQuoted = false;
      } else {
        endToken();
      }

      let operator = character;
      if (
        (character === ">" && (next === ">" || next === "|" || next === "&")) ||
        (character === "<" && (next === "<" || next === ">" || next === "&"))
      ) {
        operator += next;
        index += 1;
        if (operator === "<<" && command[index + 1] === "<") {
          operator += "<";
          index += 1;
        }
      }
      tokens.push({ value: `${descriptor}${operator}`, quoted: false });
      continue;
    }

    if (character === "(" || character === ")") {
      endSegment(";");
      continue;
    }


    if (character === "\n") {
      endSegment("\n");
      continue;
    }

    if (character === "\r") {
      continue;
    }

    if (/\s/.test(character)) {
      endToken();
      continue;
    }

    if (character === ";") {
      endSegment(";");
      continue;
    }

    if (character === "|" || character === "&") {
      if (next === character) {
        endSegment(character === "|" ? "||" : "&&");
        index += 1;
        continue;
      }

      endSegment(character === "|" ? "|" : "&");
      continue;
    }

    value += character;
    tokenStarted = true;
  }

  endToken();
  const executableTokens = stripRedirections(tokens);
  if (executableTokens.length > 0) {
    segments.push({ tokens: executableTokens, separatorBefore });
  }
  return segments;
}

function commandName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return basename.replace(/\.(?:exe|cmd|bat)$/i, "");
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function resolveInvocation(tokens: ShellToken[]): Invocation | undefined {
  let index = 0;

  while (index < tokens.length && isEnvironmentAssignment(tokens[index].value)) index += 1;

  while (index < tokens.length) {
    const name = commandName(tokens[index].value);

    if (INVOCATION_PREFIXES[tokens[index].value]) {
      index += 1;
      continue;
    }

    if (name === "command") {
      const wrapperIndex = index;
      index += 1;
      while (index < tokens.length) {
        const option = tokens[index].value;
        if (option === "-v" || option === "-V") return { index: wrapperIndex, name };
        if (option === "-p" || option === "--") {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (name === "nohup") {
      const wrapperIndex = index;
      index += 1;
      if (
        tokens[index]?.value === "--help" ||
        tokens[index]?.value === "--version"
      ) {
        return { index: wrapperIndex, name };
      }
      if (tokens[index]?.value === "--") index += 1;
      continue;
    }

    if (name === "time") {
      const wrapperIndex = index;
      index += 1;
      while (index < tokens.length) {
        const value = tokens[index].value;
        if (value === "--") {
          index += 1;
          break;
        }
        if (value === "--help" || value === "--version") {
          return { index: wrapperIndex, name };
        }
        if (!value.startsWith("-")) break;
        const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
        if (!value.includes("=") && TIME_OPTIONS_WITH_VALUE[option]) index += 2;
        else index += 1;
      }
      continue;
    }

    if (name === "timeout") {
      const wrapperIndex = index;
      index += 1;
      while (index < tokens.length) {
        const value = tokens[index].value;
        if (value === "--") {
          index += 1;
          break;
        }
        if (value === "--help" || value === "--version") {
          return { index: wrapperIndex, name };
        }
        if (!value.startsWith("-")) break;
        const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
        if (!value.includes("=") && TIMEOUT_OPTIONS_WITH_VALUE[option]) index += 2;
        else index += 1;
      }
      if (index >= tokens.length) return undefined;
      index += 1;
      if (tokens[index]?.value === "--") index += 1;
      continue;
    }

    if (COMMAND_WRAPPERS[name]) {
      index += 1;
      continue;
    }

    if (name === "env") {
      index += 1;
      while (index < tokens.length) {
        const value = tokens[index].value;
        if (isEnvironmentAssignment(value)) {
          index += 1;
          continue;
        }
        if (ENV_OPTIONS_WITH_VALUE[value]) {
          index += 2;
          continue;
        }
        if (value.startsWith("-")) {
          index += 1;
          continue;
        }
        break;
      }
      continue;
    }

    if (name === "sudo") {
      index += 1;
      while (index < tokens.length && tokens[index].value.startsWith("-")) {
        const option = tokens[index].value;
        if (SUDO_OPTIONS_WITH_VALUE[option]) {
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }

    return { index, name };
  }

  return undefined;
}

function positionalArguments(
  args: string[],
  optionsWithValue: StringLookup = CLI_OPTIONS_WITH_VALUE,
): string[] {
  const positionals: string[] = [];
  let parseOptions = true;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (parseOptions && value === "--") {
      parseOptions = false;
      continue;
    }

    if (parseOptions && value.startsWith("-")) {
      const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
      if (!value.includes("=") && optionsWithValue[option]) index += 1;
      continue;
    }

    positionals.push(value);
  }

  return positionals;
}

function parseGitInvocation(tokens: ShellToken[], invocation: Invocation): GitInvocation | undefined {
  if (invocation.name !== "git") return undefined;

  const values = tokens.slice(invocation.index + 1).map((token) => token.value);
  let index = 0;

  while (index < values.length) {
    const value = values[index];
    if (value === "--") {
      index += 1;
      break;
    }
    if (!value.startsWith("-")) break;

    const equalsIndex = value.indexOf("=");
    const option = equalsIndex >= 0 ? value.slice(0, equalsIndex) : value;
    const hasAttachedShortValue =
      (value.startsWith("-c") || value.startsWith("-C")) && value.length > 2;

    if (
      equalsIndex < 0 &&
      !hasAttachedShortValue &&
      GIT_GLOBAL_OPTIONS_WITH_VALUE[option]
    ) {
      index += 2;
    } else {
      index += 1;
    }
  }

  if (index >= values.length) return undefined;
  return {
    subcommand: values[index].toLowerCase(),
    args: values.slice(index + 1),
    globalArgs: values.slice(0, index),
  };
}

// `~`는 단어 맨 앞이나 assignment 꼴의 `=`·`:` 뒤에서만 셸이 확장한다. 경로 중간의 literal
// `~`(8.3 짧은 이름 `RUNNER~1` 등)는 확장이 아니므로 저장소 판정으로 넘긴다.
function hasShellExpansion(value: string): boolean {
  return /[$%`*?]|(?:^|[=:])~/.test(value);
}

function finalizerTargetDirectory(
  git: GitInvocation,
  context: GuardContext,
): string | undefined {
  let directory = resolve(context.cwd ?? ".");
  let gitDirectoryPath: string | undefined;

  for (let index = 0; index < git.globalArgs.length; index += 1) {
    const value = git.globalArgs[index];
    if (value === "--") break;

    if (value === "-C" || value === "--git-dir") {
      const path = git.globalArgs[index + 1];
      if (path === undefined || hasShellExpansion(path)) return undefined;
      if (value === "-C") directory = resolve(directory, path);
      else gitDirectoryPath = path;
      index += 1;
      continue;
    }

    if (value.startsWith("-C") && value.length > 2) {
      const path = value.slice(2);
      if (hasShellExpansion(path)) return undefined;
      directory = resolve(directory, path);
      continue;
    }

    if (value.startsWith("--git-dir=")) {
      const path = value.slice("--git-dir=".length);
      if (hasShellExpansion(path)) return undefined;
      gitDirectoryPath = path;
      continue;
    }

    const equalsIndex = value.indexOf("=");
    const option = equalsIndex >= 0 ? value.slice(0, equalsIndex) : value;
    const hasAttachedShortValue =
      (value.startsWith("-c") || value.startsWith("-C")) && value.length > 2;
    if (
      equalsIndex < 0 &&
      !hasAttachedShortValue &&
      GIT_GLOBAL_OPTIONS_WITH_VALUE[option]
    ) {
      index += 1;
    }
  }

  return gitDirectoryPath === undefined
    ? directory
    : resolve(directory, gitDirectoryPath);
}

function hasLongOption(
  args: string[],
  names: string[],
  minimumPrefixLength = 4,
): boolean {
  for (const value of args) {
    if (value === "--") return false;
    const normalized = value.toLowerCase();
    const equalsIndex = normalized.indexOf("=");
    const option = equalsIndex >= 0 ? normalized.slice(0, equalsIndex) : normalized;
    if (!option.startsWith("--")) continue;
    for (const name of names) {
      if (
        option === name ||
        (option.length >= minimumPrefixLength && name.startsWith(option))
      ) {
        return true;
      }
    }
  }
  return false;
}

function shortFlags(args: string[]): Set<string> {
  const flags = new Set<string>();
  for (const value of args) {
    if (value === "--") break;
    if (/^-[^-]/.test(value)) {
      for (const flag of value.slice(1)) flags.add(flag);
    }
  }
  return flags;
}


function matchGit(
  tokens: ShellToken[],
  invocation: Invocation,
  context?: GuardContext,
): string | undefined {
  const git = parseGitInvocation(tokens, invocation);
  if (!git) return undefined;

  if (FINALIZER_OWNED_GIT_COMMANDS[git.subcommand]) {
    if (!context?.isSessionRepository) return REASONS.gitFinalize;
    const targetDirectory = finalizerTargetDirectory(git, context);
    if (!targetDirectory) return REASONS.gitFinalize;
    try {
      return context.isSessionRepository(targetDirectory)
        ? REASONS.gitFinalize
        : undefined;
    } catch {
      return REASONS.gitFinalize;
    }
  }

  if (git.subcommand === "reset" && hasLongOption(git.args, ["--hard"], 3)) {
    return REASONS.gitReset;
  }

  if (git.subcommand === "clean") {
    const flags = shortFlags(git.args);
    const force = flags.has("f") || hasLongOption(git.args, ["--force"], 3);
    if (force) return REASONS.gitClean;
  }

  if (git.subcommand === "rm") {
    const flags = shortFlags(git.args);
    const paths = positionalArguments(git.args);
    const recursive = flags.has("r") || flags.has("R") || hasLongOption(git.args, ["--recursive"], 3);
    const force = flags.has("f") || hasLongOption(git.args, ["--force"], 3);
    if (recursive && force && paths.some(isBroadPath)) return REASONS.broadRemove;
  }


  if (git.subcommand === "branch") {
    const flags = shortFlags(git.args);
    const forcedShortDelete = flags.has("D") || (flags.has("d") && flags.has("f"));
    const forcedLongDelete =
      hasLongOption(git.args, ["--delete"], 3) && hasLongOption(git.args, ["--force"], 3);
    if (forcedShortDelete || forcedLongDelete) return REASONS.gitDelete;
  }

  if (git.subcommand === "tag") {
    const flags = shortFlags(git.args);
    if (flags.has("d") || hasLongOption(git.args, ["--delete"], 3)) return REASONS.gitDelete;
  }

  return undefined;
}

function isBroadPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  const upper = normalized.toUpperCase();

  if (BROAD_PATHS[normalized]) return true;
  if (BROAD_ENVIRONMENT_PATHS[upper]) return true;

  if (/^[A-Za-z]:\/(?:\*|\.\*|\*\*)?$/.test(normalized)) return true;
  return /^\/\/[^/]+\/[^/]+\/?(?:\*)?$/.test(normalized);
}

function matchRm(args: string[]): string | undefined {
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  let parseOptions = true;

  for (const value of args) {
    if (parseOptions && value === "--") {
      parseOptions = false;
      continue;
    }

    if (parseOptions && value.startsWith("--")) {
      const option = value.toLowerCase();
      if (option.length >= 3 && "--recursive".startsWith(option)) recursive = true;
      if (option.length >= 3 && "--force".startsWith(option)) force = true;
      continue;
    }

    if (parseOptions && /^-[^-]/.test(value)) {
      const flags = value.slice(1);
      if (flags.includes("r") || flags.includes("R")) recursive = true;
      if (flags.includes("f")) force = true;
      continue;
    }

    targets.push(value);
  }

  return recursive && force && targets.some(isBroadPath) ? REASONS.broadRemove : undefined;
}

function matchRemoveItem(args: string[]): string | undefined {
  let recursive = false;
  let force = false;
  const targets: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const option = value.toLowerCase().replace(/:(?:\$?true)$/i, "");

    if (option === "/s") {
      recursive = true;
      continue;
    }
    if (option === "/q" || option === "/f") {
      force = true;
      continue;
    }

    if (
      option === "-r" ||
      (option.length >= 3 && "-recurse".startsWith(option))
    ) {
      recursive = true;
      continue;
    }
    if (option === "-fo" || (option.length >= 3 && "-force".startsWith(option))) {
      force = true;
      continue;
    }
    if (REMOVE_ITEM_PATH_OPTIONS[option]) {
      if (index + 1 < args.length) targets.push(args[(index += 1)]);
      continue;
    }
    if (REMOVE_ITEM_OPTIONS_WITH_VALUE[option]) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) targets.push(value);
  }

  const broadTarget = targets.some((target) =>
    target
      .split(",")
      .map((part) => part.trim())
      .some(isBroadPath),
  );
  return recursive && force && broadTarget ? REASONS.broadRemove : undefined;
}

function stripSqlLiteralsAndComments(sql: string): string {
  let result = "";
  let state: "code" | "single" | "double" | "bracket" | "backtick" | "line" | "block" =
    "code";

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (state === "line") {
      if (character === "\n") {
        result += "\n";
        state = "code";
      }
      continue;
    }

    if (state === "block") {
      if (character === "*" && next === "/") {
        result += " ";
        state = "code";
        index += 1;
      }
      continue;
    }

    if (state !== "code") {
      const closer = state === "single" ? "'" : state === "double" ? '"' : state === "bracket" ? "]" : "`";
      if (character === closer) {
        if ((state === "single" || state === "double") && next === closer) {
          index += 1;
        } else {
          result += " ";
          state = "code";
        }
      }
      continue;
    }

    if (character === "-" && next === "-") {
      state = "line";
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      state = "block";
      index += 1;
      continue;
    }
    if (character === "'") state = "single";
    else if (character === '"') state = "double";
    else if (character === "[") state = "bracket";
    else if (character === "`") state = "backtick";
    else result += character;
  }

  return result;
}

function containsDestructiveSql(sql: string): boolean {
  const executableSql = stripSqlLiteralsAndComments(sql);
  return /(?:^|[;\r\n])\s*(?:drop|truncate)\b/i.test(executableSql);
}

function queryOptionValues(
  args: string[],
  shortOptions: string[],
  longOptions: string[],
): string[] {
  const queries: string[] = [];
  const normalizedShort = shortOptions.map((option) => option.toLowerCase());
  const normalizedLong = longOptions.map((option) => option.toLowerCase());

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    const lower = value.toLowerCase();

    if (normalizedShort.includes(lower) || normalizedLong.includes(lower)) {
      if (index + 1 < args.length) queries.push(args[(index += 1)]);
      continue;
    }

    const long = normalizedLong.find((option) => lower.startsWith(`${option}=`));
    if (long) {
      queries.push(value.slice(long.length + 1));
      continue;
    }

    const short = normalizedShort.find(
      (option) => lower.startsWith(option) && value.length > option.length,
    );
    if (short) queries.push(value.slice(short.length));
  }

  return queries;
}

function directDatabaseQueries(name: string, args: string[]): string[] {
  if (name === "sqlcmd") return queryOptionValues(args, ["-q"], []);
  if (name === "psql") return queryOptionValues(args, ["-c"], ["--command"]);
  if (name === "mysql" || name === "mariadb") {
    return queryOptionValues(args, ["-e"], ["--execute"]);
  }
  if (name === "invoke-sqlcmd") {
    return queryOptionValues(args, [], ["-query"]);
  }
  if (name === "sqlite3" || name === "duckdb") {
    const commandQueries = queryOptionValues(args, ["-cmd"], []);
    const positionals = positionalArguments(args, SQLITE_OPTIONS_WITH_VALUE);
    return positionals.length > 1
      ? [...commandQueries, positionals.slice(1).join(" ")]
      : commandQueries;
  }
  return [];
}

function pipelineText(segment: ShellSegment | undefined): string | undefined {
  if (!segment || segment.tokens.length === 0) return undefined;
  const invocation = resolveInvocation(segment.tokens);
  if (!invocation) return undefined;

  if (segment.tokens.length === 1 && segment.tokens[0].quoted) {
    return segment.tokens[0].value;
  }

  const args = segment.tokens.slice(invocation.index + 1).map((token) => token.value);
  if (invocation.name === "echo" || invocation.name === "write-output") {
    return args.filter((value) => value !== "-n").join(" ");
  }
  if (invocation.name === "printf") {
    return (args.length > 1 ? args.slice(1) : args).join(" ");
  }
  return undefined;
}

function matchDatabase(
  tokens: ShellToken[],
  invocation: Invocation,
  previousSegment: ShellSegment | undefined,
  separatorBefore: Separator | undefined,
): string | undefined {
  if (!DB_CLIENTS[invocation.name]) return undefined;

  const args = tokens.slice(invocation.index + 1).map((token) => token.value);
  const queries = directDatabaseQueries(invocation.name, args);
  if (queries.some(containsDestructiveSql)) return REASONS.database;

  if (separatorBefore === "|") {
    const pipedText = pipelineText(previousSegment);
    if (pipedText && containsDestructiveSql(pipedText)) return REASONS.database;
  }

  return undefined;
}

function isDeployScriptName(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (basename === "deploy" || basename === "release") return true;
  return /^(?:deploy|release)(?:[-_](?:canary|preview|prod|production|staging))?\.(?:bat|cmd|cjs|js|mjs|ps1|py|sh|ts)$/.test(
    basename,
  );
}

function isDeployScriptLabel(value: string): boolean {
  return /^(?:pre|post)?(?:deploy|release)(?:$|[:_-])/i.test(value);
}

function matchDeployment(tokens: ShellToken[], invocation: Invocation): string | undefined {
  const args = tokens.slice(invocation.index + 1).map((token) => token.value);
  const positionals = positionalArguments(args);

  if (invocation.name === "wrangler" && positionals[0]?.toLowerCase() === "deploy") {
    return REASONS.deploy;
  }

  if (PACKAGE_EXECUTORS[invocation.name]) {
    const toolIndex = positionals.findIndex((value) => commandName(value) === "wrangler");
    if (toolIndex >= 0 && positionals[toolIndex + 1]?.toLowerCase() === "deploy") {
      return REASONS.deploy;
    }
  }

  if (PACKAGE_MANAGERS[invocation.name]) {
    const action = positionals[0]?.toLowerCase();
    if (action === "publish" || (action === "npm" && positionals[1]?.toLowerCase() === "publish")) {
      return REASONS.deploy;
    }

    if ((action === "run" || action === "run-script") && isDeployScriptLabel(positionals[1] ?? "")) {
      return REASONS.deploy;
    }

    if (invocation.name === "yarn" && action && isDeployScriptLabel(action)) {
      return REASONS.deploy;
    }

    if (action === "dlx" || action === "exec") {
      const toolIndex = positionals.findIndex((value) => commandName(value) === "wrangler");
      if (toolIndex >= 0 && positionals[toolIndex + 1]?.toLowerCase() === "deploy") {
        return REASONS.deploy;
      }
    }
  }

  const action = positionals[0]?.toLowerCase();
  if (
    ((invocation.name === "cargo" ||
      invocation.name === "deno" ||
      invocation.name === "poetry" ||
      invocation.name === "uv") &&
      action === "publish") ||
    (invocation.name === "twine" && action === "upload") ||
    (invocation.name === "gem" && action === "push") ||
    (invocation.name === "dotnet" &&
      action === "nuget" &&
      positionals[1]?.toLowerCase() === "push")
  ) {
    return REASONS.deploy;
  }

  if (invocation.name === "gh" && action === "release") {
    const releaseAction = positionals[1]?.toLowerCase();
    if (releaseAction && GH_RELEASE_MUTATIONS[releaseAction]) return REASONS.deploy;
  }

  if (DEPLOY_TARGET_RUNNERS[invocation.name] && positionals.some(isDeployScriptLabel)) {
    return REASONS.deploy;
  }

  if (isDeployScriptName(tokens[invocation.index].value)) return REASONS.deploy;

  if (SCRIPT_INTERPRETERS[invocation.name]) {
    if (positionals[0] && isDeployScriptName(positionals[0])) return REASONS.deploy;
  }

  if (invocation.name === "powershell" || invocation.name === "pwsh") {
    const fileIndex = args.findIndex((value) => {
      const option = value.toLowerCase();
      return option === "-f" || option === "-file";
    });
    if (fileIndex >= 0 && args[fileIndex + 1] && isDeployScriptName(args[fileIndex + 1])) {
      return REASONS.deploy;
    }
  }

  return undefined;
}

function nestedCommand(tokens: ShellToken[], invocation: Invocation): string | undefined {
  if (invocation.name !== "powershell" && invocation.name !== "pwsh") return undefined;

  const args = tokens.slice(invocation.index + 1).map((token) => token.value);
  const commandIndex = args.findIndex(
    (value) => Boolean(POWERSHELL_COMMAND_OPTIONS[value.toLowerCase()]),
  );
  if (commandIndex < 0 || commandIndex + 1 >= args.length) return undefined;
  return args.slice(commandIndex + 1).join(" ");
}

function matchBlockedCommandInternal(
  command: string,
  depth: number,
  context?: GuardContext,
): string | undefined {
  const segments = tokenizeShell(command);

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const invocation = resolveInvocation(segment.tokens);
    if (!invocation) continue;

    const gitReason = matchGit(segment.tokens, invocation, context);
    if (gitReason) return gitReason;

    const args = segment.tokens.slice(invocation.index + 1).map((token) => token.value);
    if (invocation.name === "rm") {
      const reason = matchRm(args);
      if (reason) return reason;
    }
    if (
      invocation.name === "remove-item" ||
      invocation.name === "del" ||
      invocation.name === "erase" ||
      invocation.name === "rd" ||
      invocation.name === "ri" ||
      invocation.name === "rm" ||
      invocation.name === "rmdir"
    ) {
      const reason = matchRemoveItem(args);
      if (reason) return reason;
    }

    const databaseReason = matchDatabase(
      segment.tokens,
      invocation,
      segments[index - 1],
      segment.separatorBefore,
    );
    if (databaseReason) return databaseReason;

    const deployReason = matchDeployment(segment.tokens, invocation);
    if (deployReason) return deployReason;

    if (depth < 3) {
      const nested = nestedCommand(segment.tokens, invocation);
      if (nested) {
        const nestedReason = matchBlockedCommandInternal(nested, depth + 1, context);
        if (nestedReason) return nestedReason;
      }
    }
  }

  return undefined;
}

export function matchBlockedCommand(
  command: string,
  context?: GuardContext,
): string | undefined {
  const directReason = matchBlockedCommandInternal(command, 0, context);
  if (directReason) return directReason;

  const posixUnescaped = command.replace(/\\([^\r\n])/g, "$1");
  if (posixUnescaped === command) return undefined;
  return matchBlockedCommandInternal(posixUnescaped, 0, context);
}
