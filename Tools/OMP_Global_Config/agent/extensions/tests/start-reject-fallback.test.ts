import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgRetryFallbackOn } from "@oh-my-pi/pi-coding-agent/session/settings";
import {
  classifierFrom,
  createChildFallback,
  createStartRejectTracker,
  registerStartRejectFallback,
  SUBAGENT_EVENT_CHANNEL,
  type AIErrorLike,
  type FallbackOnPort,
  type StartRejectNotice,
} from "../lib/start-reject-fallback";
import type { StartRejectRecord } from "../lib/routing-ledger";

// 2026-11-18 Sol Maker 두 개가 첫 요청에서 실제로 받은 오류 원문.
const CODEX_REJECTION = "Codex error event: Unsupported parameter: system (code=invalid_request_error)";
const classify = classifierFrom(AIError as unknown as AIErrorLike);
const classifyDep = async () => classify;

const errorMessage = (errorMessageText: string, extra: Record<string, unknown> = {}) => ({
  role: "assistant", api: "openai-codex-responses", provider: "openai-codex", model: "gpt-6.1-sol",
  stopReason: "error", errorMessage: errorMessageText, content: [], ...extra,
});
const rejection = () => errorMessage(CODEX_REJECTION);
const usageLimit = () => errorMessage("You have hit your ChatGPT usage limit (plus plan). Try again in ~158 min.", { errorStatus: 429 });
const toolTurn = () => ({ role: "assistant", provider: "openai-codex", model: "gpt-6.1-sol", stopReason: "toolUse", content: [{ type: "toolCall" }] });
const okTurn = (model = "claude-sonnet-5-5") => ({ role: "assistant", provider: "anthropic", model, stopReason: "stop", content: [{ type: "text" }] });

/** core가 subagent에 주는 것과 같은 settings overlay. 부모는 정본 정책(usage-limit)이다. */
function overlayPort() {
  const parent = Settings.isolated({ "retry.fallbackOn": "usage-limit" });
  const child = parent.overlay();
  const port: FallbackOnPort = { get: () => cfgRetryFallbackOn.get(child), set: (value) => cfgRetryFallbackOn.set(child, value as never) };
  return { parent, child, port, value: () => cfgRetryFallbackOn.get(child) };
}

describe("start-reject classifier (core AIError)", () => {
  test("실제 Codex 거절 원문은 거절이고 사용 한도·네트워크·시간 초과·중단은 거절이 아니다", () => {
    expect(classify(rejection())).toBe("rejection");
    expect(classify(errorMessage('400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', { api: "anthropic-messages", errorStatus: 400 }))).toBe("rejection");
    expect(classify(usageLimit())).toBe("usage-limit");
    expect(classify(errorMessage("fetch failed: ECONNRESET"))).toBe("transient");
    expect(classify(errorMessage("Request timed out.", { api: "anthropic-messages" }))).toBe("transient");
    expect(classify(errorMessage("500 Internal server error", { errorStatus: 500 }))).toBe("transient");
    expect(classify({ ...rejection(), stopReason: "aborted", errorMessage: "Request was aborted" })).toBe("abort");
  });
});

