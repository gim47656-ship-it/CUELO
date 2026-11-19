import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createQuietDelivery } from "../lib/quiet-delivery";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function harness<T>(install: (pi: ExtensionAPI) => T) {
  const handlers: Record<string, Handler[]> = {};
  const sent: { message: { customType: string; content: string }; options: unknown }[] = [];
  const state = { idle: false, tokens: 0, kind: "main", failNext: false };
  const ctx = {
    agent: { get kind() { return state.kind; } },
    isIdle: () => state.idle,
    getContextUsage: () => ({ tokens: state.tokens, contextWindow: 500_000, percent: state.tokens / 5_000 }),
    sessionManager: { getSessionId: () => "s" },
  };
  const pi = {
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { customType: string; content: string }, options: unknown) => {
      if (state.failNext) {
        state.failNext = false;
        throw new Error("host channel down");
      }
      sent.push({ message, options });
    },
  } as unknown as ExtensionAPI;
  const result = install(pi);
  const emit = (name: string, event: Record<string, unknown> = {}) => { for (const h of handlers[name] ?? []) h(event, ctx); };
  emit("session_start");
  return { result, emit, sent, state, ctx };
}

const note = (content: string) => ({ customType: "note", content, display: false, attribution: "agent" as const });

describe("quiet delivery", () => {
  test("전송이 한 번 실패해도 그 안내와 남은 안내를 잃지 않고 다음 경계에 순서대로 보낸다", () => {
    const h = harness(createQuietDelivery);
    const send = h.result;
    h.emit("agent_start");
    send(note("a"), h.ctx as never);
    send(note("b"), h.ctx as never);
    h.state.failNext = true;
    expect(() => h.emit("tool_result", { toolName: "bash" })).toThrow("host channel down");
    expect(h.sent).toHaveLength(0);
    h.emit("tool_result", { toolName: "bash" });
    expect(h.sent.map((s) => s.message.content)).toEqual(["a", "b"]);
  });

  test("턴 끝 전송이 실패해 남은 안내는 쉬는 동안 다음 안내를 보낼 때 먼저 나간다", () => {
    const h = harness(createQuietDelivery);
    const send = h.result;
    h.emit("agent_start");
    send(note("a"), h.ctx as never);
    h.state.idle = true;
    h.state.failNext = true;
    expect(() => h.emit("agent_end", { willContinue: false })).toThrow("host channel down");
    send(note("b"), h.ctx as never);
    expect(h.sent.map((s) => [s.message.content, s.options])).toEqual([["a", undefined], ["b", undefined]]);
  });

  test("실행 중 안내는 다음 도구 결과에서 aside로 실린다", () => {
    const h = harness(createQuietDelivery);
    const send = h.result;
    h.emit("agent_start");
    send(note("a"), h.ctx as never);
    expect(h.sent).toHaveLength(0);
    h.emit("tool_result", { toolName: "bash" });
    expect(h.sent.map((s) => s.options)).toEqual([{ deliverAs: "aside" }]);
  });

  test("wait 실행 중에는 같은 묶음의 다른 도구 결과로도 보내지 않고 wait 결과가 나올 때 보낸다", () => {
    const h = harness(createQuietDelivery);
    const send = h.result;
    h.emit("agent_start");
    h.emit("tool_call", { toolName: "wait" });
    h.emit("tool_call", { toolName: "read" });
    send(note("late translation"), h.ctx as never);
    h.emit("tool_result", { toolName: "read" });
    // 여기서 aside를 큐에 넣으면 core가 진행 중인 wait를 끝낸다.
    expect(h.sent).toHaveLength(0);
    h.emit("tool_result", { toolName: "wait" });
    expect(h.sent.map((s) => [s.message.content, s.options])).toEqual([["late translation", { deliverAs: "aside" }]]);
  });

  test("도구 없이 끝난 턴의 안내는 턴을 열지 않고 붙인다: 쉬면 옵션 없이, 아직 마무리 중이면 nextTurn", () => {
    const h = harness(createQuietDelivery);
    const send = h.result;
    h.emit("agent_start");
    send(note("a"), h.ctx as never);
    h.emit("agent_end", { willContinue: true });
    expect(h.sent).toHaveLength(0);
    h.emit("agent_end", { willContinue: false });
    expect(h.sent.map((s) => s.options)).toEqual([{ deliverAs: "nextTurn" }]);
    h.state.idle = true;
    send(note("b"), h.ctx as never);
    send(note("c"));
    expect(h.sent.map((s) => s.options).slice(1)).toEqual([undefined, { deliverAs: "nextTurn" }]);
  });
});
