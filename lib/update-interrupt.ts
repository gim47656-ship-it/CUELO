/**
 * 업데이트·재시작 때 끝나지 않은 세션을 끊고, 새 서버에서 다시 이어 가게 한다.
 *
 * 흐름(파일 계약, 모두 `<externalUpdateRoot>/interrupts/` 아래):
 * - `request.json` {id, reason}: 외부(업데이트 worker의 drain 시간 초과, `restart-ompweb.ps1`)가 쓴다.
 * - 이 프로세스가 처음 보는 id면 돌고 있는 세션 id를 `pending-resume.json`에 합쳐 적고,
 *   각 세션에 `abort`를 보내고 background task child·bash까지 멈춘 뒤 `<id>.ack.json`을 쓴다.
 *   외부는 ack(`unsettled`에 든 세션 제외) 또는 running 0을 보고 진행한다.
 * - 다른 프로세스가 쓴 `pending-resume.json`은 새 서버가 읽어 세션마다 재개 prompt를 넣는다.
 *
 * 목록을 abort보다 먼저 적는다. abort 뒤 서버가 바로 죽어도 재개 대상은 남는다.
 *
 * 재개 실패 보존(2026-09-25):
 * - 재개에 성공했거나 이미 돌고 있는 세션만 목록에서 뺀다. 실패한 세션은 최소 원인과 함께 남겨
 *   다음 시도가 다시 시도한다. 예전에는 시도 전에 목록을 지워서 RPC 시작 실패가 곧 재개 포기가 됐다.
 * - 성공은 세션마다 저장하고 저장 결과를 확인한다. 저장이 실패해도 이 프로세스는 그 성공을 기억해
 *   (`resumedHere`) 다음 시도에서 같은 세션에 prompt를 다시 보내지 않는다. 이미 돌고 있는 세션도
 *   다시 보내지 않는다.
 * - prompt 전송과 파일 저장 사이에 프로세스가 죽는 구간은 exactly-once를 보장하지 않는다. 재개를
 *   잃지 않는 쪽을 택했고, 그 경우 중복은 `isRunning()`과 이 프로세스의 완료 기억이 막는다.
 * - 저장 직전에 파일을 다시 읽는다. 그 사이 새 interrupt request가 목록을 갈아치웠으면(다른 writer)
 *   옛 snapshot으로 덮어쓰지 않는다. 남의 새 요청을 지우는 선삭제도 하지 않는다 — `<id>.ack.json`
 *   존재와 그 id의 `handled` 기억이 중복 처리를 이미 막는다.
 * - 실패 원인은 한 줄짜리 짧은 message만 남긴다(stack·원문 본문은 남기지 않는다).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getRpcSession, getRunningRpcSessionIds, startRpcSession } from "./rpc-manager";
import { buildSessionContext, getSessionEntries, resolveSessionPath } from "./session-reader";
import { isRunInterrupted } from "./run-interruption";
import type { AgentMessage } from "./types";
import { markPriorGenerationConsumed, markRuntimeActivityServer, readPriorGenerationActivity, type PriorGenerationActivity, type ProcessIdentity } from "./update-maintenance";

const POLL_MS = 1000;
// 초기 재개 지연이자 재시도 최소 간격이다. 재시도 간격을 새로 만들지 않으려고 같은 값을 쓴다.
const RESUME_DELAY_MS = 3000;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,80}$/;
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const MAX_ERROR_CHARS = 200;
// drain ack 전에 child 작업이 끝나기를 기다리는 상한. worker는 interrupt request 뒤 10초만 ack를
// 기다리고, 이 감시는 1초 간격이라 그 안에 들어가야 한다.
const CHILD_SETTLE_MS = 5000;

export const INTERRUPT_RESUME_MESSAGE =
  "[자동 재개] CUELO 업데이트·재시작 때문에 이 세션의 진행 중 작업이 중단(abort)됐다. 서버가 새 버전으로 다시 떴다. "
  + "중단 직전에 돌던 명령·도구 결과는 사라졌을 수 있으니 파일·프로세스 상태를 먼저 확인하고, 하던 작업을 이어서 진행한다. "
  + "그때 돌던 SubAgent(task child)도 멈췄지만 기록은 남아 있다. 결과를 받지 못한 child에는 먼저 `write agent://<id>`로 이어서 하라고 보내 되살리고, "
  + "되살아나지 않으면(isolated 작업 공간 등) 남은 파일 상태를 확인한 뒤 새로 맡긴다.";

/** 서버가 갑자기 죽어(전원·강제 종료·크래시) abort 없이 끊긴 부모 세션용. 명령을 다시 실행하라고 하지 않는다. */
export const ABRUPT_RESUME_MESSAGE =
  "[자동 재개] CUELO 서버가 예기치 않게 종료돼 이 세션의 진행 중 작업이 중간에 끊겼다. 서버가 다시 떴다. "
  + "끊기기 직전에 돌던 명령·도구 결과는 사라졌을 수 있다. 그 명령을 그대로 다시 실행하지 말고, 파일·프로세스 상태를 먼저 확인한 뒤 하던 작업을 이어서 진행한다. "
  + "그때 돌던 SubAgent(task child)도 멈췄지만 기록은 남아 있다. 결과를 받지 못한 child에는 먼저 `write agent://<id>`로 이어서 하라고 보내 되살리고, "
  + "되살아나지 않으면 남은 파일 상태를 확인한 뒤 새로 맡긴다.";

