/**
 * OMP `bash` 도구의 내장 셸은 PowerShell도 Git Bash도 아니다. PowerShell 전용 문법을 실행 위치에 쓰면
 * 실행 뒤에 `pi-natives:command: syntax error`로만 드러나므로, 실행 전에 같은 기준으로 거절한다.
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

const GUIDANCE =
  "PowerShell 로직은 `write`로 .ps1 파일을 만든 뒤 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:/절대/슬래시/경로.ps1`로 실행하세요.";

function reason(subject: string): string {
  return `bash 도구의 내장 셸은 PowerShell이 아니라서 ${subject}는 실행 전에 차단됩니다. ${GUIDANCE}`;
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
}

/** 따옴표를 존중해 명령 구분자(; | & 줄바꿈 괄호)로 나눈 세그먼트별 토큰. */
function segmentTokens(command: string): Token[][] {
  const segments: Token[][] = [];
  let tokens: Token[] = [];
  let value = "";
  let started = false;
  let quoted = false;
  let quote: "'" | '"' | undefined;
  const endToken = (): void => {
    if (started) tokens.push({ value, quoted });
    value = "";
    started = false;
    quoted = false;
  };
  const endSegment = (): void => {
    endToken();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
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
function matchPowerShellHost(args: Token[]): string | undefined {
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
  if (args.slice(commandIndex + 1).some((arg) => arg.value.includes("$"))) {
    return reason("`-Command` 인자의 `$`(bash 층이 변형해 PowerShell이 다른 코드를 받습니다)");
  }
  return undefined;
}

/** bash 명령에 PowerShell 전용 문법이 실행 위치로 쓰였으면 차단 사유를, 아니면 undefined를 돌려준다. */
export function matchPowerShellSyntax(command: string): string | undefined {
  const body = stripHeredocBodies(command);

  for (const tokens of segmentTokens(body)) {
    const head = tokens[0];
    if (head.quoted) continue;
    const name = commandBasename(head.value);
    if (name === "powershell" || name === "pwsh") {
      const hostReason = matchPowerShellHost(tokens.slice(1));
      if (hostReason) return hostReason;
      continue;
    }
    if (CMDLETS.has(name)) return reason(`cmdlet \`${head.value}\``);
  }

  const masked = maskQuoted(body);
  const envVariable = /\$env:[A-Za-z_]\w*/i.exec(masked);
  if (envVariable) return reason(`\`${envVariable[0]}\``);

  const assignment = /(?:^|[;&|{\n])[ \t]*(\$[A-Za-z_]\w*)[ \t]*(?:[-+*/]|\?\?)?=(?!=)/.exec(masked);
  if (assignment) return reason(`\`${assignment[1]} = ...\` 대입`);

  const block = /(?:^|[;&|{\n])[ \t]*(if|elseif|foreach|while)[ \t]*\([^\n]*\)[ \t]*\{/i.exec(masked);
  if (block) return reason(`\`${block[1]} (...) { }\` 블록`);

  return undefined;
}
