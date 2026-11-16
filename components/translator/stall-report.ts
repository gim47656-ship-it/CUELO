/**
 * 통역 중 화면 멈춤 기록. 폰에서 「눌러도 안 먹힌다」가 다시 생기면 그때 앱이 바빴는지(긴 작업)
 * 단추가 문제였는지 서버 로그로 가린다. 숫자와 정해진 낱말만 오가며 대화 글은 절대 담지 않는다.
 * 화면(`useStallLog`)과 서버(`app/api/live/stall`)가 같은 검사를 쓴다.
 */

export const STALL_PHASES = ["idle", "connecting", "listening", "translating", "reconnecting", "error"] as const;
export const FACE_TRIGGERS = ["button", "back", "restore"] as const;
export const STALL_KINDS = ["stall", "face-on", "face-off"] as const;

export type StallPhase = (typeof STALL_PHASES)[number];
export type FaceTrigger = (typeof FACE_TRIGGERS)[number];

export type StallEvent =
  | { kind: "stall"; durationMs: number; phase: StallPhase; face: boolean; segmentCount: number }
  | { kind: "face-on" | "face-off"; trigger: FaceTrigger; phase: StallPhase; face: boolean; segmentCount: number };

export interface StallReport {
  events: StallEvent[];
}

/** 이만큼(ms) 넘게 멈춘 긴 작업만 남긴다. */
export const STALL_MIN_MS = 500;
/** 한 번 보내는 사건 수의 위. */
export const STALL_MAX_EVENTS = 20;
/** 요청 본문 크기의 위(바이트). */
export const STALL_MAX_BODY = 4096;
const MAX_DURATION_MS = 600_000;
const MAX_SEGMENTS = 100_000;

const isIntIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

const oneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (list as readonly string[]).includes(value);

const hasOnlyKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(record).every((key) => keys.includes(key));

function parseEvent(value: unknown): StallEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!oneOf(STALL_PHASES, raw.phase) || typeof raw.face !== "boolean" || !isIntIn(raw.segmentCount, 0, MAX_SEGMENTS)) return null;
  const common = { phase: raw.phase, face: raw.face, segmentCount: raw.segmentCount };
  if (raw.kind === "stall") {
    if (!hasOnlyKeys(raw, ["kind", "durationMs", "phase", "face", "segmentCount"])) return null;
    if (!isIntIn(raw.durationMs, STALL_MIN_MS, MAX_DURATION_MS)) return null;
    return { kind: "stall", durationMs: raw.durationMs, ...common };
  }
  if (raw.kind === "face-on" || raw.kind === "face-off") {
    if (!hasOnlyKeys(raw, ["kind", "trigger", "phase", "face", "segmentCount"])) return null;
    if (!oneOf(FACE_TRIGGERS, raw.trigger)) return null;
    return { kind: raw.kind, trigger: raw.trigger, ...common };
  }
  return null;
}

/** 서버가 받는 본문 검사. 정해진 칸 밖의 값(글 칸 포함)이 하나라도 있으면 통째로 거절한다. */
export function parseStallReport(value: unknown): StallReport | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (!hasOnlyKeys(raw, ["events"]) || !Array.isArray(raw.events)) return null;
  if (raw.events.length === 0 || raw.events.length > STALL_MAX_EVENTS) return null;
  const events: StallEvent[] = [];
  for (const item of raw.events) {
    const event = parseEvent(item);
    if (!event) return null;
    events.push(event);
  }
  return { events };
}

/** 서버 로그 한 줄. */
export function formatStallLine(event: StallEvent): string {
  const tail = `phase=${event.phase} face=${event.face} segments=${event.segmentCount}`;
  return event.kind === "stall"
    ? `[translator] stall ${event.durationMs}ms ${tail}`
    : `[translator] ${event.kind} trigger=${event.trigger} ${tail}`;
}

/** 화면 쪽 보내기 간격과 한 페이지에서 보내는 횟수의 위. */
export const STALL_POST_INTERVAL_MS = 10_000;
export const STALL_MAX_POSTS = 30;

/**
 * 보내기 조절: 마지막으로 보낸 뒤 `STALL_POST_INTERVAL_MS`가 지나야 다시 보내고, 페이지마다
 * `STALL_MAX_POSTS`번까지만 보낸다. 지금 보낼 수 있으면 0, 기다려야 하면 남은 ms, 더 못 보내면 `null`.
 */
export function nextPostDelay(lastPostAt: number | null, posts: number, now: number): number | null {
  if (posts >= STALL_MAX_POSTS) return null;
  if (lastPostAt === null) return 0;
  return Math.max(0, lastPostAt + STALL_POST_INTERVAL_MS - now);
}
