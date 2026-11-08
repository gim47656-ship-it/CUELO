import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const draft = await jiti.import("./translator-draft.ts");
const { findTranslatorLanguage } = await jiti.import("./translator-languages.ts");
const { addTranscript, beginTranscriptCall, emptyTranscriptLog, transcriptHistory } = await jiti.import("../components/translator/transcript-log.ts");

const { needsTick, applyInputDelta, applyOutputDelta, reconcileDrafts, mergeDisplay, emptyDraftState, DRAFT_TTL_MS, SKIPPED_DRAFT_MS, TURN_GAP_MS } = draft;

const ko = findTranslatorLanguage("ko");
const vi = findTranslatorLanguage("vi");
const en = findTranslatorLanguage("en");
const koVi = { mine: ko, theirs: vi };
const enVi = { mine: en, theirs: vi };

/** Feed `text` to a session as deltas 100 ms apart from `start`. */
function say(state, kind, pair, target, text, start, step = 100) {
  const apply = kind === "in" ? applyInputDelta : applyOutputDelta;
  return text.split(/(?<= )/u).reduce((current, piece, index) => apply(current, pair, target, piece, start + index * step), state);
}

/** A session heard `input` and answered `output`: the usual order, input first. */
const draftFor = (state, pair, target, input, output, start) => say(say(state, "in", pair, target, input, start), "out", pair, target, output, start + 600);

const texts = (state) => state.drafts.map((d) => `${d.language.code}:${d.text}`);
const assistant = (id, text, final = false, pair = koVi) => ({ id, role: "assistant", text, final, ...pair, call: 1 });
const user = (id, text, pair = koVi) => ({ id, role: "user", text, final: true, ...pair, call: 1 });

test("a Korean turn gets a Vietnamese draft from the Vietnamese session and none from the Korean one", () => {
  let state = emptyDraftState();
  // The session translating into Korean hears Korean: it has nothing to translate and outputs nothing,
  // or if it does the turn is an echo of its own input.
  state = say(state, "in", koVi, ko, "이거 얼마예요? ", 0);
  state = say(state, "out", koVi, ko, "이거 얼마예요? ", 1500);
  state = say(state, "in", koVi, vi, "이거 얼마예요? ", 0);
  state = say(state, "out", koVi, vi, "Cái này bao nhiêu? ", 1500);
  assert.deepEqual(texts(state), ["vi:Cái này bao nhiêu?"]);
});

test("a Vietnamese turn echoed in Vietnamese by the Vietnamese session shows no draft", () => {
  let state = say(emptyDraftState(), "in", koVi, vi, "Chú ơi, anh ấy nói là ", 0);
  state = say(state, "out", koVi, vi, "Chủ ơi, anh ấy nói là ", 600);
  assert.deepEqual(texts(state), []);
  // The Korean session of the same turn is the real translation.
  state = say(state, "in", koVi, ko, "Chú ơi, anh ấy nói là ", 0);
  state = say(state, "out", koVi, ko, "저기요, 그가 말하길 ", 700);
  assert.deepEqual(texts(state), ["ko:저기요, 그가 말하길"]);
});

test("output while the session's own input is in its output language is dropped even when it is not a copy", () => {
  // The model may paraphrase what it heard instead of copying it; the input language alone marks the turn.
  let state = say(emptyDraftState(), "in", koVi, vi, "Chú ơi, anh ấy nói là chị ấy sẽ đến lúc ba giờ chiều ", 0);
  state = say(state, "out", koVi, vi, "Xin lỗi, tôi sẽ hẹn gặp bạn sau buổi trưa ", 800);
  assert.deepEqual(texts(state), []);
});

test("an echo that starts before its input transcript is retracted when the input proves it", () => {
  let state = say(emptyDraftState(), "out", koVi, vi, "Chủ ơi, anh ấy ", 0, 300);
  assert.deepEqual(texts(state), ["vi:Chủ ơi, anh ấy"], "shown once the wait for an input transcript is over");
  state = say(state, "in", koVi, vi, "Chú ơi, anh ", 1300);
  assert.deepEqual(texts(state), [], "retracted");
  state = say(state, "out", koVi, vi, "nói là chị ấy ", 1700);
  assert.deepEqual(texts(state), [], "the turn stays an echo");
});

