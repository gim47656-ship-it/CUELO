/**
 * 동기화된 VM 사본에서 MSBuild 또는 dotnet으로 빌드·테스트하고 종료 코드·로그·적용 소스 증거만 가져온다.
 *
 * 산출물(bin/obj, 테스트 결과)은 VM 사본 안에 그대로 두고 Linux로 가져오지 않는다. 로그는 VM
 * `%LOCALAPPDATA%\cuelo-vm-build\logs`에 남고, 같은 내용의 사본만 Linux `~/.omp/vm-build/logs`(소스 트리 밖)에 둔다.
 * VM 쪽 PowerShell과 빌드 프로세스는 BelowNormal 우선순위로 돌고, 병렬 노드 수는 기본 1이다.
 */
import { posix, win32 } from "node:path";
import { buildMsbuildArgs, parseBuildLog, type BuildDiagnostics, type WindowsBuildParams } from "../windows-build/index";
import { runRemote, type Runner } from "./remote";
import { blocked, vmSafeDirectory } from "./sync";

export type BuildAction = "build" | "test";
export type BuildEngine = "msbuild" | "dotnet";

export interface VmBuildOptions extends Omit<WindowsBuildParams, "project"> {
  /** 저장소 루트 기준 상대 경로(`/` 구분). */
  project: string;
  action?: BuildAction;
  engine?: BuildEngine;
  maxCpuCount?: number;
}

export interface VmBuildRun extends BuildDiagnostics {
  ok: boolean;
  exitCode: number;
  killed: boolean;
  action: BuildAction;
  engine: BuildEngine;
  project: string;
  tool: string;
  toolVersion: string;
  durationMs: number;
  /** 빌드 직전 VM 사본의 HEAD·브랜치·상태. */
  source: { head: string; branch: string; status: string };
  /** 빌드 뒤 VM 사본에 생긴 무시되지 않는 변경. 비어 있지 않으면 다음 동기화가 멈춘다. */
  statusAfter: string;
  testSummary: string[];
  consoleTail: string[];
  logPath: string;
  logText: string;
}

const PROJECT_EXTENSION = /\.(sln|slnx|\w*proj)$/i;
export const DEFAULT_MAX_CPU = 1;
const MAX_CPU = 4;
const CONSOLE_TAIL = 15;

/** 저장소 상대 프로젝트 경로를 검증하고 VM 쪽 Windows 경로로 바꾼다. */
export function resolveVmProject(vmRoot: string, project: string): { relative: string; windows: string } {
  const relative = posix.normalize(project.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!relative || relative === "." || relative.startsWith("../") || relative === ".." || posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative)) {
    blocked(`project는 저장소 루트 기준 상대 경로여야 한다: ${project}`);
  }
  if (!PROJECT_EXTENSION.test(relative)) blocked(`project는 .sln/.slnx 또는 *proj 파일이어야 한다: ${project}`);
  return { relative, windows: win32.join(vmRoot, ...relative.split("/")) };
}

export function clampCpu(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_CPU;
  return Math.max(1, Math.min(MAX_CPU, Math.trunc(value)));
}

/** 빌드 도구 인자. 속성·target 검증은 windows_build와 같은 규칙(실행·배포 target, 빌드 이벤트 속성 거부)을 쓴다. */
export function buildCommandArgs(options: VmBuildOptions, projectWindows: string, logPath: string): string[] {
  const action = options.action ?? "build";
  const engine = options.engine ?? (action === "test" ? "dotnet" : "msbuild");
  // CLI와 도구 입력은 런타임에 다시 본다. 다른 dotnet 동사(publish 등)가 실행·배포 금지를 우회하지 못하게 둘만 허용한다.
  if (action !== "build" && action !== "test") blocked(`action은 build 또는 test다: ${String(action)}`);
  if (engine !== "msbuild" && engine !== "dotnet") blocked(`engine은 msbuild 또는 dotnet이다: ${String(engine)}`);
  const cpu = clampCpu(options.maxCpuCount);
  if (action === "test" && engine !== "dotnet") blocked("test는 dotnet engine으로만 돌린다(dotnet test)");
  if (action === "test" && options.target !== undefined) blocked("test에는 target을 줄 수 없다");
  const msbuild = buildMsbuildArgs(options, projectWindows, logPath, cpu);
  if (engine === "msbuild") return msbuild;
  // dotnet은 같은 MSBuild 인자를 받는다. 테스트 결과 요약이 콘솔 로거로 나오므로 -noconlog는 뺀다.
  const forwarded = msbuild.filter((arg) => arg.startsWith("-p:") || arg.startsWith("-t:") || arg.startsWith("-flp:"));
  return [action, projectWindows, "-nologo", `-m:${cpu}`, "-nodeReuse:false", ...forwarded, ...(options.restore ? [] : ["--no-restore"])];
}

/** CreateProcess 규칙대로 인자 하나를 따옴표 처리한다. */
export function quoteWindowsArg(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/** dotnet test 콘솔에서 결과 요약 줄만 고른다(DOTNET_CLI_UI_LANGUAGE=en). */
export function summarizeTests(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^(Passed!|Failed!)\s|^Total tests:|^\s*(Passed|Failed|Skipped|Total):\s*\d+|^Test Run (Successful|Failed|Aborted)/.test(line));
}

