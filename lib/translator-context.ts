/**
 * 통역 통화에 함께 보내는 맥락: 대화 분위기, 내 성별·나이대, 상대의 성별·나와의 나이 관계, 앞선 대화. 화면이 만들고
 * `/api/live/interpret`가 그대로 믿지 않고 이 파일의 `parseInterpreterContext`로 다시 거른다.
 * 앞선 대화는 Codex가 무음으로 끊었거나 언어를 바꿔 새로 연결한 통화가 앞 맥락을 잇게 한다.
 */

/** 말투의 결(편하게·정중하게·격식)과 말투가 달라지는 두 목적(흥정·급함). 장소는 묻지 않는다. */
export const TRANSLATOR_MOODS = ["casual", "polite", "formal", "haggling", "urgent"] as const;
export type TranslatorMood = (typeof TRANSLATOR_MOODS)[number];

export const SPEAKER_GENDERS = ["male", "female"] as const;
export type SpeakerGender = (typeof SPEAKER_GENDERS)[number];

export const SPEAKER_AGES = ["20s", "30s", "40s", "50s", "60s"] as const;
export type SpeakerAge = (typeof SPEAKER_AGES)[number];

/**
 * 상대가 나보다 어린지·위인지. 베트남어 호칭이 갈리는 경계(em / anh·chị / cô·chú / bà·ông)에 맞춘다.
 * `younger`는 나보다 어리거나 비슷한 나이, `older`는 나보다 위지만 부모 세대는 아닌 나이다.
 */
export const PARTNER_AGES = ["child", "younger", "older", "parent", "grandparent"] as const;
export type PartnerAge = (typeof PARTNER_AGES)[number];

/** 내가 고른 설정. 고르지 않은 칸은 비운다. */
export interface InterpreterProfile {
  mood?: TranslatorMood;
  gender?: SpeakerGender;
  age?: SpeakerAge;
  /** 상대의 성별. */
  partnerGender?: SpeakerGender;
  /** 상대가 나와 비교해 어떤 나이인지. */
  partnerAge?: PartnerAge;
}

/**
 * 앞선 대화의 한 줄: 들은 말(`user`) 또는 모델이 옮겨 말한 것(`assistant`). 말해진 차례대로 두며
 * 원문과 통역을 서로 짝짓지 않는다. Codex·Gemini 라이브 모두 어느 통역이 어느 원문의 것인지 알려 주지
 * 않는다.
 */
export interface InterpreterLine {
  role: "user" | "assistant";
  text: string;
}

export interface InterpreterContext {
  profile: InterpreterProfile;
  history: InterpreterLine[];
}

/** 새 통화에 넘기는 앞선 대화의 최대 줄 수. 오래된 것부터 버린다. */
export const HISTORY_MAX_LINES = 24;
/** 한 줄 글의 최대 길이. 더 길면 뒤를 자른다. */
export const LINE_MAX_CHARS = 300;

export const EMPTY_INTERPRETER_CONTEXT: InterpreterContext = { profile: {}, history: [] };

const pick = <T extends string>(allowed: readonly T[], value: unknown): T | undefined =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

/**
 * 전사는 지시문 안의 태그 블록에 들어간다. 꺾쇠를 빼서 블록을 닫거나 새 태그를 여는 일이 없게 하고,
 * 줄바꿈을 한 칸으로 접어 앞선 대화 한 줄이 지시문에서도 한 줄로 남게 한다.
 */
function cleanLineText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, LINE_MAX_CHARS);
}

export function parseInterpreterProfile(value: unknown): InterpreterProfile {
  if (!value || typeof value !== "object") return {};
  const raw = value as Record<string, unknown>;
  const profile: InterpreterProfile = {};
  const mood = pick(TRANSLATOR_MOODS, raw.mood);
  const gender = pick(SPEAKER_GENDERS, raw.gender);
  const age = pick(SPEAKER_AGES, raw.age);
  const partnerGender = pick(SPEAKER_GENDERS, raw.partnerGender);
  const partnerAge = pick(PARTNER_AGES, raw.partnerAge);
  if (mood) profile.mood = mood;
  if (gender) profile.gender = gender;
  if (age) profile.age = age;
  if (partnerGender) profile.partnerGender = partnerGender;
  if (partnerAge) profile.partnerAge = partnerAge;
  return profile;
}

/**
 * 요청 본문의 `context`를 거른다. 모르는 값은 버리고, 앞선 대화는 최근 줄만 남긴다. 이전 화면이
 * 보내는 짝 모양(`{ speaker, original, translation }`)은 들은 말과 통역 두 줄로 풀어 글만 살린다.
 */
export function parseInterpreterContext(value: unknown): InterpreterContext {
  if (!value || typeof value !== "object") return EMPTY_INTERPRETER_CONTEXT;
  const raw = value as Record<string, unknown>;
  const history: InterpreterLine[] = [];
  const push = (role: InterpreterLine["role"], text: unknown) => {
    const clean = cleanLineText(text);
    if (clean) history.push({ role, text: clean });
  };
  if (Array.isArray(raw.history)) {
    for (const item of raw.history) {
      if (!item || typeof item !== "object") continue;
      const line = item as Record<string, unknown>;
      if (line.role === "user" || line.role === "assistant") {
        push(line.role, line.text);
      } else if (line.speaker === "me" || line.speaker === "them") {
        push("user", line.original);
        push("assistant", line.translation);
      }
    }
  }
  return { profile: parseInterpreterProfile(raw.profile), history: history.slice(-HISTORY_MAX_LINES) };
}
