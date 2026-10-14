import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { interopHint, windowsOutputCommand } from "./interop-hint";

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

describe("windowsOutputCommand", () => {
  const WSL = { wsl: true };

  test("Windows 실행 파일이 없거나 WSL이 아니거나 pty·iconv·백그라운드 실행이면 감싸지 않는다", () => {
    expect(windowsOutputCommand("ls -la", WSL)).toBeUndefined();
    expect(windowsOutputCommand("tasklist.exe", { wsl: false })).toBeUndefined();
    expect(windowsOutputCommand("tasklist.exe", { wsl: true, pty: true })).toBeUndefined();
    expect(windowsOutputCommand("tasklist.exe | iconv -f cp949 -t utf-8", WSL)).toBeUndefined();
    expect(windowsOutputCommand("notepad.exe a.txt &", WSL)).toBeUndefined();
    expect(windowsOutputCommand("cat diagnostic.exe.log", WSL)).toBeUndefined();
    expect(windowsOutputCommand("git.exe status --porcelain && git.exe log -1", WSL)).toBeUndefined();
    expect(windowsOutputCommand("git.exe show HEAD:powershell.md", WSL)).toBeUndefined();
    // 이스케이프된 따옴표는 따옴표 구간을 열지 않으므로 그 사이의 `&`는 진짜 백그라운드다.
    expect(windowsOutputCommand('echo \\"; powershell.exe -File monitor.ps1 & echo \\"', WSL)).toBeUndefined();
    expect(windowsOutputCommand("echo 'x\\' & tasklist.exe 'y'", WSL)).toBeUndefined();
  });

  test("git.exe 말고 다른 Windows 프로그램이 있으면 경로·변수로 불러도 감싼다", () => {
    expect(windowsOutputCommand("git.exe status; tasklist.exe", WSL)).toBeDefined();
    expect(windowsOutputCommand('S="/mnt/c/Tools/SQLCMD.EXE"; "$S" -Q x', WSL)).toBeDefined();
    expect(windowsOutputCommand("tasklist.exe</dev/null", WSL)).toBeDefined();
    expect(windowsOutputCommand("/usr/bin/pwsh -c x", WSL)).toBeDefined();
  });

  test("`&&`·`2>&1`·`&>`는 백그라운드로 보지 않는다", () => {
    expect(windowsOutputCommand("cd /mnt/d && sqlcmd.exe -Q x 2>&1", WSL)).toBeDefined();
    expect(windowsOutputCommand("powershell.exe -File a.ps1 &> out.txt", WSL)).toBeDefined();
    expect(windowsOutputCommand(`powershell.exe -NoProfile -Command '& { Write-Output "안녕" }'`, WSL)).toBeDefined();
  });

  // 감싼 명령을 실제 bash로 돌린다. Windows CI 러너의 Git Bash에는 python3가 없을 수 있다.
  describe.skipIf(process.platform === "win32")("감싼 명령 실행", () => {
    const dir = mkdtempSync(join(tmpdir(), "interop-hint-"));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    // CP949 "가나"(B0A1 B3AA)와 UTF-8 "다"를 한 줄씩 내고 3으로 끝나는 가짜 Windows 실행 파일.
    const fake = join(dir, "fake.exe");
    writeFileSync(fake, "#!/bin/bash\nprintf '\\xb0\\xa1\\xb3\\xaa\\n'\nprintf '\\xeb\\x8b\\xa4\\n' >&2\nexit 3\n");
    chmodSync(fake, 0o755);
    const run = (command: string) => {
      const wrapped = windowsOutputCommand(command, WSL);
      expect(wrapped).toBeDefined();
      const result = Bun.spawnSync(["bash", "-c", wrapped ?? ""], { cwd: dir });
      return { exitCode: result.exitCode, output: result.stdout.toString() };
    };

    test("CP949 출력은 UTF-8로 바꾸고 UTF-8 출력과 종료 코드는 그대로 둔다", () => {
      expect(run("./fake.exe")).toEqual({ exitCode: 3, output: "가나\n다\n" });
    });

    test("따옴표·heredoc이 든 명령도 원문 그대로 실행한다", () => {
      const result = run("cat <<'EOF'\nit's \"quoted\" $HOME\nEOF\n./fake.exe; echo \"exit=$?\"");
      expect(result).toEqual({ exitCode: 0, output: "it's \"quoted\" $HOME\n가나\n다\nexit=3\n" });
    });
  });
});
