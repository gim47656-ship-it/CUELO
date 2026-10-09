import { describe, expect, test } from "bun:test";
import {
  buildMsbuildArgs, formatBuildResult, normalizeProjectInput, parseBuildLog, parseVswhereOutput, runWindowsBuild,
  type BuildDeps, type Exec, type ExecResult,
} from "./index";

// 실제 MSBuild 18(한국어 로캘, -flp verbosity=minimal, encoding=UTF-8)이 쓴 로그를 그대로 옮긴 것이다. 맨 앞은 BOM이다.
const failedLog = [
  "\uFEFF",
  "C:\\Users\\Public\\omp-wb-smoke\\A.cs(1,71): warning CS0219: 'unused' 할당되었지만 사용되지 않았습니다. [C:\\Users\\Public\\omp-wb-smoke\\Smoke.csproj]",
  "C:\\Users\\Public\\omp-wb-smoke\\B.cs(1,62): error CS0029: 암시적으로 'string' 형식을 'int' 형식으로 변환할 수 없습니다. [C:\\Users\\Public\\omp-wb-smoke\\Smoke.csproj]",
  "C:\\Users\\Public\\omp-wb-smoke\\B.cs(1,91): error CS0103: 'Missing' 이름이 현재 컨텍스트에 없습니다. [C:\\Users\\Public\\omp-wb-smoke\\Smoke.csproj]",
  "",
].join("\r\n");

const MSBUILD = "C:\\Program Files\\Microsoft Visual Studio\\18\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe";
const TEMP = "C:\\Users\\user\\AppData\\Local\\Temp";
const PF86 = "C:\\Program Files (x86)";

describe("normalizeProjectInput", () => {
  test("keeps /mnt drive paths and resolves relative ones from cwd", () => {
    expect(normalizeProjectInput("/mnt/d/work/App.sln", "/home/x", "linux")).toEqual({ posix: "/mnt/d/work/App.sln" });
    expect(normalizeProjectInput("sub/App.vbproj", "/mnt/c/proj", "linux")).toEqual({ posix: "/mnt/c/proj/sub/App.vbproj" });
  });

  test("accepts Windows drive paths with either slash and strips quotes", () => {
    expect(normalizeProjectInput("\"D:/work/App.csproj\"", "/home/x", "linux")).toEqual({ windows: "D:\\work\\App.csproj" });
    expect(normalizeProjectInput("C:\\a\\..\\b\\App.slnx", "/home/x", "linux")).toEqual({ windows: "C:\\b\\App.slnx" });
  });

  test("rejects WSL-internal, UNC and non-project paths", () => {
    expect(() => normalizeProjectInput("/home/user/App.sln", "/home/user", "linux")).toThrow("/mnt/<드라이브>/");
    expect(() => normalizeProjectInput("\\\\wsl.localhost\\Ubuntu\\App.sln", "/mnt/c", "linux")).toThrow("UNC");
    expect(() => normalizeProjectInput("/mnt/c/proj/Form1.vb", "/mnt/c", "linux")).toThrow("*proj");
    expect(() => normalizeProjectInput("  ", "/mnt/c", "linux")).toThrow("비어");
  });
});

describe("buildMsbuildArgs", () => {
  const log = "C:\\Temp\\b.log";
  test("builds the standard flags with the UTF-8 file logger and project last", () => {
    expect(buildMsbuildArgs({}, "C:\\p\\App.sln", log)).toEqual([
      "-nologo", "-m", "-nodeReuse:false", "-noconlog", "-flp:logfile=C:\\Temp\\b.log;encoding=UTF-8;verbosity=minimal", "C:\\p\\App.sln",
    ]);
  });

  test("adds configuration, platform with a space, properties, targets and restore", () => {
    const args = buildMsbuildArgs(
      { configuration: "Release", platform: "Any CPU", target: "Clean, Build", msbuildProperties: { OutputPath: "bin\\x\\" }, restore: true },
      "C:\\p\\App.vbproj", log,
    );
    expect(args.slice(4)).toEqual([
      "-flp:logfile=C:\\Temp\\b.log;encoding=UTF-8;verbosity=minimal", "-restore",
      "-p:Configuration=Release", "-p:Platform=Any CPU", "-p:OutputPath=bin\\x\\", "-t:Clean;Build", "C:\\p\\App.vbproj",
    ]);
  });

  test("rejects run/deploy targets, build-event properties and injection-shaped values", () => {
    expect(() => buildMsbuildArgs({ target: "Build;Publish" }, "p.sln", log)).toThrow("Publish");
    expect(() => buildMsbuildArgs({ target: "Run" }, "p.sln", log)).toThrow("Run");
    expect(() => buildMsbuildArgs({ msbuildProperties: { PostBuildEvent: "copy a b" } }, "p.sln", log)).toThrow("PostBuildEvent");
    expect(() => buildMsbuildArgs({ msbuildProperties: { "A=B": "x" } }, "p.sln", log)).toThrow("속성 이름");
    expect(() => buildMsbuildArgs({ configuration: "Debug;Evil" }, "p.sln", log)).toThrow("configuration");
    expect(() => buildMsbuildArgs({}, "p.sln", "C:\\a;b\\x.log")).toThrow("';'");
  });
});

