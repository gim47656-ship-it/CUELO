import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// 2026-11-14: 집 PC(Linux Mint, RAM 24 GB)에서 WinBoat VM(QEMU RSS 약 8.4 GB)이 켜진 채 production 빌드나 전체 시험을 돌리면
// 메모리가 모자라 빌드가 OOM으로 죽는다. 무거운 로컬 작업 직전에 여유가 기준 미만이면 VM을 정상 종료(ACPI)하고, 마지막 작업이
// 끝나면 다시 켠다. 사용자가 끈 VM은 켜지 않고, Windows 빌드(vm_build)나 VM 화면 연결이 있으면 끄지 않는다.

export interface GuardConfig {
  /** MemAvailable이 이 값(GB) 미만이면 무거운 작업 전에 VM을 끈다. */
  thresholdGb: number;
  /** 무거운 명령 패턴(정규식 글). 명령을 `;`·`&`·`|`·줄바꿈으로 나눈 문장마다, 앞의 환경변수·time·timeout을 뗀 뒤 적용한다. */
  heavyPatterns: string[];
  container: string;
  /** 이 포트에 연결된 클라이언트가 있으면(RDP, 웹 화면) VM을 끄지 않는다. */
  clientPorts: number[];
  /** `docker stop -t` 초. */
  stopTimeoutSeconds: number;
  /** tool_call 처리기는 코어가 30초에 막으므로 한 번에 기다리는 한도. */
  handlerBudgetSeconds: number;
  /** VM을 켠 뒤 ssh가 닿을 때까지 기다리는 전체 한도(여러 vm_build 호출에 걸친다). */
  bootWaitSeconds: number;
  /** 작업 참조가 이보다 오래 남으면 끝난 것으로 본다(결과가 오지 않은 호출 대비). */
  maxHoldMinutes: number;
}

// 무거운 명령 목록의 단일 정본. 파일 인자가 붙은 `bun test <파일>`은 가볍다고 보고 제외한다.
const NO_FILE_ARG = String.raw`(?!.*(?:\.[cm]?[jt]sx?\b|\.(?:test|spec)\b|/))`;
export const DEFAULT_CONFIG: GuardConfig = {
  thresholdGb: 6,
  heavyPatterns: [
    String.raw`^(?:(?:bunx?|npx|pnpm exec)\s+(?:--bun\s+)?)?next\s+build\b`,
    String.raw`^(?:bun|npm|pnpm|yarn)\s+(?:--bun\s+)?run\s+build(?![\w:.-])`,
    String.raw`^(?:bun|npm|pnpm|yarn)\s+(?:--bun\s+)?run\s+test(?![\w:.-])${NO_FILE_ARG}`,
    String.raw`^bun\s+test\b${NO_FILE_ARG}`,
  ],
  container: "WinBoat",
  clientPorts: [47300, 47270],
  stopTimeoutSeconds: 120,
  handlerBudgetSeconds: 25,
  bootWaitSeconds: 180,
  maxHoldMinutes: 240,
};

export const CONFIG_FILE = "cuelo-vm-memory-guard.json";
export const STATE_FILE = "cuelo-vm-memory-guard-state.json";

export interface LoadedConfig {
  config: GuardConfig;
  problems: string[];
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** 설정 글을 기본값 위에 덮는다. 잘못된 항목은 기본값으로 두고 problems에 이유를 남긴다. */
export function parseConfig(text: string | undefined): LoadedConfig {
  const config: GuardConfig = { ...DEFAULT_CONFIG, heavyPatterns: [...DEFAULT_CONFIG.heavyPatterns], clientPorts: [...DEFAULT_CONFIG.clientPorts] };
  const problems: string[] = [];
  if (text === undefined) return { config, problems };
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("객체가 아니다");
    raw = parsed as Record<string, unknown>;
  } catch (error) {
    return { config, problems: [`설정 파일을 읽지 못해 기본값을 쓴다: ${(error as Error).message}`] };
  }
  for (const key of ["thresholdGb", "stopTimeoutSeconds", "handlerBudgetSeconds", "bootWaitSeconds", "maxHoldMinutes"] as const) {
    if (!(key in raw)) continue;
    if (positive(raw[key])) config[key] = raw[key] as number;
    else problems.push(`${key}는 0보다 큰 숫자여야 해서 기본값 ${DEFAULT_CONFIG[key]}을 쓴다`);
  }
  if ("container" in raw) {
    if (typeof raw.container === "string" && /^[\w.-]+$/.test(raw.container)) config.container = raw.container;
    else problems.push("container는 컨테이너 이름 글이어야 해서 기본값을 쓴다");
  }
  if ("clientPorts" in raw) {
    const ports = raw.clientPorts;
    if (Array.isArray(ports) && ports.every((port) => Number.isInteger(port) && port > 0 && port < 65536)) config.clientPorts = ports as number[];
    else problems.push("clientPorts는 포트 번호 배열이어야 해서 기본값을 쓴다");
  }
  if ("heavyPatterns" in raw) {
    if (Array.isArray(raw.heavyPatterns) && raw.heavyPatterns.every((item) => typeof item === "string")) config.heavyPatterns = raw.heavyPatterns as string[];
    else problems.push("heavyPatterns는 정규식 글 배열이어야 해서 기본값을 쓴다");
  }
  return { config, problems };
}