test("a same-script echo is caught by similarity when the letters give no language", () => {
  // Vietnamese typed without accents reads as English to the script check, so only the text comparison sees the echo.
  let state = say(emptyDraftState(), "in", enVi, vi, "Toi lay hai ky ", 0);
  state = say(state, "out", enVi, vi, "Tôi lấy hai ký ", 800);
  assert.deepEqual(texts(state), []);
  // A real translation of different content stays.
  state = say(state, "in", enVi, vi, "How much is this one ", 5000);
  state = say(state, "out", enVi, vi, "Cái này bao nhiêu tiền ", 5800);
  assert.deepEqual(texts(state), ["vi:Cái này bao nhiêu tiền"]);
});

test("input pauses split turns; words inside the gap stay one turn", () => {
  let state = say(emptyDraftState(), "in", koVi, vi, "지금 몇 시예요? ", 0);
  state = say(state, "out", koVi, vi, "Bây giờ là mấy giờ? ", 1000);
  state = say(state, "in", koVi, vi, "하노이로 가 주세요 ", 3000 + TURN_GAP_MS);
  state = say(state, "out", koVi, vi, "Xin đưa tôi đến Hà Nội ", 4000 + TURN_GAP_MS);
  assert.deepEqual(texts(state), ["vi:Bây giờ là mấy giờ?", "vi:Xin đưa tôi đến Hà Nội"]);
  // Back to back inside the gap: one turn, one draft.
  let merged = say(emptyDraftState(), "in", koVi, vi, "지금 몇 시예요? ", 0);
  merged = say(merged, "in", koVi, vi, "하노이로 ", 1000);
  merged = say(merged, "out", koVi, vi, "Mấy giờ rồi, đến Hà Nội ", 1500);
  assert.equal(merged.drafts.length, 1);
});

test("a delta in the other language's script after a pause starts a turn, a loanword inside a sentence does not", () => {
  let state = say(emptyDraftState(), "in", koVi, ko, "지금 몇 시예요? ", 0);
  const sentenceEnd = 1000;
  state = applyInputDelta(state, koVi, ko, " Chú", sentenceEnd + 900);
  assert.equal(state.turns.ko.length, 2, "Vietnamese speech 0.9 s after Korean is a new turn");
  const koEn = { mine: ko, theirs: en };
  let loan = say(emptyDraftState(), "in", koEn, ko, "저는 아이폰이 ", 0);
  loan = applyInputDelta(loan, koEn, ko, "iPhone", 400);
  assert.equal(loan.turns.ko.length, 1, "an English word right after Korean words stays in the turn");
});

test("Codex finals take the oldest pending draft of their language, per language", () => {
  let state = draftFor(emptyDraftState(), koVi, vi, "지금 ", "Mấy giờ rồi ", 0);
  state = draftFor(state, koVi, vi, "몇 시 ", "Giờ nào ", 10000);
  state = draftFor(state, koVi, ko, "Chú ơi ", "저기요 ", 12000);
  assert.equal(state.drafts.length, 3);
  const [first, second, korean] = state.drafts;
  // The Korean final must not take a Vietnamese draft.
  let segments = [assistant(5, "저기요, 잠깐만요")];
  state = reconcileDrafts(state, segments, 13000);
  assert.equal(state.drafts.find((d) => d.id === korean.id).matched, 5);
  assert.equal(state.drafts.find((d) => d.id === first.id).matched, null);
  segments = [...segments, assistant(6, "Bây giờ là")];
  state = reconcileDrafts(state, segments, 13500);
  assert.equal(state.drafts.find((d) => d.id === first.id).matched, 6, "oldest Vietnamese draft first");
  assert.equal(state.drafts.find((d) => d.id === second.id).matched, null);
  segments = [...segments, assistant(7, "Mười giờ rồi")];
  state = reconcileDrafts(state, segments, 14000);
  assert.equal(state.drafts.find((d) => d.id === second.id).matched, 7);
});

test("a short turn's translation that comes before its input is not lost to the echo turn before it", () => {
  // The Vietnamese session echoed a Vietnamese turn; the next Korean turn is so short that its translation arrives first.
  let state = say(emptyDraftState(), "in", koVi, vi, "Chú ơi, anh ấy nói là ", 0);
  state = say(state, "out", koVi, vi, "Chủ ơi, anh ấy nói là ", 600);
  state = say(state, "out", koVi, vi, "Bây giờ mấy giờ rồi ", 4000);
  assert.deepEqual(texts(state), [], "held a moment: no input transcript yet to prove it is not an echo");
  state = say(state, "in", koVi, vi, "지금 몇 시예요 ", 4500);
  assert.deepEqual(texts(state), ["vi:Bây giờ mấy giờ rồi"], "its own input joins it and does not make it an echo");
  assert.equal(state.turns.vi.length, 2);
});