describe("child: 첫 응답 판정과 overlay 복원", () => {
  const setup = () => {
    const settings = overlayPort();
    const child = createChildFallback({ classify: classifyDep, fallbackOn: async () => settings.port });
    return { settings, child };
  };

  test("첫 요청 거절이면 그 child overlay만 any로 열고 부모 정본은 그대로이며, 대체 적용에서 되돌린다", async () => {
    const { settings, child } = setup();
    await child.onAssistantMessage(rejection());
    expect(settings.value()).toBe("any");
    expect(cfgRetryFallbackOn.get(settings.parent)).toBe("usage-limit");
    child.onFallbackApplied();
    expect(settings.value()).toBe("usage-limit");
    // 대체 모델의 거절은 다시 열지 않는다(한 번만).
    await child.onAssistantMessage(rejection());
    expect(settings.value()).toBe("usage-limit");
  });

  test("대체 없이 다음 응답이 오거나 도구가 시작되면 그 판단 전에 되돌린다", async () => {
    const next = setup();
    await next.child.onAssistantMessage(rejection());
    await next.child.onAssistantMessage(errorMessage(CODEX_REJECTION, { provider: "anthropic", model: "claude-sonnet-5-5" }));
    expect(next.settings.value()).toBe("usage-limit");

    const tool = setup();
    await tool.child.onAssistantMessage(rejection());
    tool.child.onToolStart();
    expect(tool.settings.value()).toBe("usage-limit");

    // 쓸 수 있는 다음 모델이 없어 복구가 이어 가지 않은 실행 끝.
    const end = setup();
    await end.child.onAssistantMessage(rejection());
    end.child.onRunEnd();
    expect(end.settings.value()).toBe("usage-limit");
  });

  test("도구를 쓴 child는 그 뒤 거절돼도 overlay를 열지 않는다", async () => {
    const { settings, child } = setup();
    await child.onAssistantMessage(toolTurn());
    child.onToolStart();
    await child.onAssistantMessage(rejection());
    expect(settings.value()).toBe("usage-limit");
    expect(child.flipped).toBe(false);
  });

  test("도구 호출을 담은 오류, 사용 한도, 네트워크 오류는 기존 정책 그대로다", async () => {
    for (const message of [
      { ...rejection(), content: [{ type: "toolCall" }] },
      usageLimit(),
      errorMessage("fetch failed: ECONNRESET"),
      { ...rejection(), stopReason: "aborted" },
    ]) {
      const { settings, child } = setup();
      await child.onAssistantMessage(message);
      expect(settings.value()).toBe("usage-limit");
    }
  });
});

