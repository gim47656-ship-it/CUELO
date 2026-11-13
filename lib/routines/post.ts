/**
 * 루틴 게시판 글 한 편의 파일 형식. `routines/<id>/posts/<YYYYMMDDTHHmm>-<host>.md`는 `---`로 감싼 머리말
 * (title, routineId, host, status, startedAt, finishedAt, sessionId)과 markdown 본문으로 이뤄진다.
 * 머리말 값은 JSON 문자열로 쓴다. JSON 문자열은 YAML 큰따옴표 문자열이기도 해서 다른 도구로 열어도 읽힌다.
 */

export type RoutinePostStatus = "ok" | "failed" | "timeout";
export const ROUTINE_POST_STATUSES: readonly RoutinePostStatus[] = ["ok", "failed", "timeout"];

export interface RoutinePostMeta {
  title: string;
  routineId: string;
  host: string;
  status: RoutinePostStatus;
  startedAt: string;
  finishedAt: string;
  sessionId: string | null;
}

export interface RoutinePost extends RoutinePostMeta {
  body: string;
}

const KEYS = ["title", "routineId", "host", "status", "startedAt", "finishedAt", "sessionId"] as const;
export const TITLE_LIMIT = 200;

export function serializeRoutinePost(post: RoutinePost): string {
  const head = KEYS.map((key) => `${key}: ${JSON.stringify(post[key] ?? "")}`).join("\n");
  const body = post.body.replace(/\r\n/g, "\n").replace(/\s+$/, "");
  return `---\n${head}\n---\n\n${body}\n`;
}

function readValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" ? parsed : "";
    } catch {
      return value.slice(1, value.endsWith("\"") ? -1 : undefined);
    }
  }
  return value;
}

/** 머리말이 없거나 깨진 파일은 null. 모르는 status는 failed로 읽는다(글은 보이게 둔다). */
export function parseRoutinePost(text: string): RoutinePost | null {
  const normalized = text.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return null;
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields[line.slice(0, colon).trim()] = readValue(line.slice(colon + 1));
  }
  if (!fields.title || !fields.routineId) return null;
  const status = (ROUTINE_POST_STATUSES as readonly string[]).includes(fields.status) ? fields.status as RoutinePostStatus : "failed";
  return {
    title: fields.title,
    routineId: fields.routineId,
    host: fields.host ?? "",
    status,
    startedAt: fields.startedAt ?? "",
    finishedAt: fields.finishedAt ?? "",
    sessionId: fields.sessionId || null,
    body: normalized.slice(match[0].length).replace(/^\n/, "").replace(/\s+$/, ""),
  };
}

/**
 * markdown의 첫 `# ` 제목 줄(코드 블록 밖)의 위치와 글. 코드 블록은 CommonMark처럼 여는 표시와 같은 문자로,
 * 같거나 더 긴 표시가 와야 닫힌다(```` 블록 안의 ``` 줄은 닫지 않는다).
 */
export function findTitleHeading(markdown: string): { index: number; text: string } | null {
  let fence: { char: string; length: number } | null = null;
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(lines[index]);
    if (marker) {
      const run = marker[1];
      if (!fence) fence = { char: run[0], length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && marker[2].trim() === "") fence = null;
      continue;
    }
    if (fence) continue;
    const heading = /^\s{0,3}# +(.+?)\s*#*\s*$/.exec(lines[index]);
    if (heading?.[1].trim()) return { index, text: heading[1].trim() };
  }
  return null;
}

/**
 * 답의 첫 `# ` 제목(코드 블록 밖)을 글 제목으로 쓴다. 없으면 `<루틴 이름> <YYYY-MM-DD HH:mm>`.
 */
export function extractPostTitle(answer: string, routineName: string, startedDisplay: string): string {
  return clipTitle(findTitleHeading(answer)?.text ?? `${routineName} ${startedDisplay}`);
}

function clipTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ");
  return flat.length > TITLE_LIMIT ? `${flat.slice(0, TITLE_LIMIT - 1)}…` : flat;
}
