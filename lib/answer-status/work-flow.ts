import { readExitCode } from "@/lib/tool-exit-code";
import { isEditToolName, isWriteToolName } from "@/lib/tool-names";
import type { AssistantContentBlock, ToolCallContent, ToolResultMessage } from "@/lib/types";

/**
 * 한 턴의 작업 흐름: 조사 → 수정 → 검사 → 교차리뷰 → 커밋·푸시 → CI → 배포 단계마다 무슨 일이 있었는지,
 * 실패나 지적으로 수정에 되돌아온 횟수(회차), 그리고 다음 차례 단계. 전부 도구 호출과 그 결과에서 읽는다 —
 * 모델이 답변에 적은 말은 읽지 않는다.
 */

export const WORK_STAGES = ["investigate", "edit", "check", "review", "commit", "ci", "deploy"] as const;
export type WorkStage = (typeof WORK_STAGES)[number];

/* ---------- 셸 명령 읽기 ---------- */

/** 따옴표를 벗긴 낱말과 원문 위치. */
interface ShellWord { value: string; start: number; end: number }
type ShellOperator = "&&" | "||" | "|" | ";" | "&";
type ShellToken = ShellWord | ShellOperator;

/** 파이프와 목록 연산자 사이의 단순 명령 하나. `text`는 원문 그대로다. */
interface ShellCommand { words: string[]; text: string }
interface ShellPipeline { commands: ShellCommand[]; negated: boolean }
/** `&&`·`||`로 이어진 파이프라인들. `&`로 끝났으면 배경 실행이다. */
interface ShellList { pipelines: ShellPipeline[]; operators: ("&&" | "||")[]; background: boolean }
/** 목록 차례의 구조와, 그 안의 단순 명령을 나온 차례대로 편 것. */
interface ParsedShell { lists: ShellList[]; commands: ShellCommand[]; uncertain: boolean }

/** `"…"` 안을 읽는다. 역슬래시는 `$` `` ` `` `"` `\` 앞에서만 특별하고, `$(…)`·백틱은 그대로 둔다. */
function readDoubleQuoted(source: string, from: number): { text: string; end: number } {
  let text = "";
  let i = from;
  while (i < source.length && source[i] !== "\"") {
    const char = source[i];
    if (char === "\\" && i + 1 < source.length) {
      const next = source[i + 1];
      if (next !== "\n") text += "$`\"\\".includes(next) ? next : char + next;
      i += 2;
    } else if (char === "$" && source[i + 1] === "(") {
      const end = skipGroup(source, i + 1);
      text += source.slice(i, end);
      i = end;
    } else if (char === "`") {
      const end = skipBacktick(source, i + 1);
      text += source.slice(i, end);
      i = end;
    } else {
      text += char;
      i += 1;
    }
  }
  return { text, end: Math.min(i + 1, source.length) };
}

/** `open` 자리의 `(`나 `{`와 짝이 맞는 닫는 괄호 다음 자리. 따옴표 안의 괄호는 세지 않는다. */
function skipGroup(source: string, open: number): number {
  const opener = source[open];
  const closer = opener === "{" ? "}" : ")";
  let depth = 0;
  let i = open;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
    } else if (char === "'") {
      const close = source.indexOf("'", i + 1);
      i = close < 0 ? source.length : close + 1;
    } else if (char === "\"") {
      i = readDoubleQuoted(source, i + 1).end;
    } else if (char === "`") {
      i = skipBacktick(source, i + 1);
    } else {
      if (char === opener) depth += 1;
      else if (char === closer && --depth === 0) return i + 1;
      i += 1;
    }
  }
  return source.length;
}

function skipBacktick(source: string, from: number): number {
  let i = from;
  while (i < source.length && source[i] !== "`") i += source[i] === "\\" ? 2 : 1;
  return Math.min(i + 1, source.length);
}

/**
 * 명령 문자열을 낱말과 연산자로 나눈다. 따옴표·`$(…)`·백틱 안의 연산자는 낱말에 남는다. 묶음은 단계 탐색에만
 * 평탄화하며, 그 범위와 치환·부정의 종료 코드는 증명하지 않는다. here-document 본문은 건너뛴다.
 */