// ---------------------------------------------------------------------------
// 무거운 명령 판별

/** 명령을 실행 문장들로 나눈다. 따옴표 속 글(echo "next build")은 비우고, `bash -c '…'` 안쪽은 따로 문장으로 더한다. */
export function commandSegments(command: string): string[] {
  const texts = [command];
  for (const match of command.matchAll(/\b(?:ba|z|da)?sh\s+-l?c\s+(?:'([^']*)'|"((?:\\.|[^"\\])*)")/g)) texts.push(match[1] ?? match[2] ?? "");
  const segments: string[] = [];
  for (const text of texts) {
    const bare = text
      .replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_all, double: string | undefined, single: string | undefined) => {
        const inner = double ?? single ?? "";
        // 연산자가 없는 따옴표 인자(`bun test "lib/my suite.test.ts"`)는 파일 인자를 알아볼 수 있게 공백을 `_`로 바꿔 남기고, 나머지 글은 비운다.
        return /^[^;&|<>"'`$\n]+$/.test(inner) ? inner.replace(/\s+/g, "_") : '""';
      })
      .replace(/(?:^|\s)\d*(?:>>?|<)&?\S*/g, " ");
    for (const part of bare.split(/[;&|\n]+/)) {
      const segment = part
        .trim()
        .replace(/^(?:\w+=\S*\s+)+/, "")
        .replace(/^(?:(?:timeout\s+\S+|time|nice(?:\s+-n\s*\d+)?|nohup|env)\s+)+/, "")
        .replace(/^(?:\w+=\S*\s+)+/, "")
        .trim();
      if (segment) segments.push(segment);
    }
  }
  return segments;
}

export function compilePatterns(sources: readonly string[]): { patterns: RegExp[]; problems: string[] } {
  const patterns: RegExp[] = [];
  const problems: string[] = [];
  for (const source of sources) {
    try {
      patterns.push(new RegExp(source));
    } catch {
      problems.push(`정규식이 아니라 건너뛴 패턴: ${source}`);
    }
  }
  return { patterns, problems };
}

/** 무거운 작업이면 맞은 패턴을 돌려준다. */
export function matchHeavy(command: string, patterns: readonly RegExp[]): string | undefined {
  for (const segment of commandSegments(command)) {
    for (const pattern of patterns) if (pattern.test(segment)) return pattern.source;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 환경 층. 시험은 이 인터페이스를 가짜로 바꾼다.

export type VmState = "running" | "stopped" | "absent" | "unavailable";

export interface Docker {
  /** `unavailable`이면 detail에 이유를 담는다. */
  state(): Promise<{ state: VmState; detail?: string }>;
  stop(timeoutSeconds: number): Promise<boolean>;
  start(): Promise<boolean>;
}

export interface GuardDeps {
  dir: string;
  pid: number;
  readConfigText(): string | undefined;
  docker: (container: string) => Docker;
  memAvailableKb(): number;
  clientConnected(ports: readonly number[]): boolean;
  vmBuildRunning(): boolean;
  vmReachable(): Promise<boolean>;
  pidAlive(pid: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; stdout: string; stderr: string; missing: boolean }> {
  const { promise, resolve } = Promise.withResolvers<{ ok: boolean; stdout: string; stderr: string; missing: boolean }>();
  execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), missing: code === "ENOENT" });
  });
  return promise;
}

export const realDocker = (container: string): Docker => ({
  async state() {
    const result = await run("docker", ["inspect", "-f", "{{.State.Status}}", container], 4_000);
    if (result.ok) {
      const status = result.stdout.trim();
      return { state: status === "running" || status === "restarting" || status === "paused" ? "running" : "stopped" };
    }
    if (result.missing) return { state: "unavailable", detail: "docker 명령이 없다" };
    if (/no such (?:object|container)/i.test(result.stderr)) return { state: "absent", detail: `${container} 컨테이너가 없다` };
    return { state: "unavailable", detail: result.stderr.trim().split("\n")[0] || "docker inspect 실패" };
  },
  async stop(timeoutSeconds) {
    return (await run("docker", ["stop", "-t", String(timeoutSeconds), container], (timeoutSeconds + 30) * 1000)).ok;
  },
  async start() {
    return (await run("docker", ["start", container], 10_000)).ok;
  },
});

