/**
 * OMP `bash` 도구의 셸은 PowerShell이 아니다(Windows는 내장 셸, WSL·Linux는 진짜 `/bin/bash`). PowerShell 전용
 * 문법을 실행 위치에 쓰면 실행 뒤에 `pi-natives:command: syntax error`나 bash 오류로만 드러나므로, 실행 전에
 * 같은 기준으로 거절한다.
 * 따옴표 안의 값(grep 패턴, echo 인자 등)과 heredoc 본문은 다른 프로그램의 데이터라 검사하지 않는다.
 */

const CMDLETS = new Set(
  [
    "Add-Content", "ConvertFrom-Json", "ConvertTo-Json", "Copy-Item", "ForEach-Object",
    "Get-ChildItem", "Get-Command", "Get-Content", "Get-Date", "Get-Item", "Get-Location",
    "Get-Process", "Invoke-Expression", "Invoke-WebRequest", "Join-Path", "Measure-Object",
    "Move-Item", "New-Item", "Out-File", "Out-Null", "Out-String", "Pop-Location",
    "Push-Location", "Remove-Item", "Rename-Item", "Resolve-Path", "Select-Object",
    "Select-String", "Set-Content", "Set-Location", "Sort-Object", "Split-Path", "Start-Process",
    "Stop-Process", "Test-Path", "Where-Object", "Write-Error", "Write-Host", "Write-Output",
  ].map((name) => name.toLowerCase()),
);

const GUIDANCE_WINDOWS =
  "PowerShell 로직은 `write`로 .ps1 파일을 만든 뒤 PowerShell 7 `pwsh -NoProfile -ExecutionPolicy Bypass -File C:/절대/슬래시/경로.ps1`로 실행하세요(7이 없을 때만 `powershell.exe`).";

// WSL의 bash는 진짜 bash라 따옴표·`\$`가 정상 처리되고, Windows 프로그램에는 Windows 경로를 넘겨야 한다.
// Linux `pwsh`가 아니라 Windows PowerShell 7(`pwsh.exe`)을 부른다. 5.1은 BOM 없는 .ps1을 CP949로 읽는다.
// 7도 WSL로 넘기는 stdout은 시스템 코드페이지(CP949)라 한글이 깨진다(2026-10-09 7.6.6에서 관측).
const GUIDANCE_LINUX =
  "PowerShell 로직은 `write`로 .ps1 파일을 만든 뒤 Windows PowerShell 7 `pwsh.exe -NoProfile -ExecutionPolicy Bypass -File \"$(wslpath -w /절대/경로.ps1)\"`로 실행하세요(7이 없을 때만 `powershell.exe`). " +
  "한글을 출력하면 첫 줄에 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`를 두세요. `powershell.exe`(5.1)로 실행하면 .ps1도 UTF-8 BOM으로 저장해야 합니다. " +
  "짧은 `-Command` 본문은 작은따옴표로 감싸거나 `\\$`로 이스케이프하면 통과합니다.";

function reason(subject: string, platform: NodeJS.Platform): string {
  const windows = platform === "win32";
  return `bash 도구의 ${windows ? "내장 " : ""}셸은 PowerShell이 아니라서 ${subject}는 실행 전에 차단됩니다. ${windows ? GUIDANCE_WINDOWS : GUIDANCE_LINUX}`;
}

/** `<<[-]'WORD'` 형태의 heredoc 본문을 지워 스크립트 파일 내용이 명령으로 검사되지 않게 한다. */
function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of lines) {
    if (delimiter !== undefined) {
      if (line.replace(/\r$/, "").trim() === delimiter) delimiter = undefined;
      continue;
    }
    kept.push(line);
    const marker = /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][\w]*))/.exec(line);
    if (marker) delimiter = marker[1] ?? marker[2] ?? marker[3];
  }
  return kept.join("\n");
}

/** 따옴표 안쪽 글자를 공백으로 바꿔 정규식이 데이터를 코드로 오인하지 않게 한다. */
function maskQuoted(command: string): string {
  let out = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
        out += character;
      } else if (quote === '"' && character === "\\" && index + 1 < command.length) {
        out += "  ";
        index += 1;
      } else {
        out += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    out += character;
  }
  return out;
}

interface Token {
  value: string;
  quoted: boolean;
  /** posix 모드에서 bash가 `$`를 확장할 자리(따옴표 밖이나 큰따옴표 안의 이스케이프 안 된 `$name`·`${`·`$(` 등)가 있었는가. */
  expands: boolean;
}

