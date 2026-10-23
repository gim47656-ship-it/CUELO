import type { SessionInfo } from "./types";

/**
 * 「확인할 결과」: 이 브라우저에서 마지막으로 연 뒤에 활동이 늘었고 지금 실행 중이 아닌 세션.
 * 연 시각은 세션마다 이 브라우저의 localStorage에만 남는다(다른 PC·브라우저와 나누지 않는다).
 * 처음 쓰는 브라우저는 그 시각(`since`)을 기준으로 삼아, 기능을 켜기 전의 기록이 모두 확인할
 * 결과로 쏟아지지 않게 한다.
 */
export const RESULT_REVIEW_STORAGE_KEY = "omp-web:session-opened-at";

/** 연 시각을 남기는 세션 수 상한. 넘으면 오래전에 연 것부터 버리고, 버린 세션은 `since`로 판정한다. */
export const RESULT_REVIEW_MAX_ENTRIES = 500;

export interface ResultReviewState {
  /** 이 브라우저가 연 시각을 남기기 시작한 때(ms). 연 기록이 없는 세션의 기준이다. */
  since: number;
  /** 세션 id → 마지막으로 연 때(ms). */
  opened: Record<string, number>;
}

export function parseResultReviewState(raw: string | null, now: number): ResultReviewState {
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as { since?: unknown; opened?: unknown };
        if (typeof record.since === "number" && Number.isFinite(record.since)) {
          const opened: Record<string, number> = {};
          if (record.opened && typeof record.opened === "object") {
            for (const [id, at] of Object.entries(record.opened as Record<string, unknown>)) {
              if (typeof at === "number" && Number.isFinite(at)) opened[id] = at;
            }
          }
          return { since: record.since, opened };
        }
      }
    } catch {
      // 깨진 값은 처음 쓰는 브라우저처럼 다룬다.
    }
  }
  return { since: now, opened: {} };
}

export function serializeResultReviewState(state: ResultReviewState): string {
  const entries = Object.entries(state.opened);
  const kept = entries.length > RESULT_REVIEW_MAX_ENTRIES
    ? entries.sort((left, right) => right[1] - left[1]).slice(0, RESULT_REVIEW_MAX_ENTRIES)
    : entries;
  return JSON.stringify({ since: state.since, opened: Object.fromEntries(kept) });
}

/**
 * 다른 탭이 남긴 기록을 합친다. 세션마다 나중에 연 때, 기준 시각은 이른 쪽을 쓴다. 더할 것이 없으면
 * `current` 그대로라, 탭끼리 `storage` 이벤트를 주고받아도 다시 쓰기가 되풀이되지 않는다.
 */
export function mergeResultReviewStates(current: ResultReviewState, other: ResultReviewState): ResultReviewState {
  let opened: Record<string, number> | null = null;
  for (const [id, at] of Object.entries(other.opened)) {
    if ((current.opened[id] ?? -Infinity) >= at) continue;
    opened ??= { ...current.opened };
    opened[id] = at;
  }
  if (!opened && other.since >= current.since) return current;
  return { since: Math.min(current.since, other.since), opened: opened ?? current.opened };
}

/** 저장할 값. 쓰기 직전에 저장소의 값과 합쳐 다른 탭이 그사이 남긴 기록을 덮지 않는다. */
export function resultReviewToStore(storedRaw: string | null, state: ResultReviewState, now: number): string {
  return serializeResultReviewState(mergeResultReviewStates(state, parseResultReviewState(storedRaw, now)));
}

function activityMs(session: Pick<SessionInfo, "modified">): number | null {
  const at = Date.parse(session.modified);
  return Number.isFinite(at) ? at : null;
}

/**
 * 세션을 지금 연 것으로 남긴다. 서버 시계가 브라우저보다 앞서도 열어 둔 동안의 활동이 다시
 * 확인할 결과가 되지 않게, 지금과 그 세션의 활동 시각 중 나중 것을 쓴다. 바뀐 게 없으면 같은 객체다.
 */
export function markSessionOpened(state: ResultReviewState, session: Pick<SessionInfo, "id" | "modified">, now: number): ResultReviewState {
  const at = Math.max(now, activityMs(session) ?? 0);
  if ((state.opened[session.id] ?? -Infinity) >= at) return state;
  return { since: state.since, opened: { ...state.opened, [session.id]: at } };
}

export function isResultToCheck(
  session: SessionInfo,
  runningSessionIds: ReadonlySet<string>,
  state: ResultReviewState,
): boolean {
  if (session.transient || runningSessionIds.has(session.id)) return false;
  const at = activityMs(session);
  if (at === null) return false;
  return at > (state.opened[session.id] ?? state.since);
}

export function forgetSessions(state: ResultReviewState, ids: Iterable<string>): ResultReviewState {
  let opened: Record<string, number> | null = null;
  for (const id of ids) {
    if (!Object.hasOwn(state.opened, id)) continue;
    opened ??= { ...state.opened };
    delete opened[id];
  }
  return opened ? { since: state.since, opened } : state;
}
