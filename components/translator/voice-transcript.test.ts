import { expect, test } from "bun:test";
import { upsertVoiceUtterance } from "./voice-transcript";
import { beginTranscriptCall, emptyTranscriptLog, segmentSpeaker } from "./transcript-log";
import { serializeConversation, restoreConversation } from "./conversation-store";
import { conversationTurns } from "./conversation-display";
import { TRANSLATOR_LANGUAGES } from "@/lib/translator-languages";
import type { VoiceUtterance } from "@/lib/interpreter-voice/session";
import { emptyDraftState, mergeDisplay } from "@/lib/translator-draft";
const pair = { mine: TRANSLATOR_LANGUAGES[0], theirs: TRANSLATOR_LANGUAGES[3] };
const item: VoiceUtterance = { id: 0, startMs: 0, endMs: 1000, text: "この김치찌개", side: "them", closed: false, translation: "", final: false };
test("partials and finals replace in place; correcting voice keeps source id and direction through storage", () => {
  let log = beginTranscriptCall(emptyTranscriptLog());
  log = upsertVoiceUtterance(log, item, "call", pair, 1000);
  const originalId = log.segments[0].id;
  log = upsertVoiceUtterance(log, { ...item, text: "この김치찌개二つ", closed: true, translation: "김치찌개 두 개", final: true }, "call", pair, 1000);
  expect(log.segments).toHaveLength(2);
  expect(log.segments[0].id).toBe(originalId);
  expect(log.segments.map(segmentSpeaker)).toEqual(["them", "them"]);
  const translationId = log.segments[1].id;
  log = upsertVoiceUtterance(log, { ...item, side: "me", closed: true, translation: "このキムチチゲ", final: true }, "call", pair, 1000);
  expect(log.segments.map((s) => s.id)).toEqual([originalId, translationId]);
  expect(log.segments.map((s) => s.language?.code)).toEqual(["ko", "ja"]);
  const restored = restoreConversation(serializeConversation(log.segments));
  expect(restored.segments.map(segmentSpeaker)).toEqual(["me", "me"]);
  expect(restored.segments.map((s) => s.language?.code)).toEqual(["ko", "ja"]);
});
test("split speaker bubbles keep every recognized original and translation in timeline order", () => {
  let log = beginTranscriptCall(emptyTranscriptLog());
  log = upsertVoiceUtterance(log, { ...item, id: 1, startMs: 2500, closed: true, translation: "두 개 주세요", final: true }, "call", pair, 1000);
  log = upsertVoiceUtterance(log, { ...item, id: 0, text: "얼마예요", side: "me", closed: true, translation: "いくらですか", final: true }, "call", pair, 1000);
  const turns = conversationTurns(log.segments.map((segment) => ({ key: String(segment.id), segment, draft: false })), [], pair.mine);
  expect(turns.map((turn) => [turn.side, turn.originals.map((s) => s.text), turn.translations.map((s) => s.text)])).toEqual([
    ["me", ["얼마예요"], ["いくらですか"]], ["them", ["この김치찌개"], ["두 개 주세요"]],
  ]);
});

test("same-speaker originals pair by utterance when the second source arrives before the first translation", () => {
  let log = beginTranscriptCall(emptyTranscriptLog());
  log = upsertVoiceUtterance(log, { ...item, closed: true }, "call", pair, 1000);
  log = upsertVoiceUtterance(log, { ...item, id: 1, startMs: 1500, text: "辛く", closed: true }, "call", pair, 1000);
  log = upsertVoiceUtterance(log, { ...item, closed: true, translation: "이 요리 두 개 주세요", final: true }, "call", pair, 1000);
  log = upsertVoiceUtterance(log, { ...item, id: 1, startMs: 1500, text: "辛く", closed: true, translation: "맵게", final: true }, "call", pair, 1000);
  const turns = conversationTurns(mergeDisplay(log.segments, emptyDraftState()), [], pair.mine);
  expect(turns.map((turn) => [turn.originals.map((s) => s.text), turn.translations.map((s) => s.text)])).toEqual([
    [["この김치찌개"], ["이 요리 두 개 주세요"]], [["辛く"], ["맵게"]],
  ]);
});
