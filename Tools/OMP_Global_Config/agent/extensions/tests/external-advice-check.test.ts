import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createExternalAdviceCheck } from "../external-advice-check";

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

/**
 * choice: 가짜 JEV가 돌려줄 판정. "fail"이면 판정기가 실패한다(지금 동작 유지 경로). probabilities를 주면 그 분포를 쓴다.
 * gate를 주면 그 promise가 끝날 때까지 판정이 끝나지 않는다.
 */
function harness(choice: string = "external-advice", options: { probabilities?: Record<string, number>; gate?: Promise<void> } = {}) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const judged: unknown[] = [];
  createExternalAdviceCheck({
    resolveJudge: async () => {
      if (choice === "fail") throw new Error("no judge");
      return {
        judge: async (request) => {
          judged.push(request.state);
          await options.gate;
          return { answers: { source: { type: "choice", choice, probabilities: options.probabilities ?? { [choice]: 0.9 } } } } as never;
        },
      };
    },
  })({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown) => { sent.push(message); },
  } as unknown as ExtensionAPI);
  const ctx = { cwd: "test" };
  const emit = (event: Record<string, unknown>) => { for (const handler of handlers.input ?? []) handler(event, ctx); };
  /** 실행 중 끼어든 사람의 메시지. */
  const steer = (content: string) => { for (const handler of handlers.message_start ?? []) handler({ message: { role: "user", content, steering: true } }, ctx); };
  /** 코어가 그 prompt의 준비 단계에서 모으는 메시지. */
  const start = async (prompt: string) => {
    const results = await Promise.all((handlers.before_agent_start ?? []).map((handler) => handler({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx)));
    return results.flatMap((result) => (result as { message?: Message } | undefined)?.message ?? []);
  };
  return { emit, steer, start, sent, judged };
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

  // 2026-10-30 실제 감지: 앱이 만든 보수 점검 보고 섹션을 붙여 넣은 입력에도 외부 조언 검증 안내가 붙었다.
  const UPKEEP = [
    "CUELO 보수 점검: 작업 병목 섹션",
    "",
    "점검 기간:",
    "- 최근 7일: 2026-10-23 ~ 2026-10-30",
    "- 비교 기간(직전 7일): 2026-10-16 ~ 2026-10-23",
    "- 보고서 생성: 2026-10-30 23:54 (세션 파일 298개를 읽음)",
    "",
    "섹션 판정: 문제 · Maker partial 종료가 늘었다. 이 내용 맞는지 확인해줘.",
  ].join("\n");

  test("JEV가 이 도구의 보고·상태 글이라고 하면 안내를 붙이지 않고, 외부 조언이면 붙인다", async () => {
    const report = harness("internal-report-or-status");
    report.emit({ source: "rpc", text: UPKEEP });
    expect(await report.start(UPKEEP)).toHaveLength(0);
    expect(report.judged).toHaveLength(1);

    const advice = harness("external-advice");
    advice.emit({ source: "rpc", text: SHION });
    expect(await advice.start(SHION)).toHaveLength(1);
  });

  test("판정 실패, unknown, 낮은 확신, 다른 label에 걸친 분포면 지금처럼 안내를 붙인다", async () => {
    for (const [choice, probabilities] of [
      ["fail", undefined],
      ["unknown", undefined],
      // cross-review(xr-20261030211626-f458f4) R1-OAI-2: 지우는 label을 고르고 0.5 이상일 때만 뺀다.
      ["internal-report-or-status", { "internal-report-or-status": 0.45, "external-advice": 0.3, unknown: 0.25 }],
      ["external-advice", { "external-advice": 0.4, "internal-report-or-status": 0.35, unknown: 0.25 }],
      // 2차 체인 R2-OAI-2: 확률이 없거나 NaN이면 확신을 지어내지 않는다.
      ["internal-report-or-status", {}],
      ["internal-report-or-status", { "internal-report-or-status": Number.NaN }],
    ] as const) {
      const h = harness(choice, { probabilities });
      h.emit({ source: "rpc", text: UPKEEP });
      expect(await h.start(UPKEEP)).toHaveLength(1);
    }
  });

  // R1-OAI-1: 비밀처럼 보이는 문장은 판정기에 보내지 않고 지금처럼 안내한다.
  test("비밀 패턴이 있으면 판정기를 부르지 않고 안내를 붙인다", async () => {
    const text = `${UPKEEP}\n토큰 값은 바꾸지 않았다.`;
    const h = harness("internal-report-or-status");
    h.emit({ source: "rpc", text });
    expect(await h.start(text)).toHaveLength(1);
    expect(h.judged).toHaveLength(0);
  });

  // R1-OAI-4: ~~~ 펜스와 여러 backtick literal도 판정기에 보내지 않는다.
  test("~~~ 코드 펜스와 여러 backtick literal은 발췌에서 가린다", async () => {
    const text = `${SHION}\n~~~\nprivate-fence-body\n~~~\n그리고 \`\`a \`b\` private-literal\`\` 도 봐줘.`;
    const h = harness("external-advice");
    h.emit({ source: "rpc", text });
    await h.start(text);
    const excerpt = JSON.stringify(h.judged[0]);
    expect(excerpt).not.toContain("private-fence-body");
    expect(excerpt).not.toContain("private-literal");
  });

  // R1-OAI-7: 판정을 기다리는 동안 새 입력이나 사람의 steering이 오면 옛 판정으로 안내하지 않는다.
  test("새 입력이나 steering이 오면 이전 입력의 판정으로 안내하지 않는다", async () => {
    const gate = Promise.withResolvers<void>();
    const newer = harness("external-advice", { gate: gate.promise });
    newer.emit({ source: "rpc", text: SHION });
    const started = newer.start(SHION);
    newer.emit({ source: "rpc", text: "다른 요청" });
    gate.resolve();
    expect(await started).toHaveLength(0);

    const steered = harness("external-advice");
    steered.emit({ source: "rpc", text: SHION });
    steered.steer("아니 그거 말고 다른 거 먼저 해줘");
    expect(await steered.start(SHION)).toHaveLength(0);
  });
});
