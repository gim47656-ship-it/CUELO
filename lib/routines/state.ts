import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";

/**
 * 이 PC만의 루틴 실행 상태(공용 저장소에 올리지 않는다). 루틴마다 마지막으로 시작한 예약 회차 키와 지금 도는
 * 실행(이 서버 프로세스의 bootId 포함)을 둔다. 서버가 다시 뜨면 bootId가 다른 실행을 끊긴 실행으로 본다.
 */

export interface RoutineRunning {
  bootId: string;
  sessionId: string | null;
  startedAt: string;
  trigger: "schedule" | "manual";
  /** 몇 번째 시도인지(없으면 1). 서버 재시작으로 끊긴 회차를 다시 돌릴 때 늘린다. */
  attempt?: number;
}

export interface RoutineLastRun {
  finishedAt: string;
  /** quiet: 답이 `[알림 없음]`으로 시작해 글을 올리지 않은 회차. */
  status: "ok" | "failed" | "timeout" | "quiet";
  sessionId: string | null;
}

export interface RoutineRunState {
  lastRunKey?: string;
  running?: RoutineRunning;
  /** 이 PC에서 마지막으로 끝난 실행. */
  lastRun?: RoutineLastRun;
  /** 시작한 1회 일정을 아직 enabled:false로 커밋하지 못했으면 그 일정(JSON). 다음 틱마다 다시 커밋한다. */
  pendingOnceDisable?: string;
}

interface StateFile {
  version: 1;
  routines: Record<string, RoutineRunState>;
}

const STATE_FILE = "cuelo-routines-state.json";

function statePath(): string {
  return join(getAgentDir(), STATE_FILE);
}

export function readRoutineRunStates(): Record<string, RoutineRunState> {
  try {
    const raw = JSON.parse(readFileSync(statePath(), "utf8")) as StateFile;
    return raw && raw.version === 1 && raw.routines && typeof raw.routines === "object" ? raw.routines : {};
  } catch {
    return {};
  }
}

/** 동기 read-modify-write: 한 프로세스 안에서는 끼어들 틈이 없다. `undefined`를 돌려주면 그 루틴 항목을 지운다. */
export function updateRoutineRunState(id: string, change: (current: RoutineRunState) => RoutineRunState | undefined): void {
  const routines = readRoutineRunStates();
  const next = change(routines[id] ?? {});
  if (next === undefined) delete routines[id];
  else routines[id] = next;
  mkdirSync(getAgentDir(), { recursive: true });
  writePrivateFileAtomicSync(statePath(), `${JSON.stringify({ version: 1, routines } satisfies StateFile, null, 2)}\n`);
}
