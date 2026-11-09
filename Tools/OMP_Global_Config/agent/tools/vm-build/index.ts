import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { dlopen, FFIType } from "bun:ffi";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOnVm, clampCpu, type BuildAction, type BuildEngine, type VmBuildOptions, type VmBuildRun } from "./build";
import { runProcess, type Runner } from "./remote";
import { Blocked, blocked, findMapping, resolveLinuxRoot, syncToVm, type SyncMode, type SyncResult, type VmBuildConfig } from "./sync";

/**
 * Linux 정본 저장소를 SSH로 연결된 Windows VM 사본에 한 방향으로 반영하고, 원하면 그 사본에서 빌드·테스트한다.
 * WSL interop용 `windows_build`와 달리 Linux 호스트 + VM 구성(WinBoat `ssh winboat`)을 위한 도구다.
 * CUELO 자체의 Linux 서버 배포(update.sh)와는 관계가 없다.
 *
 * 저장소 매핑은 `~/.omp/agent/vm-build.json`(또는 `CUELO_VM_BUILD_CONFIG`)에만 있다. 매핑이 없는 저장소·경로는 다루지
 * 않으므로 보존 사본(예: 다른 드라이브의 백업 폴더)은 설정에 넣지 않는 한 건드리지 않는다.
 * 무거운 일은 한 번에 하나만 돈다(`~/.omp/vm-build/lock`).
 */

export interface VmBuildParams extends Partial<Omit<VmBuildOptions, "project">> {
  repo?: string;
  mode?: SyncMode;
  project?: string;
  timeoutSeconds?: number;
}

export interface VmBuildResult {
  ok: boolean;
  status: "synced" | "already-current" | "built" | "build-failed" | "blocked";
  reason?: string;
  sync?: SyncResult;
  build?: Omit<VmBuildRun, "logText"> & { localLogPath: string };
}

const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 3600;
const DEFAULT_MAX_ERRORS = 20;
const STATE_DIR = join(homedir(), ".omp", "vm-build");

export function configPath(): string {
  return process.env.CUELO_VM_BUILD_CONFIG || join(homedir(), ".omp", "agent", "vm-build.json");
}

export function parseConfig(text: string, source: string): VmBuildConfig {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return blocked(`설정 파일을 읽지 못했다(${source}): ${error instanceof Error ? error.message : String(error)}`);
  }
  const config = value as Partial<VmBuildConfig>;
  if (typeof config.host !== "string" || !/^[\w.@-]+$/.test(config.host)) blocked(`설정 host가 올바르지 않다(${source})`);
  if (!Array.isArray(config.repos) || config.repos.length === 0) blocked(`설정 repos가 비어 있다(${source})`);
  for (const item of config.repos) {
    if (typeof item?.linux !== "string" || !item.linux.startsWith("/")) blocked(`repos.linux는 절대 경로여야 한다(${source})`);
    if (typeof item?.vm !== "string" || !/^[A-Za-z]:\\[^"*?<>|]+$/.test(item.vm)) blocked(`repos.vm은 드라이브 Windows 경로여야 한다(${source}): ${item?.vm}`);
  }
  return { host: config.host, repos: config.repos.map((item) => ({ linux: item.linux, vm: item.vm.replace(/\\+$/, "") })) };
}

const LOCK_EX = 2;
const LOCK_NB = 4;
let libc: { symbols: { flock: (fd: number, operation: number) => number } } | undefined;

/**
 * 같은 PC의 다른 세션과 겹치지 않게 한 번에 하나만 돈다. 커널 advisory lock(`flock`)을 쓰므로 주인 프로세스가 죽으면
 * 잠금이 저절로 풀려 죽은 잠금을 넘겨받는 처리가 필요 없다. 잠금 파일은 지우지 않는다(지우면 다른 호출이 새 파일에
 * 잠금을 걸어 겹친다). 같은 프로세스 안에서도 열기마다 잠금이 따로라 두 번째 호출은 막힌다.
 */
export async function withLock<T>(dir: string, work: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  libc ??= dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  });
  const handle = await open(join(dir, "lock"), "a");
  try {
    if (libc.symbols.flock(handle.fd, LOCK_EX | LOCK_NB) !== 0) blocked("다른 vm_build가 돌고 있다. 끝난 뒤 다시 부른다");
    return await work();
  } finally {
    await handle.close();
  }
}

export interface RunDeps {
  run: Runner;
  cwd: string;
  signal?: AbortSignal;
  now: () => number;
  readConfig: () => Promise<VmBuildConfig>;
  saveLog: (name: string, text: string) => Promise<string>;
}

