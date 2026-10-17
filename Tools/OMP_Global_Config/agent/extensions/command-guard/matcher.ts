import { isAbsolute, resolve } from "node:path";

export interface GuardContext {
  /** bash tool_call이 지정한 cwd. 없으면 세션 cwd. */
  cwd?: string;
  /** 주어진 디렉터리가 세션 저장소와 같은 git 저장소인지. 미제공이면 차단. */
  isSessionRepository?: (dir: string) => boolean;
  /**
   * 주어진 디렉터리를 하네스가 Windows `git.exe`로 다루는지(WSL의 `/mnt/<드라이브>` 저장소). 미제공이면 판정하지 않는다.
   */
  usesWindowsGit?: (dir: string) => boolean;
}

type Separator = ";" | "&&" | "||" | "|" | "&" | "\n";

interface ShellToken {
  value: string;
  quoted: boolean;
}

interface Heredoc {
  delimiter: string;
  /** 구분자에 따옴표·역슬래시가 있으면 본문은 확장 없이 그대로다. */
  quoted: boolean;
  stripTabs: boolean;
  /** `<<` 뒤 줄바꿈부터 구분자 줄 앞까지. 줄바꿈을 만나기 전에는 비어 있다. */
  body: string;
}

interface ShellSegment {
  tokens: ShellToken[];
  separatorBefore?: Separator;
  /** 괄호 subshell 깊이. `cd`의 효과는 같은 깊이 이하로만 이어진다. */
  depth: number;
  /** 따옴표 밖·큰따옴표 안 `$(…)`·백틱 명령 치환의 본문(작은따옴표 안과 `\$`는 제외). */
  substitutions: string[];
  /** 이 세그먼트의 stdin으로 들어가는 heredoc. */
  heredocs: Heredoc[];
  /** `<<<` here-string 값. */
  hereStrings: string[];
}

interface TokenizedShell {
  segments: ShellSegment[];
  /** 실행 세그먼트에 붙지 않은 치환 본문(`> $(…)`처럼 리다이렉션 대상 등). */
  loose: string[];
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

/** 저장소 없이 도는 git 하위 명령. 어느 git으로 돌려도 index를 건드리지 않는다. */
const REPOSITORY_FREE_GIT_COMMANDS: StringLookup = {
  help: true,
  version: true,
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
  "!": true,
  "&": true,
  "{": true,
  "}": true,
  do: true,
  elif: true,
  else: true,
  if: true,
  then: true,
  until: true,
  while: true,
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

const POWERSHELL_OPTIONS_WITH_VALUE: StringLookup = {
  "-configurationname": true,
  "-ep": true,
  "-executionpolicy": true,
  "-inputformat": true,
  "-outputformat": true,
  "-settingsfile": true,
  "-version": true,
  "-windowstyle": true,
  "-wd": true,
  "-workingdirectory": true,
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

interface WrapperSpec {
  optionsWithValue: StringLookup;
  /** 옵션 뒤, 감싸는 명령 앞에 오는 위치 인자 수(`taskset <mask>`, `flock <lockfile>`). */
  positionals: number;
}

/** 뒤따르는 명령을 그대로 실행하는 래퍼. 옵션 형태는 각 명령의 실제 CLI를 따른다. */
const EXEC_WRAPPERS: Readonly<Record<string, WrapperSpec>> = {
  exec: { optionsWithValue: { "-a": true }, positionals: 0 },
  nice: { optionsWithValue: { "-n": true, "--adjustment": true }, positionals: 0 },
  setsid: { optionsWithValue: {}, positionals: 0 },
  ionice: {
    optionsWithValue: { "-c": true, "--class": true, "-n": true, "--classdata": true },
    positionals: 0,
  },
  stdbuf: {
    optionsWithValue: { "-i": true, "-o": true, "-e": true, "--input": true, "--output": true, "--error": true },
    positionals: 0,
  },
  taskset: { optionsWithValue: {}, positionals: 1 },
  chrt: { optionsWithValue: {}, positionals: 1 },
  flock: {
    optionsWithValue: { "-w": true, "--wait": true, "--timeout": true, "-E": true, "--conflict-exit-code": true },
    positionals: 1,
  },
  xargs: {
    optionsWithValue: {
      "-a": true, "--arg-file": true, "-d": true, "--delimiter": true, "-E": true, "--eof": true, "-I": true,
      "-L": true, "--max-lines": true, "-n": true, "--max-args": true, "-P": true, "--max-procs": true,
      "-s": true, "--max-chars": true,
    },
    positionals: 0,
  },
  doas: { optionsWithValue: { "-u": true, "-C": true }, positionals: 0 },
};

/** 명령 문자열을 `-c`로 받아 셸로 실행하는 인터프리터. */
const SHELLS: StringLookup = {
  ash: true,
  bash: true,
  dash: true,
  fish: true,
  ksh: true,
  mksh: true,
  sh: true,
  zsh: true,
};

/** 최대 중첩 깊이(`bash -c`·`$(…)`·heredoc 본문). 넘으면 더 파고들지 않는다. */
const MAX_NESTING = 5;

const WRANGLER_OPTIONS_WITH_VALUE: StringLookup = {
  ...CLI_OPTIONS_WITH_VALUE,
  "--env": true,
  "-e": true,
};

/** 패키지 러너가 도구 이름 앞에서 값을 받는 옵션. */
const PACKAGE_RUNNER_OPTIONS_WITH_VALUE: StringLookup = {
  ...CLI_OPTIONS_WITH_VALUE,
  "--package": true,
  "-p": true,
};

/** 패키지 매니저가 도구 이름 앞에 두는 실행 하위 명령(`pnpm dlx wrangler`, `bun x wrangler`). */
const PACKAGE_MANAGER_EXEC_LEADERS: StringLookup = {
  dlx: true,
  exec: true,
  run: true,
  "run-script": true,
  x: true,
};

interface ShortQueryOptions {
  /** 뒤따르는 SQL을 값으로 받는 짧은 옵션 글자. */
  query: string;
  /** 값을 받지 않는 짧은 옵션 글자. 묶음(`-Atc`)을 앞에서부터 풀 때 건너뛴다. */
  withoutValue: string;
  /** 값을 받는 다른 옵션 글자(`-d db`, `-U user`). */
  withValue: string;
  /** 값이 같은 낱말에만 붙는 옵션 글자(mysql `-p<password>`). 뒤 글자는 옵션이 아니라 값이다. */
  attachedOnly: string;
}

const PSQL_SHORT_OPTIONS: ShortQueryOptions = {
  query: "c",
  withoutValue: "AabeEHlnqsStVwWxXz01?",
  withValue: "dfFhLopPRTUv",
  attachedOnly: "",
};

const MYSQL_SHORT_OPTIONS: ShortQueryOptions = {
  query: "e",
  withoutValue: "AaBbCcEfHIiLnNoqrstTUvVwWXj?",
  withValue: "DhPuSO",
  attachedOnly: "p",
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
  gitDiscard:
    "작업 트리나 stash의 변경을 되돌릴 수 없게 버리는 git checkout·restore·switch·stash·worktree 명령은 정책상 차단됩니다. " +
    "변경을 남기려면 먼저 commit하거나 git stash push로 보관하세요.",
  broadRemove:
    "현재 작업 트리나 루트 경로를 광범위하게 삭제하는 명령은 정책상 차단됩니다.",
  database:
    "실제 데이터베이스 클라이언트로 DROP/TRUNCATE를 실행하는 명령은 정책상 차단됩니다.",
  deploy:
    "배포·게시·릴리스 작업을 실행하는 명령은 정책상 차단됩니다.",
  linuxGitOnWindowsDrive:
    "이 저장소는 Windows 드라이브(/mnt/<드라이브>)에 있어 하네스·앱·git_finalize가 Windows git.exe로 다룹니다. " +
    "Linux git을 섞어 쓰면 index의 파일 정보가 서로 맞지 않아 추적 파일 전체를 다시 확인하고 index를 다시 씁니다. " +
    "큰 저장소에서는 수 분이 걸려 시간 제한에 끊기고 index.lock이 남습니다(--no-optional-locks로도 git diff의 갱신은 막히지 않습니다). " +
    "같은 명령을 git.exe로 실행하세요. 예: cd <저장소 안 폴더> && git.exe status. -C에는 \"$(wslpath -w <경로>)\"로 바꾼 경로를 넘깁니다.",
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

interface Substitution {
  inner: string;
  /** 치환이 끝난 다음 위치. */
  end: number;
}

function readBacktickSubstitution(text: string, start: number): Substitution {
  let inner = "";
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length && /[`\\$]/.test(text[index + 1])) {
      inner += text[index + 1];
      index += 2;
      continue;
    }
    if (character === "`") return { inner, end: index + 1 };
    inner += character;
    index += 1;
  }
  return { inner, end: text.length };
}

function skipDoubleQuoted(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") index += 2;
    else if (character === '"') return index + 1;
    else if (character === "$" && text[index + 1] === "(") index = readCommandSubstitution(text, index).end;
    else if (character === "`") index = readBacktickSubstitution(text, index).end;
    else index += 1;
  }
  return text.length;
}

/** `text[start]`가 `$`이고 다음이 `(`일 때 짝이 맞는 `)`까지 읽는다. 따옴표·이스케이프·중첩 치환을 따라간다. */
function readCommandSubstitution(text: string, start: number): Substitution {
  let depth = 1;
  let index = start + 2;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "'") {
      const close = text.indexOf("'", index + 1);
      index = close < 0 ? text.length : close + 1;
      continue;
    }
    if (character === '"') {
      index = skipDoubleQuoted(text, index + 1);
      continue;
    }
    if (character === "`") {
      index = readBacktickSubstitution(text, index).end;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(start + 2, index), end: index + 1 };
    }
    index += 1;
  }
  return { inner: text.slice(start + 2), end: text.length };
}

