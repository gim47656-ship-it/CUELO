/**
 * 통역 자막에서 숫자와 거기 붙은 단위(`125,000동`, `010-4821-7359`, `5만 동`, `50 nghìn đồng`)를 찾아
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