export async function runVmBuild(params: VmBuildParams, deps: RunDeps): Promise<VmBuildResult> {
  try {
    const mode = params.mode ?? "commit";
    if (mode !== "commit" && mode !== "snapshot") blocked(`mode는 commit 또는 snapshot이다: ${mode}`);
    const config = await deps.readConfig();
    const root = await resolveLinuxRoot(deps.run, resolve(deps.cwd, params.repo ?? "."));
    const mapping = await findMapping(config, root);
    return await withLock(STATE_DIR, async () => {
      const sync = await syncToVm({ run: deps.run, host: config.host, signal: deps.signal, now: deps.now }, root, mapping, mode);
      if (!params.project) return { ok: true, status: sync.status, sync };
      const timeoutSeconds = Math.max(30, Math.min(MAX_TIMEOUT_SECONDS, Math.trunc(params.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS)));
      const maxErrors = Math.max(1, Math.min(200, Math.trunc(params.maxErrors ?? DEFAULT_MAX_ERRORS)));
      const { repo: _repo, mode: _mode, timeoutSeconds: _timeout, ...rest } = params;
      const run = await buildOnVm({ run: deps.run, host: config.host, signal: deps.signal, now: deps.now }, mapping.vm, sync.vmHead,
        { ...rest, project: params.project, maxCpuCount: clampCpu(params.maxCpuCount) }, timeoutSeconds, maxErrors);
      const { logText, ...build } = run;
      const localLogPath = await deps.saveLog(`${run.logPath.split("\\").at(-1) ?? "build.log"}`, logText);
      return { ok: run.ok, status: run.ok ? "built" : "build-failed", sync, build: { ...build, localLogPath } };
    });
  } catch (error) {
    if (error instanceof Blocked) return { ok: false, status: "blocked", reason: error.message };
    throw error;
  }
}

export function formatVmBuildResult(result: VmBuildResult): string {
  if (result.status === "blocked") return `중단: ${result.reason}`;
  const out: string[] = [];
  const { sync, build } = result;
  if (sync) {
    const target = sync.snapshot ? `스냅샷 ${sync.snapshot} (부모 ${sync.commit})` : sync.commit;
    out.push(sync.status === "already-current"
      ? `동기화: VM 사본이 이미 ${target}이다`
      : `동기화: ${sync.previous || "(없음)"} → ${target} (pack ${sync.packBytes} B)`);
    out.push(`저장소: ${sync.repo} → VM ${sync.vmPath} [${sync.branch}, ${sync.mode}]`);
    if (sync.mode === "commit" && sync.linuxChanges.length) {
      out.push(`Linux 미커밋 변경 ${sync.linuxChanges.length}개는 보내지 않았다(snapshot 모드로 보낼 수 있다)`);
    } else if (sync.mode === "snapshot" && sync.linuxChanges.length && sync.snapshot) {
      out.push(`스냅샷에 담은 Linux 변경 ${sync.linuxChanges.length}개`);
    }
    out.push(...sync.linuxChanges.slice(0, 5).map((line) => `  ${line}`));
    if (sync.linuxChanges.length > 5) out.push(`  … 외 ${sync.linuxChanges.length - 5}개`);
  }
  if (build) {
    const state = build.ok ? "성공" : build.killed ? "중단(시간 초과 또는 취소)" : "실패";
    out.push(`${build.action === "test" ? "테스트" : "빌드"} ${state} — exit ${build.exitCode}, ${(build.durationMs / 1000).toFixed(1)}s, ${build.engine}`);
    out.push(`프로젝트: ${build.project}`);
    out.push(`빌드한 소스: VM HEAD ${build.source.head}${build.source.branch ? ` (${build.source.branch})` : " (detached 스냅샷)"}${build.source.status ? " · 빌드 전 변경 있음" : " · 빌드 전 변경 없음"}`);
    out.push(`도구: ${build.tool} (${build.toolVersion})`);
    out.push(`오류 ${build.errorCount}개 · 경고 ${build.warningCount}개`);
    if (build.errors.length) out.push("오류:", ...build.errors.map((line) => `  ${line}`));
    if (build.warnings.length) out.push("경고(앞 일부):", ...build.warnings.map((line) => `  ${line}`));
    if (build.testSummary.length) out.push("테스트 요약:", ...build.testSummary.map((line) => `  ${line}`));
    if (!build.ok && build.errorCount === 0) out.push("콘솔 끝부분:", ...build.consoleTail.map((line) => `  ${line}`));
    const after = build.statusAfter.split(/\r?\n/).filter((line) => line.trim());
    if (after.length) {
      out.push(`주의: 빌드 뒤 VM 사본에 무시되지 않는 파일 ${after.length}개가 생겼다. 다음 동기화는 이것 때문에 멈춘다:`, ...after.slice(0, 5).map((line) => `  ${line}`));
    }
    out.push(`로그(VM): ${build.logPath}`, `로그 사본(Linux): ${build.localLogPath}`);
  }
  return out.join("\n");
}

const defaultDeps = (cwd: string, run: Runner, signal?: AbortSignal): RunDeps => ({
  run,
  cwd,
  signal,
  now: () => Date.now(),
  readConfig: async () => {
    const path = configPath();
    const text = await readFile(path, "utf8").catch(() => blocked(`설정 파일이 없다: ${path}`));
    return parseConfig(text, path);
  },
  saveLog: async (name, text) => {
    const dir = join(STATE_DIR, "logs");
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, text);
    return path;
  },
});