interface PendingFailure {
  sessionId: string;
  error: string;
  atUtc: string;
}

interface PendingResume {
  schemaVersion: 1;
  writerPid: number;
  /** 이 목록을 만든 interrupt request id(선택, 새 필드). 완료 기억을 request 세대별로 가른다. */
  requestId?: string;
  sessionIds: string[];
  updatedAtUtc: string;
  /** 재개에 실패한 세션과 최소 원인(선택, 새 필드). 없는 파일도 그대로 읽는다. */
  failures?: PendingFailure[];
  /** 갑작스러운 종료로 복구 대기열에 든 세션(선택, 새 필드). 재개 prompt 문구와 재확인 대상을 가른다. */
  abruptSessionIds?: string[];
}

function interruptsRoot(): string {
  const configured = process.env.CUELO_EXTERNAL_UPDATE_ROOT?.trim();
  return join(resolve(configured || join(homedir(), ".omp", "external-update")), "interrupts");
}

function pendingPath(): string {
  return join(interruptsRoot(), "pending-resume.json");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } catch (error) {
    // 재시도가 반복되는 경로라 실패한 임시 파일을 남기지 않는다. 원래 오류는 그대로 올린다.
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 정리 실패가 원래 오류를 가리면 안 된다.
    }
    throw error;
  }
}

function minimalError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_CHARS);
}

function readPending(): PendingResume | null {
  const raw = readJson(pendingPath());
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.sessionIds)) return null;
  const sessionIds = raw.sessionIds.filter((id): id is string => typeof id === "string" && SESSION_ID_PATTERN.test(id));
  const failures: PendingFailure[] = [];
  if (Array.isArray(raw.failures)) {
    for (const entry of raw.failures) {
      if (!entry || typeof entry !== "object") continue;
      const value = entry as Record<string, unknown>;
      const sessionId = typeof value.sessionId === "string" ? value.sessionId : "";
      if (!SESSION_ID_PATTERN.test(sessionId)) continue;
      failures.push({ sessionId, error: String(value.error ?? ""), atUtc: String(value.atUtc ?? "") });
    }
  }
  const requestId = typeof raw.requestId === "string" && ID_PATTERN.test(raw.requestId) ? raw.requestId : undefined;
  const abruptSessionIds = Array.isArray(raw.abruptSessionIds)
    ? raw.abruptSessionIds.filter((id): id is string => typeof id === "string" && SESSION_ID_PATTERN.test(id) && sessionIds.includes(id))
    : [];
  return {
    schemaVersion: 1,
    writerPid: Number(raw.writerPid),
    ...(requestId ? { requestId } : {}),
    sessionIds,
    updatedAtUtc: String(raw.updatedAtUtc ?? ""),
    ...(failures.length > 0 ? { failures } : {}),
    ...(abruptSessionIds.length > 0 ? { abruptSessionIds } : {}),
  };
}

