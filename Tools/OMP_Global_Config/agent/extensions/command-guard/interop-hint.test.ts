import { describe, expect, test } from "bun:test";

import { interopHint } from "./interop-hint";

const MANAGED = "/opt/omp/python-env/bin/python";
const CP949_AS_UTF8 = "����: ���μ��� \"34108\"��(��) ã�� �� �����ϴ�.";
const NO_FITZ = "Traceback (most recent call last):\n  File \"<string>\", line 1, in <module>\nModuleNotFoundError: No module named 'fitz'";

describe("interopHint", () => {
  test("Windows 실행 파일 출력이 깨지면 iconv 재실행을 안내한다", () => {
    const hint = interopHint("taskkill.exe /PID 34108 /T /F", CP949_AS_UTF8);
    expect(hint).toContain("iconv -f cp949 -t utf-8");
  });

  test("이미 iconv로 받은 명령이나 Windows 실행 파일이 아닌 명령은 안내하지 않는다", () => {
    expect(interopHint("powershell.exe -File a.ps1 | iconv -f cp949 -t utf-8", CP949_AS_UTF8)).toBeUndefined();
    expect(interopHint("cat broken.txt", CP949_AS_UTF8)).toBeUndefined();
    expect(interopHint("cat diagnostic.exe.log", CP949_AS_UTF8)).toBeUndefined();
  });

  test("한 글자짜리 대체 문자는 깨짐으로 보지 않는다", () => {
    expect(interopHint("tasklist.exe", "PID 1 \uFFFD ok")).toBeUndefined();
  });

  test("시스템 python3의 모듈 없음은 관리 환경 경로와 모듈 이름을 알려 준다", () => {
    const hint = interopHint('python3 -c "import fitz"', NO_FITZ, { managedPython: MANAGED });
    expect(hint).toContain("'fitz'");
    expect(hint).toContain(MANAGED);
    expect(interopHint("/usr/bin/python3 -c 'import fitz'", NO_FITZ, { managedPython: MANAGED })).toContain("'fitz'");
    expect(interopHint("\"/usr/bin/python3\" -c 'import fitz'", NO_FITZ, { managedPython: MANAGED })).toContain("'fitz'");
  });

  test("관리 환경이 없거나 이미 그 환경을 쓴 명령이면 Python 안내를 내지 않는다", () => {
    expect(interopHint('python3 -c "import fitz"', NO_FITZ)).toBeUndefined();
    expect(interopHint('~/.omp/python-env/bin/python -c "import fitz"', NO_FITZ, { managedPython: MANAGED })).toBeUndefined();
    expect(interopHint("bun run x.ts", NO_FITZ, { managedPython: MANAGED })).toBeUndefined();
  });

  test("두 문제가 함께 나오면 두 안내를 모두 낸다", () => {
    const hint = interopHint("powershell.exe -c x; python3 y.py", `${CP949_AS_UTF8}\n${NO_FITZ}`, { managedPython: MANAGED });
    expect(hint?.split("\n")).toHaveLength(2);
  });
});
