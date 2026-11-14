import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createVmMemoryGuard } from "../../cuelo-plugins/vm-memory-guard/index";
import {
  clientConnectedFrom, compilePatterns, DEFAULT_CONFIG, establishedOnPorts, flockHeld, vmBuildRunningFrom, matchHeavy, parseConfig, readMemAvailableKb, STATE_FILE, VmMemoryGuard,
  type Docker, type GuardDeps, type GuardState, type VmState,
} from "../../cuelo-plugins/vm-memory-guard/guard";

const GB = 1_048_576;
const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 가짜 docker·메모리·연결·vm_build 층. docker stop/start는 실제로 호출되지 않는다. */
function world(options: { vm?: VmState; memGb?: number; config?: Record<string, unknown> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vm-guard-"));
  scratch.push(dir);
  const w = {
    dir,
    vm: options.vm ?? ("running" as VmState),
    detail: undefined as string | undefined,
    memKb: (options.memGb ?? 5) * GB,
    client: false,
    vmBuild: false,
    reachable: true,
    reachableAfterPolls: 0,
    polls: 0,
    clock: 1_800_000_000_000,
    alive: new Set<number>([100]),
    calls: [] as string[],
    holdStop: undefined as undefined | Promise<void>,
    stopResult: true,
    stopMakesStopped: true,
    startResult: true,
    stateThrows: false,
    stateCostMs: 0,
    startCostMs: 0,
    onState: undefined as undefined | (() => Promise<void>),
    dockers: new Map<string, { vm: VmState; calls: string[] }>(),
    config: options.config as Record<string, unknown> | undefined,
  };
  const docker: Docker = {
    async state() {
      if (w.stateThrows) throw new Error("docker boom");
      w.clock += w.stateCostMs;
      const hook = w.onState;
      w.onState = undefined;
      await hook?.();
      return { state: w.vm, detail: w.detail };
    },
    async stop() {
      w.calls.push("stop");
      if (w.holdStop) await w.holdStop;
      if (w.stopMakesStopped) {
        w.vm = "stopped";
        w.memKb += 13 * GB;
      }
      return w.stopResult;
    },
    async start() {
      w.calls.push("start");
      w.clock += w.startCostMs;
      if (!w.startResult) return false;
      w.vm = "running";
      w.memKb -= 13 * GB;
      return true;
    },
  };
  const deps: GuardDeps = {
    dir,
    pid: 100,
    readConfigText: () => (w.config ? JSON.stringify(w.config) : undefined),
    docker: (container) => {
      const other = w.dockers.get(container);
      if (!other) return docker;
      return {
        state: async () => ({ state: other.vm }),
        stop: async () => { other.calls.push("stop"); other.vm = "stopped"; return true; },
        start: async () => { other.calls.push("start"); other.vm = "running"; return true; },
      };
    },
    memAvailableKb: () => w.memKb,
    clientConnected: () => w.client,
    vmBuildRunning: () => w.vmBuild,
    vmReachable: async () => {
      w.polls += 1;
      return w.reachable && w.polls > w.reachableAfterPolls;
    },
    pidAlive: (pid) => w.alive.has(pid),
    now: () => w.clock,
    // 시간은 가짜로 흐른다. 기다림은 매크로태스크 한 번만 양보하므로, 마이크로태스크로 끝나는 끄기는 예산 경쟁에서 이기고 멈춘 끄기는 진다.
    sleep: async (ms) => {
      w.clock += ms;
      await tick();
    },
  };
  const state = (): GuardState => (existsSync(join(dir, STATE_FILE)) ? JSON.parse(readFileSync(join(dir, STATE_FILE), "utf8")) : { version: 2, refs: [] });
  return { w, deps, guard: new VmMemoryGuard(deps), state, stateExists: () => existsSync(join(dir, STATE_FILE)) };
}

/** 매크로태스크 한 번: 그 전에 이미 풀 수 있는 마이크로태스크 연쇄(뒤에서 마치는 끄기 등)가 모두 끝난다. */
function tick(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

/** 확장의 실제 폴링 타이머가 일으킬 변화를, 정해진 시간이 아니라 조건으로 기다린다. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !condition(); attempt++) await Bun.sleep(1); // 확장이 쓰는 실제 setInterval이라 가짜 시계로 돌릴 수 없다
  expect(condition()).toBe(true);
}

/** 대입 뒤 좁혀진 리터럴 타입 없이 지금 VM 상태를 읽는다. */
const vmOf = (w: { vm: VmState }): VmState => w.vm;
const starts = (calls: string[]) => calls.filter((call) => call === "start").length;
const stops = (calls: string[]) => calls.filter((call) => call === "stop").length;

describe("heavy command matching", () => {
  const { patterns } = compilePatterns(DEFAULT_CONFIG.heavyPatterns);
  const heavy = [
    "next build",
    "bun --bun next build --webpack",
    "CUELO_DIST_DIR=.next-verify NODE_OPTIONS=--max-old-space-size=2560 bun --bun next build --webpack",
    "bunx next build",
    "bun run build",
    "bun --bun run build",
    "npm run build",
    "bun run test",
    "bun test",
    "bun test --bail",
    "cd /repo && bun test",
    "cd /repo; bun run build 2>&1 | tail -20",
    "timeout 900 bun test",
    "bash -c 'cd app && bun test'",
    "echo start; bun --bun next build; echo done",
    "bun test ./app ./components".replace(" ./app ./components", ""),
  ];
  const light = [
    "bun test lib/foo.test.ts",
    'bun test "lib/foo.test.ts"',
    "bun test './app'",
    "bun test ./app ./components",
    "bun test Tools/OMP_Global_Config/agent/extensions/tests/vm-memory-guard.test.ts",
    "bun run test lib/foo.test.mjs",
    "bun run build:css",
    "bun run test:coverage",
    "bun build ./index.ts --outdir out",
    'echo "next build is slow"',
    'git commit -m "bun run build fixes"',
    "grep -rn 'bun test' docs",
    "echo next build",
    "ls .next/build",
    "cat package.json | grep build",
    "bun install",
    "git status",
    "docker ps",
  ];
  test.each(heavy)("heavy: %s", (command) => expect(matchHeavy(command, patterns)).toBeDefined());
  test.each(light)("not heavy: %s", (command) => expect(matchHeavy(command, patterns)).toBeUndefined());

  test("the pattern list is user configurable", () => {
    const { config } = parseConfig(JSON.stringify({ heavyPatterns: ["^cargo\\s+build\\b"] }));
    const custom = compilePatterns(config.heavyPatterns).patterns;
    expect(matchHeavy("cargo build --release", custom)).toBeDefined();
    expect(matchHeavy("bun test", custom)).toBeUndefined();
  });
});

describe("config, memory and connection readers", () => {
  test("defaults are 6 GB and the WinBoat container; bad values fall back with a reported problem", () => {
    expect(parseConfig(undefined).config.thresholdGb).toBe(6);
    expect(parseConfig(JSON.stringify({ thresholdGb: 8 })).config.thresholdGb).toBe(8);
    const bad = parseConfig(JSON.stringify({ thresholdGb: -1, container: "a b", clientPorts: ["x"] }));
    expect(bad.config.thresholdGb).toBe(6);
    expect(bad.config.container).toBe("WinBoat");
    expect(bad.config.clientPorts).toEqual([47300, 47270]);
    expect(bad.problems).toHaveLength(3);
    expect(parseConfig("{not json").problems[0]).toContain("기본값");
  });

  test("MemAvailable parsing; unreadable meminfo never triggers a stop", () => {
    expect(readMemAvailableKb("MemTotal: 1 kB\nMemAvailable:    6291456 kB\n")).toBe(6291456);
    expect(readMemAvailableKb("garbage")).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("an ESTABLISHED connection on 47300/47270 counts; listeners and other ports do not", () => {
    const head = "  sl  local_address rem_address   st tx_queue\n";
    const established = `${head}   0: 0100007F:D001 0100007F:1F90 01 0:0 00:0 0 0\n   1: 0100007F:1F90 0100007F:D001 01 0:0 00:0 0 0\n`;
    expect(establishedOnPorts([established], [47300, 47270])).toBe(false);
    // 47300 = 0xB8C4: 서버 쪽(로컬 포트)도, 루프백 클라이언트 쪽(원격 포트)도 잡는다.
    expect(establishedOnPorts([`${head}   0: 0100007F:B8C4 0100007F:D000 01 0:0\n`], [47300])).toBe(true);
    expect(establishedOnPorts([`${head}   0: 0100007F:D000 0100007F:B8C4 01 0:0\n`], [47300])).toBe(true);
    expect(establishedOnPorts([`${head}   0: 00000000:B8C4 00000000:0000 0A 0:0\n`], [47300])).toBe(false);
    expect(establishedOnPorts([`${head}   0: 0100007F:B8C4 0100007F:D000 06 0:0\n`], [47300])).toBe(false);
    // 47270 = 0xB8A6
    expect(establishedOnPorts([`${head}   0: 0100007F:B8A6 0100007F:D000 01 0:0\n`], [47300, 47270])).toBe(true);
    expect(establishedOnPorts([`${head}   0: 0100007F:1F90 0100007F:D000 01 0:0\n`], [47300, 47270])).toBe(false);
  });

  test("vm_build's flock is read from /proc/locks without taking it", () => {
    const locks = "1: POSIX  ADVISORY  WRITE 4242 08:01:99 0 EOF\n2: FLOCK  ADVISORY  WRITE 4343 00:2a:1234567 0 EOF\n3: FLOCK  ADVISORY  READ 4444 00:2a:777 0 EOF\n";
    expect(flockHeld(locks, 1234567)).toBe(true);
    expect(flockHeld(locks, 123456)).toBe(false);
    expect(flockHeld(locks, 99)).toBe(false);
    expect(flockHeld(locks, 777)).toBe(false);
  });
});

describe("automatic wrap", () => {
  test("below the threshold the VM is shut down before the job and started after it", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    const acquired = await guard.acquire("a");
    expect(w.vm).toBe("stopped");
    expect(w.calls).toEqual(["stop"]);
    expect(acquired.notice).toContain("정상 종료");
    expect(state().stopped).toMatchObject({ memBeforeKb: 5 * GB, memAfterKb: 18 * GB });
    const released = await guard.release("a");
    expect(w.vm).toBe("running");
    expect(w.calls).toEqual(["stop", "start"]);
    expect(released.notice).toContain("다시 켰다");
    expect(state().stopped).toBeUndefined();
    expect(state().refs).toEqual([]);
  });

  test("at or above the threshold nothing is stopped; the configured threshold is honoured", async () => {
    const above = world({ memGb: 6 });
    await above.guard.acquire("a");
    await above.guard.release("a");
    expect(above.w.calls).toEqual([]);

    const raised = world({ memGb: 7, config: { thresholdGb: 8 } });
    await raised.guard.acquire("a");
    expect(raised.w.calls).toEqual(["stop"]);
    await raised.guard.release("a");
    expect(raised.w.calls).toEqual(["stop", "start"]);
  });

  test("a running vm_build lock skips the stop", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    w.vmBuild = true;
    expect(await guard.acquire("a")).toEqual({});
    await guard.release("a");
    expect(w.calls).toEqual([]);
    expect(state().stopped).toBeUndefined();
  });

  test("a connected RDP or web viewer client skips the stop", async () => {
    const { w, guard } = world({ memGb: 5 });
    w.client = true;
    await guard.acquire("a");
    await guard.release("a");
    expect(w.calls).toEqual([]);
  });

  test("two overlapping jobs stop once and restart only after the last one ends", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    await guard.acquire("b");
    expect(stops(w.calls)).toBe(1);
    await guard.release("a");
    expect(starts(w.calls)).toBe(0);
    expect(w.vm).toBe("stopped");
    await guard.release("b");
    expect(starts(w.calls)).toBe(1);
    expect(w.vm).toBe("running");
  });

  test("a job that started with enough memory keeps the VM down when a later job stopped it", async () => {
    const { w, guard } = world({ memGb: 9 });
    await guard.acquire("a");
    w.memKb = 5 * GB;
    await guard.acquire("b");
    expect(stops(w.calls)).toBe(1);
    await guard.release("b");
    expect(starts(w.calls)).toBe(0);
    await guard.release("a");
    expect(starts(w.calls)).toBe(1);
  });

  test("concurrent acquires from two sessions issue a single docker stop", async () => {
    const { w, guard } = world({ memGb: 5 });
    await Promise.all([guard.acquire("a"), guard.acquire("b")]);
    expect(stops(w.calls)).toBe(1);
    await guard.release("a");
    await guard.release("b");
    expect(starts(w.calls)).toBe(1);
  });

  test("a VM the user stopped is never started by the guard", async () => {
    const { w, guard, state } = world({ vm: "stopped", memGb: 5 });
    await guard.acquire("a");
    await guard.release("a");
    await guard.recover();
    await guard.prepareVmBuild();
    expect(w.calls).toEqual([]);
    expect(state().stopped).toBeUndefined();
  });

  test("a VM someone started again after the guard stopped it is left alone and the mark is cleared", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.vm = "running"; // 사용자가 직접 켬
    await guard.release("a");
    expect(starts(w.calls)).toBe(0);
    expect(state().stopped).toBeUndefined();
  });

  test("a VM the user started again while a job still runs is judged afresh by the next job", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    w.vm = "running"; // 사용자가 직접 켬
    w.memKb = 5 * GB;
    await guard.acquire("b");
    expect(stops(w.calls)).toBe(2);
    await guard.release("a");
    await guard.release("b");
    expect(starts(w.calls)).toBe(1);
  });

  test("docker missing or the container absent: the guard does nothing and status says why", async () => {
    for (const [vm, detail] of [["unavailable", "docker 명령이 없다"], ["absent", "WinBoat 컨테이너가 없다"]] as const) {
      const { w, guard, stateExists } = world({ vm, memGb: 5 });
      w.detail = detail;
      expect(await guard.acquire("a")).toEqual({});
      await guard.release("a");
      expect(w.calls).toEqual([]);
      expect(stateExists()).toBe(true);
      expect((await guard.status()).text).toContain(detail);
    }
  });
});