const BUILD = String.raw`
if (-not (Test-Path -LiteralPath $P.project)) { Emit @{ fatal = "project file not found in the VM: $($P.project)" } }
$pd = Split-Path -Parent $P.project
$log = Join-Path $env:LOCALAPPDATA ('cuelo-vm-build\logs\' + $P.logName)
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
$b = G @('symbolic-ref','--short','-q','HEAD')
$st = G @('status','--porcelain','--untracked-files=normal')
$src = @{ head = (G @('rev-parse','HEAD')).out; branch = $(if ($b.code -eq 0) { $b.out } else { '' }); status = $st.out }
if ($src.head -cne $P.expectHead) { Emit @{ fatal = "VM HEAD ($($src.head)) differs from the revision just synced ($($P.expectHead))" } }
if ($st.code -ne 0 -or $st.out) { Emit @{ fatal = "VM copy changed after sync; not building (git status exit $($st.code)): $($st.out)" } }
if ($P.engine -eq 'msbuild') {
  $vw = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
  if (-not (Test-Path -LiteralPath $vw)) { Emit @{ fatal = "vswhere.exe not found: $vw" } }
  $exe = & $vw -latest -products * -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' -utf8 | Select-Object -First 1
  if (-not $exe) { Emit @{ fatal = 'vswhere found no MSBuild' } }
  $ver = & $exe -version -nologo | Select-Object -Last 1
} else {
  $cmd = Get-Command dotnet -ErrorAction SilentlyContinue
  if (-not $cmd) { Emit @{ fatal = 'dotnet is not on PATH' } }
  $exe = $cmd.Source
  $ver = & $exe --version | Select-Object -Last 1
}
$env:DOTNET_CLI_UI_LANGUAGE = 'en'; $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'; $env:DOTNET_NOLOGO = '1'
$env:MSBUILDDISABLENODEREUSE = '1'; $env:DOTNET_CLI_FORCE_UTF8_ENCODING = 'true'
$out = "$log.out.txt"; $err = "$log.err.txt"
if ($log -match '[\s;"]') { Emit @{ fatal = "VM log path contains a space, ';' or quote and cannot be passed to the MSBuild file logger: $log" } }
$argLine = $P.args.Replace('__LOG__', $log)
$sw = [Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $pd -NoNewWindow -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
$null = $proc.Handle
try { $proc.PriorityClass = 'BelowNormal' } catch {}
$killed = $false
if (-not $proc.WaitForExit([int]$P.timeoutMs)) { $killed = $true; & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null; $proc.WaitForExit() }
$code = $proc.ExitCode
function ReadTail($p, $max) {
  if (-not (Test-Path -LiteralPath $p)) { return '' }
  $t = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
  if ($t.Length -gt $max) { $t.Substring($t.Length - $max) } else { $t }
}
Emit @{ exitCode = $code; killed = $killed; tool = "$exe"; version = "$ver"; durationMs = $sw.ElapsedMilliseconds; source = $src
  statusAfter = (G @('status','--porcelain','--untracked-files=normal')).out; logPath = $log
  log = (ReadTail $log 1000000); stdout = (ReadTail $out 200000); stderr = (ReadTail $err 50000) }
`;

interface RemoteBuild {
  fatal?: string;
  exitCode: number;
  killed: boolean;
  tool: string;
  version: string;
  durationMs: number;
  source: { head: string; branch: string; status: string };
  statusAfter: string;
  logPath: string;
  log: string;
  stdout: string;
  stderr: string;
}

export interface BuildDeps {
  /** 취소 신호가 붙은 runner(`cancellable`). */
  run: Runner;
  host: string;
  now: () => number;
}

export async function buildOnVm(deps: BuildDeps, vmRoot: string, expectHead: string, options: VmBuildOptions, timeoutSeconds: number, maxErrors: number): Promise<VmBuildRun> {
  const action = options.action ?? "build";
  const engine = options.engine ?? (action === "test" ? "dotnet" : "msbuild");
  const project = resolveVmProject(vmRoot, options.project);
  // 로그 경로는 VM에서 정한다(%LOCALAPPDATA%). 인자 검증을 위해 자리표시자로 만들고 VM에서 바꾼다.
  const args = buildCommandArgs({ ...options, action, engine }, project.windows, "__LOG__");
  const stamp = new Date(deps.now()).toISOString().replace(/\D/g, "").slice(0, 14);
  const logName = `${stamp}-${Math.random().toString(36).slice(2, 8)}.log`;
  const remote = await runRemote<RemoteBuild>(deps.run, deps.host, BUILD, {
    repo: vmRoot, safe: vmSafeDirectory(vmRoot), project: project.windows, engine, expectHead, logName,
    args: args.map(quoteWindowsArg).join(" "), timeoutMs: timeoutSeconds * 1000,
  }, (timeoutSeconds + 180) * 1000);
  if (remote.fatal) blocked(`VM 빌드를 시작하지 못했다: ${remote.fatal}`);
  const consoleText = `${remote.stdout ?? ""}\n${remote.stderr ?? ""}`;
  const diagnostics = parseBuildLog(remote.log || consoleText, maxErrors);
  const ok = remote.exitCode === 0 && !remote.killed;
  return {
    ok,
    exitCode: remote.exitCode,
    killed: Boolean(remote.killed),
    action,
    engine,
    project: project.windows,
    tool: remote.tool,
    toolVersion: remote.version,
    durationMs: remote.durationMs,
    source: remote.source,
    statusAfter: remote.statusAfter ?? "",
    ...diagnostics,
    testSummary: summarizeTests(remote.stdout ?? ""),
    consoleTail: consoleText.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim()).slice(-CONSOLE_TAIL),
    logPath: remote.logPath,
    logText: [remote.log ?? "", "---- stdout ----", remote.stdout ?? "", "---- stderr ----", remote.stderr ?? ""].join("\n"),
  };
}