test("an echo whose output starts a hair before its input never flashes a draft", () => {
  // The Korean session repeats Korean speech: its first output piece can come right before the first input piece.
  let state = applyOutputDelta(emptyDraftState(), koVi, ko, "이 ", 0);
  assert.deepEqual(texts(state), []);
  state = applyInputDelta(state, koVi, ko, "이거 ", 10);
  state = say(state, "out", koVi, ko, "공을 하나에 얼마예요 ", 120);
  assert.deepEqual(texts(state), []);
});

test("a segment that opens in the other language is matched by what it turns out to be", () => {
  // Codex opened this Korean translation with the tail of the previous Vietnamese sentence.
  let state = draftFor(emptyDraftState(), koVi, ko, "Chú ơi, anh ấy ", "저기요, 그가 ", 0);
  let segments = [assistant(4, "tôi mười nghìn đồng nhé")];
  state = reconcileDrafts(state, segments, 5000);
  assert.equal(state.drafts[0].matched, null, "no Vietnamese draft to take, and it is still streaming");
  segments = [assistant(4, "tôi mười nghìn đồng nhé. 이거 1킬로에 얼마예요, 언니")];
  state = reconcileDrafts(state, segments, 5500);
  assert.equal(state.drafts[0].matched, 4);
});

test("the language of a streaming segment is read from its latest letters", () => {
  let state = draftFor(emptyDraftState(), koVi, ko, "Chú ơi, anh ấy ", "저기요, 그가 ", 0);
  // More Vietnamese than Korean letters overall, but the segment is Korean now.
  const mixed = "Cái này một ký bao nhiêu tiền vậy chị? Tôi lấy hai ký, bớt cho tôi 이거 1킬로에 얼마예요";
  state = reconcileDrafts(state, [assistant(4, mixed)], 5000);
  assert.equal(state.drafts[0].matched, 4);
});

test("a Codex translation that has only just begun is not shown beside the draft it is about to take", () => {
  const drafted = draftFor(emptyDraftState(), koVi, vi, "지금 몇 시예요 ", "Mấy giờ rồi ", 0);
  const begun = [assistant(3, "Bây")];
  assert.deepEqual(mergeDisplay(begun, drafted).map((l) => [l.draft, l.segment.text]), [[true, "Mấy giờ rồi"]]);
  // Without a draft waiting for it, the same segment is shown at once.
  assert.deepEqual(mergeDisplay(begun, emptyDraftState()).map((l) => l.segment.text), ["Bây"]);
  // Once it can take the draft it is the draft's bubble; a complete short one is shown as it is.
  const taken = reconcileDrafts(drafted, [assistant(3, "Bây giờ là")], 2000);
  assert.deepEqual(mergeDisplay([assistant(3, "Bây giờ là")], taken).map((l) => l.key), [`d${taken.drafts[0].id}`]);
  assert.deepEqual(mergeDisplay([assistant(3, "Bây", true)], drafted).map((l) => l.segment.text).sort(), ["Bây", "Mấy giờ rồi"]);
});

test("an output-first translation shows once its hold is over even if no other delta comes", () => {
  let state = applyOutputDelta(emptyDraftState(), koVi, vi, "Xin chào bạn", 0);
  assert.equal(needsTick(state), true, "the clock must tick while it waits");
  state = reconcileDrafts(state, [], 400);
  assert.deepEqual(texts(state), []);
  state = reconcileDrafts(state, [], 801);
  assert.deepEqual(texts(state), ["vi:Xin chào bạn"]);
  // An echo that the input proved never gets released.
  let echo = applyOutputDelta(emptyDraftState(), koVi, ko, "이거 하나에 얼마예요", 0);
  echo = applyInputDelta(echo, koVi, ko, "이거 하나에 얼마예요", 100);
  echo = reconcileDrafts(echo, [], 5000);
  assert.deepEqual(texts(echo), []);
  assert.equal(needsTick(echo), false);
});

test("an overdue draft expires instead of being taken over by a late segment", () => {
  let state = draftFor(emptyDraftState(), koVi, vi, "지금 몇 시예요 ", "Mấy giờ rồi ", 0);
  const created = state.drafts[0].createdAt;
  state = reconcileDrafts(state, [assistant(9, "Bây giờ là mấy giờ")], created + DRAFT_TTL_MS + 1);
  assert.equal(state.drafts.length, 0);
});