const factory: CustomToolFactory = (pi) => ({
  name: "vm_build",
  label: "VM Build",
  loadMode: "essential",
  description:
    "Push the Linux source of truth one way to its Windows VM copy over SSH (mapping in ~/.omp/agent/vm-build.json, e.g. `ssh winboat`), then optionally build or test it there. "
    + "mode commit fast-forwards the VM branch to the Linux branch HEAD; mode snapshot also sends uncommitted Linux changes as a detached snapshot commit (Linux index, refs and files stay untouched). "
    + "Transfers only missing objects (thin pack via scp + git index-pack); never resets, cleans, force-checks-out or mirrors, so ignored build outputs in the VM copy stay. "
    + "Stops without changing anything when the VM copy is dirty, on another branch, detached outside its own snapshot, or holds commits Linux lacks. "
    + "With `project` (repo-relative .sln/*proj) it runs MSBuild (default) or `dotnet build|test` in the VM at BelowNormal priority with -m:1 by default, and returns exit code, errors, test summary, the VM HEAD it built and log paths; outputs stay in the VM. "
    + "Build only: Run/Deploy/Publish/Install targets and Pre/PostBuildEvent properties are rejected. Not for CUELO's own server deploy. One run at a time per PC.",
  parameters: pi.zod.object({
    repo: pi.zod.string().optional().describe("Linux repository (any path inside it); default session cwd"),
    mode: pi.zod.enum(["commit", "snapshot"]).optional().describe("commit (default): branch HEAD only. snapshot: include uncommitted working-tree changes"),
    project: pi.zod.string().optional().describe("Repo-relative .sln/.slnx/*proj to build or test after syncing; omit to sync only"),
    action: pi.zod.enum(["build", "test"]).optional().describe("build (default) or test (dotnet test)"),
    engine: pi.zod.enum(["msbuild", "dotnet"]).optional().describe("msbuild (default for build) or dotnet (needed for net10 and for test)"),
    configuration: pi.zod.string().optional().describe("Configuration, e.g. Debug or Release"),
    platform: pi.zod.string().optional().describe("Platform, e.g. x86, Any CPU"),
    target: pi.zod.string().optional().describe("MSBuild target(s), e.g. Rebuild. Run/Deploy/Publish/Install are rejected"),
    msbuildProperties: pi.zod.record(pi.zod.string()).optional().describe("Extra -p:Name=Value properties"),
    restore: pi.zod.boolean().optional().describe("Allow NuGet restore (network); default false"),
    maxCpuCount: pi.zod.number().optional().describe("MSBuild -m node count, 1-4 (default 1)"),
    maxErrors: pi.zod.number().optional().describe("Error lines to return (default 20, max 200)"),
    timeoutSeconds: pi.zod.number().optional().describe("Build time limit in seconds (default 900, max 3600)"),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    onUpdate?.({ content: [{ type: "text", text: "Linux 소스를 VM 사본에 반영하는 중입니다." }], details: { phase: "sync" } });
    const result = await runVmBuild(params as VmBuildParams, defaultDeps(pi.cwd, runProcess, signal));
    return { content: [{ type: "text", text: formatVmBuildResult(result) }], details: result };
  },
});

export default factory;

const USAGE = "usage: index.ts [--repo <path>] [--mode commit|snapshot] [--project <rel>] [--action build|test] [--engine msbuild|dotnet] "
  + "[--configuration <c>] [--platform <p>] [--target <t>] [--property Name=Value]... [--restore] [--max-cpu <n>] [--timeout <s>] [--json]";

export function parseCliArgs(argv: string[]): { params: VmBuildParams; json: boolean } {
  const params: VmBuildParams = {};
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--restore") { params.restore = true; continue; }
    if (key === "--json") { json = true; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(USAGE);
    switch (key) {
      case "--repo": params.repo = value; break;
      case "--mode": params.mode = value as SyncMode; break;
      case "--project": params.project = value; break;
      case "--action": params.action = value as BuildAction; break;
      case "--engine": params.engine = value as BuildEngine; break;
      case "--configuration": params.configuration = value; break;
      case "--platform": params.platform = value; break;
      case "--target": params.target = value; break;
      case "--max-cpu": params.maxCpuCount = Number(value); break;
      case "--timeout": params.timeoutSeconds = Number(value); break;
      case "--property": {
        const at = value.indexOf("=");
        if (at <= 0) throw new Error(USAGE);
        params.msbuildProperties = { ...params.msbuildProperties, [value.slice(0, at)]: value.slice(at + 1) };
        break;
      }
      default: throw new Error(USAGE);
    }
  }
  return { params, json };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { params, json } = parseCliArgs(process.argv.slice(2));
    const result = await runVmBuild(params, defaultDeps(process.cwd(), runProcess));
    console.log(json ? JSON.stringify(result) : formatVmBuildResult(result));
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
