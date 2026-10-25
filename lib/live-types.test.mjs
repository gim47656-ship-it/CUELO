import assert from "node:assert/strict";
import test from "node:test";

// Wire shape follows the upstream Codex frameless-bidi fixture:
//   {"type":"turn.done","turn":{"id":"turn-1","role":"user","transcript":"hello"}}
//   {"type":"input_transcript.added","item":{"id":"input-1","type":"input_transcript","text":"hello"}}
// (openai/codex codex-rs/codex-api/src/endpoint/realtime_websocket/protocol_frameless_bidi_tests.rs)
// The SDK decoder drops turn.id/item.id, so the merge must take them separately.
async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./live-types.ts");
  } catch {
    return import("./live-types.ts");
  }
}

const { extractLiveWireId, isLiveHangupRequest, parseLiveWirePayload, updateLiveTranscript } = await loadSubject();

function wire(payload) {
  const record = parseLiveWirePayload(JSON.stringify(payload));
  assert.ok(record, "fixture must parse");
  return extractLiveWireId(record);
}

test("two distinct turns with identical text are both kept", () => {
  const first = updateLiveTranscript(
    undefined,
    "네",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네" } }),
  );
  assert.equal(first?.text, "네");
  const second = updateLiveTranscript(
    first,
    "네",
    true,
    wire({ type: "turn.done", turn: { id: "turn-2", role: "user", transcript: "네" } }),
  );
  assert.equal(second?.text, "네");
  assert.equal(second?.final, true);
});
test("a retransmitted turn.done of the same turn.id is dropped once finalized", () => {
  const done = { type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네" } };
  const first = updateLiveTranscript(undefined, "네", true, wire(done));
  assert.ok(first);
  assert.equal(updateLiveTranscript(first, "네", true, wire(done)), undefined);
  // The boundary survives intervening turns: turn-1 → turn-2 → turn-1
  // retransmit must not persist again.
  const second = updateLiveTranscript(
    first,
    "아니요",
    true,
    wire({ type: "turn.done", turn: { id: "turn-2", role: "user", transcript: "아니요" } }),
  );
  assert.equal(second?.text, "아니요");
  assert.equal(updateLiveTranscript(second, "네", true, wire(done)), undefined);
});

test("a retransmitted turn.done with different text is still the same turn", () => {
  const first = updateLiveTranscript(
    undefined,
    "네",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네" } }),
  );
  const retransmit = updateLiveTranscript(
    first,
    "네, 알겠습니다",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네, 알겠습니다" } }),
  );
  assert.equal(retransmit, undefined);
});

test("a stale turn.done arriving after the next turn's partial is dropped", () => {
  const finalized = updateLiveTranscript(
    undefined,
    "네",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네" } }),
  );
  const partial = updateLiveTranscript(
    finalized,
    "다른",
    false,
    wire({ type: "input_transcript.added", item: { id: "input-2", text: "다른" } }),
  );
  assert.equal(partial?.text, "다른");
  const stale = updateLiveTranscript(
    partial,
    "네",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네" } }),
  );
  assert.equal(stale, undefined);
});

test("partial then final merges cumulatively and keeps the item id for late partials", () => {
  const partial = updateLiveTranscript(
    undefined,
    "안녕",
    false,
    wire({ type: "input_transcript.added", item: { id: "input-1", text: "안녕" } }),
  );
  assert.equal(partial?.text, "안녕");
  const grown = updateLiveTranscript(
    partial,
    "안녕하세요",
    false,
    wire({ type: "input_transcript.added", item: { id: "input-1", text: "안녕하세요" } }),
  );
  assert.equal(grown?.text, "안녕하세요");
  const done = updateLiveTranscript(
    grown,
    "안녕하세요.",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "안녕하세요." } }),
  );
  assert.equal(done?.text, "안녕하세요.");
  assert.equal(done?.final, true);
  // A late partial of the already-finalized item is a retransmission, not a new turn.
  const late = updateLiveTranscript(
    done,
    "안녕",
    false,
    wire({ type: "input_transcript.added", item: { id: "input-1", text: "안녕" } }),
  );
  assert.equal(late, undefined);
});

test("a partial of a different item after a final starts the next turn", () => {
  const done = updateLiveTranscript(
    undefined,
    "네",
    true,
    wire({ type: "turn.done", turn: { id: "turn-1", role: "user", transcript: "네" } }),
  );
  const next = updateLiveTranscript(
    done,
    "네",
    false,
    wire({ type: "input_transcript.added", item: { id: "input-2", text: "네" } }),
  );
  assert.equal(next?.text, "네");
  assert.equal(next?.final, false);
});

test("a space that ends one delta survives when the next delta is appended", () => {
  const id = wire({ type: "output_transcript.added", item: { id: "output-1", text: "x" } });
  let state;
  for (const delta of ["감사합니다. ", "체크인은 오후 ", "2시부터예요."]) {
    state = updateLiveTranscript(state, delta, false, id);
    // What the view shows never carries the trailing space of an unfinished delta.
    assert.equal(state?.text, state?.text.trim());
  }
  assert.equal(state?.text, "감사합니다. 체크인은 오후 2시부터예요.");

  // A cumulative frame with a leading space replaces the text instead of repeating it.
  const cumulative = updateLiveTranscript(updateLiveTranscript(undefined, "감사합니다. ", false, id), " 감사합니다. 체크인은", false, id);
  assert.equal(cumulative?.text, "감사합니다. 체크인은");
  // A repeated frame that adds nothing keeps the saved space for the next delta, and so does a lone space.
  let repeated = updateLiveTranscript(undefined, "오후 ", false, id);
  repeated = updateLiveTranscript(repeated, "오후", false, id);
  assert.equal(updateLiveTranscript(repeated, "2시", false, id)?.text, "오후 2시");
  let spaced = updateLiveTranscript(undefined, "네.", false, id);
  spaced = updateLiveTranscript(spaced, " ", false, id);
  assert.equal(updateLiveTranscript(spaced, "좋아요", false, id)?.text, "네. 좋아요");
});

