import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { CharacterSpeech, speakableEnd, speechLanguage } = await jiti.import("./live-speech.ts");

function fakeSocketFactory() {
  const sockets = [];
  const factory = (url, apiKey) => {
    const socket = {
      url,
      apiKey,
      readyState: 0,
      sent: [],
      closed: false,
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(frame) { this.sent.push(JSON.parse(frame)); },
      close() { this.closed = true; this.readyState = 3; },
      open() { this.readyState = 1; this.onopen?.({}); },
      receive(message) { this.onmessage?.({ data: JSON.stringify(message) }); },
      drop() { this.readyState = 3; this.onclose?.({}); },
    };
    sockets.push(socket);
    return socket;
  };
  return { sockets, factory };
}

function setup() {
  const { sockets, factory } = fakeSocketFactory();
  const events = [];
  const fatal = [];
  const speech = new CharacterSpeech({
    apiKey: "sk_car_secret",
    model: "sonic-3.6",
    voice: { voiceId: "voice-yuki", generation: { emotion: "excited", speed: 1.2, volume: 1 } },
    defaultLanguage: "ko",
    emit: (event) => events.push(event),
    onFatal: (message) => fatal.push(message),
    openSocket: factory,
  });
  speech.connect();
  sockets[0].open();
  return { speech, socket: sockets[0], sockets, events, fatal };
}

const texts = (socket) => socket.sent.filter((frame) => "transcript" in frame).map((frame) => [frame.transcript, frame.continue]);
const audio = (events) => events.filter((event) => event.type === "speech").map((event) => `${event.epoch}:${event.audio}`);

test("문장 경계까지만 이어 보내고 마지막 조각은 turn.done에서 닫는다", () => {
  const { speech, socket } = setup();
  assert.match(socket.url, /cartesia_version=2026-08-14/);
  assert.equal(socket.apiKey, "sk_car_secret");
  speech.assistantText("안녕", false);
  speech.assistantText("안녕, 오늘", false);
  speech.assistantText("안녕, 오늘 뭐 할까? 테스트", false);
  speech.assistantText("안녕, 오늘 뭐 할까? 테스트 해 보자.", true);
  assert.deepEqual(texts(socket), [
    ["안녕, ", true],
    ["오늘 뭐 할까? ", true],
    ["테스트 해 보자.", false],
  ]);
  const [first] = socket.sent;
  assert.equal(first.voice, "voice-yuki");
  assert.equal(first.language, "ko");
  assert.deepEqual(first.generation_config, { speed: 1.2, volume: 1, emotion: "excited" });
  assert.deepEqual(first.output_format, { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 });
  assert.equal(new Set(socket.sent.map((frame) => frame.context_id)).size, 1, "한 발화는 한 context");
});

test("끼어들면 남은 context를 취소하고 새 epoch 이전 청크는 내보내지 않는다", () => {
  const { speech, socket, events } = setup();
  speech.assistantText("길게 설명할게. 먼저", false);
  const contextId = socket.sent[0].context_id;
  socket.receive({ type: "chunk", context_id: contextId, data: "AAA", done: false });
  speech.reset();
  assert.deepEqual(socket.sent.at(-1), { context_id: contextId, cancel: true });
  socket.receive({ type: "chunk", context_id: contextId, data: "LATE", done: false });
  assert.deepEqual(audio(events), ["0:AAA"]);
  assert.deepEqual(events.filter((event) => event.type === "speech-reset"), [{ type: "speech-reset", epoch: 1 }]);

  speech.assistantText("응, 말해.", true);
  const next = socket.sent.at(-1);
  assert.notEqual(next.context_id, contextId);
  socket.receive({ type: "chunk", context_id: next.context_id, data: "BBB", done: false });
  assert.deepEqual(audio(events), ["0:AAA", "1:BBB"]);
});

test("말한 것이 없으면 사용자 발화마다 reset을 알리지 않는다", () => {
  const { speech, events } = setup();
  speech.reset();
  speech.reset();
  assert.deepEqual(events, []);
});

test("앞 발화가 끝나기 전 다음 발화의 소리는 기다렸다가 순서대로 나온다", () => {
  const { speech, socket, events } = setup();
  speech.assistantText("첫 번째 대답.", true);
  const first = socket.sent[0].context_id;
  speech.assistantText("두 번째 대답.", true);
  const second = socket.sent[1].context_id;
  socket.receive({ type: "chunk", context_id: second, data: "S1", done: false });
  socket.receive({ type: "chunk", context_id: first, data: "F1", done: false });
  assert.deepEqual(audio(events), ["0:F1"]);
  socket.receive({ type: "done", context_id: first, done: true });
  socket.receive({ type: "chunk", context_id: second, data: "S2", done: false });
  assert.deepEqual(audio(events), ["0:F1", "0:S1", "0:S2"]);
});

test("캐릭터가 바뀌면 이전 소리를 먼저 지우고 다음 발화부터 새 voice로 보낸다", () => {
  const { speech, socket, events } = setup();
  speech.assistantText("유키가 말하는 중.", true);
  socket.receive({ type: "chunk", context_id: socket.sent[0].context_id, data: "Y", done: false });
  speech.setVoice({ voiceId: "voice-rin", generation: { speed: 1, volume: 1 } });
  assert.equal(events.at(-1).type, "speech-reset");
  speech.assistantText("린이야.", true);
  const frame = socket.sent.at(-1);
  assert.equal(frame.voice, "voice-rin");
  assert.deepEqual(frame.generation_config, { speed: 1, volume: 1 });
});