describe("parent: 알림과 owner 정리", () => {
  const setup = () => {
    const notices: StartRejectNotice[] = [];
    const tracker = createStartRejectTracker({ classify: classifyDep, notify: (notice) => notices.push(notice) });
    const emit = (id: string, event: Record<string, unknown>) => tracker.onChildEvent(id, event as never);
    return { notices, tracker, emit };
  };
  const SOL = "openai-codex/gpt-6.1-sol";
  const SONNET = "anthropic/claude-sonnet-5-5";

  test("첫 요청 거절 뒤 대체 적용이면 원래 모델·원문 오류·새 모델로 한 번 알리고, 대체가 일하면 더 알리지 않는다", async () => {
    const { notices, tracker, emit } = setup();
    await emit("Fix", { type: "message_end", message: rejection() });
    await emit("Fix", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    expect(notices).toEqual([{ stage: "redispatched", childId: "Fix", fromModel: SOL, error: CODEX_REJECTION, toModel: SONNET, priorRejections: 0 }]);
    expect(tracker.replaying().get("Fix")).toBe(SONNET);
    await emit("Fix", { type: "message_end", message: okTurn() });
    await emit("Fix", { type: "tool_execution_start" });
    await emit("Fix", { type: "agent_end" });
    expect(notices).toHaveLength(1);
    expect(tracker.failedChild("Fix")).toBe(false);
    expect(tracker.replaying().size).toBe(0);
  });

  test("부모 쪽 전달이 대체 적용을 먼저 실어도 같은 알림이다", async () => {
    const { notices, emit } = setup();
    await emit("Fix", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    await emit("Fix", { type: "message_end", message: rejection() });
    expect(notices.map((notice) => [notice.stage, notice.toModel])).toEqual([["redispatched", SONNET]]);
  });

  test("대체 모델도 첫 요청에서 거절되면 두 오류를 함께 알리고 owner 후보에서 뺀다", async () => {
    const { notices, tracker, emit } = setup();
    await emit("Fix", { type: "message_end", message: rejection() });
    await emit("Fix", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    await emit("Fix", { type: "message_end", message: errorMessage('400 {"error":{"type":"invalid_request_error"}}', { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", errorStatus: 400 }) });
    await emit("Fix", { type: "agent_end" });
    expect(notices.at(-1)).toMatchObject({ stage: "replacement-rejected", fromModel: SOL, error: CODEX_REJECTION, toModel: SONNET, replacementError: '400 {"error":{"type":"invalid_request_error"}}' });
    expect(notices).toHaveLength(2);
    expect(tracker.failedChild("Fix")).toBe(true);
    expect(tracker.replaying().size).toBe(0);
  });

  test("쓸 수 있는 다음 모델이 없으면 재발주 없이 원문 오류를 알리고 owner 후보에서 뺀다", async () => {
    const { notices, tracker, emit } = setup();
    await emit("Fix", { type: "message_end", message: rejection() });
    await emit("Fix", { type: "agent_end" });
    expect(notices).toEqual([{ stage: "no-replacement", childId: "Fix", fromModel: SOL, error: CODEX_REJECTION, priorRejections: 0 }]);
    expect(tracker.failedChild("Fix")).toBe(true);
  });

  test("도구를 쓴 뒤 실패한 child와 사용 한도 대체는 알리지도 정리하지도 않는다", async () => {
    const { notices, tracker, emit } = setup();
    await emit("Worked", { type: "message_end", message: toolTurn() });
    await emit("Worked", { type: "tool_execution_start" });
    await emit("Worked", { type: "message_end", message: rejection() });
    await emit("Worked", { type: "agent_end" });
    await emit("Limited", { type: "message_end", message: usageLimit() });
    await emit("Limited", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    await emit("Limited", { type: "message_end", message: okTurn() });
    await emit("Limited", { type: "agent_end" });
    expect(notices).toEqual([]);
    expect(tracker.failedChild("Worked")).toBe(false);
    expect(tracker.failedChild("Limited")).toBe(false);
  });

  test("같은 모델이 이 세션에서 다시 같은 식으로 거절되면 반복으로 표시한다", async () => {
    const { notices, emit } = setup();
    await emit("A", { type: "message_end", message: rejection() });
    await emit("A", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    await emit("B", { type: "message_end", message: rejection() });
    await emit("B", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    expect(notices.map((notice) => notice.priorRejections)).toEqual([0, 1]);
  });

  test("이어 가는 loop 끝(willContinue)은 실행 끝이 아니라 실패로 정리하지 않는다", async () => {
    const { notices, tracker, emit } = setup();
    await emit("Fix", { type: "message_end", message: rejection() });
    await emit("Fix", { type: "agent_end", willContinue: true });
    await emit("Fix", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    expect(notices.map((notice) => notice.stage)).toEqual(["redispatched"]);
    expect(tracker.failedChild("Fix")).toBe(false);
    expect(tracker.replaying().get("Fix")).toBe(SONNET);
  });

  test("대체 모델이 도구 없이 재시도 가능한 오류로 끝나도 시작 실패로 두 오류를 알리고 정리한다", async () => {
    const { notices, tracker, emit } = setup();
    await emit("Fix", { type: "message_end", message: rejection() });
    await emit("Fix", { type: "retry_fallback_applied", from: SOL, to: SONNET, role: SOL });
    await emit("Fix", { type: "message_end", message: errorMessage("fetch failed: ECONNRESET", { provider: "anthropic", model: "claude-sonnet-5-5" }) });
    expect(notices).toHaveLength(1);
    await emit("Fix", { type: "agent_end" });
    expect(notices.at(-1)).toMatchObject({ stage: "replacement-rejected", error: CODEX_REJECTION, toModel: SONNET, replacementError: "fetch failed: ECONNRESET" });
    expect(tracker.failedChild("Fix")).toBe(true);
  });

  test("원문 오류는 공백과 줄바꿈까지 그대로 싣는다", async () => {
    const { notices, emit } = setup();
    await emit("Fix", { type: "message_end", message: errorMessage(`  ${CODEX_REJECTION}\r\n`) });
    await emit("Fix", { type: "agent_end" });
    expect(notices[0]!.error).toBe(`  ${CODEX_REJECTION}\r\n`);
  });
});

describe("registerStartRejectFallback", () => {
  function fakePi() {
    const handlers: Record<string, Array<(event: unknown, ctx: unknown) => unknown>> = {};
    const listeners = new Map<string, Set<(data: unknown) => void>>();
    const sent: Array<{ message: Record<string, unknown>; options: unknown }> = [];
    const sentSignal = Promise.withResolvers<void>();
    const countWaiters: Array<{ count: number; resolve: () => void }> = [];
    const pi = {
      on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { (handlers[name] ??= []).push(handler); },
      sendMessage(message: Record<string, unknown>, options: unknown) {
        sent.push({ message, options });
        sentSignal.resolve();
        for (const waiter of countWaiters) if (sent.length >= waiter.count) waiter.resolve();
      },
      events: {
        on(channel: string, handler: (data: unknown) => void) {
          const set = listeners.get(channel) ?? new Set();
          listeners.set(channel, set);
          set.add(handler);
          return () => set.delete(handler);
        },
        emit(channel: string, data: unknown) { for (const handler of listeners.get(channel) ?? []) handler(data); },
      },
    };
    const fire = async (name: string, event: unknown, ctx: unknown) => {
      for (const handler of handlers[name] ?? []) await handler(event, ctx);
    };
    /** 알림이 count개가 될 때까지 기다린다(시간이 아니라 전송 사건으로). */
    const sentCount = (count: number) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      if (sent.length >= count) resolve();
      else countWaiters.push({ count, resolve });
      return promise;
    };
    return { pi, sent, fire, listeners, firstSend: sentSignal.promise, sentCount };
  }
  const mainCtx = { agent: { kind: "main", name: "main" }, sessionManager: { getSessionId: () => "parent-session" } };
  const started = (id: string, agent = "maker") => ({ id, agent, status: "started" });
  const LIFECYCLE = "task:subagent:lifecycle";
  const childEvent = (id: string, event: Record<string, unknown>) => ({ id, event });
  const applied = { type: "retry_fallback_applied", from: "openai-codex/gpt-6.1-sol", to: "anthropic/claude-sonnet-5-5", role: "x" };
  /** 분류기를 붙잡아 처리 도중의 경합을 만든다. 처리 줄이 분류에 들어갈 만큼만 microtask를 돌린다. */
  const heldClassifier = () => {
    const gate = Promise.withResolvers<void>();
    return { classify: () => gate.promise.then(() => classify), release: () => gate.resolve() };
  };
  const ticks = async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  };

  test("분류를 기다리던 이전 세션의 처리는 새 세션의 반복 횟수와 실패 목록을 바꾸지 않는다", async () => {
    const { pi, fire, firstSend } = fakePi();
    const held = heldClassifier();
    const records: StartRejectRecord[] = [];
    let sessionId = "session-A";
    const ctx = { agent: { kind: "main", name: "main" }, sessionManager: { getSessionId: () => sessionId } };
    const tracker = registerStartRejectFallback(pi as never, { classify: held.classify, record: (record) => records.push(record) });
    await fire("session_start", {}, ctx);
    pi.events.emit(LIFECYCLE, started("Old"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Old", { type: "message_end", message: rejection() }));
    await ticks();
    sessionId = "session-B";
    await fire("session_switch", {}, ctx);
    held.release();
    pi.events.emit(LIFECYCLE, started("New"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("New", { type: "message_end", message: rejection() }));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("New", applied));
    await firstSend;
    expect(records).toEqual([expect.objectContaining({ sessionId: "session-B", agentId: "New", repeat: false })]);
    expect(tracker.failedChild("Old")).toBe(false);
  });

  test("reload 재등록 뒤의 이벤트는 분류를 기다리던 앞 처리를 앞지르지 않는다", async () => {
    const { pi, fire, sent, sentCount } = fakePi();
    const held = heldClassifier();
    registerStartRejectFallback(pi as never, { classify: held.classify });
    await fire("session_start", {}, mainCtx);
    pi.events.emit(LIFECYCLE, started("Fix"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Fix", { type: "message_end", message: rejection() }));
    await ticks();
    const reloaded = registerStartRejectFallback(pi as never, { classify: held.classify });
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Fix", applied));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Fix", { type: "message_end", message: errorMessage('400 {"error":{"type":"invalid_request_error"}}', { api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", errorStatus: 400 }) }));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Fix", { type: "agent_end" }));
    held.release();
    await sentCount(2);
    expect(String(sent[1]!.message.content)).toContain("시작에서 실패했다");
    expect(reloaded.failedChild("Fix")).toBe(true);
  });

  test("부모는 Maker child만 관측해 사용자에게 보이는 aside와 원장 기록을 남기고, reload 재등록은 알림을 겹치지 않으며 관측을 잇는다", async () => {
    const { pi, sent, fire, listeners, firstSend } = fakePi();
    const records: StartRejectRecord[] = [];
    registerStartRejectFallback(pi as never, { classify: classifyDep, record: (record) => records.push(record) });
    await fire("session_start", {}, mainCtx);
    registerStartRejectFallback(pi as never, { classify: classifyDep, record: (record) => records.push(record) });
    expect(listeners.get(SUBAGENT_EVENT_CHANNEL)?.size).toBe(1);
    // explore child의 시작 거절은 이 기능의 대상이 아니다(먼저 줄 서므로 알림이 있었다면 첫 전송이 된다).
    pi.events.emit(LIFECYCLE, started("Look", "explore"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Look", { type: "message_end", message: rejection() }));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Look", { type: "agent_end" }));
    pi.events.emit(LIFECYCLE, started("Fix"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Fix", { type: "message_end", message: rejection() }));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Fix", applied));
    await firstSend;
    expect(sent).toHaveLength(1);
    expect(sent[0]!.options).toEqual({ deliverAs: "aside" });
    expect(sent[0]!.message).toMatchObject({ customType: "start-reject-fallback", display: true });
    const content = String(sent[0]!.message.content);
    for (const part of ["Fix", "openai-codex/gpt-6.1-sol", CODEX_REJECTION, "anthropic/claude-sonnet-5-5", "automatic redispatch done; Main must not redispatch manually"]) expect(content).toContain(part);
    expect(records).toEqual([expect.objectContaining({ type: "start-reject", sessionId: "parent-session", agentId: "Fix", stage: "redispatched", error: CODEX_REJECTION, toModel: "anthropic/claude-sonnet-5-5", repeat: false })]);
    // 같은 세션의 reload(같은 id의 session_switch)는 진행 중인 재발주 관측을 비우지 않는다.
    const reloaded = registerStartRejectFallback(pi as never, { classify: classifyDep, record: (record) => records.push(record) });
    await fire("session_switch", {}, mainCtx);
    expect(reloaded.replaying().get("Fix")).toBe("anthropic/claude-sonnet-5-5");
  });

  test("세션이 바뀌기 전에 줄 선 이벤트는 새 세션에 알리거나 기록하지 않는다", async () => {
    const { pi, sent, fire, firstSend } = fakePi();
    const records: StartRejectRecord[] = [];
    let sessionId = "session-A";
    const ctx = { agent: { kind: "main", name: "main" }, sessionManager: { getSessionId: () => sessionId } };
    registerStartRejectFallback(pi as never, { classify: classifyDep, record: (record) => records.push(record) });
    await fire("session_start", {}, ctx);
    pi.events.emit(LIFECYCLE, started("Old"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Old", { type: "message_end", message: rejection() }));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("Old", { type: "agent_end" }));
    sessionId = "session-B";
    await fire("session_switch", {}, ctx);
    pi.events.emit(LIFECYCLE, started("New"));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("New", { type: "message_end", message: rejection() }));
    pi.events.emit(SUBAGENT_EVENT_CHANNEL, childEvent("New", applied));
    await firstSend;
    expect(sent).toHaveLength(1);
    expect(records).toEqual([expect.objectContaining({ sessionId: "session-B", agentId: "New", stage: "redispatched" })]);
  });

  test("Maker child의 assistant_message에서만 overlay를 열고 Main·다른 agent는 건드리지 않는다", async () => {
    const settings = overlayPort();
    const { pi, fire } = fakePi();
    registerStartRejectFallback(pi as never, { classify: classifyDep, fallbackOn: async () => settings.port });
    await fire("assistant_message", { type: "assistant_message", message: rejection() }, mainCtx);
    await fire("assistant_message", { type: "assistant_message", message: rejection() }, { agent: { kind: "sub", name: "explore" } });
    expect(settings.value()).toBe("usage-limit");
    await fire("assistant_message", { type: "assistant_message", message: rejection() }, { agent: { kind: "sub", name: "maker" } });
    expect(settings.value()).toBe("any");
    // 실행이 이어 가는 loop 끝(willContinue)에서는 되돌리지 않고, 이어 가지 않는 실행 끝에서 되돌린다.
    const maker = { agent: { kind: "sub", name: "maker" } };
    await fire("agent_end", { type: "agent_end", willContinue: true }, maker);
    expect(settings.value()).toBe("any");
    await fire("agent_end", { type: "agent_end", willContinue: false }, maker);
    expect(settings.value()).toBe("usage-limit");
  });
});
