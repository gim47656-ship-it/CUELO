import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { useInterpreterCall, historyWithout, stoppedTurnLines } from "./useInterpreterCall.ts";
import { findTranslatorLanguage } from "../../lib/translator-languages.ts";

// The turn order of the 2026-10-26 Codex replay where moderation stopped the K4 interpretation.
const before = [
  { id: 0, role: "user", text: "아, 이거 너무 비싸다. 3만 5천 원이라고요?" },
  { id: 1, role: "assistant", text: "Ôi, cái này đắt quá. Ba mươi lăm nghìn won á?" },
];
const stopped = [
  { id: 2, role: "user", text: "와, 진짜 배고파 죽겠다. 여기 뭐가 제일 맛있어" },
  { id: 3, role: "assistant", text: "Trời ơi, đói muốn chết luôn" },
  { id: 4, role: "assistant", text: "." },
];
const lines = (history) => history.map(({ role, text }) => `${role}: ${text}`);

describe("reconnecting after Codex stopped an interpretation", () => {
  test("the stopped turn is the last heard line and everything interpreted after it", () => {
    expect(stoppedTurnLines([...before, ...stopped])).toEqual(stopped);
    expect(stoppedTurnLines([{ id: 0, role: "assistant", text: "Xin chào." }])).toEqual([]);
  });

  test("only the stopped turns' own lines leave the history, never the same words said in other turns", () => {
    const yes = (id) => ({ id, role: "user", text: "네." });
    const ok = (id) => ({ id, role: "assistant", text: "Vâng." });
    // "네." is said and interpreted, then a "네." turn gets stopped, then "네." is said again.
    const firstStop = [yes(12), { id: 13, role: "assistant", text: "Dạ, đói muốn chết" }];
    const atFirstStop = [yes(10), ok(11), ...firstStop];
    const dropped = [...stoppedTurnLines(atFirstStop)];
    expect(lines(historyWithout(atFirstStop, dropped))).toEqual(["user: 네.", "assistant: Vâng."]);

    const secondStop = [{ id: 16, role: "user", text: "배고파 죽겠다" }, { id: 17, role: "assistant", text: "Đói muốn chết" }];
    const atSecondStop = [...atFirstStop, yes(14), ok(15), ...secondStop];
    dropped.push(...stoppedTurnLines(atSecondStop));
    expect(lines(historyWithout([...atSecondStop, yes(18)], dropped))).toEqual([
      "user: 네.", "assistant: Vâng.", "user: 네.", "assistant: Vâng.", "user: 네.",
    ]);
    expect(lines(historyWithout(before, []))).toEqual(lines(before));
  });
});

test("preparing after a partner setting change replaces the call with the current address profile", async () => {
  const saved = { window: globalThis.window, RTCPeerConnection: globalThis.RTCPeerConnection, EventSource: globalThis.EventSource, fetch: globalThis.fetch };
  const offers = [];
  const peers = [];
  const ended = [];
  class Peer {
    iceGatheringState = "complete";
    closed = false;
    constructor() { peers.push(this); }
    addTransceiver() { return { sender: {} }; }
    async createOffer() { return { type: "offer", sdp: "offer" }; }
    async setLocalDescription(value) { this.localDescription = value; }
    async setRemoteDescription() {}
    close() { this.closed = true; }
  }
  globalThis.window = { setTimeout: () => 1, clearTimeout() {}, clearInterval() {} };
  globalThis.RTCPeerConnection = Peer;
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = async (url, init) => {
    if (init?.method === "DELETE") { ended.push(url); return new Response(); }
    offers.push(JSON.parse(init.body));
    return Response.json({ callId: `call-${offers.length}`, sdp: "answer" });
  };
  let controller;
  function Harness({ children }) {
    return children(useInterpreterCall({ onTranscript() {}, getHistory: () => [], onReconnect() {} }));
  }
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((resolve) => setImmediate(resolve)); };
  try {
    renderToString(createElement(Harness, null, (value) => { controller = value; return null; }));
    const ko = findTranslatorLanguage("ko");
    const vi = findTranslatorLanguage("vi");
    const profile = { gender: "male", partnerGender: "female", partnerAge: "older" };
    controller.prepare(ko, vi, profile);
    await settle();
    controller.prepare(ko, vi, { ...profile });
    await settle();
    expect(offers.map((offer) => offer.context.profile)).toEqual([profile]);
    const younger = { ...profile, partnerAge: "younger" };
    controller.prepare(ko, vi, younger);
    await settle();
    const male = { ...younger, partnerGender: "male" };
    controller.prepare(ko, vi, male);
    await settle();
    expect(offers.map((offer) => offer.context.profile)).toEqual([profile, younger, male]);
    expect(ended).toEqual(["/api/live/call/call-1", "/api/live/call/call-2"]);
    expect(peers.map((peer) => peer.closed)).toEqual([true, true, false]);
  } finally {
    controller?.stop();
    Object.assign(globalThis, saved);
  }
});