function tokenizeShell(source: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const heredocs: { delimiter: string; stripTabs: boolean }[] = [];
  let value = "";
  let start = -1;
  const flush = (end: number) => {
    if (start < 0) return;
    tokens.push({ value, start, end });
    value = "";
    start = -1;
  };
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      if (source[i + 1] !== "\n") {
        if (start < 0) start = i;
        value += source[i + 1] ?? "";
      }
      i += 2;
    } else if (char === "'") {
      if (start < 0) start = i;
      const close = source.indexOf("'", i + 1);
      const stop = close < 0 ? source.length : close;
      value += source.slice(i + 1, stop);
      i = stop + 1;
    } else if (char === "\"") {
      if (start < 0) start = i;
      const quoted = readDoubleQuoted(source, i + 1);
      value += quoted.text;
      i = quoted.end;
    } else if (char === "$" && (source[i + 1] === "(" || source[i + 1] === "{")) {
      if (start < 0) start = i;
      const end = skipGroup(source, i + 1);
      value += source.slice(i, end);
      i = end;
    } else if (char === "`") {
      if (start < 0) start = i;
      const end = skipBacktick(source, i + 1);
      value += source.slice(i, end);
      i = end;
    } else if (char === "#" && start < 0) {
      const lineEnd = source.indexOf("\n", i);
      i = lineEnd < 0 ? source.length : lineEnd;
    } else if (char === " " || char === "\t" || char === "\r") {
      flush(i);
      i += 1;
    } else if (char === "\n") {
      flush(i);
      const last = tokens[tokens.length - 1];
      // `&&`·`||`·`|` 뒤의 줄바꿈은 명령을 잇는다.
      if (last !== "&&" && last !== "||" && last !== "|") tokens.push(";");
      i += 1;
      for (const { delimiter, stripTabs } of heredocs.splice(0)) {
        while (i < source.length) {
          const lineEnd = source.indexOf("\n", i);
          const stop = lineEnd < 0 ? source.length : lineEnd;
          const line = source.slice(i, stop);
          i = stop + 1;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
        }
      }
    } else if (char === "<" && source[i + 1] === "<" && source[i + 2] !== "<") {
      // here-document: 구분자만 읽어 두고, 본문은 줄이 끝난 뒤 건너뛴다.
      flush(i);
      let j = i + 2;
      const stripTabs = source[j] === "-";
      if (stripTabs) j += 1;
      while (source[j] === " " || source[j] === "\t") j += 1;
      let delimiter = "";
      while (j < source.length && !/[\s;&|<>()]/.test(source[j])) {
        const quote = source[j];
        if (quote === "'" || quote === "\"") {
          const close = source.indexOf(quote, j + 1);
          const stop = close < 0 ? source.length : close;
          delimiter += source.slice(j + 1, stop);
          j = stop + 1;
        } else {
          delimiter += quote === "\\" ? source[j + 1] ?? "" : quote;
          j += quote === "\\" ? 2 : 1;
        }
      }
      if (delimiter) heredocs.push({ delimiter, stripTabs });
      i = j;
    } else if (char === ";") {
      flush(i);
      tokens.push(";");
      i += source[i + 1] === ";" ? 2 : 1;
    } else if (char === "&") {
      if (source[i + 1] === "&") {
        flush(i);
        tokens.push("&&");
        i += 2;
      } else if (source[i + 1] === ">" || /[<>]$/.test(value)) {
        // `&>file`·`2>&1` 같은 방향 바꾸기는 낱말이다.
        if (start < 0) start = i;
        value += char;
        i += 1;
      } else {
        flush(i);
        tokens.push("&");
        i += 1;
      }
    } else if (char === "|") {
      if (source[i + 1] === "|") {
        flush(i);
        tokens.push("||");
        i += 2;
      } else if (value.endsWith(">")) {
        value += char;
        i += 1;
      } else {
        flush(i);
        tokens.push("|");
        i += source[i + 1] === "&" ? 2 : 1;
      }
    } else if (char === "(" || char === ")") {
      flush(i);
      i += 1;
    } else {
      if (start < 0) start = i;
      value += char;
      i += 1;
    }
  }
  flush(source.length);
  return tokens;
}