/**
 * 따옴표를 존중해 명령 구분자(; | & 줄바꿈 괄호)로 나눈 세그먼트별 토큰.
 * `posix`는 진짜 bash(WSL·Linux)의 따옴표·백슬래시 이스케이프 규칙을 따른다. Windows 내장 셸 기준(`posix` false)은
 * 백슬래시를 이스케이프로 읽지 않는 기존 동작을 그대로 유지한다.
 */
function segmentTokens(command: string, posix: boolean): Token[][] {
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let value = "";
  let started = false;
  let quoted = false;
  let expands = false;
  let quote: "'" | '"' | undefined;
  const endToken = (): void => {
    if (started) tokens.push({ value, quoted, expands });
    value = "";
    started = false;
    quoted = false;
    expands = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    // bash가 확장하는 `$` 꼴(`$name`, `$1`, `$_`, `${`, `$(`, `$?` 등). 뒤가 공백·따옴표·끝이면 글자 그대로 남는다.
    const dollar = character === "$" && /[A-Za-z0-9_{(?!@*#$]/.test(command[index + 1] ?? "");
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (posix && quote === '"' && character === "\\" && index + 1 < command.length) {
        value += character + command[index + 1];
        index += 1;
      } else {
        if (posix && quote === '"' && dollar) expands = true;
        value += character;
      }
      continue;
    }
    if (posix && character === "\\" && index + 1 < command.length && command[index + 1] !== "\n") {
      value += character + command[index + 1];
      started = true;
      index += 1;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
      quoted = true;
    } else if (character === "#" && !started) {
      while (index + 1 < command.length && command[index + 1] !== "\n") index += 1;
    } else if (/\s/.test(character) && character !== "\n") {
      endToken();
    } else if (/[;|&\n(){}]/.test(character)) {
      endSegment();
    } else {
      if (posix && dollar) expands = true;
      value += character;
      started = true;
    }
  }
  endSegment();
  return segments;
}

function commandBasename(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase().replace(/\.exe$/, "");
}

/** powershell/pwsh 호출의 판정: undefined면 허용, 문자열이면 차단 사유. */
function matchPowerShellHost(args: Token[], platform: NodeJS.Platform): string | undefined {
  for (const arg of args) {
    const option = arg.value.toLowerCase();
    if (!arg.quoted && /^-f(?:i(?:le?)?)?$/.test(option)) return undefined;
    if (!arg.quoted && (option === "-encodedcommand" || option === "-e" || option === "-ec")) {
      return undefined;
    }
  }
  const commandIndex = args.findIndex(
    (arg) => !arg.quoted && ["-c", "-command", "-commandwithargs"].includes(arg.value.toLowerCase()),
  );
  if (commandIndex < 0) return undefined;
  // Windows 내장 셸은 따옴표 안의 `$`도 바꿔 넘기므로 모든 `$`를 막고, 진짜 bash는 확장되는 `$`만 막는다.
  const dollar = platform === "win32"
    ? (arg: Token) => arg.value.includes("$")
    : (arg: Token) => arg.expands;
  if (args.slice(commandIndex + 1).some(dollar)) {
    return reason("`-Command` 인자의 `$`(bash 층이 변형해 PowerShell이 다른 코드를 받습니다)", platform);
  }
  return undefined;
}

/**
 * bash 명령에 PowerShell 전용 문법이 실행 위치로 쓰였으면 차단 사유를, 아니면 undefined를 돌려준다.
 * `platform`은 bash 도구가 실제로 도는 OS(기본 `process.platform`)이며 안내문과 `-Command`의 `$` 판정을 가른다.
 */
export function matchPowerShellSyntax(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const body = stripHeredocBodies(command);

  for (const tokens of segmentTokens(body, platform !== "win32")) {
    const head = tokens[0];
    if (head.quoted) continue;
    const name = commandBasename(head.value);
    if (name === "powershell" || name === "pwsh") {
      const hostReason = matchPowerShellHost(tokens.slice(1), platform);
      if (hostReason) return hostReason;
      continue;
    }
    if (CMDLETS.has(name)) return reason(`cmdlet \`${head.value}\``, platform);
  }

  const masked = maskQuoted(body);
  const envVariable = /\$env:[A-Za-z_]\w*/i.exec(masked);
  if (envVariable) return reason(`\`${envVariable[0]}\``, platform);

  const assignment = /(?:^|[;&|{\n])[ \t]*(\$[A-Za-z_]\w*)[ \t]*(?:[-+*/]|\?\?)?=(?!=)/.exec(masked);
  if (assignment) return reason(`\`${assignment[1]} = ...\` 대입`, platform);

  const block = /(?:^|[;&|{\n])[ \t]*(if|elseif|foreach|while)[ \t]*\([^\n]*\)[ \t]*\{/i.exec(masked);
  if (block) return reason(`\`${block[1]} (...) { }\` 블록`, platform);

  return undefined;
}
