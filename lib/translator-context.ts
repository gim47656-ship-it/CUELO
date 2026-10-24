/**
 * 통역 통화에 함께 보내는 맥락: 대화 장소(상황), 내 성별·나이대, 앞선 대화. 화면이 만들고
 * `/api/live/interpret`가 그대로 믿지 않고 이 파일의 `parseInterpreterContext`로 다시 거른다.
 * 앞선 대화는 Codex가 무음으로 끊었거나 언어를 바꿔 새로 연결한 통화가 앞 맥락을 잇게 한다.
 */

export const TRANSLATOR_SITUATIONS = [
  "restaurant",
  "transport",
  "hotel",
  "shopping",
  "medical",
  "directions",
  "business",
] as const;
export type TranslatorSituation = (typeof TRANSLATOR_SITUATIONS)[number];

export const SPEAKER_GENDERS = ["male", "female"] as const;
export type SpeakerGender = (typeof SPEAKER_GENDERS)[number];

export const SPEAKER_AGES = ["20s", "30s", "40s", "50s", "60s"] as const;
export type SpeakerAge = (typeof SPEAKER_AGES)[number];

/** 내가 고른 설정. 고르지 않은 칸은 비운다. */
export interface InterpreterProfile {
  situation?: TranslatorSituation;
  gender?: SpeakerGender;
  age?: SpeakerAge;
}

/** 앞선 대화 한 차례: 누가 말했는지, 들은 말, 통역한 말. */
export interface InterpreterTurn {
  speaker: "me" | "them";
  original: string;
  translation: string;
}

export interface InterpreterContext {
  profile: InterpreterProfile;
  history: InterpreterTurn[];
}

/** 새 통화에 넘기는 앞선 대화의 최대 차례 수. 오래된 것부터 버린다. */
export const HISTORY_MAX_TURNS = 12;
/** 한 차례 글의 최대 길이. 더 길면 뒤를 자른다. */
export const TURN_MAX_CHARS = 300;

export const EMPTY_INTERPRETER_CONTEXT: InterpreterContext = { profile: {}, history: [] };

const pick = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/**
 * 전사는 지시문 안의 태그 블록에 들어간다. 꺾쇠를 빼서 블록을 닫거나 새 태그를 여는 일이 없게 하고,
 * 줄바꿈을 한 칸으로 접어 한 차례가 한 줄에 머물게 한다.
 */
function cleanTurnText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, TURN_MAX_CHARS);
}

export function parseInterpreterProfile(value: unknown): InterpreterProfile {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const profile: InterpreterProfile = {};
  const situation = pick(TRANSLATOR_SITUATIONS, raw.situation);
  const gender = pick(SPEAKER_GENDERS, raw.gender);
  const age = pick(SPEAKER_AGES, raw.age);
  if (situation) profile.situation = situation;
  if (gender) profile.gender = gender;
  if (age) profile.age = age;
  return profile;
}

/** 요청 본문의 `context`를 거른다. 모르는 값은 버리고, 앞선 대화는 최근 것만 남긴다. */
export function parseInterpreterContext(value: unknown): InterpreterContext {
  if (!value || typeof value !== "object") return EMPTY_INTERPRETER_CONTEXT;
  const raw = value as Record<string, unknown>;
  const history: InterpreterTurn[] = [];
  if (Array.isArray(raw.history)) {
    for (const item of raw.history) {
      if (!item || typeof item !== "object") continue;
      const turn = item as Record<string, unknown>;
      if (turn.speaker !== "me" && turn.speaker !== "them") continue;
      const original = cleanTurnText(turn.original);
      const translation = cleanTurnText(turn.translation);
      if (!original && !translation) continue;
      history.push({ speaker: turn.speaker, original, translation });
    }
  }
  return { profile: parseInterpreterProfile(raw.profile), history: history.slice(-HISTORY_MAX_TURNS) };
}
