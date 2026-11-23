import { expect, test } from "bun:test";
import { findTranslatorLanguage } from "../translator-languages";
import { guardVoiceTranslation, wrongVoiceLanguage } from "./output-language";
import type { InterpreterTextEvent } from "../translator-context";
const language = (code: string) => findTranslatorLanguage(code)!;

test("the observed Japanese answer with a Korean closing is rejected for a Korean target", () => {
  expect(wrongVoiceLanguage("辛くしないでください。감사합니다.", language("ja"), language("ko"))).toBe(true);
});
test("all seven target scripts accept translated speech and reject the Korean source", () => {
  const values = { en: "Do not add peanuts.", vi: "Không cho đậu phộng.", ja: "ピーナッツを入れないでください。", th: "ไม่ใส่ถั่วลิสง", zh: "请不要放花生。", "zh-tw": "請不要放花生。" };
  for (const [target, text] of Object.entries(values)) {
    expect(wrongVoiceLanguage(text, language("ko"), language(target))).toBe(false);
    expect(wrongVoiceLanguage("땅콩은 넣지 마세요.", language("ko"), language(target))).toBe(true);
  }
  expect(wrongVoiceLanguage("땅콩은 넣지 마세요.", language("en"), language("ko"))).toBe(false);
});
test("numbers, names and genuinely shared short Latin or Han text remain ambiguous", () => {
  for (const text of ["1,200", "USD 10", "Uber"]) expect(wrongVoiceLanguage(text, language("ko"), language("ja"))).toBe(false);
  for (const text of ["Hilton", "New York", "USD 10"]) expect(wrongVoiceLanguage(text, language("en"), language("vi"))).toBe(false);
  expect(wrongVoiceLanguage("東京", language("zh"), language("ja"))).toBe(false);
  expect(wrongVoiceLanguage("東京", language("zh-tw"), language("ja"))).toBe(false);
  expect(wrongVoiceLanguage("Xin cảm ơn.", language("vi"), language("en"))).toBe(true);
});
test("a wrong prefix stops the first attempt before completion and retries only once", async () => {
  const calls: boolean[] = []; let returned = false;
  const attempt = async function* (retry: boolean): AsyncGenerator<InterpreterTextEvent> {
    calls.push(retry);
    try {
      if (!retry) { yield { type: "delta", text: "辛くしないでください。감사합니다." }; throw new Error("wrong prefix was not stopped"); }
      yield { type: "delta", text: "맵지 않게 해 주세요. 감사합니다." };
      yield { type: "done", text: "맵지 않게 해 주세요. 감사합니다.", source: "ja", target: "ko" };
    } finally { if (!retry) returned = true; }
  };
  const events = [];
  for await (const event of guardVoiceTranslation(attempt, language("ja"), language("ko"))) events.push(event);
  expect(calls).toEqual([false, true]); expect(returned).toBe(true);
  expect(events.every(event => !("text" in event) || !/[ぁ-ヺ]/u.test(event.text))).toBe(true);
});
test("a short wrong answer is judged at done, not emitted below the prefix threshold", async () => {
  const attempt = async function* (retry: boolean): AsyncGenerator<InterpreterTextEvent> {
    const text = retry ? "네." : "はい。";
    yield { type: "delta", text }; yield { type: "done", text, source: "ja", target: "ko" };
  };
  const events = [];
  for await (const event of guardVoiceTranslation(attempt, language("ja"), language("ko"))) events.push(event);
  expect(events).toEqual([{ type: "delta", text: "네." }, { type: "done", text: "네.", source: "ja", target: "ko" }]);
});

test("a later wrong-language continuation is not appended and the retry replaces the accepted prefix", async () => {
  const prefix = "맵지 않게 해 주세요. 감사합니다.";
  const wrong = "辛くしないでください。もう一度お願いします。どうもありがとうございます。";
  const attempt = async function* (retry: boolean): AsyncGenerator<InterpreterTextEvent> {
    yield { type: "delta", text: prefix };
    if (!retry) yield { type: "delta", text: wrong };
    yield { type: "done", text: retry ? prefix : prefix + wrong, source: "ja", target: "ko" };
  };
  const events = [];
  for await (const event of guardVoiceTranslation(attempt, language("ja"), language("ko"))) events.push(event);
  expect(events).toEqual([{ type: "delta", text: prefix }, { type: "done", text: prefix, source: "ja", target: "ko" }]);
});
test("upstream/auth exceptions are propagated without a language retry", async () => {
  let calls = 0;
  const attempt = async function* (): AsyncGenerator<InterpreterTextEvent> { calls++; throw new Error("auth"); };
  const consume = async () => { for await (const event of guardVoiceTranslation(attempt, language("ja"), language("ko"))) void event; };
  await expect(consume()).rejects.toThrow("auth");
  expect(calls).toBe(1);
});