describe("parseBuildLog", () => {
  test("counts and lists diagnostics from a captured Korean-locale log without relying on the localized summary", () => {
    const result = parseBuildLog(failedLog, 1);
    expect(result.errorCount).toBe(2);
    expect(result.warningCount).toBe(1);
    expect(result.errors).toEqual([
      "C:\\Users\\Public\\omp-wb-smoke\\B.cs(1,62): error CS0029: 암시적으로 'string' 형식을 'int' 형식으로 변환할 수 없습니다. [C:\\Users\\Public\\omp-wb-smoke\\Smoke.csproj]",
    ]);
    expect(result.warnings).toHaveLength(1);
  });

  test("counts an error repeated in a summary once and recognizes code-less and origin-less errors", () => {
    const text = [
      "Program.cs(3,1): error CS1002: ; expected [C:\\p\\p.csproj]",
      "Build FAILED.",
      "Program.cs(3,1): error CS1002: ; expected [C:\\p\\p.csproj]",
      "C:\\p\\Err.proj(1,31): error : boom",
      "MSBUILD : error MSB1009: Project file does not exist.",
      "    2 Error(s)",
      "Compiling error handling module",
    ].join("\n");
    const result = parseBuildLog(text);
    expect(result.errorCount).toBe(3);
    expect(result.warningCount).toBe(0);
    expect(result.errors[2]).toBe("MSBUILD : error MSB1009: Project file does not exist.");
  });
});

describe("parseVswhereOutput", () => {
  test("returns the first MSBuild.exe line and undefined for empty output", () => {
    expect(parseVswhereOutput(`\r\n${MSBUILD}\r\nC:\\other\\MSBuild.exe\r\n`)).toBe(MSBUILD);
    expect(parseVswhereOutput("\r\n")).toBeUndefined();
  });
});

interface Fake {
  deps: BuildDeps;
  calls: Array<{ command: string; args: string[]; cwd: string; timeout?: number }>;
}

