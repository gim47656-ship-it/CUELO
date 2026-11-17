import { expect, test } from "bun:test";
import { VoiceInterpreterSession } from "./session";
import { TRANSLATOR_LANGUAGES } from "../translator-languages";
import { parseInterpreterTextRequest } from "../interpreter-travel";
import { upsertVoiceUtterance } from "../../components/translator/voice-transcript";
import { emptyTranscriptLog, transcriptHistory } from "../../components/translator/transcript-log";
import { serializeConversation } from "../../components/translator/conversation-store";
import { AudioTurns, type AudioTurn } from "./audio-turns";
const mine = TRANSLATOR_LANGUAGES[0], theirs = TRANSLATOR_LANGUAGES[3];
test("R1-ANT-1 / ADV-1: noise's empty final never becomes invalid translation history", async () => {
  const session = new VoiceInterpreterSession({ mine, theirs, onUpdate() {}, onFinal() {}, translate: async (r) => {
    parseInterpreterTextRequest({ mine: "ko", theirs: "ja", source: r.source, text: r.text, mode: "voice", history: r.previous.map((text) => ({ role: "user", text })) });
    return "translated";
  } });
  session.open({ id: 0, startMs: 0, endMs: 500, side: "me" }); session.transcript("0", "", true);
  session.open({ id: 1, startMs: 600, endMs: 1500, side: "me" }); session.transcript("1", "안녕", true);
  await session.whenIdle();
  expect(session.utterances.get(1)?.translationError).toBe(false);
});
test("R1-ANT-2: correction of a partial survives subsequent voice analysis and audio commit", async () => {
  let direction: string[] = [];
  const session = new VoiceInterpreterSession({ mine, theirs, onUpdate() {}, onFinal() {}, translate: async (r) => { direction = [r.source, r.target]; return "네"; } });
  session.open({ id: 0, startMs: 0, endMs: 0, side: "me" }); session.transcript("a", "はい", false);
  session.correct(0, "them"); session.direction(0, "me"); session.commit({ id: 0, startMs: 0, endMs: 900, side: "me" });
  session.transcript("a", "はい", true); await session.whenIdle();
  expect(direction).toEqual(["ja", "ko"]);
});
test("R1-ANT-6: real blank-during-correction sequence preserves translation segment id", () => {
  const item = { id: 0, startMs: 0, endMs: 1000, text: "はい", side: "me" as const, closed: true, translation: "はい", final: true };
  let log = upsertVoiceUtterance(emptyTranscriptLog(), item, "call", { mine, theirs }, 0);
  const id = log.segments.find((segment) => segment.role === "assistant")!.id;
  log = upsertVoiceUtterance(log, { ...item, translation: "", final: false }, "call", { mine, theirs }, 0);
  log = upsertVoiceUtterance(log, { ...item, translation: "네", final: true, side: "them" }, "call", { mine, theirs }, 0);
  expect(log.segments.find((segment) => segment.role === "assistant")!.id).toBe(id);
});
test("R2-ANT-1: manual correction of an open utterance ignores subsequent stale voice identity", () => {
  const commits: AudioTurn[] = [];
  const turns = new AudioTurns({ open() {}, append() {}, commit: (turn) => commits.push(turn) }); turns.holdMs = 1500;
  for (let i = 0; i < 40; i++) turns.push(new Int16Array(2400).fill(8000), "me");
  turns.correct(0, "them"); turns.identify("me", 3500);
  expect(commits).toHaveLength(0); expect(turns.current?.side).toBe("them");
});
test("R2-ANT-2: existing history and storage boundaries exclude retained blank segments", () => {
  const item = { id: 0, startMs: 0, endMs: 1000, text: "はい", side: "me" as const, closed: true, translation: "abc", final: true };
  let log = upsertVoiceUtterance(emptyTranscriptLog(), item, "call", { mine, theirs }, 0);
  log = upsertVoiceUtterance(log, { ...item, translation: "", translationError: true }, "call", { mine, theirs }, 0);
  expect(transcriptHistory(log, 24).filter((line) => !line.text.trim())).toEqual([]);
  expect(JSON.parse(serializeConversation(log.segments)).segments.filter((line: { text: string }) => !line.text.trim())).toEqual([]);
});
test("R2-ANT-3: correcting an older turn cannot become the most recent speaker", () => {
  const turns = new AudioTurns({ open() {}, append() {}, commit() {} });
  for (let id = 0; id < 2; id++) { turns.push(new Int16Array(2400).fill(8000), "me"); turns.finish(); }
  turns.correct(0, "them"); turns.push(new Int16Array(2400).fill(8000));
  expect(turns.current?.side).toBe("me");
});
test("R3-ANT-1: delayed first transcript still establishes the previous audio speaker", async () => {
  const session = new VoiceInterpreterSession({ mine, theirs, onUpdate() {}, onFinal() {}, translate: async () => "ok" });
  session.open({ id: 0, startMs: 0, endMs: 500 }); session.open({ id: 1, startMs: 600, endMs: 1500 });
  session.transcript("a", "はい", true); session.transcript("b", "1234", true); await session.whenIdle();
  expect(session.utterances.get(1)?.side).toBe("them");
});
test("R3-ADV-1: commit without voice identity preserves the partial's first-language lock", async () => {
  const session = new VoiceInterpreterSession({ mine: TRANSLATOR_LANGUAGES[1], theirs, onUpdate() {}, onFinal() {}, translate: async () => "ok" });
  session.open({ id: 0, startMs: 0, endMs: 0 }); session.transcript("a", "はい", false);
  session.commit({ id: 0, startMs: 0, endMs: 1000, side: undefined });
  session.transcript("a", "はい let us go to the station", true); await session.whenIdle();
  expect(session.utterances.get(0)?.side).toBe("them");
});
