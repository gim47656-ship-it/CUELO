import { findTranslatorLanguage, type TranslatorLanguage } from "@/lib/translator-languages";
import { emptyTranscriptLog, segmentLanguage, type TranscriptLog, type TranscriptSegment } from "./transcript-log";

/**
 * 음성 통역 대화를 이 폰의 localStorage에만 남긴다. 화면을 떠나거나 앱을 다시 켜도 마지막 대화를
 * 다시 보고 공유할 수 있게 하려는 것이고, 서버에는 아무것도 보내지 않는다. 「지우기」가 지운다.
 */

export const CONVERSATION_KEY = "cuelo-translator-conversation";
/** 저장하는 조각 수의 위. 넘으면 오래된 것부터 버린다. */
export const CONVERSATION_MAX_SEGMENTS = 200;

interface StoredSegment {
  role: TranscriptSegment["role"];
  text: string;
  mine: string;
  theirs: string;
  at: number;
}

interface StoredConversation {
  v: 1;
  segments: StoredSegment[];
}

/** 저장할 꼴: 글이 있는 조각만 최근 `CONVERSATION_MAX_SEGMENTS`개, 언어는 코드로. */
export function serializeConversation(segments: readonly TranscriptSegment[]): string {
  const stored: StoredConversation = {
    v: 1,
    segments: segments
      .filter((segment) => segment.text.trim())
      .slice(-CONVERSATION_MAX_SEGMENTS)
      .map(({ role, text, mine, theirs, at }) => ({ role, text, mine: mine.code, theirs: theirs.code, at })),
  };
  return JSON.stringify(stored);
}

/**
 * 저장한 대화를 전사 기록으로 되살린다. 되살린 조각은 끝난 턴이고 지난 통화(번호 0)의 것이다.
 * 망가진 값이면 빈 기록이다.
 */
export function restoreConversation(raw: string | null): TranscriptLog {
  const log = emptyTranscriptLog();
  if (!raw) return log;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return log;
  }
  if (!parsed || typeof parsed !== "object" || !("v" in parsed) || parsed.v !== 1 || !("segments" in parsed)) return log;
  const items = parsed.segments;
  if (!Array.isArray(items)) return log;
  const segments: TranscriptSegment[] = [];
  for (const item of items.slice(-CONVERSATION_MAX_SEGMENTS)) {
    if (!item || typeof item !== "object") continue;
    const { role, text, mine, theirs, at } = item as Record<string, unknown>;
    const pairMine = findTranslatorLanguage(mine);
    const pairTheirs = findTranslatorLanguage(theirs);
    if ((role !== "user" && role !== "assistant") || typeof text !== "string" || !text.trim() || !pairMine || !pairTheirs) continue;
    segments.push({
      id: segments.length,
      role,
      text,
      final: true,
      mine: pairMine,
      theirs: pairTheirs,
      call: 0,
      at: typeof at === "number" && Number.isFinite(at) ? at : 0,
      restored: true,
    });
  }
  return { ...log, segments, nextId: segments.length };
}

export interface ShareLabels {
  title: string;
  original: string;
  translation: string;
}

/**
 * 공유할 글: 제목 한 줄 뒤에 조각마다 「[시각] 원문(언어): 글」. 원문과 통역은 짝을 알 수 없으므로
 * 생긴 차례대로 그대로 적는다. `time`은 화면 언어의 시각 표기를 준다.
 */
export function formatConversation(
  segments: readonly TranscriptSegment[],
  labels: ShareLabels,
  time: (at: number) => string,
): string {
  const lines = segments
    .filter((segment) => segment.text.trim())
    .map((segment) => {
      const language: TranslatorLanguage | undefined = segmentLanguage(segment);
      const kind = segment.role === "assistant" ? labels.translation : labels.original;
      const head = language ? `${kind} (${language.nativeName})` : kind;
      const stamp = segment.at > 0 ? `[${time(segment.at)}] ` : "";
      return `${stamp}${head}: ${segment.text.trim()}`;
    });
  return [labels.title, "", ...lines].join("\n");
}