const toWindows = (posix: string) => posix.replace(/^\/mnt\/([a-z])\//, (_m, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\");
const toPosix = (windows: string) => windows.replace(/^([A-Za-z]):\\/, (_m, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");

function fake(options: { vswhere?: ExecResult; msbuild?: Partial<ExecResult>; log?: string; existing?: (path: string) => boolean } = {}): Fake {
  const calls: Fake["calls"] = [];
  const logs = new Map<string, string>();
  const exec: Exec = async (command, args, opts) => {
    calls.push({ command, args, cwd: opts.cwd, timeout: opts.timeout });
    if (command === "wslpath") return { code: 0, stdout: `${args[0] === "-w" ? toWindows(args[1]) : toPosix(args[1])}\n` };
    if (command === "cmd.exe") return { code: 0, stdout: `${TEMP}\r\n${PF86}\r\n` };
    if (command.endsWith("vswhere.exe")) return options.vswhere ?? { code: 0, stdout: `${MSBUILD}\r\n` };
    if (args.includes("-version")) return { code: 0, stdout: "\r\n18.10.1.42706\r\n" };
    const flp = args.find((arg) => arg.startsWith("-flp:logfile="));
    if (flp && options.log !== undefined) logs.set(toPosix(flp.slice("-flp:logfile=".length).split(";")[0]), options.log);
    return { code: 1, stdout: "", stderr: "", ...options.msbuild };
  };
  const deps: BuildDeps = {
    exec, cwd: "/mnt/c/proj", wsl: true,
    exists: async (path) => options.existing?.(path) ?? true,
    mkdirp: async () => {},
    readText: async (path) => logs.get(path),
    env: () => undefined,
    now: (() => { let t = 1_760_000_000_000; return () => (t += 1500); })(),
  };
  return { deps, calls };
}

describe("runWindowsBuild", () => {
  test("converts paths with wslpath, runs MSBuild from the project directory and returns the standardized result", async () => {
    const { deps, calls } = fake({ log: failedLog });
    const result = await runWindowsBuild({ project: "/mnt/d/work/App.sln", configuration: "Debug" }, deps);

    expect(calls.find((call) => call.command === "wslpath")?.args).toEqual(["-w", "/mnt/d/work/App.sln"]);
    const vswhere = calls.find((call) => call.command.endsWith("vswhere.exe"))!;
    expect(vswhere.command).toBe("/mnt/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe");
    expect(vswhere.args).toEqual(["-latest", "-products", "*", "-requires", "Microsoft.Component.MSBuild", "-find", "MSBuild\\**\\Bin\\MSBuild.exe", "-utf8"]);
    const build = calls.at(-1)!;
    expect(build.command).toBe("/mnt/c/Program Files/Microsoft Visual Studio/18/Community/MSBuild/Current/Bin/MSBuild.exe");
    expect(build.cwd).toBe("/mnt/d/work");
    expect(build.timeout).toBe(600_000);
    expect(build.args.at(-1)).toBe("D:\\work\\App.sln");
    expect(build.args).toContain("-p:Configuration=Debug");

    expect(result).toMatchObject({
      ok: false, exitCode: 1, msbuildPath: MSBUILD, msbuildVersion: "18.10.1.42706", project: "D:\\work\\App.sln",
      errorCount: 2, warningCount: 1, logMissing: false,
    });
    expect(result.logPath.startsWith(`${TEMP}\\omp-windows-build\\build-`)).toBe(true);
    expect(result.logPathPosix.startsWith("/mnt/c/Users/user/AppData/Local/Temp/omp-windows-build/build-")).toBe(true);
    expect(result.consoleTail).toBeUndefined();
    const text = formatBuildResult(result);
    expect(text).toContain("빌드 실패 — exit 1");
    expect(text).toContain("오류 2개 · 경고 1개");
    expect(text).toContain(result.logPath);
  });

  test("reports success for exit 0 and a Windows drive project path", async () => {
    const { deps } = fake({ log: "\uFEFF\r\n", msbuild: { code: 0 } });
    const result = await runWindowsBuild({ project: "D:\\work\\App.vbproj" }, deps);
    expect(result).toMatchObject({ ok: true, exitCode: 0, errorCount: 0, warningCount: 0, project: "D:\\work\\App.vbproj" });
    expect(formatBuildResult(result)).toContain("빌드 성공");
  });

  test("falls back to console output when MSBuild stops before it writes a log", async () => {
    const { deps } = fake({ msbuild: { code: 1, stdout: "MSBUILD : error MSB1009: 프로젝트 파일이 없습니다.\r\n스위치: C:\\x.vbproj\r\n" } });
    const result = await runWindowsBuild({ project: "/mnt/c/x.vbproj" }, deps);
    expect(result).toMatchObject({ ok: false, logMissing: true, errorCount: 1 });
    expect(result.errors[0]).toContain("MSB1009");
  });

  test("keeps a console tail when the build fails without any parsable diagnostic", async () => {
    const { deps } = fake({ log: "", msbuild: { code: -1, killed: true, stdout: "line one\r\nline two\r\n" } });
    const result = await runWindowsBuild({ project: "/mnt/c/x.sln" }, deps);
    expect(result).toMatchObject({ ok: false, killed: true, errorCount: 0, consoleTail: ["line one", "line two"] });
    expect(formatBuildResult(result)).toContain("빌드 중단");
  });

  test("returns a clear not-found error when vswhere or MSBuild is absent", async () => {
    const noVswhere = fake({ existing: (path) => !path.endsWith("vswhere.exe") });
    await expect(runWindowsBuild({ project: "/mnt/c/x.sln" }, noVswhere.deps)).rejects.toThrow("MSBuild를 찾지 못했다. vswhere.exe가 없다");
    expect(noVswhere.calls.some((call) => call.args.includes("-nologo"))).toBe(false);

    const noInstall = fake({ vswhere: { code: 0, stdout: "\r\n" } });
    await expect(runWindowsBuild({ project: "/mnt/c/x.sln" }, noInstall.deps)).rejects.toThrow("Build Tools(MSBuild 구성 요소)");
  });

  test("refuses a missing project file before invoking any Windows program", async () => {
    const { deps, calls } = fake({ existing: () => false });
    await expect(runWindowsBuild({ project: "/mnt/c/missing.sln" }, deps)).rejects.toThrow("프로젝트 파일이 없다");
    expect(calls.some((call) => call.command === "cmd.exe")).toBe(false);
  });
});
