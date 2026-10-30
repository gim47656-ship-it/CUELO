import { readExitCode } from "@/lib/tool-exit-code";
import { isEditToolName, isWriteToolName } from "@/lib/tool-names";
import { isScratchOnlyWrite, readTouchedPaths } from "@/lib/turn-written-files";
import { resolveLocalFilePath } from "@/lib/file-links";
import { getRelativeFilePath } from "@/lib/file-paths";
import type { AssistantContentBlock, ToolCallContent, ToolResultMessage } from "@/lib/types";

/**
 * 한 턴의 작업 흐름: 조사 → 수정 → 검사 → 교차리뷰 → 커밋·푸시 → CI → 배포 단계마다 무슨 일이 있었는지,
 * 실패나 지적으로 수정에 되돌아온 횟수(회차), 그리고 진행 중인 턴의 다음 차례 단계. 전부 도구 호출과 그 결과에서 읽는다 —
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

/**
 * `bash -c '<script>'`처럼 셸에 넘긴 스크립트. `-o errexit`처럼 값을 받는 옵션은 그 값까지 건너뛴다. 셸 내장 `eval '<script>'`도
 * 인자를 공백으로 이은 스크립트를 그 자리에서 실행한다. 없으면 null.
 */
function readShellScript(words: readonly string[]): string | null {
  const at = programIndex(words);
  if (at >= 0 && words[at] === "eval") return at + 1 < words.length ? words.slice(at + 1).join(" ") : null;
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
 * 중립 명령(`neutral`, 기본은 `set` 옵션·`cd`·대입), pipefail 아래 판정 명령 뒤의 출력 정리(tail·head·cat·tee), 마지막
 * `exit`/`exit $?`만 올 수 있고, 그 밖의 명령(trap·`exit 0`·printf …)이 하나라도 있으면 가려졌다고 본다. 파이프 중간(pipefail
 * 없이), `!`, `||`, `&`, 바로 돌아오는 실행기, 뒤따르는 다른 목록도 결과를 가린다. `set -e`는 따지지 않는다.
 */
function traceStatus(
  parsed: ParsedShell,
  decides: (command: ShellCommand) => boolean,
  neutral: (words: readonly string[]) => boolean = isNeutralCommand,
  depth = 0,
): StatusTrace {
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
        const inner = script === null ? null : traceStatus(parseShell(script), decides, neutral, depth + 1);
        if (inner && inner.decisive.length > 0) decisive.push(...inner.decisive);
        else if (decides(command)) decisive.push(command);
        else {
          const at = programIndex(command.words);
          const filter = decided && pipefail && at >= 0 && Object.hasOwn(PIPE_FILTERS, basename(command.words[at]));
          if (!filter && !neutral(command.words) && !isFinalExit(lists, index)) masked = true;
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

/** 실행하지 않고 도움말·버전만 보이는 옵션. `npm test --help`는 검사를 돌리지 않는다. */
const INFO_OPTIONS: Record<string, true> = { "--help": true, "-h": true, "--version": true };

/**
 * node 옵션 가운데 값을 다음 낱말로 받는 것(`--import tsx`). `--test` 앞에 와도 그 값은 실행 대상이 아니다.
 * Node v24.21.0 `node --help`에서 값이 필수(`--opt=...`)인 옵션 전부에, 도움말에 없는 `--loader`·`--experimental-loader`를 더했다.
 * 값이 선택인 옵션(`--inspect[=port]`)은 다음 낱말을 받지 않는다. 인라인 코드 옵션(`-e`·`--eval`)은 테스트 실행이 아니라 뺐다.
 */
const NODE_VALUE_OPTIONS: Record<string, true> = Object.fromEntries([
  "-C", "-r", "--allow-fs-read", "--allow-fs-write", "--build-snapshot-config", "--conditions", "--cpu-prof-dir",
  "--debug-port", "--inspect-port", "--experimental-config-file", "--experimental-default-config-file",
  "--experimental-test-isolation", "--test-isolation", "--report-dir", "--report-directory",
  "--cpu-prof-interval", "--cpu-prof-name", "--diagnostic-dir", "--disable-proto", "--disable-warning", "--dns-result-order",
  "--env-file", "--env-file-if-exists", "--experimental-loader", "--experimental-package-map",
  "--experimental-sea-config", "--experimental-test-tag-filter", "--heap-prof-dir", "--heap-prof-interval", "--heap-prof-name",
  "--heapsnapshot-near-heap-limit", "--heapsnapshot-signal", "--icu-data-dir", "--import", "--input-type",
  "--inspect-publish-uid", "--loader", "--localstorage-file", "--max-http-header-size", "--max-old-space-size-percentage",
  "--network-family-autoselection-attempt-timeout", "--openssl-config", "--redirect-warnings", "--report-filename",
  "--report-signal", "--require", "--run", "--secure-heap", "--secure-heap-min", "--snapshot-blob", "--test-concurrency",
  "--test-coverage-branches", "--test-coverage-exclude", "--test-coverage-functions", "--test-coverage-include",
  "--test-coverage-lines", "--test-global-setup", "--test-name-pattern", "--test-random-seed", "--test-reporter",
  "--test-reporter-destination", "--test-rerun-failures", "--test-shard", "--test-skip-pattern", "--test-timeout", "--title",
  "--tls-cipher-list", "--tls-keylog", "--trace-event-categories", "--trace-event-file-pattern", "--trace-require-module",
  "--unhandled-rejections", "--use-largepages", "--v8-pool-size", "--watch-kill-signal", "--watch-path",
].map((option) => [option, true]));

/**
 * `node --test …`: 실행 대상 앞의 `--test` 옵션은 파일 이름과 관계없이(대상이 없으면 기본 검색으로) 테스트를 실행한다.
 * `--`는 옵션의 끝이라 그 뒤의 `--test`는 실행 대상이다.
 */
function nodeTestMode(words: readonly string[], from: number): boolean {
  for (let i = from; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--test") return true;
    if (word === "--" || !word.startsWith("-")) return false;
    if (Object.hasOwn(NODE_VALUE_OPTIONS, word)) i += 1;
  }
  return false;
}

/**
 * 프로그램 자리에서 검사를 실행하는지: 검사 프로그램이거나, 실행기가 검사 이름의 대상을 실행하거나, `node --test`다. 인자 안의
 * 글자는 보지 않는다. 셸의 조건 명령 `test`·`[`와 도움말·버전만 보이는 명령은 검사가 아니다.
 */
function invokesCheck(words: readonly string[]): boolean {
  const at = programIndex(words);
  if (at < 0) return false;
  const program = basename(words[at]);
  if (program === "test" || program === "[") return false;
  if (words.slice(at + 1).some((word) => Object.hasOwn(INFO_OPTIONS, word))) return false;
  if (CHECK_COMMAND.test(program)) return true;
  if (!Object.hasOwn(CHECK_RUNNERS, program)) return false;
  if (program === "node" && nodeTestMode(words, at + 1)) return true;
  const target = runnerTarget(words, at + 1);
  return target !== undefined && CHECK_COMMAND.test(target);
}

/** 검사 단계 탐색: 프로그램 자리와 실제 `sh -c` 스크립트 안만 본다. */
function runsCheck(words: readonly string[], depth = 0): boolean {
  const script = readShellScript(words);
  if (script !== null) return depth < 3 && parseShell(script).commands.some((command) => runsCheck(command.words, depth + 1));
  return invokesCheck(words);
}

/** git 전역 옵션 가운데 값을 다음 낱말로 받는 것(`git -C repo commit`). */
const GIT_VALUE_OPTIONS: Record<string, true> = { "-C": true, "-c": true, "--git-dir": true, "--work-tree": true, "--namespace": true };
/**
 * 커밋을 남기거나 올리지 않는 하위 명령 옵션. `git push -n`은 dry-run이고 `git push --delete`는 원격 ref를 지울 뿐이다.
 * `git commit -n`은 훅 생략이라 넣지 않는다.
 */
const GIT_NO_COMMIT_OPTIONS: Record<"commit" | "push", Record<string, true>> = {
  commit: { "--dry-run": true, "-h": true, "--help": true },
  push: { "--dry-run": true, "-n": true, "-h": true, "--help": true, "--delete": true, "-d": true },
};

/** 프로그램이 git이면 하위 명령 이름과 그 자리. 아니거나 하위 명령이 없으면 null. */
function gitSubcommand(words: readonly string[]): { name: string; at: number } | null {
  const at = programIndex(words);
  if (at < 0 || basename(words[at]) !== "git") return null;
  for (let i = at + 1; i < words.length; i += 1) {
    if (Object.hasOwn(GIT_VALUE_OPTIONS, words[i])) i += 1;
    else if (!words[i].startsWith("-")) return { name: words[i], at: i };
  }
  return null;
}

/** 커밋을 남기거나 올리는 명령: 프로그램 자리의 `git commit`·`git push`. dry-run·도움말은 아니다. `sh -c` 스크립트 안도 본다. */
function runsGitCommit(words: readonly string[], depth = 0, only?: "commit" | "push"): boolean {
  const script = readShellScript(words);
  if (script !== null) return depth < 3 && parseShell(script).commands.some((command) => runsGitCommit(command.words, depth + 1, only));
  const sub = gitSubcommand(words);
  if (!sub || (sub.name !== "commit" && sub.name !== "push") || (only !== undefined && sub.name !== only)) return false;
  const noWrite = GIT_NO_COMMIT_OPTIONS[sub.name];
  return !words.slice(sub.at + 1).some((word) => Object.hasOwn(noWrite, word) || (sub.name === "push" && /[nd]/.test(clusteredFlags(word, "o"))));
}

/**
 * 묶은 짧은 옵션(`git push -fn`)의 글자들. 값을 받는 글자(`-o <값>`, 붙여 쓴 `-oci.skip`) 뒤는 그 값이라 보지 않는다.
 * 짧은 옵션이 아니면(`--delete`, `-`) 빈 글이다.
 */
function clusteredFlags(word: string, valued: string): string {
  if (!/^-[a-zA-Z0-9]/.test(word)) return "";
  let flags = "";
  for (const letter of word.slice(1)) {
    if (valued.includes(letter) || !/[a-zA-Z0-9]/.test(letter)) break;
    flags += letter;
  }
  return flags;
}

/** 커밋 판정 곁에 와도 되는 명령: 기본 중립 명령과 커밋·푸시가 아닌 git 명령(`git add` 등). 그 git 명령은 커밋의 결과를 바꾸지 않는다. */
function isCommitNeutral(words: readonly string[]): boolean {
  return isNeutralCommand(words) || gitSubcommand(words) !== null;
}

/** 단계마다 판정을 맡는 명령. 그 명령의 종료 코드가 셸 종료 코드까지 그대로 와야 통과다. */
const DECISIVE_COMMAND: Record<JudgedStage, (command: ShellCommand) => boolean> = {
  check: ({ words }) => invokesCheck(words),
  commit: ({ words }) => runsGitCommit(words),
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

type CommandStage = "check" | "ci" | "deploy";
/** bash 명령 하나가 닿을 수 있는 단계: 검사·CI·배포와, 직접 실행한 커밋·푸시(`git commit`·`git push`). */
type JudgedStage = CommandStage | "commit";

/**
 * 명령 하나가 검사·커밋·CI·배포 가운데 둘 이상에 걸친 것. 셸 종료 코드는 명령 전체의 결과 하나뿐이라, 0이 아니면 명령이
 * 실패했다는 것만 알고 어느 단계의 명령이 실패했는지는 모른다(`failed`). 그때 단계마다의 판정은 미확인이다.
 */
export interface CompoundCommand {
  /** 이 명령이 닿은 단계, 단계 차례. */
  stages: JudgedStage[];
  /** 명령 전체가 실패로 끝났는지: 0이 아닌 종료 코드, 또는 종료 코드 없이 오류로 끝난 호출. */
  failed: boolean;
}

export interface CheckRun {
  toolCallId: string;
  command: string;
  state: CheckState;
  /** 결과에 기록된 종료 코드. 없으면 null. */
  exitCode: number | null;
  /** 명령 낱말에서 읽은 검사 이름, 나온 차례대로. 못 읽었으면 빈 배열. */
  labels: CheckLabel[];
  /** 검사와 CI·배포를 한 명령으로 실행했을 때만 있다. */
  compound?: CompoundCommand;
}

function readBashCommand(block: ToolCallContent | null | undefined): string | null {
  if (!block || typeof block !== "object" || block.toolName !== "bash" || !block.input || typeof block.input !== "object" || Array.isArray(block.input)) return null;
  const command = typeof block.input.command === "string" ? block.input.command.trim() : "";
  return command || null;
}

interface CommandJudgement {
  stage: JudgedStage;
  state: CheckState;
  exitCode: number | null;
  labels: CheckLabel[];
  compound?: CompoundCommand;
  /** 판정 명령의 종료 코드를 따로 찍은 줄(`exit=0`)로 판정했으면 그 줄. */
  evidence?: string;
}

/** 바로 앞 명령의 종료 코드만 펼쳐 찍는 echo의 틀. `first`는 `${PIPESTATUS[0]}` — 바로 앞 파이프라인 첫 명령의 종료 코드다. */
interface StatusEcho { prefix: string; suffix: string; first: boolean }

const STATUS_WORDS: Record<string, boolean> = { "$?": false, "${PIPESTATUS[0]}": true };

/** 목록이 `echo "<앞말>$?"` 하나뿐이면 그 틀. 옵션·방향 바꾸기·다른 펼침이 있거나 앞말이 숫자·공백뿐이면 null. */
function readStatusEcho(list: ShellList | undefined): StatusEcho | null {
  const words = list && !list.background ? soleCommand(list)?.words : undefined;
  if (!words || words[0] !== "echo" || words.length < 2) return null;
  const args = words.slice(1);
  // 옵션(-e·-n)이나 방향 바꾸기가 붙으면 그 줄이 출력에 그대로 남는다고 할 수 없다.
  if (args.some((arg) => arg.startsWith("-") || /^(?:\d*[<>]|&>)/.test(arg))) return null;
  const line = args.join(" ");
  for (const [word, first] of Object.entries(STATUS_WORDS)) {
    const at = line.indexOf(word);
    if (at < 0 || line.indexOf(word, at + 1) >= 0) continue;
    const prefix = line.slice(0, at);
    const suffix = line.slice(at + word.length);
    if (/[$`\\]/.test(prefix + suffix) || !/[^\s\d]/.test(prefix)) return null;
    return { prefix, suffix, first };
  }
  return null;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface EchoedStatus { code: number; line: string }

/**
 * 판정 명령마다 바로 다음 echo가 찍은 그 종료 코드(`cmd; echo "exit=$?"`). 판정 명령은 그 목록의 마지막 파이프라인에 있어야
 * 하고(`$?`는 혼자인 명령, `${PIPESTATUS[0]}`은 파이프라인의 첫 명령), 그 앞은 `&&`로 이은 중립 명령뿐이어야 한다. 같은 틀의
 * echo 수와 출력에서 그 틀에 맞는 줄 수가 같을 때만 차례대로 짝짓는다 — 판정 명령이 같은 모양의 줄을 찍었으면 모른다.
 */
function readEchoedStatuses(
  parsed: ParsedShell,
  decides: (command: ShellCommand) => boolean,
  neutral: (words: readonly string[]) => boolean,
  output: string,
): Map<ShellCommand, EchoedStatus> {
  const echoed = new Map<ShellCommand, EchoedStatus>();
  const echoes = parsed.lists.map((list) => readStatusEcho(list));
  const lines = output.split("\n").map((line) => line.trimEnd());
  parsed.lists.forEach((list, index) => {
    const echo = echoes[index + 1];
    if (!echo || list.background || list.operators.includes("||")) return;
    const last = list.pipelines[list.pipelines.length - 1];
    const before = list.pipelines.slice(0, -1);
    if (last.negated || before.some((pipeline) => pipeline.negated || pipeline.commands.length !== 1 || !neutral(pipeline.commands[0].words))) return;
    const command = echo.first || last.commands.length === 1 ? last.commands[0] : undefined;
    if (!command || !decides(command) || detaches(command.words) || /[(){}!`]/.test(command.text)) return;
    const same = echoes.filter((other) => other?.prefix === echo.prefix && other.suffix === echo.suffix);
    const pattern = new RegExp(`^${escapeRegExp(echo.prefix)}(-?\\d+)${escapeRegExp(echo.suffix.trimEnd())}$`);
    const found = lines.flatMap((line) => {
      const match = pattern.exec(line);
      return match ? [{ code: Number(match[1]), line }] : [];
    });
    if (found.length !== same.length) return;
    const position = echoes.slice(0, index + 2).filter((other) => same.includes(other)).length - 1;
    echoed.set(command, found[position]);
  });
  return echoed;
}

/**
 * bash 명령 하나가 닿은 단계(검사·커밋·CI·배포, 단계 차례)마다의 판정. 단계는 실행 위치로만 찾는다. 아무 단계도 아니면 빈 배열.
 * 한 단계뿐인 명령은 0이 아닌 종료 코드가 그 단계의 실패다. 여러 단계에 걸친 명령은 종료 코드가 어느 단계 것인지 모르므로
 * 실패를 어느 단계에도 붙이지 않고(`compound.failed`), 0으로 끝났을 때만 단계마다 기존 증명 규칙으로 통과를 가린다. 판정
 * 명령마다 바로 뒤 echo가 그 종료 코드를 찍었으면(`readEchoedStatuses`) 그 값이 그 단계의 판정이다.
 */
function judgeCommand(command: string, recorded: ToolResultMessage | undefined): CommandJudgement[] {
  const skipped = harnessSkip(recorded);
  if (skipped === "notRun") return [];
  // 시작했지만 끊긴 호출의 결과 글은 명령의 결과가 아니다.
  const result = skipped ? undefined : recorded;
  const parsed = parseShell(command);
  const stages: JudgedStage[] = [];
  if (parsed.commands.some(({ words }) => runsCheck(words))) stages.push("check");
  if (parsed.commands.some(({ words }) => runsGitCommit(words))) stages.push("commit");
  if (parsed.commands.some(({ words }) => runsCi(words))) stages.push("ci");
  if (parsed.commands.some(DECISIVE_COMMAND.deploy)) stages.push("deploy");
  if (stages.length === 0) return [];
  const exitCode = result ? readExitCode(result) : null;
  const failed = exitCode === null ? Boolean(result?.isError) : exitCode !== 0;
  const compound = stages.length > 1 ? { stages, failed } : undefined;
  const output = result ? resultText(result) : "";
  return stages.map((stage) => {
    const neutral = stage === "commit" ? isCommitNeutral : isNeutralCommand;
    const trace = traceStatus(parsed, DECISIVE_COMMAND[stage], neutral);
    // `--if-present`는 스크립트가 없으면 아무것도 실행하지 않고 0으로 끝난다. 그 0은 검사가 돌았다는 증거가 아니다.
    const optional = stage === "check" && trace.decisive.some(({ words }) => words.includes("--if-present"));
    const echoed = result ? readEchoedStatuses(parsed, DECISIVE_COMMAND[stage], neutral, output) : new Map<ShellCommand, EchoedStatus>();
    const shown = trace.decisive.flatMap((decisive) => echoed.get(decisive) ?? []);
    const deciding = shown.length > 0 && shown.length === trace.decisive.length ? shown.find(({ code }) => code !== 0) ?? shown[0] : null;
    // 종료 코드가 기록되지 않은 결과(백그라운드로 넘어간 실행 등)는 성공으로 치지 않는다.
    const state: CheckState = deciding
      ? (deciding.code !== 0 ? "failed" : optional ? "unverified" : "passed")
      : failed ? (compound ? "unverified" : "failed")
      : exitCode === null ? "unobserved"
      : trace.reach === "carried" && !optional ? "passed" : "unverified";
    return {
      stage,
      state,
      exitCode,
      labels: stage === "check" ? readCheckLabels(trace.decisive) : [],
      ...(compound ? { compound } : {}),
      ...(deciding ? { evidence: deciding.line } : {}),
    };
  });
}

/** bash 호출 하나를 검사로 읽는다. 검사 명령이 없으면 null. CI·배포와 한 명령이면 `compound`가 붙는다. */
export function readCheckRun(block: ToolCallContent | null | undefined, result: ToolResultMessage | undefined): CheckRun | null {
  const command = readBashCommand(block);
  const judged = command === null ? undefined : judgeCommand(command, result).find((entry) => entry.stage === "check");
  if (command === null || !judged) return null;
  return { toolCallId: block!.toolCallId, command, state: judged.state, exitCode: judged.exitCode, labels: judged.labels, ...(judged.compound ? { compound: judged.compound } : {}) };
}

/* ---------- 단계 사건 ---------- */

/** 단계 사건 하나의 결과. 진행 중(running)은 아직 끝나지 않은 턴에서 결과가 오지 않은 호출이다. */
export type StepOutcome = "running" | "done" | CheckState;

interface StepCore {
  toolCallId: string;
  /** 이 사건이 일어난 회차(1부터). */
  attempt: number;
  outcome: StepOutcome;
  /**
   * 통과·완료로 끝났지만 그 뒤에 성공한 직접 수정이 있었다. 결과는 사실이지만 마지막 수정본을 보증하지 않는다.
   * 문서만 고친 수정도 예외가 아니다.
   */
  stale?: true;
}

export interface PlainStep extends StepCore {
  stage: "investigate" | "edit";
  /** 발주(task). 결과가 와도 맡긴 수정이 끝났다는 뜻은 아니어서 회차를 늘리지 않는다. */
  dispatch?: boolean;
  /**
   * 작업 기록(`isWorkRecordFile`)만 고친 수정. 앞선 커밋의 CI·배포 결과는 그대로 그 커밋의 사실이라 수정 전 결과로 돌리지
   * 않는다. 검사·리뷰는 다른 수정처럼 수정 전 결과가 된다.
   */
  recordOnly?: true;
}

/** 검사·CI·배포: 실행한 bash 명령과 기록된 종료 코드. 검사 이름은 검사 단계에서만 읽는다. */
export interface CommandStep extends StepCore {
  stage: CommandStage;
  command: string;
  /** 압축된 요청의 명령 본문을 생략해도 같은 검사 명령끼리 묶기 위한 요청 안의 식별자. */
  commandKey?: string;
  exitCode: number | null;
  labels: CheckLabel[];
  /** 여러 단계에 걸친 명령이면 그 단계들과 명령 전체의 실패 여부. 같은 호출이 단계마다 사건 하나씩 남긴다. */
  compound?: CompoundCommand;
  /**
   * 이 호출의 셸 종료 코드가 아닌 기록으로 판정했으면 그 기록 한 줄: 판정 명령 뒤 echo가 찍은 종료 코드(`exit=0`), 백그라운드
   * job의 완료 기록(`bg_3 · Command exited with code 0`), 배포 로그의 결과 줄(`READY 94661c1`), 커밋에 이어진 CI 실행 기록.
   */
  evidence?: string;
  /**
   * 기다린 실행의 결과를 CI 판정에서 뺐으면 그 결과와 까닭: 기록상 다른 커밋(`commit`, 앞 7자리)의 실행이었거나, CI 조회와
   * 한 명령에서 기다린 실행이 모두 게시 실행(`publish`)이었거나, 같은 명령이 본 그 실행이 통과도 실패도 아닌
   * conclusion(`unjudged`, skipped 등)으로 끝났다.
   */
  otherRun?: { kind: "commit"; sha: string; outcome: "passed" | "failed" } | { kind: "publish"; outcome: "passed" | "failed" } | { kind: "unjudged"; conclusion: string };
}

/**
 * 교차리뷰: review는 받은 지적 수, resolve는 남은 지적 수. 결과를 못 읽었으면 null. `unusable`은 리뷰어 답을 쓸 수
 * 없었던 review(호출 실패·파싱 불가, `passable:false`)다 — 지적이 0건이어도 리뷰가 성립하지 않았으므로 판정 미확인이다.
 */
export interface ReviewStep extends StepCore {
  stage: "review";
  action: "review" | "resolve";
  findings: number | null;
  unusable?: true;
}

/**
 * 커밋·푸시: 결과에 기록된 커밋. `docsOnly`는 넘긴 파일이 모두 문서인 성공한 커밋이다. 문서는 확장자가 `.md`·`.mdx`·
 * `.markdown`·`.txt`이거나 `doc`·`docs` 폴더 아래(대소문자 무시)에 있는 파일이다 — 작업 기록의 evidence JSON도 문서다.
 */
export interface CommitStep extends StepCore {
  stage: "commit";
  commit: string | null;
  docsOnly: boolean;
  /** 커밋 메시지 첫 줄. 공개 미러의 CI 실행을 제목으로 잇는 데만 쓴다. 기록에 없으면 없다. */
  title?: string;
}

const DOC_FILE = /\.(?:md|mdx|markdown|txt)$/i;
const DOC_FOLDER = /^docs?$/i;

function isDocFile(file: string): boolean {
  return DOC_FILE.test(file) || file.split(/[\\/]/).slice(0, -1).some((segment) => DOC_FOLDER.test(segment));
}

/**
 * 실행에 쓰이지 않는다고 정해진 작업 기록: `doc/history/` 아래와 `HANDOFF.md`. 다른 문서(AGENTS·규칙·skill·프롬프트·README 등)는
 * 빌드·실행 입력일 수 있어 기록이 아니다.
 */
function isWorkRecordFile(file: string, cwd: string | undefined): boolean {
  // 위로 올라가는 원 경로는 정규화해서 작업 기록으로 승격하지 않는다.
  if (file.split(/[\\/]/).includes("..")) return false;
  const base = cwd ? resolveLocalFilePath(cwd) ?? cwd : undefined;
  const own = getRelativeFilePath(resolveLocalFilePath(file, cwd) ?? file, base);
  // 작업 폴더 밖이거나, 절대 경로를 상대화할 폴더를 모르면 기록이라고 단정하지 않는다.
  if (/^[\\/]/.test(own) || /^[a-zA-Z]:[\\/]/.test(own)) return false;
  const segments = own.split(/[\\/]/).filter((segment) => segment !== "" && segment !== ".");
  return segments.at(-1) === "HANDOFF.md"
    || (segments[0] === "doc" && segments[1] === "history" && segments.length > 2);
}

/** 고친 경로를 모두 알고(지운 파일 포함) 그것이 모두 작업 기록인 쓰기·수정. */
function isRecordOnlyEdit(block: ToolCallContent, result: ToolResultMessage | undefined, cwd: string | undefined): boolean {
  if (!result || !(isWriteToolName(block.toolName) || isEditToolName(block.toolName))) return false;
  const paths = readTouchedPaths(block.input, result);
  return paths.length > 0 && paths.every((path) => isWorkRecordFile(path, cwd));
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

/** 작업용 임시 경로에만 쓴 쓰기·수정(`isScratchOnlyWrite`). 고친 결과가 아니라 조사의 산출물이다. */
function isScratchWrite(block: ToolCallContent, result: ToolResultMessage | undefined, cwd: string | undefined): boolean {
  return (isWriteToolName(block.toolName) || isEditToolName(block.toolName)) && isScratchOnlyWrite(block.input, result, cwd);
}

function readSteps(block: ToolCallContent, result: ToolResultMessage | undefined, live: boolean, cwd: string | undefined): WorkStep[] {
  const step = readStep(block, result, live, cwd);
  if (Array.isArray(step)) return step;
  return step ? [step] : [];
}

function readStep(block: ToolCallContent, recorded: ToolResultMessage | undefined, live: boolean, cwd: string | undefined): WorkStep | WorkStep[] | null {
  if (!block.input || typeof block.input !== "object" || Array.isArray(block.input) || typeof block.toolName !== "string") return null;
  const skipped = harnessSkip(recorded);
  if (skipped === "notRun") return null;
  const core = { toolCallId: block.toolCallId, attempt: 0 };
  const pending: StepOutcome = live && !skipped ? "running" : "unobserved";
  const command = readBashCommand(block);
  if (command !== null) {
    const job = readBackgroundJob(recorded);
    return judgeCommand(command, recorded).map((judged): WorkStep => {
      if (judged.stage === "commit") {
        const outcome = recorded ? (judged.state === "unobserved" && showsGitWrites(command, recorded) ? "done" : COMMIT_OUTCOME[judged.state]) : pending;
        return { ...core, stage: "commit", ...(outcome === "done" ? readGitCommit(recorded) : { commit: null }), docsOnly: false, outcome };
      }
      const own = judged.evidence ?? (job && judged.exitCode !== null ? `Command exited with code ${judged.exitCode}` : undefined);
      const evidence = own && job ? `${job.jobId} · ${own}` : own;
      // 실패로 끝난 watch가 같은 명령에서 본 그 실행이 통과도 실패도 아닌 conclusion(skipped 등)이면 그 실패는 CI 판정이 아니다.
      const conclusion = judged.stage === "ci" && judged.state === "failed" && recorded ? unjudgedWatchedRun(command, recorded) : null;
      return {
        ...core,
        stage: judged.stage,
        command,
        exitCode: judged.exitCode,
        labels: judged.labels,
        outcome: conclusion ? "unverified" : recorded ? judged.state : pending,
        ...(judged.compound ? { compound: judged.compound } : {}),
        ...(evidence ? { evidence: conclusion ? `${evidence} · ${conclusion}` : evidence } : {}),
        ...(conclusion ? { otherRun: { kind: "unjudged" as const, conclusion } } : {}),
      };
    });
  }
  // 확장 이름공간(`ext.edit` 등)은 마지막 이름만 본다. 시작했지만 끊긴 호출은 결과를 모른다.
  const name = block.toolName.toLowerCase().split(/[.:/]/).pop() ?? "";
  const result = skipped ? undefined : recorded;
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
    if (findings !== null && findings > 0) return { ...core, stage: "review", action, findings, outcome: "failed" };
    const reviewers: unknown[] = Array.isArray(details.reviewers) ? details.reviewers : [];
    const unusable = details.passable === false
      || reviewers.some((reviewer) => !reviewer || typeof reviewer !== "object" || !("status" in reviewer) || reviewer.status !== "ok");
    if (unusable) return { ...core, stage: "review", action, findings, outcome: "unverified", unusable: true };
    return { ...core, stage: "review", action, findings, outcome: findings === null ? "unobserved" : "done" };
  }
  if (name === "git_finalize") {
    const title = typeof block.input.message === "string" ? commitTitle(block.input.message) : undefined;
    const titled = title ? { title } : {};
    if (!result) return { ...core, stage: "commit", commit: null, docsOnly: false, ...titled, outcome: pending };
    // 성공은 결과가 밝힌 것만이다: `details.ok: true`, 커밋 SHA(details나 결과 글의 `Committed and pushed <SHA>`).
    // 오류이거나 `ok: false`면 실패이고, 그 밖은 결과 미관측이다.
    const sha = publishedSha(result, details);
    const failed = result.isError || details.ok === false;
    const ok = !failed && (details.ok === true || sha !== null);
    const files: unknown = block.input.files;
    const docsOnly = ok && Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === "string" && isDocFile(file));
    return { ...core, stage: "commit", commit: ok ? sha : null, docsOnly, ...titled, outcome: ok ? "done" : failed ? "failed" : "unobserved" };
  }
  if (name === "git_integrate") {
    // 세션 worktree 브랜치를 대상 브랜치에 게시한 호출이다. 대상에 밀어 올린 SHA가 있을 때만 커밋 단계를 마쳤고, 충돌로 멈춘 결과
    // (`ok: false`, 오류 아님)와 던진 오류는 실패다. 되돌리기(abort)와 올릴 것이 없던 호출(up-to-date)은 게시 시도가 아니다.
    if (block.input.action === "abort" || details.stage === "up-to-date") return null;
    if (!result) return { ...core, stage: "commit", commit: null, docsOnly: false, outcome: pending };
    const sha = publishedSha(result, details);
    const failed = result.isError || details.ok === false;
    const ok = !failed && sha !== null;
    const files: unknown = details.files;
    const docsOnly = ok && Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === "string" && isDocFile(file));
    return { ...core, stage: "commit", commit: ok ? sha : null, docsOnly, outcome: ok ? "done" : failed ? "failed" : "unobserved" };
  }
  if (name === "eval") return readEvalCommit(block, result, pending);
  if (isEditCall(block, name)) {
    // 실패한 수정과 거절된 발주는 아무것도 바꾸지 않았다. 시작했지만 끊긴 수정은 썼는지 기록이 없다: 결과 미관측이고,
    // 관측된 수정이 아니라서 앞선 통과를 수정 전 통과로 돌리지 않고 회차도 늘리지 않는다.
    if (!skipped && recorded?.isError) return null;
    if (isScratchWrite(block, result, cwd)) return { ...core, stage: "investigate", outcome: skipped ? "unobserved" : recorded || !live ? "done" : "running" };
    return {
      ...core,
      stage: "edit",
      outcome: result ? "done" : pending,
      ...(name === "task" ? { dispatch: true } : {}),
      ...(isRecordOnlyEdit(block, result, cwd) ? { recordOnly: true as const } : {}),
    };
  }
  if (Object.hasOwn(INVESTIGATE_TOOLS, name)) return { ...core, stage: "investigate", outcome: skipped ? "unobserved" : recorded || !live ? "done" : "running" };
  return null;
}

/* ---------- 커밋 기록 ---------- */

/** 셸 판정을 커밋 사건의 결과로: 통과는 완료다. */
const COMMIT_OUTCOME: Record<CheckState, StepOutcome> = { passed: "done", failed: "failed", unverified: "unverified", unobserved: "unobserved" };

/** 커밋 메시지의 첫 줄. 비었으면 없다. */
function commitTitle(message: string): string | undefined {
  return message.split("\n")[0].trim() || undefined;
}

/** `git commit`이 찍는 `[main 94661c1] 제목` 줄. 분리된 HEAD(`[detached HEAD 94661c1]`)와 첫 커밋(`(root-commit)`)도 같다. */
const GIT_COMMIT_LINE = /^\[[^\]\n]*? ([0-9a-f]{7,40})\] (.+)$/m;
/** `git push`가 찍는 `4c570d7..94661c1  main -> main` 줄. 뒤 SHA가 올린 커밋이다. */
const GIT_PUSH_LINE = /^\s*\+?[0-9a-f]{7,40}\.{2,3}([0-9a-f]{7,40})\s+\S+\s+->\s+\S+/m;

