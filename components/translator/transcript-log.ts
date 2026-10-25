import { guessTranslatorLanguage, type TranslatorLanguage } from "@/lib/translator-languages";
import type { InterpreterLine } from "@/lib/translator-context";

/**
 * 통역 통화 전사의 두 흐름. 들은 말(user 전사)과 모델이 옮겨 말한 것(assistant 전사)을 턴마다 한
 * 조각으로 따로 쌓는다. Codex·Gemini 라이브 모두 어느 통역이 어느 원문의 것인지 알려 주지 않으므로
 * 원문과 통역을 짝짓지 않고, 서로 다른 턴을 하나로 합치지도 않는다. React 밖의 순수 함수라 기록한
 * 실제 전사 순서를 그대로 다시 넣어 검사할 수 있다.
 */

export type TranscriptRole = InterpreterLine["role"];

export interface TranscriptSegment {
  /** 두 흐름을 통틀어 생긴 차례. 마주보기 화면은 이 차례로 두 흐름을 섞는다. */
  id: number;
  role: TranscriptRole;
  /** 그 턴의 지금까지 글. 전사는 누적이라 갱신마다 통째로 바뀐다. */
  text: string;
  /** 그 턴의 전사가 끝났는지(final). */
  final: boolean;
  /** 이 조각이 생길 때의 통화 언어 짝. 나중에 언어를 바꿔도 이 조각의 언어 판별은 그대로다. */
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  /** 이 조각을 만든 통화 번호. 다른 통화의 전사는 이 조각을 이어 쓰지 않는다. */
  call: number;
}

export interface TranscriptUpdate {
  role: TranscriptRole;
  text: string;
  final: boolean;
}

export interface TranscriptLog {
  segments: TranscriptSegment[];
  /** 역할별로 아직 끝나지 않은 턴이 쓰는 조각. final이 오면 비운다. */
  open: Record<TranscriptRole, number | null>;
  nextId: number;
  /** 지금 전사를 받는 통화 번호. */
  call: number;
}

export function emptyTranscriptLog(): TranscriptLog {
  return { segments: [], open: { user: null, assistant: null }, nextId: 0, call: 0 };
}

/** 새 통화를 시작한다. 이전 통화의 조각은 남기되, 끝나지 않은 턴을 새 통화가 이어 쓰지 않는다. */
export function beginTranscriptCall(log: TranscriptLog): TranscriptLog {
  return { ...log, open: { user: null, assistant: null }, call: log.call + 1 };
}

/**
 * 조각을 모두 지운다. 진행 중인 통화의 번호와 조각 id는 이어 쓴다. 멈춘 턴을 id로 기억하는 쪽
 * (`useInterpreterCall`)이 있어, 지운 뒤의 새 조각이 옛 id를 다시 쓰면 안 된다.
 */
export function clearTranscripts(log: TranscriptLog): TranscriptLog {
  return { ...emptyTranscriptLog(), call: log.call, nextId: log.nextId };
}

/**
 * Codex 전사는 문장 조각을 공백 없이 잇기도 한다(「걸려요.두 번째」). 마침표·물음표·느낌표 바로 뒤에
 * 대문자나 한글·가나 같은 글자가 오면 띄운다. 소수점·약어(「5.5」, 「e.g.」)는 그대로다.
 */
function spaceSentences(text: string): string {
  return text.replace(/([.!?])(?=[\p{Lu}\p{Lo}])/gu, "$1 ");
}

/** 전사 하나를 그 역할의 열린 턴에 쓴다. 열린 턴이 없으면 새 조각을 연다. */
export function addTranscript(
  log: TranscriptLog,
  transcript: TranscriptUpdate,
  pair: { mine: TranslatorLanguage; theirs: TranslatorLanguage },
): TranscriptLog {
  const text = spaceSentences(transcript.text);
  let { segments, nextId } = log;
  let id = log.open[transcript.role];
  if (id === null) {
    if (!text.trim()) return log;
    id = nextId++;
    segments = [...segments, { id, role: transcript.role, text, final: transcript.final, ...pair, call: log.call }];
  } else {
    segments = segments.map((segment) => (segment.id === id ? { ...segment, text, final: transcript.final } : segment));
  }
  return { ...log, segments, nextId, open: { ...log.open, [transcript.role]: transcript.final ? null : id } };
}

/**
 * 조각 글의 언어. 그 조각의 글자로만 가른다(다른 흐름의 글로 짐작하지 않는다). 같은 문자를 쓰는 짝에서
 * 숫자·이름만 말했으면 `undefined`다.
 */
export function segmentLanguage(segment: TranscriptSegment): TranslatorLanguage | undefined {
  return guessTranslatorLanguage(segment.text, segment.mine, segment.theirs);
}

/**
 * 그 조각을 낳은 사람. 들은 말은 그 언어로 말한 사람이고, 통역은 반대쪽 사람의 말을 옮긴 것이다.
 * 언어를 모르면 `undefined`다.
 */
export function segmentSpeaker(segment: TranscriptSegment): "me" | "them" | undefined {
  const language = segmentLanguage(segment);
  if (!language) return undefined;
  const mineLanguage = language.code === segment.mine.code;
  return (segment.role === "user") === mineLanguage ? "me" : "them";
}

/** A history line with the id of the segment it came from, so one turn can be told from the same words said again. */
export interface HistoryLine extends InterpreterLine {
  id: number;
}

/** 새 통화에 넘길 앞선 대화: 글이 있는 조각을 말해진 차례대로 조각 id·역할·글만 남겨 최근 `max`줄. 서버는 id를 버린다. */
export function transcriptHistory(log: TranscriptLog, max: number): HistoryLine[] {
  return log.segments
    .filter((segment) => segment.text.trim())
    .slice(-max)
    .map(({ id, role, text }) => ({ id, role, text }));
}
