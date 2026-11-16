/**
 * 통역 자막에서 숫자와 거기 붙은 단위(`125,000동`, `010-0000-0000`, `5만 동`, `50 nghìn đồng`)를 찾아
 * 눈에 띄게 그릴 조각으로 나눈다. 받아쓰기가 숫자를 틀리게 들었을 때 사용자가 바로 확인하게 하는
 * 표시일 뿐이며 값을 고치거나 해석하지 않는다.
 */
const NUM = String.raw`\d(?:[\d,.:/-]*\d)?`;
const MULT = String.raw`(?:[kK](?![A-Za-z])|%|만|억|천|백)`;
const UNIT = String.raw`(?:원|동|위안|달러|엔|바트|đồng|nghìn|ngàn|triệu|tỷ|VND|[$€£¥₩₫]|개|명|시|분|번|층|년|월|일|(?:kg|km|cm|ml|g|m)(?![A-Za-z]))`;
/** `$125.00`·`€50`처럼 숫자 앞에 붙는 통화 기호(뒤에 붙는 기호는 UNIT이 받는다). */
const PREFIX = String.raw`[$€£¥₩₫]?`;
/** `12만 5천 동`처럼 배수 단위로 이어지는 금액은 한 덩어리로 묶는다. */
const NUMBER_RUN = new RegExp(`${PREFIX}${NUM}(?:\\s?${MULT})*(?:\\s?${NUM}(?:\\s?${MULT})+)*(?:\\s?${UNIT}){0,2}`, "gu");

export interface NumberSpan {
  text: string;
  number: boolean;
}

export function splitNumberSpans(text: string): NumberSpan[] {
  const spans: NumberSpan[] = [];
  let last = 0;
  for (const match of text.matchAll(NUMBER_RUN)) {
    const start = match.index ?? 0;
    if (start > last) spans.push({ text: text.slice(last, start), number: false });
    spans.push({ text: match[0], number: true });
    last = start + match[0].length;
  }
  if (last < text.length) spans.push({ text: text.slice(last), number: false });
  return spans;
}

/**
 * Only numeric-only lines and matching explicit currency/quantity facts are confident.
 * Dates, times, written numerals, scales and unknown units stay with the model.
 */
export function hasNumericMismatch(original: string, translation: string): boolean {
  const aliases: Record<string, string> = {
    "¥": "yen", "円": "yen", "엔": "yen", "JPY": "yen",
    "₩": "won", "원": "won", "ウォン": "won", "KRW": "won",
    "$": "dollar", "달러": "dollar", "USD": "dollar", "dollars": "dollar",
    "€": "euro", "유로": "euro", "EUR": "euro", "euros": "euro",
    "₫": "dong", "동": "dong", "đồng": "dong", "VND": "dong",
    "개": "quantity", "つ": "quantity", "個": "quantity", "pieces": "quantity",
    "명": "people", "人": "people",
  };
  const facts: Map<string, Set<number>>[] = [];
  for (const text of [original, translation]) {
    const normalized = text.normalize("NFKC");
    if (/\d[^\d\s]*\s*[-/〜~–—]\s*\d/u.test(normalized)) return false;
    const numericOnly = /^[\s\d.,+-]+$/.test(normalized);
    const found = new Map<string, Set<number>>();
    for (const match of normalized.matchAll(/([$€¥₩₫])?\s*([+-]?\d+(?:[.,]\d+)*)\s*(円|엔|JPY|원|ウォン|KRW|달러|USD|dollars|유로|EUR|euros|동|đồng|VND|개|つ|個|pieces|명|人)?/gu)) {
      const token = match[2];
      if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(token)) return false;
      const value = Number(token.replaceAll(",", ""));
      if (!Number.isSafeInteger(Math.round(value * 100))) return false;
      const unit = numericOnly ? "digits" : aliases[match[3] || match[1]];
      if (match[1] && !match[3] && /^\s*\p{L}/u.test(normalized.slice((match.index ?? 0) + match[0].length))) return false;
      // Unknown numeric facts prevent a partial comparison from claiming certainty.
      if (!unit) return false;
      if (!found.has(unit)) found.set(unit, new Set());
      found.get(unit)!.add(value);
    }
    if (!found.size) return false;
    facts.push(found);
  }
  for (const [unit, values] of facts[0]) {
    const other = facts[1].get(unit);
    // Missing digit facts may be rendered as words; compare only equal-size fact sets.
    if (other && values.size === other.size && [...values].some((value) => !other.has(value))) return true;
  }
  return false;
}