/** MemAvailable(kB). 읽지 못하면 아주 큰 값을 돌려 아무것도 끄지 않는다. */
export function readMemAvailableKb(text?: string): number {
  try {
    const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(text ?? readFileSync("/proc/meminfo", "utf8"));
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** /proc/net/tcp(6)의 ESTABLISHED 줄에서 로컬 포트가 대상이거나, 원격이 루프백의 대상 포트인 연결이 있는지. */
export function establishedOnPorts(tables: readonly string[], ports: readonly number[]): boolean {
  for (const table of tables) {
    for (const line of table.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4 || fields[3] !== "01") continue;
      const [, localPort] = fields[1]!.split(":");
      const [remoteAddr, remotePort] = fields[2]!.split(":");
      if (localPort && ports.includes(parseInt(localPort, 16))) return true;
      const loopback = remoteAddr === "0100007F" || remoteAddr === "00000000000000000000000001000000";
      if (loopback && remotePort && ports.includes(parseInt(remotePort, 16))) return true;
    }
  }
  return false;
}

/** 연결 표를 하나도 읽지 못하면 연결 여부를 알 수 없으므로 연결된 것으로 본다(끄지 않는 쪽이 안전). */
export function clientConnectedFrom(ports: readonly number[], read: (path: string) => string = (path) => readFileSync(path, "utf8")): boolean {
  const tables: string[] = [];
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    try {
      tables.push(read(path));
    } catch (error) {
      // 표가 없는 것(IPv6를 끈 PC의 tcp6)은 그 주소 종류의 연결이 없다는 뜻이다. 그 밖의 읽기 실패는 연결 여부를 알 수 없으니 연결된 것으로 본다.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return true;
    }
  }
  return tables.length === 0 || establishedOnPorts(tables, ports);
}

/** vm_build는 `~/.omp/vm-build/lock`에 flock(LOCK_EX)을 걸고 도는 동안 쥔다. 잠금을 시도하면 vm_build와 겹치므로 /proc/locks를 읽기만 한다. */
export function flockHeld(locksText: string, inode: number): boolean {
  const pattern = new RegExp(String.raw`\bFLOCK\s+\S+\s+WRITE\s+\d+\s+[0-9a-f]+:[0-9a-f]+:${inode}\b`);
  return locksText.split("\n").some((line) => pattern.test(line));
}

/** 잠금 파일이 있는데 /proc/locks를 읽지 못하면 vm_build가 도는지 알 수 없으므로 돈다고 본다(끄지 않는 쪽이 안전). */
export function vmBuildRunningFrom(lockPath: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): boolean {
  if (!existsSync(lockPath)) return false;
  try {
    return flockHeld(read("/proc/locks"), statSync(lockPath).ino);
  } catch {
    return true;
  }
}

async function realVmReachable(): Promise<boolean> {
  return (await run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "winboat", "exit"], 8_000)).ok;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function realDeps(dir = join(homedir(), ".omp", "agent")): GuardDeps {
  return {
    dir,
    pid: process.pid,
    readConfigText: () => {
      try {
        return readFileSync(join(dir, CONFIG_FILE), "utf8");
      } catch {
        return undefined;
      }
    },
    docker: realDocker,
    memAvailableKb: () => readMemAvailableKb(),
    clientConnected: (ports) => clientConnectedFrom(ports),
    vmBuildRunning: () => vmBuildRunningFrom(join(homedir(), ".omp", "vm-build", "lock")),
    vmReachable: realVmReachable,
    pidAlive,
    now: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
  };
}

// ---------------------------------------------------------------------------
// 상태 파일. 여러 세션(프로세스)이 함께 쓴다. 잠금은 파일 읽고 쓰는 짧은 동안만 잡고 docker 호출은 잠금 밖에서 한다.
// 끄기·켜기 같은 긴 동작은 상태 파일의 op(진행 중 동작)로 알리고, 장치가 껐다는 소유 표시(stopped)는 끄기가 확인된 뒤에만 만든다.

export interface Ref {
  id: string;
  pid: number;
  at: number;
}

