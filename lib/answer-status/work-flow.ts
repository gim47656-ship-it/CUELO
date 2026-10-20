import { readExitCode } from "@/lib/tool-exit-code";
import { isEditToolName, isWriteToolName } from "@/lib/tool-names";
import { isScratchOnlyWrite } from "@/lib/turn-written-files";
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

type CommandStage = "check" | "ci" | "deploy";

/**
 * 명령 하나가 검사·CI·배포 가운데 둘 이상에 걸친 것. 셸 종료 코드는 명령 전체의 결과 하나뿐이라, 0이 아니면 명령이
 * 실패했다는 것만 알고 어느 단계의 명령이 실패했는지는 모른다(`failed`). 그때 단계마다의 판정은 미확인이다.
 */
export interface CompoundCommand {
  /** 이 명령이 닿은 단계, 단계 차례. */
  stages: CommandStage[];
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
  stage: CommandStage;
  state: CheckState;
  exitCode: number | null;
  labels: CheckLabel[];
  compound?: CompoundCommand;
}

/**
 * bash 명령 하나가 닿은 단계(검사·CI·배포, 단계 차례)마다의 판정. 단계는 실행 위치로만 찾는다. 아무 단계도 아니면 빈 배열.
 * 한 단계뿐인 명령은 0이 아닌 종료 코드가 그 단계의 실패다. 여러 단계에 걸친 명령은 종료 코드가 어느 단계 것인지 모르므로
 * 실패를 어느 단계에도 붙이지 않고(`compound.failed`), 0으로 끝났을 때만 단계마다 기존 증명 규칙으로 통과를 가린다.
 */
