import { describe, expect, test } from "bun:test";
import {
  addTranscript,
  beginTranscriptCall,
  clearTranscripts,
  emptyTranscriptLog,
  segmentLanguage,
  segmentSpeaker,
  transcriptHistory,
} from "./transcript-log.ts";
import { findTranslatorLanguage } from "../../lib/translator-languages.ts";

const ko = findTranslatorLanguage("ko");
const vi = findTranslatorLanguage("vi");
const en = findTranslatorLanguage("en");
const pair = { mine: ko, theirs: vi };

const update = ([role, text, final]) => ({ role: role === "u" ? "user" : "assistant", text, final: final === 1 });

/** `[role, text, final]` 순서를 그대로 넣는다. */
function replayLog(events, log = emptyTranscriptLog(), languages = pair) {
  for (const event of events) log = addTranscript(log, update(event), languages);
  return log;
}

/** 역할별 흐름의 글. 두 흐름은 서로 짝지어지지 않는다. */
const streams = (log) => ({
  user: log.segments.filter((s) => s.role === "user").map((s) => s.text),
  assistant: log.segments.filter((s) => s.role === "assistant").map((s) => s.text),
});

describe("interpreter transcript streams", () => {
  test("keeps each turn of a live ko→vi exchange in its own role's stream", () => {
    // 2026-10-14 dev:verify 실통화 기록(api-smoke-2)에서 줄인 순서. 통역이 시작된 뒤에도 원문 전사가 이어진다.
    const log = replayLog([
      ["u", "안", 0], ["u", "안녕하세요", 0], ["a", "Xin ch", 0], ["u", "안녕하세요.", 0], ["a", "Xin chào.", 0],
      ["u", "안녕하세요.", 1], ["u", "근처", 0], ["a", "Xin chào.", 1], ["u", "근처에 맛있는", 0],
      ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요", 0], ["a", "Ở gần", 0], ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요?", 0],
      ["a", "Ở gần đây có quán phở ngon", 0], ["u", "근처에 맛있는 쌀국수 집이 어디에 있나요?", 1],
      ["a", "Ở gần đây có quán phở ngon nào không?", 0], ["a", "Ở gần đây có quán phở ngon nào không?", 1],
    ]);
    expect(streams(log)).toEqual({
      user: ["안녕하세요.", "근처에 맛있는 쌀국수 집이 어디에 있나요?"],
      assistant: ["Xin chào.", "Ở gần đây có quán phở ngon nào không?"],
    });
    expect(log.segments.every((s) => s.final)).toBe(true);
    expect(log.open).toEqual({ user: null, assistant: null });
  });

  test("keeps an utterance whose transcript ends after its interpretation", () => {
    const log = replayLog([["a", "Xin ch", 0], ["u", "안녕하세요", 1], ["a", "Xin chào.", 1]]);
    expect(streams(log)).toEqual({ user: ["안녕하세요"], assistant: ["Xin chào."] });
  });

  test("an utterance whose transcript never arrives shifts nothing in either stream", () => {
    // 2026-10-25 폰 실기기 통역(ko↔en): 첫 말의 전사가 끝내 오지 않았다.
    const first = "Well, if they don't even offer an apology, I think it's only right to expose them through the media and social networks myself. So, what do you think I should do about that?";
    const log = replayLog([
      ["a", "Well, if they don't even offer an apology,", 0], ["a", first, 1],
      ["u", "잘 모르겠어요", 0], ["u", "잘 모르겠어요", 1], ["a", "I'm not", 0], ["a", "I'm not really sure.", 1],
      ["u", "뭘 해야 될지 모르겠어요", 1], ["a", "I don't know what I should do.", 1],
    ], emptyTranscriptLog(), { mine: ko, theirs: en });
    expect(streams(log)).toEqual({
      user: ["잘 모르겠어요", "뭘 해야 될지 모르겠어요"],
      assistant: [first, "I'm not really sure.", "I don't know what I should do."],
    });
  });

  test("a long interpretation Codex split over several turns never moves text between segments", () => {
    // 2026-10-25 폰 0.10.72에서 본 통역 세 조각과 짧은 원문 「그래서」·「저는」. 화면 조회만 있어
    // 긴 원문 가운데와 중간 전사, 끼어든 순서는 지어낸 것이다. 고치기 전에는 둘째 조각이 앞 말 밑에
    // 붙었다가 24자를 넘는 순간 「그래서」 밑으로 옮겨 갔다.
    const long = "뭐라하죠 오늘 뵀을 때 기분이 꽤 좋았어요 생각했던 것보다 훨씬 더 미인이셨고";
    const turns = ["How should I put it? Today when", "I saw you, it felt pretty good. You were much prettier than", "I expected."];
    const partials = (text) => Array.from({ length: Math.ceil(text.length / 6) - 1 }, (_, i) => ["a", text.slice(0, (i + 1) * 6), 0]);
    const events = [
      ["u", long, 1],
      ...partials(turns[0]), ["u", "그래서", 0], ["a", turns[0], 1], ["u", "그래서", 1],
      ...partials(turns[1]), ["u", "저는", 0], ["a", turns[1], 1], ["u", "저는", 1],
      ...partials(turns[2]), ["a", turns[2], 1],
    ];
    let log = emptyTranscriptLog();
    const shown = new Map();
    for (const event of events) {
      log = addTranscript(log, update(event), { mine: ko, theirs: en });
      for (const segment of log.segments) {
        const before = shown.get(segment.id) ?? "";
        // 누적 전사만 왔으니 한번 보인 글은 같은 조각에서 이어질 뿐 사라지거나 다른 조각으로 가지 않는다.
        expect(segment.text.startsWith(before)).toBe(true);
        shown.set(segment.id, segment.text);
      }
    }
    expect(streams(log)).toEqual({ user: [long, "그래서", "저는"], assistant: turns });
  });

  test("turns of the same role stay separate even when one ends mid-sentence", () => {
    // 2026-10-15 운영 화면(en→ko): Codex가 「…걸려요.」를 두 통역 턴에 걸쳐 끊었다. 어느 턴이 어느
    // 말의 것인지 알려 주는 식별자가 없어 합치지 않는다.
    const log = replayLog([
      ["u", "It is about five minutes away.", 1], ["a", "거기서 한 5분", 0], ["u", "Turn left", 0],
      ["a", "거기서 한 5분 정도 걸", 1], ["u", "Turn left at the second street.", 1],
      ["a", "려", 0], ["a", "려요.두 번째", 0], ["a", "려요.두 번째 길에서 왼쪽으로 도세요.", 1],
    ], emptyTranscriptLog(), { mine: ko, theirs: en });
    expect(streams(log).assistant).toEqual(["거기서 한 5분 정도 걸", "려요. 두 번째 길에서 왼쪽으로 도세요."]);
    expect(streams(replayLog([["u", "음 그러니까", 1], ["a", "Well", 1], ["u", "고마워요", 1], ["a", "Thanks.", 1]])).assistant)
      .toEqual(["Well", "Thanks."]);
  });

  test("a cumulative revision rewrites the open turn, including one that gets shorter", () => {
    const log = replayLog([["a", "려요 그리고 아주 길게 이어지는 문장인데요", 0], ["a", "려요.", 1], ["a", "다음", 0]]);
    expect(streams(log).assistant).toEqual(["려요.", "다음"]);
    expect(log.open.assistant).toBe(log.segments[1].id);
  });

  test("spaces sentences Codex joined without a space", () => {
    const log = replayLog([["u", "안녕하세요.근처에 있나요?", 1], ["a", "Xin chào.Có ở gần đây không?", 1]]);
    expect(streams(log)).toEqual({ user: ["안녕하세요. 근처에 있나요?"], assistant: ["Xin chào. Có ở gần đây không?"] });
  });

  test("a reconnected call never continues a turn the previous call left open", () => {
    let log = replayLog([["u", "안녕하", 0]], beginTranscriptCall(emptyTranscriptLog()));
    log = beginTranscriptCall(log);
    log = replayLog([["u", "안녕", 0], ["a", "Hello.", 1]], log, { mine: ko, theirs: en });
    expect(log.segments.map((s) => [s.call, s.role, s.text, s.theirs.code])).toEqual([
      [1, "user", "안녕하", "vi"],
      [2, "user", "안녕", "en"],
      [2, "assistant", "Hello.", "en"],
    ]);
  });

  test("clearing keeps the running call's number", () => {
    const log = clearTranscripts(beginTranscriptCall(beginTranscriptCall(emptyTranscriptLog())));
    expect(log.call).toBe(2);
    expect(replayLog([["u", "네", 1]], log).segments[0].call).toBe(2);
  });

  test("language and speaker come from the segment's own text only", () => {
    const [mineSaid, mineInterpreted, theirsSaid, theirsInterpreted, unknownSaid, unknownInterpreted] = replayLog([
      ["u", "안녕하세요", 1], ["a", "Xin chào.", 1],
      ["u", "Cảm ơn bạn", 1], ["a", "고마워요", 1],
      ["u", "123", 1], ["a", "123", 1],
    ]).segments;
    expect([mineSaid, mineInterpreted, theirsSaid, theirsInterpreted].map((s) => [segmentLanguage(s)?.code, segmentSpeaker(s)]))
      .toEqual([["ko", "me"], ["vi", "me"], ["vi", "them"], ["ko", "them"]]);
    expect([unknownSaid, unknownInterpreted].map((s) => [segmentLanguage(s), segmentSpeaker(s)]))
      .toEqual([[undefined, undefined], [undefined, undefined]]);
  });

  test("history hands the latest lines over in spoken order without pairing them", () => {
    const log = replayLog([["u", "안녕하세요", 1], ["a", "Xin ch", 0], ["u", "근처", 0]]);
    expect(transcriptHistory(log, 2)).toEqual([{ role: "assistant", text: "Xin ch" }, { role: "user", text: "근처" }]);
    expect(transcriptHistory(log, 24)).toHaveLength(3);
  });
});
