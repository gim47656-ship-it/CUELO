import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createTodoNudge } from "../todo-nudge";

type Classify = Parameters<typeof createTodoNudge>[0];
type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

function harness(classify: Classify, branch: unknown[] = []) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const deliveries: unknown[] = [];
  const ctx = { cwd: "test", sessionManager: { getBranch: () => branch, getSessionId: () => "session" } };
  createTodoNudge(classify)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown, options: unknown) => { sent.push(message); deliveries.push(options); },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: Record<string, unknown>) => {
    for (const handler of handlers[name] ?? []) handler(event, ctx);
  };
  const input = (text = "첫째를 조사하고, 둘째를 수정하고, 셋째를 검증해줘", source = "interactive") =>
    emit("input", { source, text });
  const calls = (names: string[]) => { for (const toolName of names) emit("tool_call", { toolName }); };
  emit("session_start", {});
  return { emit, input, calls, sent, deliveries };
}

describe("todo nudge", () => {
  test("0.5 이상의 판정은 세 번째 도구에서 요청당 한 번만 aside 안내한다", async () => {
    const judged: string[] = [];
    const h = harness(async (excerpt) => { judged.push(excerpt); return 0.5; });
    h.input();
    await Promise.resolve();
    h.calls(["read", "bash"]);
    expect(h.sent).toHaveLength(0);
    h.calls(["read", "edit", "bash"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ customType: "todo-nudge", display: false, attribution: "agent" });
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
    expect(judged).toHaveLength(1);
    h.input("새 작업을 조사하고 수정하고 검증해줘", "rpc");
    await Promise.resolve();
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(2);
    expect(judged).toHaveLength(2);
  });

  test("0.5 미만 판정은 세 번째 도구 이후에도 안내하지 않는다", async () => {
    const h = harness(async () => 0.49);
    h.input("단일 파일을 읽어줘");
    await Promise.resolve();
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
  });

  test("세 번째 도구까지 판정이 미도착이면 기존 규칙으로 한 번 안내하고 늦은 결과는 소급하지 않는다", async () => {
    const decision = deferred<number>();
    const h = harness(async () => decision.promise);
    h.input();
    h.calls(["read", "bash", "read", "edit"]);
    expect(h.sent).toHaveLength(1);
    decision.resolve(0);
    await Promise.resolve();
    h.calls(["read"]);
    expect(h.sent).toHaveLength(1);
  });

  test("판정 실패는 기존 규칙으로 안내한다", async () => {
    const h = harness(async () => { throw new Error("credential unavailable"); });
    h.input();
    await Promise.resolve();
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(1);
  });


  test("새 입력이 오면 이전 세대의 늦은 판정을 버린다", async () => {
    const first = deferred<number>();
    const signals: AbortSignal[] = [];
    const h = harness(async (_excerpt, _ctx, signal) => {
      signals.push(signal);
      return signals.length === 1 ? first.promise : 0;
    });
    h.input("오래된 여러 작업");
    h.input("새로운 단일 조회");
    expect(signals[0]?.aborted).toBe(true);
    await Promise.resolve();
    first.resolve(1);
    await Promise.resolve();
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(0);
  });

  test("그 요청에서 todo 를 먼저 쓰면 안내하지 않는다", async () => {
    const h = harness(async () => 1);
    h.input();
    await Promise.resolve();
    h.calls(["read", "todo", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
  });

  test("사용자 직접 입력이 없는 세션(child)과 확장 입력에는 판정·안내가 없다", () => {
    let judgments = 0;
    const h = harness(async () => { judgments++; return 1; });
    h.calls(["read", "bash", "read", "edit", "bash"]);
    h.input("세 단계 작업", "extension");
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
    expect(judgments).toBe(0);
  });

  test("진행 중인 todo 가 남아 있으면 새 요청에서도 새 목록을 강요하지 않는다", async () => {
    let judgments = 0;
    const h = harness(async () => { judgments++; return 1; });
    h.input();
    h.emit("tool_result", {
      toolName: "todo", isError: false,
      details: { phases: [{ tasks: [{ content: "work", status: "in_progress" }] }] },
    });
    h.input();
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
    h.emit("tool_result", {
      toolName: "todo", isError: false,
      details: { phases: [{ tasks: [{ content: "work", status: "completed" }] }] },
    });
    h.input();
    await Promise.resolve();
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(1);
    expect(judgments).toBe(2);
  });

  test("요청 발췌에서 경로·URL·코드를 제거하고 비밀이 있으면 판정하지 않는다", () => {
    const excerpts: string[] = [];
    const h = harness(async (excerpt) => { excerpts.push(excerpt); return 0; });
    h.input("`src/private.ts`를 보고 https://example.test/private 의 F:/hidden/file.ts와 비교한 뒤 검증해줘\n```js\nconst secretCode = 1;\n```");
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).not.toMatch(/src\/private|example\.test|hidden\/file|secretCode/);
    h.input("API key: sk_privatevalue12345678 을 검사해줘");
    expect(excerpts).toHaveLength(1);
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(1);
  });
});
