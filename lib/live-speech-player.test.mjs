import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { LiveSpeechPlayer } = await jiti.import("./live-speech-player.ts");

function fakeContext() {
  const sources = [];
  const context = {
    state: "suspended",
    currentTime: 1,
    destination: {},
    resumed: 0,
    closed: false,
    resume() { this.resumed += 1; this.state = "running"; return Promise.resolve(); },
    close() { this.closed = true; this.state = "closed"; return Promise.resolve(); },
    createBuffer(_channels, length, sampleRate) {
      const data = new Float32Array(length);
      return { duration: length / sampleRate, getChannelData: () => data, data };
    },
    createBufferSource() {
      const source = {
        buffer: null,
        onended: null,
        startedAt: undefined,
        stopped: false,
        connect() {},
        start(when) { this.startedAt = when; },
        stop() { this.stopped = true; },
      };
      sources.push(source);
      return source;
    },
  };
  return { context, sources };
}

/** `count` samples of little-endian int16 `value`, base64. */
function pcm(count, value = 16384) {
  const bytes = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) bytes.writeInt16LE(value, index * 2);
  return bytes.toString("base64");
}

test("청크를 받은 순서대로 끊김 없이 이어 예약한다", () => {
  const { context, sources } = fakeContext();
  const player = new LiveSpeechPlayer(() => context);
  player.unlock();
  assert.equal(context.resumed, 1, "사용자 조작 안에서 자동 재생 차단을 푼다");
  player.push(0, pcm(2400));
  player.push(0, pcm(4800));
  assert.equal(sources.length, 2);
  assert.ok(Math.abs(sources[0].startedAt - 1.05) < 1e-9);
  assert.ok(Math.abs(sources[1].startedAt - (1.05 + 0.1)) < 1e-9, "앞 청크 길이(0.1초) 뒤에 붙는다");
  assert.equal(sources[0].buffer.data[0], 0.5);
  assert.equal(player.speaking, true);
});

test("reset은 예약된 소리를 멈추고 그 epoch 이전 청크를 버린다", () => {
  const { context, sources } = fakeContext();
  const player = new LiveSpeechPlayer(() => context);
  player.push(0, pcm(2400));
  player.push(0, pcm(2400));
  player.reset(1);
  assert.deepEqual(sources.map((source) => source.stopped), [true, true]);
  assert.equal(player.speaking, false);
  player.push(0, pcm(2400));
  assert.equal(sources.length, 2, "끼어들기 전 대답의 늦은 청크는 재생하지 않는다");
  player.push(1, pcm(2400));
  assert.equal(sources.length, 3);
  assert.ok(Math.abs(sources[2].startedAt - 1.05) < 1e-9, "새 대답은 지금부터 시작한다");
});

test("새 epoch 청크가 먼저 오면 옛 소리를 멈추고 시작한다", () => {
  const { context, sources } = fakeContext();
  const player = new LiveSpeechPlayer(() => context);
  player.push(0, pcm(2400));
  player.push(2, pcm(2400));
  assert.equal(sources[0].stopped, true);
  assert.equal(sources.length, 2);
});

test("샘플 중간에서 끊긴 청크는 다음 청크와 이어 붙인다", () => {
  const { context, sources } = fakeContext();
  const player = new LiveSpeechPlayer(() => context);
  const whole = Buffer.from(pcm(3, -16384), "base64");
  player.push(0, whole.subarray(0, 3).toString("base64"));
  player.push(0, whole.subarray(3).toString("base64"));
  const samples = sources.flatMap((source) => [...source.buffer.data]);
  assert.deepEqual(samples, [-0.5, -0.5, -0.5]);
});

test("close는 소리를 멈추고 오디오 장치를 놓는다", () => {
  const { context, sources } = fakeContext();
  const player = new LiveSpeechPlayer(() => context);
  player.push(0, pcm(10));
  player.close();
  assert.equal(sources[0].stopped, true);
  assert.equal(context.closed, true);
});
