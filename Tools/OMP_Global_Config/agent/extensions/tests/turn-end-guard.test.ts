import { describe, expect, test } from "bun:test";
import turnEndGuard, { createTurnEndGuard } from "../turn-end-guard";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void | Promise<void>;

function harness(
  branch: unknown[] = [],
  classify?: Parameters<typeof createTurnEndGuard>[0],
  classifyAnswers?: NonNullable<Parameters<typeof createTurnEndGuard>[1]>,
) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const deliveries: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => "main-session" } };
  (classify || classifyAnswers ? createTurnEndGuard(classify, classifyAnswers) : turnEndGuard)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown, options: unknown) => { sent.push(message); deliveries.push(options); },
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
  return { emit, todo, end, sent, deliveries };
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
    h.emit("input", { source: "rpc", text: "이어서 진행해" });
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
    h.emit("input", { source: "interactive", text: "작업 상태 알려줘" });
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
    h.emit("input", { source: "rpc", text: "다음 단계" });
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
    await h.emit(eventName, { source: "rpc", text: "새 입력" });
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
  test.each(["steering-only", "input-and-steering"])("사용자 중간 질문 %s와 이후 본문만 판정한다", async (delivery) => {
    const seen: unknown[] = [];
    const h = harness([], undefined, async (summary) => {
      seen.push(summary);
      return [false];
    });
    await h.emit("input", { source: "rpc", text: "원래 작업을 진행해" });
    if (delivery === "input-and-steering") await h.emit("input", { source: "rpc", text: "lint는 뭐?" });
    await h.emit("message_start", {
      message: { role: "user", steering: true, content: "lint는 뭐?", attribution: "user" },
    });
    const messages = [
      { role: "assistant", content: [{ type: "text", text: "이전 턴에서는 lint가 정적 분석이라고 답했습니다." }] },
      { role: "user", content: "lint는 뭐?", steering: true },
      { role: "assistant", content: [{ type: "text", text: "작업 중입니다." }] },
    ];
    await h.end("작업 중입니다.", { messages });
    await h.end("작업 중입니다.", { messages });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      questions: [{ question: "lint는 뭐?", assistant: "작업 중입니다." }],
    });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      customType: "turn-end-guard",
      content: expect.stringContaining("사용자 중간 질문 1건에 아직 답하지 않았다: lint는 뭐?"),
      display: false, attribution: "agent",
    });
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
  });

  test("여러 질문의 판정을 나눠 미답 요지만 알리고 기존 TODO 안내와 합친다", async () => {
    const h = harness([], async () => "unknown", async () => [true, false]);
    await h.emit("input", { source: "interactive", text: "Contributors 지정 가능?" });
    await h.emit("message_start", { message: { role: "user", content: "Contributors 지정 가능?" } });
    await h.emit("message_start", { message: { role: "user", steering: true, content: "다른 저장소의 Claude는 뭐?" } });
    await h.todo(["pending"]);
    const messages = [
      { role: "user", content: "Contributors 지정 가능?" },
      { role: "assistant", content: [{ type: "text", text: "Contributors는 설정에서 지정할 수 있습니다." }] },
      { role: "user", content: "다른 저장소의 Claude는 뭐?", steering: true },
      { role: "assistant", content: [{ type: "text", text: "작업을 마칩니다." }] },
    ];
    await h.end("작업을 마칩니다.", { messages });
    expect(h.sent).toHaveLength(1);
    const message = h.sent[0];
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") {
      throw new Error("aside content missing");
    }
    expect(message.content).toContain("사용자 중간 질문 1건에 아직 답하지 않았다: 다른 저장소의 Claude는 뭐?");
    expect(message.content).toContain("현재 TODO에 pending");
  });

  test("질문 없음·모두 답함·judge 실패·출처 불명에는 안내하지 않는다", async () => {
    let calls = 0;
    const h = harness([], undefined, async () => { calls += 1; return [true]; });
    await h.emit("input", { source: "extension", text: "사용자 질문?" });
    await h.end("질문이 없습니다.");
    await h.emit("message_start", { message: { role: "user", steering: true, synthetic: true, content: "합성 질문?" } });
    await h.emit("message_start", { message: { role: "user", steering: true, attribution: "agent", content: "에이전트 질문?" } });
    await h.end("질문이 없습니다.");
    expect(calls).toBe(0);
    await h.emit("input", { source: "interactive", text: "lint는 뭐?" });
    await h.end("lint는 정적 분석입니다.", { messages: [
      { role: "user", content: "lint는 뭐?" },
      { role: "assistant", content: [{ type: "text", text: "lint는 정적 분석입니다." }] },
    ] });
    expect(calls).toBe(1);
    expect(h.sent).toHaveLength(0);
    const failing = harness([], undefined, async () => { throw new Error("judge unavailable"); });
    await failing.emit("input", { source: "rpc", text: "lint는 뭐?" });
    await failing.end("작업 중입니다.", { messages: [
      { role: "user", content: "lint는 뭐?" },
      { role: "assistant", content: [{ type: "text", text: "작업 중입니다." }] },
    ] });
    expect(failing.sent).toHaveLength(0);
  });

  test("secret이 있으면 judge를 부르지 않고 경로·URL·literal·코드는 요약에서 제거한다", async () => {
    const seen: unknown[] = [];
    const h = harness([], undefined, async (summary) => { seen.push(summary); return [false]; });
    await h.emit("input", { source: "rpc", text: "password=unsafe 이 값은 뭐?" });
    await h.end("작업 중", { messages: [
      { role: "user", content: "password=unsafe 이 값은 뭐?" },
      { role: "assistant", content: [{ type: "text", text: "작업 중" }] },
    ] });
    expect(seen).toHaveLength(0);
    await h.emit("input", { source: "rpc", text: "`F:/private/file.ts`와 https://example.org/secret은 뭐?" });
    await h.end("C:/private/answer.ts를 조사 중", { messages: [
      { role: "user", content: "`F:/private/file.ts`와 https://example.org/secret은 뭐?" },
      { role: "assistant", content: [{ type: "text", text: "C:/private/answer.ts를 조사 중" }] },
    ] });
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).not.toMatch(/private|example\.org/);
    await h.emit("input", { source: "rpc", text: "lint는 뭐?" });
    await h.end("민감한 응답", { messages: [
      { role: "user", content: "lint는 뭐?" },
      { role: "assistant", content: [{ type: "text", text: "Authorization:Bearer short-value" }] },
    ] });
    expect(seen).toHaveLength(1);
  });

  test("child처럼 직접 입력 없는 세션·확장 출처·자동 continuation은 질문 판정 대상이 아니다", async () => {
    let calls = 0;
    const h = harness([], undefined, async () => { calls += 1; return [false]; });
    await h.emit("message_start", { message: { role: "user", steering: true, content: "첫 질문?" } });
    await h.end("진행 중", { messages: [
      { role: "user", content: "첫 질문?", steering: true },
      { role: "assistant", content: [{ type: "text", text: "진행 중" }] },
    ] });
    await h.emit("input", { source: "extension", text: "둘째 질문?" });
    await h.end("진행 중");
    await h.emit("input", { source: "rpc", text: "셋째 질문?" });
    await h.end("진행 중", { willContinue: true, messages: [
      { role: "user", content: "셋째 질문?" },
      { role: "assistant", content: [{ type: "text", text: "진행 중" }] },
    ] });
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  test("질문 다섯 개·각 300자·assistant 발췌를 제한한다", async () => {
    const seen: unknown[] = [];
    const h = harness([], undefined, async (summary) => {
      seen.push(summary);
      return Array(summary.questions.length).fill(true);
    });
    const longQuestion = `${"질문".repeat(180)}?`;
    const text = [longQuestion, "둘?", "셋?", "넷?", "다섯?", "여섯?"].join("\n");
    await h.emit("input", { source: "rpc", text });
    await h.end("답변", { messages: [
      { role: "user", content: text },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(3000) }] },
    ] });
    expect(seen).toHaveLength(1);
    const summary = seen[0];
    if (!summary || typeof summary !== "object" || !("questions" in summary) || !Array.isArray(summary.questions)) {
      throw new Error("question summary missing");
    }
    expect(summary.questions).toHaveLength(5);
    for (const item of summary.questions) {
      expect(item.question.length).toBeLessThanOrEqual(300);
      expect(item.assistant.length).toBeLessThanOrEqual(1403);
    }
  });

  test("assistant가 도구만 호출한 뒤 끝나도 질문 판정은 유지하고 TODO 안내만 건너뛴다", async () => {
    const h = harness([], undefined, async () => [false]);
    await h.emit("input", { source: "rpc", text: "lint는 뭐?" });
    await h.todo(["pending"]);
    await h.emit("agent_end", { messages: [
      { role: "user", content: "lint는 뭐?" },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }] },
    ] });
    expect(h.sent).toHaveLength(1);
    const message = h.sent[0];
    if (!message || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") {
      throw new Error("aside content missing");
    }
    expect(message.content).toContain("사용자 중간 질문 1건");
    expect(message.content).not.toContain("현재 TODO에 pending");
  });

  test("실제 세 질문은 모두 기록하고 작업 지시 두 문장은 질문으로 세지 않는다", async () => {
    const seen: string[] = [];
    const h = harness([], undefined, async (summary) => {
      seen.push(...summary.questions.map(item => item.question));
      return summary.questions.map(() => true);
    });
    const questions = [
      "Contributors 이걸로 지정맘대로가능하냐?",
      "lint 는뭐여?",
      "뭐 딴애들보니까 클로드 이런거들어가있던데이건뭐지.",
    ];
    for (const text of [...questions, "2번은 처리해주고", "그래도배포하자"]) {
      await h.emit("input", { source: "rpc", text });
      await h.end("다른 진행입니다.", { messages: [
        { role: "user", content: text },
        { role: "assistant", content: [{ type: "text", text: "다른 진행입니다." }] },
      ] });
    }
    expect(seen).toEqual(questions);
    expect(h.sent).toHaveLength(0);
  });

  test.each(["이건 뭐야.", "이건 뭔데", "이유는 왜", "어떻게", "가능한가", "가능한지", "맞냐", "했니", "했나요", "할까", "무슨 의미인지", "상태 알려줘", "작동을 설명해줘"])(
    "물음표 없는 한국어 질문형 어미도 판정한다: %s",
    async (text) => {
      const seen: string[] = [];
      const h = harness([], undefined, async (summary) => {
        seen.push(...summary.questions.map(item => item.question));
        return [true];
      });
      await h.emit("input", { source: "interactive", text });
      await h.end("진행합니다.", { messages: [
        { role: "user", content: text },
        { role: "assistant", content: [{ type: "text", text: "진행합니다." }] },
      ] });
      expect(seen).toEqual([text]);
    },
  );

  test("새 입력·세션이 이전 미답 질문의 늦은 판정을 취소한다", async () => {
    for (const eventName of ["input", "session_start"]) {
      const pending = Promise.withResolvers<boolean[]>();
      let signal: AbortSignal | undefined;
      const h = harness([], undefined, async (_summary, _ctx, requestedSignal) => {
        signal = requestedSignal;
        return pending.promise;
      });
      await h.emit("input", { source: "rpc", text: "lint는 뭐?" });
      const oldEnd = h.end("작업 중", { messages: [
        { role: "user", content: "lint는 뭐?" },
        { role: "assistant", content: [{ type: "text", text: "작업 중" }] },
      ] });
      await h.emit(eventName, { source: "rpc", text: "새 질문이 아닌 요청" });
      expect(signal?.aborted).toBe(true);
      pending.resolve([false]);
      await oldEnd;
      expect(h.sent).toHaveLength(0);
    }
  });
});
