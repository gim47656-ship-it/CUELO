import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// 2026-11-12 야간: bash 도구는 세션마다 셸 하나를 이어 쓴다(core `tools/bash.ts`의 `sessionKey: sessionId`).
// 한 호출에서 켠 `set -e`가 다음 호출까지 남아, 뒤 호출의 여러 단계 명령이 첫 실패에서 말없이 멈춘다.
// 집 PC 기록(2026-11-12): 원본을 수정 전 사본으로 바꾸고 실패할 시험을 돌린 뒤 되돌리는 명령이 시험에서 멈춰
// 사본이 원본 자리에 남았다. 앞 호출이 errexit를 남겼을 수 있으면 다음 bash 호출이 `set +e`로 시작하게 한다.

const BUSY_NOTICE = "Ran in a copy of the busy session shell";
export const EVENTS_FILE = "cuelo-errexit-reset-events.jsonl";

/** WSL에서는 command-guard가 Windows 실행 파일 호출의 bash 입력을 바꾼다. 입력 교체는 마지막 처리기만 이기므로 겹치지 않게 안내만 한다. */
const WSL_INTEROP = process.platform === "linux" && existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");

export const WSL_ADVICE = [
  "이 bash 호출이 `set -e`를 켠 채 끝났을 수 있다. bash 도구는 세션 셸을 이어 쓰므로 다음 호출도 첫 실패에서 말없이 멈추고 그 뒤 단계(되돌리기 포함)를 건너뛸 수 있다.",
  "다음 bash 호출은 `set +e`로 시작하고, `set -e`는 `( … )` 서브셸이나 `bash -c` 안에서만 쓴다.",
].join(" ");

/** 따옴표, `$`, 역슬래시가 없는 `set` 인자가 errexit를 켜는지. 이런 인자는 셸이 글자 그대로 받는다. */
function plainSetEnables(argText: string): boolean {
  const args = argText.trim().split(/[ \t]+/).filter(Boolean);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const sign = arg[0];
    const flags = arg.slice(1);
    if ((sign !== "-" && sign !== "+") || !/^[a-zA-Z]+$/.test(flags)) return false;
    if (sign === "-" && flags.includes("e")) return true;
    if (flags.includes("o")) {
      i += 1;
      if (sign === "-" && args[i] === "errexit") return true;
    }
  }
  return false;
}

// 안을 볼 수 없는 글을 현재 셸에서 실행하는 명령: `source`, `.`, `eval`.
const OPAQUE_RUN = /(?:^|[^\w.\-])(?:source|eval)(?![\w\-])|(?:^|[\s;&|(){}`])\.[ \t]+[^\s;&|]/;
// `set` 낱말과 그 문장 끝까지의 인자. 제어문 속도 잡는다.
const SET_WORD = /(?:^|[^\w.\-$])set(?![\w\-])([^;&|(){}\n]*)/g;
// 셸이 그대로 받아 errexit를 끄는 맨 앞 문장. 앞 공백은 셸 공백만 인정하고, 이 모양이 아니면 끈 것으로 보지 않는다.
const LEADING_OFF = /^[ \t\n]*set[ \t]+(?:\+e|\+o[ \t]+errexit)[ \t]*(?:$|;(?![;&])|&&|\n)/;

/**
 * 명령 글만으로는 실행 뒤 세션 셸에 errexit가 남았는지 알 수 없다(서브셸 `( set +e )`, 조건문, 따옴표 처리).
 * 그래서 놓치지 않는 쪽으로 읽는다. `enables`: 따옴표, 역슬래시, 줄 이음을 지운 글에서(`s""et -e`, `set "-e"`도 붙여 읽힘)
 * `set`의 인자에 `$`, 백틱, 리디렉션이 있거나 그대로 읽어 errexit를 켜면, 또는 `source`, `.`, `eval`로 안을 볼 수 없는
 * 글을 실행하면 켜졌을 수 있다고 본다.
 * `startsOff`: 맨 앞 문장(앞 `cd … &&` 다음)이 정확히 `set +e`나 `set +o errexit`다.
 * 오판은 이미 꺼진 셸을 다음 호출에서 한 번 더 끄는 것뿐이고, 놓치면 다음 호출의 복구 단계가 실행되지 않으므로 이쪽을 고른다.
 * 남는 한계: 앞 호출에서 정의한 함수나 별칭 안의 `set -e`, 변수로 만든 명령 이름은 보지 못한다.
 */
export function errexitChange(command: string): { enables: boolean; startsOff: boolean } {
  const unquoted = command.replace(/\\\n/g, "").replace(/\$(?=["'])/g, "").replace(/["'\\]/g, "");
  let enables = OPAQUE_RUN.test(unquoted);
  for (const match of unquoted.matchAll(SET_WORD)) {
    if (/[$`<>]/.test(match[1]) || plainSetEnables(match[1])) enables = true;
  }
  const cd = leadingCdEnd(command);
  const startsOff = LEADING_OFF.test(cd ? command.slice(cd.index) : command);
  return { enables, startsOff };
}

