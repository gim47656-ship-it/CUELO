import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import imageQuestionRouter from "../image-question-router";
import { onSessionLifecycle } from "../lib/session-identity";
import { createSteeringReplyGate, type ClassifySteeringReply } from "../steering-reply-gate";
import todoNudge from "../todo-nudge";
import { createTurnEndGuard } from "../turn-end-guard";

// core는 session_start를 런타임 초기화 때 한 번만 보내고 `/new`·resume·fork·reload는 session_switch로 알린다.
// reload는 같은 세션 파일을 다시 읽는 switch라 session id가 그대로다. 아래 테스트는 같은 id와 다른 id의 전환을 가르고
// 확장이 실제로 내는 결과(안내 전송·차단)와 늦게 도착한 판정의 격리를 본다.

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

interface Session {
  id: string;
  branch: unknown[];
}

function fakePi() {
  const handlers: Record<string, Handler[]> = {};
  const sent: Array<{ customType?: string; content?: unknown }> = [];
  const pi = {
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { customType?: string; content?: unknown }) => { sent.push(message); },
  } as unknown as ExtensionAPI;
  return { pi, handlers, sent };
}

function contextFor(session: Session, extra: Record<string, unknown> = {}) {
  return { cwd: "test", ...extra, sessionManager: { getSessionId: () => session.id, getBranch: () => session.branch } };
}

/** 사용자가 todo 도구로 남긴 durable 상태(세션 파일에서 다시 읽는 값). */
const persistedTodo = (...statuses: string[]) => ({
  type: "custom",
  customType: "user_todo_edit",
  data: { phases: [{ tasks: statuses.map((status, index) => ({ content: `work-${index}`, status })) }] },
});

describe("onSessionLifecycle", () => {
  function recorder() {
    const { pi, handlers } = fakePi();
    const calls: string[] = [];
    onSessionLifecycle(pi, { start: (ctx) => calls.push(`start:${ctx.sessionManager.getSessionId()}`), reload: (ctx) => calls.push(`reload:${ctx.sessionManager.getSessionId()}`) });
    const emit = (name: string, id?: string) =>
      handlers[name]!.forEach((handler) => handler({}, { sessionManager: { getSessionId: () => id } }));
    return { calls, emit };
  }

  test("session_start와 다른 id로 옮긴 switch는 start, 같은 id switch는 reload로 가른다", () => {
    const r = recorder();
    r.emit("session_start", "a");
    r.emit("session_switch", "a");
    r.emit("session_switch", "b");
    r.emit("session_switch", "b");
    r.emit("session_switch", "a");
    expect(r.calls).toEqual(["start:a", "reload:a", "start:b", "reload:b", "start:a"]);
  });

  test("같은 세션이라는 증거가 없으면 start로 본다(id를 못 읽거나 start를 아직 못 본 경우)", () => {
    const r = recorder();
    r.emit("session_switch", "a");
    r.emit("session_switch", "a");
    r.emit("session_switch", undefined);
    r.emit("session_switch", undefined);
    expect(r.calls).toEqual(["start:a", "reload:a", "start:undefined", "start:undefined"]);
  });

  test("reload 처리기를 주지 않으면 같은 id switch는 아무것도 하지 않는다", () => {
    const { pi, handlers } = fakePi();
    const calls: string[] = [];
    onSessionLifecycle(pi, { start: () => calls.push("start") });
    const ctx = { sessionManager: { getSessionId: () => "a" } };
    handlers.session_start!.forEach((handler) => handler({}, ctx));
    handlers.session_switch!.forEach((handler) => handler({}, ctx));
    expect(calls).toEqual(["start"]);
  });
});

describe("turn-end guard 세션 전환", () => {
  function setup(classify?: (summary: string, ctx: ExtensionContext, signal: AbortSignal) => Promise<"routine_confirmation" | "unknown">) {
    const { pi, handlers, sent } = fakePi();
    createTurnEndGuard(classify as never)(pi);
    const session: Session = { id: "session-1", branch: [persistedTodo("in_progress", "pending")] };
    const ctx = contextFor(session);
    const emit = (name: string, event: Record<string, unknown> = {}) => Promise.all((handlers[name] ?? []).map((handler) => handler(event, ctx)));
    const end = (text: string) => emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
    return { session, emit, end, sent };
  }

  test("다른 세션으로 옮기면 이전 세션의 미완 TODO로 새 세션의 종료를 깨우지 않는다", async () => {
    const h = setup();
    await h.emit("session_start");
    await h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
    h.session.id = "session-2";
    h.session.branch = [];
    await h.emit("session_switch", { reason: "new" });
    await h.emit("input", { source: "interactive", text: "새 작업 시작" });
    await h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
  });

  test("같은 세션 reload는 이미 안내한 입력의 재안내를 막고, 다시 읽은 durable TODO는 반영한다", async () => {
    const h = setup();
    await h.emit("session_start");
    await h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
    await h.emit("session_switch", { reason: "resume" });
    await h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
    // 디스크의 세션 파일에서 TODO가 모두 닫혔다면 reload 뒤 새 입력의 종료는 깨우지 않는다.
    h.session.branch = [persistedTodo("completed")];
    await h.emit("session_switch", { reason: "resume" });
    await h.emit("input", { source: "interactive", text: "다음" });
    await h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
  });

  test("다른 세션으로 옮긴 뒤 늦게 도착한 이전 세션의 판정은 안내를 만들지 않고, 같은 세션 reload는 진행 중인 판정을 유지한다", async () => {
    for (const [label, nextId, expected] of [["다른 세션", "session-2", 0], ["같은 세션 reload", "session-1", 1]] as const) {
      const gate = Promise.withResolvers<"routine_confirmation">();
      const h = setup(() => gate.promise);
      await h.emit("session_start");
      const pending = h.end("계속할까요?");
      h.session.id = nextId;
      await h.emit("session_switch", { reason: "resume" });
      gate.resolve("routine_confirmation");
      await pending;
      expect([label, h.sent.length]).toEqual([label, expected]);
    }
  });
});

