import { expect, test } from "bun:test";
import { conversationTurns, type ConversationLine } from "./conversation-display";
import { findTranslatorLanguage } from "@/lib/translator-languages";
import type { TypedTurn } from "./TypedInterpreter";

const mine = findTranslatorLanguage("ko")!, theirs = findTranslatorLanguage("vi")!;
const line = (id: number, role: "user" | "assistant", text: string, at = id): ConversationLine => ({ key: String(id), draft: false, segment: { id, role, text, at, final: true, mine, theirs, call: 1 } });

test("adjacent voice lines use one bubble without changing text or crossing speaker runs", () => {
  const lines = [line(1, "user", "쌀국수 주세요"), line(2, "user", "고수는 빼 주세요"), line(3, "assistant", "Cho tôi phở, không rau mùi."), line(4, "user", "Phở bò hay phở gà?"), line(5, "assistant", "소고기인가요, 닭고기인가요?")];
  const turns = conversationTurns(lines, [], mine);
  expect(turns.map((turn) => turn.side)).toEqual(["me", "them"]);
  expect(turns[0].originals.map((text) => text.text)).toEqual([lines[0].segment.text, lines[1].segment.text]);
  expect(turns[0].translations.map((text) => text.text)).toEqual([lines[2].segment.text]);
  expect(turns.flatMap((turn) => turn.voiceLines).length).toBe(lines.length);
});

test("late interpretation joins only the canonical adjacent voice run before merging typed turns", () => {
  const lines = [line(1, "user", "소고기 주세요", 10), line(2, "user", "Không rau mùi?", 30), line(3, "assistant", "Cho tôi phở bò.", 40), line(4, "assistant", "고수는 빼 드릴까요?", 50)];
  const typed: TypedTurn = { id: 0, at: 20, original: "네", translation: "Vâng", source: mine, target: theirs };
  const turns = conversationTurns(lines, [typed], mine);
  expect(turns.map((turn) => turn.key)).toEqual(["voice-1", "typed-0", "voice-2"]);
  expect(turns[0].voiceLines.map((item) => item.key)).toEqual(["1", "3"]);
  expect(turns[2].voiceLines.map((item) => item.key)).toEqual(["2", "4"]);
  expect(lines.map((item) => item.key)).toEqual(["1", "2", "3", "4"]);
});

test("original-only voice run keeps its key when interpretation streams in", () => {
  const original = line(1, "user", "고수 빼 주세요");
  const before = conversationTurns([original], [], mine)[0];
  const after = conversationTurns([original, line(2, "assistant", "Không rau mùi")], [], mine)[0];
  expect(before.key).toBe(after.key);
  expect(before.translations).toEqual([]);
  expect(after.originals).toEqual(before.originals);
});

test("typed directions, pending text, and delayed readings remain independent display turns", () => {
  const committed: TypedTurn = { id: 0, at: 10, original: "두 그릇", translation: "Hai bát", source: mine, target: theirs, reading: "하이 밧" };
  const provisional: TypedTurn = { id: 1, at: 20, original: "Cảm ơn", translation: "감사", source: theirs, target: mine };
  const turns = conversationTurns([], [committed], mine, provisional);
  expect(turns.map((turn) => turn.side)).toEqual(["me", "them"]);
  expect(turns[0].translations[0].reading).toBe("하이 밧");
  expect(turns[1].pending).toBe(true);
  expect(turns[1].translations[0].final).toBe(false);
  expect(conversationTurns([], [], mine)).toEqual([]);
});

test("a typed reply separates two same-speaker voice utterances chronologically", () => {
  const lines = [line(1, "user", "Phở bò hay phở gà?", 10), line(2, "assistant", "소고기인가요?", 12), line(3, "user", "Hôm nay hết phở gà rồi.", 30), line(4, "assistant", "오늘 닭고기는 없어요.", 32)];
  const typed: TypedTurn = { id: 0, at: 20, original: "소고기 주세요", translation: "Cho tôi phở bò.", source: mine, target: theirs };
  const turns = conversationTurns(lines, [typed], mine);
  expect(turns.map((turn) => turn.key)).toEqual(["voice-1", "typed-0", "voice-3"]);
  expect(turns[2].translations[0].text).toBe("오늘 닭고기는 없어요.");
});
