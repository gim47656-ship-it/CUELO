import { describe, expect, test } from "bun:test";

import { matchPowerShellSyntax } from "./powershell-syntax";

describe("bash PowerShell 문법 사전 차단", () => {
  const rejected = [
    ["변수 대입", "$x = 1; echo done", "$x"],
    ["줄 시작 대입", "echo a\n$root = 'C:/x'", "$root"],
    ["$env 참조", "node $env:USERPROFILE/app.js", "$env:USERPROFILE"],
    ["Push-Location", "Push-Location F:/CUELO; bun test", "Push-Location"],
    ["Select-Object 파이프", "git log | Select-Object -First 3", "Select-Object"],
    ["소문자 cmdlet", "get-childitem .", "get-childitem"],
    ["Set-Content", "Set-Content -Path a.txt -Value x", "Set-Content"],
    ["Remove-Item", "Remove-Item ./dist", "Remove-Item"],
    ["if 블록", "if ($a -eq 1) { echo y }", "if (...) { }"],
    ["foreach 블록", "foreach ($f in $files) { echo $f }", "foreach"],
    ["powershell -Command $", 'powershell.exe -NoProfile -Command "$x = 1; $x"', "-Command"],
    ["pwsh -c $", "pwsh -c 'Write-Host $env:PATH'", "-Command"],
  ] as const;
  // 진짜 bash(Linux·WSL)에서는 작은따옴표 안의 `$`가 그대로 넘어가므로 이 항목만 Windows에서만 막는다.

  for (const platform of ["win32", "linux"] as const) {
    for (const [label, command, token] of rejected) {
      if (platform === "linux" && label === "pwsh -c $") continue;
      test(`차단(${platform}): ${label}`, () => {
        const reason = matchPowerShellSyntax(command, platform);
        expect(reason).toBeDefined();
        expect(reason).toContain(token);
        expect(reason).toContain("-NoProfile -ExecutionPolicy Bypass -File");
        expect(reason).toContain("write");
      });
    }
  }

  test("안내문은 실행 OS의 경로 규칙을 따른다", () => {
    const windows = matchPowerShellSyntax("Set-Content a.txt x", "win32");
    expect(windows).toContain("C:/절대/슬래시/경로.ps1");
    expect(windows).not.toContain("wslpath");
    const linux = matchPowerShellSyntax("Set-Content a.txt x", "linux");
    expect(linux).toContain("wslpath -w");
    expect(linux).toContain("UTF-8 BOM");
    expect(linux).toContain("[Console]::OutputEncoding");
    expect(linux).not.toContain("C:/절대/슬래시/경로.ps1");
  });

  const bashKeepsDollar = [
    ["작은따옴표 본문", "powershell.exe -NoProfile -Command 'Get-Date | ForEach-Object { $_.Year }'"],
    ["큰따옴표 안 \\$ 이스케이프", 'powershell.exe -NoProfile -Command "Get-Process | Where-Object { \\$_.Id -gt 1 }"'],
    ["이스케이프된 따옴표와 \\$", 'powershell.exe -NoProfile -Command "Get-CimInstance Win32_Service -Filter \\"Name=\'x\'\\" | ForEach-Object { \\$_.Name }"'],
    ["따옴표 밖 \\$ 이스케이프", "pwsh -c \\$PSVersionTable.PSVersion"],
    ["뒤에 이름이 없는 $", 'pwsh -Command "echo cost: 5$ total"'],
  ] as const;

  for (const [label, command] of bashKeepsDollar) {
    test(`허용(linux)·차단(win32): ${label}`, () => {
      expect(matchPowerShellSyntax(command, "linux")).toBeUndefined();
      expect(matchPowerShellSyntax(command, "win32")).toContain("-Command");
    });
  }

  const bashExpandsDollar = [
    ["큰따옴표 안 $_", 'powershell.exe -Command "Get-Process | Where-Object { $_.Id -gt 1 }"'],
    ["큰따옴표 안 ${}", 'pwsh -Command "echo ${x}"'],
    ["큰따옴표 안 $()", 'pwsh -Command "echo $(Get-Date)"'],
    ["따옴표 밖 $name", "powershell.exe -Command echo $PSVersionTable"],
    ["이스케이프 뒤 확장 $", 'pwsh -Command "\\$a = $b"'],
  ] as const;

  for (const [label, command] of bashExpandsDollar) {
    test(`차단(linux): ${label}`, () => {
      expect(matchPowerShellSyntax(command, "linux")).toContain("-Command");
    });
  }

  const allowed = [
    ["-File 호출", "powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/tmp/run.ps1"],
    ["pwsh -File 인자에 cmdlet 문자열", "pwsh -File C:/tmp/run.ps1 -Name Push-Location"],
    ["$ 없는 -Command", 'powershell -Command "Get-Date"'],
    ["grep -v 데이터", 'grep -v "Set-Content" file.txt'],
    ["grep -n 데이터", "grep -n 'Push-Location' file.ps1"],
    ["echo 작은따옴표 $env", "echo '$env:PATH'"],
    ["echo 큰따옴표 데이터", 'echo "$x = 1; if (a) { b }"'],
    ["heredoc으로 ps1 작성", "cat > a.ps1 <<'EOF'\n$x = 1;\nPush-Location .\nEOF\nls"],
    ["POSIX 변수 대입", "x=1; echo $x"],
    ["POSIX if", "if [ -f a ]; then echo y; fi"],
    ["POSIX 산술 for", "for ((i=0;i<3;i++)); do echo $i; done"],
    ["git", "git status --short"],
    ["bun test", "bun test ./agent/extensions/tests"],
    ["node", "node patches/check-extension-duplicates.mjs"],
    ["gh", "gh run list --workflow ci"],
    ["python", "python -c 'print(1)'"],
  ] as const;

  for (const platform of ["win32", "linux"] as const) {
    for (const [label, command] of allowed) {
      test(`허용(${platform}): ${label}`, () => {
        expect(matchPowerShellSyntax(command, platform)).toBeUndefined();
      });
    }
  }
});
