import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { access, mkdir, readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";

/**
 * WSL(또는 Windows)에서 Windows 전용 프로젝트(VB.NET/.NET Framework WinForms, C# 솔루션)를 MSBuild로 빌드한다.
 * 빌드만 한다: 산출물 실행·복사·배포를 하지 않고 프로젝트 파일은 읽기만 한다.
 * 콘솔 출력은 PowerShell 5.1/콘솔 코드페이지(CP949)에 따라 깨질 수 있어 쓰지 않고(-noconlog),
 * MSBuild 파일 로거가 UTF-8로 쓴 로그에서 오류·경고를 읽는다.
 */

export interface WindowsBuildParams {
  project: string;
  configuration?: string;
  platform?: string;
  target?: string;
  properties?: Record<string, string>;
  restore?: boolean;
  maxErrors?: number;
  timeoutSeconds?: number;
}

export interface ExecResult { code: number; stdout: string; stderr?: string; killed?: boolean }
export type Exec = (command: string, args: string[], options: { cwd: string; timeout?: number }) => Promise<ExecResult>;

export interface BuildDeps {
  exec: Exec;
  cwd: string;
  /** WSL이면 경로를 wslpath로 바꾼다. Windows 네이티브면 변환 없이 그대로 쓴다. */
  wsl: boolean;
  exists: (path: string) => Promise<boolean>;
  mkdirp: (path: string) => Promise<void>;
  readText: (path: string) => Promise<string | undefined>;
  env: (name: string) => string | undefined;
  now: () => number;
}

export interface BuildDiagnostics {
  errorCount: number;
  warningCount: number;
  errors: string[];
  warnings: string[];
}

export interface BuildResult extends BuildDiagnostics {
  ok: boolean;
  exitCode: number;
  killed: boolean;
  project: string;
  msbuildPath: string;
  msbuildVersion: string;
  logPath: string;
  logPathPosix: string;
  logMissing: boolean;
  consoleTail?: string[];
  durationMs: number;
}

const DEFAULT_MAX_ERRORS = 20;
const MAX_WARNING_LINES = 5;
const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;
const PROJECT_EXTENSION = /\.(sln|slnx|\w*proj)$/i;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const WSL_DRIVE_PATH = /^\/mnt\/[a-z]\//i;
const VSWHERE_RELATIVE = "Microsoft Visual Studio\\Installer\\vswhere.exe";
const DEFAULT_PROGRAM_FILES_X86 = "C:\\Program Files (x86)";
// 빌드만 한다: 실행·배포 계열 target과 빌드 전후 명령·시작 프로그램 속성은 거부한다.
const DENIED_TARGETS: Record<string, true> = { run: true, deploy: true, publish: true, install: true };
const DENIED_PROPERTIES: Record<string, true> = {
  postbuildevent: true, prebuildevent: true, startprogram: true, startaction: true, deployonbuild: true, deploytarget: true,
};
const DIAGNOSTIC_LINE = /^\s*(?:(?<origin>.*?):\s+)?(?<severity>error|warning)(?:\s+(?<code>[A-Za-z]+\d+))?\s*:\s*(?<message>.*?)\s*$/i;

export interface ProjectInput { windows?: string; posix?: string }

/**
 * 프로젝트 경로를 받아 드라이브 위 Windows 경로 또는 `/mnt/<드라이브>/` POSIX 경로로 정규화한다.
 * WSL 안(ext4)·UNC 경로는 MSBuild가 안정적으로 열지 못하므로 거부한다. 파일 존재는 여기서 보지 않는다.
 */
export function normalizeProjectInput(input: string, cwd: string, platform: NodeJS.Platform = process.platform): ProjectInput {
  const value = input.trim().replace(/^"(.*)"$/, "$1");
  if (!value) throw new Error("windows_build: project 경로가 비어 있다.");
  let result: ProjectInput;
  if (DRIVE_PATH.test(value)) {
    result = { windows: win32.normalize(value.replace(/\//g, "\\")) };
  } else if (/^\\\\/.test(value)) {
    throw new Error(`windows_build: UNC 경로는 지원하지 않는다: ${value}`);
  } else if (platform === "win32") {
    result = { windows: win32.resolve(cwd, value) };
  } else {
    const resolved = posix.resolve(cwd, value);
    if (!WSL_DRIVE_PATH.test(resolved)) {
      throw new Error(`windows_build: /mnt/<드라이브>/ 아래 Windows 드라이브 프로젝트만 빌드한다(받은 경로: ${resolved}).`);
    }
    result = { posix: resolved };
  }
  const name = result.windows ?? result.posix!;
  if (!PROJECT_EXTENSION.test(name)) {
    throw new Error(`windows_build: project는 .sln/.slnx 또는 *proj 파일이어야 한다: ${name}`);
  }
  return result;
}

function validateToken(label: string, value: string, pattern: RegExp): string {
  const trimmed = value.trim();
  if (!trimmed || !pattern.test(trimmed)) throw new Error(`windows_build: ${label} 값이 올바르지 않다: ${JSON.stringify(value)}`);
  return trimmed;
}

/** MSBuild 명령줄 인자를 만든다. project·logFile은 이미 Windows 경로여야 한다. */
export function buildMsbuildArgs(params: Omit<WindowsBuildParams, "project">, project: string, logFile: string): string[] {
  if (logFile.includes(";")) throw new Error(`windows_build: 로그 경로에 ';'가 있어 MSBuild 파일 로거에 넘길 수 없다: ${logFile}`);
  const args = ["-nologo", "-m", "-nodeReuse:false", "-noconlog", `-flp:logfile=${logFile};encoding=UTF-8;verbosity=minimal`];
  if (params.restore) args.push("-restore");
  const properties: Array<[string, string]> = [];
  if (params.configuration !== undefined) properties.push(["Configuration", validateToken("configuration", params.configuration, /^[\w .+-]+$/)]);
  if (params.platform !== undefined) properties.push(["Platform", validateToken("platform", params.platform, /^[\w .+-]+$/)]);
  for (const [name, value] of Object.entries(params.properties ?? {})) {
    if (!/^[A-Za-z_][\w.]*$/.test(name)) throw new Error(`windows_build: 속성 이름이 올바르지 않다: ${JSON.stringify(name)}`);
    if (DENIED_PROPERTIES[name.toLowerCase()]) throw new Error(`windows_build: 빌드만 허용하므로 속성 ${name}은 쓸 수 없다.`);
    if (/[\r\n\0]/.test(value)) throw new Error(`windows_build: 속성 ${name} 값에 줄바꿈이 있다.`);
    properties.push([name, value]);
  }
  for (const [name, value] of properties) args.push(`-p:${name}=${value}`);
  if (params.target !== undefined) {
    const targets = params.target.split(/[;,]/).map((item) => item.trim()).filter(Boolean);
    if (targets.length === 0) throw new Error("windows_build: target이 비어 있다.");
    for (const item of targets) {
      if (!/^[A-Za-z_][\w.-]*$/.test(item)) throw new Error(`windows_build: target 이름이 올바르지 않다: ${JSON.stringify(item)}`);
      if (DENIED_TARGETS[item.toLowerCase()]) throw new Error(`windows_build: 빌드만 허용하므로 target ${item}은 쓸 수 없다.`);
    }
    args.push(`-t:${targets.join(";")}`);
  }
  args.push(project);
  return args;
}

/**
 * MSBuild 로그·콘솔 텍스트에서 `origin: error CODE: message` / `warning` 줄을 모은다.
 * 같은 줄이 요약부에 다시 나오므로 줄 전체가 같으면 한 번만 센다. 진단 접두어(error/warning)는 현지화되지 않아
 * 한국어 MSBuild 로그에서도 같다. 요약의 "N 오류" 문구는 현지화되므로 쓰지 않는다.
 */
export function parseBuildLog(text: string, maxErrors = DEFAULT_MAX_ERRORS): BuildDiagnostics {
  const errors = new Set<string>();
  const warnings = new Set<string>();
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = DIAGNOSTIC_LINE.exec(raw);
    if (!match?.groups) continue;
    (match.groups.severity.toLowerCase() === "error" ? errors : warnings).add(raw.trim());
  }
  return {
    errorCount: errors.size,
    warningCount: warnings.size,
    errors: [...errors].slice(0, maxErrors),
    warnings: [...warnings].slice(0, Math.min(maxErrors, MAX_WARNING_LINES)),
  };
}

/** vswhere 출력에서 첫 MSBuild.exe 경로를 고른다. 없으면 undefined. */
export function parseVswhereOutput(stdout: string): string | undefined {
  return stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /msbuild\.exe$/i.test(line));
}

function nonEmptyLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function describeFailure(label: string, result: ExecResult): string {
  return `${label} (exit ${result.code}): ${(result.stderr || result.stdout || "").trim() || "출력 없음"}`;
}

export async function runWindowsBuild(params: WindowsBuildParams, deps: BuildDeps): Promise<BuildResult> {
  const { exec, cwd } = deps;
  const maxErrors = Math.max(1, Math.min(200, Math.trunc(params.maxErrors ?? DEFAULT_MAX_ERRORS)));
  const timeoutSeconds = Math.max(10, Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)));
  const input = normalizeProjectInput(params.project, cwd, deps.wsl ? "linux" : "win32");

  const convert = async (flag: "-w" | "-u", path: string): Promise<string> => {
    if (!deps.wsl) return path;
    const result = await exec("wslpath", [flag, path], { cwd });
    const converted = result.stdout.trim();
    if (result.code !== 0 || !converted) throw new Error(describeFailure(`windows_build: wslpath ${flag} ${path} 변환 실패`, result));
    return converted;
  };
  const toWindows = (path: string) => convert("-w", path);
  const toPosix = (path: string) => convert("-u", path);

  const projectWindows = input.windows ?? await toWindows(input.posix!);
  const projectPosix = input.posix ?? await toPosix(input.windows!);
  if (!(await deps.exists(projectPosix))) throw new Error(`windows_build: 프로젝트 파일이 없다: ${projectPosix}`);
  const projectDir = deps.wsl ? posix.dirname(projectPosix) : win32.dirname(projectWindows);

  // Windows 쪽 TEMP와 Program Files (x86). cmd를 UTF-8 코드페이지로 바꿔 한국어 사용자 이름 경로도 깨지지 않게 읽는다.
  let tempDir: string | undefined;
  let programFilesX86: string | undefined;
  if (deps.wsl) {
    const result = await exec("cmd.exe", ["/c", "chcp 65001>nul&echo %TEMP%&echo %ProgramFiles(x86)%"], { cwd: projectDir });
    const lines = nonEmptyLines(result.stdout);
    if (result.code === 0 && DRIVE_PATH.test(lines[0] ?? "")) tempDir = lines[0];
    if (result.code === 0 && DRIVE_PATH.test(lines[1] ?? "")) programFilesX86 = lines[1];
  } else {
    tempDir = deps.env("TEMP");
    programFilesX86 = deps.env("ProgramFiles(x86)");
  }
  if (!tempDir) throw new Error("windows_build: Windows TEMP 폴더를 알아내지 못했다.");
  programFilesX86 ??= DEFAULT_PROGRAM_FILES_X86;

  const vswhereWindows = win32.join(programFilesX86, VSWHERE_RELATIVE);
  const vswherePosix = await toPosix(vswhereWindows);
  if (!(await deps.exists(vswherePosix))) {
    throw new Error(`windows_build: MSBuild를 찾지 못했다. vswhere.exe가 없다(${vswhereWindows}). Visual Studio 또는 Build Tools(MSBuild 구성 요소)를 설치해야 한다.`);
  }
  const found = await exec(
    vswherePosix,
    ["-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "-find", "MSBuild\\**\\Bin\\MSBuild.exe", "-utf8"],
    { cwd: projectDir },
  );
  const msbuildWindows = found.code === 0 ? parseVswhereOutput(found.stdout) : undefined;
  if (!msbuildWindows) {
    throw new Error(`windows_build: MSBuild를 찾지 못했다. vswhere가 MSBuild 구성 요소가 있는 설치를 찾지 못했다${found.code === 0 ? "" : ` (exit ${found.code})`}. Visual Studio 또는 Build Tools(MSBuild 구성 요소)를 설치해야 한다.`);
  }
  const msbuildPosix = await toPosix(msbuildWindows);
  if (!(await deps.exists(msbuildPosix))) throw new Error(`windows_build: vswhere가 알려준 MSBuild가 없다: ${msbuildWindows}`);
  const versionResult = await exec(msbuildPosix, ["-version", "-nologo"], { cwd: projectDir });
  const msbuildVersion = nonEmptyLines(versionResult.stdout).at(-1) ?? "unknown";

  const logDirWindows = win32.join(tempDir, "omp-windows-build");
  const logDirPosix = await toPosix(logDirWindows);
  await deps.mkdirp(logDirPosix);
  const stamp = new Date(deps.now()).toISOString().replace(/\D/g, "").slice(0, 14);
  const logName = `build-${stamp}-${Math.random().toString(36).slice(2, 8)}.log`;
  const logPath = win32.join(logDirWindows, logName);
  const logPathPosix = deps.wsl ? posix.join(logDirPosix, logName) : logPath;

  const args = buildMsbuildArgs(params, projectWindows, logPath);
  const started = deps.now();
  const run = await exec(msbuildPosix, args, { cwd: projectDir, timeout: timeoutSeconds * 1000 });
  const durationMs = deps.now() - started;

  const logText = await deps.readText(logPathPosix);
  const consoleText = `${run.stdout}\n${run.stderr ?? ""}`;
  // 로그가 없으면 MSBuild가 빌드 전에 멈춘 것(MSB1009 프로젝트 없음 등)이라 콘솔 출력에서 읽는다.
  const diagnostics = parseBuildLog(logText ?? consoleText, maxErrors);
  const failed = run.code !== 0;
  return {
    ok: !failed,
    exitCode: run.code,
    killed: Boolean(run.killed),
    project: projectWindows,
    msbuildPath: msbuildWindows,
    msbuildVersion,
    logPath,
    logPathPosix,
    logMissing: logText === undefined,
    ...diagnostics,
    ...(failed && diagnostics.errorCount === 0 ? { consoleTail: nonEmptyLines(consoleText).slice(-15) } : {}),
    durationMs,
  };
}

export function formatBuildResult(result: BuildResult, maxErrors = DEFAULT_MAX_ERRORS): string {
  const lines: string[] = [];
  const seconds = (result.durationMs / 1000).toFixed(1);
  const status = result.ok ? "빌드 성공" : result.killed ? "빌드 중단(시간 초과 또는 취소)" : "빌드 실패";
  lines.push(`${status} — exit ${result.exitCode}, ${seconds}s`);
  lines.push(`프로젝트: ${result.project}`);
  lines.push(`MSBuild: ${result.msbuildPath} (${result.msbuildVersion})`);
  lines.push(`오류 ${result.errorCount}개 · 경고 ${result.warningCount}개`);
  if (result.errors.length > 0) {
    lines.push("오류:", ...result.errors.map((line) => `  ${line}`));
    if (result.errorCount > result.errors.length) lines.push(`  … 외 ${result.errorCount - result.errors.length}개(전체는 로그 참고, 최대 ${maxErrors}줄 표시)`);
  }
  if (result.warnings.length > 0) {
    lines.push("경고(앞 일부):", ...result.warnings.map((line) => `  ${line}`));
  }
  if (result.consoleTail?.length) lines.push("MSBuild 콘솔 끝부분:", ...result.consoleTail.map((line) => `  ${line}`));
  lines.push(`로그: ${result.logPath}${result.logMissing ? " (생성되지 않음)" : ""}`);
  if (result.logPathPosix !== result.logPath) lines.push(`로그(POSIX): ${result.logPathPosix}`);
  return lines.join("\n");
}

const defaultDeps = (cwd: string, exec: Exec): BuildDeps => ({
  exec,
  cwd,
  wsl: process.platform === "linux" && Boolean(process.env.WSL_DISTRO_NAME),
  exists: (path) => access(path).then(() => true, () => false),
  mkdirp: async (path) => { await mkdir(path, { recursive: true }); },
  readText: (path) => readFile(path, "utf8").then((text) => text, () => undefined),
  env: (name) => process.env[name],
  now: () => Date.now(),
});

const factory: CustomToolFactory = (pi) => ({
  name: "windows_build",
  label: "Windows Build",
  loadMode: "essential",
  description:
    "Build a Windows-only project (.sln/.slnx/*proj, e.g. VB.NET or C# WinForms on a /mnt/<drive> or X:\\ path) with Windows MSBuild from WSL. "
    + "Locates MSBuild through vswhere.exe, converts paths with wslpath, runs `MSBuild -nologo -m` with a UTF-8 file logger, and returns exit code, MSBuild path/version, error/warning counts, the first error lines and the log path. "
    + "Build only: never runs the built program, never touches devices, never deploys or copies outputs; Run/Deploy/Publish/Install targets and Pre/PostBuildEvent properties are rejected. "
    + "`restore: true` adds -restore (NuGet network access); default is off. Build writes bin/obj inside the project folder as a normal build does.",
  parameters: pi.zod.object({
    project: pi.zod.string().describe("Solution or project file: /mnt/<drive>/... or X:\\... (relative paths resolve from the session cwd)"),
    configuration: pi.zod.string().optional().describe("Configuration property, e.g. Debug or Release"),
    platform: pi.zod.string().optional().describe("Platform property, e.g. x86, x64, Any CPU"),
    target: pi.zod.string().optional().describe("MSBuild target(s), e.g. Rebuild or Clean;Build. Run/Deploy/Publish/Install are rejected"),
    properties: pi.zod.record(pi.zod.string()).optional().describe("Extra -p:Name=Value properties"),
    restore: pi.zod.boolean().optional().describe("Add -restore before building (default false)"),
    maxErrors: pi.zod.number().optional().describe("Number of error lines to return (default 20, max 200)"),
    timeoutSeconds: pi.zod.number().optional().describe("Build time limit in seconds (default 600, max 3600)"),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const exec: Exec = (command, args, options) => pi.exec(command, args, { ...options, signal });
    onUpdate?.({
      content: [{ type: "text", text: "MSBuild를 찾아 빌드하는 중입니다." }],
      details: { phase: "build", project: params.project },
    });
    const result = await runWindowsBuild(params as WindowsBuildParams, defaultDeps(pi.cwd, exec));
    return {
      content: [{ type: "text", text: formatBuildResult(result, Math.max(1, Math.min(200, Math.trunc(params.maxErrors ?? DEFAULT_MAX_ERRORS)))) }],
      details: result,
    };
  },
});

export default factory;
