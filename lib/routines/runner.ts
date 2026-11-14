import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { type AgentSessionWrapper, startNewRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { commitRoutineChange } from "./git-sync";
import { type RoutinePost, type RoutinePostStatus, extractPostTitle } from "./post";
import { runStamp } from "./schedule";
import { type RoutineLastRun, type RoutineRunning, readRoutineRunStates, updateRoutineRunState } from "./state";
import { type Routine, expandHome, isExistingDirectory, readRoutine, routinePaths, thisRoutineHost, writePostFile } from "./store";
import { routineModelSettings, runRoutineChecker } from "./model";
import { checkRoutineAnswer, parseRoutineModel } from "../../Tools/OMP_Global_Config/agent/cuelo-plugins/routine-model/policy";

/**
 * 루틴 한 회차: 새 세션을 열어 지시문을 보내고, 세션이 끝날 때까지 서버 안에서 지켜본 뒤 마지막 답을 게시판 글로
 * 커밋해 올린다. 답이 `[알림 없음]` 줄로 시작하면 글 없이 이 PC의 실행 기록에만 남긴다. 같은 루틴은 이 프로세스에서
 * 한 번에 하나만 돈다. 서버가 내려가며 끊긴 회차는 실패 글 대신 실행 표시를 남기고, 다음 부팅의 복구가 새 세션으로
 * 한 번 다시 돌린다.
 */

export const QUIET_MARKER = "[알림 없음]";
const RUN_TIMEOUT_MS = 60 * 60_000;
const POLL_MS = 5_000;
const ABORT_GRACE_MS = 10_000;
const STOP_BACKGROUND_MS = 30_000;
/** 게시하지 못한 실행 표시. 다음 틱의 복구가 실패 글을 다시 올리려 한다. */
const POST_FAILED_BOOT = "post-failed";
/** 서버 재시작으로 끊긴 회차는 이 횟수까지 시도한다(처음 1번 + 다시 1번). */
const MAX_ATTEMPTS = 2;
/** 끊긴 회차가 이보다 오래전에 시작했으면 다시 돌리지 않고 실패 글로 남긴다(지난 결과가 쓸모없을 수 있다). */
const RETRY_WINDOW_MS = 3 * 60 * 60_000;

const log = (message: string) => console.log(`[routines] ${message}`);

declare global {
  var __cueloRoutineRuns: Map<string, Promise<void>> | undefined;
  var __cueloRoutineBootId: string | undefined;
  var __cueloRoutineServerStop: { since: number | null } | undefined;
  var __cueloRoutineRecovery: Promise<void> | undefined;
}

/** 종료 신호 뒤 이 시간 안에는 종료 중으로 본다. 그 뒤에도 프로세스가 살아 있으면 종료가 일어나지 않은 것이다. */
const STOP_WINDOW_MS = 5 * 60_000;

/**
 * 서버 프로세스가 종료 중인지. 신호를 받으면 세션 레지스트리가 모든 세션을 닫으므로(`rpc-manager`), 그사이 닫히거나
 * 실패한 루틴 회차는 루틴의 실패가 아니라 재시작으로 끊긴 회차다. 프로세스당 한 번만 듣는다.
 */
function serverStopping(now = Date.now()): boolean {
  if (!globalThis.__cueloRoutineServerStop) {
    globalThis.__cueloRoutineServerStop = { since: null };
    const mark = () => { globalThis.__cueloRoutineServerStop!.since = Date.now(); };
    process.on("SIGTERM", mark);
    process.on("SIGINT", mark);
  }
  const since = globalThis.__cueloRoutineServerStop.since;
  return since !== null && now - since < STOP_WINDOW_MS;
}

const sameRunning = (a: RoutineRunning | undefined, b: RoutineRunning | undefined) =>
  !!a && !!b && a.bootId === b.bootId && a.startedAt === b.startedAt && (a.attempt ?? 1) === (b.attempt ?? 1);

function runs(): Map<string, Promise<void>> {
  globalThis.__cueloRoutineRuns ??= new Map();
  return globalThis.__cueloRoutineRuns;
}

export function routineBootId(): string {
  globalThis.__cueloRoutineBootId ??= randomUUID();
  return globalThis.__cueloRoutineBootId;
}

export function isRoutineRunning(id: string): boolean {
  return runs().has(id);
}

/**
 * 새 회차를 시작한다. 이미 돌고 있거나 서버가 종료 중이면 시작하지 않고 false. 실행은 기다리지 않는다. `retryOf`는
 * 복구가 다시 돌리는 끊긴 회차의 표시이고, 새 실행이 그 표시를 덮어쓴다(먼저 지우지 않아 시작이 실패해도 남는다).
 */
export function startRoutineRun(dir: string, routine: Routine, trigger: RoutineRunning["trigger"], retryOf?: RoutineRunning): boolean {
  const map = runs();
  if (map.has(routine.id) || serverStopping()) return false;
  // 끊겼거나 글을 못 올린 지난 실행의 표시가 남아 있으면, 복구가 처리할 때까지 새 실행으로 덮지 않는다.
  const pending = readRoutineRunStates()[routine.id]?.running;
  if (pending && !sameRunning(pending, retryOf)) return false;
  const attempt = retryOf ? (retryOf.attempt ?? 1) + 1 : 1;
  const run = executeRun(dir, routine, trigger, attempt)
    .catch((error) => console.error(`[routines] ${routine.id} run failed:`, error))
    .finally(() => map.delete(routine.id));
  map.set(routine.id, run);
  return true;
}

function preamble(routine: Routine, postsDir: string, inRoutineFolder: boolean, trigger: RoutineRunning["trigger"], attempt: number): string {
  const how = trigger === "schedule" ? "예약 루틴으로 자동 실행됐다" : "루틴의 지금 실행으로 시작됐다";
  return [
    `[CUELO 루틴: ${routine.name}] 이 세션은 ${how}. 사용자는 지금 보고 있지 않으니 질문하지 말고 끝까지 진행한다.`,
    ...(attempt > 1 ? ["앞선 시도가 CUELO 서버 재시작으로 중간에 끊겨 이 회차를 새 세션으로 다시 실행한다. 앞선 시도가 남긴 작업(커밋하지 않은 변경, 반쯤 한 일)이 있으면 먼저 확인하고 이어서 마무리하며, 같은 일을 두 번 하지 않는다."] : []),
    "마지막 답은 그대로 루틴 게시판의 글 본문으로 올라간다.",
    `루틴 공통 안내 ${resolve(postsDir, "../../../GUIDE.md")}가 있으면 글을 쓰기 전에 읽는다. 글의 말투, 길이, 형식은 그 안내를 따르고(이 루틴의 지시가 요구한 표, 항목, 링크도 그 안내가 정한 자리에 넣는다), 무엇을 조사하고 알릴지는 이 루틴의 지시를 따른다.`,
    `알릴 것이 없으면 마지막 답을 \`${QUIET_MARKER}\` 한 줄로 시작한다.`,
    `이 루틴의 지난 글은 ${postsDir}에 있으니 필요하면 읽고 같은 내용을 반복하지 않는다.`,
    ...(inRoutineFolder ? ["이 폴더 밖 파일은 바꾸지 않는다."] : []),
  ].join(" ");
}

/** 마감까지 기다린다. 마감이 지나면 `null`(그 일은 뒤에서 계속될 수 있다). */
async function untilDeadline<T>(work: Promise<T>, deadline: number): Promise<{ value: T } | null> {
  const timeout = Promise.withResolvers<null>();
  const timer = setTimeout(() => timeout.resolve(null), Math.max(0, deadline - Date.now()));
  try {
    return await Promise.race([work.then((value) => ({ value })), timeout.promise]);
  } finally {
    clearTimeout(timer);
  }
}

interface Observation {
  timedOut: boolean;
  error: string | null;
}

/**
 * 프롬프트를 보내고 세션이 쉴 때까지 기다린다. 프롬프트 접수(입력 확장)도 마감 안에 든다. `prompt_done`(입력 확장이
 * 프롬프트를 삼켰으면 실행 중이 아님) 뒤에도 하위 작업 결과가 새 턴을 깨울 수 있으므로, `isSafelyIdle()`이 두 번
 * 연달아 참일 때 끝으로 본다.
 */
async function promptAndObserve(session: AgentSessionWrapper, message: string, deadline: number): Promise<Observation> {
  let promptDone = false;
  let error: string | null = null;
  let wake: (() => void) | null = null;
  const unsubscribe = session.onEvent((event) => {
    if (event.type === "prompt_error") error = typeof event.errorMessage === "string" ? event.errorMessage : "프롬프트 실행이 오류로 끝났습니다.";
    if (event.type === "prompt_done") promptDone = true;
    if (event.type === "prompt_done" || event.type === "agent_settled") wake?.();
  }, { keepAlive: true });
  try {
    if (!(await untilDeadline(session.send({ type: "prompt", message }), deadline))) return { timedOut: true, error };
    let idleStreak = 0;
    for (;;) {
      if (!session.isAlive()) return { timedOut: false, error: error ?? "세션이 중간에 닫혔습니다." };
      const finished = (promptDone || !session.isRunning()) && session.isSafelyIdle();
      idleStreak = finished ? idleStreak + 1 : 0;
      if (idleStreak >= 2) return { timedOut: false, error };
      const left = deadline - Date.now();
      if (left <= 0) return { timedOut: true, error };
      const { promise, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, Math.min(POLL_MS, left));
      wake = () => {
        clearTimeout(timer);
        // 이벤트 직후에는 상태가 아직 바뀌는 중일 수 있어, 한 번 쉬게 둔다.
        setTimeout(resolve, 500);
      };
      await promise;
      wake = null;
    }
  } finally {
    unsubscribe();
  }
}

/**
 * 마감을 넘긴 세션을 먼저 닫힘 예약해(그 뒤로는 기다리던 프롬프트도 시작하지 못한다) 턴과 하위 작업을 멈추고, 그때까지의
 * 마지막 답을 읽은 뒤 세션을 닫는다. 돌려주는 약속은 닫기가 끝날 때 풀린다: 실행 자리를 그때까지 쥐고 있어, 닫히지
 * 않은 세션이 다음 회차와 겹치지 않는다.
 */
async function stopTimedOutSession(session: AgentSessionWrapper): Promise<{ answer: string; closed: Promise<void> }> {
  session.beginClose();
  await untilDeadline(session.send({ type: "abort" }).catch(() => undefined), Date.now() + ABORT_GRACE_MS);
  await untilDeadline(session.stopBackgroundWorkForDrain(STOP_BACKGROUND_MS).catch(() => false), Date.now() + STOP_BACKGROUND_MS + ABORT_GRACE_MS);
  const answer = ((await untilDeadline(lastAnswer(session), Date.now() + ABORT_GRACE_MS))?.value ?? "").trim();
  return { answer, closed: session.shutdown().catch(() => undefined) };
}

/** 마지막 답 원문(앞뒤 공백 그대로). `[알림 없음]` 판정은 원문 첫 줄로 한다. */
async function lastAnswer(session: AgentSessionWrapper): Promise<string> {
  try {
    const result = await session.send({ type: "get_last_assistant_text" }) as { text?: unknown } | null;
    return typeof result?.text === "string" ? result.text : "";
  } catch {
    return "";
  }
}

type RunResult = { status: RoutinePostStatus; body: string } | { status: "quiet" };

const TIMEOUT_NOTE = "_60분 안에 끝나지 않아 실행을 멈췄습니다._";

function timedOut(answer: string): RunResult {
  return { status: "timeout", body: answer ? `${answer}\n\n---\n\n${TIMEOUT_NOTE} 위는 그때까지의 마지막 답입니다.` : TIMEOUT_NOTE };
}

/**
 * 세션 하나로 회차를 돌린다. 세션 열기·이름 붙이기·프롬프트 접수·실행 모두 60분 마감 안에 든다. `closed`는 세션을
 * 닫아야 했을 때 그 닫기가 끝나면 풀린다(부른 쪽은 그때까지 실행 자리를 쥔다).
 */
async function runSession(routine: Routine, cwd: string, inRoutineFolder: boolean, postsDir: string, trigger: RoutineRunning["trigger"],
  attempt: number, started: Date, stampDisplay: string, onSession: (sessionId: string) => void): Promise<{ result: RunResult; closed: Promise<void> }> {
  const deadline = started.getTime() + RUN_TIMEOUT_MS;
  let settings;
  try {
    settings = await untilDeadline(routineModelSettings(routine.model), deadline);
  } catch (error) {
    throw new Error(`PC ${thisRoutineHost()}의 루틴 모델 설정을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!settings) return { result: timedOut(""), closed: Promise.resolve() };
  const { enabled, model } = settings.value;
  const starting = startNewRpcSession(undefined, cwd, model ? { initialModel: parseRoutineModel(model) } : {});
  let startedSession;
  try {
    startedSession = await untilDeadline(starting, deadline);
  } catch (error) {
    if (!enabled) throw error;
    throw new Error(`루틴 모델 ${model ?? "(세션 기본값)"}을 PC ${thisRoutineHost()}에서 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!startedSession) {
    // 늦게라도 열리면 프롬프트 없이 바로 닫는다.
    void starting.then(({ session }) => session.shutdown()).catch(() => undefined);
    return { result: { status: "timeout", body: "_60분 안에 세션을 열지 못해 멈췄습니다._" }, closed: Promise.resolve() };
  }
  const { session, realSessionId } = startedSession.value;
  onSession(realSessionId);
  const named = await untilDeadline(session.send({ type: "set_session_name", name: `루틴: ${routine.name} ${stampDisplay}` }), deadline);
  invalidateSessionListCache();
  if (!named) {
    const stopped = await stopTimedOutSession(session);
    return { result: timedOut(stopped.answer), closed: stopped.closed };
  }
  log(`${routine.id} started session ${realSessionId} in ${cwd} (${trigger})`);
  const observed = await promptAndObserve(session, `${preamble(routine, postsDir, inRoutineFolder, trigger, attempt)}\n\n${routine.prompt}`, deadline);
  if (observed.timedOut) {
    const stopped = await stopTimedOutSession(session);
    return { result: timedOut(stopped.answer), closed: stopped.closed };
  }
  const raw = await lastAnswer(session);
  const answer = raw.trim();
  let closed = Promise.resolve();
  if (!observed.error && raw.split("\n", 1)[0].replace(/\r$/, "") === QUIET_MARKER) return { result: { status: "quiet" }, closed };
  if (!answer || observed.error) {
    const reason = observed.error ? `세션이 오류로 끝났습니다: ${observed.error}` : "세션이 마지막 답 없이 끝났습니다.";
    return { result: { status: "failed", body: answer ? `${answer}\n\n---\n\n_${reason}_` : reason }, closed };
  }
  const body = enabled ? await checkRoutineAnswer({
    instruction: routine.prompt, answer, deadline, check: runRoutineChecker,
    log: (message) => log(`${routine.id} ${message}`),
    revise: async (message, revisionDeadline) => {
      const revision = await promptAndObserve(session, message, revisionDeadline);
      if (revision.timedOut) {
        const stopped = await stopTimedOutSession(session);
        closed = stopped.closed;
        throw new Error("revision exceeded routine deadline");
      }
      if (revision.error) throw new Error(revision.error);
      const result = await untilDeadline(lastAnswer(session), revisionDeadline);
      if (!result) throw new Error("revision answer exceeded routine deadline");
      return result.value;
    },
  }) : answer;
  return { result: { status: "ok", body }, closed };
}

/** 글을 커밋해 올린다. 그사이 루틴이 지워졌으면 글을 쓰지 않는다(지운 폴더를 되살리지 않는다). */
function commitPost(dir: string, routine: Routine, stampFile: string, post: RoutinePost): Promise<boolean> {
  return commitRoutineChange(dir, `routine(${routine.id}): ${post.title}`, () => {
    if (!readRoutine(dir, routine.id)) return { paths: [], result: false };
    return { paths: [writePostFile(dir, routine.id, stampFile, post.host, post)], result: true };
  });
}

async function executeRun(dir: string, routine: Routine, trigger: RoutineRunning["trigger"], attempt: number): Promise<void> {
  const started = new Date();
  const stamp = runStamp(started, routine.timezone);
  const host = thisRoutineHost();
  const paths = routinePaths(dir, routine.id);
  updateRoutineRunState(routine.id, (current) => ({
    ...current,
    running: { bootId: routineBootId(), sessionId: null, startedAt: started.toISOString(), trigger, ...(attempt > 1 ? { attempt } : {}) },
  }));

  let sessionId: string | null = null;
  let result: RunResult;
  let closed: Promise<void> = Promise.resolve();
  try {
    const cwd = routine.cwd ? expandHome(routine.cwd) : paths.folder;
    if (!routine.cwd) mkdirSync(paths.posts, { recursive: true });
    if (isExistingDirectory(cwd)) {
      ({ result, closed } = await runSession(routine, cwd, !routine.cwd, paths.posts, trigger, attempt, started, stamp.display, (id) => {
        sessionId = id;
        updateRoutineRunState(routine.id, (current) => current.running ? { ...current, running: { ...current.running, sessionId: id } } : current);
      }));
    } else {
      result = { status: "failed", body: `프로젝트 폴더가 이 PC(${host})에 없어 실행하지 못했습니다: \`${routine.cwd}\`` };
    }
  } catch (error) {
    result = { status: "failed", body: `세션을 실행하지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
  }

  // 이 회차가 시작된 뒤 서버가 종료 신호를 받았으면, 실패(세션이 닫혔거나, 닫힌 세션에서 답을 못 읽었거나, 세션을
  // 못 열었다)는 루틴의 실패가 아니다. 판정은 종료 창과 무관하게 신호 시각으로 한다. 실행 표시를 그대로 둬
  // recordInterruptedRuns가 다시 돌리거나 실패 글로 남긴다.
  const stopSignalAt = globalThis.__cueloRoutineServerStop?.since ?? null;
  if (result.status === "failed" && stopSignalAt !== null && stopSignalAt >= started.getTime()) {
    log(`${routine.id} was cut by the server stopping (attempt ${attempt}); recovery takes it over`);
    return;
  }

  try {
    const finishedAt = new Date().toISOString();
    const lastRun: RoutineLastRun = { finishedAt, status: result.status, sessionId };
    if (result.status === "quiet") {
      updateRoutineRunState(routine.id, (current) => ({ ...current, running: undefined, lastRun }));
      log(`${routine.id} finished quietly (no post)`);
      return;
    }
    const post: RoutinePost = {
      // 실패 글은 답의 제목을 빌리지 않는다: 게시판에서 실패 회차가 루틴 이름과 시각으로 보이게 둔다.
      title: extractPostTitle(result.status === "failed" ? "" : result.body, routine.name, stamp.display),
      routineId: routine.id,
      host,
      status: result.status,
      startedAt: started.toISOString(),
      finishedAt,
      sessionId,
      body: result.body,
    };
    try {
      const posted = await commitPost(dir, routine, stamp.file, post);
      updateRoutineRunState(routine.id, (current) => ({ ...current, running: undefined, lastRun }));
      log(posted ? `${routine.id} posted (${result.status})` : `${routine.id} was deleted during the run; no post`);
    } catch (error) {
      // 다음 틱의 복구가 이 실행을 실패 글로 다시 올린다.
      updateRoutineRunState(routine.id, (current) => current.running
        ? { ...current, running: { ...current.running, bootId: POST_FAILED_BOOT }, lastRun: { ...lastRun, status: "failed" } }
        : current);
      throw error;
    }
  } finally {
    // 마감으로 닫은 세션이 다 닫힐 때까지 실행 자리를 놓지 않는다(startRoutineRun의 finally가 놓는다).
    await closed;
  }
}

/**
 * 끝을 보지 못한 실행을 처리한다. 서버 재시작으로 끊긴 회차는 루틴이 아직 이 PC에서 켜져 있고, 시도 횟수가
 * 남았고, 시작한 지 오래되지 않았으면 새 세션으로 한 번 다시 돌린다(새 실행이 표시를 덮어쓴다). 그 밖(글을 올리지
 * 못한 실행, 다시 돌릴 수 없는 회차)은 실패 글로 남긴다. 글을 올린 뒤에야 표시를 지워, 실패하면 다음 틱에 다시 해
 * 본다. 루틴이 지워졌으면 표시만 지운다. 이 프로세스가 남긴 표시도 처리한다: 종료 신호를 받고도 서버가 살아남으면
 * 그 표시가 루틴을 계속 막기 때문이다. 종료 중에는 아무것도 하지 않고, 동시에 부르면 진행 중인 처리를 함께 기다린다.
 */
export function recordInterruptedRuns(dir: string, now = Date.now()): Promise<void> {
  globalThis.__cueloRoutineRecovery ??= recoverRuns(dir, now).finally(() => { globalThis.__cueloRoutineRecovery = undefined; });
  return globalThis.__cueloRoutineRecovery;
}

async function recoverRuns(dir: string, now: number): Promise<void> {
  const host = thisRoutineHost();
  for (const id of Object.keys(readRoutineRunStates())) {
    // 앞 항목의 글을 올리는 동안 종료가 시작됐거나 표시가 바뀌었을 수 있어 항목마다 다시 읽는다.
    if (serverStopping(now)) return;
    const running = readRoutineRunStates()[id]?.running;
    if (!running || isRoutineRunning(id)) continue;
    const routine = readRoutine(dir, id);
    if (routine) {
      const startedAt = new Date(running.startedAt);
      const attempt = running.attempt ?? 1;
      const cut = running.bootId !== POST_FAILED_BOOT;
      if (cut && routine.enabled && routine.host === host && attempt < MAX_ATTEMPTS
        && Number.isFinite(startedAt.getTime()) && now - startedAt.getTime() < RETRY_WINDOW_MS) {
        if (startRoutineRun(dir, routine, running.trigger, running)) log(`${id} restarted after a server restart cut it (attempt ${attempt + 1})`);
        // 시작하지 못했으면(이미 돌거나 종료 중) 표시를 그대로 두고 다음 틱에 다시 본다.
        continue;
      }
      const stamp = runStamp(Number.isNaN(startedAt.getTime()) ? new Date() : startedAt, routine.timezone);
      const post: RoutinePost = {
        title: extractPostTitle("", routine.name, stamp.display),
        routineId: id,
        host,
        status: "failed",
        startedAt: running.startedAt,
        finishedAt: new Date().toISOString(),
        sessionId: running.sessionId,
        body: !cut
          ? "이 실행의 결과를 게시판에 올리지 못했습니다. 세션 기록은 세션 목록에서 볼 수 있습니다."
          : attempt > 1
            ? "실행 중에 CUELO 서버가 다시 시작돼 끊겼고, 새 세션으로 다시 실행한 회차도 서버 재시작으로 끊겼습니다. 세션 기록은 세션 목록에서 볼 수 있습니다."
            : "실행 중에 CUELO 서버가 다시 시작돼 결과를 받지 못했습니다. 세션 기록은 세션 목록에서 볼 수 있습니다.",
      };
      try {
        await commitPost(dir, routine, stamp.file, post);
      } catch (error) {
        console.error(`[routines] ${id} interrupted-run post failed:`, error);
        continue;
      }
    }
    // 그사이 같은 루틴이 새로 시작해 표시를 바꿨으면 그 표시는 지우지 않는다.
    updateRoutineRunState(id, (current) => sameRunning(current.running, running) ? { ...current, running: undefined } : current);
  }
}
