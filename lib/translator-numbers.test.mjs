import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { splitNumberSpans } = await jiti.import("./translator-numbers.ts");

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