export interface StoppedMark {
  /** 끄기를 시작한 시각. */
  at: number;
  /** `docker stop`이 성공했고 컨테이너가 실제로 exited임을 확인한 시각. 이 표시는 확인된 뒤에만 만들어진다. 이보다 먼저 찍은 docker 상태 스냅샷으로는 지우지 않는다. */
  confirmedAt: number;
  /** 장치가 끈 컨테이너. 설정이 바뀌어도 이 컨테이너만 다시 켠다. */
  container: string;
  reason: string;
  memBeforeKb: number;
  memAfterKb: number;
}

/** 진행 중인 docker stop/start 하나. 끄기와 켜기는 이 자리를 먼저 잡은 쪽만 낸다(상태 파일 잠금 안에서 잡는다). 소유 기록(StoppedMark)과는 별개다. */
export interface Operation {
  kind: "stopping" | "starting";
  pid: number;
  at: number;
  /** 이 동작의 시간 한도. 동작을 시작한 때의 설정으로 정해, 나중에 설정이 바뀌어도 진행 중인 동작의 자리가 일찍 풀리지 않는다. */
  limitMs: number;
}

export interface GuardState {
  version: 2;
  /** 장치가 껐음이 확인된 VM. 이 표시가 있을 때만 장치가 다시 켠다. */
  stopped?: StoppedMark;
  op?: Operation;
  refs: Ref[];
  lastStart?: number;
  last?: { at: number; text: string };
}

const emptyState = (): GuardState => ({ version: 2, refs: [] });
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 3_000;
/** 한 번의 ssh 검사가 걸릴 수 있는 최대 시간. 예산이 이만큼 안 남았으면 새 검사를 시작하지 않는다. */
const PROBE_MS = 8_000;
/** 진행 중 동작을 기다리는 한 바퀴가 걸릴 수 있는 최대 시간(대기 1초 + docker inspect 4초 + 잠금 3초). */
const WAIT_ROUND_MS = 8_000;

const gb = (kb: number) => (kb / 1_048_576).toFixed(1);
const fmtTime = (ms: number) => new Date(ms).toLocaleString("ko-KR", { hour12: false });

export interface Outcome {
  /** 사용자에게 보일 한국어 한 줄. */
  notice?: string;
  /** vm_build를 막아야 하는 이유. */
  block?: string;
}

type Claim = { container: string } | { busy: Operation["kind"] } | undefined;
type StartResult = "started" | "running" | "absent" | "unknown" | "failed";
type Decision = { kind: "none" | "wait" | "error" } | { kind: "stop"; memBeforeKb: number };

export class VmMemoryGuard {
  constructor(private readonly deps: GuardDeps) {}

  /** 지금 설정의 무거운 명령 패턴. */
  heavyPatterns(): string[] {
    return this.loadConfig().config.heavyPatterns;
  }

  private get statePath() { return join(this.deps.dir, STATE_FILE); }

  private loadConfig(): LoadedConfig {
    return parseConfig(this.deps.readConfigText());
  }