describe("a stop that is still in flight or fails", () => {
  test("a start never overlaps a stop in flight: the job ends first, the start waits for the stop", async () => {
    const { w, guard, state } = world({ memGb: 5, config: { handlerBudgetSeconds: 1 } });
    let finishStop!: () => void;
    w.holdStop = new Promise<void>((resolve) => { finishStop = resolve; });
    const acquired = await guard.acquire("a"); // 1초(가짜) 예산이 지나 끄는 중인 채로 돌아온다
    expect(acquired.notice).toContain("끄는 중");
    expect(state().op?.kind).toBe("stopping");
    await guard.release("a");
    expect(w.calls).toEqual(["stop"]);
    expect(w.vm).toBe("running");
    finishStop();
    await tick();
    expect(w.calls).toEqual(["stop", "start"]);
    expect(w.vm).toBe("running");
    expect(state().stopped).toBeUndefined();
  });

  test("a stop that fails leaves no mark, so the guard can never start a VM it did not stop", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    w.stopResult = false;
    w.stopMakesStopped = false;
    const acquired = await guard.acquire("a");
    expect(acquired.notice).toContain("끄지 못한 것");
    expect(state().stopped).toBeUndefined();
    w.vm = "stopped"; // 나중에 사용자가 끈 VM
    await guard.release("a");
    await guard.recover();
    expect(starts(w.calls)).toBe(0);
  });

  test("a background stop that times out after the handler returned clears the mark", async () => {
    const { w, guard, state } = world({ memGb: 5, config: { handlerBudgetSeconds: 1 } });
    let finishStop!: () => void;
    w.holdStop = new Promise<void>((resolve) => { finishStop = resolve; });
    w.stopResult = false;
    w.stopMakesStopped = false;
    await guard.acquire("a");
    expect(state().op?.kind).toBe("stopping");
    finishStop();
    await tick();
    expect(state().stopped).toBeUndefined();
    await guard.release("a");
    expect(starts(w.calls)).toBe(0);
  });

  test("docker stop failing while the container exited anyway (user stopped it) is not claimed as the guard's stop", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    w.stopResult = false;
    await guard.acquire("a");
    expect(w.vm).toBe("stopped");
    expect(state().stopped).toBeUndefined();
    await guard.release("a");
    await guard.recover();
    expect(starts(w.calls)).toBe(0);
  });

  test("a failed start keeps the mark so recovery retries it", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.startResult = false;
    expect((await guard.release("a")).notice).toContain("다시 켜지 못했다");
    expect(state().stopped).toBeDefined();
    w.startResult = true;
    await guard.recover();
    expect(w.vm).toBe("running");
    expect(state().stopped).toBeUndefined();
  });
});

