import { describe, expect, test } from "bun:test";
import { createExternalAdviceCheck } from "../external-advice-check";

type Classify = Parameters<typeof createExternalAdviceCheck>[0];
type Handler = (event: Record<string, unknown>, ctx: unknown) => Promise<void> | void;

const SHION = [
  "SHION / ChatGPT 6 Pro 답변:",
  "### 보완할 것",
  "- 커밋 a1b2c3에서 설치 스크립트가 수정되었고 관련 파일만 finalize했다고 설명한다.",
  "- CI run 36220431643의 Setup source manifest는 성공했으며 해당 job의 모든 단계가 초록색이라고 주장한다.",
  "- 테스트 6개가 통과했으므로 이 변경은 안전하고 추가 검증이 불필요하다는 의견을 덧붙였다.",
  "맞어?",
].join("\n");

function harness(classify: Classify) {
  const handlers: Record<string, Handler[]> = {};
  const sent: Array<{ message: { content: string; customType: string; display: boolean; attribution: string }; options: { deliverAs: string } }> = [];
  createExternalAdviceCheck(classify)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: typeof sent[number]["message"], options: typeof sent[number]["options"]) => { sent.push({ message, options }); },
  } as unknown as Parameters<ReturnType<typeof createExternalAdviceCheck>>[0]);
  const ctx = { cwd: "test", modelRegistry: {}, model: {}, sessionManager: { getSessionId: () => "session" } };
  const emit = async (event: Record<string, unknown>) => { await Promise.all((handlers.input ?? []).map((handler) => handler(event, ctx))); };
  return { emit, sent };
}

const classify: Classify = async (candidates) => candidates.map((item) => item.includes("CI run") ? "CI" : item.includes("테스트") ? "테스트" : "파일");

describe("external advice check", () => {
  test("SHION 주장별 종류·방법을 단일 judge 호출과 단일 aside로 보낸다", async () => {
    const calls: string[][] = [];
    const h = harness(async (candidates, ctx, signal) => {
      expect(ctx.cwd).toBe("test");
      expect(signal.aborted).toBe(false);
      calls.push([...candidates]);
      return classify(candidates, ctx, signal);
    });
    await h.emit({ source: "rpc", text: SHION });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({
      message: { customType: "external-advice-check", display: false, attribution: "agent" },
      options: { deliverAs: "aside" },
    });
    expect(h.sent[0]!.message.content).toContain("[CI] CI run 36220431643");
    expect(h.sent[0]!.message.content).toContain("해당 run과 job의 실제 상태·로그를 조회");
    expect(h.sent[0]!.message.content).toContain("확인/반박/미확인");
    expect(h.sent[0]!.message.content).toContain("의견은 사실과 구분");
  });

  test("출처와 검증 요청 중 하나라도 빠지거나 extension 입력이면 호출·안내가 없다", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return []; });
    await h.emit({ source: "interactive", text: "ChatGPT 답변: CI는 성공했다." });
    await h.emit({ source: "interactive", text: "CI는 성공했다. 맞어?" });
    await h.emit({ source: "extension", text: SHION });
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  test("짧은 GPT·ChatGPT 일반 요청은 외부 답 인용으로 보지 않는다", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return []; });
    await h.emit({ source: "interactive", text: "GPT 모델 설정 확인해줘" });
    await h.emit({ source: "rpc", text: "ChatGPT 로그인 됐는지 확인해" });
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  test("제목·빈 bullet은 제외하고 경로·URL·코드 literal 없이 본문 주장만 judge에 전달한다", async () => {
    const observed: string[][] = [];
    const h = harness(async (candidates) => { observed.push([...candidates]); return candidates.map(() => "파일"); });
    await h.emit({ source: "interactive", text: [
      "### 보완할 것", "-", "- `src/hidden.ts`와 F:/private/config.yml에 변경이 있었다.",
      "- https://example.test/private/path 에 CI 결과가 있으며 보고된 run은 성공했다.",
      "- 실제 상대 경로 src/another-file.ts의 테스트 설정이 바뀌어 검증 범위가 달라졌다.",
      "```js", "const privateCode = 'never-send';", "```", "맞어?",
    ].join("\n") });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toHaveLength(3);
    expect(observed[0]!.join(" ")).not.toMatch(/src\/hidden|src\/another|private\/config|example\.test|never-send/);
    expect(observed[0]!.join(" ")).toContain("[path]");
    expect(observed[0]!.join(" ")).toContain("[url]");
    expect(observed[0]!.join(" ")).not.toContain("### 보완할 것");
    expect(observed[0]!.every((item) => item.length >= 10)).toBe(true);
  });

  test("secret·자격 패턴에서는 judge를 부르지 않고 원문을 재인용하지 않는다", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return []; });
    const credential = "sk_exampleSecretValue12345678";
    await h.emit({ source: "rpc", text: `${SHION}\nAPI key: ${credential}` });
    expect(calls).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.content).not.toContain(credential);
    expect(h.sent[0]!.message.content).toContain("각 주장을 도구로 확인");
  });

  test("judge 오류에는 짧은 미분류 지시만 남긴다", async () => {
    const h = harness(async () => { throw new Error("no credentials"); });
    await h.emit({ source: "interactive", text: SHION });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.message.content).not.toContain("a1b2c3");
    expect(h.sent[0]!.message.content).toContain("확인/반박/미확인");
  });

  test("후보는 12개로 제한하고 새 입력은 오래 걸리는 judge 결과를 취소한다", async () => {
    const deferred = Promise.withResolvers<"파일"[]>();
    let cancelled: AbortSignal | undefined;
    const h = harness((candidates, _ctx, signal) => {
      cancelled = signal;
      expect(candidates).toHaveLength(12);
      return deferred.promise;
    });
    const first = h.emit({ source: "interactive", text: `SHION\n${Array.from({ length: 20 }, (_, i) => `- 주장 ${i}의 파일이 실제로 바뀌었다.`).join("\n")}\n맞어?` });
    expect(cancelled?.aborted).toBe(false);
    await h.emit({ source: "interactive", text: "새로운 단순 작업" });
    expect(cancelled?.aborted).toBe(true);
    deferred.resolve(Array(12).fill("파일"));
    await first;
    expect(h.sent).toHaveLength(0);
  });
});
