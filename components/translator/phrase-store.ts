/**
 * 자주 쓰는 문장. 상황별 기본 문장과 사용자가 더한 문장을 내 언어에서 상대 언어로 한 번 옮겨
 * 이 폰의 localStorage에 둔다. 데이터가 끊긴 곳에서도 옮겨 둔 문장은 바로 보여 주고 읽어 준다.
 */

export const PHRASEBOOK_KEY = "cuelo-translator-phrases";
/** 옮겨 둔 문장 수의 위. 넘으면 오래 전에 옮긴 것부터 버린다. */
export const PHRASE_CACHE_MAX = 400;
/** 사용자가 더하는 문장 수와 길이의 위. */
export const CUSTOM_PHRASE_MAX = 50;
export const CUSTOM_PHRASE_MAX_CHARS = 200;

export type PhraseGroupId = "food" | "restroom" | "payment" | "directions" | "emergency";

/** 기본 문장의 원문. 한국어와 영어로 둔다. 내 언어가 그 밖이면 기본 문장은 쓰지 않는다. */
export const BUILT_IN_PHRASES: Record<PhraseGroupId, { ko: string; en: string }[]> = {
  food: [
    { ko: "저는 땅콩 알레르기가 있어요.", en: "I'm allergic to peanuts." },
    { ko: "새우나 게 같은 갑각류는 못 먹어요.", en: "I can't eat shellfish like shrimp or crab." },
    { ko: "맵지 않게 해 주세요.", en: "Not spicy, please." },
    { ko: "고기는 빼 주실 수 있나요?", en: "Could you leave out the meat?" },
  ],
  restroom: [
    { ko: "화장실이 어디에 있나요?", en: "Where is the restroom?" },
    { ko: "화장실을 써도 될까요?", en: "May I use the restroom?" },
    { ko: "화장지가 없어요.", en: "There's no toilet paper." },
  ],
  payment: [
    { ko: "계산해 주세요.", en: "The bill, please." },
    { ko: "카드로 계산할 수 있나요?", en: "Can I pay by card?" },
    { ko: "영수증 주세요.", en: "Can I have a receipt?" },
    { ko: "따로 계산할게요.", en: "We'll pay separately." },
  ],
  directions: [
    { ko: "여기에 어떻게 가나요?", en: "How do I get here?" },
    { ko: "가장 가까운 지하철역이 어디예요?", en: "Where is the nearest subway station?" },
    { ko: "걸어서 얼마나 걸려요?", en: "How long does it take on foot?" },
    { ko: "이 주소로 가 주세요.", en: "Please take me to this address." },
  ],
  emergency: [
    { ko: "도와주세요!", en: "Help me, please!" },
    { ko: "구급차를 불러 주세요.", en: "Please call an ambulance." },
    { ko: "경찰을 불러 주세요.", en: "Please call the police." },
    { ko: "가장 가까운 병원이 어디예요?", en: "Where is the nearest hospital?" },
    { ko: "여권을 잃어버렸어요.", en: "I lost my passport." },
  ],
};

export const PHRASE_GROUPS = Object.keys(BUILT_IN_PHRASES) as PhraseGroupId[];

export interface CustomPhrase {
  id: string;
  text: string;
  /** 이 문장을 쓴 언어. 내 언어가 같을 때만 보인다. */
  lang: string;
}

export interface PhrasebookData {
  custom: CustomPhrase[];
  /** 옮긴 문장. 키는 `phraseCacheKey`, 넣은 차례가 오래된 차례다. */
  cache: Record<string, string>;
}

/** 옮겨 둔 결과의 키: 원문 언어·상대 언어·원문 글이 모두 같아야 같은 결과다. */
export function phraseCacheKey(text: string, mine: string, theirs: string): string {
  return `${mine}>${theirs}\u0000${text.trim()}`;
}

/** 내 언어에서 쓸 기본 문장 원문. 기본 문장이 없는 언어면 `null`. */
export function builtInText(phrase: { ko: string; en: string }, mine: string): string | null {
  return mine === "ko" ? phrase.ko : mine === "en" ? phrase.en : null;
}

export function readPhrasebook(raw: string | null): PhrasebookData {
  const empty: PhrasebookData = { custom: [], cache: {} };
  if (!raw) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return empty;
  }
  if (!parsed || typeof parsed !== "object") return empty;
  const custom: CustomPhrase[] = [];
  if ("custom" in parsed && Array.isArray(parsed.custom)) {
    for (const item of parsed.custom.slice(0, CUSTOM_PHRASE_MAX)) {
      if (!item || typeof item !== "object") continue;
      const { id, text, lang } = item as Record<string, unknown>;
      if (typeof id === "string" && typeof text === "string" && text.trim() && typeof lang === "string") {
        custom.push({ id, text: text.slice(0, CUSTOM_PHRASE_MAX_CHARS), lang });
      }
    }
  }
  const cache: Record<string, string> = {};
  if ("cache" in parsed && parsed.cache && typeof parsed.cache === "object") {
    for (const [key, value] of Object.entries(parsed.cache)) {
      if (typeof value === "string" && value.trim()) cache[key] = value;
    }
  }
  return { custom, cache: trimCache(cache) };
}

/** 오래 전에 넣은 결과부터 버려 `PHRASE_CACHE_MAX`개 안으로 줄인다. */
export function trimCache(cache: Record<string, string>): Record<string, string> {
  const entries = Object.entries(cache);
  return entries.length <= PHRASE_CACHE_MAX ? cache : Object.fromEntries(entries.slice(-PHRASE_CACHE_MAX));
}

/** 옮긴 결과 하나를 넣는다. 같은 키는 맨 뒤(가장 새것)로 옮긴다. */
export function withCached(data: PhrasebookData, key: string, translation: string): PhrasebookData {
  const cache = { ...data.cache };
  delete cache[key];
  cache[key] = translation;
  return { ...data, cache: trimCache(cache) };
}

/**
 * 동시에 `limit`개까지만 일을 돌리는 문지기. 「모두 미리 번역」과 문장 하나 누르기가 같은 문지기를
 * 거쳐, 어느 쪽에서 시작했든 번역 요청이 한꺼번에 `limit`개를 넘지 않는다. 끝난 일의 자리는 기다리던
 * 다음 일에 바로 넘긴다(자리가 빈 틈에 새 일이 끼어들지 못한다).
 */
export function createLimiter(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active < limit) active += 1;
    else {
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.push(resolve);
      await promise;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
