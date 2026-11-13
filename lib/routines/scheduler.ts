import { commitRoutineChange, requestRoutineSync, syncRoutineRepo } from "./git-sync";
import { isRoutineRunning, recordInterruptedRuns, startRoutineRun } from "./runner";
import { dueRunKey } from "./schedule";
import { readRoutineRunStates, updateRoutineRunState } from "./state";
import { inspectRepo, readRoutine, readRoutines, routinesDir, thisRoutineHost, writeRoutineFile } from "./store";

const TICK_MS = 30_000;
const FIRST_TICK_MS = 15_000;
const SYNC_INTERVAL_MS = 5 * 60_000;

declare global {
  var __cueloRoutineScheduler: { ticking: boolean } | undefined;
}

const log = (message: string) => console.log(`[routines] ${message}`);

/**
 * 시작한 1회 일정을 끈다(커밋해 다른 PC에도 알린다). 그사이 일정이 바뀌었거나 이미 꺼졌거나 지워졌으면 손대지
 * 않는다. 커밋하지 못하면 상태 파일의 표시를 남겨 다음 틱에 다시 한다. 같은 회차는 회차 키가 다시 막는다.
 */
async function disableOnce(dir: string, id: string, ranSchedule: string): Promise<void> {
  try {
    await commitRoutineChange(dir, `routine(${id}): disable after once run`, () => {
      const current = readRoutine(dir, id);
      if (!current?.enabled || JSON.stringify(current.schedule) !== ranSchedule) return { paths: [], result: undefined };
      return { paths: [writeRoutineFile(dir, { ...current, enabled: false, updatedAt: new Date().toISOString() })], result: undefined };
    });
    updateRoutineRunState(id, (current) => current.pendingOnceDisable === ranSchedule ? { ...current, pendingOnceDisable: undefined } : current);
  } catch (error) {
    console.error(`[routines] ${id} could not disable the once schedule (retrying next tick):`, error);
  }
}

/**
 * 30초마다 공용 저장소의 루틴을 읽어, 실행 PC가 이 PC이고 켜져 있으며 지금 실행 창 안에 든 회차를 시작한다. 시작
 * 직전에 저장소를 받아(되는 데까지) routine.json을 다시 읽고, 꺼졌거나 지워졌거나 일정이 바뀌었으면 시작하지 않는다:
 * 다른 PC에서 끈 것이 대기 중인 틱보다 이긴다. 회차 키는 세션을 열기 전에 상태 파일에 남겨 서버가 죽었다 떠도
 * 같은 회차를 다시 돌리지 않는다. 저장소는 5분마다 백그라운드로 동기화한다. `instrumentation.ts`에서 서버
 * 프로세스당 한 번 부른다.
 */
export function ensureRoutineScheduler(): void {
  if (globalThis.__cueloRoutineScheduler) return;
  const state = { ticking: false };
  globalThis.__cueloRoutineScheduler = state;
  const tick = async () => {
    if (state.ticking) return;
    state.ticking = true;
    try {
      const dir = routinesDir();
      if (!inspectRepo(dir).ok) return;
      await recordInterruptedRuns(dir);
      for (const [id, runState] of Object.entries(readRoutineRunStates())) {
        if (runState.pendingOnceDisable) await disableOnce(dir, id, runState.pendingOnceDisable);
      }
      requestRoutineSync(dir, SYNC_INTERVAL_MS);
      const host = thisRoutineHost();
      const runStates = readRoutineRunStates();
      // 끊긴 실행의 글이 아직 안 올라간 루틴(running 표시가 남은 루틴)은 새 회차로 덮지 않는다.
      const due = readRoutines(dir).flatMap((routine) => {
        if (!routine.enabled || routine.host !== host || isRoutineRunning(routine.id) || runStates[routine.id]?.running) return [];
        const key = dueRunKey(routine.schedule, routine.timezone, new Date());
        return key && runStates[routine.id]?.lastRunKey !== key ? [{ id: routine.id, key, schedule: JSON.stringify(routine.schedule) }] : [];
      });
      if (due.length === 0) return;
      await syncRoutineRepo(dir);
      for (const { id, key, schedule } of due) {
        // 동기화가 오래 걸렸을 수 있어 시계도 다시 읽는다: 실행 창이 닫혔으면 따라잡지 않는다. 일정은 회차 키가 같아도
        // 모양이 바뀌었으면(예: 매주 13:00 → 오늘 13:00 한 번) 바뀐 것으로 본다.
        const fresh = readRoutine(dir, id);
        if (!fresh || !fresh.enabled || fresh.host !== host || JSON.stringify(fresh.schedule) !== schedule
          || dueRunKey(fresh.schedule, fresh.timezone, new Date()) !== key) {
          log(`${id} skipped ${key}: disabled, deleted, moved, rescheduled or past its window before the run`);
          continue;
        }
        const onceSchedule = fresh.schedule.kind === "once" ? schedule : undefined;
        // 회차 키(와 1회 일정 끄기 표시)를 먼저 남긴다: 이 쓰기가 실패하면 세션을 열지 않는다. 다시 읽은 정의와 시작
        // 사이에는 기다림이 없고, 1회 일정을 끄는 커밋은 시작한 뒤에 한다.
        const previous = readRoutineRunStates()[id];
        updateRoutineRunState(id, (current) => ({ ...current, lastRunKey: key, ...(onceSchedule ? { pendingOnceDisable: onceSchedule } : {}) }));
        if (!startRoutineRun(dir, fresh, "schedule")) {
          updateRoutineRunState(id, (current) => ({ ...current, lastRunKey: previous?.lastRunKey, pendingOnceDisable: previous?.pendingOnceDisable }));
          continue;
        }
        if (onceSchedule) await disableOnce(dir, id, onceSchedule);
      }
    } catch (error) {
      console.error("[routines] scheduler tick failed:", error);
    } finally {
      state.ticking = false;
    }
  };
  setTimeout(() => void tick(), FIRST_TICK_MS).unref?.();
  setInterval(() => void tick(), TICK_MS).unref?.();
  console.info("[routines] scheduler started: every 30s");
}