const CD_TERMINATORS: Record<string, true> = { " ": true, "\t": true, "\n": true, "\r": true, "&": true, "|": true, ";": true, "<": true, ">": true, "(": true, ")": true };

/**
 * core는 맨 앞 `cd <경로> &&`나 `cd <경로>;`를 떼어 작업 폴더로 쓴다(`shell-tokenize.ts` `extractLeadingCdTarget`).
 * 그 앞에 글을 붙이면 떼어 내기가 깨지므로 구분자 바로 뒤 위치를 돌려준다. core가 떼어 내는 모양은 모두 찾고,
 * 더 넓게 찾는 경우(`$`가 든 경로 등)도 같은 구분자로 끼우므로 셸 의미는 같다.
 */
export function leadingCdEnd(command: string): { index: number; separator: "&&" | ";" } | null {
  const prefix = /^cd[ \t]+/.exec(command);
  if (!prefix) return null;
  let i = prefix[0].length;
  let quote: "'" | '"' | null = null;
  let length = 0;
  for (; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i++;
      else if (ch === quote) quote = null;
      length++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      length++;
      continue;
    }
    if (CD_TERMINATORS[ch]) break;
    length++;
  }
  if (quote || length === 0) return null;
  while (command[i] === " " || command[i] === "\t") i++;
  let separator: "&&" | ";";
  if (command[i] === "&" && command[i + 1] === "&") separator = "&&";
  else if (command[i] === ";" && command[i + 1] !== ";" && command[i + 1] !== "&") separator = ";";
  else return null;
  i += separator.length;
  while (command[i] === " " || command[i] === "\t") i++;
  return { index: i, separator };
}

/** 명령이 errexit 없이 시작하게 고친다. 맨 앞 `cd … &&`는 그대로 두고 같은 구분자로 그 뒤에 끼운다. */
export function withErrexitReset(command: string): string {
  const cd = leadingCdEnd(command);
  if (!cd) return `set +e; ${command}`;
  return `${command.slice(0, cd.index)}set +e ${cd.separator} ${command.slice(cd.index)}`;
}

type Log = (record: Record<string, unknown>) => void;

// 관찰 기록은 플러그인 폴더 밖(에이전트 폴더)에 둔다. 정식 폴더는 프로필 동기화가 덮는다.
const defaultLog: Log = (record) => {
  try {
    appendFileSync(join(import.meta.dir, "..", "..", EVENTS_FILE), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // 기록 실패는 동작을 막지 않는다.
  }
};

/** 결과가 오지 않은(막힌) 바뀐 호출 id를 붙잡아 두는 상한. 동시에 도는 bash 호출 수보다 충분히 크다. */
const MAX_REVISED = 64;

export function createErrexitReset(options: { log?: Log; wsl?: boolean } = {}) {
  const log = options.log ?? defaultLog;
  const wsl = options.wsl ?? WSL_INTEROP;
  return function errexitReset(pi: ExtensionAPI): void {
    // 세션 셸(키 = 세션 id)에 errexit가 남았을 수 있는 세션들. bash 도구의 영속 셸 키와 같다.
    const leaked = new Set<string>();
    // 이 플러그인이 `set +e`를 끼운 호출. 다른 처리기가 막아 실행되지 않은 호출은 결과가 없으므로 상태를 바꾸지 않는다.
    // 그런 호출의 id는 지울 결과가 오지 않으므로 오래된 것부터 버린다.
    const revised = new Set<string>();

    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== "bash" || wsl) return;
      const input = event.input as Record<string, unknown>;
      // 백그라운드 호출은 자기 셸에서 돈다(core `sessionKey: …:async:<job>`).
      if (input.async === true || typeof input.command !== "string") return;
      if (!leaked.has(ctx.sessionManager?.getSessionId?.() ?? "")) return;
      revised.add(event.toolCallId);
      if (revised.size > MAX_REVISED) revised.delete(revised.values().next().value as string);
      return { input: { ...input, command: withErrexitReset(input.command) } };
    });

    pi.on("tool_result", (event, ctx) => {
      if (event.toolName !== "bash") return;
      const wasRevised = revised.delete(event.toolCallId);
      const input = (event.input ?? {}) as Record<string, unknown>;
      if (input.async === true || typeof input.command !== "string") return;
      // 세션 셸이 바빠 사본에서 돈 호출은 세션 셸 상태를 바꾸지 않는다.
      if (event.content.some((part) => part.type === "text" && part.text.includes(BUSY_NOTICE))) return;
      const session = ctx.sessionManager?.getSessionId?.() ?? "";
      const before = wasRevised ? false : leaked.has(session);
      const change = errexitChange(input.command);
      const after = change.enables || (before && !change.startsOff);
      if (after) leaked.add(session);
      else leaked.delete(session);
      if (wasRevised) log({ type: "reset", sessionId: session });
      if (wsl && after && !before) {
        log({ type: "advice", sessionId: session });
        return { additionalContext: WSL_ADVICE };
      }
    });
  };
}

export default createErrexitReset();