describe("review findings", () => {
  test("manual start does not start under a stop that is still in flight", async () => {
    const { w, guard } = world({ memGb: 5, config: { handlerBudgetSeconds: 1 } });
    let finishStop!: () => void;
    w.holdStop = new Promise<void>((resolve) => { finishStop = resolve; });
    await guard.acquire("a");
    w.vm = "stopped"; // 컨테이너는 이미 exited지만 docker stop 호출은 아직 돌아오지 않음
    expect(await guard.manualStart()).toContain("끄는 중");
    expect(starts(w.calls)).toBe(0);
    finishStop();
    await tick();
  });

  test("only the container the guard stopped is restarted, even if the configured container changes", async () => {
    const { w, guard } = world({ memGb: 5 });
    const other = { vm: "stopped" as VmState, calls: [] as string[] };
    w.dockers.set("Other", other);
    await guard.acquire("a");
    w.config = { container: "Other" };
    await guard.release("a");
    expect(other.calls).toEqual([]);
    expect(w.vm).toBe("running");
    expect(starts(w.calls)).toBe(1);
  });

  test("a live owner's fresh state lock is never taken over; a dead owner's lock is", async () => {
    const live = world({ memGb: 5 });
    live.w.clock = Date.now(); // 잠금 폴더 mtime은 실제 시각이라 시계를 맞춘다
    const lock = join(live.w.dir, `${STATE_FILE}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "100:x"); // pid 100은 살아 있다
    expect(await live.guard.acquire("a")).toEqual({});
    expect(live.w.calls).toEqual([]);
    expect(existsSync(lock)).toBe(true);

    const dead = world({ memGb: 5 });
    const deadLock = join(dead.w.dir, `${STATE_FILE}.lock`);
    mkdirSync(deadLock);
    writeFileSync(join(deadLock, "owner"), "4242:x"); // 죽은 pid
    await dead.guard.acquire("a");
    expect(dead.w.calls).toEqual(["stop"]);
    expect(existsSync(deadLock)).toBe(false);
  });

  test("a second heavy job waits (within the budget) for another session's stop in flight instead of racing it", async () => {
    const { w, guard } = world({ memGb: 5 });
    writeFileSync(join(w.dir, STATE_FILE), JSON.stringify({ version: 2, refs: [], op: { kind: "stopping", pid: 100, at: w.clock, limitMs: 165_000 } }));
    const before = w.clock;
    await guard.acquire("b");
    expect(w.calls).toEqual([]);
    expect(w.clock - before).toBeGreaterThanOrEqual(16_000); // 한 바퀴(8초)가 남지 않을 때까지 기다린다
    expect(w.clock - before).toBeLessThanOrEqual(25_000);
  });

  test("the hook budget covers the docker inspect too: a slow inspect shortens the stop wait", async () => {
    const { w, guard } = world({ memGb: 5 });
    w.stateCostMs = 20_000;
    w.holdStop = new Promise<void>(() => {});
    const before = w.clock;
    const outcome = await guard.acquire("a");
    expect(outcome.notice).toContain("끄는 중");
    expect(w.clock - before).toBeLessThanOrEqual(26_000);
  });

  test("vm_build pre-start never begins an ssh probe that could overrun the hook budget", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    w.reachable = false;
    const before = w.clock;
    const outcome = await guard.prepareVmBuild();
    expect(outcome.block).toContain("부팅 중");
    expect(w.clock - before).toBeLessThanOrEqual(25_000 - 8_000 + 2_000);
  });

  test("vm_build pre-start blocks instead of passing when it cannot tell the guard-stopped VM's state", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.vm = "unavailable";
    const outcome = await guard.prepareVmBuild();
    expect(outcome.block).toContain("확인하지 못했다");
    expect(state().stopped).toBeDefined();
    w.vm = "stopped";
    expect((await guard.prepareVmBuild()).block).toBeUndefined();
    expect(starts(w.calls)).toBe(1);
  });

  test("an unreadable lock table or connection table means 'unknown', which counts as busy", () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-guard-lock-"));
    scratch.push(dir);
    const lock = join(dir, "lock");
    const unreadable = () => { throw new Error("EACCES"); };
    expect(vmBuildRunningFrom(lock, unreadable)).toBe(false); // 잠금 파일이 없으면 vm_build는 한 번도 안 돌았다
    writeFileSync(lock, "");
    expect(vmBuildRunningFrom(lock, unreadable)).toBe(true);
    expect(vmBuildRunningFrom(lock, () => "")).toBe(false);
    expect(clientConnectedFrom([47300], unreadable)).toBe(true);
    const enoent = Object.assign(new Error("none"), { code: "ENOENT" });
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    // 표가 없는 것(IPv6를 끈 PC)은 연결 없음, 그 밖의 읽기 실패는 모르니 연결됨.
    expect(clientConnectedFrom([47300], (path) => { if (path.endsWith("tcp6")) throw enoent; return "head\n"; })).toBe(false);
    expect(clientConnectedFrom([47300], (path) => { if (path.endsWith("tcp6")) throw eacces; return "head\n"; })).toBe(true);
    expect(clientConnectedFrom([47300], (path) => { if (path.endsWith("tcp6")) return "head\n"; throw eacces; })).toBe(true);
  });

  test("a transient docker failure never erases the record that the guard stopped the VM", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.vm = "unavailable";
    await guard.release("a");
    expect(state().stopped).toBeDefined();
    w.vm = "unavailable";
    await guard.acquire("b"); // 새 작업이 확인 불가 상태에서도 기록을 지우지 않는다
    expect(state().stopped).toBeDefined();
    w.vm = "stopped";
    await guard.release("b");
    expect(vmOf(w)).toBe("running");
  });

  test("a container that no longer exists drops the stale mark", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.vm = "absent";
    await guard.release("a");
    expect(state().stopped).toBeUndefined();
  });
});

describe("second review round", () => {
  test("a failed or unavailable manual start leaves no ownership record, so recovery never starts that VM later", async () => {
    const { w, guard, stateExists, state } = world({ vm: "stopped" });
    w.startResult = false;
    expect(await guard.manualStart()).toContain("실패");
    w.startResult = true;
    await guard.recover();
    expect(starts(w.calls)).toBe(1); // 수동 켜기 한 번뿐
    expect(stateExists() ? state().stopped : undefined).toBeUndefined();

    const unavailable = world({ vm: "unavailable" });
    expect(await unavailable.guard.manualStart()).toContain("켜지 못");
    unavailable.w.vm = "stopped";
    await unavailable.guard.recover();
    expect(unavailable.w.calls).toEqual([]);
  });

  test("a job arriving while the restart is in flight waits for it, then shuts the VM down again", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    let arrival: Promise<unknown> = Promise.resolve();
    w.onState = async () => { arrival = guard.acquire("b"); }; // 재시작이 VM을 확인하는 사이 도착
    await guard.release("a");
    expect(starts(w.calls)).toBe(1);
    await arrival;
    expect(stops(w.calls)).toBe(2);
    expect(w.vm).toBe("stopped");
    await guard.release("b");
    expect(starts(w.calls)).toBe(2);
  });

  test("a manual start in flight blocks a guard stop from overlapping it", async () => {
    const { w, guard } = world({ vm: "stopped", memGb: 5 });
    let arrival: Promise<unknown> = Promise.resolve();
    w.onState = async () => { w.vm = "stopped"; arrival = guard.acquire("b"); };
    await guard.manualStart();
    await arrival;
    // 켜기가 끝난 뒤에야 b가 상태를 다시 보고(켜진 VM, 여유 부족) 끈다.
    expect(w.calls.join(",")).toBe("start,stop");
  });

  test("an inspection snapshot taken before another session confirmed its stop cannot erase that mark", async () => {
    const { w, guard, state } = world({ memGb: 9 });
    const mark = { at: w.clock - 5000, container: "WinBoat", reason: "x", memBeforeKb: 5 * GB, memAfterKb: 18 * GB, confirmedAt: w.clock + 1000 };
    writeFileSync(join(w.dir, STATE_FILE), JSON.stringify({ version: 2, refs: [], stopped: mark }));
    await guard.acquire("a"); // docker는 켜진 것으로 답하지만 그 스냅샷은 확정보다 앞선다
    expect(state().stopped).toBeDefined();
    w.vm = "stopped";
    await guard.release("a");
    expect(starts(w.calls)).toBe(1);
  });

  test("vm_build pre-start answers inside the hook budget even when docker inspect and start are slow", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    w.stateCostMs = 4_000;
    w.startCostMs = 10_000;
    w.reachable = false;
    const before = w.clock;
    const outcome = await guard.prepareVmBuild();
    expect(outcome.block).toContain("부팅 중");
    expect(w.clock - before).toBeLessThanOrEqual(25_000);
  });

  test("a quoted file argument with spaces still marks a targeted test as light", () => {
    const { patterns } = compilePatterns(DEFAULT_CONFIG.heavyPatterns);
    expect(matchHeavy('bun test "lib/my suite.test.ts"', patterns)).toBeUndefined();
    expect(matchHeavy('echo "a; bun test"', patterns)).toBeUndefined();
    expect(matchHeavy('bun test --timeout "5000"', patterns)).toBeDefined();
  });
});

describe("recovery and stale references", () => {
  test("a crash after the guard stopped the VM: recovery starts it when no live reference remains", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.alive.delete(100); // 작업을 쥔 프로세스가 죽음
    w.alive.add(999);
    const recovering = new VmMemoryGuard({ ...worldDeps(w, state), pid: 999 } as GuardDeps);
    const outcome = await recovering.recover();
    expect(w.vm).toBe("running");
    expect(starts(w.calls)).toBe(1);
    expect(outcome.notice).toContain("다시 켰다");
  });

  test("a live reference from another process blocks recovery", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    await guard.recover();
    expect(starts(w.calls)).toBe(0);
    expect(w.vm).toBe("stopped");
  });

  test("a reference older than maxHoldMinutes expires even if its process is alive", async () => {
    const { w, guard } = world({ memGb: 5, config: { maxHoldMinutes: 10 } });
    await guard.acquire("a");
    w.clock += 11 * 60_000;
    await guard.recover();
    expect(starts(w.calls)).toBe(1);
  });

  test("a stop left in flight by a dead process never authorizes a start: the stop was never confirmed", async () => {
    for (const vm of ["stopped", "running"] as const) {
      const { w, guard, state } = world({ vm, memGb: 5 });
      writeFileSync(join(w.dir, STATE_FILE), JSON.stringify({ version: 2, refs: [], op: { kind: "stopping", pid: 555, at: w.clock, limitMs: 165_000 } }));
      await guard.recover();
      expect(w.calls).toEqual([]);
      w.clock += 300_000; // 동작 한도가 지나 중단된 것으로 본다
      await guard.recover();
      expect(w.calls).toEqual([]);
      expect(state().op).toBeUndefined();
      expect(state().stopped).toBeUndefined();
      expect(await guard.manualStart()).toBeDefined();
    }
  });

  test("a stop that outlived its operation slot (taken over by another stop) does not claim ownership", async () => {
    const { w, guard, state } = world({ memGb: 5, config: { handlerBudgetSeconds: 1 } });
    let finishStop!: () => void;
    w.holdStop = new Promise<void>((resolve) => { finishStop = resolve; });
    await guard.acquire("a");
    const s = state();
    s.op = { kind: "stopping", pid: 777, at: w.clock, limitMs: 165_000 };
    writeFileSync(join(w.dir, STATE_FILE), JSON.stringify(s));
    finishStop();
    await tick();
    expect(state().stopped).toBeUndefined();
    expect(state().op?.pid).toBe(777);
  });

  test("an operation keeps the time limit it started with when the configured stop timeout changes later", async () => {
    const { w, guard } = world({ memGb: 5, config: { handlerBudgetSeconds: 1 } });
    w.holdStop = new Promise<void>(() => {});
    await guard.acquire("a");
    w.clock += 110_000;
    w.vm = "stopped";
    w.config = { stopTimeoutSeconds: 60 };
    expect(await guard.manualStart()).toContain("끄는 중");
    expect(starts(w.calls)).toBe(0);
  });

  test("waiting for another operation never begins a round that could overrun the hook budget", async () => {
    const { w, guard } = world({ memGb: 5 });
    writeFileSync(join(w.dir, STATE_FILE), JSON.stringify({ version: 2, refs: [], op: { kind: "stopping", pid: 100, at: w.clock, limitMs: 165_000 } }));
    w.stateCostMs = 4_000;
    const before = w.clock;
    await guard.acquire("b");
    expect(w.clock - before).toBeLessThanOrEqual(25_000);
  });

  test("manual start also waits out a stop whose owner died, instead of starting under its docker child", async () => {
    const { w, guard } = world({ vm: "stopped", memGb: 5 });
    writeFileSync(join(w.dir, STATE_FILE), JSON.stringify({ version: 2, refs: [], op: { kind: "stopping", pid: 555, at: w.clock, limitMs: 165_000 } }));
    expect(await guard.manualStart()).toContain("끄는 중");
    expect(w.calls).toEqual([]);
  });

  test("after a dead stop's limit has passed the next job shuts a running VM down normally", async () => {
    const { w, guard } = world({ memGb: 5 });
    writeFileSync(join(w.dir, STATE_FILE), JSON.stringify({ version: 2, refs: [], op: { kind: "stopping", pid: 555, at: w.clock - 300_000, limitMs: 165_000 } }));
    await guard.acquire("a");
    expect(w.calls).toEqual(["stop"]);
  });

  test("a stale state lock directory from a dead run is broken", async () => {
    const { w, guard } = world({ memGb: 5 });
    const lock = join(w.dir, `${STATE_FILE}.lock`);
    mkdirSync(lock);
    // 잠금 mtime은 실제 시각이라 가짜 시계를 한참 앞당겨 낡은 것으로 만든다.
    w.clock = Date.now() + 60_000;
    await guard.acquire("a");
    expect(w.calls).toEqual(["stop"]);
  });
});

describe("vm_build pre-start", () => {
  test("starts the VM the guard stopped, waits for ssh, and the later job end does not start it again", async () => {
    const { w, guard, state } = world({ memGb: 5 });
    await guard.acquire("a");
    w.reachableAfterPolls = 3;
    const outcome = await guard.prepareVmBuild();
    expect(outcome.block).toBeUndefined();
    expect(outcome.notice).toContain("vm_build");
    expect(starts(w.calls)).toBe(1);
    expect(w.polls).toBeGreaterThan(3);
    expect(state().stopped).toBeUndefined();
    await guard.release("a");
    expect(starts(w.calls)).toBe(1);
  });

  test("blocks with a retry hint after the hook budget and keeps waiting on the next call without a second docker start", async () => {
    const { w, guard } = world({ memGb: 5 });
    await guard.acquire("a");
    w.reachableAfterPolls = 20; // 25초(가짜) 예산 안에는 닿지 않는다
    const first = await guard.prepareVmBuild();
    expect(first.block).toContain("부팅 중");
    expect(first.block).toMatch(/\d+초/);
    w.reachableAfterPolls = w.polls + 2;
    const second = await guard.prepareVmBuild();
    expect(second.block).toBeUndefined();
    expect(starts(w.calls)).toBe(1);
  });

  test("stops waiting once the whole boot window has passed", async () => {
    const { w, guard } = world({ memGb: 5, config: { bootWaitSeconds: 30 } });
    await guard.acquire("a");
    w.reachable = false;
    await guard.prepareVmBuild();
    w.clock += 40_000;
    expect(await guard.prepareVmBuild()).toEqual({});
  });

  test("does nothing for a VM the guard did not stop", async () => {
    const { w, guard } = world({ memGb: 9 });
    expect(await guard.prepareVmBuild()).toEqual({});
    expect(w.calls).toEqual([]);
    expect(w.polls).toBe(0);
  });

  test("refuses while a guard stop is still in progress rather than starting under it", async () => {
    const { w, guard } = world({ memGb: 5, config: { handlerBudgetSeconds: 1 } });
    w.holdStop = new Promise<void>(() => {});
    await guard.acquire("a");
    const outcome = await guard.prepareVmBuild();
    expect(outcome.block).toContain("끄는 중");
    expect(starts(w.calls)).toBe(0);
  });
});

describe("manual tool actions", () => {
  test("stop is refused while vm_build runs or a client is connected unless forced, and is never auto-undone", async () => {
    const { w, guard, state } = world({ memGb: 9 });
    w.vmBuild = true;
    expect(await guard.manualStop(false)).toContain("vm_build");
    w.vmBuild = false;
    w.client = true;
    expect(await guard.manualStop(false)).toContain("연결");
    expect(w.calls).toEqual([]);
    expect(await guard.manualStop(true)).toContain("정상 종료");
    expect(w.vm).toBe("stopped");
    expect(state().stopped).toBeUndefined();
    await guard.recover();
    await guard.acquire("a");
    await guard.release("a");
    expect(starts(w.calls)).toBe(0);
  });

  test("start works for any stopped VM and is a no-op when it is running", async () => {
    const { w, guard } = world({ vm: "stopped" });
    expect(await guard.manualStart()).toContain("켰다");
    expect(w.vm).toBe("running");
    expect(await guard.manualStart()).toContain("이미 켜져");
    expect(starts(w.calls)).toBe(1);
  });

  test("status shows VM state, memory, threshold, refs, last action and the active patterns", async () => {
    const { guard } = world({ memGb: 5, config: { thresholdGb: 7, heavyPatterns: ["^cargo build"] } });
    await guard.acquire("a");
    const status = await guard.status();
    expect(status.text).toContain("꺼짐(이 장치가 끔)");
    expect(status.text).toContain("기준 7 GB");
    expect(status.text).toContain("작업 참조: 1개");
    expect(status.text).toContain("^cargo build");
    expect(status.text).toContain("마지막 동작");
    expect(status.details.refs).toBe(1);
  });
});

/** recovery 시험용: 같은 월드를 다른 프로세스 id로 본다. */
function worldDeps(w: ReturnType<typeof world>["w"], _state: unknown): Partial<GuardDeps> {
  const { guard: _g } = { guard: undefined };
  return {
    dir: w.dir,
    readConfigText: () => (w.config ? JSON.stringify(w.config) : undefined),
    docker: () => ({
      state: async () => ({ state: w.vm }),
      stop: async () => true,
      start: async () => { w.calls.push("start"); w.vm = "running"; return true; },
    }),
    memAvailableKb: () => w.memKb,
    clientConnected: () => w.client,
    vmBuildRunning: () => w.vmBuild,
    vmReachable: async () => true,
    pidAlive: (pid) => w.alive.has(pid),
    now: () => w.clock,
    sleep: async () => {},
  };
}

describe("extension wiring", () => {
  type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
  function wired(options: Parameters<typeof world>[0] = {}) {
    const env = world(options);
    const handlers = new Map<string, Handler>();
    const tools = new Map<string, { execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }> }>();
    const notified: string[] = [];
    let running: { id: string }[] = [];
    const ctx = {
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: (message: string) => notified.push(message) },
      getAsyncJobSnapshot: () => ({ running }),
    };
    const pi = {
      zod: z,
      on: (name: string, fn: Handler) => handlers.set(name, fn),
      registerTool: (tool: { name: string; execute: never }) => tools.set(tool.name, tool),
    };
    createVmMemoryGuard({ deps: env.deps, asyncPollMs: 5 })(pi as never);
    let id = 0;
    const call = (toolName: string, input: Record<string, unknown>) => {
      const toolCallId = `c${++id}`;
      const before = handlers.get("tool_call")!({ toolName, toolCallId, input }, ctx);
      return { toolCallId, before: before as Promise<{ block?: boolean; reason?: string; additionalContext?: string } | undefined> };
    };
    const result = (toolCallId: string, details?: unknown) =>
      handlers.get("tool_result")!({ toolName: "bash", toolCallId, input: {}, isError: false, content: [], details }, ctx) as Promise<{ additionalContext?: string } | undefined>;
    return { ...env, handlers, tools, notified, ctx, call, result, setRunning: (jobs: { id: string }[]) => { running = jobs; } };
  }

  test("a heavy bash call is wrapped: stop notice on the call, restart notice on the result", async () => {
    const h = wired({ memGb: 5 });
    const { toolCallId, before } = h.call("bash", { command: "bun --bun next build --webpack" });
    expect((await before)?.additionalContext).toContain("정상 종료");
    expect(h.w.vm).toBe("stopped");
    expect((await h.result(toolCallId))?.additionalContext).toContain("다시 켰다");
    expect(h.w.vm).toBe("running");
  });

  test("light commands, named services and non-bash tools never touch the VM", async () => {
    const h = wired({ memGb: 5 });
    for (const input of [{ command: "bun test lib/a.test.ts" }, { command: "next build", name: "dev-build" }, { command: "git status" }]) {
      expect(await h.call("bash", input).before).toBeUndefined();
    }
    expect(await h.call("read", { path: "next build" }).before).toBeUndefined();
    expect(h.w.calls).toEqual([]);
  });

  test("a call that is blocked elsewhere never gets a result: turn end releases it", async () => {
    const h = wired({ memGb: 5 });
    await h.call("bash", { command: "bun run build" }).before;
    expect(h.w.vm).toBe("stopped");
    await h.handlers.get("turn_end")!({}, h.ctx);
    expect(h.w.vm).toBe("running");
  });

  test("session shutdown releases what the session still holds", async () => {
    const h = wired({ memGb: 5 });
    await h.call("bash", { command: "bun test" }).before;
    await h.handlers.get("session_shutdown")!({}, h.ctx);
    expect(h.w.vm).toBe("running");
  });

  test("a background job keeps the VM down until the job leaves the running list", async () => {
    const h = wired({ memGb: 5 });
    const { toolCallId, before } = h.call("bash", { command: "bun run build", async: true });
    await before;
    h.setRunning([{ id: "bg_1" }]);
    expect(await h.result(toolCallId, { async: { state: "running", jobId: "bg_1" } })).toBeUndefined();
    await Bun.sleep(12); // 폴링이 몇 번 돌아도 작업이 도는 동안은 꺼진 채여야 한다(실제 5ms 타이머)
    expect(h.w.vm).toBe("stopped");
    h.setRunning([]);
    await until(() => h.w.vm === "running");
    expect(starts(h.w.calls)).toBe(1);
    expect(h.notified.some((line) => line.includes("다시 켰다"))).toBe(true);
  });

  test("vm_build: starts a guard-stopped VM first, and blocks with a Korean retry reason while it boots", async () => {
    const h = wired({ memGb: 5 });
    await h.call("bash", { command: "next build" }).before;
    h.w.reachable = false;
    const blocked = await h.call("vm_build", { project: "x.sln" }).before;
    expect(blocked?.block).toBe(true);
    expect(blocked?.reason).toContain("부팅 중");
    h.w.reachable = true;
    const ok = await h.call("vm_build", { project: "x.sln" }).before;
    expect(ok?.block).toBeUndefined();
    expect(starts(h.w.calls)).toBe(1);
  });

  test("a guard failure never blocks the tool call", async () => {
    const h = wired({ memGb: 5 });
    h.w.stateThrows = true;
    const outcome = await h.call("bash", { command: "bun test" }).before;
    expect(outcome).toBeUndefined();
    expect(h.w.calls).toEqual([]);
  });

  test("session start recovers a VM left off by a dead run and tells the user", async () => {
    const h = wired({ memGb: 5 });
    await h.guard.acquire("dead");
    h.w.alive.clear();
    h.w.alive.add(100);
    const s = h.state();
    s.refs = [{ id: "dead", pid: 31337, at: h.w.clock }];
    writeFileSync(join(h.w.dir, STATE_FILE), JSON.stringify(s));
    await h.handlers.get("session_start")!({}, h.ctx);
    expect(h.w.vm).toBe("running");
    expect(h.notified[0]).toContain("다시 켰다");
  });

  test("lab_vm_memory_guard status, stop and start run through the registered tool", async () => {
    const h = wired({ memGb: 9 });
    const tool = h.tools.get("lab_vm_memory_guard")!;
    expect((await tool.execute("t", { action: "status" })).content[0]!.text).toContain("WinBoat VM(WinBoat): 켜짐");
    h.w.client = true;
    expect((await tool.execute("t", { action: "stop" })).content[0]!.text).toContain("연결");
    expect((await tool.execute("t", { action: "stop", force: true })).content[0]!.text).toContain("정상 종료");
    expect((await tool.execute("t", { action: "start" })).content[0]!.text).toContain("켰다");
  });
});