/** 성공한 `git commit`·`git push` 출력에 찍힌 커밋(앞자리 SHA)과 제목. 못 읽었으면 커밋은 null이다. */
function readGitCommit(result: ToolResultMessage | undefined): { commit: string | null; title?: string } {
  const text = result ? resultText(result) : "";
  const made = GIT_COMMIT_LINE.exec(text);
  if (made) return { commit: made[1], title: made[2].trim() };
  return { commit: GIT_PUSH_LINE.exec(text)?.[1] ?? null };
}

/**
 * 종료 코드가 기록되지 않은 결과에서 git이 직접 찍은 성공 줄. 명령에 든 커밋에는 `[main 94661c1] 제목` 줄이, 푸시에는
 * `a..b  main -> main` 줄이 있어야 한다. 오류로 끝난 결과는 아니다.
 */
function showsGitWrites(command: string, result: ToolResultMessage): boolean {
  if (result.isError) return false;
  const { commands } = parseShell(command);
  const text = resultText(result);
  const runs = (only: "commit" | "push") => commands.some(({ words }) => runsGitCommit(words, 0, only));
  return (!runs("commit") || GIT_COMMIT_LINE.test(text)) && (!runs("push") || GIT_PUSH_LINE.test(text));
}

/**
 * 하네스가 대신 남긴 결과. `notRun`은 실행하지 않은 호출의 합성 결과(`details.executed: false`)라 아무 일도 없었다.
 * `interrupted`는 시작했지만 끊은 호출(`details.__interrupted`)이라 결과를 모른다.
 */
