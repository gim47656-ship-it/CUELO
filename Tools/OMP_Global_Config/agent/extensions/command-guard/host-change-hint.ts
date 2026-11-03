/**
 * 호스트 OS 시스템 설정을 바꾸는 Windows 명령(`reg`·`sc`·`netsh`·`bcdedit`)을 실행한 bash 결과에 규칙 안내를 붙인다.
 *
 * 근거: RULES 「Host OS system changes」(2026-10-06 보안 필터 드라이버 비활성화 제안 지적)은 문서로만 지켜졌다
 * (`rules/rule-enforcement.md` R19). 사용자 결정(2026-11-03): 차단하지 않고 경고만 한다. 조회(`reg query`·`sc query`)는
 * 안내하지 않는다. 결과에 붙으므로 그 호출 자체를 멈추지는 못하고, 다음 행동(승인 확인·사용자 보고·되돌리기)을 바로잡는다.
 */

import { invokedCommandLines } from "./matcher";

const writes = (...names: string[]): Record<string, true> => Object.fromEntries(names.map((name) => [name, true]));
const REG_WRITES = writes("add", "delete", "import", "restore", "copy", "load", "unload");
const SC_WRITES = writes("config", "stop", "delete", "create", "failure", "sdset", "privs");
const NETSH_WRITES = writes("set", "add", "delete", "reset");
// netsh는 `netsh [-a|-c|-r|-u|-p|-f 값…] <문맥…> <동사> <인자…>`다. 전역 옵션과 그 값을 건너뛴 첫 동사가 쓰기일 때만 센다
// (`show config "reset"`의 `reset`은 인자, `-r reset`의 `reset`은 원격 컴퓨터 이름이다).
const NETSH_VERBS = writes("set", "add", "delete", "reset", "show", "dump", "help", "?");
const NETSH_OPTIONS = writes("-a", "-c", "-r", "-u", "-p", "-f");
const BCDEDIT_WRITES = writes("/set", "/delete", "/deletevalue", "/import", "/create", "/default");
// `writes`가 만든 표는 Object 원형을 물려받으므로 `constructor` 같은 이름을 쓰기로 보지 않게 자기 키만 본다.
const has = (table: Record<string, true>, key: string | undefined): key is string => key !== undefined && Object.hasOwn(table, key);

function programName(word: string): string {
  const name = (word.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

/** 호출 하나가 시스템 설정 쓰기면 `reg add`처럼 프로그램과 하위 명령을, 아니면 undefined를 돌려준다. */
function systemWrite(word: string, args: string[]): string | undefined {
  const name = programName(word);
  const lower = args.map((arg) => arg.toLowerCase());
  if (name === "reg") {
    const sub = lower[0];
    return has(REG_WRITES, sub) ? `reg ${sub}` : undefined;
  }
  if (name === "sc") {
    // `sc \\server config …`처럼 원격 컴퓨터 이름이 앞에 올 수 있다(따옴표 없이 쓰면 셸이 `\server`로 푼다).
    const sub = lower.find((arg) => !arg.startsWith("\\"));
    return has(SC_WRITES, sub) ? `sc ${sub}` : undefined;
  }
  if (name === "netsh") {
    let verb: string | undefined;
    for (let index = 0; index < lower.length && verb === undefined; index += 1) {
      if (has(NETSH_OPTIONS, lower[index])) index += 1;
      else if (has(NETSH_VERBS, lower[index])) verb = lower[index];
    }
    return has(NETSH_WRITES, verb) ? `netsh … ${verb}` : undefined;
  }
  if (name === "bcdedit") {
    const sub = lower.find((arg) => has(BCDEDIT_WRITES, arg));
    return sub ? `bcdedit ${sub}` : undefined;
  }
  return undefined;
}

export function hostSystemChangeHint(command: string): string | undefined {
  const found = [...new Set(invokedCommandLines(command).flatMap(({ word, args }) => systemWrite(word, args) ?? []))];
  if (found.length === 0) return undefined;
  return (
    `[호스트 시스템 변경] 이 명령은 Windows 시스템 설정을 바꾼다(${found.map((write) => `\`${write}\``).join(", ")}). ` +
    "RULES 「Host OS system changes」: 대상·현재 값·새 값·예상 영향·되돌리는 법을 설명하고 사용자가 그 정확한 변경을 승인한 때만 실행한다. " +
    "UAC 허용은 승인이 아니고, 진단용 '꺼 보기'는 금지다. 승인 없이 실행했다면 더 바꾸지 말고 무엇이 바뀌었는지와 되돌리는 방법을 지금 사용자에게 알린다."
  );
}
