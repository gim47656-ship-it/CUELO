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

const { extractLiveWireId, parseLiveWirePayload, updateLiveTranscript } = await loadSubject();

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
