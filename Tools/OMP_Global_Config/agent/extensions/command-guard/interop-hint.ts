/**
 * WSL bash 결과에서 Windows/Linux 차이로 생긴 실패를 알아보고 다음 행동 한 줄을 돌려준다.
 * 명령을 바꾸거나 다시 실행하지 않는다(결과 출처가 흐려지지 않게 안내만 덧붙인다).
 *
 * 근거(2026-10-14 세션 기록 집계, WSL 이관 10-07 이후):
 * - Windows 실행 파일 출력의 CP949 한글이 U+FFFD로 깨진 호출 66건. pi-natives가 bash 출력을 UTF-8로
 *   손실 해석하므로 결과를 다시 읽을 수 없고, `iconv`를 붙여 다시 실행해야 한다.
 * - 시스템 `python3`에 PyMuPDF·openpyxl·Pillow·ezdxf·python-docx가 없어 실패한 호출 28건.
 *   관리 Python 환경(`~/.omp/python-env`, eval이 자동으로 고르는 환경)에는 설치돼 있다.
 */

// 실행 파일 이름 끝의 `.exe`만 본다(`x.exe.log` 같은 인자는 아니다).
const WINDOWS_EXECUTABLE = /\.exe(?=["'\s;&|)]|$)|\bpowershell\b|\bpwsh\b/im;
const MOJIBAKE = /\uFFFD{2,}/;
const MISSING_PYTHON_MODULE = /ModuleNotFoundError: No module named '([\w.]+)'/;
// `python3`, `python3.12`, `/usr/bin/python3`, `"/usr/bin/python3"`처럼 경로·따옴표를 붙인 호출도 잡는다.
const PYTHON_COMMAND = /(?:^|[\s;&|(/"'])python3?(?:\.\d+)?(?=["'\s;&|)]|$)/m;

export interface InteropHintContext {
  /** 관리 Python 환경의 python 실행 파일. 없으면 Python 안내를 내지 않는다. */
  managedPython?: string;
}

export function interopHint(command: string, output: string, context: InteropHintContext = {}): string | undefined {
  const hints: string[] = [];
  if (WINDOWS_EXECUTABLE.test(command) && !/\biconv\b/.test(command) && MOJIBAKE.test(output)) {
    hints.push(
      "[WSL interop] Windows 프로그램 출력의 한글이 CP949라 깨졌다(�). 이 결과는 복구할 수 없으니 `| iconv -f cp949 -t utf-8`을 붙여 다시 실행한다. `wsl.exe`는 `WSL_UTF8=1 WSLENV=WSL_UTF8`, 한글이 든 `.ps1`은 UTF-8 BOM과 `[Console]::OutputEncoding` 설정을 쓴다.",
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
