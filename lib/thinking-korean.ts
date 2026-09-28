/** Latin letters needed before a thinking block is worth a translation request. */
const MIN_LATIN_LETTERS = 40;
/** Blocks at or above this Hangul share are already Korean enough to show as-is. */
const KOREAN_SHARE = 0.3;

function letterCounts(text: string): { latin: number; hangul: number } {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ");
  return {
    latin: prose.match(/[A-Za-z]/g)?.length ?? 0,
    hangul: prose.match(/[\uAC00-\uD7A3]/g)?.length ?? 0,
  };
}

/**
 * Whether a thinking block is written in Korean — in practice a progress sentence addressed to the
 * user rather than the model's monologue. Decided from the first Hangul, so a streaming block does
 * not flip between folded and open as it grows. Code, inline literals and URLs are ignored.
 */
export function isKoreanThinking(text: string): boolean {
  const { latin, hangul } = letterCounts(text);
  return hangul > 0 && hangul / (hangul + latin) >= KOREAN_SHARE;
}

/**
 * Whether a finished thinking block reads as English and should be shown in Korean.
 * Code, inline literals and URLs are ignored so a Korean block full of identifiers stays as-is.
 */
export function needsKoreanTranslation(text: string): boolean {
  const { latin, hangul } = letterCounts(text);
  if (latin < MIN_LATIN_LETTERS) return false;
  return hangul / (hangul + latin) < KOREAN_SHARE;
}
