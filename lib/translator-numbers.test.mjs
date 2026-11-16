import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { splitNumberSpans, hasNumericMismatch } = await jiti.import("./translator-numbers.ts");

const numbers = (text) => splitNumberSpans(text).filter((span) => span.number).map((span) => span.text);

test("a number is marked together with the unit or currency attached to it", () => {
  assert.deepEqual(numbers("합계 125,000동입니다. 전화는 010-0000-0000예요."), ["125,000동", "010-0000-0000"]);
  assert.deepEqual(numbers("택시 요금은 45만 동이고 87.5위안은 따로예요."), ["45만 동", "87.5위안"]);
  assert.deepEqual(numbers("Cho em 50k nhé, còn cái kia 50 nghìn đồng."), ["50k", "50 nghìn đồng"]);
  assert.deepEqual(numbers("체크인은 오후 2시부터, 조식은 2층이에요."), ["2시", "2층"]);
  assert.deepEqual(numbers("합계 12만 5천 동이고 망고 2 kg 주세요."), ["12만 5천 동", "2 kg"]);
  assert.deepEqual(numbers("Total $47.50, or 125₫, 50€ and ₩3000."), ["$47.50", "125₫", "50€", "₩3000"]);
});

test("text without digits stays whole and every character survives the split", () => {
  assert.deepEqual(splitNumberSpans("năm mươi nghìn đồng"), [{ text: "năm mươi nghìn đồng", number: false }]);
  const text = "약 8%, 1,200개를 11월 25일까지. 전화는 010 0000 0000.";
  assert.equal(splitNumberSpans(text).map((span) => span.text).join(""), text);
  assert.deepEqual(numbers(text), ["8%", "1,200개", "11월", "25일", "010", "0000", "0000"]);
});

test("digit value mismatches are flagged without treating formatting as a change", () => {
  assert.equal(hasNumericMismatch("500엔", "5000円"), true);
  assert.equal(hasNumericMismatch("500", "5000"), true);
  assert.equal(hasNumericMismatch("1,000", "1000"), false);
  assert.equal(hasNumericMismatch("３", "3"), false);
  assert.equal(hasNumericMismatch("1,000원", "1000ウォン"), false);
  assert.equal(hasNumericMismatch("３개", "3つ"), false);
  assert.equal(hasNumericMismatch("두 개", "2つ"), false);
  assert.equal(hasNumericMismatch("500원, 2개", "2つ、500ウォン"), false);
  assert.equal(hasNumericMismatch("2개, 500원", "3つ、5000ウォン"), true);
  assert.equal(hasNumericMismatch("2026-11-16", "2026/11/16"), false);
});

test("ambiguous separators, word-only values and scaled digits are left to the model", () => {
  assert.equal(hasNumericMismatch("5만 원", "50000ウォン"), false);
  assert.equal(hasNumericMismatch("50 nghìn đồng", "50000동"), false);
  assert.equal(hasNumericMismatch("1.000원", "1000ウォン"), false);
  assert.equal(hasNumericMismatch("1,50유로", "1.50 euros"), false);
  assert.equal(hasNumericMismatch("오백 엔", "五百円"), false);
  assert.equal(hasNumericMismatch("3.50유로", "3.50 euros"), false);
  assert.equal(hasNumericMismatch("2명, 7시", "二人、7時"), false);
  assert.equal(hasNumericMismatch("11월 25일", "November 25"), false);
  assert.equal(hasNumericMismatch("오후 2시", "14h"), false);
  assert.equal(hasNumericMismatch("5 พัน", "5000"), false);
  assert.equal(hasNumericMismatch("1.15달러", "11.50 dollars"), true);
  assert.equal(hasNumericMismatch("19.99달러", "19.99 dollars"), false);
  assert.equal(hasNumericMismatch("15시에 만나요", "Let's meet at 3pm."), false);
  assert.equal(hasNumericMismatch("2 people on March 5", "3월 5일에 두 명"), false);
  assert.equal(hasNumericMismatch("two apples and 3 oranges", "2 apples and three oranges"), false);
  assert.equal(hasNumericMismatch("2 hundred", "200"), false);
  assert.equal(hasNumericMismatch("1조", "1,000,000,000,000"), false);
});

test("mixed written counts, currency scales and ranges remain model-only", () => {
  for (const [original, translated] of [
    ["大人2人、子供1人", "어른 2명, 아이 한 명"],
    ["1個と10個", "한 개와 10개"],
    ["¥5万", "¥50,000"], ["₩3만", "₩30,000"],
    ["3-5", "3 - 5"], ["010-1234-5678", "010 1234 5678"],
    ["2026-04-12", "2026 04 12"], ["500원-1000원", "500ウォン〜1000ウォン"],
  ]) assert.equal(hasNumericMismatch(original, translated), false);
});
