import { expect, test } from "bun:test";
import { conversationTurns } from "./conversation-display";
import { findTranslatorLanguage } from "@/lib/translator-languages";
import { VoiceInterpreterSession } from "@/lib/interpreter-voice/session";
import { AudioTurns } from "@/lib/interpreter-voice/audio-turns";
const mine = findTranslatorLanguage("ko")!, theirs = findTranslatorLanguage("zh")!;
test("an original-only turn and a different translation-only turn never become a pair", () => {
  const lines = ([['user','안녕하세요','one'],['assistant','我们不太清楚。','two']] as const).map(([role,text,utterance],id) => ({ key: String(id), draft: false, segment: { id, role, text, utterance, at:id, mine, theirs, call:1, side:'me' as const, final:true } }));
  expect(conversationTurns(lines, [], mine).map(t => t.voiceLines.map(l => l.segment.utterance))).toEqual([['one'],['two']]);
});
test("a previous voice and an ambiguous first delta do not override this turn's recognizable words", async () => {
  const directions: string[] = [];
  const session = new VoiceInterpreterSession({ mine, theirs, onUpdate() {}, onFinal() {}, translate: async r => { directions.push(r.source); return 'translation'; } });
  const turns = new AudioTurns({ open: t => session.open(t), append() {}, commit: t => session.commit(t) });
  turns.push(new Int16Array(24000).fill(3000), 'them'); turns.finish(); session.transcript('a','你好',true);
  turns.push(new Int16Array(24000).fill(3000)); turns.finish(); session.transcript('b','  ',false); session.transcript('b','서울역에서 만나요.',true);
  await session.whenIdle(); expect(directions).toEqual(['zh','ko']);
});
