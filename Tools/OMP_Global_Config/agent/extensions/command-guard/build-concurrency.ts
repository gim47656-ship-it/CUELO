import { readFileSync, readlinkSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { invokedCommandLines } from "./matcher";
import { BUILD_RESERVATION_MS, type BuildReservationStore } from "./build-reservations";

// Main's 2026-11-06 home observation: one verify build on 30.5 GiB RAM under MemoryMax=8G
// peaked at 7,703,035,904 B (~7.17 GiB, including page cache); system MemAvailable reached 4,895,664 kB.
// Keep 6 GiB admission headroom (not a build cap): above the known-failing 4 GiB cap, below that ~7.2 GiB peak.
// On the 8 GiB cloud host, refusal protects the live CUELO server rather than capping a build into OOM.
export const MIN_BUILD_AVAILABLE_BYTES = 6 * 1024 ** 3;

export interface BuildResourceReaders {
  listPids(): string[];
  readFile(path: string): string;
  readLink(path: string): string;
  currentPid: number;
  log(message: string): void;
}

const procReaders: BuildResourceReaders = {
  listPids: () => readdirSync("/proc"),
  readFile: (path) => readFileSync(path, "utf8"),
  readLink: readlinkSync,
  currentPid: process.pid,
  log: (message) => console.warn(message),
};

export interface RunningBuild {
  pid: number;
  command: string;
  cwd: string;
  startedAt: string;
  distDir?: string;
}

export interface BuildResources {
  availableBytes: number;
  builds: RunningBuild[];
}

function name(word: string): string {
  return basename(word.replace(/\\/g, "/")).replace(/\.(?:exe|cmd|bat)$/i, "");
}

// Runner CLI arguments, not shell syntax: shell wrappers/quoting/chains belong to matcher.ts.
function runnerArgs(args: string[], runner: string): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index]!;
    if (arg === "--") return args.slice(index + 1);
    if (!arg.startsWith("-")) break;
    if (/^(?:-e|--eval|-c|--command)$/.test(arg)) return [];
    const takesValue = /^(?:-r|--require|--import|--loader|--cwd|--prefix|-C|--dir|-p|--package|--workspace|--filter|-F)$/.test(arg)
      || (arg === "-w" && (runner === "npm" || runner === "npx"));
    index += takesValue ? 2 : 1;
  }
  return args.slice(index);
}

function isBuildInvocation(word: string, args: string[]): boolean {
  const program = name(word);
  if (/^next(?:@[^/]+)?$/.test(program)) return args[0] === "build";
  if (!/^(?:bun|bunx|npx|node|npm|pnpm|yarn)$/.test(program)) return false;
  const command = runnerArgs(args, program);
  if (program === "yarn" && command[0] === "workspace" && command[1]) {
    return isBuildInvocation("yarn", command.slice(2));
  }
  if (command[0] === "run" || command[0] === "run-script") {
    const script = runnerArgs(command.slice(1), program);
    // Conservatively treat package build scripts as heavy, without executing/reading package.json.
    if (script[0] === "build") return true;
    return program === "bun" && script[0] !== undefined && isBuildInvocation(script[0], script.slice(1));
  }
  if (/^(?:pnpm|yarn)$/.test(program) && command[0] === "build") return true;
  if (command[0] === "exec" || command[0] === "x" || (program === "pnpm" && command[0] === "dlx")) {
    const nested = runnerArgs(command.slice(1), program);
    return nested[0] !== undefined && isBuildInvocation(nested[0], nested.slice(1));
  }
  return command[0] !== undefined && /^next(?:@[^/]+)?$/.test(name(command[0])) && command[1] === "build";
}

export function isHeavyBuildCommand(command: string): boolean {
  return invokedCommandLines(command).some(({ word, args }) => isBuildInvocation(word, args));
}

function isRunningBuild(argv: string[]): boolean {
  // A process title may replace argv. Only the explicit Next build title is accepted, not next-server/dev/start.
  if (/^next build(?: \(v[^)]+\))?$/.test(argv[0] ?? "")) return true;
  return argv[0] !== undefined && isBuildInvocation(argv[0], argv.slice(1));
}

