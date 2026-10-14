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
}

export function emptyTranscriptLog(): TranscriptLog {
  return { entries: [], open: { user: null, assistant: null }, nextId: 0, call: 0 };
}

/**
 * 새 통화를 시작한다. 이전 통화의 말풍선은 그대로 두되, 새 통화의 전사는 그 말풍선을 채우지 않는다.
 * 언어를 바꿔 다시 연결하면 이전 통화에서 통역을 받지 못한 말이 남을 수 있는데, 새 통화의 첫 통역이
 * 거기 붙으면 다른 언어 짝의 말과 섞인다.
 */
export function beginTranscriptCall(log: TranscriptLog): TranscriptLog {
  return { ...log, open: { user: null, assistant: null }, call: log.call + 1 };
}

/** 말풍선을 모두 지운다. 진행 중인 통화의 번호는 이어 쓴다. */
export function clearTranscripts(log: TranscriptLog): TranscriptLog {
  return { ...emptyTranscriptLog(), call: log.call };
}

export function addTranscript(
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
  const update: Partial<TranscriptEntry> = transcript.role === "user"
    ? { original: transcript.text, heard: transcript.final }
    : { translation: transcript.text };
  entries = entries.map((entry) => (entry.id === id ? { ...entry, ...update } : entry));
  return { entries, nextId, call: log.call, open: { ...log.open, [transcript.role]: transcript.final ? null : id } };
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
