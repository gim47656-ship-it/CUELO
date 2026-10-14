import { guessTranslatorLanguage, type TranslatorLanguage } from "@/lib/translator-languages";

/**
 * 통역 통화 전사로 만드는 말풍선 목록. 들은 말(user 전사)이 원문, 모델이 말한 것(assistant 전사)이
 * 통역이다. React 밖의 순수 함수라 기록한 실제 전사 순서를 그대로 다시 넣어 검사할 수 있다.
 */

export interface TranscriptEntry {
  id: number;
  /** 들은 말(사용자 전사). 모델이 먼저 말하기 시작하면 잠시 비어 있다. */
  original: string;
  /** 들은 말의 전사가 끝났는지(final). */
  heard: boolean;
  /** 모델이 말한 통역(assistant 전사). */
  translation: string;
  /** 이 말풍선이 생길 때의 통화 언어 짝. 나중에 언어를 바꿔도 자리가 바뀌지 않는다. */
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  /** 이 말풍선을 만든 통화 번호. 다른 통화의 전사는 이 말풍선을 채우지 않는다. */
  call: number;
}

export interface TranscriptUpdate {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface TranscriptLog {
  entries: TranscriptEntry[];
  /** 역할별로 아직 끝나지 않은 전사가 채우는 말풍선. final이 오면 비운다. */
  open: Record<TranscriptUpdate["role"], number | null>;
  nextId: number;
  /** 지금 전사를 받는 통화 번호. */
  call: number;
  /**
   * Codex가 통역 한 문장을 두 턴에 걸쳐 끊으면(「…정도 걸」 + 「려요. 두 번째…」) 앞 턴은 문장 끝 없이
   * 끝난다. 그다음 통역 턴이 끝날 때까지 기억한다: 첫 문장 조각을 붙일 앞 말풍선(`id`)과 그 원래
   * 통역(`base`), 나머지를 쓰는 말풍선(`rest`, 아직 없으면 `null`). 전사는 누적이라 매번 다시 나눈다.
   */
  carry: { id: number; base: string; rest: number | null } | null;
  /**
   * 끊긴 것으로 보이는 마지막 통역. 문장 끝 없이 끝났고 그때 이미 다음 사람의 말이 들어오고 있었다
   * (Codex가 다음 말 때문에 통역을 끊은 경우). 다음 통역 턴 하나만 이것을 이어 받는다. 다음 말이
   * 시작되기 전에 끝난 통역(「Well」)은 끊긴 게 아니라 원래 그렇게 끝난 말이다.
   */
  cutOff: { id: number; base: string } | null;
}

export function emptyTranscriptLog(): TranscriptLog {
  return { entries: [], open: { user: null, assistant: null }, nextId: 0, call: 0, carry: null, cutOff: null };
}

/**
 * 새 통화를 시작한다. 이전 통화의 말풍선은 그대로 두되, 새 통화의 전사는 그 말풍선을 채우지 않는다.
 * 언어를 바꿔 다시 연결하면 이전 통화에서 통역을 받지 못한 말이 남을 수 있는데, 새 통화의 첫 통역이
 * 거기 붙으면 다른 언어 짝의 말과 섞인다.
 */
export function beginTranscriptCall(log: TranscriptLog): TranscriptLog {
  return { ...log, open: { user: null, assistant: null }, call: log.call + 1, carry: null, cutOff: null };
}

/** 말풍선을 모두 지운다. 진행 중인 통화의 번호는 이어 쓴다. */
export function clearTranscripts(log: TranscriptLog): TranscriptLog {
  return { ...emptyTranscriptLog(), call: log.call };
}

/** 문장 끝 부호와 그 뒤의 닫는 따옴표·괄호. */
const SENTENCE_END = /[.!?。！？…]["'”’)\]」』]*/u;
const ENDS_SENTENCE = new RegExp(`${SENTENCE_END.source}$`, "u");
/** 새 통역 턴 첫머리에서 앞 말풍선으로 돌려 붙일 조각의 최대 길이. 더 길면 끊긴 조각이 아니라 새 문장이다. */
const CARRY_MAX_CHARS = 24;

/** 끊긴 첫 문장 조각과 나머지. 조각으로 보기에 길면 `null`이다. */
function splitCarried(text: string): { head: string; rest: string } | null {
  const end = SENTENCE_END.exec(text);
  const head = end ? text.slice(0, end.index + end[0].length) : text;
  if (head.length > CARRY_MAX_CHARS) return null;
  return { head, rest: text.slice(head.length).trim() };
}

/** 라틴 문자끼리 맞닿으면 단어 사이로 보고 띄운다. 한글·가나·태국 문자는 낱말 가운데서 끊긴다. */
function joinCarried(base: string, head: string): string {
  return spaceSentences(/[\p{Script=Latin}\d]$/u.test(base) && /^[\p{Script=Latin}\d]/u.test(head) ? `${base} ${head}` : base + head);
}

/**
 * Codex 전사는 문장 조각을 공백 없이 잇기도 한다(「걸려요.두 번째」). 마침표·물음표·느낌표 바로 뒤에
 * 대문자나 한글·가나 같은 글자가 오면 띄운다. 소수점·약어(「5.5」, 「e.g.」)는 그대로다.
 */
function spaceSentences(text: string): string {
  return text.replace(/([.!?])(?=[\p{Lu}\p{Lo}])/gu, "$1 ");
}

export function addTranscript(
  log: TranscriptLog,
  transcript: TranscriptUpdate,
  pair: { mine: TranslatorLanguage; theirs: TranslatorLanguage },
): TranscriptLog {
  if (transcript.role !== "assistant") return placeTranscript(log, transcript, pair);
  let carry = log.carry;
  if (carry === null && log.open.assistant === null && log.cutOff) carry = { ...log.cutOff, rest: null };
  if (carry === null) {
    if (!transcript.final) return placeTranscript(log, transcript, pair);
    // 통역이 끝났다. 문장 끝 없이 끝났고 그 뒤의 말이 이미 들어오고 있으면 끊긴 통역으로 남긴다.
    const placed = placeTranscript(log, { ...transcript, final: false }, pair);
    const id = placed.open.assistant;
    const entry = placed.entries.find((candidate) => candidate.id === id);
    const cut = entry !== undefined && !ENDS_SENTENCE.test(entry.translation.trimEnd())
      && placed.entries.some((later) => later.call === log.call && later.id > entry.id && later.original !== "");
    return { ...placed, open: { ...placed.open, assistant: null }, cutOff: cut ? { id: entry.id, base: entry.translation } : null };
  }
  const { id, base } = carry;
  let { rest } = carry;
  // 누적 전사가 고쳐질 수 있어 매 갱신마다 처음부터 나눈다. 조각이 아니면 앞 말풍선은 원래대로다.
  const split = splitCarried(transcript.text);
  const remainder = split ? split.rest : transcript.text;
  const translation = split ? joinCarried(base, split.head) : base;
  let next: TranscriptLog = { ...log, entries: log.entries.map((entry) => (entry.id === id ? { ...entry, translation } : entry)) };
  if (remainder) {
    // 나머지는 이 턴 동안 한 말풍선에만 쓴다. 처음이면 평소 규칙으로 고른다.
    next = placeTranscript({ ...next, open: { ...next.open, assistant: rest } }, { ...transcript, text: remainder, final: false }, pair);
    rest = next.open.assistant;
  } else if (rest !== null) {
    // 고쳐진 전사에 나머지가 없어졌다. 그 말풍선의 통역만 비운다(들은 말은 그대로).
    next = { ...next, entries: next.entries.map((entry) => (entry.id === rest ? { ...entry, translation: "" } : entry)) };
  }
  return {
    ...next,
    open: { ...next.open, assistant: transcript.final ? null : rest },
    carry: transcript.final ? null : { id, base, rest },
    cutOff: null,
  };
}

function placeTranscript(
  log: TranscriptLog,
  transcript: TranscriptUpdate,
  pair: { mine: TranslatorLanguage; theirs: TranslatorLanguage },
): TranscriptLog {
  let { entries, nextId } = log;
  const current = entries.filter((entry) => entry.call === log.call);
  let id = log.open[transcript.role];
  if (id === null) {
    if (transcript.role === "user") {
      // 들은 말의 전사가 늦게 와 모델이 먼저 말하기 시작했으면 원문이 빈 말풍선이 이미 있다.
      const last = current.at(-1);
      if (last && last.original === "") id = last.id;
    } else {
      // 모델은 들은 순서대로 옮긴다. 다음 말이 이미 들어오기 시작했어도 통역은 다 듣고 아직 옮기지
      // 않은 가장 최근 말의 것이다. 그런 말이 없으면(전사가 통역보다 늦게 끝나는 경우) 아직 옮기지
      // 않은 마지막 말에 붙인다.
      const untranslated = current.filter((entry) => entry.translation === "");
      id = (untranslated.findLast((entry) => entry.heard) ?? untranslated.at(-1))?.id ?? null;
    }
    if (id === null) {
      id = nextId++;
      entries = [...entries, { id, original: "", heard: false, translation: "", ...pair, call: log.call }];
    }
  }
  const text = spaceSentences(transcript.text);
  const update: Partial<TranscriptEntry> = transcript.role === "user"
    ? { original: text, heard: transcript.final }
    : { translation: text };
  entries = entries.map((entry) => (entry.id === id ? { ...entry, ...update } : entry));
  return { ...log, entries, nextId, open: { ...log.open, [transcript.role]: transcript.final ? null : id } };
}

/**
 * 말한 사람의 언어. 원문의 글자로 먼저 가르고, 원문으로 못 가르면 통역문이 어느 언어인지로 거꾸로
 * 정한다. 둘 다 못 가르면(같은 문자를 쓰는 짝에서 숫자·이름만 말한 경우 등) `undefined`이고 그
 * 말풍선은 상대 자리(왼쪽)에 둔다.
 */
export function spokenLanguage(entry: TranscriptEntry): TranslatorLanguage | undefined {
  const byOriginal = guessTranslatorLanguage(entry.original, entry.mine, entry.theirs);
  if (byOriginal) return byOriginal;
  const byTranslation = guessTranslatorLanguage(entry.translation, entry.mine, entry.theirs);
  if (!byTranslation) return undefined;
  return byTranslation === entry.mine ? entry.theirs : entry.mine;
}
