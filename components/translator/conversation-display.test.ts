import { expect, test } from "bun:test";
import { conversationTurns, type ConversationLine } from "./conversation-display";
import { findTranslatorLanguage } from "@/lib/translator-languages";
import type { TypedTurn } from "./TypedInterpreter";

const mine = findTranslatorLanguage("ko")!, theirs = findTranslatorLanguage("vi")!, japanese = findTranslatorLanguage("ja")!;
const line = (id: number, role: "user" | "assistant", text: string, at = id, other = theirs): ConversationLine => ({ key: String(id), draft: false, segment: { id, role, text, at, final: true, mine, theirs: other, call: 1 } });
const ja = (id: number, role: "user" | "assistant", text: string) => line(id, role, text, id, japanese);
const shape = (lines: ConversationLine[]) => conversationTurns(lines, [], mine).map((turn) => [turn.side, turn.originals.map((text) => text.text), turn.translations.map((text) => text.text), turn.speakerStart === true]);

test("consecutive utterances by one person read as alternating original/interpretation bubbles", () => {
  // The phone conversation of 11-17: five Korean utterances in a row had been one bubble, all Japanese above all Korean.
  const lines = [ja(1, "user", "음 저는"), ja(2, "assistant", "うーん、私は…"), ja(3, "user", "모르겠어요"), ja(4, "assistant", "わかりません。"), ja(5, "user", "안녕하세요"), ja(6, "assistant", "こんにちは。")];
  expect(shape(lines)).toEqual([
    ["me", ["음 저는"], ["うーん、私は…"], true],
    ["me", ["모르겠어요"], ["わかりません。"], false],
    ["me", ["안녕하세요"], ["こんにちは。"], false],
  ]);
});

test("an interpretation arriving before its heard words still splits per utterance, both directions", () => {
  const lines = [ja(1, "assistant", "どこに行きますか?"), ja(2, "user", "어디 가세요?"), ja(3, "user", "駅です。"), ja(4, "assistant", "역이에요."), ja(5, "user", "감사합니다"), ja(6, "assistant", "ありがとうございます。")];
  expect(shape(lines)).toEqual([
    ["me", ["어디 가세요?"], ["どこに行きますか?"], true],
    ["them", ["駅です。"], ["역이에요."], true],
    ["me", ["감사합니다"], ["ありがとうございます。"], true],
  ]);
});

test("ambiguous legacy originals and their merged interpretation stay separate, with no lines lost", () => {
  const lines = [ja(1, "user", "쌀국수 주세요"), ja(2, "user", "고수는 빼 주세요"), ja(3, "assistant", "フォーをください、パクチー抜きで。")];
  expect(shape(lines)).toEqual([
    ["me", ["쌀국수 주세요"], [], true],
    ["me", ["고수는 빼 주세요"], [], false],
    ["me", [], ["フォーをください、パクチー抜きで。"], false],
  ]);
  expect(conversationTurns(lines, [], mine).flatMap((turn) => turn.voiceLines).length).toBe(lines.length);
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
