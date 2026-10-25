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
    const entries = replay([["a", "Xin ch", 0], ["u", "안녕하세요", 1], ["a", "Xin chào.", 1]]);
    expect(entries.map((e) => [e.original, e.translation])).toEqual([["안녕하세요", "Xin chào."]]);
  });

  test("keeps later pairs aligned when one utterance's transcript never arrives", () => {
    // 2026-10-25 폰 실기기 통역(ko↔en)에서 본 순서. 첫 말의 전사가 끝내 오지 않았고, 다음 말들이
    // 앞 말풍선을 하나씩 채워 원문이 모두 한 칸 앞 통역 밑에 붙었다.
    const english = { mine: findTranslatorLanguage("ko"), theirs: findTranslatorLanguage("en") };
    const first = "Well, if they don't even offer an apology, I think it's only right to expose them through the media and social networks myself. So, what do you think I should do about that?";
    const log = replayLog([
      ["a", "Well, if they don't even offer an apology,", 0], ["a", first, 1],
      ["u", "잘 모르겠어요", 0], ["u", "잘 모르겠어요", 1], ["a", "I'm not", 0], ["a", "I'm not really sure.", 1],
      ["u", "뭘 해야 될지 모르겠어요", 1], ["a", "I don't know what I should do.", 1],
    ], emptyTranscriptLog(), english);
    expect(bubbles(log)).toEqual([
      ["", first],
      ["잘 모르겠어요", "I'm not really sure."],
      ["뭘 해야 될지 모르겠어요", "I don't know what I should do."],
    ]);
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
    log = replayLog([["a", "Hel", 0], ["u", "안녕", 1], ["a", "Hello.", 1]], log, english);
    expect(bubbles(log)).toEqual([["안녕하세요", ""], ["안녕", "Hello."]]);
    expect(log.entries.map((e) => [e.call, e.theirs.code])).toEqual([[1, "vi"], [2, "en"]]);
  });

  test("clearing keeps the running call's number", () => {
    const log = clearTranscripts(beginTranscriptCall(beginTranscriptCall(emptyTranscriptLog())));
    expect(log.call).toBe(2);
    expect(replayLog([["u", "네", 1]], log).entries[0].call).toBe(2);
  });

  test("moves the cut-off start of a translation back to the bubble Codex split it from", () => {
    // 2026-10-15 운영 화면(사용자 웨일 탭, en→ko): Codex가 「…걸려요.」를 두 통역 턴에 걸쳐 끊어
    // 「…정도 걸」과 「려요.두 번째…」가 서로 다른 말풍선에 들어갔고 문장 사이도 붙었다.
    const languages = { mine: findTranslatorLanguage("ko"), theirs: findTranslatorLanguage("en") };
    const log = replayLog([
      ["u", "It is about five minutes away.", 1], ["a", "거기서 한 5분", 0], ["u", "Turn left", 0],
      ["a", "거기서 한 5분 정도 걸", 1], ["u", "Turn left at the second street.", 1],
      ["a", "려", 0], ["a", "려요.두 번째", 0], ["a", "려요.두 번째 길에서 왼쪽으로 도세요.", 1],
    ], emptyTranscriptLog(), languages);
    expect(bubbles(log)).toEqual([
      ["It is about five minutes away.", "거기서 한 5분 정도 걸려요."],
      ["Turn left at the second street.", "두 번째 길에서 왼쪽으로 도세요."],
    ]);
    expect(log.carry).toBe(null);
  });

  test("keeps a new utterance's translation in its own bubble after an unpunctuated one", () => {
    // 짧은 새 문장도 앞 통역이 다음 말 전에 끝났으면 끊긴 게 아니다(「Well Thanks.」로 붙던 회귀).
    expect(bubbles(replayLog([["u", "음 그러니까", 1], ["a", "Well", 1], ["u", "고마워요", 1], ["a", "Thanks.", 1]])))
      .toEqual([["음 그러니까", "Well"], ["고마워요", "Thanks."]]);
    expect(bubbles(replayLog([
      ["u", "음 그러니까", 1], ["a", "Well", 1], ["u", "오늘 날씨가 정말 좋네요", 1],
      ["a", "The weather is", 0], ["a", "The weather is really nice today.", 1],
    ]))).toEqual([["음 그러니까", "Well"], ["오늘 날씨가 정말 좋네요", "The weather is really nice today."]]);
  });

  test("spaces sentences Codex joined without a space", () => {
    const log = replayLog([["u", "안녕하세요.근처에 있나요?", 1], ["a", "Xin chào.Có ở gần đây không?", 1]]);
    expect(bubbles(log)).toEqual([["안녕하세요. 근처에 있나요?", "Xin chào. Có ở gần đây không?"]]);
  });

  test("re-splits a cut-off translation when a later cumulative update corrects it", () => {
    const start = [["u", "It is about five minutes away.", 1], ["u", "Turn left", 0], ["a", "거기서 한 5분 정도 걸", 1], ["u", "Turn left at the second street.", 1]];
    const languages = { mine: findTranslatorLanguage("ko"), theirs: findTranslatorLanguage("en") };
    // 한때 첫 문장이 조각으로 보기에 길었다가 고쳐져 짧아진다.
    const longThenShort = replayLog([
      ...start, ["a", "려요 그리고 아주 길게 이어지는 문장인데요", 0], ["a", "려요. 두 번째 길에서 왼쪽으로 도세요.", 1],
    ], emptyTranscriptLog(), languages);
    expect(bubbles(longThenShort)).toEqual([
      ["It is about five minutes away.", "거기서 한 5분 정도 걸려요."],
      ["Turn left at the second street.", "두 번째 길에서 왼쪽으로 도세요."],
    ]);
    // 나머지가 고쳐진 전사에서 사라지면 그 말풍선의 통역만 비운다.
    const restDropped = replayLog([...start, ["a", "려요.두 번째", 0], ["a", "려요.", 1]], emptyTranscriptLog(), languages);
    expect(bubbles(restDropped)).toEqual([
      ["It is about five minutes away.", "거기서 한 5분 정도 걸려요."],
      ["Turn left at the second street.", ""],
    ]);
    expect(restDropped.open.assistant).toBe(null);
  });
});