describe("todo-nudge 세션 전환", () => {
  function setup() {
    const { pi, handlers, sent } = fakePi();
    todoNudge(pi);
    const session: Session = { id: "session-1", branch: [persistedTodo("in_progress")] };
    const ctx = contextFor(session, { agent: { kind: "main" } });
    const emit = (name: string, event: Record<string, unknown> = {}) => handlers[name]!.forEach((handler) => handler(event, ctx));
    const threeTools = () => { for (const toolName of ["read", "edit", "bash"]) emit("tool_call", { toolName }); };
    return { session, emit, sent, threeTools };
  }

  test("다른 세션으로 옮기면 이전 세션의 활성 TODO가 새 세션의 todo 안내를 막지 않는다", () => {
    const h = setup();
    h.emit("session_start");
    h.emit("input", { source: "interactive", text: "하나" });
    h.threeTools();
    expect(h.sent).toHaveLength(0);
    h.session.id = "session-2";
    h.session.branch = [];
    h.emit("session_switch", { reason: "new" });
    h.emit("input", { source: "interactive", text: "둘" });
    h.threeTools();
    expect(h.sent).toHaveLength(1);
  });

  test("같은 세션 reload는 요청 단위 안내 상태를 지우지 않고 durable TODO만 다시 읽는다", () => {
    const h = setup();
    h.emit("session_start");
    h.session.branch = [];
    h.emit("session_switch", { reason: "resume" });
    h.emit("input", { source: "interactive", text: "하나" });
    h.threeTools();
    expect(h.sent).toHaveLength(1);
    // reload가 같은 요청의 안내 한 번 제한을 되살리지 않는다.
    h.emit("session_switch", { reason: "resume" });
    h.threeTools();
    expect(h.sent).toHaveLength(1);
    // reload 뒤 durable TODO가 생기면 그 목록이 이미 추적 중이다.
    h.session.branch = [persistedTodo("pending")];
    h.emit("session_switch", { reason: "resume" });
    h.emit("input", { source: "interactive", text: "둘" });
    h.threeTools();
    expect(h.sent).toHaveLength(1);
  });
});

describe("steering reply gate 세션 전환", () => {
  const text = (value: string) => [{ type: "text", text: value }, { type: "toolCall" }];

  for (const [label, nextId, reminders] of [["다른 세션", "session-2", 0], ["같은 세션 reload", "session-1", 1]] as const) {
    test(`${label}: 늦게 도착한 판정은 ${reminders ? "진행 중인 판정이므로 안내를 보낸다" : "이전 세션의 것이라 안내를 보내지 않는다"}`, async () => {
      const gate = Promise.withResolvers<"unanswered">();
      const judged = Promise.withResolvers<void>();
      const classify: ClassifySteeringReply = async () => {
        const answer = await gate.promise;
        judged.resolve();
        return answer;
      };
      const { pi, handlers, sent } = fakePi();
      createSteeringReplyGate(classify)(pi);
      const session: Session = { id: "session-1", branch: [] };
      const ctx = contextFor(session, { model: {}, modelRegistry: {} });
      const emit = (name: string, event: Record<string, unknown> = {}) => Promise.all((handlers[name] ?? []).map((handler) => handler(event, ctx)));
      await emit("session_start");
      await emit("message_start", { message: { role: "user", steering: true, content: "측정 결과는 줘야지" } });
      await emit("message_update", { message: { role: "assistant", content: text("측정 결과를 확인하겠습니다.") } });
      await emit("tool_call", {});
      session.id = nextId;
      await emit("session_switch", { reason: "resume" });
      gate.resolve("unanswered");
      await judged.promise;
      // 판정 결과를 받은 gate의 후속 처리(microtask)를 비운다.
      await Promise.resolve();
      await Promise.resolve();
      expect(sent.filter((message) => message.customType === "steering-reply-gate")).toHaveLength(reminders);
    });
  }
});

describe("image-question-router 세션 전환", () => {
  function setup() {
    const { pi, handlers } = fakePi();
    imageQuestionRouter(pi);
    const session: Session = { id: "session-1", branch: [] };
    const ctx = contextFor(session, { model: { input: ["text", "image"] } });
    const emit = (name: string, event: Record<string, unknown> = {}) => handlers[name]!.map((handler) => handler(event, ctx));
    const read = (path: string) => emit("tool_call", { toolName: "read", toolCallId: "c", input: { path } })[0] as { block?: boolean } | undefined;
    return { session, emit, read };
  }

  test("질문한 이미지의 직접 read 허용은 그 세션의 것이라 다른 세션에는 넘어가지 않고 같은 세션 reload에는 남는다", () => {
    const h = setup();
    h.emit("session_start");
    h.read("shot.png?q=버튼이 잘렸나");
    expect(h.read("shot.png")).toBeUndefined();
    h.emit("session_switch", { reason: "resume" });
    expect(h.read("shot.png")).toBeUndefined();
    h.session.id = "session-2";
    h.emit("session_switch", { reason: "new" });
    expect(h.read("shot.png")?.block).toBe(true);
  });
});
