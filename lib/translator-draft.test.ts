import { expect, test } from "bun:test";
import { FastTranslationTurns, type FastTurn } from "./translator-draft";
import { findTranslatorLanguage } from "./translator-languages";

const mine = findTranslatorLanguage("ko")!;
const theirs = findTranslatorLanguage("ja")!;
const pcm = new Int16Array([3, 4]);

function call() {
  const turns = new Map<number, FastTurn>();
  const audio: number[] = [];
  const engine = new FastTranslationTurns({ mine, theirs }, {
    update: (turn) => { turns.set(turn.id, turn); },
    remove: (id) => { turns.delete(id); },
    play: (_, id) => audio.push(id),
    cancel: () => {},
  }, true);
  return { engine, turns, audio };
}

test("output-first text may appear, but late same-language input retracts it without playing audio", () => {
  const { engine, turns, audio } = call();
  engine.output(theirs, "明日お会いしましょう", 0);
  engine.audio(theirs, pcm, 100);
  engine.tick(900);
  expect(turns.size).toBe(1);
  expect(audio).toEqual([]);
  engine.tick(2900);
  expect([...turns.values()][0].final).toBe(true);
  engine.input(theirs, "明日お会いしましょう", 3100);
  engine.tick(4000);
  expect(turns.size).toBe(0);
  expect(audio).toEqual([]);
});

test("an unattributed result settles as text only; a later turn cannot release its PCM", () => {
  const { engine, turns, audio } = call();
  engine.input(theirs, "2026", 0);
  engine.output(theirs, "二千二十六", 150);
  engine.audio(theirs, pcm, 200);
  engine.tick(3000);
  expect([...turns.values()]).toMatchObject([{ final: true, output: "二千二十六" }]);
  engine.input(theirs, "내일 만나요", 3100);
  engine.output(theirs, "明日会いましょう", 3200);
  expect(audio).toEqual([]);
  engine.audio(theirs, pcm, 3300);
  expect(audio).toEqual([[...turns.values()][1].id]);
});

test("a speaker switch keeps both directions and does not play the previous target's echo", () => {
  const { engine, turns, audio } = call();
  for (const target of [mine, theirs]) engine.input(target, "새벽에 만나요.", 100);
  engine.output(mine, "새벽에 만나요.", 500);
  engine.audio(mine, pcm, 520);
  engine.output(theirs, "夜明けに会いましょう。", 600);
  engine.audio(theirs, pcm, 660);
  expect(audio).toEqual([[...turns.values()][0].id]);

  for (const target of [mine, theirs]) engine.input(target, "京都から出ます。", 800);
  engine.output(mine, "요.", 900); // Tail of the old same-language run.
  engine.audio(mine, pcm, 910);
  engine.audio(theirs, pcm, 950); // No longer enough evidence to attribute new packets to the old turn.
  engine.input(mine, " 早く", 2000);
  engine.output(mine, "교토에서 출발해요.", 2200);
  engine.audio(mine, pcm, 2260);
  engine.output(theirs, "京都から出ます。", 2300);
  engine.audio(theirs, pcm, 2350);
  engine.stop(2400);
  expect([...turns.values()].map(({ input, output, final }) => [input, output, final])).toEqual([
    ["새벽에 만나요.", "夜明けに会いましょう。", true],
    ["京都から出ます。 早く", "교토에서 출발해요.", true],
  ]);
  expect(audio).toEqual([...turns.keys()]);
});