function vanished(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

/** Read-only machine-wide snapshot. Inaccessible procfs fails open; processes exiting during the scan are normal. */
export function readBuildResources(readers: BuildResourceReaders = procReaders): BuildResources | undefined {
  if (readers === procReaders && process.platform !== "linux") return undefined;
  try {
    const available = /^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(readers.readFile("/proc/meminfo"));
    if (!available) throw new Error("MemAvailable is missing from /proc/meminfo");
    const builds: RunningBuild[] = [];
    let bootSeconds: number | undefined;
    for (const entry of readers.listPids()) {
      if (!/^\d+$/.test(entry) || Number(entry) === readers.currentPid) continue;
      const root = `/proc/${entry}`;
      try {
        const argv = readers.readFile(`${root}/cmdline`).split("\0").filter(Boolean);
        if (!isRunningBuild(argv)) continue;
        const cwd = readers.readLink(`${root}/cwd`);
        const stat = readers.readFile(`${root}/stat`);
        // comm may contain spaces and ')'; fields following its final ')' start at field 3.
        const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19]);
        if (!Number.isFinite(ticks)) throw new Error(`Invalid process start time: ${root}/stat`);
        if (bootSeconds === undefined) {
          const boot = /^btime\s+(\d+)$/m.exec(readers.readFile("/proc/stat"));
          if (!boot) throw new Error("btime is missing from /proc/stat");
          bootSeconds = Number(boot[1]);
        }
        // Linux procfs exposes starttime in USER_HZ (100 ticks/second), including WSL.
        const startedAt = new Date((bootSeconds + ticks / 100) * 1000).toISOString();
        const distDir = readers.readFile(`${root}/environ`).split("\0")
          .find((value) => /^(?:CUELO_DIST_DIR|NEXT_DIST_DIR)=/.test(value))?.split("=").slice(1).join("=");
        builds.push({ pid: Number(entry), command: argv.join(" "), cwd, startedAt, ...(distDir ? { distDir } : {}) });
      } catch (error) {
        if (!vanished(error)) throw error;
      }
    }
    return { availableBytes: Number(available[1]) * 1024, builds };
  } catch (error) {
    readers.log(`[BuildConcurrencyGuard] /proc 조회 실패로 빌드 검사를 건너뜁니다: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function buildConcurrencyBlockReason(
  command: string,
  readers?: BuildResourceReaders,
  reservation?: { cwd: string; sessionId: string; store: BuildReservationStore },
): string | undefined {
  if (!isHeavyBuildCommand(command)) return undefined;
  const resources = readBuildResources(readers);
  if (!resources) return undefined;
  const { builds, availableBytes } = resources;
  const pending = builds.length === 0 && availableBytes >= MIN_BUILD_AVAILABLE_BYTES && reservation
    ? reservation.store.reserve({ cwd: reservation.cwd, sessionId: reservation.sessionId })
    : undefined;
  if (builds.length === 0 && availableBytes >= MIN_BUILD_AVAILABLE_BYTES && !pending) return undefined;
  const running = builds.length > 0
    ? builds.map((build) => `- pid=${build.pid} cwd=${build.cwd} 시작=${build.startedAt}${build.distDir ? ` dist=${build.distDir}` : ""} 명령=${build.command}`).join("\n")
    : pending
      ? `- 빌드 시작 예약 session=${pending.sessionId} cwd=${pending.cwd} 시작=${new Date(pending.createdAt).toISOString()} 만료=${new Date(pending.createdAt + BUILD_RESERVATION_MS).toISOString()}`
      : "- 실행 중인 프로덕션 빌드 없음";
  const minimumGiB = MIN_BUILD_AVAILABLE_BYTES / 1024 ** 3;
  return `[BuildConcurrencyGuard] 프로덕션 빌드 명령을 차단했습니다: ${command}\n` +
    `${running}\nMemAvailable=${(availableBytes / 1024 ** 3).toFixed(2)} GiB (최소 ${minimumGiB} GiB).\n` +
    (pending
      ? `표시된 빌드 시작 예약이 만료된 뒤 가용 메모리가 ${minimumGiB} GiB 이상일 때 다시 실행하세요. `
      : `실행 중인 빌드가 끝나고 가용 메모리가 ${minimumGiB} GiB 이상일 때 다시 실행하세요. `) +
    "여러 Maker는 프로덕션 빌드를 한 번에 하나만 실행하도록 조율하세요.";
}
