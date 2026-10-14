import { describe, expect, test } from "bun:test";
import { addTranscript, beginTranscriptCall, clearTranscripts, emptyTranscriptLog, spokenLanguage } from "./transcript-log.ts";
import { findTranslatorLanguage } from "../../lib/translator-languages.ts";

const pair = { mine: findTranslatorLanguage("ko"), theirs: findTranslatorLanguage("vi") };

/** `[role, text, final]` 순서를 그대로 넣는다. */
function replayLog(events, log = emptyTranscriptLog(), languages = pair) {
  for (const [role, text, final] of events) log = addTranscript(log, { role: role === "u" ? "user" : "assistant", text, final: final === 1 }, languages);
  return log;
}

const replay = (events) => replayLog(events).entries;
const bubbles = (log) => log.entries.map((e) => [e.original, e.translation]);

describe("interpreter transcript log", () => {
  test("pairs a live ko→vi exchange where the translation starts before the utterance's transcript ends", () => {
    // 2026-10-14 dev:verify 실통화 기록(api-smoke-2)에서 줄인 순서. 모델이 첫 문장을 옮기는 동안
    // 다음 문장 전사가 시작되고, 둘째 통역은 둘째 문장 전사가 final이 되기 전에 시작된다.
    const entries = replay([
      ["u", "안", 0], ["u", "안녕하세요", 0], ["a", "Xin ch", 0], ["u", "안녕하세요.", 0], ["a", "Xin chào.", 0],
      ["u", "안녕하세요.", 1], ["u", "근처", 0], ["a", "Xin chào.", 1], ["u", "근처에 맛있는", 0],
      ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요", 0], ["a", "Ở gần", 0], ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요?", 0],
      ["a", "Ở gần đây có quán phở ngon", 0], ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요?", 1],
      ["a", "Ở gần đây có quán phở ngon nào không?", 0], ["a", "Ở gần đây có quán phở ngon nào không?", 1],
    ]);
    expect(entries.map((e) => [e.original, e.translation])).toEqual([
      ["안녕하세요.", "Xin chào."],
      ["근처에 맛있는 쌀국수 집이 어디에 있나요?", "Ở gần đây có quán phở ngon nào không?"],
    ]);
    expect(entries.every((e) => e.heard)).toBe(true);
  });

  test("gives a translation to the finished utterance even after the next one started", () => {
    // 같은 날 앱 화면 실행에서 본 순서: 첫 문장 전사가 끝나고 둘째 문장이 거의 끝날 때 첫 통역이 왔다.
    const entries = replay([
      ["u", "안녕하세요", 1], ["u", "근", 0], ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요", 0],
      ["a", "Xin ch", 0], ["a", "Xin chào.", 1], ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요", 1],
      ["a", "Ở gần đây có quán phở nào ngon không?", 1],
    ]);
    expect(entries.map((e) => [e.original, e.translation])).toEqual([
      ["안녕하세요", "Xin chào."],
      ["근처에 맛있는 쌀국수 집이 어디에 있나요", "Ở gần đây có quán phở nào ngon không?"],
    ]);
  });

  test("lets a late utterance transcript fill the bubble its translation opened", () => {
    const entries = replay([["a", "Xin chào.", 1], ["u", "안녕하세요", 1]]);
    expect(entries.map((e) => [e.original, e.translation])).toEqual([["안녕하세요", "Xin chào."]]);
  });

  test("skips a finished utterance the model left untranslated", () => {
    const entries = replay([["u", "음", 1], ["u", "감사합니다", 1], ["a", "Cảm ơn.", 1]]);
    expect(entries.map((e) => [e.original, e.translation])).toEqual([["음", ""], ["감사합니다", "Cảm ơn."]]);
  });

  test("places each bubble by the language that was spoken", () => {
    const [mineSpoke, theirsSpoke, unknown] = replay([
      ["u", "안녕하세요", 1], ["a", "Xin chào.", 1],
      ["u", "Cảm ơn bạn", 1], ["a", "고마워요", 1],
      ["u", "123", 1], ["a", "123", 1],
    ]);
    expect(spokenLanguage(mineSpoke)?.code).toBe("ko");
    expect(spokenLanguage(theirsSpoke)?.code).toBe("vi");
    expect(spokenLanguage(unknown)).toBeUndefined();
  });

  test("a reconnected call never fills a bubble left untranslated by the previous call", () => {
    // ko↔vi 통화에서 들은 말 하나가 통역을 받기 전에 언어를 ko↔en으로 바꿔 다시 연결했다.
    let log = replayLog([["u", "안녕하세요", 1]], beginTranscriptCall(emptyTranscriptLog()));
    log = beginTranscriptCall(log);
    const english = { mine: findTranslatorLanguage("ko"), theirs: findTranslatorLanguage("en") };
    log = replayLog([["a", "Hello.", 1], ["u", "안녕", 1]], log, english);
    expect(bubbles(log)).toEqual([["안녕하세요", ""], ["안녕", "Hello."]]);
    expect(log.entries.map((e) => [e.call, e.theirs.code])).toEqual([[1, "vi"], [2, "en"]]);
  });

  test("clearing keeps the running call's number", () => {
    const log = clearTranscripts(beginTranscriptCall(beginTranscriptCall(emptyTranscriptLog())));
    expect(log.call).toBe(2);
    expect(replayLog([["u", "네", 1]], log).entries[0].call).toBe(2);
  });
});
