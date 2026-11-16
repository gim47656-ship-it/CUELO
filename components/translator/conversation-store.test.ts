import { describe, expect, test } from "bun:test";
import { findTranslatorLanguage, type TranslatorLanguage } from "@/lib/translator-languages";
import { CONVERSATION_MAX_SEGMENTS, formatConversation, restoreConversation, serializeConversation } from "./conversation-store";
import { addTranscript, beginTranscriptCall, transcriptHistory, type TranscriptSegment } from "./transcript-log";

const ko = findTranslatorLanguage("ko") as TranslatorLanguage;
const vi = findTranslatorLanguage("vi") as TranslatorLanguage;

function segment(id: number, role: TranscriptSegment["role"], text: string, at = 1_700_000_000_000 + id * 60_000): TranscriptSegment {
  return { id, role, text, final: true, mine: ko, theirs: vi, call: 1, at };
}

describe("conversation persistence", () => {
  test("round-trips role, text, language pair and time; restored lines are final and marked", () => {
    const log = restoreConversation(serializeConversation([segment(0, "user", "얼마예요?"), segment(1, "assistant", "Bao nhiêu tiền?")]));
    expect(log.segments.map((s) => [s.role, s.text, s.mine.code, s.theirs.code, s.at, s.final, s.restored])).toEqual([
      ["user", "얼마예요?", "ko", "vi", 1_700_000_000_000, true, true],
      ["assistant", "Bao nhiêu tiền?", "ko", "vi", 1_700_000_060_000, true, true],
    ]);
    expect(log.nextId).toBe(2);
  });

  test("keeps only the latest CONVERSATION_MAX_SEGMENTS lines and drops blank ones", () => {
    const many = Array.from({ length: CONVERSATION_MAX_SEGMENTS + 30 }, (_, index) => segment(index, "user", `줄 ${index}`));
    const restored = restoreConversation(serializeConversation([...many, segment(999, "user", "   ")])).segments;
    expect(restored).toHaveLength(CONVERSATION_MAX_SEGMENTS);
    expect(restored[0].text).toBe("줄 30");
    expect(restored.at(-1)?.text).toBe(`줄 ${CONVERSATION_MAX_SEGMENTS + 29}`);
  });

  test("broken or foreign storage restores to an empty log", () => {
    expect(restoreConversation(null).segments).toEqual([]);
    expect(restoreConversation("{not json").segments).toEqual([]);
    expect(restoreConversation(JSON.stringify({ v: 2, segments: [] })).segments).toEqual([]);
    expect(restoreConversation(JSON.stringify({ v: 1, segments: [{ role: "user", text: "hi", mine: "xx", theirs: "vi", at: 1 }] })).segments).toEqual([]);
  });

  test("restored lines are not sent as context to a new call, new lines are", () => {
    let log = beginTranscriptCall(restoreConversation(serializeConversation([segment(0, "user", "어제 한 말")])));
    log = addTranscript(log, { role: "user", text: "오늘 한 말", final: true }, { mine: ko, theirs: vi }, 5);
    expect(transcriptHistory(log, 10).map((line) => line.text)).toEqual(["오늘 한 말"]);
    expect(log.segments.at(-1)?.at).toBe(5);
    expect(log.segments.at(-1)?.id).toBeGreaterThan(log.segments[0].id);
  });
});

describe("share text", () => {
  test("lists each line with time, kind and language in spoken order", () => {
    const text = formatConversation(
      [segment(0, "user", "얼마예요?"), segment(1, "assistant", "Bao nhiêu tiền?"), segment(2, "assistant", "50000", 0)],
      { title: "CUELO 통역 기록", original: "원문", translation: "통역" },
      (at) => `t${at % 1_000_000}`,
    );
    expect(text.split("\n")).toEqual([
      "CUELO 통역 기록",
      "",
      "[t0] 원문 (한국어): 얼마예요?",
      "[t60000] 통역 (Tiếng Việt): Bao nhiêu tiền?",
      "통역: 50000",
    ]);
  });
});
