import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { closeLiveCall, createLiveCall, handleAgentEvent, handleServerEvent } = await jiti.import("./live-session.ts");
const { Settings } = await jiti.import("@oh-my-pi/pi-coding-agent/config/settings");

const settle = async () => {
  for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setImmediate(resolve));
};

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
    alias: null,
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

/** A sideband that opens at once and records what is sent, so no Codex socket is ever opened. */
class FakeSideband {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  readyState = FakeSideband.CONNECTING;
  sent = [];
  constructor(url) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = FakeSideband.OPEN;
      this.onopen?.();
    });
  }
  send(data) { this.sent.push(data); }
  close() { this.readyState = FakeSideband.CLOSED; }
}

/**
 * Runs the real offer path (signaling body, sideband attach) against a stubbed
 * Codex endpoint and returns what was signaled and answered.
 */
async function offer({ settings, voice }) {
  const signaled = [];
  const saved = {
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    runtime: globalThis.__ompRuntimePromise,
    sessions: globalThis.__ompSessions,
  };
  globalThis.fetch = async (url, init) => {
    signaled.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("answer-sdp", { status: 201, headers: { location: "/v1/realtime/calls/rtc_voice_test" } });
  };
  globalThis.WebSocket = FakeSideband;
  globalThis.__ompRuntimePromise = Promise.resolve({
    settings,
    authStorage: { oauth: { access: async () => ({ accessToken: "token", accountId: "account" }) } },
  });
  globalThis.__ompSessions = new Map([["session-voice", { isAlive: () => true, cwd: settings.getCwd(), inner: { subscribe: () => () => {} } }]]);
  try {
    const answer = await createLiveCall({ sessionId: "session-voice", sdp: "v=0", ...(voice ? { voice } : {}) });
    await closeLiveCall(answer.callId);
    return { answer, signaled };
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.WebSocket = saved.WebSocket;
    globalThis.__ompRuntimePromise = saved.runtime;
    globalThis.__ompSessions = saved.sessions;
  }
}

test("통화는 설정한 live.voice(haetsal)로 Codex 신호를 보내고, 설정이 없으면 sol이다", async () => {
  const configured = await offer({ settings: Settings.isolated({ "live.voice": "haetsal" }) });
  assert.equal(configured.signaled.length, 1);
  assert.equal(configured.signaled[0].body.session.audio.output.voice, "haetsal");
  assert.equal(configured.answer.callId, "rtc_voice_test");
  assert.equal(configured.answer.sdp, "answer-sdp");

  const unset = await offer({ settings: Settings.isolated() });
  assert.equal(unset.signaled[0].body.session.audio.output.voice, "sol");
});

test("요청이 목소리를 직접 고르면 설정보다 앞선다", async () => {
  const { signaled } = await offer({ settings: Settings.isolated({ "live.voice": "haetsal" }), voice: "hanul" });
  assert.equal(signaled[0].body.session.audio.output.voice, "hanul");
});
