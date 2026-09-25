import { describe, expect, test } from "bun:test";
import turnEndGuard, { createTurnEndGuard } from "../turn-end-guard";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void | Promise<void>;

function harness(branch: unknown[] = [], classify?: Parameters<typeof createTurnEndGuard>[0]) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch } };
  (classify ? createTurnEndGuard(classify) : turnEndGuard)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown) => { sent.push(message); },
  } as unknown as Parameters<typeof turnEndGuard>[0]);
  const emit = (name: string, event: Record<string, unknown>) =>
    Promise.all((handlers[name] ?? []).map((handler) => handler(event, ctx)));
  const todo = (statuses: string[], isError = false) => emit("tool_result", {
    toolName: "todo", isError,
    details: { phases: [{ tasks: statuses.map((status, index) => ({ content: `work-${index}`, status })) }] },
  });
  const end = (text: string, extra: Record<string, unknown> = {}) => emit("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }], ...extra,
  });
  emit("session_start", {});
  return { emit, todo, end, sent };
}

describe("turn-end guard", () => {
  test("남은 작업이 있으면 약속 문구 없이 끝나도 한 번 이어 간다", () => {
    const h = harness();
    h.todo(["in_progress", "pending"]);
    h.end("원인은 확인했습니다.");
    h.end("다음에 처리하겠습니다.");
    expect(h.sent).toHaveLength(1);
    h.emit("input", { source: "extension" });
    h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
    h.emit("input", { source: "rpc" });
    h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(2);
  });

  test("미관측·완료·blocked 작업에는 인용 문구로 개입하지 않는다", () => {
    const h = harness();
    h.end('문구 예시: "계속"이라고 하시면 이어서 할게요.');
    h.todo(["completed", "abandoned", "blocked"]);
    h.end("다음 턴에 이어서 할게요.");
    expect(h.sent).toHaveLength(0);
    h.todo(["blocked", "pending"]);
    h.end("독립 작업이 남았습니다.");
    expect(h.sent).toHaveLength(1);
  });

  test("실패한 todo는 상태를 덮지 않고 성공한 완료는 개입을 멈춘다", () => {
    const h = harness();
    h.todo(["pending"]);
    h.todo(["completed"], true);
    h.end("정리했습니다.");
    expect(h.sent).toHaveLength(1);
    h.emit("input", { source: "interactive" });
    h.todo(["completed"]);
    h.end("계속할까요?");
    expect(h.sent).toHaveLength(1);
  });

  test("실제 승인 요청·도구 호출·자동 continuation은 개입하지 않는다", () => {
    const h = harness();
    h.todo(["in_progress"]);
    h.end("배포 승인해 주세요.");
    h.end("작업을 이어 갑니다.", { willContinue: true });
    h.emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "toolCall" }] }] });
    expect(h.sent).toHaveLength(0);
  });

  test("세션 복원은 durable todo를 사용하고 다른 세션 상태를 가져오지 않는다", () => {
    const branch: unknown[] = [{ type: "custom", customType: "user_todo_edit", data: {
      phases: [{ tasks: [{ content: "복원 작업", status: "in_progress" }] }],
    } }];
    const h = harness(branch);
    h.end("여기까지 확인했습니다.");
    expect(h.sent).toHaveLength(1);
    branch.length = 0;
    h.emit("session_start", {});
    h.end("다음 턴에 이어서 할게요.");
    expect(h.sent).toHaveLength(1);
  });

  test("형식적인 로컬 확인만 JEV 분류 후 한 번 이어 간다", async () => {
    const summaries: string[] = [];
    const h = harness([], async (summary) => {
      summaries.push(summary);
      return "routine_confirmation";
    });
    h.todo(["in_progress"]);
    await h.end("`E:/private/project.ts`의 기존 로컬 검사를 이어서 실행할까요?");
    await h.end("계속할까요?");
    expect(h.sent).toHaveLength(1);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toContain("E:/private");
  });

  test("공개 push와 provider 안전 승인은 분류기로 우회하지 않는다", async () => {
    let calls = 0;
    const h = harness([], async () => { calls += 1; return "routine_confirmation"; });
    h.todo(["pending"]);
    await h.end("index.html과 cuelo-benchmark.pdf를 커밋해서 GitHub Pages에 push할까요?\n\n네 승인을 받고 실행할게요.");
    await h.end("provider 안전 확인이 필요합니다. 승인해 주세요.");
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  test("사용자 방향 선택과 분류 실패는 자동 재개하지 않는다", async () => {
    let calls = 0;
    const h = harness([], async () => {
      calls += 1;
      if (calls === 1) return "user_choice";
      throw new Error("judge unavailable");
    });
    h.todo(["pending"]);
    await h.end("동작을 어느 쪽으로 바꿀지 정해 주세요.");
    await h.end("계속할까요?");
    expect(calls).toBe(1);
    h.emit("input", { source: "rpc" });
    await h.end("기존 로컬 검사를 진행할까요?");
    await h.end("계속할까요?");
    expect(calls).toBe(2);
    expect(h.sent).toHaveLength(0);
  });

  test.each(["input", "session_shutdown"])("%s 뒤 이전 분류 결과는 취소하고 버린다", async (eventName) => {
    const pending = Promise.withResolvers<"routine_confirmation">();
    let signal: AbortSignal | undefined;
    const h = harness([], async (_summary, _ctx, requestedSignal) => {
      signal = requestedSignal;
      return pending.promise;
    });
    h.todo(["in_progress"]);
    const oldEnd = h.end("기존 로컬 검사를 이어서 할까요?");
    await h.emit(eventName, { source: "rpc" });
    expect(signal?.aborted).toBe(true);
    pending.resolve("routine_confirmation");
    await oldEnd;
    expect(h.sent).toHaveLength(0);
  });

  test("판정 중 작업이 완료되면 늦은 결과가 세션을 다시 깨우지 않는다", async () => {
    const pending = Promise.withResolvers<"routine_confirmation">();
    let calls = 0;
    const h = harness([], async () => { calls += 1; return pending.promise; });
    h.todo(["pending"]);
    const oldEnd = h.end("기존 로컬 검사를 진행할까요?");
    await h.end("중간 결과입니다.");
    await h.todo(["completed"]);
    pending.resolve("routine_confirmation");
    await oldEnd;
    expect(calls).toBe(1);
    expect(h.sent).toHaveLength(0);
  });
});