function parseShell(source: string): ParsedShell {
  const lists: ShellList[] = [];
  const commands: ShellCommand[] = [];
  let list: ShellList = { pipelines: [], operators: [], background: false };
  let pipeline: ShellPipeline = { commands: [], negated: false };
  let words: ShellWord[] = [];
  const endCommand = () => {
    const values = words.map((word) => word.value).filter((word) => word !== "{" && word !== "}");
    if (pipeline.commands.length === 0 && values[0] === "!") {
      pipeline.negated = true;
      values.shift();
    }
    if (values.length > 0) {
      const command = { words: values, text: source.slice(words[0].start, words[words.length - 1].end) };
      pipeline.commands.push(command);
      commands.push(command);
    }
    words = [];
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.commands.length > 0) list.pipelines.push(pipeline);
    pipeline = { commands: [], negated: false };
  };
  const endList = (background: boolean) => {
    endPipeline();
    if (list.pipelines.length > 0) lists.push({ ...list, background });
    list = { pipelines: [], operators: [], background: false };
  };
  for (const token of tokenizeShell(source)) {
    if (typeof token !== "string") words.push(token);
    else if (token === "|") endCommand();
    else if (token === "&&" || token === "||") {
      endPipeline();
      list.operators.push(token);
    } else endList(token === "&");
  }
  endList(false);
  // This is a display classifier, not a shell interpreter. Grouping, substitution and negation
  // are outside its proof subset, even when they occur in a harmless quoted argument.
  return { lists, commands, uncertain: /[(){}!`]/.test(source) };
}

function basename(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true };
/** 다른 명령을 감싸 실행하는 명령. 그 뒤의 낱말에서 실제 프로그램을 찾는다. */
const WRAPPERS: Record<string, true> = {
  sudo: true, env: true, command: true, exec: true, nice: true, nohup: true, time: true, timeout: true, setsid: true, "systemd-run": true,
};
/** 감싸는 명령의 옵션 가운데 값을 다음 낱말로 받는 것. */
const VALUE_OPTIONS: Record<string, true> = {
  "-u": true, "--unit": true, "-p": true, "--property": true, "-E": true, "--setenv": true, "--description": true, "--slice": true,
  "-M": true, "--machine": true, "-H": true, "--host": true, "--uid": true, "--gid": true, "--working-directory": true,
  "-s": true, "--signal": true, "-k": true, "--kill-after": true,
};
/** systemd-run이 띄운 프로그램을 기다리게 하는 옵션. */
const WAITING_SYSTEMD_OPTIONS: Record<string, true> = { "--wait": true, "-W": true, "--pipe": true, "-P": true, "--pty": true, "-t": true, "--scope": true };
/** 뒤따르는 명령을 실행하는 셸 예약어. 그 뒤의 낱말이 실제 프로그램이다. */
const SHELL_KEYWORDS: Record<string, true> = { if: true, then: true, elif: true, else: true, do: true, while: true, until: true };

/** `bash -c '<script>'`처럼 셸에 넘긴 스크립트. `-o errexit`처럼 값을 받는 옵션은 그 값까지 건너뛴다. 없으면 null. */
function readShellScript(words: readonly string[]): string | null {
  const at = programIndex(words);
  if (at < 0 || !Object.hasOwn(SHELLS, basename(words[at])) || shellNoExec(words, at)) return null;
  for (let j = at + 1; j < words.length && /^[-+]/.test(words[j]); j += 1) {
    if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(words[j])) return words[j + 1] ?? null;
    if (/^[-+][a-zA-Z]*[oO]$/.test(words[j]) || words[j] === "--rcfile" || words[j] === "--init-file") j += 1;
  }
  return null;
}

/** `-n`이나 `-o noexec`로 띄운 셸은 스크립트를 읽기만 하고 실행하지 않는다. 값을 받는 옵션(`-o errexit`)은 값까지 건너뛴다. */
function shellNoExec(words: readonly string[], at: number): boolean {
  for (let j = at + 1; j < words.length && /^[-+]/.test(words[j]); j += 1) {
    if (/^-[a-zA-Z]*n[a-zA-Z]*$/.test(words[j]) || (/^-[a-zA-Z]*o$/.test(words[j]) && words[j + 1] === "noexec")) return true;
    if (/^[-+][a-zA-Z]*[oO]$/.test(words[j]) || words[j] === "--rcfile" || words[j] === "--init-file") j += 1;
  }
  return false;
}

/** 감싸는 명령의 질의 옵션: 프로그램을 찾아보거나 권한만 확인하고 실행하지 않는다. */
const QUERY_OPTIONS: Record<string, RegExp> = {
  command: /^-[a-zA-Z]*[vV]/,
  sudo: /^(?:-[a-zA-Z]*[lvVhK]|--(?:list|validate|version|help|remove-timestamp)$)/,
};

/** 환경 변수 대입과 감싸는 명령(sudo·env·timeout …)과 그 옵션을 건너뛴 실제 프로그램 자리. 없으면 -1. */
function programIndex(words: readonly string[]): number {
  let wrapped = false;
  let wrapper = "";
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (/^[A-Za-z_]\w*=/.test(word) || (!wrapped && Object.hasOwn(SHELL_KEYWORDS, word))) continue;
    if (wrapped && (word.startsWith("-") || /^\d+(?:\.\d+)?[smhd]?$/.test(word))) {
      if (Object.hasOwn(QUERY_OPTIONS, wrapper) && QUERY_OPTIONS[wrapper].test(word)) return -1;
      // `command`의 옵션은 값을 받지 않는다(`command -p -v`).
      if (wrapper !== "command" && Object.hasOwn(VALUE_OPTIONS, word)) i += 1;
      continue;
    }
    if (!Object.hasOwn(WRAPPERS, basename(word))) return i;
    wrapped = true;
    wrapper = basename(word);
  }
  return -1;
}

/**
 * CUELO WSL 배포를 실제로 실행하는 명령: 프로그램 자리가 `wsl/update.sh`이거나, 셸이 그 스크립트를 인자나
 * `-c` 스크립트로 받아 실행한다. `grep`·`sed`처럼 그 파일을 읽기만 하는 명령은 아니다.
 */
const DEPLOY_SCRIPT = /(?:^|\/)wsl\/update\.sh$/;
function runsDeployScript(words: readonly string[], depth = 0): boolean {
  const script = readShellScript(words);
  if (script !== null) return depth < 3 && parseShell(script).commands.some((command) => runsDeployScript(command.words, depth + 1));
  const at = programIndex(words);
  if (at < 0) return false;
  if (DEPLOY_SCRIPT.test(words[at])) return true;
  if (!Object.hasOwn(SHELLS, basename(words[at])) || shellNoExec(words, at)) return false;
  const target = words.slice(at + 1).find((word) => !word.startsWith("-"));
  return target !== undefined && DEPLOY_SCRIPT.test(target);
}

/** systemd-run(기다리는 옵션 없이)·setsid(-w 없이)·`sudo -b`는 프로그램을 띄우고 바로 돌아온다. 그 종료 코드는 띄운 결과뿐이다. */
function detaches(words: readonly string[]): boolean {
  const at = programIndex(words);
  const prefix = at < 0 ? words : words.slice(0, at);
  const names = prefix.map(basename);
  if (names.includes("systemd-run")) return !prefix.some((word) => Object.hasOwn(WAITING_SYSTEMD_OPTIONS, word));
  if (names.includes("sudo") && prefix.some((word) => word === "--background" || /^-[a-zA-Z]*b[a-zA-Z]*$/.test(word))) return true;
  return names.includes("setsid") && !prefix.includes("-w") && !prefix.includes("--wait");
}

/** 목록 하나가 명령 하나뿐일 때 그 명령. */
function soleCommand(list: ShellList): ShellCommand | null {
  const [pipeline] = list.pipelines;
  return list.pipelines.length === 1 && pipeline.commands.length === 1 && !pipeline.negated ? pipeline.commands[0] : null;
}

/** Only the last list, or an immediately following `exit` / `exit $?`, preserves a proven status.
 * Named captures are deliberately not tracked: later assignments or early exits can replace them. */
function statusSurvives(lists: readonly ShellList[], index: number): boolean {
  if (index === lists.length - 1) return true;
  const last = lists[lists.length - 1];
  const exit = soleCommand(last)?.words;
  if (!exit || exit[0] !== "exit" || last.background) return false;
  if (index === lists.length - 2) return exit.length === 1 || (exit.length === 2 && exit[1] === "$?");
  return false;
}

interface StatusTrace {
  /** 판정 명령의 종료 코드가 명령 전체의 종료 코드까지 그대로 오는지. 판정 명령이 없으면 absent. */
  reach: "carried" | "masked" | "absent";
  /** 판정 명령들. `bash -c` 스크립트 안의 명령은 스크립트 안에서 찾은 것이다. */
  decisive: ShellCommand[];
}

/**
 * 판정 명령 곁에 있어도 그 결과를 바꾸거나 건너뛰지 않는 명령: 옵션만 있는 `set`(실행을 멈추는 `-n`은 아니다), 인자 하나 이하의
 * `cd`, 대입뿐인 명령·`export`.
 */
function isNeutralCommand(words: readonly string[]): boolean {
  if (words.every((word) => /^[A-Za-z_]\w*=/.test(word))) return true;
  const [program, ...args] = words;
  if (program === "cd") return args.length <= 1;
  if (program === "export") return args.every((word) => /^[A-Za-z_]\w*=/.test(word));
  if (program === "set") return args.every((word) => (/^[-+][a-zA-Z]+$/.test(word) && !/^-[a-zA-Z]*n/.test(word)) || word === "pipefail");
  return false;
}

/** pipefail 아래에서 판정 명령 뒤에 붙어도 되는 출력 정리 명령. */
const PIPE_FILTERS: Record<string, true> = { tail: true, head: true, cat: true, tee: true };

/** 마지막 목록이 `exit`·`exit $?` 하나뿐인지. 그 앞 목록의 종료 코드를 그대로 돌려준다. */
function isFinalExit(lists: readonly ShellList[], index: number): boolean {
  if (index !== lists.length - 1 || lists[index].background) return false;
  const exit = soleCommand(lists[index])?.words;
  return exit?.[0] === "exit" && (exit.length === 1 || (exit.length === 2 && exit[1] === "$?"));
}

/**
 * 판정에 쓰는 명령(`decides`)마다 그 종료 코드가 셸 종료 코드로 그대로 전해지는지 본다. 허용 목록 방식이다 — 판정 명령 곁에는
 * 중립 명령(`set` 옵션·`cd`·대입), pipefail 아래 판정 명령 뒤의 출력 정리(tail·head·cat·tee), 마지막 `exit`/`exit $?`만 올 수
 * 있고, 그 밖의 명령(trap·`exit 0`·printf …)이 하나라도 있으면 가려졌다고 본다. 파이프 중간(pipefail 없이), `!`, `||`, `&`,
 * 바로 돌아오는 실행기, 뒤따르는 다른 목록도 결과를 가린다. `set -e`는 따지지 않는다.
 */
function traceStatus(parsed: ParsedShell, decides: (command: ShellCommand) => boolean, depth = 0): StatusTrace {
  const { lists } = parsed;
  const decisive: ShellCommand[] = [];
  let masked = parsed.uncertain;
  let pipefail = false;
  lists.forEach((list, index) => {
    // Any mention of pipefail (a conditional, redirected or wrapped `command set +o pipefail`, `eval`)
    // may disable an earlier enable. Only the standalone enable below can establish it for a later list.
    if (list.pipelines.some((pipeline) => pipeline.commands.some(({ words }) => words.some((word) => word.includes("pipefail"))))) pipefail = false;
    for (const pipeline of list.pipelines) {
      let decided = false;
      for (const command of pipeline.commands) {
        const script = depth < 3 ? readShellScript(command.words) : null;
        const inner = script === null ? null : traceStatus(parseShell(script), decides, depth + 1);
        if (inner && inner.decisive.length > 0) decisive.push(...inner.decisive);
        else if (decides(command)) decisive.push(command);
        else {
          const at = programIndex(command.words);
          const filter = decided && pipefail && at >= 0 && Object.hasOwn(PIPE_FILTERS, basename(command.words[at]));
          if (!filter && !isNeutralCommand(command.words) && !isFinalExit(lists, index)) masked = true;
          continue;
        }
        decided = true;
        if (inner?.reach === "masked"
          || pipeline.negated
          || (pipeline.commands.length > 1 && !pipefail)
          || list.operators.includes("||")
          || list.background
          || detaches(command.words)
          || !statusSurvives(lists, index)) masked = true;
      }
    }
    // Only an unconditional, standalone top-level enable/disable statement affects later pipelines.
    const setting = soleCommand(list)?.words;
    if (!list.background && setting?.[0] === "set" && setting.length === 3 && setting[2] === "pipefail") {
      if (/^-[a-zA-Z]*o$/.test(setting[1])) pipefail = true;
      else if (/^\+[a-zA-Z]*o$/.test(setting[1])) pipefail = false;
    }
  });
  return { reach: decisive.length === 0 ? "absent" : masked ? "masked" : "carried", decisive };
}

/* ---------- 검사·CI·배포 명령 ---------- */

/** 검사 이름: test·typecheck·tsc·lint·eslint·vitest·jest·pytest·build·check·verify·smoke 가운데 하나가 단어로 든 것. */
const CHECK_COMMAND = /(?:^|[^\w-])(?:tests?|typecheck|tsc|lint|eslint|vitest|jest|pytest|build|check|verify|smoke)(?![\w])/i;
/** CI stage detection only follows executed program positions, including real shell -c scripts. */
function runsCi(words: readonly string[], depth = 0): boolean {
  const script = readShellScript(words);
  if (script !== null) return depth < 3 && parseShell(script).commands.some((command) => runsCi(command.words, depth + 1));
  const at = programIndex(words);
  return at >= 0 && basename(words[at]) === "gh" && words[at + 1] === "run"
    && ["watch", "view", "list"].includes(words[at + 2]);
}

/** 스크립트나 하위 명령을 실행하는 프로그램. 실행 대상이 검사 이름일 때만 검사다. */
const CHECK_RUNNERS: Record<string, true> = {
  bun: true, bunx: true, npm: true, npx: true, pnpm: true, yarn: true,
  node: true, python: true, python3: true, deno: true,
};

/** 실행기가 실행하는 대상: 옵션이 아닌 첫 낱말, 그것이 `run`·`exec`·`x`·`dlx`면 그 뒤, `-m`이면 그 모듈. */
function runnerTarget(words: readonly string[], from: number): string | undefined {
  for (let i = from; i < words.length; i += 1) {
    const word = words[i];
    if (word === "-m") return words[i + 1];
    // 인라인 코드(`python -c`·`-Bc`·`-cpass`, `node -e`·`-pe`, `--eval`)는 실행 대상이 아니다.
    if (/^-[a-zA-Z]*[cep]/.test(word) || /^--(?:eval|print)(?:=|$)/.test(word)) return undefined;
    if (word.startsWith("-")) continue;
    if (word === "run" || word === "exec" || word === "x" || word === "dlx") return words.slice(i + 1).find((next) => !next.startsWith("-"));
    return word;
  }
  return undefined;
}

/**
 * 프로그램 자리에서 검사를 실행하는지: 검사 프로그램이거나, 실행기가 검사 이름의 대상을 실행한다. 인자 안의 글자는 보지 않는다.
 * 셸의 조건 명령 `test`·`[`는 검사가 아니다.
 */
function invokesCheck(words: readonly string[]): boolean {
  const at = programIndex(words);
  if (at < 0) return false;
  const program = basename(words[at]);
  if (program === "test" || program === "[") return false;
  if (CHECK_COMMAND.test(program)) return true;
  if (!Object.hasOwn(CHECK_RUNNERS, program)) return false;
  const target = runnerTarget(words, at + 1);
  return target !== undefined && CHECK_COMMAND.test(target);
}

/** 검사 단계 탐색: 프로그램 자리와 실제 `sh -c` 스크립트 안만 본다. */
function runsCheck(words: readonly string[], depth = 0): boolean {
  const script = readShellScript(words);
  if (script !== null) return depth < 3 && parseShell(script).commands.some((command) => runsCheck(command.words, depth + 1));
  return invokesCheck(words);
}

/** 단계마다 판정을 맡는 명령. 그 명령의 종료 코드가 셸 종료 코드까지 그대로 와야 통과다. */
const DECISIVE_COMMAND: Record<CommandStep["stage"], (command: ShellCommand) => boolean> = {
  check: ({ words }) => invokesCheck(words),
  // CI 결과를 종료 코드로 돌려주는 명령: 끝날 때까지 기다리는 `gh run watch … --exit-status`. `gh run view --exit-status`는
  // 진행 중인 실행에도 0을 돌려주고, `gh run list`는 목록만 보여 준다.
  ci: ({ words }) => {
    const at = programIndex(words);
    return at >= 0 && basename(words[at]) === "gh" && words[at + 1] === "run" && words[at + 2] === "watch" && words.includes("--exit-status");
  },
  deploy: (command) => runsDeployScript(command.words),
};

/** 검사 명령 낱말에서 읽는 검사 이름. 화면은 한국어 이름을 보이고 원래 명령은 펼쳐야 보인다. */
export type CheckLabel = "typecheck" | "lint" | "test" | "build" | "verify" | "smoke";

const CHECK_LABELS: Record<string, CheckLabel> = {
  test: "test", tests: "test", vitest: "test", jest: "test", pytest: "test",
  typecheck: "typecheck", tsc: "typecheck",
  lint: "lint", eslint: "lint",
  build: "build",
  check: "verify", verify: "verify",
  smoke: "smoke",
};

/**
 * 판정 명령의 낱말에서 검사 이름을 나온 차례대로 모은다. `test:unit` 같은 스크립트 이름과 `--test` 옵션도 읽고, 경로 속 글자는
 * 읽지 않는다. 프로그램 자리의 `test`는 셸의 조건 검사(`test -s file`)라 테스트 실행이 아니다.
 */
function readCheckLabels(commands: readonly ShellCommand[]): CheckLabel[] {
  const labels: CheckLabel[] = [];
  for (const { words } of commands) {
    const program = programIndex(words);
    words.forEach((word, index) => {
      if (index === program && word === "test") return;
      for (const part of word.replace(/^-+/, "").toLowerCase().split(":")) {
        const label = Object.hasOwn(CHECK_LABELS, part) ? CHECK_LABELS[part] : undefined;
        if (label && !labels.includes(label)) labels.push(label);
      }
    });
  }
  return labels;
}

/**
 * 셸 명령의 판정. 셸이 0으로 끝났어도 판정 명령의 종료 코드가 셸 종료 코드까지 그대로 오지 않으면
 * (`| tail`, `; echo`, `|| true`, `&`, 바로 돌아오는 systemd-run …) 통과가 아니라 판정 미확인(unverified)이다.
 */
export type CheckState = "passed" | "unverified" | "failed" | "unobserved";

export interface CheckRun {
  toolCallId: string;
  command: string;
  state: CheckState;
  /** 결과에 기록된 종료 코드. 없으면 null. */
  exitCode: number | null;
  /** 명령 낱말에서 읽은 검사 이름, 나온 차례대로. 못 읽었으면 빈 배열. */
  labels: CheckLabel[];
}

function readBashCommand(block: ToolCallContent | null | undefined): string | null {
  if (!block || typeof block !== "object" || block.toolName !== "bash" || !block.input || typeof block.input !== "object" || Array.isArray(block.input)) return null;
  const command = typeof block.input.command === "string" ? block.input.command.trim() : "";
  return command || null;
}

/** bash 명령 하나가 속한 단계(배포 > CI > 검사 차례로 하나)와 그 판정. 셋 다 아니면 null. 단계는 실행 위치로만 찾는다. */
function judgeCommand(command: string, result: ToolResultMessage | undefined): Omit<CheckRun, "toolCallId" | "command"> & { stage: CommandStep["stage"] } | null {
  const parsed = parseShell(command);
  const stage = parsed.commands.some(DECISIVE_COMMAND.deploy) ? "deploy"
    : parsed.commands.some(({ words }) => runsCi(words)) ? "ci"
    : parsed.commands.some(({ words }) => runsCheck(words)) ? "check" : null;
  if (stage === null) return null;
  const trace = traceStatus(parsed, DECISIVE_COMMAND[stage]);
  const exitCode = result ? readExitCode(result) : null;
  // 종료 코드가 기록되지 않은 결과(백그라운드로 넘어간 실행 등)는 성공으로 치지 않는다.
  const state: CheckState = exitCode === null
    ? (result?.isError ? "failed" : "unobserved")
    : exitCode !== 0 ? "failed" : trace.reach === "carried" ? "passed" : "unverified";
  return { stage, state, exitCode, labels: stage === "check" ? readCheckLabels(trace.decisive) : [] };
}

/** bash 호출 하나를 검사로 읽는다. 검사 명령이 아니거나 CI·배포 명령이면 null. */
export function readCheckRun(block: ToolCallContent | null | undefined, result: ToolResultMessage | undefined): CheckRun | null {
  const command = readBashCommand(block);
  const judged = command === null ? null : judgeCommand(command, result);
  if (command === null || judged?.stage !== "check") return null;
  return { toolCallId: block!.toolCallId, command, state: judged.state, exitCode: judged.exitCode, labels: judged.labels };
}

/* ---------- 단계 사건 ---------- */

/** 단계 사건 하나의 결과. 진행 중(running)은 아직 끝나지 않은 턴에서 결과가 오지 않은 호출이다. */
export type StepOutcome = "running" | "done" | CheckState;

interface StepCore {
  toolCallId: string;
  /** 이 사건이 일어난 회차(1부터). */
  attempt: number;
  outcome: StepOutcome;
}

export interface PlainStep extends StepCore {
  stage: "investigate" | "edit";
  /** 발주(task). 결과가 와도 맡긴 수정이 끝났다는 뜻은 아니어서 회차를 늘리지 않는다. */
  dispatch?: boolean;
}

/** 검사·CI·배포: 실행한 bash 명령과 기록된 종료 코드. 검사 이름은 검사 단계에서만 읽는다. */
export interface CommandStep extends StepCore {
  stage: "check" | "ci" | "deploy";
  command: string;
  exitCode: number | null;
  labels: CheckLabel[];
}

/** 교차리뷰: review는 받은 지적 수, resolve는 남은 지적 수. 결과를 못 읽었으면 null. */
export interface ReviewStep extends StepCore {
  stage: "review";
  action: "review" | "resolve";
  findings: number | null;
}

/** 커밋·푸시: 결과에 기록된 커밋. */
export interface CommitStep extends StepCore {
  stage: "commit";
  commit: string | null;
}

export type WorkStep = PlainStep | CommandStep | ReviewStep | CommitStep;

const INVESTIGATE_TOOLS: Record<string, true> = {
  read: true, grep: true, glob: true, find: true, ls: true, skim: true, web_search: true, fetch: true, ast_grep: true, lsp: true, recall: true, reflect: true,
};
/** tool-names 판별에 걸리지 않는 수정 도구. */
const EDIT_TOOLS: Record<string, true> = { multiedit: true, notebookedit: true, draft: true };
const LSP_EDIT_ACTIONS: Record<string, true> = { rename: true, rename_file: true };

function isEditCall(block: ToolCallContent, name: string): boolean {
  if (name === "task" || Object.hasOwn(EDIT_TOOLS, name)) return true;
  if (name === "lsp") return typeof block.input.action === "string" && Object.hasOwn(LSP_EDIT_ACTIONS, block.input.action);
  if (!isWriteToolName(block.toolName) && !isEditToolName(block.toolName)) return false;
  // `agent://Main`처럼 스킴이 붙은 대상에 쓰는 것은 파일 수정이 아니다(turn-written-files와 같은 기준).
  const target = block.input.file_path ?? block.input.path;
  return typeof target !== "string" || /^[a-zA-Z]:[\\/]/.test(target) || !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(target);
}

function readStep(block: ToolCallContent, result: ToolResultMessage | undefined, live: boolean): WorkStep | null {
  if (!block.input || typeof block.input !== "object" || Array.isArray(block.input) || typeof block.toolName !== "string") return null;
  const core = { toolCallId: block.toolCallId, attempt: 0 };
  const pending: StepOutcome = live ? "running" : "unobserved";
  const command = readBashCommand(block);
  if (command !== null) {
    const judged = judgeCommand(command, result);
    if (judged === null) return null;
    return { ...core, stage: judged.stage, command, exitCode: judged.exitCode, labels: judged.labels, outcome: result ? judged.state : pending };
  }
  // 확장 이름공간(`ext.edit` 등)은 마지막 이름만 본다.
  const name = block.toolName.toLowerCase().split(/[.:/]/).pop() ?? "";
  const details = (result?.details && typeof result.details === "object" ? result.details : {}) as Record<string, unknown>;
  if (name === "cross_review") {
    const action = block.input.action === "resolve" ? "resolve" : "review";
    if (!result || result.isError) return { ...core, stage: "review", action, findings: null, outcome: result ? "failed" : pending };
    if (action === "resolve") {
      if (details.pass === true) return { ...core, stage: "review", action, findings: 0, outcome: "passed" };
      const open = Array.isArray(details.open) ? details.open.length : null;
      return { ...core, stage: "review", action, findings: open, outcome: details.pass === false ? "failed" : "unobserved" };
    }
    const findings = Array.isArray(details.findings) ? details.findings.length : null;
    return { ...core, stage: "review", action, findings, outcome: findings === null ? "unobserved" : findings > 0 ? "failed" : "done" };
  }
  if (name === "git_finalize") {
    if (!result) return { ...core, stage: "commit", commit: null, outcome: pending };
    const ok = !result.isError && details.ok !== false;
    return { ...core, stage: "commit", commit: ok && typeof details.commitSha === "string" ? details.commitSha : null, outcome: ok ? "done" : "failed" };
  }
  if (isEditCall(block, name)) {
    // 실패한 수정과 거절된 발주는 아무것도 바꾸지 않았다.
    if (result?.isError) return null;
    return { ...core, stage: "edit", outcome: result ? "done" : pending, ...(name === "task" ? { dispatch: true } : {}) };
  }
  if (Object.hasOwn(INVESTIGATE_TOOLS, name)) return { ...core, stage: "investigate", outcome: result || !live ? "done" : "running" };
  return null;
}

/* ---------- 흐름 ---------- */

/** 수정에 되돌아온 일 하나. */
export interface LoopBack {
  /** 되돌아오게 한 실패나 지적이 있던 단계. */
  from: "check" | "review" | "ci";
  /** 실패한 회차. 되돌아온 뒤의 회차는 이보다 하나 크다. */
  attempt: number;
}

export type StageStatus = "waiting" | StepOutcome;

export interface StageView {
  stage: WorkStage;
  status: StageStatus;
  /** 지금 회차에 이 단계에서 일어난 사건. 조사는 회차를 나누지 않고 전부 모은다. */
  steps: WorkStep[];
  /** 앞 회차에 이 단계에서 일어난 사건. 조사는 늘 비어 있다. */
  earlier: WorkStep[];
}

export interface NextStage {
  stage: WorkStage;
  /** 실패나 지적이 풀리지 않아 수정으로 돌아가는 차례인지. */
  returning: boolean;
}

export interface WorkFlow {
  steps: WorkStep[];
  /** 지금 회차(1부터). */
  attempt: number;
  loops: LoopBack[];
  /** WORK_STAGES 차례. */
  stages: StageView[];
  /** 가장 나중 사건의 단계. 사건이 없으면 null. */
  current: WorkStage | null;
  /** 지금 회차에서 실패하지 않고 지난 가장 뒤 단계(조사는 모든 회차). 없으면 null. */
  reached: WorkStage | null;
  /** 다음 차례 단계. 사건이 없거나 배포까지 지났으면 null. */
  next: NextStage | null;
}

type VerifyStage = LoopBack["from"];

interface SegmentEntry { stage: VerifyStage; outcome: StepOutcome; order: number }

/** 앞선 실패를 덮을 수 있는 결과: 판정이 끝난 것(통과·실패·완료). 진행 중·미관측·판정 미확인은 실패를 지우지 않는다. */
function settles(outcome: StepOutcome): boolean {
  return outcome === "passed" || outcome === "failed" || outcome === "done";
}

/** 마지막 수정 뒤의 검증 가운데 아직 풀리지 않은 실패. 같은 검사 명령은 마지막 결과, 교차리뷰와 CI는 마지막 사건만 센다. */
function latestFailure(segment: ReadonlyMap<string, SegmentEntry>): VerifyStage | null {
  let found: SegmentEntry | null = null;
  for (const entry of segment.values()) {
    if (entry.outcome === "failed" && (!found || entry.order > found.order)) found = entry;
  }
  return found?.stage ?? null;
}

/** 같은 검사 명령을 다시 돌렸으면 마지막 결과만 남긴 검사 사건. 단계 요약의 수는 이것으로 센다. */
export function latestChecks(steps: readonly WorkStep[]): CommandStep[] {
  const latest = new Map<string, CommandStep>();
  for (const step of steps) {
    if (step.stage !== "check") continue;
    const previous = latest.get(step.command);
    if (previous?.outcome === "failed" && !settles(step.outcome)) continue;
    latest.set(step.command, step);
  }
  return [...latest.values()];
}

/** 단계 상태가 여럿 섞이면 가장 주의가 필요한 것을 보인다. 실패는 다른 검사가 진행 중이어도 가려지지 않는다. */
const OUTCOME_WEIGHT: Record<StepOutcome, number> = { failed: 5, running: 4, unverified: 3, unobserved: 2, passed: 1, done: 0 };

function stageStatus(stage: WorkStage, steps: readonly WorkStep[]): StageStatus {
  if (steps.length === 0) return "waiting";
  if (stage !== "check") {
    // 다시 돌린 CI·배포·리뷰가 아직 판정 전이면 앞선 실패를 그대로 보인다.
    let status: StepOutcome = steps[0].outcome;
    for (const { outcome } of steps.slice(1)) if (status !== "failed" || settles(outcome)) status = outcome;
    return status;
  }
  let status: StepOutcome = "done";
  for (const { outcome } of latestChecks(steps)) if (OUTCOME_WEIGHT[outcome] > OUTCOME_WEIGHT[status]) status = outcome;
  return status;
}

/**
 * 턴 블록을 차례로 읽어 작업 흐름을 만든다. 마지막 수정 뒤에 풀리지 않은 실패(검사 실패, 교차리뷰 지적이나 미해결,
 * CI 실패)가 있는데 다시 수정하면 회차가 하나 늘고 되돌아온 일(loop)이 남는다. `live`는 아직 진행 중인 턴이다 —
 * 결과가 아직 오지 않은 호출을 진행 중으로 본다.
 */
export function deriveWorkFlow(
  blocks: readonly AssistantContentBlock[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  live = false,
): WorkFlow {
  const steps: WorkStep[] = [];
  const loops: LoopBack[] = [];
  let attempt = 1;
  let segment = new Map<string, SegmentEntry>();
  const results: ReadonlyMap<string, ToolResultMessage> = toolResults instanceof Map ? toolResults : new Map();
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || block.type !== "toolCall") continue;
    const step = readStep(block, results.get(block.toolCallId), live);
    if (!step) continue;
    if (step.stage === "edit" && step.outcome === "done" && !step.dispatch) {
      const failed = latestFailure(segment);
      if (failed) {
        loops.push({ from: failed, attempt });
        attempt += 1;
      }
      segment = new Map();
    } else if (step.stage === "check" || step.stage === "review" || step.stage === "ci") {
      const key = step.stage === "check" ? `check:${step.command}` : step.stage;
      const previous = segment.get(key);
      if (previous?.outcome !== "failed" || settles(step.outcome)) {
        segment.set(key, { stage: step.stage, outcome: step.outcome, order: steps.length });
      }
    }
    step.attempt = attempt;
    steps.push(step);
  }

  const stages = WORK_STAGES.map((stage): StageView => {
    const own = steps.filter((step) => step.stage === stage);
    const current = stage === "investigate" ? own : own.filter((step) => step.attempt === attempt);
    return {
      stage,
      status: stageStatus(stage, current),
      steps: current,
      earlier: stage === "investigate" ? [] : own.filter((step) => step.attempt < attempt),
    };
  });

  let furthest = -1;
  stages.forEach((view, index) => {
    if (view.status !== "waiting" && view.status !== "failed") furthest = index;
  });
  let next: NextStage | null = null;
  if (steps.length > 0) {
    if (latestFailure(segment)) next = { stage: "edit", returning: true };
    // 지난 단계가 모두 실패했으면(커밋만 실패한 턴 등) 그 단계를 다시 할 차례다.
    else if (furthest < 0) next = { stage: stages.find((view) => view.status !== "waiting")?.stage ?? WORK_STAGES[0], returning: false };
    else if (furthest < WORK_STAGES.length - 1) next = { stage: WORK_STAGES[furthest + 1], returning: false };
  }

  return {
    steps,
    attempt,
    loops,
    stages,
    current: steps.length > 0 ? steps[steps.length - 1].stage : null,
    reached: furthest < 0 ? null : WORK_STAGES[furthest],
    next,
  };
}
