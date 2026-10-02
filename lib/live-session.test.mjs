import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { handleAgentEvent, handleServerEvent } = await jiti.import("./live-session.ts");

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A character call whose Main lookup is held open by `gate`, so assistant frames
 * can arrive while the switch is still being resolved. Speech records which
 * voice each transcript was sent with.
 */
function fixture({ accounts }) {
  let open;
  const gate = new Promise((resolve) => { open = resolve; });
  const events = [];
  const sent = [];
  let voiceId = "voice-yuki";
  const lookups = { count: 0 };
  const speech = {
    assistantText: (text, final) => sent.push(["text", voiceId, text, final]),
    reset: () => sent.push(["reset"]),
    setVoice: (voice) => {
      sent.push(["reset"]);
      voiceId = voice.voiceId;
    },
    close: () => {},
  };
  const call = {
    callId: "call-test",
    sessionId: "session-test",
    state: "live",
    listeners: new Set([(event) => events.push(event)]),
    activeDelegationId: undefined,
    sendTail: Promise.resolve(),
    persistTail: Promise.resolve(),
    transcripts: { user: { text: "", final: false }, assistant: { text: "", final: false } },
    closed: false,
    voice: { mode: "character", alias: "YUKI(유키)", tuning: "accepted" },
    speech,
    speechKey: "sk_car_key",
    characterCheck: Promise.resolve(),
    speechHold: 0,
    speechGen: 0,
  };
  const wrapper = {
    inner: {
      model: { provider: "anthropic", id: "claude" },
      listCurrentProviderOAuthAccounts: async () => {
        lookups.count += 1;
        await gate;
        return { provider: "anthropic", accounts };
      },
      agent: { appendMessage: () => {} },
      sessionManager: { appendCustomMessageEntry: () => {}, ensureOnDisk: async () => {}, flush: async () => {} },
    },
  };
  globalThis.__liveVoiceService = {
    planFor: async (alias) => ({
      kind: "ready",
      alias,
      apiKey: "sk_car_key",
      voiceId: `voice-${alias}`,
      profile: { generation: { speed: 1, volume: 1 }, tuning: "provisional" },
    }),
  };
  const deliver = (event) => handleServerEvent(call, wrapper, event, undefined);
  return { call, deliver, events, sent, open, lookups };
}

test.afterEach(() => {
  delete globalThis.__liveVoiceService;
});

test("Main 확인이 끝나기 전에 온 답은 기다렸다가 새 캐릭터 목소리로만 보낸다", async () => {
  const { deliver, events, sent, open } = fixture({ accounts: [{ active: true, position: 0 }] });
  deliver({ type: "turn.done", turn: { role: "user", transcript: "린으로 바꿔 줘" } });
  deliver({ type: "output_transcript.added", item: { text: "응, 이제 린이야. 계속" } });
  deliver({ type: "turn.done", turn: { role: "assistant", transcript: "응, 이제 린이야. 계속 말할게." } });
  assert.deepEqual(sent, [], "확인 전에는 아무 목소리로도 보내지 않는다");
  open();
  await settle();
  assert.deepEqual(sent, [
    ["reset"],
    ["text", "voice-RIN(린)", "응, 이제 린이야. 계속", false],
    ["text", "voice-RIN(린)", "응, 이제 린이야. 계속 말할게.", true],
  ]);
  assert.deepEqual(events.filter((event) => event.type === "voice").map((event) => event.voice.alias), ["RIN(린)"]);
  // 다음 응답도 첫 프레임에서 Main을 다시 확인하고(그사이 바뀌었을 수 있다), 그 뒤 같은 목소리로 나간다.
  deliver({ type: "output_transcript.added", item: { text: "다음 답" } });
  await settle();
  assert.deepEqual(sent.at(-1), ["text", "voice-RIN(린)", "다음 답", false]);
});