/**
 * 요청을 처리했으면 true. 같은 id는 프로세스당 한 번만 처리한다.
 * `inFlight`는 지금 처리 중인 id다. 완료 표시(`handled`)는 ack 저장까지 끝난 뒤에만 하므로,
 * pending 쓰기 같은 중간 단계가 실패하면 다음 tick이 같은 요청을 다시 처리한다.
 */
export async function handleInterruptRequest(handled: Set<string>, inFlight: Set<string>): Promise<boolean> {
  const root = interruptsRoot();
  const request = readJson(join(root, "request.json"));
  const id = typeof request?.id === "string" ? request.id : "";
  if (!ID_PATTERN.test(id) || handled.has(id) || inFlight.has(id) || existsSync(join(root, `${id}.ack.json`))) return false;
  inFlight.add(id);
  try {
    // 이 프로세스가 뜨기 전에 쓴 요청은 옛 서버 몫이다. 새 서버가 받으면 막 재개한 세션을 끊는다.
    const requestedAt = Date.parse(String(request?.atUtc ?? ""));
    const processStartedAt = Date.now() - process.uptime() * 1000;
    if (!Number.isFinite(requestedAt) || requestedAt < processStartedAt) return false;
    const excluded = new Set(Array.isArray(request?.excludeSessionIds) ? request.excludeSessionIds.map((value) => String(value).toLowerCase()) : []);
    const running = getRunningRpcSessionIds().filter((sessionId) => SESSION_ID_PATTERN.test(sessionId) && !excluded.has(sessionId));
    const previous = readPending();
    const merged = [...new Set([...(previous?.sessionIds ?? []), ...running])].sort();
    const carried = (previous?.failures ?? []).filter((failure) => merged.includes(failure.sessionId));
    const carriedAbrupt = (previous?.abruptSessionIds ?? []).filter((sessionId) => merged.includes(sessionId));
    writeJsonAtomic(pendingPath(), {
      schemaVersion: 1,
      writerPid: process.pid,
      requestId: id,
      sessionIds: merged,
      updatedAtUtc: new Date().toISOString(),
      ...(carried.length > 0 ? { failures: carried } : {}),
      ...(carriedAbrupt.length > 0 ? { abruptSessionIds: carriedAbrupt } : {}),
    } satisfies PendingResume);

    const aborted: string[] = [];
    const failed: Array<{ sessionId: string; error: string }> = [];
    for (const sessionId of running) {
      try {
        await getRpcSession(sessionId)?.send({ type: "abort" });
        aborted.push(sessionId);
      } catch (error) {
        failed.push({ sessionId, error: minimalError(error) });
      }
    }
    // 턴 abort는 부모만 멈춘다. background task child와 bash는 계속 돌아 cutover 중에 설치 폴더를
    // 잡는다(2026-09-28). 세션마다 그것까지 멈추고 실제로 끝났는지 본 뒤에 ack를 쓴다. 시간 안에
    // 끝나지 않은 세션은 `unsettled`로 알려 worker가 그 세션을 통과시키지 않게 한다.
    const unsettled: string[] = [];
    await Promise.all(running.map(async (sessionId) => {
      try {
        const settled = await getRpcSession(sessionId)?.stopBackgroundWorkForDrain(CHILD_SETTLE_MS) ?? true;
        if (!settled) unsettled.push(sessionId);
      } catch (error) {
        unsettled.push(sessionId);
        failed.push({ sessionId, error: minimalError(error) });
      }
    }));
    writeJsonAtomic(join(root, `${id}.ack.json`), {
      schemaVersion: 1,
      id,
      processId: process.pid,
      aborted,
      failed,
      unsettled: unsettled.sort(),
      atUtc: new Date().toISOString(),
    });
    // 여기까지 왔을 때만 완료로 표시한다. 앞에서 표시하면 pending 쓰기 실패가 재처리를 막는다.
    handled.add(id);
    return true;
  } finally {
    inFlight.delete(id);
  }
}

