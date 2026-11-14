/**
 * 글을 가리키는 읽음 키 `<루틴 id>/<글 파일>`의 형식과 시각. 서버(`reads.ts`, `store.ts`)와 브라우저(`board-store.ts`)가
 * 같은 규칙을 쓰도록 파일 시스템에 기대지 않는 순수 함수만 둔다.
 */

export const ROUTINE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const POST_FILE_PATTERN = /^\d{8}T\d{4}-[a-z0-9-]{1,63}(?:-\d+)?\.md$/;

/** 「새 글」로 보이는 기간. */
export const NEW_POST_MS = 7 * 24 * 60 * 60 * 1000;

/** `<루틴 id>/<글 파일>` 형식이면 그 둘을, 아니면 null. */
export function parsePostKey(key: string): { routineId: string; file: string } | null {
  const parts = key.split("/");
  if (parts.length !== 2) return null;
  const [routineId, file] = parts;
  return ROUTINE_ID_PATTERN.test(routineId) && POST_FILE_PATTERN.test(file) ? { routineId, file } : null;
}

/** 글 파일 이름 앞의 실행 시각(YYYYMMDDTHHMM, 한국 시간)을 ms로. 달력에 없는 시각이면 null. */
export function postFileStartedAt(file: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(file);
  if (!m) return null;
  const [year, month, day, hour, minute] = m.slice(1).map(Number);
  const at = Date.UTC(year, month - 1, day, hour - 9, minute);
  const check = new Date(at + 9 * 3_600_000);
  const valid = check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    && check.getUTCHours() === hour && check.getUTCMinutes() === minute;
  return valid ? at : null;
}