test("a delta that says the last word again after a space is kept, not taken for a resend (issue #47)", () => {
  for (const word of ["very", "아니"]) {
    // Same item id and a fresh item id per delta, as the wire sends them.
    for (const ids of [["item-1", "item-1"], ["item-1", "item-2"]]) {
      let state = updateLiveTranscript(undefined, word, false, ids[0]);
      state = updateLiveTranscript(state, ` ${word}`, false, ids[1]);
      assert.equal(state?.text, `${word} ${word}`, `${word} ${ids.join(",")}`);
      // A trailing space on the repeated word is a separator for the next delta, not growth.
      const trailing = updateLiveTranscript(updateLiveTranscript(undefined, word, false, ids[0]), ` ${word} `, false, ids[1]);
      assert.equal(trailing?.text, `${word} ${word}`, `${word} trailing ${ids.join(",")}`);
      assert.equal(updateLiveTranscript(trailing, "!", false, ids[1])?.text, `${word} ${word} !`);
      // A complete final still replaces the partial as before.
      assert.equal(updateLiveTranscript(state, `${word} ${word}.`, true, "turn-1")?.text, `${word} ${word}.`);
    }
  }
  // A word repeated straight after a space the earlier delta ended with is kept too.
  const spaced = updateLiveTranscript(updateLiveTranscript(undefined, "아니 ", false, "i"), " 아니", false, "i");
  assert.equal(spaced?.text, "아니 아니");
  // Resends stay suppressed: the same delta again, with or without its leading space.
  const sentence = updateLiveTranscript(updateLiveTranscript(undefined, "I like", false, "i"), " very", false, "i");
  assert.equal(updateLiveTranscript(sentence, " very", false, "i")?.text, "I like very");
  assert.equal(updateLiveTranscript(sentence, "very", false, "i")?.text, "I like very");
  assert.equal(updateLiveTranscript(updateLiveTranscript(undefined, "very", false, "i"), "very", false, "i")?.text, "very");
});

test("frames without wire ids keep the previous text heuristic", () => {
  const first = updateLiveTranscript(undefined, "네", true, undefined);
  assert.equal(first?.text, "네");
  // Known limitation: identical id-less turns cannot be told apart.
  assert.equal(updateLiveTranscript(first, "네", true, undefined), undefined);
  assert.equal(updateLiveTranscript(first, "네", false, undefined), undefined);
  // A genuinely different id-less turn still lands.
  const other = updateLiveTranscript(first, "아니요", true, undefined);
  assert.equal(other?.text, "아니요");
});

test("extractLiveWireId reads turn.id and item.id and ignores other events", () => {
  assert.equal(
    wire({ type: "turn.done", turn: { id: "turn-9", role: "assistant", transcript: "x" } }),
    "turn-9",
  );
  assert.equal(wire({ type: "output_transcript.added", item: { id: "item-3", text: "x" } }), "item-3");
  assert.equal(wire({ type: "delegation.created", item: { id: "d-1" } }), undefined);
  assert.equal(wire({ type: "turn.done", turn: { role: "user", transcript: "x" } }), undefined);
  assert.equal(parseLiveWirePayload("not json"), null);
});

test("a whole-utterance end-call request is a hangup, with ordinary punctuation and spacing", () => {
  // "아… 일단 끊어": 2026-10-02 실제 통화에서 사용자가 말했는데 끊기지 않았다.
  // "알았어, 끊어봐"·"아니 통화 종료하라고": 2026-10-05 실제 통화에서 같은 일이 반복됐다.
  for (const text of ["끊어", "아, 끊어", "아 끊어.", "통화 끊어", "통화끊어줘", "통화 종료해 줘", "통화 종료해주세요!", "전화 좀 끊어 줘", "  끊어요  ", "이제 그만 끊자", "아… 일단 끊어", "아...일단 끊어", "일단 통화 끊어", "알았어, 끊어봐", "아니 통화 종료하라고", "그래 끊어 봐", "알겠어, 통화 종료해 봐", "끊으라고"]) {
    assert.equal(isLiveHangupRequest(text), true, text);
  }
});

test("negation, quotation, conditions and unrelated commands are not a hangup", () => {
  for (const text of ["", "?", "끊지 마", "끊지마 제발", "끊어라고 하면 끊어져?", "내가 끊어라고 했어", "끊어도 돼?", "아 끊어야 하나", "연결 끊어", "서버 종료해 줘", "종료해 줘", "네트워크 끊어짐", "통화 끊어졌어", "안녕하세요", "그래, 아까 그 파일 끊어서 읽어줘", "일단 끊지 마", "일단 끊어야 하나", "일단 끊어라고 했어", "일단 끊어도 돼?", "통학은 어", "통화 종료가 안 먹네", "아니 끊지 마", "끊으라고 했잖아", "끊어 봐도 돼?", "알았어, 연결 끊어봐", "통화 종료하라고 하면 끊어져?"]) {
    assert.equal(isLiveHangupRequest(text), false, text);
  }
});