/** 이 프로세스가 재개를 끝낸(=다시 보내면 안 되는) 세션. 저장 실패나 중복 호출을 견디게 한다. */
let resumedHere = new Set<string>();
/** `resumedHere`가 어느 request 세대의 것인지. 새 세대가 오면 다시 시도해야 하므로 비운다. */
let resumedGeneration = "";

let resumeInFlight: Promise<string[]> | null = null;

/** 이전 프로세스가 남긴 재개 목록을 이어 간다. 이 프로세스가 쓴 목록(아직 교체 전)은 건드리지 않는다. */
export async function resumeInterruptedSessions(): Promise<string[]> {
  // 동시 호출은 같은 시도를 공유한다. 두 번 시작하면 같은 세션에 재개 prompt가 두 번 들어간다.
  if (resumeInFlight) return resumeInFlight;
  const pass = runResumePass().finally(() => {
    resumeInFlight = null;
  });
  resumeInFlight = pass;
  return pass;
}

/**
 * 재개 성공·이미 실행 중인 세션을 목록에서 뺀다. 저장 직전에 최신 파일을 다시 읽어, 그 사이 새
 * interrupt request가 목록을 갈아치웠으면 손대지 않는다. 실패는 원인과 함께 남긴다.
 */
function commitResumeProgress(snapshot: PendingResume, failures: Map<string, PendingFailure>): void {
  const current = readPending();
  // writer와 request 세대가 모두 같을 때만 갱신한다. 같은 writerPid가 새 request로 목록을
  // 갈아치운 경우에도 옛 완료 기억으로 새 재개 의무를 지우면 안 된다.
  if (!current || current.writerPid !== snapshot.writerPid || current.requestId !== snapshot.requestId) return;
  const remaining = current.sessionIds.filter((sessionId) => !resumedHere.has(sessionId));
  if (remaining.length === 0) {
    rmSync(pendingPath(), { force: true });
    return;
  }
  // 남은 세션의 기존 원인은 유지하고, 이번 시도가 만든 결과만 덮어쓴다. 다른 세션의 원인을
  // 이번 pass가 못 본 이유로 지우지 않는다.
  const kept = new Map<string, PendingFailure>();
  for (const failure of current.failures ?? []) {
    if (remaining.includes(failure.sessionId)) kept.set(failure.sessionId, failure);
  }
  for (const [sessionId, failure] of failures) {
    if (remaining.includes(sessionId)) kept.set(sessionId, failure);
  }
  const next: PendingResume = {
    schemaVersion: 1,
    // 처음 목록을 쓴 프로세스를 보존한다. 현재 pid로 바꾸면 `writerPid === process.pid` 규칙 때문에
    // 같은 프로세스의 다음 시도가 이 목록을 건너뛰어 재시도가 사라진다.
    writerPid: current.writerPid,
    ...(current.requestId ? { requestId: current.requestId } : {}),
    sessionIds: remaining,
    updatedAtUtc: new Date().toISOString(),
  };
  if (kept.size > 0) next.failures = [...kept.values()];
  const abrupt = (current.abruptSessionIds ?? []).filter((sessionId) => remaining.includes(sessionId));
  if (abrupt.length > 0) next.abruptSessionIds = abrupt;
  writeJsonAtomic(pendingPath(), next);
}

