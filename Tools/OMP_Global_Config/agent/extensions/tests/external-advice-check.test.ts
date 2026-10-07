import { describe, expect, test } from "bun:test";
import externalAdviceCheck from "../external-advice-check";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

const SHION = [
  "SHION / ChatGPT 6 Pro 답변:",
  "### 보완할 것",
  "- 커밋 a1b2c3에서 설치 스크립트가 수정되었고 관련 파일만 finalize했다고 설명한다.",
  "- CI run 36220431643의 Setup source manifest는 성공했으며 해당 job의 모든 단계가 초록색이라고 주장한다.",
  "- 테스트 6개가 통과했으므로 이 변경은 안전하고 추가 검증이 불필요하다는 의견을 덧붙였다.",
  "맞어?",
].join("\n");

type Message = { content: string; customType: string; display: boolean; attribution: string };

function harness() {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  externalAdviceCheck({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown) => { sent.push(message); },
  } as unknown as Parameters<typeof externalAdviceCheck>[0]);
  const ctx = { cwd: "test" };
  const emit = (event: Record<string, unknown>) => { for (const handler of handlers.input ?? []) handler(event, ctx); };
  /** 코어가 그 prompt의 준비 단계에서 모으는 메시지. */
  const start = async (prompt: string) => {
    const results = await Promise.all((handlers.before_agent_start ?? []).map((handler) => handler({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx)));
    return results.flatMap((result) => (result as { message?: Message } | undefined)?.message ?? []);
  };
  return { emit, start, sent };
}

describe("external advice check", () => {
  test("외부 답 검증 요청에는 그 prompt에 기본 검증 지시 하나만 붙이고 원문을 다시 싣지 않는다", async () => {
    const h = harness();
    h.emit({ source: "rpc", text: SHION });
    const messages = await h.start(SHION);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ customType: "external-advice-check", display: false, attribution: "agent" });
    expect(messages[0]!.content).toContain("확인/반박/미확인");
    expect(messages[0]!.content).toContain("의견·제안은 사실 판정과 구분");
    expect(messages[0]!.content).not.toMatch(/a1b2c3|36220431643/);
  });

  test("입력만으로는 별도 턴을 여는 메시지를 보내지 않고, 다른 본문의 prompt에는 붙지 않는다", async () => {
    // 회귀: idle 세션에 aside를 보내면 안내만으로 턴이 열리고 사용자 본문 prompt가 거절됐다.
    const h = harness();
    h.emit({ source: "rpc", text: SHION });
    expect(h.sent).toHaveLength(0);
    expect(await h.start("goal continuation 같은 내부 prompt")).toHaveLength(0);
    // 정책 경합으로 같은 prompt의 준비가 다시 불려도 같은 안내를 받는다.
    expect(await h.start(SHION)).toHaveLength(1);
    expect(await h.start(SHION)).toHaveLength(1);
    h.emit({ source: "rpc", text: "새로운 단순 작업" });
    expect(await h.start(SHION)).toHaveLength(0);
  });

  test("출처와 검증 요청 중 하나라도 빠지거나 extension 입력이면 안내가 없다", async () => {
    const h = harness();
    for (const [source, text] of [["interactive", "ChatGPT 답변: CI는 성공했다."], ["interactive", "CI는 성공했다. 맞어?"], ["extension", SHION]] as const) {
      h.emit({ source, text });
      expect(await h.start(text)).toHaveLength(0);
    }
  });

  test("짧은 GPT·ChatGPT 일반 요청은 외부 답 인용으로 보지 않는다", async () => {
    const h = harness();
    for (const [source, text] of [["interactive", "GPT 모델 설정 확인해줘"], ["rpc", "ChatGPT 로그인 됐는지 확인해"]] as const) {
      h.emit({ source, text });
      expect(await h.start(text)).toHaveLength(0);
    }
  });
});