// 실제 WebRTC 관측(.omp/private-tts/rtc-switch-071.json): 통화 중 RIN 프리셋으로 바꾼 뒤 말하자
// 순서가 user partial … → assistant partial → user partial(같은 발화의 늦은 ASR) … → assistant partial
// → user final → assistant partial → assistant final 이었고, 첫 프레임들이 YUKI 목소리로 나갔다.
const OBSERVED_ORDER = [
  { type: "input_transcript.added", item: { text: "안녕! 한 문" } },
  { type: "input_transcript.added", item: { text: "안녕! 한 문장으로" } },
  { type: "output_transcript.added", item: { text: "안녕! " } },
  { type: "input_transcript.added", item: { text: "안녕! 한 문장으로 짧" } },
  { type: "input_transcript.added", item: { text: "안녕! 한 문장으로 짧게" } },
  { type: "output_transcript.added", item: { text: "안녕! 린이야. " } },
  { type: "output_transcript.added", item: { text: "안녕! 린이야. 반가" } },
  { type: "turn.done", turn: { role: "user", transcript: "안녕! 한 문장으로 짧게 인사해줘." } },
  { type: "output_transcript.added", item: { text: "안녕! 린이야. 반가워" } },
  { type: "turn.done", turn: { role: "assistant", transcript: "안녕! 린이야. 반가워." } },
];
const ANSWER_FRAMES = [
  ["text", "voice-RIN(린)", "안녕!", false],
  ["text", "voice-RIN(린)", "안녕! 린이야.", false],
  ["text", "voice-RIN(린)", "안녕! 린이야. 반가", false],
  ["text", "voice-RIN(린)", "안녕! 린이야. 반가워", false],
  ["text", "voice-RIN(린)", "안녕! 린이야. 반가워.", true],
];

test("assistant 부분 전사가 사용자 최종 턴보다 먼저 와도 첫 프레임부터 새 Main 목소리로만, 한 번만 보낸다", async () => {
  const { deliver, events, sent, open, lookups } = fixture({ accounts: [{ active: true, position: 0 }] });
  for (const event of OBSERVED_ORDER) deliver(event);
  assert.equal(sent.some((entry) => entry[0] === "text"), false, "확인 전에는 옛 목소리 프레임이 하나도 없다");
  open();
  await settle();
  // 사용자 발화 시작의 끼어들기 reset, 전환의 reset 뒤로는 응답이 처음부터 끝까지 한 번만 나간다.
  assert.deepEqual(sent.slice(sent.findIndex((entry) => entry[0] === "text")), ANSWER_FRAMES);
  assert.deepEqual(events.filter((event) => event.type === "voice").map((event) => event.voice.alias), ["RIN(린)"]);
  assert.equal(lookups.count, 1, "응답 하나에 확인은 한 번");
});

test("확인이 먼저 끝나 말하기 시작한 응답은 늦게 온 사용자 partial·final이 다시 시작시키지 않는다", async () => {
  const { deliver, sent, open, lookups } = fixture({ accounts: [{ active: true, position: 0 }] });
  open();
  for (const event of OBSERVED_ORDER) {
    deliver(event);
    await settle();
  }
  assert.deepEqual(sent.slice(sent.findIndex((entry) => entry[0] === "text")), ANSWER_FRAMES, "첫 프레임 뒤에 reset도 같은 문장의 재전송도 없다");
  assert.equal(lookups.count, 1);
  // 응답이 끝난 뒤 새로 말하기 시작하면 그건 끼어들기다.
  deliver({ type: "input_transcript.added", item: { text: "그리고" } });
  assert.deepEqual(sent.at(-1), ["reset"]);
});

test("final만 오는 assistant 턴도 먼저 Main을 확인한다", async () => {
  const { deliver, sent, open, lookups } = fixture({ accounts: [{ active: true, position: 0 }] });
  deliver({ type: "turn.done", turn: { role: "assistant", transcript: "짧은 대답." } });
  assert.deepEqual(sent, []);
  open();
  await settle();
  assert.deepEqual(sent.filter((entry) => entry[0] === "text"), [["text", "voice-RIN(린)", "짧은 대답.", true]]);
  assert.equal(lookups.count, 1);
});

test("바뀐 Main을 확인하지 못하면 옛 목소리로 말하지 않고 통화를 끝낸다", async () => {
  const { call, deliver, events, sent, open } = fixture({ accounts: [{ active: false, position: 0 }, { active: false, position: 1 }] });
  deliver({ type: "turn.done", turn: { role: "user", transcript: "다른 캐릭터로" } });
  deliver({ type: "output_transcript.added", item: { text: "안녕, 누구일까" } });
  open();
  await settle();
  assert.equal(sent.some((entry) => entry[0] === "text"), false, "옛 목소리 프레임이 하나도 없다");
  assert.equal(events.filter((event) => event.type === "speech-error").length, 1);
  assert.equal(call.voice.alias, "YUKI(유키)");
  deliver({ type: "output_transcript.added", item: { text: "안녕, 누구일까. 그 뒤 답" } });
  assert.equal(sent.some((entry) => entry[0] === "text"), false, "끝내기로 한 뒤 들어온 답도 보내지 않는다");
});