test("provider 오류와 말하는 중 끊김은 통화를 끝내게 알리고, 쉬는 중 끊김은 다시 연다", () => {
  const first = setup();
  first.speech.assistantText("말하는 중.", true);
  first.socket.receive({ type: "error", context_id: first.socket.sent[0].context_id, status_code: 402, title: "Payment Required", message: "Out of credits" });
  assert.deepEqual(first.fatal, ["Cartesia 402: Payment Required: Out of credits"]);
  assert.equal(first.socket.closed, true);

  const idle = setup();
  idle.socket.drop();
  assert.deepEqual(idle.fatal, []);
  idle.speech.assistantText("다시 말할게.", true);
  assert.equal(idle.sockets.length, 2);
  idle.sockets[1].open();
  assert.deepEqual(texts(idle.sockets[1]), [["다시 말할게.", false]]);

  const speaking = setup();
  speaking.speech.assistantText("끊기기 전.", true);
  speaking.socket.drop();
  assert.deepEqual(speaking.fatal, ["Cartesia 음성 연결이 끊겼습니다."]);
});

test("닫은 뒤 들어온 전사와 청크는 아무것도 보내거나 내보내지 않는다", () => {
  const { speech, socket, events } = setup();
  speech.close();
  const sent = socket.sent.length;
  speech.assistantText("늦은 전사.", true);
  socket.onmessage?.({ data: JSON.stringify({ type: "chunk", context_id: "x", data: "Z" }) });
  assert.equal(socket.sent.length, sent);
  assert.deepEqual(events, []);
});

test("고쳐 쓴 전사는 이미 말한 부분을 다시 말하지 않는다", () => {
  const { speech, socket, events } = setup();
  speech.assistantText("오늘은 맑아요. 그리고", false);
  speech.assistantText("오늘은 흐려요.", true);
  assert.deepEqual(texts(socket), [["오늘은 맑아요. ", true]]);
  // 닫을 조각이 없는 발화가 다음 발화를 막지 않는다.
  speech.assistantText("다음 발화.", true);
  const next = socket.sent.at(-1).context_id;
  socket.receive({ type: "chunk", context_id: next, data: "N", done: false });
  assert.deepEqual(audio(events), ["0:N"]);
});

test("경계·언어 판정", () => {
  assert.equal(speakableEnd("끝.", 0), 0, "끝의 경계는 보류한다");
  assert.equal(speakableEnd("こんにちは。元気", 0), "こんにちは。".length);
  const long = `${"단어 ".repeat(40)}끝`;
  assert.ok(speakableEnd(long, 0) > 0, "구두점이 없어도 너무 길면 공백에서 끊는다");
  assert.equal(speechLanguage("hello 안녕", "en"), "ko");
  assert.equal(speechLanguage("やった", "ko"), "ja");
  assert.equal(speechLanguage("hello", "en"), "en");
});

test("연결 전에 끼어들면 쌓여 있던 옛 전사는 열린 뒤에도 보내지 않는다", () => {
  const { sockets, factory } = fakeSocketFactory();
  const events = [];
  const speech = new CharacterSpeech({
    apiKey: "sk_car_secret",
    model: "sonic-3.6",
    voice: { voiceId: "voice-yuki", generation: { speed: 1, volume: 1 } },
    defaultLanguage: "ko",
    emit: (event) => events.push(event),
    onFatal: () => {},
    openSocket: factory,
  });
  speech.assistantText("버려질 긴 설명이야. 계속", false);
  speech.reset();
  speech.assistantText("새 대답.", true);
  sockets[0].open();
  assert.deepEqual(texts(sockets[0]), [["새 대답.", false]]);
  assert.equal(sockets[0].sent.some((frame) => frame.cancel), false, "provider가 모르는 context는 취소할 것도 없다");
  speech.reset();
  assert.deepEqual(sockets[0].sent.at(-1), { context_id: sockets[0].sent[0].context_id, cancel: true }, "열린 뒤 보낸 발화는 취소한다");
});

test("provider 오류 문구나 연결 예외에 키가 섞여 와도 내보내는 오류에는 없다", () => {
  const { speech, socket, fatal } = setup();
  speech.assistantText("말해 볼게.", true);
  socket.receive({ type: "error", context_id: socket.sent[0].context_id, title: "Unauthorized", message: "bad key sk_car_secret for org" });
  assert.equal(fatal.length, 1);
  assert.ok(!fatal[0].includes("sk_car_secret"));
  assert.match(fatal[0], /\[redacted\]/);

  const thrown = [];
  const broken = new CharacterSpeech({
    apiKey: "sk_car_secret",
    model: "sonic-3.6",
    voice: { voiceId: "voice-yuki", generation: { speed: 1, volume: 1 } },
    defaultLanguage: "ko",
    emit: () => {},
    onFatal: (message) => thrown.push(message),
    openSocket: () => { throw new Error("connect failed with header X-API-Key: sk_car_secret"); },
  });
  broken.connect();
  assert.equal(thrown.length, 1);
  assert.ok(!thrown[0].includes("sk_car_secret"));
});