function harnessSkip(result: ToolResultMessage | undefined): "notRun" | "interrupted" | null {
  const details: unknown = result?.details;
  if (!details || typeof details !== "object") return null;
  if ("__synthetic" in details && details.__synthetic === true && "executed" in details && details.executed === false) return "notRun";
  return "__interrupted" in details && details.__interrupted === true ? "interrupted" : null;
}

/** eval 코드가 실제로 부르는 `tool.git_finalize(`·`tool.git_integrate(`. 이름을 글자로만 다루는 코드(`name === 'git_finalize'`)는 아니다. */
const EVAL_FINALIZE_CALL = /\btool\.git_(?:finalize|integrate)\s*\(/;
/**
 * 게시한 커밋: git_finalize 결과 글(`Committed and pushed <SHA> to …`), git_integrate 결과 글(`Integrated <브랜치> and pushed <SHA> to …`),
 * 결과 details(`commitSha: '<SHA>'`).
 */
const FINALIZED_COMMIT = /\b(?:Committed|Integrated \S+) and pushed ([0-9a-f]{40})\b|\bcommitSha["']?\s*:\s*["']([0-9a-f]{40})["']/;
/**
 * git_finalize·git_integrate가 거절하거나 실패한 기록: 던진 오류(`git_finalize failed at cross-review: …`)와, 돌려준 결과의 `ok: false`나
 * complete가 아닌 stage(`stage: 'cross-review'`, git_integrate의 `stage: 'conflict'`).
 */
const FINALIZE_FAILED = /\bgit_(?:finalize|integrate) failed\b|\bok["']?\s*:\s*false\b|\bstage["']?\s*:\s*["'](?!complete["'])[\w-]+["']/;
/** 게시 시도가 아닌 git_integrate 결과: 올릴 것이 없었거나(up-to-date) 되돌렸다(aborted). */
const INTEGRATE_UNPUBLISHED = /\bstage["']?\s*:\s*["'](?:up-to-date|aborted)["']/;
/** 코드에 글자 그대로 넘긴 커밋 메시지(`message: "…"`). 변수로 넘겼으면 읽지 않는다. */
const MESSAGE_LITERAL = /["']?\bmessage["']?\s*:\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\])*)\1/;

/** 결과가 밝힌 게시 커밋 SHA: details의 `commitSha`, 없거나 비었으면 결과 글(FINALIZED_COMMIT). */
function publishedSha(result: ToolResultMessage, details: Record<string, unknown>): string | null {
  if (typeof details.commitSha === "string" && details.commitSha.trim() !== "") return details.commitSha.trim();
  const pushed = FINALIZED_COMMIT.exec(resultText(result));
  return pushed?.[1] ?? pushed?.[2] ?? null;
}

function evalCode(input: Record<string, unknown>): string {
  if (typeof input.code === "string") return input.code;
  const cells: unknown = input.cells;
  if (!Array.isArray(cells)) return "";
  return cells.map((cell) => (cell && typeof cell === "object" && "code" in cell && typeof cell.code === "string" ? cell.code : "")).join("\n");
}

/**
 * eval에서 부른 git_finalize·git_integrate. 결과(백그라운드였으면 완료 기록)에 밀어 올린 커밋 SHA가 찍혔을 때만 완료다. 실패 기록이 찍혔거나
 * 셀이 오류로 끝났는데 SHA가 없으면 실패다. SHA와 실패 기록이 함께 있으면(셀 안의 다른 코드가 실패했을 수도 있다) 결과 미관측이다.
 * git_integrate가 올릴 것이 없었거나 되돌린 결과(SHA 없음)는 게시 시도가 아니다.
 */
function readEvalCommit(block: ToolCallContent, result: ToolResultMessage | undefined, pending: StepOutcome): CommitStep | null {
  const code = evalCode(block.input);
  if (!EVAL_FINALIZE_CALL.test(code)) return null;
  const message = MESSAGE_LITERAL.exec(code)?.[2];
  const title = message === undefined ? undefined : commitTitle(message.replace(/\\n/g, "\n").replace(/\\(["'`\\])/g, "$1"));
  const base = { toolCallId: block.toolCallId, attempt: 0, stage: "commit" as const, docsOnly: false, ...(title ? { title } : {}) };
  if (!result) return { ...base, commit: null, outcome: pending };
  const text = resultText(result);
  const pushed = FINALIZED_COMMIT.exec(text);
  const sha = pushed ? (pushed[1] ?? pushed[2]).toLowerCase() : null;
  if (!sha && INTEGRATE_UNPUBLISHED.test(text)) return null;
  const failed = FINALIZE_FAILED.test(text);
  if (sha && !failed) return { ...base, commit: sha, outcome: "done" };
  return { ...base, commit: null, outcome: !sha && (failed || result.isError) ? "failed" : "unobserved" };
}

/* ---------- 백그라운드 job ---------- */

/**
 * 블록 밖에 기록되는 백그라운드 job 완료 통지(async-result custom 메시지)의 글과, 그 통지 바로 앞 도구 호출 id(앞에 없으면
 * null). 완료가 어느 호출 뒤에 기록됐는지는 그 자리로만 안다.
 */
export interface JobNotice {
  text: string;
  after: string | null;
}

/** 백그라운드 job 하나의 완료 기록: job id, 그 job이 남긴 출력, 기록에 있으면 종료 코드. */
interface JobCompletion { jobId: string; text: string; exitCode: number | null }

/** 완료 기록으로 바꾼 결과(`resolveBackgroundResults`)의 details에 붙는 표시: 어느 job이, 어느 호출 뒤에 끝났다고 기록됐는지. */
interface BackgroundJob { jobId: string; after: string }

const JOB_ID = /^bg_\d+$/;

function readBackgroundJob(result: ToolResultMessage | undefined): BackgroundJob | null {
  const details = result?.details;
  const job: unknown = details && typeof details === "object" && "backgroundJob" in details ? details.backgroundJob : null;
  if (!job || typeof job !== "object" || !("jobId" in job) || !("after" in job)) return null;
  return typeof job.jobId === "string" && typeof job.after === "string" ? { jobId: job.jobId, after: job.after } : null;
}

/** 백그라운드로 넘어간 호출의 job id: 결과 details의 `async.jobId`, 없으면 「Backgrounded … as job bg_N」로 시작하는 결과 글. */
function launchedJob(result: ToolResultMessage): string | null {
  const details = result.details;
  const async: unknown = details && typeof details === "object" && "async" in details ? details.async : null;
  if (async && typeof async === "object" && "jobId" in async && typeof async.jobId === "string" && JOB_ID.test(async.jobId)) return async.jobId;
  const text = resultText(result).trimStart();
  return text.startsWith("Backgrounded") ? /\bBackgrounded as job (bg_\d+)\b/.exec(text)?.[1] ?? null : null;
}

function completion(jobId: string, text: string): JobCompletion {
  const footer = /Command exited with code (-?\d+)\s*$/.exec(text.trimEnd());
  return { jobId, text, exitCode: footer ? Number(footer[1]) : null };
}

/** `wait` 결과의 끝난 job들: details.jobs에 출력이 실린 것, 없으면 글의 `### bg_N [bash] — completed` 절의 코드 블록. */
function readWaitCompletions(result: ToolResultMessage): JobCompletion[] {
  const details = result.details;
  const jobs: unknown = details && typeof details === "object" && "jobs" in details ? details.jobs : null;
  const recorded = (Array.isArray(jobs) ? jobs : []).flatMap((job: unknown): JobCompletion[] => {
    if (!job || typeof job !== "object" || !("id" in job) || !("status" in job) || !("resultText" in job)) return [];
    if (typeof job.id !== "string" || !JOB_ID.test(job.id) || (job.status !== "completed" && job.status !== "failed") || typeof job.resultText !== "string") return [];
    const exitCode = "exitCode" in job && typeof job.exitCode === "number" ? job.exitCode : null;
    return [{ ...completion(job.id, job.resultText), ...(exitCode === null ? {} : { exitCode }) }];
  });
  if (recorded.length > 0) return recorded;
  const text = resultText(result);
  const heads = [...text.matchAll(/^### (bg_\d+) \[\w+\] — (?:completed|failed)$/gm)];
  return heads.map((head, index) => {
    const start = (head.index ?? 0) + head[0].length;
    const section = text.slice(start, index + 1 < heads.length ? heads[index + 1].index : text.length);
    const open = section.indexOf("\n```\n");
    const close = section.lastIndexOf("\n```");
    return completion(head[1], open >= 0 && close > open ? section.slice(open + 5, close) : "");
  });
}

/** async-result 통지 글의 끝난 job들: 하나면 「Background job bg_N has completed…」 뒤, 여럿이면 `── Job bg_N (…) ──` 절마다. */
function readNoticeCompletions(text: string): JobCompletion[] {
  const body = text.replace(/^\s*<system-notice>\s*\n?/, "").replace(/\s*<\/system-notice>\s*$/, "");
  const single = /^Background job (bg_\d+) has (?:completed|failed)\b[^\n]*(?:\n|$)/.exec(body);
  if (single) return [completion(single[1], body.slice(single[0].length))];
  const heads = [...body.matchAll(/^── Job (\S+) .*──$/gm)];
  return heads.flatMap((head, index) => {
    if (!JOB_ID.test(head[1])) return [];
    const start = (head.index ?? 0) + head[0].length;
    return [completion(head[1], body.slice(start, index + 1 < heads.length ? heads[index + 1].index : body.length).replace(/^\n/, ""))];
  });
}

/** `read proc://bg_N`가 끝난 job을 보였으면(`1|bg_N [bash] — completed — …`) 줄 번호를 뗀 출력. */
function readProcCompletion(block: ToolCallContent, result: ToolResultMessage): JobCompletion | null {
  const path = block.input.path;
  const id = typeof path === "string" ? /^proc:\/\/(bg_\d+)$/.exec(path)?.[1] : undefined;
  if (!id) return null;
  const [head, ...lines] = resultText(result).split("\n");
  if (!new RegExp(`^1\\|${id} \\[\\w+\\] — (?:completed|failed)\\b`).test(head)) return null;
  return completion(id, lines.map((line) => line.replace(/^\d+\|/, "")).join("\n"));
}

/**
 * 턴의 도구 호출마다 판정에 쓸 결과. 백그라운드로 넘어간 bash·eval 호출은 그 뒤에 기록된 그 job의 첫 완료(`wait` 결과,
 * `read proc://bg_N`, async-result 통지)로 바꾼다 — 서버가 다시 떠 같은 id가 다시 쓰이면 새 실행이 그 뒤 완료를 받는다.
 * 완료 기록이 없는 백그라운드 호출은 결과가 없는 호출처럼 빠진다(진행 중 / 결과 미관측). job 상태 말(completed·failed)은
 * 판정에 쓰지 않는다 — 판정은 출력과 종료 코드로만 한다. 값에는 그 턴 호출의 결과만 있다.
 */
export function resolveBackgroundResults(
  blocks: readonly AssistantContentBlock[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  notices: readonly JobNotice[] = [],
): Map<string, ToolResultMessage> {
  const resolved = new Map<string, ToolResultMessage>();
  const waiting = new Map<string, { toolCallId: string; result: ToolResultMessage }>();
  const noticesAfter = new Map<string, JobNotice[]>();
  for (const notice of notices) {
    if (notice.after !== null) noticesAfter.set(notice.after, [...(noticesAfter.get(notice.after) ?? []), notice]);
  }
  const settle = (completions: readonly JobCompletion[], after: string) => {
    for (const done of completions) {
      const launch = waiting.get(done.jobId);
      if (!launch) continue;
      waiting.delete(done.jobId);
      resolved.set(launch.toolCallId, {
        ...launch.result,
        isError: false,
        content: [{ type: "text", text: done.text }],
        details: { ...(done.exitCode === null ? {} : { exitCode: done.exitCode }), backgroundJob: { jobId: done.jobId, after } },
      });
    }
  };
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || block.type !== "toolCall") continue;
    const result = toolResults.get(block.toolCallId);
    if (result) {
      const job = block.toolName === "bash" || block.toolName === "eval" ? launchedJob(result) : null;
      if (job) waiting.set(job, { toolCallId: block.toolCallId, result });
      else resolved.set(block.toolCallId, result);
      if (block.toolName === "wait") settle(readWaitCompletions(result), block.toolCallId);
      const proc = block.toolName === "read" ? readProcCompletion(block, result) : null;
      if (proc) settle([proc], block.toolCallId);
    }
    for (const notice of noticesAfter.get(block.toolCallId) ?? []) settle(readNoticeCompletions(notice.text), block.toolCallId);
  }
  return resolved;
}

/* ---------- 흐름 ---------- */

/** 수정에 되돌아온 일 하나. */
export interface LoopBack {
  /** 되돌아오게 한 실패나 지적이 있던 단계. */
  from: "check" | "review" | "ci";
  /** 실패한 회차. 되돌아온 뒤의 회차는 이보다 하나 크다. */
  attempt: number;
}

/**
 * `skipped`: 뒤 단계가 이미 지나간 빈 단계, 또는 끝난 턴에서 들어가지 않은 단계(건너뜀). `notNeeded`: 할 일이 없는 CI·배포 —
 * 문서만 바꾼 커밋 뒤의 배포, 공개 저장소가 바뀌지 않은 비공개 게시 뒤의 CI(`WorkFlow.publication`), 그리고 끝난 턴에서
 * 성공한 커밋이 없거나 마지막 성공한 커밋이 문서만 바꿨을 때 들어가지 않은 CI·배포. `stale`: 이 단계의 결과가 모두 그 뒤의
 * 수정보다 앞선다. 끝난 턴에는 `waiting`이 남지 않는다.
 */
export type StageStatus = "waiting" | "skipped" | "notNeeded" | "stale" | StepOutcome;

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

/**
 * 비공개 커밋의 게시가 공개 저장소를 바꾸지 않았다는 관측. 공개 저장소에 새 커밋이 없으면 공개 CI가 돌지 않는다(비공개
 * 저장소의 CI 잡은 손으로 띄울 때만 돈다, `.github/workflows/ci.yml`).
 * - `publicHeadUnchanged`: 마지막 커밋 뒤 그 커밋의 「Publish public mirror」 실행이 성공했고, 그 뒤 공개 저장소 `repo`의
 *   `ref`가 커밋 전부터 CI 성공이 기록된 `sha` 그대로였다. `runId`는 게시 실행 id다.
 * - `nothingToPublish`: 마지막 커밋 뒤 한 명령이 그 커밋(`commit`, 전체 SHA)의 게시 실행 로그에서 게시 워크플로가 남기는
 *   「Public tree already matches; nothing to publish」를 걸러 냈다. 실행 id와 공개 head는 기록에 없다.
 */
export type PublicationEvidence =
  | { kind: "publicHeadUnchanged"; repo: string; ref: string; sha: string; runId: string }
  | { kind: "nothingToPublish"; commit: string };

export interface WorkFlow {
  steps: WorkStep[];
  /** 지금 회차(1부터). */
  attempt: number;
  loops: LoopBack[];
  /** WORK_STAGES 차례. */
  stages: StageView[];
  /** 지금 단계: 가장 나중 사건의 단계. 성공한 커밋 뒤에는 아직 끝나지 않은 CI·배포(`currentStage`). 사건이 없으면 null. */
  current: WorkStage | null;
  /** 지금 회차에서 실패하지 않고 마지막 수정 뒤에 지난 가장 뒤 단계(조사는 모든 회차). 없으면 null. */
  reached: WorkStage | null;
  /** 다음 차례 단계. 진행 중인 턴에서만 정한다. 사건이 없거나 배포까지 지났거나 끝난 턴이면 null. */
  next: NextStage | null;
  /** CI가 필요 없다는 관측. 있으면 CI 단계는 notNeeded다. */
  publication: PublicationEvidence | null;
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
    const key = step.commandKey ?? step.command;
    const previous = latest.get(key);
    if (previous?.outcome === "failed" && !settles(step.outcome)) continue;
    latest.set(key, step);
  }
  return [...latest.values()];
}

/** 여러 단계에 걸친 명령이 실패로 끝난 사건. 어느 단계의 실패인지 모르므로 그 단계를 지난 것으로 치지 않는다. */
export function isCompoundFailure(step: WorkStep): boolean {
  return "compound" in step && step.compound?.failed === true;
}

/** 단계 상태가 여럿 섞이면 가장 주의가 필요한 것을 보인다. 실패는 다른 검사가 진행 중이어도 가려지지 않는다. */
const STATUS_WEIGHT: Record<StepOutcome | "stale", number> = { failed: 6, running: 5, unverified: 4, unobserved: 3, stale: 2, passed: 1, done: 0 };

/** 판정을 내렸거나 아직 기다리는 CI 결과. */
function decidesCi(outcome: StepOutcome | "stale"): boolean {
  return outcome !== "stale" && (settles(outcome) || outcome === "running");
}

/**
 * 실행 상태만 다시 본 CI 조회: 결과를 기다리는 `gh run watch … --exit-status`가 없고 판정도 내리지 못한 사건. 판정을 기다린
 * watch는 결과를 못 봤어도(결과 미관측) 조회가 아니다 — 그 실행의 결과는 모른다.
 */
function isCiQuery(step: WorkStep, own: StepOutcome | "stale"): boolean {
  if (step.stage !== "ci" || decidesCi(own)) return false;
  return !parseShell(step.command).commands.some(({ words }) => ghInvocations(words).some((args) => args[0] === "run" && args[1] === "watch" && args.includes("--exit-status")));
}

/** CI 사건이 대상으로 삼은 실행 id들: 모든 gh 호출이 숫자 id를 준 `gh run watch|view`일 때만. 아니면 null. */
function ciRunTargets(step: WorkStep): string[] | null {
  if (step.stage !== "ci") return null;
  const calls = parseShell(step.command).commands.flatMap(({ words }) => ghInvocations(words));
  const ids = calls.map((args) => (args[0] === "run" && (args[1] === "watch" || args[1] === "view") ? runIdArgument(args) : null));
  return ids.length > 0 && ids.every((id): id is string => id !== null) ? ids : null;
}

/** 단계 상태. 수정 전 통과·완료는 stale로 센다. */
function stageStatus(stage: WorkStage, steps: readonly WorkStep[]): StageStatus {
  if (steps.length === 0) return "waiting";
  if (stage !== "check") {
    // 다시 돌린 CI·배포·리뷰가 아직 판정 전이면 앞선 실패를 그대로 보인다. CI는 그 뒤에 실행 상태만 다시 본 조회가
    // 앞선 판정이나 기다리는 watch를 가리지 않는다. 수정 전에 판정한 실행(수정 전 통과)을 다시 본 조회도 그 판정을 가리지 않는다.
    const judged = new Set<string>();
    let status: StepOutcome | "stale" | null = null;
    for (const step of steps) {
      const own = step.stale ? "stale" : step.outcome;
      if (status === "failed" && !settles(step.outcome)) continue;
      if (status !== null && isCiQuery(step, own)) {
        const sameRuns = status === "stale" && (ciRunTargets(step)?.every((id) => judged.has(id)) ?? false);
        if (decidesCi(status) || sameRuns) continue;
      }
      status = own;
      if (own === "stale" || step.outcome === "passed" || step.outcome === "failed") for (const id of ciRunTargets(step) ?? []) judged.add(id);
    }
    return status ?? "waiting";
  }
  let status: StepOutcome | "stale" = "done";
  for (const step of latestChecks(steps)) {
    const own = step.stale ? "stale" : step.outcome;
    if (STATUS_WEIGHT[own] > STATUS_WEIGHT[status]) status = own;
  }
  return status;
}

/** 마지막 수정 뒤에 실제로 지난 단계인지: 실패·수정 전 결과·여러 단계 명령의 실패가 아닌 사건이 하나라도 있다. */
function passedSinceEdit(view: StageView): boolean {
  if (view.status === "waiting" || view.status === "failed" || view.status === "skipped" || view.status === "notNeeded" || view.status === "stale") return false;
  return view.steps.some((step) => !step.stale && step.outcome !== "failed" && !isCompoundFailure(step));
}

/* ---------- 비공개 게시와 공개 CI ---------- */

/** 기록된 성공한 CI 실행 하나: 저장소(`owner/name`, 소문자), 실행의 headSha, 기록으로 밝혀진 브랜치와 워크플로 이름(소문자). */
export interface CiSuccessHead {
  repo: string;
  sha: string;
  branch: string;
  workflow: string;
}

const PUBLISH_WORKFLOWS: Record<string, true> = { "publish public mirror": true, "publish-public.yml": true, ".github/workflows/publish-public.yml": true };
const CI_WORKFLOWS: Record<string, true> = { ci: true, "ci.yml": true, ".github/workflows/ci.yml": true };
const FULL_SHA = /^[0-9a-f]{40}$/i;

function resultText(result: ToolResultMessage): string {
  const content: unknown = result.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((block) => (block && typeof block === "object" && "text" in block && typeof block.text === "string" ? block.text : "")).join("\n") : "";
}

/** 출력에서 줄 하나가 통째로 JSON인 것만 읽어, 객체와 배열 안의 객체를 나온 차례대로. */
function readJsonObjects(text: string): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) objects.push(entry as Record<string, unknown>);
    }
  }
  return objects;
}

/** 실제로 실행되는 `gh` 명령마다 `gh` 뒤 낱말. `sh -c` 스크립트 안도 본다. */
function ghInvocations(words: readonly string[], depth = 0): string[][] {
  const script = readShellScript(words);
  if (script !== null) return depth < 3 ? parseShell(script).commands.flatMap((command) => ghInvocations(command.words, depth + 1)) : [];
  const at = programIndex(words);
  return at >= 0 && basename(words[at]) === "gh" ? [words.slice(at + 1)] : [];
}

/** `--repo X`·`--repo=X`·`-R X` 같은 옵션 값. */
function optionValue(args: readonly string[], names: readonly string[]): string | null {
  for (let i = 0; i < args.length; i += 1) {
    for (const name of names) {
      if (args[i] === name) return args[i + 1] ?? null;
      if (name.startsWith("--") && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return null;
}

const GH_RUN_VALUE_OPTIONS: Record<string, true> = {
  "-R": true, "--repo": true, "-j": true, "--job": true, "--interval": true, "-i": true, "--json": true, "-q": true, "--jq": true, "-t": true, "--template": true,
};

/** `gh run <sub> <대상>`의 대상 낱말: 하위 명령 뒤 옵션이 아닌 첫 낱말. 값을 받는 옵션의 값은 건너뛴다. */
function runTarget(args: readonly string[]): string | null {
  for (let i = 2; i < args.length; i += 1) {
    if (Object.hasOwn(GH_RUN_VALUE_OPTIONS, args[i])) {
      i += 1;
      continue;
    }
    if (!args[i].startsWith("-")) return args[i];
  }
  return null;
}

/** `gh run <sub> <id>`의 실행 id. 대상이 숫자가 아니면 null. */
function runIdArgument(args: readonly string[]): string | null {
  const target = runTarget(args);
  return target !== null && /^\d+$/.test(target) ? target : null;
}

const RUN_URL_REPO = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/\d+/i;

interface RunRecord {
  id: string | null;
  repo: string | null;
  sha: string | null;
  status: unknown;
  conclusion: unknown;
  branch: string | null;
  workflow: string | null;
  /** JSON의 displayTitle(커밋 제목, 길면 「…」로 줄인 것). 없으면 null. */
  title: string | null;
}

/**
 * 성공한 `gh run list|view --json` 출력의 실행들. 실행 저장소는 JSON의 url, 없으면 그 명령에 `gh run` 호출이 하나뿐일 때 그 `-R`.
 * 워크플로는 JSON의 workflowName, 없으면 그 호출의 `--workflow`. 커밋은 JSON의 headSha, 없으면 그 호출이 `--commit <sha>`로 거른
 * 목록일 때 그 SHA다. 출력이 어느 호출 것인지 모를 때는 JSON에 실린 값만 쓴다.
 */
function readRunRecords(command: string, result: ToolResultMessage | undefined): RunRecord[] {
  if (!result || result.isError || !/\bgh\b/.test(command) || readExitCode(result) !== 0) return [];
  const calls = parseShell(command).commands.flatMap(({ words }) => ghInvocations(words)).filter((args) => args[0] === "run" && (args[1] === "list" || args[1] === "view"));
  if (calls.length === 0) return [];
  const sole = calls.length === 1 ? calls[0] : null;
  const filtered = sole?.[1] === "list" ? optionValue(sole, ["-c", "--commit"])?.toLowerCase() : undefined;
  const commitFilter = filtered && /^[0-9a-f]{7,40}$/.test(filtered) ? filtered : null;
  const text = resultText(result);
  if (!commitFilter && !text.includes("headSha")) return [];
  return readJsonObjects(text).flatMap((entry): RunRecord[] => {
    const sha = typeof entry.headSha === "string" ? entry.headSha.toLowerCase() : commitFilter;
    if (sha === null) return [];
    const url = typeof entry.url === "string" ? RUN_URL_REPO.exec(entry.url)?.[1] ?? null : null;
    const id = typeof entry.databaseId === "number" || typeof entry.databaseId === "string" ? String(entry.databaseId)
      : sole?.[1] === "view" ? runIdArgument(sole) : null;
    return [{
      id,
      repo: (url ?? (sole ? optionValue(sole, ["-R", "--repo"]) : null))?.toLowerCase() ?? null,
      sha,
      status: entry.status,
      conclusion: entry.conclusion,
      branch: typeof entry.headBranch === "string" ? entry.headBranch : sole ? optionValue(sole, ["-b", "--branch"]) : null,
      workflow: (typeof entry.workflowName === "string" ? entry.workflowName
        // `gh run list|view --json name`의 name은 워크플로 이름이다.
        : typeof entry.name === "string" && "databaseId" in entry ? entry.name
        : sole ? optionValue(sole, ["-w", "--workflow"]) : null)?.toLowerCase() ?? null,
      title: typeof entry.displayTitle === "string" ? entry.displayTitle : null,
    }];
  });
}

/** 실행 id로 볼 낱말(GitHub Actions 실행 id는 9~12자리)과, 숫자만은 아닌 커밋 SHA 앞자리. */
const RUN_ID_WORD = /\b\d{9,12}\b/g;
const SHORT_SHA_WORD = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;

/**
 * 성공한 `gh run list`의 글 출력(표, `--jq` 문자열)에서 게시 실행인 줄. 줄에 게시 워크플로 이름이 있거나 그 목록이
 * `--workflow <게시 워크플로>`로 거른 것이고, 실행 id로 볼 낱말이 하나뿐인 줄만 본다. 커밋은 그 줄의 SHA 앞자리, 없으면 null이다.
 * JSON 줄은 `readRunRecords`가 읽는다.
 */
function readPublishRunLines(command: string, result: ToolResultMessage | undefined): { id: string; sha: string | null; repo: string | null }[] {
  if (!result || result.isError || readExitCode(result) !== 0) return [];
  const lists = parseShell(command).commands.flatMap(({ words }) => ghInvocations(words)).filter((args) => args[0] === "run" && args[1] === "list");
  if (lists.length !== 1) return [];
  const workflow = optionValue(lists[0], ["-w", "--workflow"])?.toLowerCase();
  const filtered = workflow !== undefined && Object.hasOwn(PUBLISH_WORKFLOWS, workflow);
  const repo = optionValue(lists[0], ["-R", "--repo"])?.toLowerCase() ?? null;
  return resultText(result).split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return [];
    const lower = trimmed.toLowerCase();
    if (!filtered && !Object.keys(PUBLISH_WORKFLOWS).some((name) => lower.includes(name))) return [];
    const ids = trimmed.match(RUN_ID_WORD) ?? [];
    return ids.length === 1 ? [{ id: ids[0], sha: SHORT_SHA_WORD.exec(lower)?.[0] ?? null, repo }] : [];
  });
}

/**
 * bash 호출 하나가 기록한 성공한 CI 실행들. 완료·success이고 저장소·브랜치·워크플로가 기록(JSON이나 그 호출의 `-R`·`--branch`·
 * `--workflow`)으로 밝혀졌으며 그 워크플로가 CI인 것만이다. 워크플로나 브랜치를 모르면 CI 성공의 증거가 아니다.
 */
export function readCiSuccessHeads(block: AssistantContentBlock, result: ToolResultMessage | undefined): CiSuccessHead[] {
  if (block?.type !== "toolCall") return [];
  const command = readBashCommand(block);
  if (command === null) return [];
  return readRunRecords(command, result).flatMap((run): CiSuccessHead[] => (
    run.repo && run.sha && run.branch && run.workflow && run.status === "completed" && run.conclusion === "success" && Object.hasOwn(CI_WORKFLOWS, run.workflow)
      ? [{ repo: run.repo, sha: run.sha, branch: run.branch, workflow: run.workflow }]
      : []
  ));
}

/** 공개 ref 조회의 마지막 관측. 읽을 수 없는 응답도 이전 SHA를 확정 근거로 쓰지 못하게 무효화한다. */
function readPublicHeads(command: string, result: ToolResultMessage | undefined): { repo: string; ref: string; sha: string | null }[] {
  const parsed = parseShell(command);
  const calls = parsed.commands.flatMap(({ words }) => ghInvocations(words)).filter((args) => args[0] === "api");
  const plain = !parsed.uncertain && parsed.commands.length === 1 && calls.length === 1;
  const text = result && !result.isError && readExitCode(result) === 0 ? resultText(result).trim() : "";
  const heads: { repo: string; ref: string; sha: string | null }[] = [];
  for (const args of calls) {
    const path = args.slice(1).find((arg) => /^\/?repos\//.test(arg));
    const match = path ? /^\/?repos\/([^/]+\/[^/]+)\/commits\/([^/?\s]+)$/.exec(path) : null;
    if (!match) continue;
    const query = optionValue(args, ["-q", "--jq"]);
    let value: unknown = null;
    if (plain && query === ".sha") value = text.split("\n")[0]?.trim();
    else if (plain && query === null && text.startsWith("{")) {
      try {
        // bash 결과의 시간·종료 코드 footer는 JSON 본문 뒤에 붙는다.
        value = JSON.parse(text.slice(0, text.lastIndexOf("}") + 1)).sha;
      } catch {
        // 최신 조회의 SHA를 모르면 이전 일치 결과로 생략하지 않는다.
      }
    }
    const sha = typeof value === "string" && FULL_SHA.test(value) ? value.toLowerCase() : null;
    heads.push({ repo: match[1].toLowerCase(), ref: match[2], sha });
  }
  return heads;
}

/** 흐름 안에서 차례(블록 순번)와 함께 모은 게시 관련 관측. */
interface PublicationTrail {
  /** 게시 워크플로 실행 id → 그 실행이 게시한 커밋, 실행 저장소(모르면 null), 관측 순번. */
  publishRuns: Map<string, { sha: string | null; repo: string | null; order: number }>;
  /** 성공으로 끝난 `gh run watch <id> --exit-status`. */
  watched: { id: string; order: number }[];
  heads: { repo: string; ref: string; sha: string | null; order: number }[];
  ciHeads: (CiSuccessHead & { order: number })[];
  /** 게시 실행 로그가 「nothing to publish」였던 커밋(전체 SHA, 소문자). */
  nothingToPublish: { sha: string; order: number }[];
  /** `gh run list|view --json`이 보인 실행 전부(커밋에 이어진 CI 실행을 찾는 데 쓴다). */
  runs: (RunRecord & { order: number })[];
}

/** 게시 워크플로(`.github/workflows/publish-public.yml`)가 공개 트리에 바뀐 것이 없을 때 로그에 남기는 말. */
const NOTHING_TO_PUBLISH = "Public tree already matches; nothing to publish";

/** `$id`·`${id}`처럼 변수 하나만 펼치는 낱말이면 그 이름(따옴표는 셸 읽기에서 벗겨졌다). */
function variableName(word: string | null): string | null {
  const match = word === null ? null : /^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/.exec(word);
  return match ? match[1] ?? match[2] : null;
}

/** `NAME=$(gh run list --commit <전체 SHA> --workflow "Publish public mirror" …)` 하나뿐인 목록이면 변수 이름과 커밋. */
function readPublishRunLookup(list: ShellList): { name: string; sha: string } | null {
  const words = soleCommand(list)?.words;
  const match = words?.length === 1 ? /^([A-Za-z_]\w*)=\$\(([\s\S]*)\)$/.exec(words[0]) : null;
  if (!match) return null;
  const inner = parseShell(match[2]);
  const command = inner.lists.length === 1 ? soleCommand(inner.lists[0]) : null;
  const calls = command?.words[0] === "gh" ? ghInvocations(command.words) : [];
  if (calls.length !== 1 || calls[0][0] !== "run" || calls[0][1] !== "list") return null;
  const sha = optionValue(calls[0], ["-c", "--commit"]);
  const workflow = optionValue(calls[0], ["-w", "--workflow"])?.toLowerCase();
  return sha && FULL_SHA.test(sha) && workflow && Object.hasOwn(PUBLISH_WORKFLOWS, workflow) ? { name: match[1], sha: sha.toLowerCase() } : null;
}

/**
 * 찾은 실행을 기다리거나 확인만 하고 그 말을 출력할 수 없는 명령: 조건 검사·exit·sleep, 그 실행의 `gh run watch`, 그리고
 * 그 변수와 `$?`만 펼치고 그 말의 낱말을 담지 않은 echo·printf.
 */
function waitsQuietly(words: readonly string[], name: string): boolean {
  const [program, ...args] = words;
  if (program === "[" || program === "[[" || program === "test" || program === "exit" || program === "true" || program === ":" || program === "sleep") return true;
  if (program === "echo" || program === "printf") {
    return args.every((arg) => !/`|\$\(/.test(arg) && !/public|tree|already|matches|nothing|publish/i.test(arg)
      && [...arg.matchAll(/\$\{?([A-Za-z_]\w*|[?])/g)].every((use) => use[1] === name || use[1] === "?"));
  }
  if (program !== "gh") return false;
  const calls = ghInvocations(words);
  return calls.length === 1 && calls[0][0] === "run" && calls[0][1] === "watch" && variableName(runTarget(calls[0])) === name;
}

/** 마지막 목록이 `gh run view "$NAME" --log | grep -o "<그 말>" [| head -n 1]` 하나뿐인지. */
function filtersRunLog(list: ShellList, name: string): boolean {
  if (list.background || list.pipelines.length !== 1) return false;
  const [pipeline] = list.pipelines;
  const [view, grep, ...rest] = pipeline.commands;
  if (pipeline.negated || !grep || rest.length > 1 || view.words[0] !== "gh") return false;
  const calls = ghInvocations(view.words);
  if (calls.length !== 1 || calls[0][0] !== "run" || calls[0][1] !== "view" || !calls[0].includes("--log")) return false;
  const target = runTarget(calls[0]);
  if (variableName(target) !== name) return false;
  // 로그 말고 다른 것을 내보내는 옵션(--json·--jq·--template 등)은 받지 않는다. 저장소 옵션과 오류 출력 방향 바꾸기만 둔다.
  for (let i = 2; i < calls[0].length; i += 1) {
    const arg = calls[0][i];
    if (arg === "-R" || arg === "--repo") i += 1;
    else if (arg !== target && arg !== "--log" && !arg.startsWith("--repo=") && !/^2>/.test(arg)) return false;
  }
  const [program, ...args] = grep.words;
  const options = args.filter((arg) => arg.startsWith("-"));
  const patterns = args.filter((arg) => !arg.startsWith("-"));
  if (program !== "grep" || !options.every((option) => /^-[oFas]+$/.test(option)) || !options.some((option) => option.includes("o"))) return false;
  if (patterns.length !== 1 || patterns[0] !== NOTHING_TO_PUBLISH) return false;
  const [tail] = rest;
  return !tail || ((tail.words[0] === "head" || tail.words[0] === "tail") && tail.words.slice(1).every((arg) => /^(?:-n?\d*|\d+)$/.test(arg)));
}

/**
 * 게시 실행 로그를 걸러 「nothing to publish」를 본 명령(4c570d7 기록의 모양)이면 그 커밋의 전체 SHA. 명령이 성공했고, 앞에는
 * `set`·`cd`만, 그다음 그 커밋의 게시 실행을 찾아 변수에 담고, 사이에는 `waitsQuietly`만, 마지막은 그 변수의 실행 로그를
 * `grep -o`로 거른 것이며, 그 말이 명령에 한 번만 나오고 출력에 그 말 그대로인 줄이 있어야 한다. 그 말은 grep만 출력할 수 있다.
 */
function readNothingToPublish(command: string, result: ToolResultMessage | undefined): string | null {
  if (!result || result.isError || readExitCode(result) !== 0 || command.split(NOTHING_TO_PUBLISH).length !== 2) return null;
  const { lists } = parseShell(command);
  let at = 0;
  while (at < lists.length && ["set", "cd"].includes(soleCommand(lists[at])?.words[0] ?? "")) at += 1;
  const lookup = at < lists.length - 1 ? readPublishRunLookup(lists[at]) : null;
  if (!lookup || !filtersRunLog(lists[lists.length - 1], lookup.name)) return null;
  const between = lists.slice(at + 1, -1).flatMap((list) => list.pipelines.flatMap(({ commands }) => commands));
  if (!between.every(({ words }) => waitsQuietly(words, lookup.name))) return null;
  return resultText(result).split("\n").some((line) => line.trim() === NOTHING_TO_PUBLISH) ? lookup.sha : null;
}

function observePublication(trail: PublicationTrail, block: ToolCallContent, result: ToolResultMessage | undefined, order: number) {
  const command = readBashCommand(block);
  if (command === null || !command.includes("gh")) return;
  // 같은 게시 실행을 다시 본 기록은 처음 관측한 순번을 지킨다. 커밋을 모르는 줄은 아는 기록을 덮지 않는다.
  const record = (id: string, run: { sha: string | null; repo: string | null }) => {
    const known = trail.publishRuns.get(id);
    if (!known || (run.sha !== null && known.sha === null)) trail.publishRuns.set(id, { ...run, order: known?.order ?? order });
  };
  for (const run of readRunRecords(command, result)) {
    trail.runs.push({ ...run, order });
    if (run.id && run.sha && run.workflow && Object.hasOwn(PUBLISH_WORKFLOWS, run.workflow)) record(run.id, { sha: run.sha, repo: run.repo });
  }
  for (const run of readPublishRunLines(command, result)) record(run.id, run);
  for (const head of readCiSuccessHeads(block, result)) trail.ciHeads.push({ ...head, order });
  for (const head of readPublicHeads(command, result)) trail.heads.push({ ...head, order });
  const unpublished = readNothingToPublish(command, result);
  if (unpublished) trail.nothingToPublish.push({ sha: unpublished, order });
}

/**
 * 마지막 커밋 C 뒤에: C를 게시한 「Publish public mirror」 실행(`gh run list|view`가 headSha C로 기록한 id)의
 * `gh run watch <id> --exit-status`가 성공했고, 그 뒤 공개 저장소·ref의 마지막으로 읽은 head가 C 전에 같은 저장소·브랜치의
 * CI 성공이 기록된 커밋이면 그 증거. 같은 저장소·ref를 나중에 다시 읽어 다른 커밋이 나왔으면 그 마지막 값만 본다.
 */
function findPublication(trail: PublicationTrail, commit: { sha: string; order: number }, prior: readonly CiSuccessHead[]): PublicationEvidence | null {
  const watch = trail.watched.find(({ id, order }) => {
    const run = trail.publishRuns.get(id);
    return order > commit.order && run?.sha === commit.sha && run.order > commit.order && run.order <= order;
  });
  if (!watch) return null;
  const latest = new Map<string, { repo: string; ref: string; sha: string | null }>();
  for (const head of trail.heads) if (head.order > watch.order) latest.set(`${head.repo}#${head.ref}`, head);
  const before = [...prior, ...trail.ciHeads.filter((head) => head.order < commit.order)];
  for (const head of latest.values()) {
    if (head.sha === null || head.sha === commit.sha) continue;
    if (before.some((run) => run.repo === head.repo && run.sha === head.sha && run.branch === head.ref)) {
      return { kind: "publicHeadUnchanged", repo: head.repo, ref: head.ref, sha: head.sha, runId: watch.id };
    }
  }
  return null;
}

/** `gh run list` 호출이 게시 워크플로(`--workflow "Publish public mirror"` 등)의 실행 목록인지. */
function listsPublishRuns(args: readonly string[]): boolean {
  const workflow = args[0] === "run" && args[1] === "list" ? optionValue(args, ["-w", "--workflow"])?.toLowerCase() : undefined;
  return workflow !== undefined && Object.hasOwn(PUBLISH_WORKFLOWS, workflow);
}

/**
 * 명령의 gh 호출마다 게시 실행을 살핀 것인지: 게시 워크플로의 실행 목록, 그리고 게시 실행으로 기록된 실행(`seen`)이나 같은
 * 명령에서 `NAME=$(gh run list --workflow <게시 워크플로> …)`로 담은 변수를 대상으로 한 `gh run watch|view`. 변수는 명령 차례대로
 * 마지막 대입만 본다. 대입 안의 호출은 따로 세지 않는다.
 */
function publishRunCalls(command: string, seen: (id: string) => boolean): { args: string[]; publish: boolean }[] {
  const publishVariables = new Map<string, boolean>();
  const calls: { args: string[]; publish: boolean }[] = [];
  for (const { words } of parseShell(command).commands) {
    const assignments = words.map((word) => /^([A-Za-z_]\w*)=([\s\S]*)$/.exec(word));
    if (words.length > 0 && assignments.every((match) => match !== null)) {
      for (const match of assignments) {
        if (!match) continue;
        const inner = /^\$\(([\s\S]*)\)$/.exec(match[2])?.[1];
        const lists = inner === undefined ? [] : parseShell(inner).commands.flatMap((command) => ghInvocations(command.words));
        publishVariables.set(match[1], lists.length === 1 && listsPublishRuns(lists[0]));
      }
      continue;
    }
    for (const args of ghInvocations(words)) {
      if (listsPublishRuns(args)) {
        calls.push({ args, publish: true });
        continue;
      }
      const target = args[0] === "run" && (args[1] === "watch" || args[1] === "view") ? runTarget(args) : null;
      const name = variableName(target);
      const publish = name !== null ? publishVariables.get(name) === true : target !== null && /^\d+$/.test(target) && seen(target);
      calls.push({ args, publish });
    }
  }
  return calls;
}

/** 명령의 gh 호출이 모두 게시 실행을 살핀 것인지(`publishRunCalls`). 다른 실행을 기다리거나 보는 호출이 하나라도 있으면 아니다. */
function observesPublishRunsOnly(command: string, seen: (id: string) => boolean): boolean {
  const calls = publishRunCalls(command, seen);
  return calls.length > 0 && calls.every(({ publish }) => publish);
}

/** 명령이 결과를 기다린 `gh run watch`가 모두 게시 실행을 기다린 것인지. 그 종료 상태는 커밋의 CI 판정이 아니다. */
function watchesPublishRunsOnly(command: string, seen: (id: string) => boolean): boolean {
  const watches = publishRunCalls(command, seen).filter(({ args }) => args[0] === "run" && args[1] === "watch");
  return watches.length > 0 && watches.every(({ publish }) => publish);
}

/** 마지막 커밋 C 뒤에 C의 게시 실행 로그가 「nothing to publish」였다는 관측이 있으면 그 증거. */
function findNothingToPublish(trail: PublicationTrail, commit: { sha: string; order: number }): PublicationEvidence | null {
  return trail.nothingToPublish.some(({ sha, order }) => sha === commit.sha && order > commit.order) ? { kind: "nothingToPublish", commit: commit.sha } : null;
}

/** 명령의 gh 호출이 모두 그 커밋(전체 SHA)의 실행 목록 `gh run list --commit <sha>`뿐인지. 다른 실행을 기다리거나 보는 호출이 없다. */
function listsCommitRuns(command: string, sha: string): boolean {
  const calls = parseShell(command).commands.flatMap(({ words }) => ghInvocations(words));
  return calls.length > 0 && calls.every((args) => args[0] === "run" && args[1] === "list" && optionValue(args, ["-c", "--commit"])?.toLowerCase() === sha);
}

/** 두 커밋 SHA가 같은 커밋인지: 소문자 16진수이고, 짧은 쪽이 7자리 이상이며 긴 쪽의 앞자리다. */
function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const [short, long] = a.length <= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
  return short.length >= 7 && /^[0-9a-f]+$/.test(long) && long.startsWith(short);
}

/** 흐름 안의 사건과 그 블록 순번. */
interface ReadStep { step: WorkStep; order: number }

/** 성공한 커밋 사건과 그 블록 순번. */
interface CommitMark { step: CommitStep & { commit: string }; order: number }

/** 「…」로 줄인 제목이 커밋 제목의 앞부분이라고 볼 만큼 긴지. 짧은 앞부분은 다른 커밋 제목과도 맞는다. */
const TRUNCATED_TITLE_MIN = 20;

/** 실행의 displayTitle이 커밋 제목과 같거나, 「…」로 줄인 20자 이상의 앞부분인지. */
function titleMatches(shown: string, title: string): boolean {
  if (shown === title) return true;
  const prefix = shown.endsWith("…") ? shown.slice(0, -1) : null;
  return prefix !== null && prefix.length >= TRUNCATED_TITLE_MIN && title.startsWith(prefix);
}

/**
 * 기록된 실행이 그 커밋의 실행인지. headSha가 그 커밋이면 그렇다. 아니면 공개 미러의 CI 실행일 때만 제목으로 잇는다 — 그 커밋을
 * 게시한 실행이 관측됐고, 이 실행이 그 커밋 뒤에 관측된 CI 워크플로 실행이며, 게시 실행과 다른 저장소에 있고, 제목이 맞아야 한다.
 */
function runOfCommit(run: RunRecord & { order: number }, commit: CommitMark, trail: PublicationTrail): boolean {
  if (sameCommit(run.sha, commit.step.commit)) return true;
  const { title } = commit.step;
  if (!title || !run.title || !run.repo || run.order <= commit.order || !run.workflow || !Object.hasOwn(CI_WORKFLOWS, run.workflow)) return false;
  const published = [...trail.publishRuns.values()].some((publish) => publish.order > commit.order && publish.sha !== null && sameCommit(publish.sha, commit.step.commit) && publish.repo !== null && publish.repo !== run.repo);
  return published && titleMatches(run.title, title);
}

/** 끝난 실행의 conclusion 가운데 실패인 것. neutral·skipped 같은 나머지는 통과도 실패도 아니다. */
const FAILED_CONCLUSIONS: Record<string, true> = { failure: true, cancelled: true, timed_out: true, startup_failure: true };

/**
 * 결과를 기다린 `gh run watch <대상> --exit-status`와 같은 대상을 `gh run view <대상> --json`으로 본 명령에서, 출력의 끝난
 * 실행(`status: completed`) 하나가 통과도 실패도 아닌 conclusion(skipped 등)이면 그 conclusion. 아니면 null.
 */
function unjudgedWatchedRun(command: string, result: ToolResultMessage): string | null {
  const calls = parseShell(command).commands.flatMap(({ words }) => ghInvocations(words));
  const target = calls.find((args) => args[0] === "run" && args[1] === "watch" && args.includes("--exit-status"));
  const watched = target ? runTarget(target) : null;
  if (watched === null || !calls.some((args) => args[0] === "run" && args[1] === "view" && args.includes("--json") && runTarget(args) === watched)) return null;
  const ended = readJsonObjects(resultText(result)).filter((object) => object.status === "completed" && typeof object.conclusion === "string");
  const conclusion = ended.length === 1 ? ended[0].conclusion : null;
  return typeof conclusion === "string" && conclusion !== "" && conclusion !== "success" && !Object.hasOwn(FAILED_CONCLUSIONS, conclusion) ? conclusion : null;
}

/**
 * 커밋 뒤의 CI 사건을 그 커밋의 실행 기록에 잇는다. 그 앞의 마지막 성공한 커밋이 기준이다.
 * - `gh run watch <id>`: 그 실행의 기록이 있는데 모두 다른 커밋의 실행이면, 그 결과는 이 커밋의 CI 판정이 아니다(판정 미확인).
 *   기록이 없는 실행은 지금까지처럼 종료 코드로 판정한다.
 * - `gh run list|view --json`: 판정하지 못한 조회가 보인 그 커밋의 CI 실행(출력 차례로 첫 것)이 끝났으면 그 conclusion이 판정이다.
 */
function linkCiRuns(read: ReadStep[], trail: PublicationTrail): void {
  let commit: CommitMark | null = null;
  // 기준 커밋 뒤에 관측된 수정이 있었는지. 그 커밋의 실행이 통과했어도 마지막 수정본의 통과는 아니다(수정 전 통과).
  let editedSince = false;
  read.forEach((entry, index) => {
    const { step, order } = entry;
    if (step.stage === "commit" && step.outcome === "done" && step.commit) {
      commit = { step: { ...step, commit: step.commit }, order };
      editedSince = false;
    }
    if (step.stage === "edit" && step.outcome === "done" && !step.dispatch && !step.recordOnly) editedSince = true;
    if (step.stage !== "ci" || !commit) return;
    const base: CommitMark = commit;
    const calls = parseShell(step.command).commands.flatMap(({ words }) => ghInvocations(words));
    const watch = calls.find((args) => args[0] === "run" && args[1] === "watch");
    if (watch) {
      // 게시 실행만 기다린 명령의 종료 상태는 이 커밋의 CI 판정이 아니다. gh 호출이 모두 게시 실행이면 뒤에서 조사로 옮기고,
      // 함께 본 CI 조회가 있으면 그 조회만 남은 판정 미확인이다. 통과한 게시 실행 대기는 게시 증거로 남긴다.
      const id = runIdArgument(watch);
      const seen = (run: string) => (trail.publishRuns.get(run)?.order ?? Infinity) <= order;
      if (watchesPublishRunsOnly(step.command, seen)) {
        if (!observesPublishRunsOnly(step.command, seen) && (step.outcome === "passed" || step.outcome === "failed")) {
          if (id && step.outcome === "passed") trail.watched.push({ id, order });
          read[index] = { order, step: { ...step, outcome: "unverified", evidence: undefined, otherRun: { kind: "publish", outcome: step.outcome } } };
        }
        return;
      }
      const records = id ? trail.runs.filter((run) => run.id === id) : [];
      const recorded = records.find((run) => run.sha !== null)?.sha;
      if (!recorded || records.some((run) => runOfCommit(run, base, trail))) {
        if (recorded && editedSince && step.outcome === "passed") read[index] = { order, step: { ...step, stale: true } };
        return;
      }
      if (step.outcome === "passed" || step.outcome === "failed") {
        const sha = recorded.slice(0, 7);
        read[index] = { order, step: { ...step, outcome: "unverified", evidence: `run ${id} · ${sha}`, otherRun: { kind: "commit", sha, outcome: step.outcome } } };
      }
      return;
    }
    if (step.outcome !== "unverified") return;
    const run = trail.runs.find((record) => record.order === order && record.workflow !== null && Object.hasOwn(CI_WORKFLOWS, record.workflow) && runOfCommit(record, base, trail));
    if (!run || run.status !== "completed" || typeof run.conclusion !== "string") return;
    const outcome = run.conclusion === "success" ? "passed" : Object.hasOwn(FAILED_CONCLUSIONS, run.conclusion) ? "failed" : null;
    if (outcome) read[index] = { order, step: { ...step, outcome, evidence: `run ${run.id ?? "?"} · ${run.status} ${run.conclusion}`, ...(outcome === "passed" && editedSince ? { stale: true as const } : {}) } };
  });
}

/** update.sh가 남기는 결과 줄(`say`: `<UTC 시각> READY <target> …`, `ROLLED_BACK <old>`, `ROLLBACK_FAILED <old>`, `FAIL …`). */
const DEPLOY_READY = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) READY ([0-9a-f]{7,40})\b/;
const DEPLOY_FAILED = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) (ROLLED_BACK|ROLLBACK_FAILED|FAIL)\b/;
/** update.sh가 실행마다 처음 남기는 `<UTC 시각> START old=<old> target=<target>` 줄. */
const DEPLOY_START = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ) START old=\S* target=([0-9a-f]{7,40})\b/;

/** 배포 명령이 update.sh에 글자 그대로 넘긴 revision(7~40자리 16진수). 변수·생략(origin/main)이거나 배포 실행이 여럿이면 null. */
function deployRevision(command: string): string | null {
  const revisions: (string | null)[] = [];
  const visit = (words: readonly string[], depth: number) => {
    const script = readShellScript(words);
    if (script !== null) {
      if (depth < 3) for (const inner of parseShell(script).commands) visit(inner.words, depth + 1);
      return;
    }
    if (!runsDeployScript(words)) return;
    const at = programIndex(words);
    const scriptAt = DEPLOY_SCRIPT.test(words[at]) ? at : words.findIndex((word, index) => index > at && !word.startsWith("-"));
    const revision = words[scriptAt + 1];
    revisions.push(revision !== undefined && /^[0-9a-f]{7,40}$/i.test(revision) ? revision.toLowerCase() : null);
  };
  for (const { words } of parseShell(command).commands) visit(words, 0);
  return revisions.length === 1 ? revisions[0] : null;
}

/**
 * 끝을 모르는 배포(바로 돌아오는 systemd-run 등)를 그 뒤 기록의 update.sh 결과 줄로 닫는다. 시작 결과의 시각을 알 때만 본다.
 * revision은 글자 그대로 넘긴 것이고, 변수로 넘겼으면 시작 뒤 시각의 첫 `START old=… target=<revision>` 줄이 이 실행의 대상이다.
 * 시작 뒤 시각의 `READY <그 revision>`은 통과, `ROLLED_BACK`·`ROLLBACK_FAILED`·`FAIL`은 실패다(실패 줄에는 대상 revision이
 * 없다). 다른 revision의 READY와 시작 전 시각의 줄은 이 배포의 결과가 아니다.
 */
function closeDeploys(read: ReadStep[], blocks: readonly AssistantContentBlock[], results: ReadonlyMap<string, ToolResultMessage>, launches: ReadonlyMap<string, ToolResultMessage>): void {
  read.forEach((entry, index) => {
    const { step, order } = entry;
    if (step.stage !== "deploy" || (step.outcome !== "unverified" && step.outcome !== "unobserved")) return;
    let revision = deployRevision(step.command);
    const launch = launches.get(step.toolCallId);
    if (typeof launch?.timestamp !== "number") return;
    const details = launch.details;
    const wall = details && typeof details === "object" && "wallTimeMs" in details && typeof details.wallTimeMs === "number" ? details.wallTimeMs : 0;
    const since = Math.floor((launch.timestamp - wall) / 1000) * 1000;
    for (let at = order; at < blocks.length; at += 1) {
      const block = blocks[at];
      const result = block?.type === "toolCall" ? results.get(block.toolCallId) : undefined;
      if (!result) continue;
      for (const line of resultText(result).split("\n")) {
        // `grep -n`이 붙인 줄 번호(`1689:`)는 결과 줄의 일부가 아니다.
        const text = line.trim().replace(/^\d+[:-](?=\d{4}-\d\d-\d\dT)/, "");
        if (revision === null) {
          const start = DEPLOY_START.exec(text);
          if (start && Date.parse(start[1]) >= since) revision = start[2];
          continue;
        }
        const ready = DEPLOY_READY.exec(text);
        if (ready && Date.parse(ready[1]) >= since && sameCommit(ready[2], revision)) {
          read[index] = { order, step: { ...step, outcome: "passed", evidence: `${ready[1]} READY ${ready[2].slice(0, 12)}` } };
          return;
        }
        const failed = DEPLOY_FAILED.exec(text);
        if (failed && Date.parse(failed[1]) >= since) {
          read[index] = { order, step: { ...step, outcome: "failed", evidence: text.length > 120 ? `${text.slice(0, 119)}…` : text } };
          return;
        }
      }
    }
  });
}

/**
 * 턴 블록을 차례로 읽어 작업 흐름을 만든다. 마지막 수정 뒤에 풀리지 않은 실패(검사 실패, 교차리뷰 지적이나 미해결,
 * CI 실패)가 있는데 다시 수정하면 회차가 하나 늘고 되돌아온 일(loop)이 남는다. 성공한 직접 수정보다 앞선 통과·완료는
 * stale이다. `live`는 아직 진행 중인 턴이다 — 결과가 아직 오지 않은 호출을 진행 중으로 보고 다음 차례 단계(`next`)를 정한다.
 * 끝난 턴은 다음 차례가 없고 들어가지 않은 단계를 건너뜀·필요 없음으로 닫는다. `priorCiHeads`는 이 블록들보다
 * 앞선 기록의 성공한 CI 실행이다(비공개 게시 판정에만 쓴다). `cwd`는 세션 작업 폴더다 — 임시 경로에만 쓴 수정을
 * 조사로 가를 때 그 폴더 안의 경로는 폴더 아래 부분만 본다. `jobNotices`는 블록 밖에 기록된 백그라운드 job 완료
 * 통지다(`resolveBackgroundResults`).
 */
export function deriveWorkFlow(
  blocks: readonly AssistantContentBlock[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  live = false,
  priorCiHeads: readonly CiSuccessHead[] = [],
  cwd?: string,
  jobNotices: readonly JobNotice[] = [],
): WorkFlow {
  const steps: WorkStep[] = [];
  const loops: LoopBack[] = [];
  let attempt = 1;
  let segment = new Map<string, SegmentEntry>();
  let lastEdit = -1;
  let lastSourceEdit = -1;
  const stepOrder = new Map<WorkStep, number>();
  const trail: PublicationTrail = { publishRuns: new Map(), watched: [], heads: [], ciHeads: [], nothingToPublish: [], runs: [] };
  const list = Array.isArray(blocks) ? blocks : [];
  const launches: ReadonlyMap<string, ToolResultMessage> = toolResults instanceof Map ? toolResults : new Map();
  const results = resolveBackgroundResults(list, launches, Array.isArray(jobNotices) ? jobNotices : []);
  const read: ReadStep[] = [];
  list.forEach((block, order) => {
    if (!block || block.type !== "toolCall") return;
    const result = results.get(block.toolCallId);
    observePublication(trail, block, result, order);
    for (const step of readSteps(block, result, live, cwd)) read.push({ step, order });
  });
  linkCiRuns(read, trail);
  closeDeploys(read, list, results, launches);
  // 그 사건까지 관측된 게시 실행인지. 게시 실행을 관찰한 명령은 그 실행이 기록된 뒤에만 가른다.
  const publishSeen = (id: string | null, order: number) => id !== null && (trail.publishRuns.get(id)?.order ?? Infinity) <= order;
  for (const { step: entry, order } of read) {
    let step = entry;
    if (step.stage === "ci") {
      const words = parseShell(step.command).commands.flatMap(({ words: command }) => ghInvocations(command));
      const watch = words.find((args) => args[0] === "run" && args[1] === "watch");
      const id = watch ? runIdArgument(watch) : null;
      if (id && step.outcome === "passed") trail.watched.push({ id, order });
      // 게시 실행을 관찰한 것이지 CI를 실행한 것은 아니다. 원 도구 로그와 실패/진행 상태는 조사에 남긴다. 판정이 없어도 끝난
      // 관찰은 끝난 조사다.
      if (!step.compound && observesPublishRunsOnly(step.command, (run) => publishSeen(run, order))) {
        step = { toolCallId: step.toolCallId, attempt: step.attempt, stage: "investigate", outcome: step.outcome === "passed" || step.outcome === "unverified" ? "done" : step.outcome };
      }
    }
    if (step.stage === "edit" && step.outcome === "done" && !step.dispatch) {
      const failed = latestFailure(segment);
      if (failed) {
        loops.push({ from: failed, attempt });
        attempt += 1;
      }
      segment = new Map();
      lastEdit = steps.length;
      if (!step.recordOnly) lastSourceEdit = steps.length;
    } else if (step.stage === "check" || step.stage === "review" || step.stage === "ci") {
      const key = step.stage === "check" ? `check:${step.command}` : step.stage;
      const previous = segment.get(key);
      if (previous?.outcome !== "failed" || settles(step.outcome)) {
        segment.set(key, { stage: step.stage, outcome: step.outcome, order: steps.length });
      }
    }
    step.attempt = attempt;
    stepOrder.set(step, order);
    steps.push(step);
  }
  // 성공한 직접 수정보다 앞선 통과·완료는 그 수정본을 보증하지 않는다. 커밋과 그 뒤의 CI·배포는 그 커밋의 사실이라 작업 기록만
  // 고친 수정은 그것을 바꾸지 않는다. 커밋 앞의 CI 결과는 어느 커밋 것인지 모르니 다른 수정처럼 수정 전 결과다.
  let committedBefore = false;
  steps.forEach((step, index) => {
    const ofCommit = step.stage === "commit" || (committedBefore && (step.stage === "ci" || step.stage === "deploy"));
    if (index < (ofCommit ? lastSourceEdit : lastEdit) && step.stage !== "investigate" && step.stage !== "edit" && (step.outcome === "passed" || step.outcome === "done")) step.stale = true;
    if (step.stage === "commit" && step.outcome === "done") committedBefore = true;
  });

  // 이번 회차의 마지막 성공한 커밋. 그 뒤에 수정했으면 그 커밋은 마지막 수정본이 아니다.
  const commit = steps.filter((step): step is CommitStep => step.stage === "commit" && step.outcome === "done" && step.attempt === attempt).at(-1);
  const commitOrder = commit ? stepOrder.get(commit) ?? -1 : -1;
  const committed = commit && !commit.stale && commit.commit && FULL_SHA.test(commit.commit) ? { sha: commit.commit.toLowerCase(), order: commitOrder } : null;
  let publication = committed ? findPublication(trail, committed, priorCiHeads) ?? findNothingToPublish(trail, committed) : null;
  // 「nothing to publish」를 거른 명령과 그 커밋의 실행 목록만 본 명령은 게시 실행을 살핀 조사다. 판정 없이 끝났다고 CI 줄로
  // 남기면 필요 없음인 CI 아래에 판정 미확인이 보인다. 이 커밋의 실행이 아닌 CI 조회는 그대로 CI다.
  if (publication?.kind === "nothingToPublish") {
    const sha = publication.commit;
    steps.forEach((step, index) => {
      const order = stepOrder.get(step) ?? -1;
      if (step.stage !== "ci" || step.outcome !== "unverified" || order <= commitOrder) return;
      if (!trail.nothingToPublish.some((seen) => seen.order === order && seen.sha === sha) && !listsCommitRuns(step.command, sha)) return;
      const observed: PlainStep = { toolCallId: step.toolCallId, attempt: step.attempt, stage: "investigate", outcome: "done" };
      steps[index] = observed;
      stepOrder.set(observed, order);
    });
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

  const deploy = stages[WORK_STAGES.indexOf("deploy")];
  // 문서만 바꾼 커밋이면 배포할 실행 코드가 없다. 이 요청이 앞서 실행 코드를 커밋했으면 뒤의 문서 커밋이 그 배포를 지우지 않는다.
  const shippedSource = steps.some((step) => step.stage === "commit" && step.outcome === "done" && !step.docsOnly);
  if (commit?.docsOnly && !commit.stale && !shippedSource && deploy.status === "waiting") deploy.status = "notNeeded";
  const ci = stages[WORK_STAGES.indexOf("ci")];
  // 게시 증거가 있어도 커밋 뒤의 CI 결과는 그대로 보인다. 커밋 앞의 판정 미확인·수정 전 결과는 이 커밋의 CI가 아니다.
  const ciAfterCommit = ci.steps.some((step) => (stepOrder.get(step) ?? Infinity) > commitOrder);
  if (publication && (ci.status === "waiting" || ((ci.status === "unverified" || ci.status === "stale") && !ciAfterCommit))) ci.status = "notNeeded";
  else publication = null;

  let furthest = -1;
  stages.forEach((view, index) => {
    if (passedSinceEdit(view)) furthest = index;
  });
  let next: NextStage | null = null;
  if (live && steps.length > 0) {
    if (latestFailure(segment)) next = { stage: "edit", returning: true };
    // 지난 단계가 모두 실패했으면(커밋만 실패한 턴 등) 그 단계를 다시 할 차례다.
    else if (furthest < 0) next = { stage: stages.find((view) => view.status !== "waiting")?.stage ?? WORK_STAGES[0], returning: false };
    else {
      const last = stages[furthest].steps.at(-1);
      // 리뷰어 답을 쓸 수 없던 리뷰는 다시 받을 차례다. 그 결과로 커밋에 넘어가지 않는다.
      if (last?.stage === "review" && last.unusable) next = { stage: "review", returning: false };
      else {
        const following = stages.slice(furthest + 1).find((view) => view.status !== "skipped" && view.status !== "notNeeded");
        next = following ? { stage: following.stage, returning: false } : null;
      }
    }
  }
  // 뒤 단계가 이미 지나간 빈 단계는 대기가 아니라 건너뛴 것이다.
  stages.forEach((view, index) => {
    if (index < furthest && view.status === "waiting") view.status = "skipped";
  });
  // 끝난 턴에는 기다리는 단계가 없다. 들어가지 않은 단계는 건너뛴 것이고, CI·배포는 성공한 커밋이 없거나 성공한 커밋이 모두
  // 문서만 바꿨으면 할 일이 없다. 실패·판정 미확인·수정 전 결과는 그대로 남는다.
  if (!live && steps.length > 0) {
    const nothingToShip = !shippedSource;
    for (const view of stages) {
      if (view.status === "waiting") view.status = nothingToShip && (view.stage === "ci" || view.stage === "deploy") ? "notNeeded" : "skipped";
    }
  }

  return {
    steps,
    attempt,
    loops,
    stages,
    current: currentStage(steps, stages, commit),
    reached: furthest < 0 ? null : WORK_STAGES[furthest],
    next,
    publication,
  };
}

/** 커밋 뒤 아직 끝나지 않은 CI·배포 상태: 진행 중·결과 미관측·판정 미확인·실패, 그리고 마지막 커밋 전의 수정 앞에서만 통과한 것. */
const OPEN_STATUS: Partial<Record<StageStatus, true>> = { running: true, unobserved: true, unverified: true, failed: true, stale: true };

/**
 * 지금 단계. 보통은 가장 나중 사건의 단계다. 지금 회차의 성공한 커밋 뒤에 성공한 수정이 없으면 그 뒤의 조사·검사·기다림은
 * 단계를 옮기지 않는다 — 사건이 있는 CI·배포 가운데 아직 끝나지 않은 첫 단계, 없으면 사건이 있는 커밋·CI·배포 가운데 가장 뒤
 * 단계다(필요 없음·건너뜀으로 닫힌 단계는 빼고).
 */
function currentStage(steps: readonly WorkStep[], stages: readonly StageView[], commit: CommitStep | undefined): WorkStage | null {
  const last = steps.at(-1);
  if (!last) return null;
  if (!commit || commit.stale) return last.stage;
  const shipping = stages.filter((view) => (view.stage === "commit" || view.stage === "ci" || view.stage === "deploy")
    && view.steps.length > 0 && view.status !== "notNeeded" && view.status !== "skipped");
  const open = shipping.find((view) => view.stage !== "commit" && Object.hasOwn(OPEN_STATUS, view.status));
  return open?.stage ?? shipping.at(-1)?.stage ?? last.stage;
}