async function runResumePass(): Promise<string[]> {
  const snapshot = readPending();
  if (!snapshot || snapshot.writerPid === process.pid) return [];
  const generation = snapshot.requestId ?? `pid:${snapshot.writerPid}`;
  if (generation !== resumedGeneration) {
    resumedGeneration = generation;
    resumedHere = new Set();
  }
  const resumed: string[] = [];
  const failures = new Map<string, PendingFailure>();
  const commit = (): void => {
    try {
      commitResumeProgress(snapshot, failures);
    } catch (error) {
      // 저장 실패로 이번 시도를 끝내지 않는다. 성공한 세션은 resumedHere에 남아 다음 시도가
      // 다시 보내지 않고 제거만 재시도한다.
      console.error("[update-interrupt] pending save failed:", error);
    }
  };
  for (const sessionId of snapshot.sessionIds) {
    if (resumedHere.has(sessionId)) continue;
    try {
      const live = getRpcSession(sessionId);
      const session = live?.isAlive()
        ? live
        : await (async () => {
          const filePath = await resolveSessionPath(sessionId);
          if (!filePath) throw new Error(`session record not found: ${sessionId}`);
          return (await startRpcSession(sessionId, filePath, undefined)).session;
        })();
      if (session.isRunning()) {
        // 사용자가 직접 이어 갔거나 앞선 prompt가 처리 중이다. 다시 보내지 않고 목록에서만 뺀다.
        resumedHere.add(sessionId);
        commit();
        continue;
      }
      const abrupt = snapshot.abruptSessionIds?.includes(sessionId) === true;
      // 갑작스러운 종료 복구는 prompt 직전에 한 번 더 본다. 그 사이 사용자가 직접 이어 갔고 이미 끝났으면
      // 같은 작업에 재개 prompt를 또 넣지 않는다(기록이 더는 중단 상태가 아니다).
      if (abrupt && !isRunInterrupted(session.inner.messages as unknown as AgentMessage[])) {
        resumedHere.add(sessionId);
        commit();
        continue;
      }
      await session.sendInternalPrompt(abrupt ? ABRUPT_RESUME_MESSAGE : INTERRUPT_RESUME_MESSAGE);
      resumed.push(sessionId);
      resumedHere.add(sessionId);
      // 성공마다 저장하고 결과를 확인한다. 실패하면 resumedHere가 중복 전송을 막는다.
      commit();
    } catch (error) {
      failures.set(sessionId, { sessionId, error: minimalError(error), atUtc: new Date().toISOString() });
      console.error(`[update-interrupt] resume failed ${sessionId}:`, error);
    }
  }
  // 성공이 하나도 없어도 실패 원인을 남긴다.
  commit();
  return resumed;
}

/** 프로세스당 한 번 감시를 켠다. heartbeat 라우트가 첫 요청에서 부른다. */
export function ensureInterruptWatcher(): void {
  const state = globalThis as typeof globalThis & { __ompwebInterruptWatcher?: boolean };
  if (state.__ompwebInterruptWatcher) return;
  state.__ompwebInterruptWatcher = true;
  const handled = new Set<string>();
  const inFlight = new Set<string>();
  let busy = false;
  // 시작 시각을 재개 시도 시각으로 둔다. 초기 지연 동안 tick이 앞질러 시도하지 않게 한다.
  let lastResumeAt = Date.now();
  const attemptResume = async () => {
    lastResumeAt = Date.now();
    await resumeInterruptedSessions();
  };
  // 요청 처리와 재개를 한 번에 하나만 돌린다. 새 요청이 목록을 합치는 동안 옛 snapshot으로 저장하지 않는다.
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      try {
        await handleInterruptRequest(handled, inFlight);
      } catch (error) {
        console.error("[update-interrupt] request failed:", error);
      }
      // 재시도 대상은 실패한 세션 재개뿐이다. 요청 재처리는 위 1초 tick이 담당한다.
      if (Date.now() - lastResumeAt >= RESUME_DELAY_MS) {
        try {
          await attemptResume();
        } catch (error) {
          console.error("[update-interrupt] resume failed:", error);
        }
      }
    } finally {
      busy = false;
    }
  };
  setInterval(() => void tick(), POLL_MS).unref?.();
  setTimeout(() => void tick(), RESUME_DELAY_MS).unref?.();
}

/**
 * 이 서버가 실제로 듣는 포트로 만든 같은 서버 묶음 식별자. Next가 `PORT`를 채운다. 알 수 없으면 복구 대상으로 표시하지 않는다.
 * 호스트 이름은 쓰지 않는다: dev 서버는 `CUELO_HOSTNAME`이 `0.0.0.0`으로 보이는 등 값이 일정하지 않아 같은 서버의
 * 세대끼리 값이 달라질 수 있다. 묶음 키일 뿐 이전 세대가 끝났다는 증거가 아니다 — 그것은 PID+시작 identity로 확인한다.
 */
export function effectiveServerOrigin(): string | null {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0) return null;
  return `port:${port}`;
}

