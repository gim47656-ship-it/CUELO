import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createSteeringReplyGate, type ClassifySteeringReply } from "../steering-reply-gate";

type Classify = ClassifySteeringReply;
type Handler = (event: Record<string, unknown>, ctx: unknown) => void | Promise<void>;

function harness(classify: Classify) {
  const handlers: Record<string, Handler[]> = {};
  const sent: { content: string; customType: string }[] = [];
  const deliveries: unknown[] = [];
  createSteeringReplyGate(classify)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { content: string; customType: string }, options: unknown) => {
      sent.push(message);
      deliveries.push(options);
    },
  } as unknown as ExtensionAPI);
  const ctx = { cwd: "test", modelRegistry: {}, model: {}, sessionManager: { getSessionId: () => "session" } };
  const emit = (name: string, event: Record<string, unknown> = {}) =>
    Promise.all((handlers[name] ?? []).map(handler => handler(event, ctx)));
  const steer = (content: unknown) => emit("message_start", { message: { role: "user", steering: true, content } });
  const answer = (content: unknown) => emit("message_update", { message: { role: "assistant", content } });
  const tool = (content?: unknown) => emit("tool_call", content ? { assistantMessage: { role: "assistant", content } } : {});
  const startTool = () => handlers.tool_call?.[0]?.({}, ctx);
  return { emit, steer, answer, tool, startTool, sent, deliveries };
}

const text = (value: string) => [{ type: "text", text: value }, { type: "toolCall" }];

describe("steering reply gate", () => {
  test.each(["answered", "unanswered", "unknown"] as const)("본문의 답변 여부 %s 판정", async (result) => {
    const seen: unknown[] = [];
    const h = harness(async (summary, ctx, signal) => {
      expect(ctx.cwd).toBe("test");
      expect(signal.aborted).toBe(false);
      seen.push(summary);
      return result;
    });
    await h.steer("측정 결과는 줘야지");
    await h.answer(text(result === "answered" ? "측정 결과는 38%입니다." : "측정 결과를 확인하겠습니다."));
    await h.tool();
    await h.tool();
    expect(seen).toHaveLength(1);
    expect(h.sent).toHaveLength(result === "unanswered" ? 1 : 0);
    if (result === "unanswered") {
      expect(h.sent[0]).toMatchObject({ customType: "steering-reply-gate", content: expect.stringContaining("결론을 본문으로") });
      expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
    }
  });

  test("본문이 없으면 기존 결정론 안내만 보내고 판정하지 않는다", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return "unanswered"; });
    await h.steer("결과는 줘야지");
    await h.tool([{ type: "toolCall" }]);
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.content).toContain("아직 답하지 않고 도구를 시작했다");
  });

  test("본문이 도구 이벤트에만 실려도 판정하고 민감 경로·URL·코드를 전달하지 않는다", async () => {
    const seen: unknown[] = [];
    const h = harness(async (summary) => { seen.push(summary); return "unanswered"; });
    await h.steer("F:/private/result.txt 결과를 https://example.test/secret/path 기준으로 줘");
    await h.tool(text("`src/private.ts` 결과 확인 중입니다. ```js\nconst secretCode = 1\n```"));
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen)).not.toMatch(/private|example\.test|secretCode/);
    expect(h.sent).toHaveLength(1);
  });

  test("판정 실패에는 기존 본문 있음 결정을 유지한다", async () => {
    const h = harness(async () => { throw new Error("no credentials"); });
    await h.steer("결과는 줘야지");
    await h.answer(text("다음 단계로 넘어가겠습니다."));
    await h.tool();
    expect(h.sent).toHaveLength(0);
  });

  test("느린 판정은 도구 핸들러의 반환을 붙잡지 않고 결과가 오면 안내한다", async () => {
    const pending = Promise.withResolvers<"unanswered">();
    let signal: AbortSignal | undefined;
    const h = harness((_summary, _ctx, requestedSignal) => {
      signal = requestedSignal;
      return pending.promise;
    });
    await h.steer("결과는 줘야지");
    await h.answer(text("결과를 확인하겠습니다."));
    const returned = h.startTool();
    expect(returned).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    expect(h.sent).toHaveLength(0);
    pending.resolve("unanswered");
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent).toHaveLength(1);
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
  });

  test("새 입력과 세션 종료는 늦은 판정을 취소하고 버린다", async () => {
    for (const eventName of ["input", "session_shutdown"] as const) {
      const pending = Promise.withResolvers<"unanswered">();
      let signal: AbortSignal | undefined;
      const h = harness((_summary, _ctx, requestedSignal) => { signal = requestedSignal; return pending.promise; });
      await h.steer("결과는 줘야지");
      await h.answer(text("결과를 확인하겠습니다."));
      const oldTool = h.tool();
      await h.emit(eventName, { source: "rpc", text: "새 입력" });
      expect(signal?.aborted).toBe(true);
      pending.resolve("unanswered");
      await oldTool;
      expect(h.sent).toHaveLength(0);
    }
  });

  test("합성·agent steering에는 개입하지 않는다", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return "unanswered"; });
    await h.emit("message_start", { message: { role: "user", steering: true, synthetic: true, content: "결과" } });
    await h.emit("message_start", { message: { role: "user", steering: true, attribution: "agent", content: "결과" } });
    await h.answer(text("진행하겠습니다."));
    await h.tool();
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(0);
  });
});