/** 따옴표 없는 heredoc 본문에서 셸이 실행하는 `$(…)`·백틱 치환만 꺼낸다. 본문의 따옴표는 그냥 글자다. */
function heredocExpansions(body: string): string[] {
  const scripts: string[] = [];
  let index = 0;
  while (index < body.length) {
    const character = body[index];
    if (character === "\\") {
      index += 2;
    } else if (character === "$" && body[index + 1] === "(") {
      const substitution = readCommandSubstitution(body, index);
      scripts.push(substitution.inner);
      index = substitution.end;
    } else if (character === "`") {
      const substitution = readBacktickSubstitution(body, index);
      scripts.push(substitution.inner);
      index = substitution.end;
    } else {
      index += 1;
    }
  }
  return scripts;
}

/**
 * heredoc 구분자 낱말을 읽는다. 따옴표(`'EOF'`·`"EOF"`·빈 `''`)나 역슬래시(`\EOF`, `E\OF`)가 한 글자라도 있으면 본문은
 * 확장 없이 그대로다. 구분자 값은 따옴표·역슬래시를 벗긴 글자이고, 빈 따옴표는 빈 구분자(빈 줄이 끝)다.
 */
function scanHeredocWord(command: string, start: number): { delimiter: string; quoted: boolean; end: number } {
  let index = start;
  let delimiter = "";
  let quoted = false;
  while (index < command.length) {
    const character = command[index];
    if (character === "'" || character === '"') {
      quoted = true;
      const close = command.indexOf(character, index + 1);
      const end = close < 0 ? command.length : close;
      delimiter += command.slice(index + 1, end);
      index = close < 0 ? command.length : close + 1;
      continue;
    }
    if (character === "\\" && index + 1 < command.length && command[index + 1] !== "\n") {
      quoted = true;
      delimiter += command[index + 1];
      index += 2;
      continue;
    }
    if (/[\s;&|<>()]/.test(character)) break;
    delimiter += character;
    index += 1;
  }
  return { delimiter, quoted, end: index };
}

/** `<<` 바로 뒤(`-`·공백 다음)의 구분자 낱말이 시작하는 위치와 `<<-` 여부. */
function heredocWordStart(command: string, start: number): { index: number; stripTabs: boolean } {
  let index = start;
  const stripTabs = command[index] === "-";
  if (stripTabs) index += 1;
  while (command[index] === " " || command[index] === "\t") index += 1;
  return { index, stripTabs };
}

/** `<<` 바로 뒤의 구분자 낱말을 읽는다. 낱말이 없으면 undefined. */
function readHeredocDelimiter(command: string, start: number): { heredoc: Heredoc; end: number } | undefined {
  const { index, stripTabs } = heredocWordStart(command, start);
  const word = scanHeredocWord(command, index);
  if (word.end === index) return undefined;
  return { heredoc: { delimiter: word.delimiter, quoted: word.quoted, stripTabs, body: "" }, end: word.end };
}

