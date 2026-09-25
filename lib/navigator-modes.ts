import type { SessionInfo } from "./types";

export const NAVIGATOR_MODES = ["projects", "priority"] as const;
export type NavigatorMode = (typeof NAVIGATOR_MODES)[number];

export const NAVIGATOR_MODE_STORAGE_KEY = "omp-web:navigator-mode";
export const LEGACY_PRIORITY_MODE_STORAGE_KEY = "omp-prio-on";
export const PRIORITY_REFRESH_MS = 15_000;
export const PRIORITY_RECENT_SESSION_LIMIT = 10;

export interface PrioritySessionGroup {
  key: string;
  label: string;
  running: boolean;
  sessions: SessionInfo[];
}

export function isNavigatorMode(value: unknown): value is NavigatorMode {
  return typeof value === "string" && NAVIGATOR_MODES.includes(value as NavigatorMode);
}

export function parseStoredNavigatorMode(
  storedMode: string | null,
  legacyPriorityEnabled: string | null,
): NavigatorMode {
  if (storedMode === "gpt6") return "projects";
  if (isNavigatorMode(storedMode)) return storedMode;
  return legacyPriorityEnabled === "1" ? "priority" : "projects";
}

export function prioritySessionTitle(session: SessionInfo): string {
  return (session.name || session.firstMessage || session.id.slice(0, 8))
    .replace(/\s+/g, " ")
    .trim();
}

export function prioritySessionProjectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? "";
}

/** Scratch directory names the OMP relay and harness runs create themselves. */
const OMP_SCRATCH_PREFIXES = ["omp-relay-session-", "omp-cwd-", "ompscope_"];

/**
 * True when a project path is never a work folder: a drive or filesystem root,
 * the OS temp tree, the OMP profile directory, or one of the scratch
 * directories OMP creates for its own relay and harness runs. Anything else —
 * including a folder that merely happens to be named like a system directory —
 * stays a normal project. Windows paths match case-insensitively and both
 * slash styles are accepted.
 */
export function isTemporaryProjectPath(project: string): boolean {
  const normalized = project.trim().replace(/\\/g, "/").toLowerCase();
  if (/^[a-z]:\/?$/.test(normalized) || normalized === "/") return true;
  // …/AppData/Local/Temp/…, /tmp, /var/tmp, /private/tmp and a tmp/temp
  // directory sitting directly under a drive or filesystem root. Every pattern
  // ends on a segment boundary so neighbours such as …/TempArchive or
  // …/Temperature stay normal projects.
  if (/(^|\/)appdata\/local\/temp(\/|$)/.test(normalized)) return true;
  if (/^\/(?:var\/|private\/)?tmp(?:\/|$)/.test(normalized)) return true;
  if (/^[a-z]:\/(?:tmp|temp)(?:\/|$)/.test(normalized)) return true;
  // The OMP profile dir, but only where a user profile owns it
  // (…/Users/<name>/.omp, /home/<name>/.omp) — a project folder that merely
  // happens to be named .omp is not the agent profile.
  if (/(^|\/)(?:users|home)\/[^/]+\/\.omp(\/|$)/.test(normalized)) return true;
  // Scratch dirs the relay and harness runs create for themselves. Eval runs nest the real
  // work folder under them (…/omp-cwd-20260924/oe-…/project), so any segment counts, not only the leaf.
  return normalized.split("/").some((segment) => OMP_SCRATCH_PREFIXES.some((prefix) => segment.startsWith(prefix)));
}


function calendarDayDistance(now: Date, date: Date): number {
  const nowUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const dateUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((nowUtc - dateUtc) / 86_400_000);
}

export function formatPriorityDateLabel(dayKey: string, now: Date, locale: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const distance = calendarDayDistance(now, date);
  if (distance === 0 || distance === 1) {
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-distance, "day");
  }
  if (distance >= 0 && distance < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}


export function buildPrioritySessionGroups(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  now: Date,
  locale: string,
  priorityLabel = "Priority",
  pinnedSessionIds: ReadonlySet<string> = new Set(),
  pinnedLabel = "Pinned",
): PrioritySessionGroup[] {
  const ordered = sessions
    .filter((session) => !session.transient)
    .slice()
    .sort((left, right) => {
      const leftTime = Date.parse(left.modified);
      const rightTime = Date.parse(right.modified);
      return (Number.isFinite(rightTime) ? rightTime : 0)
        - (Number.isFinite(leftTime) ? leftTime : 0);
    });
  const pinned = ordered.filter((session) => pinnedSessionIds.has(session.id));
  const running: SessionInfo[] = [];
  const sessionsByDay = new Map<string, SessionInfo[]>();

  let recentSessionCount = 0;
  for (const session of ordered) {
    if (pinnedSessionIds.has(session.id)) continue;
    if (runningSessionIds.has(session.id)) {
      running.push(session);
      continue;
    }
    const modified = new Date(session.modified);
    if (recentSessionCount >= PRIORITY_RECENT_SESSION_LIMIT) continue;
    recentSessionCount += 1;
    const key = [
      modified.getFullYear(),
      String(modified.getMonth() + 1).padStart(2, "0"),
      String(modified.getDate()).padStart(2, "0"),
    ].join("-");
    const group = sessionsByDay.get(key);
    if (group) group.push(session);
    else sessionsByDay.set(key, [session]);
  }

  const groups: PrioritySessionGroup[] = [];
  if (pinned.length > 0) {
    groups.push({ key: "pinned", label: pinnedLabel, running: false, sessions: pinned });
  }
  if (running.length > 0) {
    groups.push({ key: "priority", label: priorityLabel, running: true, sessions: running });
  }
  for (const key of [...sessionsByDay.keys()].sort().reverse()) {
    groups.push({
      key,
      label: formatPriorityDateLabel(key, now, locale),
      running: false,
      sessions: sessionsByDay.get(key) ?? [],
    });
  }
  return groups;
}