  private readState(): GuardState {
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as GuardState;
      if (parsed && parsed.version === 2 && Array.isArray(parsed.refs)) return parsed;
    } catch {
      // 없거나 깨진 파일은 빈 상태로 본다.
    }
    return emptyState();
  }

  private writeState(state: GuardState): void {
    mkdirSync(this.deps.dir, { recursive: true });
    const tmp = `${this.statePath}.${this.deps.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, this.statePath);
  }

  /** 진행 중 동작의 시간 한도. docker stop 호출 자체의 한도(stopTimeout + 30초)보다 길다. 시작한 프로세스가 죽어도 그 자식 docker가 안 끝났을 수 있어 프로세스 생사가 아니라 시간만 본다. */
  private opLimitMs(config: GuardConfig): number {
    return (config.stopTimeoutSeconds + 45) * 1000;
  }

  /** 상태 파일 잠금 안에서 읽고(죽은·오래된 참조와 한도가 지난 동작을 걷어 낸 뒤) work로 고쳐 저장한다. work는 docker를 부르지 않는 짧은 동기 일이어야 한다. */
  private async locked<T>(config: GuardConfig, work: (state: GuardState) => T): Promise<T> {
    const lock = `${this.statePath}.lock`;
    const token = `${this.deps.pid}:${Math.random().toString(36).slice(2)}`;
    mkdirSync(this.deps.dir, { recursive: true });
    const deadline = this.deps.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        mkdirSync(lock);
        writeFileSync(join(lock, "owner"), token);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const owner = Number.parseInt(readFileSync(join(lock, "owner"), "utf8"), 10);
          const ownerDead = Number.isInteger(owner) && !this.deps.pidAlive(owner);
          if (ownerDead || this.deps.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
        } catch {
          // 그 사이 풀렸거나 주인 파일을 쓰는 중이면 다시 시도한다.
          try {
            if (this.deps.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { recursive: true, force: true });
          } catch {
            // 이미 풀렸다.
          }
        }
        if (this.deps.now() > deadline) throw new Error("상태 파일 잠금을 얻지 못했다");
        await this.deps.sleep(40);
      }
    }
    try {
      const state = this.readState();
      const maxAge = config.maxHoldMinutes * 60_000;
      state.refs = state.refs.filter((ref) => this.deps.pidAlive(ref.pid) && this.deps.now() - ref.at < maxAge);
      if (state.op && this.deps.now() - state.op.at >= state.op.limitMs) {
        this.note(state, `${state.op.kind === "stopping" ? "끄기" : "켜기"}가 한도를 넘어 중단된 것으로 봄(끄기를 확인하지 못했으면 장치가 껐다고 보지 않음)`);
        delete state.op;
      }
      const result = work(state);
      this.writeState(state);
      return result;
    } finally {
      try {
        // 내 잠금일 때만 푼다. 낡았다고 다른 프로세스가 가져간 잠금을 지우지 않는다.
        if (readFileSync(join(lock, "owner"), "utf8") === token) rmSync(lock, { recursive: true, force: true });
      } catch {
        // 이미 없다.
      }
    }
  }

  private note(state: GuardState, text: string): void {
    state.last = { at: this.deps.now(), text };
  }

  /**
   * 무거운 작업을 시작한다. 필요하면 VM을 끈다. 끝나기를 handlerBudgetSeconds(처리기 전체 예산)까지만 기다리고, 나머지는 뒤에서 마친다.
   * 다른 끄기·켜기가 진행 중이면 그것이 끝나기를 예산까지 기다린 뒤 VM 상태를 다시 보고 판단한다.
   */
  async acquire(id: string): Promise<Outcome> {
    const { config } = this.loadConfig();
    const deadline = this.deps.now() + config.handlerBudgetSeconds * 1000;
    const docker = this.deps.docker(config.container);
    let pushed = false;
    for (;;) {
      const snapshotAt = this.deps.now();
      const vm = await docker.state();
      const first = !pushed;
      const decision = await this.locked(config, (state): Decision => {
        if (first) state.refs.push({ id, pid: this.deps.pid, at: this.deps.now() });
        const mark = state.stopped;
        if (mark && mark.container === config.container) {
          // 컨테이너가 없으면 표시는 의미가 없다. 확인 불가(unavailable)는 표시를 그대로 둔다: 일시 오류가 복구 기록을 지우면 안 된다.
          if (vm.state === "absent") delete state.stopped;
          // 스냅샷을 찍은 뒤에 확정된 표시는 스냅샷이 낡았을 수 있으니 지우지 않는다. 그보다 먼저인데 VM이 켜져 있으면 누군가 다시 켰다.
          else if (vm.state === "running" && !state.op && mark.confirmedAt <= snapshotAt) delete state.stopped;
        }
        if (state.op) return { kind: "wait" };
        if (state.stopped || vm.state !== "running") return { kind: "none" };
        const memBeforeKb = this.deps.memAvailableKb();
        if (memBeforeKb >= config.thresholdGb * 1_048_576) return { kind: "none" };
        if (this.deps.vmBuildRunning() || this.deps.clientConnected(config.clientPorts)) return { kind: "none" };
        state.op = { kind: "stopping", pid: this.deps.pid, at: this.deps.now(), limitMs: this.opLimitMs(config) };
        return { kind: "stop", memBeforeKb };
      }).catch((): Decision => ({ kind: "error" }));
      if (decision.kind !== "error") pushed = true;
      // 다음 한 바퀴(대기 1초 + 상태 확인 4초 + 잠금 3초)가 예산 안에 끝날 때만 다시 본다.
      if (decision.kind === "wait" && this.deps.now() + WAIT_ROUND_MS < deadline) {
        await this.deps.sleep(1_000);
        continue;
      }
      if (decision.kind !== "stop") return {};

      const stopping = (async () => {
        const ok = await docker.stop(config.stopTimeoutSeconds);
        return this.finishStop(config, docker, ok, decision.memBeforeKb);
      })();
      stopping.catch(() => undefined);
      const raced = await Promise.race([
        stopping.then((outcome) => ({ outcome })),
        this.deps.sleep(Math.max(1, deadline - this.deps.now())).then(() => undefined),
      ]);
      if (raced) return raced.outcome;
      return { notice: `VM 메모리 장치: 메모리 여유가 ${gb(decision.memBeforeKb)} GB로 모자라 WinBoat VM을 끄는 중이다(정상 종료). 끄기는 뒤에서 계속되고 작업은 그대로 시작한다. 작업이 끝나면 다시 켠다.` };
    }
  }

  /** `docker stop`이 끝난 뒤: stop이 성공했고 컨테이너가 실제로 exited일 때만 "장치가 껐다"는 표시를 만든다. 아니면 만들지 않는다. */
  private async finishStop(config: GuardConfig, docker: Docker, stopOk: boolean, memBeforeKb: number): Promise<Outcome> {
    const vm = await docker.state().catch(() => ({ state: "unavailable" as VmState, detail: "docker inspect 실패" }));
    const outcome = await this.locked(config, (state): Outcome => {
      const op = state.op;
      if (!op || op.kind !== "stopping" || op.pid !== this.deps.pid) return {};
      delete state.op;
      if (stopOk && vm.state === "stopped") {
        const memAfterKb = this.deps.memAvailableKb();
        state.stopped = {
          at: op.at, confirmedAt: this.deps.now(), container: config.container, memBeforeKb, memAfterKb,
          reason: `메모리 여유 ${gb(memBeforeKb)} GB가 기준 ${config.thresholdGb} GB 미만이라 무거운 작업 전에 끔`,
        };
        this.note(state, `메모리 여유 ${gb(memBeforeKb)} → ${gb(memAfterKb)} GB, WinBoat VM을 정상 종료함`);
        return { notice: `VM 메모리 장치: 메모리 여유가 ${gb(memBeforeKb)} GB로 모자라 WinBoat VM을 정상 종료했다(여유 ${gb(memAfterKb)} GB). 작업이 끝나면 다시 켠다.` };
      }
      const detail = !stopOk ? "docker stop 실패 또는 시간 초과" : vm.state === "running" ? "종료 뒤에도 켜져 있음" : (vm.detail ?? vm.state);
      this.note(state, `VM을 끄지 못함: ${detail}`);
      return { notice: `VM 메모리 장치: WinBoat VM을 끄지 못한 것으로 보고 켜지도 않는다(${detail}).` };
    }).catch(() => ({}) as Outcome);
    const restart = await this.restartIfIdle(config);
    return { notice: outcome.notice && restart.notice ? `${outcome.notice} ${restart.notice}` : (outcome.notice ?? restart.notice) };
  }

  /** 무거운 작업이 끝났다. 마지막 참조였고 장치가 껐으면 다시 켠다. */
  async release(id: string): Promise<Outcome> {
    const { config } = this.loadConfig();
    await this.locked(config, (state) => {
      state.refs = state.refs.filter((ref) => ref.id !== id);
    }).catch(() => undefined);
    return this.restartIfIdle(config).catch(() => ({}));
  }

  /** 세션 시작·수동 호출: 장치가 끈 채 남은 VM을 살려 둔다(참조가 하나도 안 남았을 때만). */
  async recover(): Promise<Outcome> {
    return this.restartIfIdle(this.loadConfig().config).catch(() => ({}));
  }

  /**
   * 켜기 자리를 잡는다. 다른 끄기·켜기가 진행 중이면 busy. 장치가 껐음이 확인된 표시가 없으면 requireMark일 때 undefined이고,
   * 아니면(수동 켜기) 컨테이너 이름만 돌려준다: 장치가 끈 기록을 새로 만들지 않는다.
   * idleOnly: 살아 있는 작업 참조가 있으면 잡지 않는다(참조 확인과 자리 잡기가 한 잠금 안에서 일어난다).
   */
  private claimStart(config: GuardConfig, options: { requireMark: boolean; idleOnly: boolean }): Promise<Claim> {
    return this.locked(config, (state): Claim => {
      if (state.op) return { busy: state.op.kind };
      const mark = state.stopped;
      if (!mark && options.requireMark) return undefined;
      if (options.idleOnly && state.refs.length > 0) return undefined;
      state.op = { kind: "starting", pid: this.deps.pid, at: this.deps.now(), limitMs: this.opLimitMs(config) };
      return { container: mark?.container ?? config.container };
    });
  }

  /** 잡은 켜기 자리로 컨테이너를 켜고 표시를 정리한다. 실제로 꺼진 것이 확인될 때만 docker start를 낸다. */
  private async runStart(config: GuardConfig, container: string, noteText: string): Promise<StartResult> {
    const docker = this.deps.docker(container);
    const vm = await docker.state().catch(() => ({ state: "unavailable" as VmState }));
    const started = vm.state === "stopped" ? await docker.start().catch(() => false) : undefined;
    return this.locked(config, (state): StartResult => {
      if (state.op?.kind === "starting" && state.op.pid === this.deps.pid) delete state.op;
      if (vm.state === "unavailable") return "unknown"; // 확인하지 못했으니 기록을 남겨 다음에 다시 시도한다.
      if (vm.state === "stopped" && started === false) {
        this.note(state, "VM을 다시 켜지 못함");
        return "failed";
      }
      if (state.stopped?.container === container) delete state.stopped;
      if (vm.state === "stopped") {
        state.lastStart = this.deps.now();
        this.note(state, noteText);
        return "started";
      }
      return vm.state === "running" ? "running" : "absent";
    });
  }

  /** 장치가 껐고(표시가 있고) 살아 있는 참조가 없을 때만 다시 켠다. 표시가 없으면 아무것도 켜지 않는다. */
  private async restartIfIdle(config: GuardConfig): Promise<Outcome> {
    const claim = await this.claimStart(config, { requireMark: true, idleOnly: true });
    if (!claim || "busy" in claim) return {};
    const result = await this.runStart(config, claim.container, "작업이 끝나 WinBoat VM을 다시 켬");
    if (result === "started") return { notice: "VM 메모리 장치: 무거운 작업이 끝나 WinBoat VM을 다시 켰다(부팅에 1~2분 걸린다)." };
    if (result === "failed") return { notice: "VM 메모리 장치: WinBoat VM을 다시 켜지 못했다. 다음 세션 시작이나 lab_vm_memory_guard start로 다시 켠다." };
    return {};
  }

  /** vm_build 호출 직전: 장치가 끈 VM이면 켜고, 방금 켠 VM이면 ssh가 닿을 때까지 기다린다. 처리기 한도 안에서만 기다리고 아니면 다시 부르라고 막는다. */
  async prepareVmBuild(): Promise<Outcome> {
    const { config } = this.loadConfig();
    const deadline = this.deps.now() + config.handlerBudgetSeconds * 1000;
    let claim: Claim;
    try {
      claim = await this.claimStart(config, { requireMark: true, idleOnly: false });
    } catch {
      return { block: "VM 메모리 장치가 상태를 확인하지 못했다. 잠시 뒤 vm_build를 다시 부른다." };
    }
    let started = false;
    if (claim && "busy" in claim) {
      if (claim.busy === "stopping") return { block: "VM 메모리 장치가 WinBoat VM을 끄는 중이다. 끝난 뒤(보통 20초 안) vm_build를 다시 부른다." };
    } else if (claim) {
      const result = await this.runStart(config, claim.container, "vm_build 호출 전에 WinBoat VM을 다시 켬");
      if (result === "failed") return { block: "VM 메모리 장치가 끈 WinBoat VM을 켜지 못했다. lab_vm_memory_guard status로 상태를 확인한다." };
      if (result === "unknown") return { block: "VM 메모리 장치가 WinBoat VM 상태를 확인하지 못했다(docker 응답 없음). 잠시 뒤 vm_build를 다시 부른다." };
      started = result === "started";
    }
    const lastStart = this.readState().lastStart;
    const bootDeadline = (lastStart ?? 0) + config.bootWaitSeconds * 1000;
    // 장치가 켠 적이 없거나 부팅 대기 시간이 지났으면 더 기다리지 않는다. 그 뒤 연결 실패는 vm_build가 직접 알린다.
    if (!started && !(claim && "busy" in claim) && (lastStart === undefined || this.deps.now() >= bootDeadline)) return {};
    while (this.deps.now() < deadline - PROBE_MS) {
      if (await this.deps.vmReachable()) return { notice: started ? "VM 메모리 장치: vm_build를 위해 끈 WinBoat VM을 다시 켰다." : undefined };
      if (this.deps.now() >= bootDeadline && !started && !(claim && "busy" in claim)) return {};
      await this.deps.sleep(2_000);
    }
    const left = Math.max(10, Math.ceil((Math.max(bootDeadline, this.deps.now()) - this.deps.now()) / 1000));
    return { block: `VM 메모리 장치가 켠 WinBoat VM이 아직 부팅 중이라 ssh에 닿지 않는다. ${Math.min(left, 60)}초쯤 뒤 vm_build를 다시 부르면 이어서 기다린다.` };
  }

  async status(): Promise<{ text: string; details: Record<string, unknown> }> {
    const loaded = this.loadConfig();
    const { config } = loaded;
    const vm = await this.deps.docker(config.container).state();
    const state = this.readState();
    const alive = state.refs.filter((ref) => this.deps.pidAlive(ref.pid));
    const mem = this.deps.memAvailableKb();
    const vmBuild = this.deps.vmBuildRunning();
    const client = this.deps.clientConnected(config.clientPorts);
    const mark = state.stopped;
    const vmText = vm.state === "running" ? "켜짐"
      : vm.state === "stopped" ? (mark ? "꺼짐(이 장치가 끔)" : "꺼짐(이 장치가 끈 게 아니라 자동으로 켜지 않음)")
        : vm.state === "absent" ? `없음 — 장치는 아무것도 하지 않는다(${vm.detail})`
          : `확인 불가 — 장치는 아무것도 하지 않는다(${vm.detail})`;
    const opText = state.op ? ` (${state.op.kind === "stopping" ? "끄는" : "켜는"} 중)` : "";
    const lines = [
      `WinBoat VM(${config.container}): ${vmText}`,
      `메모리 여유: ${mem === Number.MAX_SAFE_INTEGER ? "읽지 못함" : `${gb(mem)} GB`} (기준 ${config.thresholdGb} GB 미만이면 무거운 작업 전에 끔)`,
      `vm_build 실행 중: ${vmBuild ? "예" : "아니오"}, VM 화면 연결(${config.clientPorts.join("/")}): ${client ? "있음" : "없음"}`,
      `작업 참조: ${alive.length}개`,
      mark ? `장치가 끈 기록: ${fmtTime(mark.at)}, ${mark.reason}${mark.memAfterKb ? `, 여유 ${gb(mark.memBeforeKb)}→${gb(mark.memAfterKb)} GB` : ""}${opText}` : `장치가 끈 기록: 없음${opText}`,
      state.last ? `마지막 동작: ${fmtTime(state.last.at)} ${state.last.text}` : "마지막 동작: 없음",
      `무거운 명령 패턴(~/.omp/agent/${CONFIG_FILE} 로 바꿈): ${config.heavyPatterns.join("  |  ")}`,
      ...loaded.problems.map((problem) => `설정 문제: ${problem}`),
      ...compilePatterns(config.heavyPatterns).problems.map((problem) => `설정 문제: ${problem}`),
    ];
    return { text: lines.join("\n"), details: { vm: vm.state, memAvailableKb: mem, vmBuildRunning: vmBuild, clientConnected: client, refs: alive.length, stopped: mark ?? null, config } };
  }

  /** 수동 끄기. 장치가 껐다는 표시를 남기지 않으므로 자동으로 다시 켜지 않는다(켜려면 start). */
  async manualStop(force: boolean): Promise<string> {
    const { config } = this.loadConfig();
    const docker = this.deps.docker(config.container);
    const vm = await docker.state();
    if (vm.state === "absent" || vm.state === "unavailable") return `WinBoat VM을 끄지 못한다: ${vm.detail}`;
    if (vm.state === "stopped") return "WinBoat VM이 이미 꺼져 있다.";
    if (!force) {
      if (this.deps.vmBuildRunning()) return "vm_build가 돌고 있거나 확인하지 못해 끄지 않았다. 그래도 끄려면 force: true로 다시 부른다.";
      if (this.deps.clientConnected(config.clientPorts)) return "VM 화면(RDP/웹)이 연결돼 있거나 확인하지 못해 끄지 않았다. 그래도 끄려면 force: true로 다시 부른다.";
    }
    const memBefore = this.deps.memAvailableKb();
    if (!(await docker.stop(config.stopTimeoutSeconds))) return "docker stop이 실패했거나 시간 안에 끝나지 않았다. status로 확인한다.";
    return `WinBoat VM을 정상 종료했다(여유 ${gb(memBefore)} → ${gb(this.deps.memAvailableKb())} GB). 수동으로 끈 것이라 자동으로 다시 켜지 않는다. 켜려면 lab_vm_memory_guard start.`;
  }

  /** 수동 켜기. 사용자가 명시한 동작이라 장치가 끈 VM이 아니어도 켠다. 끄기·켜기가 진행 중이면 겹치지 않게 거절한다. */
  async manualStart(): Promise<string> {
    const { config } = this.loadConfig();
    const claim = await this.claimStart(config, { requireMark: false, idleOnly: false });
    if (claim && "busy" in claim) return `VM 메모리 장치가 WinBoat VM을 ${claim.busy === "stopping" ? "끄는" : "켜는"} 중이라 겹쳐 켜지 않았다. 끝난 뒤 다시 부른다.`;
    const result = await this.runStart(config, claim!.container, "수동으로 WinBoat VM을 켬");
    switch (result) {
      case "started": return "WinBoat VM을 켰다(부팅에 1~2분 걸린다).";
      case "running": return "WinBoat VM이 이미 켜져 있다.";
      case "failed": return "docker start가 실패했다. status로 확인한다.";
      case "absent": return "WinBoat 컨테이너가 없어 켜지 못한다.";
      default: return "docker 응답이 없어 켜지 못했다. status로 확인한다.";
    }
  }
}
