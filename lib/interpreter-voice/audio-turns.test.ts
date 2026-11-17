import { expect, test } from "bun:test";
import { AudioTurns, overlapDetected, SPEAKER_BUFFER_MS, type AudioTurn } from "./audio-turns";
import { confidentSide, languageSide, singleVoiceSide, speakerBoundary } from "./speakers";
import { shouldChunkMonologue } from "./chunks";
import { TRANSLATOR_LANGUAGES } from "../translator-languages";
const voiced = () => new Int16Array(2400).fill(8000);
const quiet = () => new Int16Array(2400);
function capture(holdMs = 0) {
  const committed: AudioTurn[] = [], sent: { id: number; samples: number }[] = [];
  const turns = new AudioTurns({ open: () => {}, append: (audio, turn) => sent.push({ id: turn.id, samples: audio.length }), commit: (turn) => committed.push({ ...turn }) });
  turns.holdMs = holdMs;
  return { turns, committed, sent };
}
test("400 ms silence commits once, flushes rolling audio and never commits idle silence", () => {
  const { turns, committed, sent } = capture(SPEAKER_BUFFER_MS);
  for (let i = 0; i < 10; i++) turns.push(voiced(), "me");
  expect(sent).toHaveLength(0);
  for (let i = 0; i < 4; i++) turns.push(quiet());
  expect(committed).toEqual([{ id: 0, startMs: 0, endMs: 1000, side: "me" }]);
  expect(sent.reduce((n, x) => n + x.samples, 0)).toBe(14 * 2400);
  for (let i = 0; i < 10; i++) turns.push(quiet());
  turns.finish();
  expect(committed).toHaveLength(1);
});
test("buffered speaker boundary rewinds detection lag without losing or duplicating samples", () => {
  const { turns, committed, sent } = capture(SPEAKER_BUFFER_MS);
  for (let i = 0; i < 30; i++) turns.push(voiced(), "me");
  turns.identify("them", 2500);
  expect(committed[0]).toEqual({ id: 0, startMs: 0, endMs: 2500, side: "me" });
  for (let i = 0; i < 20; i++) turns.push(voiced());
  turns.finish();
  expect(committed.map((item) => [item.side, item.startMs, item.endMs])).toEqual([["me", 0, 2500], ["them", 2500, 5000]]);
  expect(sent.filter((item) => item.id === 0).reduce((n, x) => n + x.samples, 0)).toBe(60000);
  expect(sent.reduce((n, x) => n + x.samples, 0)).toBe(120000);
});
test("a boundary already sent cuts at detection, never retroactively", () => {
  const { turns, committed } = capture();
  for (let i = 0; i < 30; i++) turns.push(voiced(), "me");
  turns.identify("them", 2500);
  expect(committed).toHaveLength(1);
  expect(committed[0].endMs).toBe(3000);
  turns.push(voiced()); turns.finish();
  expect(committed[1].side).toBe("them");
});
test("short and low-confidence voice matches never switch speakers; clear margins do", () => {
  expect(confidentSide([{ side: "them", score: 0.9 }], 0.3)).toBeUndefined();
  expect(confidentSide([{ side: "them", score: 0.4 }], 1)).toBeUndefined();
  expect(confidentSide([{ side: "them", score: 0.65 }, { side: "me", score: 0.6 }], 1)).toBeUndefined();
  expect(confidentSide([{ side: "me", score: 0.2 }, { side: "them", score: 0.75 }], 1)).toBe("them");
  expect(languageSide("この店の김치찌개を二つください", TRANSLATOR_LANGUAGES[0], TRANSLATOR_LANGUAGES[3])).toBe("them");
});
test("overlap uses powerset overlap frames and minimum support, not speaker changes", () => {
  expect(overlapDetected(1, 5)).toBe(false);
  expect(overlapDetected(2, 10)).toBe(true);
  expect(overlapDetected(9, 100)).toBe(false);
  expect(overlapDetected(10, 100)).toBe(true);
  expect(overlapDetected(0, 0)).toBe(false);
});
test("new utterance's first confident voice replaces the provisional previous side without a phantom split", () => {
  const { turns, committed } = capture(SPEAKER_BUFFER_MS);
  for (let i = 0; i < 12; i++) turns.push(voiced(), "me");
  for (let i = 0; i < 4; i++) turns.push(quiet());
  for (let i = 0; i < 12; i++) turns.push(voiced());
  turns.identify("them", turns.now - 500);
  expect(committed).toHaveLength(1);
  expect(turns.current?.side).toBe("them");
  turns.finish();
  expect(committed.map((turn) => turn.side)).toEqual(["me", "them"]);
});
test("score crossover estimates the audio boundary rather than the worker arrival time", () => {
  const boundary = speakerBoundary({ endMs: 3000, matches: [{ side: "me", score: .5 }, { side: "them", score: .3 }] },
    { endMs: 3250, matches: [{ side: "me", score: .1 }, { side: "them", score: .5 }] }, "me", "them");
  expect(boundary).toBeCloseTo(2583.333, 2);
});
test("artificial monologue chunks require a minimum clause, unlike real short replies", () => {
  expect(shouldChunkMonologue("네.", 20000)).toBe(false);
  expect(shouldChunkMonologue("긴 문장".repeat(15) + ".", 7000)).toBe(false);
  expect(shouldChunkMonologue("긴 문장".repeat(15) + ".", 8000)).toBe(true);
  expect(shouldChunkMonologue("긴 문장".repeat(15), 10000)).toBe(false);
  expect(shouldChunkMonologue("긴 문장".repeat(15), 15000)).toBe(true);
});
test("one enrolled voice assigns clearly distinct voices; uncertainty is not a voice change", () => {
  expect(singleVoiceSide([{ side: "me", score: 0.2 }], 1)).toBe("them");
  expect(singleVoiceSide([{ side: "me", score: 0.4 }], 1)).toBeUndefined();
  expect(singleVoiceSide([{ side: "me", score: 0.2 }], .3)).toBeUndefined();
  expect(singleVoiceSide([{ side: "me", score: .3 }, { side: "them", score: .3 }], 1)).toBeUndefined();
});
test("R4-ANT-2: single-profile score crossing rewinds the boundary in both directions", () => {
  expect(speakerBoundary({ endMs: 3000, matches: [{ side: "me", score: .8 }] }, { endMs: 3250, matches: [{ side: "me", score: .1 }] }, "me", "them")).toBe(2625);
  expect(speakerBoundary({ endMs: 3000, matches: [{ side: "me", score: .1 }] }, { endMs: 3250, matches: [{ side: "me", score: .8 }] }, "them", "me")).toBe(2625);
});