function judgeCommand(command: string, result: ToolResultMessage | undefined): CommandJudgement[] {
  const parsed = parseShell(command);
  const stages: CommandStage[] = [];
  if (parsed.commands.some(({ words }) => runsCheck(words))) stages.push("check");
  if (parsed.commands.some(({ words }) => runsCi(words))) stages.push("ci");
  if (parsed.commands.some(DECISIVE_COMMAND.deploy)) stages.push("deploy");
  if (stages.length === 0) return [];
  const exitCode = result ? readExitCode(result) : null;
  const failed = exitCode === null ? Boolean(result?.isError) : exitCode !== 0;
  const compound = stages.length > 1 ? { stages, failed } : undefined;
  return stages.map((stage) => {
    const trace = traceStatus(parsed, DECISIVE_COMMAND[stage]);
    // `--if-present`는 스크립트가 없으면 아무것도 실행하지 않고 0으로 끝난다. 그 0은 검사가 돌았다는 증거가 아니다.
    const optional = stage === "check" && trace.decisive.some(({ words }) => words.includes("--if-present"));
    // 종료 코드가 기록되지 않은 결과(백그라운드로 넘어간 실행 등)는 성공으로 치지 않는다.
    const state: CheckState = failed
      ? (compound ? "unverified" : "failed")
      : exitCode === null ? "unobserved"
      : trace.reach === "carried" && !optional ? "passed" : "unverified";
    return { stage, state, exitCode, labels: stage === "check" ? readCheckLabels(trace.decisive) : [], ...(compound ? { compound } : {}) };
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
}

/** 검사·CI·배포: 실행한 bash 명령과 기록된 종료 코드. 검사 이름은 검사 단계에서만 읽는다. */
export interface CommandStep extends StepCore {
  stage: CommandStage;
  command: string;
  exitCode: number | null;
  labels: CheckLabel[];
  /** 여러 단계에 걸친 명령이면 그 단계들과 명령 전체의 실패 여부. 같은 호출이 단계마다 사건 하나씩 남긴다. */
  compound?: CompoundCommand;
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
}

const DOC_FILE = /\.(?:md|mdx|markdown|txt)$/i;
const DOC_FOLDER = /^docs?$/i;

function isDocFile(file: string): boolean {
  return DOC_FILE.test(file) || file.split(/[\\/]/).slice(0, -1).some((segment) => DOC_FOLDER.test(segment));
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

function readStep(block: ToolCallContent, result: ToolResultMessage | undefined, live: boolean, cwd: string | undefined): WorkStep | WorkStep[] | null {
  if (!block.input || typeof block.input !== "object" || Array.isArray(block.input) || typeof block.toolName !== "string") return null;
  const core = { toolCallId: block.toolCallId, attempt: 0 };
  const pending: StepOutcome = live ? "running" : "unobserved";
  const command = readBashCommand(block);
  if (command !== null) {
    return judgeCommand(command, result).map((judged): CommandStep => ({
      ...core,
      stage: judged.stage,
      command,
      exitCode: judged.exitCode,
      labels: judged.labels,
      outcome: result ? judged.state : pending,
      ...(judged.compound ? { compound: judged.compound } : {}),
    }));
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
    if (findings !== null && findings > 0) return { ...core, stage: "review", action, findings, outcome: "failed" };
    const reviewers: unknown[] = Array.isArray(details.reviewers) ? details.reviewers : [];
    const unusable = details.passable === false
      || reviewers.some((reviewer) => !reviewer || typeof reviewer !== "object" || !("status" in reviewer) || reviewer.status !== "ok");
    if (unusable) return { ...core, stage: "review", action, findings, outcome: "unverified", unusable: true };
    return { ...core, stage: "review", action, findings, outcome: findings === null ? "unobserved" : "done" };
  }
  if (name === "git_finalize") {
    if (!result) return { ...core, stage: "commit", commit: null, docsOnly: false, outcome: pending };
    const ok = !result.isError && details.ok !== false;
    const files: unknown = block.input.files;
    const docsOnly = ok && Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === "string" && isDocFile(file));
    return { ...core, stage: "commit", commit: ok && typeof details.commitSha === "string" ? details.commitSha : null, docsOnly, outcome: ok ? "done" : "failed" };
  }
  if (isEditCall(block, name)) {
    // 실패한 수정과 거절된 발주는 아무것도 바꾸지 않았다.
    if (result?.isError) return null;
    if (isScratchWrite(block, result, cwd)) return { ...core, stage: "investigate", outcome: result || !live ? "done" : "running" };
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
  /** 가장 나중 사건의 단계. 사건이 없으면 null. */
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
    const previous = latest.get(step.command);
    if (previous?.outcome === "failed" && !settles(step.outcome)) continue;
    latest.set(step.command, step);
  }
  return [...latest.values()];
}

/** 여러 단계에 걸친 명령이 실패로 끝난 사건. 어느 단계의 실패인지 모르므로 그 단계를 지난 것으로 치지 않는다. */
export function isCompoundFailure(step: WorkStep): boolean {
  return "compound" in step && step.compound?.failed === true;
}

/** 단계 상태가 여럿 섞이면 가장 주의가 필요한 것을 보인다. 실패는 다른 검사가 진행 중이어도 가려지지 않는다. */
const STATUS_WEIGHT: Record<StepOutcome | "stale", number> = { failed: 6, running: 5, unverified: 4, unobserved: 3, stale: 2, passed: 1, done: 0 };

/** 단계 상태. 수정 전 통과·완료는 stale로 센다. */
function stageStatus(stage: WorkStage, steps: readonly WorkStep[]): StageStatus {
  if (steps.length === 0) return "waiting";
  if (stage !== "check") {
    // 다시 돌린 CI·배포·리뷰가 아직 판정 전이면 앞선 실패를 그대로 보인다.
    let status: StepOutcome | "stale" = steps[0].stale ? "stale" : steps[0].outcome;
    for (const step of steps.slice(1)) if (status !== "failed" || settles(step.outcome)) status = step.stale ? "stale" : step.outcome;
    return status;
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
}

/**
 * 성공한 `gh run list|view --json` 출력의 실행들. 실행 저장소는 JSON의 url, 없으면 그 명령에 `gh run` 호출이 하나뿐일 때 그 `-R`.
 * 워크플로는 JSON의 workflowName, 없으면 그 호출의 `--workflow`. 출력이 어느 호출 것인지 모를 때는 JSON에 실린 값만 쓴다.
 */
function readRunRecords(command: string, result: ToolResultMessage | undefined): RunRecord[] {
  if (!result || result.isError || !/\bgh\b/.test(command) || readExitCode(result) !== 0) return [];
  const text = resultText(result);
  if (!text.includes("headSha")) return [];
  const calls = parseShell(command).commands.flatMap(({ words }) => ghInvocations(words)).filter((args) => args[0] === "run" && (args[1] === "list" || args[1] === "view"));
  if (calls.length === 0) return [];
  const sole = calls.length === 1 ? calls[0] : null;
  return readJsonObjects(text).flatMap((entry): RunRecord[] => {
    if (typeof entry.headSha !== "string") return [];
    const url = typeof entry.url === "string" ? RUN_URL_REPO.exec(entry.url)?.[1] ?? null : null;
    const id = typeof entry.databaseId === "number" || typeof entry.databaseId === "string" ? String(entry.databaseId)
      : sole?.[1] === "view" ? runIdArgument(sole) : null;
    return [{
      id,
      repo: (url ?? (sole ? optionValue(sole, ["-R", "--repo"]) : null))?.toLowerCase() ?? null,
      sha: entry.headSha.toLowerCase(),
      status: entry.status,
      conclusion: entry.conclusion,
      branch: typeof entry.headBranch === "string" ? entry.headBranch : sole ? optionValue(sole, ["-b", "--branch"]) : null,
      workflow: (typeof entry.workflowName === "string" ? entry.workflowName : sole ? optionValue(sole, ["-w", "--workflow"]) : null)?.toLowerCase() ?? null,
    }];
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
  /** 게시 워크플로 실행 id → 그 실행이 게시한 커밋, 관측 순번. */
  publishRuns: Map<string, { sha: string; order: number }>;
  /** 성공으로 끝난 `gh run watch <id> --exit-status`. */
  watched: { id: string; order: number }[];
  heads: { repo: string; ref: string; sha: string | null; order: number }[];
  ciHeads: (CiSuccessHead & { order: number })[];
  /** 게시 실행 로그가 「nothing to publish」였던 커밋(전체 SHA, 소문자). */
  nothingToPublish: { sha: string; order: number }[];
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
  for (const run of readRunRecords(command, result)) {
    if (run.id && run.sha && run.workflow && Object.hasOwn(PUBLISH_WORKFLOWS, run.workflow)) trail.publishRuns.set(run.id, { sha: run.sha, order });
  }
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

/** 마지막 커밋 C 뒤에 C의 게시 실행 로그가 「nothing to publish」였다는 관측이 있으면 그 증거. */
function findNothingToPublish(trail: PublicationTrail, commit: { sha: string; order: number }): PublicationEvidence | null {
  return trail.nothingToPublish.some(({ sha, order }) => sha === commit.sha && order > commit.order) ? { kind: "nothingToPublish", commit: commit.sha } : null;
}

/** 명령의 gh 호출이 모두 그 커밋(전체 SHA)의 실행 목록 `gh run list --commit <sha>`뿐인지. 다른 실행을 기다리거나 보는 호출이 없다. */
function listsCommitRuns(command: string, sha: string): boolean {
  const calls = parseShell(command).commands.flatMap(({ words }) => ghInvocations(words));
  return calls.length > 0 && calls.every((args) => args[0] === "run" && args[1] === "list" && optionValue(args, ["-c", "--commit"])?.toLowerCase() === sha);
}

/**
 * 턴 블록을 차례로 읽어 작업 흐름을 만든다. 마지막 수정 뒤에 풀리지 않은 실패(검사 실패, 교차리뷰 지적이나 미해결,
 * CI 실패)가 있는데 다시 수정하면 회차가 하나 늘고 되돌아온 일(loop)이 남는다. 성공한 직접 수정보다 앞선 통과·완료는
 * stale이다. `live`는 아직 진행 중인 턴이다 — 결과가 아직 오지 않은 호출을 진행 중으로 보고 다음 차례 단계(`next`)를 정한다.
 * 끝난 턴은 다음 차례가 없고 들어가지 않은 단계를 건너뜀·필요 없음으로 닫는다. `priorCiHeads`는 이 블록들보다
 * 앞선 기록의 성공한 CI 실행이다(비공개 게시 판정에만 쓴다). `cwd`는 세션 작업 폴더다 — 임시 경로에만 쓴 수정을
 * 조사로 가를 때 그 폴더 안의 경로는 폴더 아래 부분만 본다.
 */
export function deriveWorkFlow(
  blocks: readonly AssistantContentBlock[],
  toolResults: ReadonlyMap<string, ToolResultMessage>,
  live = false,
  priorCiHeads: readonly CiSuccessHead[] = [],
  cwd?: string,
): WorkFlow {
  const steps: WorkStep[] = [];
  const loops: LoopBack[] = [];
  let attempt = 1;
  let segment = new Map<string, SegmentEntry>();
  let lastEdit = -1;
  const stepOrder = new Map<WorkStep, number>();
  const trail: PublicationTrail = { publishRuns: new Map(), watched: [], heads: [], ciHeads: [], nothingToPublish: [] };
  const results: ReadonlyMap<string, ToolResultMessage> = toolResults instanceof Map ? toolResults : new Map();
  (Array.isArray(blocks) ? blocks : []).forEach((block, order) => {
    if (!block || block.type !== "toolCall") return;
    const result = results.get(block.toolCallId);
    observePublication(trail, block, result, order);
    for (let step of readSteps(block, result, live, cwd)) {
      if (step.stage === "ci") {
        const words = parseShell(step.command).commands.flatMap(({ words: command }) => ghInvocations(command));
        const watch = words.find((args) => args[0] === "run" && args[1] === "watch");
        const id = watch ? runIdArgument(watch) : null;
        if (id && step.outcome === "passed") trail.watched.push({ id, order });
        const query = words.length === 1 && words[0][0] === "run" && (words[0][1] === "list" || words[0][1] === "view") ? words[0] : null;
        const workflow = query ? optionValue(query, ["-w", "--workflow"])?.toLowerCase() : null;
        const publishQuery = query && ((workflow && Object.hasOwn(PUBLISH_WORKFLOWS, workflow)) || trail.publishRuns.has(runIdArgument(query) ?? ""));
        // 게시 실행을 관찰한 것이지 CI를 실행한 것은 아니다. 원 도구 로그와 실패/진행 상태는 조사에 남긴다.
        if (words.length === 1 && ((id && trail.publishRuns.has(id)) || publishQuery) && !step.compound) {
          step = { toolCallId: step.toolCallId, attempt: step.attempt, stage: "investigate", outcome: step.outcome === "passed" ? "done" : step.outcome };
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
  });
  // 성공한 직접 수정보다 앞선 통과·완료는 그 수정본을 보증하지 않는다.
  steps.forEach((step, index) => {
    if (index < lastEdit && step.stage !== "investigate" && step.stage !== "edit" && (step.outcome === "passed" || step.outcome === "done")) step.stale = true;
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
  // 문서만 바꾼 커밋이면 배포할 실행 코드가 없다.
  if (commit?.docsOnly && !commit.stale && deploy.status === "waiting") deploy.status = "notNeeded";
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
  // 끝난 턴에는 기다리는 단계가 없다. 들어가지 않은 단계는 건너뛴 것이고, CI·배포는 성공한 커밋이 없거나 마지막 성공한
  // 커밋이 문서만 바꿨으면 할 일이 없다. 실패·판정 미확인·수정 전 결과는 그대로 남는다.
  if (!live && steps.length > 0) {
    const lastCommit = steps.filter((step): step is CommitStep => step.stage === "commit" && step.outcome === "done").at(-1);
    const nothingToShip = !lastCommit || lastCommit.docsOnly;
    for (const view of stages) {
      if (view.status === "waiting") view.status = nothingToShip && (view.stage === "ci" || view.stage === "deploy") ? "notNeeded" : "skipped";
    }
  }

  return {
    steps,
    attempt,
    loops,
    stages,
    current: steps.length > 0 ? steps[steps.length - 1].stage : null,
    reached: furthest < 0 ? null : WORK_STAGES[furthest],
    next,
    publication,
  };
}