/** UI의 "지난 실행이 중단됐어요"와 같은 근거(저장된 기록이 실행 도중에 끊겼는가)로 본다. */
async function sessionWasCutOff(sessionId: string): Promise<boolean> {
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) return false;
  return isRunInterrupted(buildSessionContext(await getSessionEntries(filePath)).messages);
}

/** 기존 pending-resume.json에 합친다. 정상 배포가 남긴 대기열·실패 원인·세대는 그대로 보존한다. */
function queueAbruptResume(sessionIds: string[], prior: PriorGenerationActivity): void {
  const previous = readPending();
  const known = new Set(previous?.sessionIds ?? []);
  const merged = [...new Set([...known, ...sessionIds])].sort();
  const abrupt = [...new Set([...(previous?.abruptSessionIds ?? []), ...sessionIds.filter((sessionId) => !known.has(sessionId))])].sort();
  const failures = (previous?.failures ?? []).filter((failure) => merged.includes(failure.sessionId));
  writeJsonAtomic(pendingPath(), {
    schemaVersion: 1,
    // `runResumePass`는 이 프로세스가 쓴 목록을 건너뛴다. 옛 세대 pid가 우연히 같아도 건너뛰지 않게 한다.
    writerPid: previous?.writerPid ?? (prior.processId === process.pid ? 0 : prior.processId),
    requestId: previous?.requestId ?? `abrupt-${prior.startedAtMs}`,
    sessionIds: merged,
    updatedAtUtc: new Date().toISOString(),
    ...(failures.length > 0 ? { failures } : {}),
    abruptSessionIds: abrupt,
  } satisfies PendingResume);
}

/**
 * 서버 시작 때 한 번(instrumentation). 같은 origin의 직전 서버 세대가 영수증에 running으로 남기고 정상 종료
 * 절차 없이 사라졌다면, 그때 돌던 부모 세션 중 저장 기록이 실제로 끊긴 것만 기존 복구 대기열에 올린다.
 * 대기열은 `runResumePass`가 상태 확인 prompt로 이어 간다. 사용자 취소·완료·실패 종료·사용자 답 대기 세션은 뺀다.
 * 대기열 쓰기가 성공한 뒤에만 이전 세대 영수증을 소비 표시한다. 전송 직후 서버가 또 죽는 구간은
 * exactly-once가 아니다(재개 prompt가 한 번 더 갈 수 있다).
 */
export async function recoverAbruptStop(
  deps: { origin?: string | null; isInterrupted?: (sessionId: string) => Promise<boolean>; probe?: (pid: number) => ProcessIdentity } = {},
): Promise<{ queued: string[]; skipped: string[] }> {
  const origin = deps.origin === undefined ? effectiveServerOrigin() : deps.origin;
  if (!origin) return { queued: [], skipped: [] };
  const own = markRuntimeActivityServer(origin);
  const prior = readPriorGenerationActivity(origin, own.startedAtMs, deps.probe);
  if (!prior) return { queued: [], skipped: [] };
  const check = deps.isInterrupted ?? sessionWasCutOff;
  const queued: string[] = [];
  const skipped: string[] = [];
  for (const sessionId of prior.runningSessionIds) {
    if (!SESSION_ID_PATTERN.test(sessionId) || prior.waitingSessionIds.includes(sessionId)) {
      skipped.push(sessionId);
      continue;
    }
    try {
      (await check(sessionId) ? queued : skipped).push(sessionId);
    } catch (error) {
      // 기록을 읽지 못한 세션은 추정으로 prompt를 보내지 않는다.
      skipped.push(sessionId);
      console.error(`[update-interrupt] abrupt-stop check failed ${sessionId}:`, error);
    }
  }
  if (queued.length > 0) queueAbruptResume(queued, prior);
  markPriorGenerationConsumed(prior, own.startedAtMs);
  // 감시는 보통 탭 heartbeat가 켠다. 복구는 브라우저 없이도 이어져야 하므로 같은 감시를 여기서도 켠다.
  if (queued.length > 0) ensureInterruptWatcher();
  return { queued, skipped };
}