/** `position`(줄 시작)부터 대기 중인 heredoc 본문을 차례로 읽고 다음 위치를 돌려준다. 구분자 줄이 없으면 끝까지가 본문이다. */
function readHeredocBodies(command: string, position: number, pending: Heredoc[]): number {
  let index = position;
  for (const heredoc of pending) {
    const lines: string[] = [];
    while (index < command.length) {
      const lineEnd = command.indexOf("\n", index);
      const raw = command.slice(index, lineEnd < 0 ? command.length : lineEnd);
      index = lineEnd < 0 ? command.length : lineEnd + 1;
      const line = raw.replace(/\r$/, "");
      if ((heredoc.stripTabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
      lines.push(raw);
    }
    heredoc.body = lines.join("\n");
  }
  return index;
}

function tokenizeShell(command: string): TokenizedShell {
  const segments: ShellSegment[] = [];
  const loose: string[] = [];
  const looseHeredocs: Heredoc[] = [];
  let tokens: ShellToken[] = [];
  let substitutions: string[] = [];
  let heredocs: Heredoc[] = [];
  let pendingBodies: Heredoc[] = [];
  let value = "";
  let tokenStarted = false;
  let tokenQuoted = false;
  let quote: "'" | '"' | undefined;
  let separatorBefore: Separator | undefined;
  let depth = 0;

  const endToken = (): void => {
    if (!tokenStarted) return;
    tokens.push({ value, quoted: tokenQuoted });
    value = "";
    tokenStarted = false;
    tokenQuoted = false;
  };

  const hereStrings = (): string[] => {
    const values: string[] = [];
    tokens.forEach((token, position) => {
      if (!token.quoted && /^\d*<<<$/.test(token.value) && tokens[position + 1]) {
        values.push(tokens[position + 1].value);
      }
    });
    return values;
  };

  const endSegment = (separator?: Separator): void => {
    endToken();
    let pushed = false;
    if (tokens.length > 0) {
      const executableTokens = stripRedirections(tokens);
      if (executableTokens.length > 0) {
        segments.push({
          tokens: executableTokens,
          separatorBefore,
          depth,
          substitutions,
          heredocs,
          hereStrings: hereStrings(),
        });
        pushed = true;
      }
    }
    if (!pushed) {
      loose.push(...substitutions);
      looseHeredocs.push(...heredocs);
    }
    tokens = [];
    substitutions = [];
    heredocs = [];
    if (separator !== undefined && (pushed || separatorBefore === undefined)) separatorBefore = separator;
  };

  /** 단어 안의 치환을 단어 값에 그대로 두고 본문만 따로 모은다. 읽은 마지막 위치를 돌려준다. */
  const takeSubstitution = (index: number): number => {
    const substitution =
      command[index] === "`" ? readBacktickSubstitution(command, index) : readCommandSubstitution(command, index);
    substitutions.push(substitution.inner);
    value += command.slice(index, substitution.end);
    tokenStarted = true;
    return substitution.end - 1;
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

      if (quote === '"' && (character === "`" || (character === "$" && next === "("))) {
        index = takeSubstitution(index);
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

    if (character === "`" || (character === "$" && next === "(")) {
      index = takeSubstitution(index);
      continue;
    }

    if (character === "\\" && next !== undefined) {
      if (/['";|&#\\()<>]/.test(next)) {
        value += next;
        tokenStarted = true;
        index += 1;
      } else if (next === "$" || next === "`") {
        value += character + next;
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
      if (operator === "<<") {
        const delimiter = readHeredocDelimiter(command, index + 1);
        if (delimiter) {
          index = delimiter.end - 1;
          tokens.push({ value: delimiter.heredoc.delimiter, quoted: true });
          heredocs.push(delimiter.heredoc);
          pendingBodies.push(delimiter.heredoc);
        }
      }
      continue;
    }

    if (character === "(" || character === ")") {
      endSegment(";");
      depth = character === "(" ? depth + 1 : Math.max(0, depth - 1);
      continue;
    }


    if (character === "\n") {
      endSegment("\n");
      if (pendingBodies.length > 0) {
        index = readHeredocBodies(command, index + 1, pendingBodies) - 1;
        pendingBodies = [];
      }
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

  endSegment();
  for (const heredoc of looseHeredocs) {
    if (!heredoc.quoted) loose.push(...heredocExpansions(heredoc.body));
  }
  return { segments, loose };
}

function commandName(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  return basename.replace(/\.(?:exe|cmd|bat)$/i, "");
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function skipWrapperArguments(tokens: ShellToken[], start: number, spec: WrapperSpec): number {
  let index = start;
  while (index < tokens.length) {
    const value = tokens[index].value;
    if (value === "--") {
      index += 1;
      break;
    }
    if (!value.startsWith("-") || value === "-") break;
    const equalsIndex = value.indexOf("=");
    const option = equalsIndex >= 0 ? value.slice(0, equalsIndex) : value;
    index += equalsIndex < 0 && spec.optionsWithValue[option] ? 2 : 1;
  }
  return index + spec.positionals;
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

    const wrapper = Object.hasOwn(EXEC_WRAPPERS, name) ? EXEC_WRAPPERS[name] : undefined;
    if (wrapper) {
      const wrapperIndex = index;
      index = skipWrapperArguments(tokens, index + 1, wrapper);
      // `flock <lockfile> -c '<명령>'`은 감싼 명령이 따로 없고 문자열을 셸이 실행한다. 그 문자열은 호출한 쪽이 푼다.
      if (name === "flock" && /^(?:-c|--command)$/.test(tokens[index]?.value ?? "")) {
        return { index: wrapperIndex, name };
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

/** git 하위 명령별로 짧은 옵션이 값을 받는 글자. 그 글자 뒤는 값이지 옵션 묶음이 아니다(`-enode_modules`, `-sSTABLE`). */
const GIT_SHORT_VALUE_OPTIONS: Readonly<Record<string, string>> = {
  branch: "u",
  checkout: "bBU",
  clean: "e",
  commit: "mFCct",
  push: "o",
  restore: "sU",
  switch: "cC",
  tag: "mFu",
};

/** git 하위 명령별로 `--name value`처럼 다음 낱말을 값으로 받는 긴 옵션(`--name=value`는 값이 붙어 있어 해당 없음). */
const GIT_LONG_VALUE_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  add: ["--pathspec-from-file"],
  branch: ["--format", "--points-at", "--set-upstream-to", "--sort"],
  checkout: ["--conflict", "--inter-hunk-context", "--orphan", "--pathspec-from-file", "--unified"],
  clean: ["--exclude"],
  commit: [
    "--author", "--cleanup", "--date", "--file", "--fixup", "--message", "--pathspec-from-file",
    "--reedit-message", "--reuse-message", "--squash", "--template", "--trailer",
  ],
  push: ["--exec", "--push-option", "--receive-pack", "--repo"],
  restore: ["--conflict", "--inter-hunk-context", "--pathspec-from-file", "--source", "--unified"],
  rm: ["--pathspec-from-file"],
  switch: ["--conflict", "--create", "--force-create", "--orphan"],
  tag: ["--cleanup", "--file", "--format", "--local-user", "--message", "--points-at", "--sort"],
};

/**
 * 하위 명령 인자에서 옵션이 받는 값을 걷어 낸다. 값은 옵션처럼 보여도(`--exclude -n`, `-m --dry-run`, `-sSTABLE`의 `S`) 옵션이
 * 아니므로, 이 뒤의 `shortFlags`·`hasLongOption`이 값을 플래그로 읽지 못하게 한다. 값을 받는 짧은 옵션 글자 앞까지만 남기고,
 * `--` 뒤는 그대로 둔다. 긴 옵션은 git처럼 모호하지 않은 줄임말(`--exc`)도 같은 옵션으로 본다.
 */
function withoutOptionValues(subcommand: string, args: string[]): string[] {
  const shortValues = Object.hasOwn(GIT_SHORT_VALUE_OPTIONS, subcommand) ? GIT_SHORT_VALUE_OPTIONS[subcommand] : "";
  const longValues = Object.hasOwn(GIT_LONG_VALUE_OPTIONS, subcommand) ? GIT_LONG_VALUE_OPTIONS[subcommand] : [];
  const kept: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") return [...kept, ...args.slice(index)];
    if (value.startsWith("--")) {
      kept.push(value);
      const takesNext =
        !value.includes("=") && longValues.some((name) => name === value || (value.length >= 4 && name.startsWith(value)));
      if (takesNext) index += 1;
      continue;
    }
    if (/^-[^-]/.test(value)) {
      const cut = [...value.slice(1)].findIndex((letter) => shortValues.includes(letter));
      if (cut < 0) {
        kept.push(value);
        continue;
      }
      if (cut > 0) kept.push(value.slice(0, cut + 1));
      if (cut === value.length - 2) index += 1;
      continue;
    }
    kept.push(value);
  }
  return kept;
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
  const subcommand = values[index].toLowerCase();
  return {
    subcommand,
    args: withoutOptionValues(subcommand, values.slice(index + 1)),
    globalArgs: values.slice(0, index),
  };
}

// `~`는 단어 맨 앞이나 assignment 꼴의 `=`·`:` 뒤에서만 셸이 확장한다. 경로 중간의 literal
// `~`(8.3 짧은 이름 `RUNNER~1` 등)는 확장이 아니므로 저장소 판정으로 넘긴다.
function hasShellExpansion(value: string): boolean {
  return /[$%`*?]|(?:^|[=:])~/.test(value);
}

/**
 * git이 실제로 여는 위치. `cwd`가 null이면(앞선 cd를 확정할 수 없음) 절대경로 `-C`·`--git-dir`만으로 정해질 때만
 * 값을 돌려주고, 그 밖에는 undefined다. undefined `cwd`는 현재 프로세스 위치(".")다.
 */
function gitTargetDirectory(
  git: GitInvocation,
  cwd: string | null | undefined,
): string | undefined {
  let directory = cwd === null ? undefined : resolve(cwd ?? ".");
  let gitDirectoryPath: string | undefined;

  for (let index = 0; index < git.globalArgs.length; index += 1) {
    const value = git.globalArgs[index];
    if (value === "--") break;

    if (value === "-C" || value === "--git-dir") {
      const path = git.globalArgs[index + 1];
      if (path === undefined || hasShellExpansion(path)) return undefined;
      if (value === "-C") {
        directory = isAbsolute(path) ? resolve(path) : directory === undefined ? undefined : resolve(directory, path);
      } else gitDirectoryPath = path;
      index += 1;
      continue;
    }

    if (value.startsWith("-C") && value.length > 2) {
      const path = value.slice(2);
      if (hasShellExpansion(path)) return undefined;
      directory = isAbsolute(path) ? resolve(path) : directory === undefined ? undefined : resolve(directory, path);
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

  if (gitDirectoryPath === undefined) return directory;
  if (isAbsolute(gitDirectoryPath)) return resolve(gitDirectoryPath);
  return directory === undefined ? undefined : resolve(directory, gitDirectoryPath);
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

/** `git checkout .`·`git restore :/`처럼 작업 트리 전체를 가리키는 pathspec. */
function isWorktreeWidePathspec(value: string): boolean {
  return isBroadPath(value) || /^:(?:\/\*?|\(top\)[.*]?)$/i.test(value.trim());
}

/**
 * 작업 트리·stash의 변경을 되돌릴 수 없게 버리는 git 명령. 파일 하나를 지정한 복원, 브랜치 전환, `restore --staged`처럼
 * index만 바꾸는 명령, 새 stash 저장·적용은 막지 않는다.
 */
function matchWorkDiscard(git: GitInvocation): string | undefined {
  const flags = shortFlags(git.args);
  const force = flags.has("f") || hasLongOption(git.args, ["--force"], 3);
  const action = git.args.find((value) => !value.startsWith("-"))?.toLowerCase();

  switch (git.subcommand) {
    case "checkout":
      return force || positionalArguments(git.args, {}).some(isWorktreeWidePathspec)
        ? REASONS.gitDiscard
        : undefined;
    case "switch":
      return force || hasLongOption(git.args, ["--discard-changes"], 4) ? REASONS.gitDiscard : undefined;
    case "restore": {
      const staged = flags.has("S") || hasLongOption(git.args, ["--staged"], 4);
      const worktree = flags.has("W") || hasLongOption(git.args, ["--worktree"], 4);
      const wide = positionalArguments(git.args, {}).some(isWorktreeWidePathspec);
      return wide && (worktree || !staged) ? REASONS.gitDiscard : undefined;
    }
    case "stash":
      return action === "clear" || action === "drop" ? REASONS.gitDiscard : undefined;
    case "worktree":
      return action === "remove" && force ? REASONS.gitDiscard : undefined;
    default:
      return undefined;
  }
}

function matchGit(
  tokens: ShellToken[],
  invocation: Invocation,
  context?: GuardContext,
): string | undefined {
  const git = parseGitInvocation(tokens, invocation);
  if (!git) return undefined;

  if (FINALIZER_OWNED_GIT_COMMANDS[git.subcommand]) {
    // 미리보기는 index·ref·원격을 바꾸지 않는다. commit의 `-n`은 `--no-verify`라 commit은 long option만 본다.
    const dryRun =
      (git.subcommand === "add" || git.subcommand === "commit" || git.subcommand === "push") &&
      (hasLongOption(git.args, ["--dry-run"]) ||
        (git.subcommand !== "commit" && shortFlags(git.args).has("n")));
    if (dryRun) return undefined;
    if (!context?.isSessionRepository) return REASONS.gitFinalize;
    const targetDirectory = gitTargetDirectory(git, context.cwd);
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
    // `-n`·`--dry-run`은 지울 목록만 보여 주므로 `-f`가 함께 있어도 아무것도 지우지 않는다.
    const dryRun = flags.has("n") || hasLongOption(git.args, ["--dry-run"], 3);
    if (force && !dryRun) return REASONS.gitClean;
  }

  const discardReason = matchWorkDiscard(git);
  if (discardReason) return discardReason;

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

/**
 * WSL에서 하네스가 Windows `git.exe`로 다루는 저장소(`/mnt/<드라이브>`)를 Linux git으로 여는 호출을 막는다.
 * 두 git은 index에 적는 stat 정보가 달라, 번갈아 쓰면 바뀐 쪽이 추적 파일 전체를 다시 확인하고 index를 통째로 다시 쓴다.
 * 2026-10-12 SJF 저장소(추적 217,935개)에서 Linux `git --no-optional-locks diff`가 그 갱신 도중 bash 30초 제한에 끊겨
 * `index.lock`을 남겼다. `--no-optional-locks`는 diff의 index 갱신을 막지 못한다(git 2.43 재현).
 * `windowsShell`은 Windows PowerShell(`*.exe`) 안의 호출이라 그 안의 `git`이 이미 Windows git이라는 뜻이다.
 * 앞선 cd를 확정할 수 없어도(`cwd` null) 절대경로 `-C`·`--git-dir`이면 판정하고, 그 밖에 위치를 모르면 판정하지 않는다.
 */
function matchLinuxGitOnWindowsDrive(
  tokens: ShellToken[],
  invocation: Invocation,
  context: GuardContext | undefined,
  cwd: string | null | undefined,
  windowsShell: boolean,
): string | undefined {
  if (windowsShell || !context?.usesWindowsGit) return undefined;
  // commandName은 `.exe`를 떼므로 원래 토큰으로 Windows git을 구분한다.
  if (/\.exe$/i.test(tokens[invocation.index].value)) return undefined;
  const git = parseGitInvocation(tokens, invocation);
  if (!git || REPOSITORY_FREE_GIT_COMMANDS[git.subcommand]) return undefined;
  const directory = gitTargetDirectory(git, cwd);
  return directory !== undefined && context.usesWindowsGit(directory)
    ? REASONS.linuxGitOnWindowsDrive
    : undefined;
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

/**
 * 짧은 옵션 묶음(`psql -Atc`, `mysql -Nse`, `-1c"…"`)을 앞에서부터 풀어 SQL을 받는 옵션의 값을 모은다. 값을 받는 다른
 * 옵션을 만나면 그 묶음의 해석을 멈추고, 값이 따로 떨어져 있으면 그 값은 건너뛴다. 글자 구분은 대소문자를 지킨다.
 */
function shortOptionQueries(args: string[], options: ShortQueryOptions): string[] {
  const queries: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!/^-[^-]/.test(value)) continue;
    for (let position = 1; position < value.length; position += 1) {
      const flag = value[position];
      if (options.withoutValue.includes(flag)) continue;
      const attached = value.slice(position + 1);
      if (options.query.includes(flag)) {
        if (attached) queries.push(attached);
        else if (index + 1 < args.length) queries.push(args[(index += 1)]);
      } else if (options.withValue.includes(flag) && !attached) {
        index += 1;
      }
      break;
    }
  }
  return queries;
}

function directDatabaseQueries(name: string, args: string[]): string[] {
  if (name === "sqlcmd") return queryOptionValues(args, ["-q"], []);
  if (name === "psql") {
    return [...shortOptionQueries(args, PSQL_SHORT_OPTIONS), ...queryOptionValues(args, [], ["--command"])];
  }
  if (name === "mysql" || name === "mariadb") {
    return [...shortOptionQueries(args, MYSQL_SHORT_OPTIONS), ...queryOptionValues(args, [], ["--execute"])];
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

/** 세그먼트의 stdin으로 들어가는 heredoc 본문과 here-string 값. */
function stdinTexts(segment: ShellSegment): string[] {
  return [...segment.heredocs.map((heredoc) => heredoc.body), ...segment.hereStrings];
}

const PRINTF_ESCAPES: Readonly<Record<string, string>> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  '"': '"',
  "'": "'",
  a: "\x07",
  b: "\b",
  f: "\f",
  v: "\v",
  e: "\x1b",
  E: "\x1b",
};

/** 서식 문자열의 이스케이프(`\NNN`은 1~3자리 8진수, `\c`는 글자 그대로). 그룹: 1 단순, 2 `\x`, 3 `\u`, 4 `\U`, 5 8진수. */
const PRINTF_FORMAT_ESCAPE =
  /\\(?:([ntrabfveE\\"'])|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/y;
/** `%b` 인자의 이스케이프(`\0NNN`, `\c`는 이후 출력 전체를 끊는다). 그룹 6이 `\c`다. */
const PRINTF_ARGUMENT_ESCAPE =
  /\\(?:([ntrabfveE\\"'])|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(0[0-7]{0,3}|[1-7][0-7]{0,2})|(c))/y;
/** `%` 변환 명세. 그룹: 1 `%%`, 2 플래그, 3 너비, 4 정밀도, 5 변환 글자(`hh`·`l` 등 길이 수식자는 무시). */
const PRINTF_SPEC = /%(?:(%)|([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?(?:hh|h|ll|l|L|j|z|t)?([A-Za-z]))/y;
/** 너비·정밀도 상한. 스캔이 거대한 문자열을 만들지 못하게 한다. */
const PRINTF_MAX_WIDTH = 1024;

interface PrintfEscape {
  text: string;
  length: number;
  stop: boolean;
}

/** `text[index]`의 역슬래시 이스케이프를 읽는다. 알 수 없는 이스케이프(서식의 `\c`·`\q`)는 undefined라 글자 그대로 둔다. */
function readPrintfEscape(text: string, index: number, pattern: RegExp): PrintfEscape | undefined {
  pattern.lastIndex = index;
  const match = pattern.exec(text);
  if (!match) return undefined;
  const [whole, simple, hex, unicode, longUnicode, octal, cut] = match;
  if (cut !== undefined) return { text: "", length: whole.length, stop: true };
  let value: string;
  if (simple !== undefined) value = PRINTF_ESCAPES[simple];
  else if (hex !== undefined) value = String.fromCharCode(Number.parseInt(hex, 16));
  else if (octal !== undefined) value = String.fromCharCode(Number.parseInt(octal, 8) & 0xff);
  else {
    const code = Number.parseInt(unicode ?? longUnicode ?? "0", 16);
    value = code <= 0x10ffff ? String.fromCodePoint(code) : "\ufffd";
  }
  return { text: value, length: whole.length, stop: false };
}

/** `%b` 인자를 푼다. `\c`를 만나면 거기까지만 돌려주고 `stop`으로 이후 출력 전체를 끊는다. */
function expandPrintfArgument(value: string): { text: string; stop: boolean } {
  let text = "";
  let index = 0;
  while (index < value.length) {
    const escape = value[index] === "\\" ? readPrintfEscape(value, index, PRINTF_ARGUMENT_ESCAPE) : undefined;
    if (!escape) {
      text += value[index];
      index += 1;
      continue;
    }
    text += escape.text;
    if (escape.stop) return { text, stop: true };
    index += escape.length;
  }
  return { text, stop: false };
}

/** `%d` 류의 정수 인자. `'A`는 글자 코드, 앞의 숫자만 읽고 못 읽으면 0(printf는 오류를 내지만 0을 출력한다). */
function parsePrintfInteger(raw: string | undefined): bigint {
  const text = raw ?? "";
  const character = /^['"](.)/su.exec(text);
  if (character) return BigInt(character[1].codePointAt(0) ?? 0);
  const number = /^[-+]?(?:0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(text);
  if (!number) return BigInt(0);
  const negative = number[0].startsWith("-");
  const digits = number[0].replace(/^[-+]/, "");
  const magnitude = BigInt(/^0[0-7]+$/.test(digits) ? `0o${digits.slice(1)}` : digits);
  return negative ? -magnitude : magnitude;
}

interface PrintfConversion {
  text: string;
  numeric: boolean;
  stop: boolean;
}

/** 변환 글자 하나를 값에 적용한다(너비 채움은 호출자). 모르는 변환 글자는 undefined(printf는 오류로 멈춘다). */
function convertPrintfValue(
  letter: string,
  raw: string | undefined,
  flags: string,
  precision: number | undefined,
): PrintfConversion | undefined {
  const limit = (text: string): string => (precision === undefined ? text : Array.from(text).slice(0, precision).join(""));
  const sign = (negative: boolean): string => (negative ? "-" : flags.includes("+") ? "+" : flags.includes(" ") ? " " : "");
  if (letter === "s") return { text: limit(raw ?? ""), numeric: false, stop: false };
  if (letter === "c") return { text: Array.from(raw ?? "")[0] ?? "\0", numeric: false, stop: false };
  if (letter === "q") {
    const quoted = raw === undefined || raw === "" ? "''" : raw.replace(/[^A-Za-z0-9_@%+=:,./-]/g, "\\$&");
    return { text: limit(quoted), numeric: false, stop: false };
  }
  if (letter === "b") {
    const expanded = expandPrintfArgument(raw ?? "");
    return { text: limit(expanded.text), numeric: false, stop: expanded.stop };
  }
  if ("diuoxX".includes(letter)) {
    const value = parsePrintfInteger(raw);
    const signed = letter === "d" || letter === "i";
    const magnitude = signed ? (value < 0 ? -value : value) : BigInt.asUintN(64, value);
    const base = letter === "o" ? 8 : letter === "x" || letter === "X" ? 16 : 10;
    let digits = magnitude.toString(base);
    if (letter === "X") digits = digits.toUpperCase();
    if (precision === 0 && magnitude === BigInt(0)) digits = "";
    if (precision !== undefined) digits = digits.padStart(Math.min(precision, PRINTF_MAX_WIDTH), "0");
    let prefix = "";
    if (flags.includes("#") && magnitude !== BigInt(0)) prefix = base === 16 ? (letter === "X" ? "0X" : "0x") : "";
    if (flags.includes("#") && base === 8 && !digits.startsWith("0")) digits = `0${digits}`;
    return { text: (signed ? sign(value < 0) : "") + prefix + digits, numeric: true, stop: false };
  }
  if ("eEfFgGaA".includes(letter)) {
    // 부동소수 변환은 숫자·부호·`.`·`e`만 만들어 명령 글자를 이룰 수 없다. 값은 근사로 쓴다.
    const parsed = Number.parseFloat(raw ?? "");
    const value = Number.isFinite(parsed) ? parsed : 0;
    const places = Math.min(precision ?? 6, 100);
    const lower = letter.toLowerCase();
    let body: string;
    if (lower === "f") body = Math.abs(value).toFixed(places);
    else if (lower === "e") body = Math.abs(value).toExponential(places).replace(/e([+-])(\d)$/, "e$10$2");
    else if (lower === "g") body = String(Number(Math.abs(value).toPrecision(precision === 0 ? 1 : Math.max(1, places))));
    else body = `0x${Math.abs(value).toString(16)}p+0`;
    if (letter !== lower) body = body.toUpperCase();
    return { text: sign(value < 0) + body, numeric: true, stop: false };
  }
  return undefined;
}

/**
 * 리터럴 인자만으로 정해지는 `printf`의 출력. 서식을 읽으며 `%s %b %c %q %d %i %u %o %x %X`와 부동소수 변환을 값으로 채우고,
 * 플래그·너비·정밀도(`%.3s`, `%-5s`, `%*s`, `%.*s`)를 적용하며, 값이 남으면 서식을 되풀이한다(변환 없는 서식은 한 번).
 * `%b`의 `\c`는 이후 출력을 모두 끊고, 변환 글자가 없거나 모르는 명세는 printf처럼 거기서 멈춘다. `printf -v`는 출력이 없다.
 * 변수·치환으로 만든 서식·값은 정적으로 알 수 없어 글자 그대로 쓴다.
 */
function printfOutput(args: string[]): string {
  const start = args[0] === "--" ? 1 : 0;
  if (args[start] === "-v") return "";
  const [format = "", ...values] = args.slice(start);
  let output = "";
  let used = 0;
  let stopped = false;

  const render = (): void => {
    let index = 0;
    while (index < format.length && !stopped) {
      const character = format[index];
      if (character === "\\") {
        const escape = readPrintfEscape(format, index, PRINTF_FORMAT_ESCAPE);
        output += escape?.text ?? "\\";
        index += escape?.length ?? 1;
        continue;
      }
      if (character !== "%") {
        output += character;
        index += 1;
        continue;
      }

      PRINTF_SPEC.lastIndex = index;
      const spec = PRINTF_SPEC.exec(format);
      if (!spec) {
        stopped = true;
        return;
      }
      index += spec[0].length;
      if (spec[1] !== undefined) {
        output += "%";
        continue;
      }

      const flags = spec[2];
      let width = spec[3] === "*" ? Number(parsePrintfInteger(values[used++])) : Number(spec[3] ?? 0);
      let precision: number | undefined;
      if (spec[4] === "*") precision = Number(parsePrintfInteger(values[used++]));
      else if (spec[4] !== undefined) precision = Number(spec[4] || 0);
      if (precision !== undefined && precision < 0) precision = undefined;
      const left = flags.includes("-") || width < 0;
      width = Math.min(Math.abs(width), PRINTF_MAX_WIDTH);

      const converted = convertPrintfValue(spec[5], values[used++], flags, precision === undefined ? undefined : Math.min(precision, PRINTF_MAX_WIDTH));
      if (!converted) {
        stopped = true;
        return;
      }
      let { text } = converted;
      const padding = Math.max(0, width - Array.from(text).length);
      if (left) text += " ".repeat(padding);
      else if (flags.includes("0") && converted.numeric && !(precision !== undefined && "diuoxX".includes(spec[5]))) {
        const lead = /^[-+ ]?(?:0[xX])?/.exec(text)?.[0] ?? "";
        text = lead + "0".repeat(padding) + text.slice(lead.length);
      } else text = " ".repeat(padding) + text;
      output += text;
      if (converted.stop) stopped = true;
    }
  };

  let before = used;
  render();
  while (!stopped && used > before && used < values.length) {
    before = used;
    render();
  }
  return output;
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
  if (invocation.name === "printf") return printfOutput(args);
  if (invocation.name === "cat" && positionalArguments(args).length === 0) {
    const stdin = stdinTexts(segment);
    return stdin.length > 0 ? stdin.join("\n") : undefined;
  }
  return undefined;
}

function matchDatabase(
  segment: ShellSegment,
  invocation: Invocation,
  previousSegment: ShellSegment | undefined,
): string | undefined {
  if (!DB_CLIENTS[invocation.name]) return undefined;

  const args = segment.tokens.slice(invocation.index + 1).map((token) => token.value);
  const queries = directDatabaseQueries(invocation.name, args);
  if (queries.some(containsDestructiveSql)) return REASONS.database;
  if (stdinTexts(segment).some(containsDestructiveSql)) return REASONS.database;

  if (segment.separatorBefore === "|") {
    const pipedText = pipelineText(previousSegment);
    if (pipedText && containsDestructiveSql(pipedText)) return REASONS.database;
  }

  return undefined;
}

function isDeployScriptName(value: string): boolean {
  const normalized = value.replace(/\\/g, "/").toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (basename === "deploy" || basename === "release" || basename === "deploy-live") return true;
  return /^(?:deploy|release)(?:[-_](?:canary|live|preview|prod|production|staging))?\.(?:bat|cmd|cjs|js|mjs|ps1|py|sh|ts)$/.test(
    basename,
  );
}

function isDeployScriptLabel(value: string): boolean {
  return /^(?:pre|post)?(?:deploy|release)(?:$|[:_-])/i.test(value);
}

function isWranglerName(value: string): boolean {
  return commandName(value).replace(/@[^/]*$/, "") === "wrangler";
}

/** 패키지 러너·매니저 인자에서 `wrangler` 도구 이름 뒤의 인자를 돌려준다(`@version`·`dlx`·`exec`·`x` 허용). */
function argumentsAfterWrangler(args: string[], leaders: StringLookup): string[] | undefined {
  let index = 0;
  let leaderSeen = false;
  while (index < args.length) {
    const value = args[index];
    if (value === "--") {
      index += 1;
    } else if (value.startsWith("-")) {
      index += !value.includes("=") && PACKAGE_RUNNER_OPTIONS_WITH_VALUE[value] ? 2 : 1;
    } else if (isWranglerName(value)) {
      return args.slice(index + 1);
    } else if (!leaderSeen && leaders[value.toLowerCase()]) {
      leaderSeen = true;
      index += 1;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** `wrangler` 뒤 위치 인자(옵션 값 제외)가 배포 하위 명령인지. */
function isWranglerDeploy(args: string[]): boolean {
  const [first, second] = positionalArguments(args, WRANGLER_OPTIONS_WITH_VALUE).map((value) => value.toLowerCase());
  if (first === "deploy" || first === "publish") return true;
  if (first === "versions" || first === "triggers") return second === "deploy";
  return first === "pages" && (second === "deploy" || second === "publish");
}

/** PowerShell 옵션(값을 받는 옵션 포함)을 지난 첫 위치 인자. `-Command`·`-File`에서 멈춘다(각각 따로 판정한다). */
function firstPowerShellPositional(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index].toLowerCase();
    if (!option.startsWith("-")) return args[index];
    if (POWERSHELL_COMMAND_OPTIONS[option] || option === "-f" || option === "-file") return undefined;
    if (POWERSHELL_OPTIONS_WITH_VALUE[option]) index += 1;
  }
  return undefined;
}

function matchDeployment(tokens: ShellToken[], invocation: Invocation): string | undefined {
  const args = tokens.slice(invocation.index + 1).map((token) => token.value);
  const positionals = positionalArguments(args);

  if (invocation.name === "wrangler" && isWranglerDeploy(args)) {
    return REASONS.deploy;
  }

  if (PACKAGE_EXECUTORS[invocation.name] || PACKAGE_MANAGERS[invocation.name]) {
    const afterTool = argumentsAfterWrangler(args, PACKAGE_EXECUTORS[invocation.name] ? {} : PACKAGE_MANAGER_EXEC_LEADERS);
    if (afterTool && isWranglerDeploy(afterTool)) return REASONS.deploy;
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
    // `pwsh Tools/x/deploy-live.ps1`: 옵션을 지난 첫 위치 인자는 실행할 스크립트다.
    const script = firstPowerShellPositional(args);
    if (script && isDeployScriptName(script)) return REASONS.deploy;
  }

  return undefined;
}

/** `powershell -Command`의 명령 문자열. */
function powerShellCommand(args: string[]): string | undefined {
  const commandIndex = args.findIndex(
    (value) => Boolean(POWERSHELL_COMMAND_OPTIONS[value.toLowerCase()]),
  );
  if (commandIndex < 0 || commandIndex + 1 >= args.length) return undefined;
  return args.slice(commandIndex + 1).join(" ");
}

/**
 * `bash -lc '…'`·`bash -o pipefail -c '…'`처럼 옵션을 지난 첫 위치 인자를 명령 문자열로 쓰는 셸의 인자 해석.
 * `-c`가 없고 스크립트 파일도 없으면(또는 `-s`·`-`) 셸은 stdin을 읽는다.
 */
function parseShellArguments(args: string[]): { commandString?: string; readsStdin: boolean } {
  let commandFlag = false;
  let stdinFlag = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      index += 1;
      break;
    }
    if (value.length < 2 || !/^[-+]/.test(value)) break;
    if (value === "--rcfile" || value === "--init-file") {
      index += 1;
      continue;
    }
    if (/^-[A-Za-z]+$/.test(value)) {
      if (value.includes("c")) commandFlag = true;
      if (value.includes("s")) stdinFlag = true;
    }
    if (/^[-+][A-Za-z]*[oO]$/.test(value)) index += 1;
  }
  const rest = args.slice(index);
  if (commandFlag) return { commandString: rest[0], readsStdin: false };
  return { readsStdin: stdinFlag || rest.length === 0 || rest[0] === "-" };
}

/** `su -c '…'`·`script -qc '…'`·`flock <lock> -c '…'`의 명령 문자열. */
function commandOptionValue(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value.startsWith("--command=")) return value.slice("--command=".length);
    if (value === "--command" || /^-[A-Za-z]*c$/.test(value)) return args[index + 1];
  }
  return undefined;
}

/** `watch -n 5 <명령…>`은 이어 붙인 명령 전체를 `sh -c`로 실행한다. */
function watchCommand(args: string[]): string {
  let index = 0;
  while (index < args.length) {
    const value = args[index];
    if (value === "--") {
      index += 1;
      break;
    }
    if (!value.startsWith("-")) break;
    index += value === "-n" || value === "--interval" ? 2 : 1;
  }
  return args.slice(index).join(" ");
}

/**
 * 이 세그먼트가 문자열로 실행하게 만드는 하위 스크립트 전부. 명령 치환, 확장이 일어나는 heredoc 본문의 치환,
 * `bash -c '…'`·`eval`·`su -c`·`watch` 같은 리터럴 명령 문자열, stdin을 읽는 셸에 먹이는 heredoc·here-string·파이프 텍스트.
 * 변수·동적으로 만든 문자열(`bash -c "$cmd"`)은 정적으로 알 수 없으므로 본문 그대로 넘어가 아무것도 찾지 못한다.
 */
function nestedScripts(
  segment: ShellSegment,
  invocation: Invocation | undefined,
  previousSegment: ShellSegment | undefined,
): string[] {
  const scripts = [...segment.substitutions];
  for (const heredoc of segment.heredocs) {
    if (!heredoc.quoted) scripts.push(...heredocExpansions(heredoc.body));
  }
  if (!invocation) return scripts;

  const args = segment.tokens.slice(invocation.index + 1).map((token) => token.value);
  const { name } = invocation;
  if (name === "powershell" || name === "pwsh") {
    const command = powerShellCommand(args);
    if (command) scripts.push(command);
  } else if (SHELLS[name]) {
    const shell = parseShellArguments(args);
    if (shell.commandString !== undefined) {
      scripts.push(shell.commandString);
    } else if (shell.readsStdin) {
      scripts.push(...stdinTexts(segment));
      const piped = segment.separatorBefore === "|" ? pipelineText(previousSegment) : undefined;
      if (piped) scripts.push(piped);
    }
  } else if (name === "eval") {
    if (args.length > 0) scripts.push(args.join(" "));
  } else if (name === "watch") {
    const command = watchCommand(args);
    if (command) scripts.push(command);
  } else if (name === "su" || name === "script" || name === "flock") {
    const command = commandOptionValue(args);
    if (command !== undefined) scripts.push(command);
  }
  return scripts;
}

/**
 * 명령이 실제로 부르는 실행 파일 이름(따옴표를 벗긴 첫 낱말) 전부. 따옴표 안 언급·주석·heredoc 본문의 글자는 포함하지 않고,
 * 명령 치환·`bash -c '…'`·래퍼 뒤의 명령은 포함한다. 부르는 낱말이 `"$S"`처럼 변수면 무엇인지 정적으로 알 수 없으므로,
 * 같은 명령에서 앞서 `S=…`로 대입한 값을 그 호출 후보로 함께 돌려준다. WSL interop이 Windows 프로그램 호출을 알아보는 데 쓴다.
 */
export function invokedCommands(command: string): string[] {
  const invoked: string[] = [];
  const assigned: string[] = [];
  const visit = (text: string, depth: number): void => {
    const tokenized = tokenizeShell(text);
    const descend = (script: string): void => {
      if (depth < MAX_NESTING) visit(script, depth + 1);
    };
    tokenized.loose.forEach(descend);
    tokenized.segments.forEach((segment, index) => {
      for (const token of segment.tokens) {
        if (!isEnvironmentAssignment(token.value)) break;
        assigned.push(token.value.slice(token.value.indexOf("=") + 1));
      }
      const invocation = resolveInvocation(segment.tokens);
      nestedScripts(segment, invocation, tokenized.segments[index - 1]).forEach(descend);
      if (!invocation) return;
      const word = segment.tokens[invocation.index].value;
      invoked.push(word);
      if (word.startsWith("$")) invoked.push(...assigned);
      if (invocation.name === "find") {
        const args = segment.tokens.slice(invocation.index + 1).map((token) => token.value);
        args.forEach((value, position) => {
          if (/^-(?:exec|execdir|ok|okdir)$/.test(value) && args[position + 1]) invoked.push(args[position + 1]);
        });
      }
    });
  };
  visit(command, 0);
  return invoked;
}

function matchBlockedCommandInternal(
  command: string,
  depth: number,
  context: GuardContext | undefined,
  windowsShell: boolean,
): string | undefined {
  const tokenized = tokenizeShell(command);
  const segments = tokenized.segments;
  const descend = (script: string, scriptContext: GuardContext | undefined, shell: boolean): string | undefined =>
    depth < MAX_NESTING ? matchBlockedCommandInternal(script, depth + 1, scriptContext, shell) : undefined;
  for (const script of tokenized.loose) {
    const reason = descend(script, context, windowsShell);
    if (reason) return reason;
  }
  // `cd <리터럴 경로>` 뒤 `&&`로만 이어진 호출은 그 경로에서 돈다. `;`·`||`·`|`·`&`·줄바꿈으로 이어지면 cd가 실패해도
  // 다음 호출이 돌 수 있어 위치를 모르는 것(null)으로 보고 finalizer 소유 git을 막는다. 괄호 subshell의 cd는 닫히면
  // 사라진다. GIT_DIR·GIT_WORK_TREE를 쓰는 명령은 위치가 저장소를 정하지 않으므로 cd를 따라가지 않는다.
  const followCd = !/\bGIT_(?:DIR|WORK_TREE)\b/.test(command);
  const cwds: (string | null | undefined)[] = [context?.cwd];
  const moved: boolean[] = [false];

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    for (let level = cwds.length; level <= segment.depth; level += 1) {
      cwds[level] = cwds[level - 1];
      moved[level] = moved[level - 1];
    }
    cwds.length = moved.length = segment.depth + 1;
    if (index > 0 && segment.separatorBefore !== "&&" && moved[segment.depth]) cwds[segment.depth] = null;

    const invocation = resolveInvocation(segment.tokens);
    const segmentCwd = cwds[segment.depth];
    const gitContext = segmentCwd === null ? undefined : context && { ...context, cwd: segmentCwd };
    // 하위 스크립트는 이 세그먼트가 도는 위치에서 실행된다. 이 세그먼트의 `cd`는 그 뒤에 적용한다.
    const nestedWindowsShell =
      windowsShell ||
      Boolean(
        invocation &&
          (invocation.name === "powershell" || invocation.name === "pwsh") &&
          /\.exe$/i.test(segment.tokens[invocation.index].value),
      );
    for (const script of nestedScripts(segment, invocation, segments[index - 1])) {
      const reason = descend(script, gitContext, nestedWindowsShell);
      if (reason) return reason;
    }
    if (!invocation) continue;

    if (invocation.name === "cd" || invocation.name === "pushd" || invocation.name === "popd") {
      const targets = segment.tokens
        .slice(invocation.index + 1)
        .map((token) => token.value)
        .filter((value) => value !== "-L" && value !== "-P" && value !== "--");
      const from = cwds[segment.depth];
      const target = targets[0];
      const literal =
        followCd && invocation.name === "cd" && targets.length === 1 && target !== "-" && !hasShellExpansion(target);
      cwds[segment.depth] = !literal
        ? null
        : from === null
          ? isAbsolute(target) ? resolve(target) : null
          : resolve(from ?? ".", target);
      moved[segment.depth] = true;
      continue;
    }

    const gitReason = matchGit(segment.tokens, invocation, gitContext);
    if (gitReason) return gitReason;
    const linuxGitReason = matchLinuxGitOnWindowsDrive(segment.tokens, invocation, context, segmentCwd, windowsShell);
    if (linuxGitReason) return linuxGitReason;

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

    const databaseReason = matchDatabase(segment, invocation, segments[index - 1]);
    if (databaseReason) return databaseReason;

    const deployReason = matchDeployment(segment.tokens, invocation);
    if (deployReason) return deployReason;
  }

  return undefined;
}

function unescapePosix(command: string): string {
  let result = "";
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "<" && command[index + 1] === "<" && command[index + 2] !== "<" && command[index - 1] !== "<") {
      const wordStart = heredocWordStart(command, index + 2).index;
      const wordEnd = scanHeredocWord(command, wordStart).end;
      result += command.slice(index, wordEnd);
      index = wordEnd - 1;
      continue;
    }
    if (character === "\\" && index + 1 < command.length && !/[\r\n$`]/.test(command[index + 1])) {
      result += command[index + 1];
      index += 1;
      continue;
    }
    result += character;
  }
  return result;
}

export function matchBlockedCommand(
  command: string,
  context?: GuardContext,
): string | undefined {
  const directReason = matchBlockedCommandInternal(command, 0, context, false);
  if (directReason) return directReason;

  // 역슬래시를 POSIX처럼 벗긴 2차 판정. `\$`·`\``는 치환이 일어나지 않게 막은 것이고, heredoc 구분자 낱말(`<<\EOF`,
  // `<<E\OF`, `<<'E'OF`)의 `\`·따옴표는 본문을 확장 없이 그대로 두라는 표시라 둘 다 벗기지 않는다.
  const posixUnescaped = unescapePosix(command);
  if (posixUnescaped === command) return undefined;
  return matchBlockedCommandInternal(posixUnescaped, 0, context, false);
}