test("a segment that began as a leftover of the other language can take a draft made while it streamed", () => {
  // Codex's segment opened with a Vietnamese tail, the Korean draft appeared, then the segment turned Korean.
  let state = emptyDraftState();
  state = reconcileDrafts(state, [assistant(4, "t cho tôi 10.000 won nhé")], 13800);
  state = draftFor(state, koVi, ko, "Cái này một ký ", "이건 1킬로에 얼마예요 ", 14000);
  state = reconcileDrafts(state, [assistant(4, "t cho tôi 10.000 won nhé. 이거 한 킬로에 얼마예요")], 17800);
  assert.equal(state.drafts[0].matched, 4);
  // The same segment staying one language is still never a draft made after it first read.
  let late = reconcileDrafts(emptyDraftState(), [assistant(5, "Bây giờ là mấy giờ")], 1000);
  late = draftFor(late, koVi, vi, "지금 몇 시 ", "Mấy giờ rồi ", 2000);
  late = reconcileDrafts(late, [assistant(5, "Bây giờ là mấy giờ rồi ạ")], 3000);
  assert.equal(late.drafts[0].matched, null);
});

test("a single unreadable input letter does not release an output-first echo as a flash", () => {
  let state = applyOutputDelta(emptyDraftState(), koVi, vi, "Tôi muốn ", 0);
  state = applyInputDelta(state, koVi, vi, " C", 150);
  assert.deepEqual(texts(state), [], "the input says nothing about the language yet");
  state = say(state, "in", koVi, vi, "ái này một ký ", 200);
  assert.deepEqual(texts(state), [], "it was the Vietnamese session repeating Vietnamese");
});

test("a draft Codex skipped does not take the final of a later turn", () => {
  // Codex can merge two quick turns into one translation: the first turn's draft never gets a final.
  let state = draftFor(emptyDraftState(), koVi, vi, "지금 몇 시예요 ", "Mấy giờ rồi ", 0);
  state = draftFor(state, koVi, vi, "하노이로 가 주세요 ", "Xin đưa tôi đến Hà Nội ", SKIPPED_DRAFT_MS);
  state = reconcileDrafts(state, [assistant(8, "Làm ơn đưa tôi đến Hà Nội")], SKIPPED_DRAFT_MS + 1500);
  assert.deepEqual(state.drafts.map((d) => [d.text, d.matched]), [["Xin đưa tôi đến Hà Nội", 8]]);
  // A single pending draft is never skipped, however old: its final may only be late.
  let lone = draftFor(emptyDraftState(), koVi, vi, "지금 몇 시예요 ", "Mấy giờ rồi ", 0);
  lone = reconcileDrafts(lone, [assistant(9, "Bây giờ là mấy giờ")], SKIPPED_DRAFT_MS + 1000);
  assert.equal(lone.drafts[0].matched, 9);
});

test("a tiny leftover segment takes no draft, a longer one does once its text can be trusted", () => {
  let state = draftFor(emptyDraftState(), koVi, vi, "고마워요 ", "Cảm ơn nhiều ", 0);
  state = reconcileDrafts(state, [assistant(1, "nhé.", true)], 1000);
  assert.equal(state.drafts[0].matched, null, "a four-letter final is a leftover");
  state = reconcileDrafts(state, [assistant(2, "Cảm")], 1100);
  assert.equal(state.drafts[0].matched, null, "too little text to trust the language while streaming");
  state = reconcileDrafts(state, [assistant(2, "Cảm ơn bạn")], 1200);
  assert.equal(state.drafts[0].matched, 2);
});

test("a final that was there before a draft never takes it", () => {
  let state = reconcileDrafts(emptyDraftState(), [assistant(3, "Xin chào")], 1000);
  state = draftFor(state, koVi, vi, "안녕 ", "Xin chào bạn ", 2000);
  state = reconcileDrafts(state, [assistant(3, "Xin chào bạn")], 3500);
  assert.equal(state.drafts[0].matched, null);
  assert.equal(mergeDisplay([assistant(3, "Xin chào bạn")], state).length, 2, "the draft shows beside the old final until it expires");
});

test("segments that existed when drafts started are not matched", () => {
  const old = [assistant(0, "Xin chào")];
  let state = emptyDraftState(old);
  state = draftFor(state, koVi, vi, "고마워요 ", "Cảm ơn bạn ", 0);
  state = reconcileDrafts(state, old, 1000);
  assert.equal(state.drafts[0].matched, null);
});