test("확인을 기다리는 사이 사용자가 끼어들면 줄 선 옛 답은 버린다", async () => {
  const { deliver, sent, open } = fixture({ accounts: [{ active: true, position: 0 }] });
  deliver({ type: "turn.done", turn: { role: "user", transcript: "린으로" } });
  deliver({ type: "output_transcript.added", item: { text: "버려질 답이야. 길게" } });
  deliver({ type: "input_transcript.added", item: { text: "잠깐만" } });
  open();
  await settle();
  assert.equal(sent.some((entry) => entry[0] === "text"), false, "끼어들기 전 답은 합성하지 않는다");
});

/** A call whose sideband records every frame the server would send to Codex. */
function relayFixture(messages = []) {
  const frames = [];
  const call = {
    callId: "call-relay",
    sessionId: "session-relay",
    state: "connecting",
    listeners: new Set(),
    activeDelegationId: undefined,
    sendTail: Promise.resolve(),
    closed: false,
    sideband: { readyState: WebSocket.OPEN, send: (data) => frames.push(JSON.parse(data)) },
    voice: { mode: "native", alias: undefined, reason: "no-key" },
  };
  const wrapper = { inner: { messages } };
  const text = (frame) => frame.content.map((item) => item.text).join("");
  return { call, wrapper, frames, text };
}

test("통화가 열리면 최근 Main 대화와 지난 통화 턴을 오래된 순서로, 읽지 않을 배경으로 넘긴다", async () => {
  const { call, wrapper, frames, text } = relayFixture([
    { role: "user", content: "빌드 고쳐 줘" },
    { role: "assistant", content: [{ type: "text", text: "빌드 고쳤어" }, { type: "toolCall", id: "t", name: "bash", arguments: {} }] },
    { role: "toolResult", content: [{ type: "text", text: "exit 0" }] },
    { role: "custom", customType: "todo-reminder", content: "todo" },
    { role: "custom", customType: "live-transcript", content: "User (live voice):\n아까 그거 됐어?", details: { role: "user" } },
  ]);
  handleServerEvent(call, wrapper, { type: "session.started", session: { id: "s" } }, undefined);
  await settle();
  assert.ok(frames.length > 0);
  assert.ok(frames.every((frame) => frame.type === "session.context.append" && frame.channel === "commentary"));
  const history = frames.map(text).join("");
  assert.ok(history.endsWith("User: 빌드 고쳐 줘\nAssistant: 빌드 고쳤어\nUser (voice): 아까 그거 됐어?"), history);
  assert.equal(history.includes("exit 0") || history.includes("todo"), false, "도구 결과와 다른 custom은 빠진다");
});

test("이력이 없는 세션은 통화 시작 때 아무것도 보내지 않는다", async () => {
  const { call, wrapper, frames } = relayFixture([]);
  handleServerEvent(call, wrapper, { type: "session.started", session: { id: "s" } }, undefined);
  await settle();
  assert.deepEqual(frames, []);
});

test("통화 중 채팅으로 끝난 Main 턴은 요청은 배경으로, 답은 읽을 최종 답으로 넘긴다", async () => {
  const { call, frames, text } = relayFixture();
  handleAgentEvent(call, {
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "테스트 돌려 줘" }] },
      { role: "assistant", content: [{ type: "text", text: "돌릴게" }], stopReason: "toolUse" },
      { role: "assistant", content: [{ type: "text", text: "테스트 12개 통과" }], stopReason: "stop" },
    ],
  });
  await settle();
  assert.equal(frames.length, 2);
  assert.equal(frames[0].channel, "commentary");
  assert.ok(text(frames[0]).includes("User: 테스트 돌려 줘"));
  assert.equal(frames[1].type, "session.context.append");
  assert.equal(frames[1].channel, undefined);
  assert.ok(text(frames[1]).includes("테스트 12개 통과"));
  assert.equal(text(frames[1]).includes("돌릴게"), false, "도구 사용 중간 문장은 최종 답이 아니다");
});

test("위임한 턴의 답은 그대로 위임 채널로 가고 session 채널로 중복되지 않는다", async () => {
  const { call, frames } = relayFixture();
  call.activeDelegationId = "item-1";
  handleAgentEvent(call, { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "끝났어" }] }] });
  await settle();
  assert.ok(frames.length > 0);
  assert.ok(frames.every((frame) => frame.type === "delegation.context.append" && frame.delegation_item_id === "item-1"));
  assert.equal(call.activeDelegationId, undefined);
});

test("중간 agent_end와 답 없는 턴은 아무것도 읽게 하지 않는다", async () => {
  const { call, frames } = relayFixture();
  handleAgentEvent(call, { type: "agent_end", isTerminal: false, messages: [{ role: "assistant", content: "중간" }] });
  handleAgentEvent(call, { type: "agent_end", messages: [{ role: "user", content: "취소" }] });
  await settle();
  assert.deepEqual(frames, []);
});
