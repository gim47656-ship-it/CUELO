/**
 * 루틴 예약 시각 계산. 루틴의 시간대(저장 값, 기본 Asia/Seoul)로 지금을 읽어, 일정의 어느 회차(slot) 시각부터
 * 5분 안이면 그 회차 키(`YYYY-MM-DDTHH:mm`, 그 시간대의 날짜와 시각)를 돌려준다. 서버가 꺼져 그 5분을 놓친
 * 회차는 나중에 따라잡지 않는다. 분 단위까지만 다룬다(초는 없다).
 */

export const ROUTINE_TIMEZONE = "Asia/Seoul";
export const DUE_WINDOW_MINUTES = 5;

export type RoutineSchedule =
  | { kind: "weekly"; days: number[]; times: string[] }
  /** `everyHours`시간마다 `minute`분. `hour % everyHours == startHour % everyHours`인 시에만 돈다. */
  | { kind: "hourly"; everyHours: number; minute: number; startHour?: number; days?: number[] }
  | { kind: "once"; date: string; time: string };

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  weekday: number; // 0=일 … 6=토
  hour: number;
  minute: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${String(hour).padStart(2, "0")}:${parts.minute}`,
    weekday: WEEKDAYS[parts.weekday] ?? 0,
    hour,
    minute: Number(parts.minute),
  };
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function parseClock(time: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

const isDay = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;
const sortedUnique = <T>(values: T[]) => [...new Set(values)].sort();

/** 저장 파일이나 화면에서 온 일정을 검사해 정리한다. 틀리면 이유 문자열. */
export function parseSchedule(raw: unknown): RoutineSchedule | string {
  if (!raw || typeof raw !== "object") return "schedule must be an object";
  const value = raw as Record<string, unknown>;
  if (value.kind === "weekly") {
    if (!Array.isArray(value.days) || value.days.length === 0 || !value.days.every(isDay)) return "schedule.days must be 1+ integers 0-6";
    if (!Array.isArray(value.times) || value.times.length === 0 || !value.times.every((t) => typeof t === "string" && parseClock(t) !== null)) {
      return "schedule.times must be 1+ HH:mm values";
    }
    return { kind: "weekly", days: sortedUnique(value.days as number[]), times: sortedUnique(value.times as string[]) };
  }
  if (value.kind === "hourly") {
    const { everyHours, minute, startHour, days } = value;
    if (!Number.isInteger(everyHours) || (everyHours as number) < 1 || (everyHours as number) > 12) return "schedule.everyHours must be 1-12";
    if (!Number.isInteger(minute) || (minute as number) < 0 || (minute as number) > 59) return "schedule.minute must be 0-59";
    if (startHour !== undefined && (!Number.isInteger(startHour) || (startHour as number) < 0 || (startHour as number) > 23)) return "schedule.startHour must be 0-23";
    if (days !== undefined && (!Array.isArray(days) || days.length === 0 || !days.every(isDay))) return "schedule.days must be 1+ integers 0-6";
    return {
      kind: "hourly", everyHours: everyHours as number, minute: minute as number,
      ...(startHour === undefined ? {} : { startHour: startHour as number }),
      ...(days === undefined ? {} : { days: sortedUnique(days as number[]) }),
    };
  }
  if (value.kind === "once") {
    if (typeof value.date !== "string" || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value.date)) return "schedule.date must be YYYY-MM-DD";
    if (typeof value.time !== "string" || parseClock(value.time) === null) return "schedule.time must be HH:mm";
    return { kind: "once", date: value.date, time: value.time };
  }
  return "schedule.kind must be weekly, hourly or once";
}

function slotMatches(schedule: RoutineSchedule, at: LocalParts): boolean {
  switch (schedule.kind) {
    case "weekly":
      return schedule.days.includes(at.weekday) && schedule.times.includes(at.time);
    case "hourly":
      return (schedule.days === undefined || schedule.days.includes(at.weekday))
        && at.minute === schedule.minute
        && at.hour % schedule.everyHours === (schedule.startHour ?? 0) % schedule.everyHours;
    case "once":
      return at.date === schedule.date && at.time === schedule.time;
  }
}

/**
 * 지금이 어느 회차의 실행 창 안이면 그 회차 키, 아니면 null. 창 안에 회차가 여럿이면 가장 늦은 회차다. 창이 자정을
 * 넘으면(23:58 시작) 다음 날 00:01에도 전날 회차로 본다: 키의 날짜와 요일은 회차 시각이 실제로 속한 날이다.
 */
export function dueRunKey(schedule: RoutineSchedule, timeZone: string, now: Date): string | null {
  if (!isValidTimeZone(timeZone)) return null;
  for (let elapsed = 0; elapsed < DUE_WINDOW_MINUTES; elapsed += 1) {
    const at = localParts(new Date(now.getTime() - elapsed * 60_000), timeZone);
    if (slotMatches(schedule, at)) return `${at.date}T${at.time}`;
  }
  return null;
}

/** 루틴 시간대의 벽시계 시각(UTC 필드로 적은 ms)을 실제 시각으로. 그 시각의 시간대 차이로 한 번 맞춘다. */
function wallToInstant(wall: number, timeZone: string, guessOffset: number): Date {
  const guess = wall - guessOffset;
  const parts = localParts(new Date(guess), timeZone);
  const [y, m, d] = parts.date.split("-").map(Number);
  return new Date(guess + (wall - Date.UTC(y, m - 1, d, parts.hour, parts.minute)));
}

/**
 * 다음 회차 시각(지금보다 뒤). 1회 일정은 날짜가 아무리 멀어도 그 회차이고, 지났으면 null. 매주·몇 시간마다
 * 일정은 8일 안에서 찾는다(언제나 그 안에 회차가 있다). 그 8일 동안은 시간대 차이가 바뀌지 않는다고 본다
 * (Asia/Seoul은 일광 절약 시간이 없다).
 */
export function nextRunAt(schedule: RoutineSchedule, timeZone: string, now: Date): Date | null {
  if (!isValidTimeZone(timeZone)) return null;
  const nowParts = localParts(now, timeZone);
  const [y, m, d] = nowParts.date.split("-").map(Number);
  const wallNow = Date.UTC(y, m - 1, d, nowParts.hour, nowParts.minute);
  const offset = wallNow - Math.floor(now.getTime() / 60_000) * 60_000;
  if (schedule.kind === "once") {
    const [oy, om, od] = schedule.date.split("-").map(Number);
    const wall = Date.UTC(oy, om - 1, od) + (parseClock(schedule.time) ?? 0) * 60_000;
    return wall > wallNow ? wallToInstant(wall, timeZone, offset) : null;
  }
  const candidates: number[] = [];
  for (let day = 0; day <= 8; day += 1) {
    const base = Date.UTC(y, m - 1, d + day);
    const weekday = new Date(base).getUTCDay();
    if (schedule.kind === "weekly" && schedule.days.includes(weekday)) {
      for (const time of schedule.times) candidates.push(base + (parseClock(time) ?? 0) * 60_000);
    } else if (schedule.kind === "hourly" && (schedule.days === undefined || schedule.days.includes(weekday))) {
      for (let hour = 0; hour < 24; hour += 1) {
        if (hour % schedule.everyHours === (schedule.startHour ?? 0) % schedule.everyHours) candidates.push(base + (hour * 60 + schedule.minute) * 60_000);
      }
    }
  }
  const next = candidates.filter((wall) => wall > wallNow).sort((a, b) => a - b)[0];
  return next === undefined ? null : new Date(next - offset);
}

/** 실행 시작 시각을 루틴 시간대로 읽은 표시용 문자열(`YYYY-MM-DD HH:mm`)과 글 파일 이름용 도장(`YYYYMMDDTHHmm`). */
export function runStamp(instant: Date, timeZone: string): { display: string; file: string } {
  const parts = localParts(instant, isValidTimeZone(timeZone) ? timeZone : ROUTINE_TIMEZONE);
  return {
    display: `${parts.date} ${parts.time}`,
    file: `${parts.date.replace(/-/g, "")}T${parts.time.replace(":", "")}`,
  };
}
