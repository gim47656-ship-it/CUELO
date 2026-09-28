/** Latin letters needed before a thinking block is worth a translation request. */
const MIN_LATIN_LETTERS = 40;
/** Blocks at or above this Hangul share are already Korean enough to show as-is. */
const KOREAN_SHARE = 0.3;

/**
 * Whether a finished thinking block reads as English and should be shown in Korean.
 * Code, inline literals and URLs are ignored so a Korean block full of identifiers stays as-is.
 */
export function needsKoreanTranslation(text: string): boolean {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/gi, " ");
  const latin = prose.match(/[A-Za-z]/g)?.length ?? 0;
  if (latin < MIN_LATIN_LETTERS) return false;
  const hangul = prose.match(/[\uAC00-\uD7A3]/g)?.length ?? 0;
  return hangul / (hangul + latin) < KOREAN_SHARE;
}
