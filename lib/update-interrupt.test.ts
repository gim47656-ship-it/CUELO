/**
 * update-interrupt.ts의 재개 보존 계약 검증.
 *
 * 격리 규약: rpc-manager/session-reader를 대체하는 module mock은 프로세스 전역이라, 이 파일은
 * 케이스마다 자기 자신을 자식 프로세스(`bun run <이 파일>`)로 띄워 그 안에서만 mock을 쓴다.
 * 그래서 `bun test` 전체 실행에서 다른 테스트가 real export를 import해도 이 mock이 새지 않는다.
 *  - 부모(`bun test`): 케이스 이름마다 자식 하나를 실행하고 exit status와 `CASE OK`를 확인한다.
 *  - 자식(`UPDATE_INTERRUPT_CASE=<name>`): 임시 OMPWEB_EXTERNAL_UPDATE_ROOT에서 케이스 하나만
 *    실행하고, 성공/실패와 무관하게 자기 root를 지우고 env를 되돌린다.
 *
 * vendor(omp-web)는 exact input이라 그 폴더에서 직접 실행하지 않는다. 변경 파일만 격리 경로로
 * 복사한 사본에서 `bun test lib/update-interrupt.test.ts`를 돌린다.
 */
import { expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SID = (n: number): string => `a0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

type FakeSession = {
  isAlive: () => boolean;
  isRunning: () => boolean;
  send: (message: unknown) => Promise<void>;
  sendInternalPrompt: (message: string) => Promise<void>;
};

const control = {
  running: [] as string[],
  runningSessions: new Set<string>(),
  failStart: new Set<string>(),
  failAbort: new Set<string>(),
  alive: new Set<string>(),
  prompts: [] as string[],
  startCalls: [] as string[],
  gate: null as Promise<void> | null,
  releaseGate: null as (() => void) | null,
  /** `startRpcSession` 진입 직후 호출된다. 중간 저장 상태를 관측하는 테스트 훅. */
  onStart: null as ((sessionId: string) => void) | null,
};

function sessionFor(sessionId: string): FakeSession {
  return {
    isAlive: () => control.alive.has(sessionId),
    isRunning: () => control.runningSessions.has(sessionId),
    send: async () => {
      if (control.failAbort.has(sessionId)) throw new Error(`abort failed: ${sessionId}`);
    },
    sendInternalPrompt: async (message: string) => {
      control.prompts.push(`${sessionId}:${message.slice(0, 4)}`);
    },
  };
}

let root = "";
let generation = 0;

const interruptDir = (): string => join(root, "interrupts");
const pendingPath = (): string => join(interruptDir(), "pending-resume.json");
const ackPath = (id: string): string => join(interruptDir(), `${id}.ack.json`);

/** 이전 프로세스가 남긴 재개 목록. 케이스마다 다른 세대가 되도록 requestId를 새로 준다. */
function seedPending(
  sessionIds: string[],
  options: { writerPid?: number; requestId?: string | null; failures?: Array<{ sessionId: string; error: string }> } = {},
): void {
  mkdirSync(interruptDir(), { recursive: true });
  generation += 1;
  const requestId = options.requestId === undefined ? `probe-${generation}` : options.requestId;
  writeFileSync(pendingPath(), JSON.stringify({
    schemaVersion: 1,
    writerPid: options.writerPid ?? 999999,
    ...(requestId === null ? {} : { requestId }),
    sessionIds,
    updatedAtUtc: new Date().toISOString(),
    ...(options.failures
      ? { failures: options.failures.map((failure) => ({ ...failure, atUtc: new Date().toISOString() })) }
      : {}),
  }), "utf8");
}

function readPendingFile(): Record<string, unknown> | null {
  if (!existsSync(pendingPath())) return null;
  return JSON.parse(readFileSync(pendingPath(), "utf8")) as Record<string, unknown>;
}

function failureIds(): string[] {
  const failures = (readPendingFile()?.failures ?? []) as Array<{ sessionId: string }>;
  return failures.map((failure) => failure.sessionId);
}

function seedRequest(id: string, atUtc = new Date().toISOString(), excludeSessionIds?: string[]): void {
  mkdirSync(interruptDir(), { recursive: true });
  writeFileSync(join(interruptDir(), "request.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    reason: "test",
    atUtc,
    ...(excludeSessionIds ? { excludeSessionIds } : {}),
  }), "utf8");
}

function gateThis(): { release: () => void } {
  const gate = Promise.withResolvers<void>();
  control.gate = gate.promise;
  control.releaseGate = gate.resolve;
  return { release: gate.resolve };
}

/** 케이스 표. 자식 프로세스에서 하나만 실행한다. 각 케이스는 자기 root를 새로 받는다. */
const CASES: Record<string, (mod: typeof import("./update-interrupt")) => Promise<void>> = {
  "재개에 실패한 세션은 목록에 남아 두 번째 시도가 다시 시도한다": async (mod) => {
    seedPending([SID(1)]);
    control.failStart.add(SID(1));

    const first = await mod.resumeInterruptedSessions();

    expect(first).toEqual([]);
    expect(readPendingFile()?.sessionIds).toEqual([SID(1)]);
    expect(failureIds()).toEqual([SID(1)]);
    const failures = (readPendingFile()?.failures ?? []) as Array<{ error: string }>;
    expect(failures[0].error).toBe(`rpc start failed: ${SID(1)}`);

    control.failStart.delete(SID(1));
    const second = await mod.resumeInterruptedSessions();

    expect(second).toEqual([SID(1)]);
    expect(control.prompts.length).toBe(1);
    expect(existsSync(pendingPath())).toBe(false);
  },

  "성공한 세션만 목록에서 빼고 남은 세션의 기존 원인을 지우지 않는다": async (mod) => {
    seedPending([SID(2), SID(3)], { failures: [{ sessionId: SID(3), error: "old cause for 3" }] });
    control.failStart.add(SID(3));
    // SID(2)가 성공해 중간 저장이 일어난 시점의 파일을 붙잡는다.
    let intermediate: Record<string, unknown> | null = null;
    control.onStart = () => {
      intermediate = readPendingFile();
    };

    const resumed = await mod.resumeInterruptedSessions();

    expect(resumed).toEqual([SID(2)]);
    const during = intermediate as Record<string, unknown> | null;
    expect(during?.sessionIds).toEqual([SID(3)]);
    expect(((during?.failures ?? []) as Array<{ sessionId: string; error: string }>).map((failure) => failure.error)).toEqual(["old cause for 3"]);
    expect(readPendingFile()?.sessionIds).toEqual([SID(3)]);
    expect(control.prompts).toEqual([`${SID(2)}:[자동 `]);
  },

  "이미 돌고 있는 세션은 다시 보내지 않고 목록에서 뺀다": async (mod) => {
    seedPending([SID(4)]);
    control.alive.add(SID(4));
    control.runningSessions.add(SID(4));

    const resumed = await mod.resumeInterruptedSessions();

    expect(resumed).toEqual([]);
    expect(control.prompts).toEqual([]);
    expect(existsSync(pendingPath())).toBe(false);
  },

  "동시 호출은 같은 시도를 공유해 prompt를 한 번만 보낸다": async (mod) => {
    seedPending([SID(5)]);
    const gate = gateThis();

    // async 함수라 반환 promise 객체는 매번 새로 만들어지므로 시작 호출·prompt 수로 공유를 본다.
    const first = mod.resumeInterruptedSessions();
    const second = mod.resumeInterruptedSessions();
    gate.release();

    expect(await first).toEqual([SID(5)]);
    expect(await second).toEqual([SID(5)]);
    expect(control.startCalls).toEqual([SID(5)]);
    expect(control.prompts.length).toBe(1);
  },

  "이 프로세스가 쓴 목록은 소비하지 않는다": async (mod) => {
    seedPending([SID(6)], { writerPid: process.pid });

    const resumed = await mod.resumeInterruptedSessions();

    expect(resumed).toEqual([]);
    expect(control.startCalls).toEqual([]);
    expect(readPendingFile()?.sessionIds).toEqual([SID(6)]);
  },

  "다른 writer가 목록을 갈아치우면 옛 snapshot으로 저장하지 않는다": async (mod) => {
    seedPending([SID(7)]);
    const gate = gateThis();
    const pass = mod.resumeInterruptedSessions();

    // 재개가 await 중인 사이 새 interrupt request가 들어와 목록을 다시 쓴다(다른 writerPid·새 세션).
    control.running = [SID(8)];
    seedRequest("probe-writer-change");
    await mod.handleInterruptRequest(new Set(), new Set());
    const during = readPendingFile();
    expect(during?.writerPid).toBe(process.pid);
    expect(during?.sessionIds).toEqual([SID(7), SID(8)].sort());

    gate.release();
    expect(await pass).toEqual([SID(7)]);

    const after = readPendingFile();
    expect(after?.writerPid).toBe(process.pid);
    expect(after?.sessionIds).toEqual([SID(7), SID(8)].sort());
    expect(control.prompts.length).toBe(1);
  },

  "같은 writer의 새 request 세대도 옛 완료 기억으로 지우지 않는다": async (mod) => {
    seedPending([SID(9)], { writerPid: 424242, requestId: "gen-1" });
    const gate = gateThis();
    const pass = mod.resumeInterruptedSessions();

    // 같은 writerPid가 새 request로 목록을 갈아치운다: 세대가 다르므로 옛 pass는 저장하면 안 된다.
    writeFileSync(pendingPath(), JSON.stringify({
      schemaVersion: 1,
      writerPid: 424242,
      requestId: "gen-2",
      sessionIds: [SID(9), SID(10)].sort(),
      updatedAtUtc: new Date().toISOString(),
    }), "utf8");

    gate.release();
    expect(await pass).toEqual([SID(9)]);

    const after = readPendingFile();
    expect(after?.requestId).toBe("gen-2");
    expect(after?.sessionIds).toEqual([SID(9), SID(10)].sort());

    // 새 세대는 자기 재개 의무를 다시 갖는다: 완료 기억이 세대별로 초기화돼 SID(9)에 다시 보낸다.
    const second = await mod.resumeInterruptedSessions();

    expect(second).toEqual([SID(9), SID(10)].sort());
    expect(control.prompts.filter((entry) => entry.startsWith(SID(9))).length).toBe(2);
    expect(control.prompts.filter((entry) => entry.startsWith(SID(10))).length).toBe(1);
    expect(existsSync(pendingPath())).toBe(false);
  },

  "성공 prompt 뒤 저장이 실패해도 다음 시도는 제거만 재시도한다": async (mod) => {
    seedPending([SID(16), SID(17)]);
    control.failStart.add(SID(17));
    // 남은 세션이 있어 저장 경로(rename)를 타야 실패가 재현된다. 읽기는 되고 rename만 실패하도록
    // 원자 저장 대상을 읽기전용으로 만든다.
    chmodSync(pendingPath(), 0o444);
    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map((value) => String(value)).join(" "));
    };

    try {
      const first = await mod.resumeInterruptedSessions();

      expect(first).toEqual([SID(16)]);
      expect(control.prompts.filter((entry) => entry.startsWith(SID(16))).length).toBe(1);
      // 저장이 실패했으므로 성공한 SID(16)가 아직 목록에 남는다.
      expect(readPendingFile()?.sessionIds).toEqual([SID(16), SID(17)]);
      expect(logged.some((line) => line.includes("pending save failed"))).toBe(true);
    } finally {
      console.error = originalError;
    }

    chmodSync(pendingPath(), 0o666);
    const second = await mod.resumeInterruptedSessions();

    // 완료 기억이 있어 같은 세션에 prompt를 다시 보내지 않고, 제거와 남은 실패 기록만 갱신한다.
    expect(second).toEqual([]);
    expect(control.prompts.filter((entry) => entry.startsWith(SID(16))).length).toBe(1);
    expect(readPendingFile()?.sessionIds).toEqual([SID(17)]);
    expect(failureIds()).toEqual([SID(17)]);
  },

  "pending 저장이 실패하면 같은 request를 다시 처리하고, 성공 뒤에만 완료로 표시한다": async (mod) => {
    seedPending([]);
    // pending 자리를 디렉터리로 만들어 원자 저장의 rename을 실패시킨다.
    rmSync(pendingPath(), { force: true });
    mkdirSync(pendingPath(), { recursive: true });
    control.running = [SID(12)];
    seedRequest("probe-retry");
    const handled = new Set<string>();

    await expect(mod.handleInterruptRequest(handled, new Set())).rejects.toThrow();

    expect([...handled]).toEqual([]);
    expect(existsSync(ackPath("probe-retry"))).toBe(false);

    rmSync(pendingPath(), { recursive: true, force: true });
    const retried = await mod.handleInterruptRequest(handled, new Set());

    expect(retried).toBe(true);
    expect([...handled]).toEqual(["probe-retry"]);
    const ack = JSON.parse(readFileSync(ackPath("probe-retry"), "utf8")) as { aborted: string[]; failed: unknown[] };
    expect(ack.aborted).toEqual([SID(12)]);
    expect(ack.failed).toEqual([]);
    expect(readPendingFile()?.sessionIds).toEqual([SID(12)]);
  },

  "과거 request와 이미 ack가 있는 id는 처리하지 않는다": async (mod) => {
    seedPending([]);
    control.running = [SID(13)];
    seedRequest("probe-past", new Date(Date.now() - 3_600_000).toISOString());

    const past = await mod.handleInterruptRequest(new Set(), new Set());

    expect(past).toBe(false);
    expect(readPendingFile()?.sessionIds).toEqual([]);
    expect(existsSync(ackPath("probe-past"))).toBe(false);

    seedRequest("probe-acked");
    expect(await mod.handleInterruptRequest(new Set(), new Set())).toBe(true);
    expect(await mod.handleInterruptRequest(new Set(), new Set())).toBe(false);
    expect(readPendingFile()?.sessionIds).toEqual([SID(13)]);
  },

  "excludeSessionIds와 abort 실패는 ack에 그대로 반영된다": async (mod) => {
    seedPending([]);
    control.running = [SID(14), SID(15)];
    control.alive.add(SID(14));
    control.alive.add(SID(15));
    control.failAbort.add(SID(15));
    seedRequest("probe-ack-body", new Date().toISOString(), [SID(14).toUpperCase()]);

    expect(await mod.handleInterruptRequest(new Set(), new Set())).toBe(true);

    const ack = JSON.parse(readFileSync(ackPath("probe-ack-body"), "utf8")) as {
      aborted: string[];
      failed: Array<{ sessionId: string; error: string }>;
    };
    expect(ack.aborted).toEqual([]);
    expect(ack.failed.length).toBe(1);
    expect(ack.failed[0].sessionId).toBe(SID(15));
    expect(readPendingFile()?.sessionIds).toEqual([SID(15)]);
  },
};

const CASE_NAMES = Object.keys(CASES);

if (process.env.UPDATE_INTERRUPT_CASE) {
  // 자식 프로세스: mock을 먼저 등록해야 rpc-manager/session-reader가 대체되고 무거운 실제
  // 의존성이 딸려 오지 않는다(정적 import로는 불가능한 지점).
  mock.module("./rpc-manager", () => ({
    getRunningRpcSessionIds: () => [...control.running],
    getRpcSession: (sessionId: string) => (control.alive.has(sessionId) ? sessionFor(sessionId) : undefined),
    startRpcSession: async (sessionId: string) => {
      control.startCalls.push(sessionId);
      control.onStart?.(sessionId);
      if (control.gate) await control.gate;
      if (control.failStart.has(sessionId)) throw new Error(`rpc start failed: ${sessionId}`);
      control.alive.add(sessionId);
      return { session: sessionFor(sessionId) };
    },
  }));
  mock.module("./session-reader", () => ({ resolveSessionPath: async (sessionId: string) => `/fake/sessions/${sessionId}` }));

  const caseName = process.env.UPDATE_INTERRUPT_CASE;
  const savedRoot = process.env.OMPWEB_EXTERNAL_UPDATE_ROOT;
  const childRoot = mkdtempSync(join(tmpdir(), "update-interrupt-case-"));
  try {
    root = childRoot;
    process.env.OMPWEB_EXTERNAL_UPDATE_ROOT = childRoot;
    const runCase = CASES[caseName];
    if (!runCase) throw new Error(`unknown case: ${caseName}`);
    const mod = await import("./update-interrupt");
    await runCase(mod);
    console.log(`CASE OK ${caseName}`);
  } catch (error) {
    console.error(`CASE FAIL ${caseName}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    // 실패해도 자기 임시 root를 지우고 env를 되돌린다.
    if (savedRoot === undefined) delete process.env.OMPWEB_EXTERNAL_UPDATE_ROOT;
    else process.env.OMPWEB_EXTERNAL_UPDATE_ROOT = savedRoot;
    rmSync(childRoot, { recursive: true, force: true });
  }
} else {
  // 부모: 케이스마다 자식 프로세스 하나. 이 프로세스는 mock을 등록하지 않으므로 다른 테스트의
  // real export를 오염시키지 않는다.
  for (const caseName of CASE_NAMES) {
    test(caseName, () => {
      const result = spawnSync(process.execPath, ["run", import.meta.path], {
        env: { ...process.env, UPDATE_INTERRUPT_CASE: caseName },
        encoding: "utf8",
        timeout: 60_000,
      });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      const ok = result.status === 0 && output.includes(`CASE OK ${caseName}`);
      if (!ok) console.error(output.trim());
      else console.log(`  OK  ${caseName}`);
      expect({ case: caseName, status: result.status, caseOk: output.includes(`CASE OK ${caseName}`) })
        .toEqual({ case: caseName, status: 0, caseOk: true });
    });
  }
}
