/**
 * WSL bash에서 Windows/Linux 차이로 생기는 실패를 다룬다.
 *
 * 근거(2026-10-14 세션 기록 집계, WSL 이관 10-07 이후):
 * - Windows 실행 파일 출력의 CP949 한글이 U+FFFD로 깨진 호출 66건. pi-natives가 bash 출력을 UTF-8로
 *   손실 해석하므로 결과 쪽에서는 되살릴 수 없다. 그래서 실행 전에 출력이 UTF-8이 되도록 명령을 감싼다
 *   ({@link windowsOutputCommand}). 감싸지 못한 명령이 깨지면 다시 실행할 방법을 안내한다.
 * - 시스템 `python3`에 PyMuPDF·openpyxl·Pillow·ezdxf·python-docx가 없어 실패한 호출 28건.
 *   관리 Python 환경(`~/.omp/python-env`, eval이 자동으로 고르는 환경)에는 설치돼 있다.
 */

import { invokedCommands } from "./matcher";

const MOJIBAKE = /\uFFFD{2,}/;
const MISSING_PYTHON_MODULE = /ModuleNotFoundError: No module named '([\w.]+)'/;
// `python3`, `python3.12`, `/usr/bin/python3`, `"/usr/bin/python3"`처럼 경로·따옴표를 붙인 호출도 잡는다.
const PYTHON_COMMAND = /(?:^|[\s;&|(/"'])python3?(?:\.\d+)?(?=["'\s;&|)]|$)/m;

export interface InteropHintContext {
  /** 관리 Python 환경의 python 실행 파일. 없으면 Python 안내를 내지 않는다. */
  managedPython?: string;
}

// 출력 줄이 UTF-8로 읽히면 그대로 두고, 아니면 CP949로 읽어 UTF-8로 낸다. Windows의 UTF-8 출력
// (`git.exe`, `WSL_UTF8`을 받은 `wsl.exe`, BOM `.ps1`)과 Linux 출력은 바뀌지 않는다.
const DECODER = [
  "import sys",
  "w = sys.stdout.buffer",
  "for b in iter(sys.stdin.buffer.readline, b''):",
  "    try:",
  "        t = b.decode('utf-8')",
  "    except UnicodeDecodeError:",
  "        t = b.decode('cp949', 'replace')",
  "    w.write(t.encode('utf-8'))",
  "    w.flush()",
].join("\n");
// 출력이 변환기 하나를 거치도록 원래 명령을 실제 bash 한 번으로 돌리고, 그 종료 코드를 그대로 돌려준다.
// 원문과 변환기는 base64로 넘겨 따옴표·heredoc이 어떤 모양이든 그대로 실행된다.
const RUNNER =
  'c=$(printf %s "$1" | base64 -d) && p=$(printf %s "$2" | base64 -d) || exit 2; ' +
  'bash -c "$c" 2>&1 | python3 -u -c "$p"; exit "${PIPESTATUS[0]}"';
/**
 * 명령이 실제로 부르는 Windows 프로그램의 파일 이름(소문자). `*.exe`와 낱말 하나인 `powershell`·`pwsh`만 센다.
 * 따옴표 안 언급·주석·heredoc 본문의 글자(`echo "tasklist.exe"`, `cat <<'EOF' … pwsh … EOF`)는 부르는 것이 아니므로 세지 않고,
 * `bash -c '…'`·`$(…)`·`xargs`·`for … do` 안의 호출은 센다.
 */
function windowsPrograms(command: string): string[] {
  const programs: string[] = [];
  for (const invoked of invokedCommands(command)) {
    const name = (invoked.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase();
    if (name.endsWith(".exe") || name === "powershell" || name === "pwsh") programs.push(name);
  }
  return programs;
}

/**
 * bash 따옴표·이스케이프를 따라가며 따옴표 밖의 백그라운드 `&`가 있는지 본다(`&&`·`&>`·`>&`·`<&`·`|&` 제외).
 * 백그라운드 자식이 출력 파이프를 붙잡으면 감싼 호출이 끝나지 않으므로 그런 명령은 감싸지 않는다.
 * 따옴표 안의 `&`(PowerShell 호출 연산자 등)와 `\&`는 bash 연산자가 아니다.
 */
function hasBackgroundAmpersand(command: string): boolean {
  let quote: string | undefined;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "&") continue;
    const previous = command[index - 1] ?? "";
    const next = command[index + 1] ?? "";
    if (next === "&") {
      index++;
      continue;
    }
    if (next === ">" || previous === ">" || previous === "<" || previous === "|") continue;
    return true;
  }
  return false;
}

export interface WindowsOutputContext {
  /** WSL에서 Windows 실행 파일을 부를 수 있을 때만 감싼다. */
  wsl: boolean;
  /** 대화형 pty 실행은 감싸지 않는다. */
  pty?: boolean;
}

/**
 * Windows 실행 파일을 부르는 bash 명령을, 출력을 UTF-8로 바꿔 내는 명령으로 감싼다. 감쌀 필요가 없거나
 * 감싸면 동작이 달라질 수 있는 명령은 `undefined`를 돌려준다.
 *
 * 감싼 명령은 지속 셸이 아니라 새 bash에서 돌므로, 그 안의 `cd`·변수 대입은 다음 호출로 이어지지 않는다
 * (export된 환경과 작업 폴더는 물려받는다).
 */
export function windowsOutputCommand(command: string, context: WindowsOutputContext): string | undefined {
  if (!context.wsl || context.pty) return undefined;
  if (/\biconv\b/.test(command) || hasBackgroundAmpersand(command)) return undefined;
  // `git.exe`는 UTF-8로 내고 /mnt 저장소에서 가장 자주 부르므로, Windows 프로그램이 그것뿐이면 감싸지 않는다.
  const programs = windowsPrograms(command);
  if (programs.every((program) => program === "git.exe")) return undefined;
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  const encodedDecoder = Buffer.from(DECODER, "utf8").toString("base64");
  return `bash -c '${RUNNER}' cuelo-windows-output '${encodedCommand}' '${encodedDecoder}'`;
}

export function interopHint(command: string, output: string, context: InteropHintContext = {}): string | undefined {
  const hints: string[] = [];
  if (windowsPrograms(command).length > 0 && !/\biconv\b/.test(command) && MOJIBAKE.test(output)) {
    hints.push(
      "[WSL interop] Windows 프로그램 출력의 한글이 CP949라 깨졌다(�). 자동 UTF-8 변환은 `&` 백그라운드·pty·`iconv`가 든 명령을 감싸지 않는다. 이 결과는 복구할 수 없으니 `| iconv -f cp949 -t utf-8`을 붙여 다시 실행한다. `wsl.exe`는 `WSL_UTF8=1 WSLENV=WSL_UTF8`을 쓴다.",
    );
  }
  const missing = MISSING_PYTHON_MODULE.exec(output);
  if (missing && context.managedPython && PYTHON_COMMAND.test(command) && !command.includes("python-env/bin/python")) {
    hints.push(
      `[WSL interop] 시스템 python3에는 '${missing[1]}'이 없다. 관리 Python 환경 \`${context.managedPython}\`(eval도 이 환경을 쓴다)으로 다시 실행하고, 그래도 없으면 그 환경에 \`-m pip install\`로 넣는다.`,
    );
  }
  return hints.length > 0 ? hints.join("\n") : undefined;
}
