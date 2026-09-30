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

  for (const [label, command, token] of rejected) {
    test(`차단: ${label}`, () => {
      const reason = matchPowerShellSyntax(command);
      expect(reason).toBeDefined();
      expect(reason).toContain(token);
      expect(reason).toContain("-NoProfile -ExecutionPolicy Bypass -File");
      expect(reason).toContain("write");
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

  for (const [label, command] of allowed) {
    test(`허용: ${label}`, () => {
      expect(matchPowerShellSyntax(command)).toBeUndefined();
    });
  }
});