test("a draft with no final expires and its still-running turn does not bring it back", () => {
  let state = say(emptyDraftState(), "in", koVi, vi, "지금 몇 시예요? ", 0);
  // A long translation: a piece every second, so the turn is still running when its draft expires.
  for (let t = 1000; t <= 1000 + DRAFT_TTL_MS; t += 1000) state = applyOutputDelta(state, koVi, vi, "từ ", t);
  assert.equal(state.turns.vi.length, 1);
  state = reconcileDrafts(state, [], 1000 + DRAFT_TTL_MS);
  assert.equal(state.drafts.length, 1, "still within the time");
  state = reconcileDrafts(state, [], 1001 + DRAFT_TTL_MS);
  assert.equal(state.drafts.length, 0);
  state = applyOutputDelta(state, koVi, vi, "nữa ", 1000 + DRAFT_TTL_MS + 500);
  state = applyOutputDelta(state, koVi, vi, "đi ", 1000 + DRAFT_TTL_MS + 900);
  assert.equal(state.drafts.length, 0, "the expired turn stays gone");
  // Output after a long pause is a new turn and gets its own draft.
  state = draftFor(state, koVi, vi, "안녕하세요 ", "Xin chào ", 9000 + DRAFT_TTL_MS);
  assert.equal(state.drafts.length, 1);
});

test("a draft sits after the last segment and a matched draft keeps its place while the final streams", () => {
  const log = [user(0, "지금 몇 시예요?")];
  let state = reconcileDrafts(emptyDraftState(), log, 0);
  state = say(state, "in", koVi, vi, "지금 몇 시예요? ", 0);
  state = say(state, "out", koVi, vi, "Bây giờ là mấy giờ? ", 800);
  let lines = mergeDisplay(log, state);
  assert.deepEqual(lines.map((l) => [l.draft, l.segment.text]), [[false, "지금 몇 시예요?"], [true, "Bây giờ là mấy giờ?"]]);
  const draftKey = lines[1].key;

  // A newer original (heard text) arrives before the translation: it goes after the draft.
  const next = [...log, user(1, "하노이요")];
  state = reconcileDrafts(state, next, 1000);
  assert.deepEqual(mergeDisplay(next, state).map((l) => l.segment.text), ["지금 몇 시예요?", "Bây giờ là mấy giờ?", "하노이요"]);

  // The final starts: the bubble stays the draft's until the final is as long, then it is the final's.
  const streaming = [...next, assistant(2, "Mấy giờ")];
  state = reconcileDrafts(state, streaming, 1500);
  lines = mergeDisplay(streaming, state);
  assert.equal(lines.length, 3);
  assert.equal(lines[1].key, draftKey);
  assert.deepEqual([lines[1].draft, lines[1].segment.text], [true, "Bây giờ là mấy giờ?"]);
  const longer = [...next, assistant(2, "Bây giờ là mấy giờ rồi ạ?")];
  lines = mergeDisplay(longer, reconcileDrafts(state, longer, 1600));
  assert.deepEqual([lines[1].key, lines[1].draft, lines[1].segment.text], [draftKey, false, "Bây giờ là mấy giờ rồi ạ?"]);
  // A complete final shorter than the draft still wins.
  const shortFinal = [...next, assistant(2, "Mấy giờ?", true)];
  lines = mergeDisplay(shortFinal, reconcileDrafts(state, shortFinal, 1700));
  assert.deepEqual([lines[1].draft, lines[1].segment.text], [false, "Mấy giờ?"]);
});

test("drafts stay out of the history and the segments are left as they were", () => {
  let log = beginTranscriptCall(emptyTranscriptLog());
  log = addTranscript(log, { role: "user", text: "지금 몇 시예요?", final: true }, koVi);
  const before = JSON.stringify(log.segments);
  const historyBefore = transcriptHistory(log, 20);
  let state = reconcileDrafts(emptyDraftState(), log.segments, 0);
  state = say(state, "in", koVi, vi, "지금 몇 시예요? ", 0);
  state = say(state, "out", koVi, vi, "Mấy giờ rồi ", 800);
  const lines = mergeDisplay(log.segments, state);
  assert.equal(lines.length, 2);
  assert.deepEqual(transcriptHistory(log, 20), historyBefore);
  assert.equal(JSON.stringify(log.segments), before);
  assert.ok(!transcriptHistory(log, 20).some((line) => line.text.includes("Mấy giờ")));
});

test("a reset (reconnect, hang-up, clear) drops every draft and keeps ids counting", () => {
  let state = draftFor(emptyDraftState(), koVi, vi, "지금 ", "Mấy giờ rồi ", 0);
  const used = state.nextDraftId;
  const reset = emptyDraftState([assistant(4, "x")], state);
  assert.equal(reset.drafts.length, 0);
  assert.deepEqual(reset.turns, {});
  assert.ok(reset.nextDraftId >= used);
  state = draftFor(reset, koVi, vi, "고마워요 ", "Cảm ơn ", 5000);
  assert.ok(state.drafts[0].id >= used, "a React key is never reused");
});
