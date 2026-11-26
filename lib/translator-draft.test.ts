import { expect, test } from "bun:test";
import { FastTranslationTurns, type FastTurn } from "./translator-draft";
import { findTranslatorLanguage } from "./translator-languages";

const mine = findTranslatorLanguage("ko")!;
const theirs = findTranslatorLanguage("ja")!;
const pcm = new Int16Array([3, 4]);

function call(pair = { mine, theirs }) {
  const turns = new Map<number, FastTurn>();
  const audio: number[] = [];
  const packets: number[] = [];
  const engine = new FastTranslationTurns(pair, {
    update: (turn) => { turns.set(turn.id, turn); },
    remove: (id) => { turns.delete(id); },
    play: (samples, id) => { audio.push(id); packets.push(samples[0]); },
    cancel: () => {},
  }, true);
  return { engine, turns, audio, packets };
}

test("output with no input transcript never appears, and late same-language input keeps it hidden", () => {
  const { engine, turns, audio } = call();
  engine.output(theirs, "明日お会いしましょう", 0);
  engine.audio(theirs, pcm, 100);
  engine.tick(900);
  engine.tick(2900);
  expect(turns.size).toBe(0);
  engine.input(theirs, "明日お会いしましょう", 3100);
  engine.tick(4000);
  expect(turns.size).toBe(0);
  expect(audio).toEqual([]);
});

test("a translation tail arriving after its turn settled does not become its own bubble", () => {
  // 2026-11-26 ko→ja log: 「안녕하세요」 showed as やあ, then みなさん and こんにちは without input.
  const { engine, turns } = call();
  engine.input(theirs, " 안녕하세요", 0);
  engine.output(theirs, "やあ", 300);
  engine.tick(4000);
  engine.output(theirs, "みなさん", 10_000);
  engine.tick(11_000);
  engine.tick(14_000);
  engine.output(theirs, "こんにちは", 17_000);
  engine.tick(21_000);
  expect([...turns.values()].map((turn) => turn.output)).toEqual(["やあ"]);
});

test("output that comes before its input transcript appears once the input arrives", () => {
  const { engine, turns } = call();
  engine.output(theirs, "明日会いましょう", 0);
  engine.tick(900);
  expect(turns.size).toBe(0);
  engine.input(theirs, "내일 만나요", 1000);
  expect([...turns.values()]).toMatchObject([{ input: "내일 만나요", output: "明日会いましょう" }]);
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

test("recorded Korean to Japanese prefix and tail do not wait for the output transcript", () => {
  const { engine, packets } = call();
  // ko-ja-ko.wav: original arrival times rounded to ms; use packet numbers instead of 24 kHz PCM.
  const times = [2269, 2663, 3068, 3474, 3879, 4281, 4685, 5090, 5493, 5892, 6303, 6710, 7101,
    7506, 7940, 8398, 8863, 9240, 9630, 10030, 10424, 10781, 11119, 11509, 11910, 12324];
  for (const [index, at] of times.entries()) {
    if (index === 2) {
      engine.input(theirs, " 안", 2918);
      engine.input(theirs, "녕하세요", 2956);
      expect(packets).toEqual([0, 1]);
    }
    if (index === 14) engine.output(theirs, "駅", 7698);
    engine.tick(at);
    engine.audio(theirs, Int16Array.of(index), at);
  }
  expect(packets).toEqual(times.map((_, i) => i));
});

test("a new speaker does not inherit held audio even while the previous run keeps arriving", () => {
  const { engine, packets } = call();
  engine.input(theirs, "2026", 0); // No identifiable source in this turn.
  for (let i = 1; i <= 4; i++) engine.audio(theirs, Int16Array.of(i), 390 * i);
  engine.input(theirs, "다음 사람이에요", 1600);
  engine.audio(theirs, Int16Array.of(5), 1700); // Could still belong to the first speaker.
  expect(packets).toEqual([]);
  engine.input(theirs, " 반갑습니다", 2850);
  engine.audio(theirs, Int16Array.of(6), 3000);
  expect(packets).toEqual([6]);
});

test("voice off discards pre-roll, including packets arriving before a transcript", () => {
  const { engine, packets } = call();
  engine.audio(theirs, Int16Array.of(1), 0);
  engine.setVoice(false);
  engine.audio(theirs, Int16Array.of(2), 200);
  engine.setVoice(true);
  engine.input(theirs, "안녕하세요", 300);
  engine.audio(theirs, Int16Array.of(3), 400);
  expect(packets).toEqual([3]);
});

test("audio-first same-language input discards the entire echo run", () => {
  const { engine, packets } = call();
  engine.audio(theirs, Int16Array.of(1), 0);
  engine.input(theirs, "こんにちは", 650);
  engine.audio(theirs, Int16Array.of(2), 900);
  engine.stop(1100);
  expect(packets).toEqual([]);
});

test("a second sentence in the same source language keeps its continuous audio run", () => {
  const { engine, packets } = call();
  for (let i = 0; i <= 20; i++) {
    if (i === 1) engine.input(theirs, "안녕하세요.", 100);
    if (i === 5) engine.input(theirs, "내일 봐요.", 1650);
    if (i === 15) engine.output(theirs, "明日", 6000);
    engine.audio(theirs, Int16Array.of(i), 400 * i);
  }
  expect(packets).toEqual(Array.from({ length: 21 }, (_, i) => i));
});

test("fresh audio after a gap waits for fresh source evidence, not the last turn", () => {
  const { engine, packets } = call();
  engine.input(theirs, "안녕하세요.", 0);
  engine.output(theirs, "こんにちは", 300);
  engine.audio(theirs, Int16Array.of(1), 400);
  engine.tick(1640);
  engine.audio(theirs, Int16Array.of(2), 1650);
  engine.input(theirs, "ありがとう", 1950);
  engine.stop(2000);
  expect(packets).toEqual([1]);
});

test("Japanese and Taiwan Chinese keep the same text-only safety rule as Japanese and Chinese", () => {
  const tw = findTranslatorLanguage("zh-tw")!;
  for (const pair of [{ mine: theirs, theirs: tw }, { mine: tw, theirs }]) {
    const { engine, packets } = call(pair);
    engine.input(tw, "ありがとうございます", 100);
    engine.audio(tw, pcm, 200);
    expect(packets).toEqual([]);
  }
});
