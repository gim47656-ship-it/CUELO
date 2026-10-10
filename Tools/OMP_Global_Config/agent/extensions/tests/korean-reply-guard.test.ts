import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  classify, createKoreanReplyGuard, REMINDER_TYPE, TRANSLATION_TYPE, type TranslateReply,
} from "../korean-reply-guard";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Sent = { customType: string; content: string; display: boolean };

const ENGLISH = "I'm now going to inspect the extension loader and then write the focused regression test for it.";
const KOREAN = "확장 로더를 먼저 확인하고, 그다음 `skim.ts`의 callModel 경로와 HIKARI 번역 호출을 비교하겠습니다.";

function harness(translate: TranslateReply, kind: "main" | "sub" = "main") {
  const handlers: Record<string, Handler[]> = {};
  const sent: Sent[] = [];
  const deliveries: unknown[] = [];
  createKoreanReplyGuard(translate)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: Sent, options: unknown) => { sent.push(message); deliveries.push(options); },
  } as unknown as ExtensionAPI);
  const ctx = { agent: { kind }, isIdle: () => true };
  const emit = (name: string, event: Record<string, unknown> = {}) =>
    handlers[name]?.map((h) => h(event, ctx)) ?? [];
  const user = (text: string) => emit("message_start", { message: { role: "user", content: text } });
  const assistant = async (text: string, toolCall = false) => {
    emit("message_end", { message: { role: "assistant", content: [{ type: "text", text }, ...(toolCall ? [{ type: "toolCall" }] : [])] } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { emit, user, assistant, sent, deliveries, handlers, ctx };
}

const ok: TranslateReply = async () => "번역문";

describe("classify", () => {
  test("영어 API·경로·식별자가 섞인 정상 한국어는 드리프트가 아니다", () => {
    expect(classify(KOREAN)).toBe("korean");
    expect(classify("Tools/OMP_Global_Config/setup.ps1 의 safetyFiles 목록에 korean-reply-guard.ts 를 추가했고 bun test 도 통과했습니다.")).toBe("korean");
    expect(classify("WebSocket과 TypeScript, Gemini Flash, Cloudflare Workers 설정을 모두 확인했습니다.")).toBe("korean");
  });
  test("영어 진행 문장은 드리프트", () => {
    expect(classify(ENGLISH)).toBe("drift");
  });
  test("코드 블록·URL·원본 오류만 영어면 판정하지 않는다", () => {
    expect(classify("검증 결과를 정리해서 아래에 그대로 붙입니다.\n```\nThis is a long English log line that should be preserved verbatim here\n```")).toBe("korean");
    expect(classify("TypeError: Cannot read properties of undefined while parsing the configuration object value")).toBe("neutral");
  });
  test("짧은 영어는 판정하지 않는다", () => {
    expect(classify("Done. Checking now.")).toBe("neutral");
  });
});

describe("korean reply guard", () => {
  test("첫 드리프트도 알림 1회와 함께 그 메시지를 번역해 표시한다", async () => {
    const seen: string[] = [];
    const h = harness(async (text) => { seen.push(text); return "번역문"; });
    await h.assistant(ENGLISH);
    expect(seen).toEqual([ENGLISH]);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[0]).toMatchObject({ customType: REMINDER_TYPE, display: false });
    expect(h.sent[0]!.content).toContain("한국어");
    expect(h.deliveries[0]).toEqual({ deliverAs: "nextTurn" });
    expect(h.sent[1]).toMatchObject({ customType: TRANSLATION_TYPE, display: true, content: "[한국어 번역]\n번역문" });
  });

  test("도구 호출이 이어지는 드리프트 알림은 aside로 끼운다", async () => {
    const h = harness(ok);
    await h.assistant(ENGLISH, true);
    expect(h.deliveries[0]).toEqual({ deliverAs: "aside" });
  });

  test("연속 드리프트는 알림 없이 메시지마다 번역하고 같은 메시지는 두 번 번역하지 않는다", async () => {
    const seen: string[] = [];
    const h = harness(async (text) => { seen.push(text); return "한국어 번역"; });
    await h.assistant(ENGLISH);
    await h.assistant(ENGLISH + " Second part.");
    expect(seen).toEqual([ENGLISH, ENGLISH + " Second part."]);
    expect(h.sent.map((m) => m.customType)).toEqual([REMINDER_TYPE, TRANSLATION_TYPE, TRANSLATION_TYPE]);
    h.emit("message_end", { message: { role: "assistant", content: [{ type: "text", text: ENGLISH + " Second part." }] } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(seen).toHaveLength(2);
  });

  test("긴 드리프트도 앞부분만 자르지 않고 전체를 번역기에 넘긴다", async () => {
    const seen: string[] = [];
    const h = harness(async (text) => { seen.push(text); return "번역문"; });
    const long = Array.from({ length: 120 }, (_, i) => `${ENGLISH} Paragraph ${i}.`).join("\n");
    expect(long.length).toBeGreaterThan(4000);
    await h.assistant(long);
    expect(seen).toEqual([long.trim()]);
  });

  test("빠르게 이어진 드리프트들은 각각 번역되어 모두 표시된다", async () => {
    const resolvers: ((value: string) => void)[] = [];
    const h = harness(() => new Promise<string>((resolve) => { resolvers.push(resolve); }));
    await h.assistant(ENGLISH);
    await h.assistant(ENGLISH + " First.");
    expect(resolvers).toHaveLength(2);
    resolvers[1]!("둘째");
    resolvers[0]!("첫째");
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.sent.filter((m) => m.customType === TRANSLATION_TYPE).map((m) => m.content)).toEqual(["[한국어 번역]\n둘째", "[한국어 번역]\n첫째"]);
  });

  test("번역 메시지는 모델 문맥에서 빠진다", () => {
    const h = harness(ok);
    const messages = [
      { role: "user", content: "q" },
      { role: "custom", customType: TRANSLATION_TYPE, content: "번역" },
      { role: "custom", customType: "other", content: "유지" },
    ];
    const result = h.emit("context", { messages })[0] as { messages: unknown[] };
    expect(result.messages).toEqual([messages[0], messages[2]]);
    expect(h.emit("context", { messages: [messages[0]] })[0]).toBeUndefined();
  });

  test("한국어로 돌아오면 리셋되어 다음 드리프트는 다시 알림을 보낸다", async () => {
    const h = harness(ok);
    await h.assistant(ENGLISH);
    await h.assistant(KOREAN);
    await h.assistant("Now I will inspect another module and then summarize the remaining open risks.");
    expect(h.sent.filter((m) => m.customType === REMINDER_TYPE)).toHaveLength(2);
    expect(h.sent.filter((m) => m.customType === TRANSLATION_TYPE)).toHaveLength(2);
  });

  test("서브에이전트 세션은 건너뛴다", async () => {
    const h = harness(ok, "sub");
    await h.assistant(ENGLISH);
    expect(h.sent).toHaveLength(0);
  });

  test("사용자가 영어로 썼거나 영어 답을 요청하면 건너뛴다", async () => {
    const a = harness(ok);
    a.user("Please explain what the extension loader does and how it rebinds subagent sessions.");
    await a.assistant(ENGLISH);
    expect(a.sent).toHaveLength(0);
    const b = harness(ok);
    b.user("이 내용을 영어로 설명해줘");
    await b.assistant(ENGLISH);
    expect(b.sent).toHaveLength(0);
    b.user("이제 한국어로 계속해");
    await b.assistant(ENGLISH);
    expect(b.sent.map((m) => m.customType)).toEqual([REMINDER_TYPE, TRANSLATION_TYPE]);
  });

  test("비밀처럼 보이면 번역을 보내지 않고 생략 한 줄만 남긴다", async () => {
    let calls = 0;
    const h = harness(async () => { calls++; return "x"; });
    // 가짜 키는 실행 중에 조립한다. 원문에 키 모양이 있으면 프로필 반영 전 비밀값 검사가 막는다.
    await h.assistant(`The configuration uses api_key = ${"sk" + "-"}abcdefghijklmnop123456 and then restarts the worker process now.`);
    expect(calls).toBe(0);
    expect(h.sent[1]!.content).toContain("번역 생략");
  });

  test("번역 실패는 실패 한 줄만 표시한다", async () => {
    const h = harness(async () => { throw new Error("no credentials"); });
    await h.assistant(ENGLISH);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toMatchObject({ customType: TRANSLATION_TYPE, display: true });
    expect(h.sent[1]!.content).toContain("번역 실패");
  });
});
