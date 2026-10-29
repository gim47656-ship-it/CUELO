import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createUserInputInterpreter, INPUT_TRANSLATION_TYPE, type TranslateInput } from "../user-input-interpreter";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Sent = { customType: string; content: string; display: boolean };

const KOREAN = "디스크 임시파일 정리하고 압축해줘";

function harness(translate: TranslateInput, kind: "main" | "sub" = "main", idle = false, timeoutMs?: number) {
  const handlers: Record<string, Handler[]> = {};
  const sent: Sent[] = [];
  const deliveries: unknown[] = [];
  const calls: string[] = [];
  createUserInputInterpreter(async (text, ctx, signal) => { calls.push(text); return translate(text, ctx, signal); }, timeoutMs)({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: Sent, options: unknown) => { sent.push(message); deliveries.push(options); },
  } as unknown as ExtensionAPI);
  const ctx = { agent: { kind }, isIdle: () => idle };
  const emit = (name: string, event: Record<string, unknown>) => handlers[name]?.map((h) => h(event, ctx)) ?? [];
  const prompt = async (text: string) => (await Promise.all(emit("before_agent_start", { reason: "prompt", prompt: text, systemPrompt: [] })))[0] as
    | { message?: Sent } | undefined;
  const userMessage = async (text: string) => {
    emit("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { prompt, userMessage, sent, deliveries, calls };
}

describe("user-input-interpreter", () => {
  test("한국어 프롬프트에는 영어 번역을 같은 요청의 숨김 메시지로 싣고, 같은 글의 user 메시지에서 다시 번역하지 않는다", async () => {
    const h = harness(async () => "Clean up the disk temp files and compact it");
    const result = await h.prompt(KOREAN);
    expect(result?.message).toMatchObject({ customType: INPUT_TRANSLATION_TYPE, display: false });
    expect(result?.message?.content).toContain("Clean up the disk temp files and compact it");
    await h.userMessage(KOREAN);
    expect(h.calls).toEqual([KOREAN]);
    expect(h.sent).toHaveLength(0);
  });

  test("실행 중 끼어든 한국어 메시지는 번역이 오면 aside로 붙인다", async () => {
    const h = harness(async () => "But is npm really needed?");
    await h.userMessage("근데 npm 이꼭필요해?");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ customType: INPUT_TRANSLATION_TYPE, display: false });
    expect(h.sent[0]!.content).toContain("But is npm really needed?");
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
  });

  test("영어·비밀처럼 보이는 글·서브 에이전트는 번역하지 않고, 번역 실패는 원문만 보낸다", async () => {
    const h = harness(async () => "x");
    expect(await h.prompt("please fix the failing test in lib/a.ts")).toBeUndefined();
    // 키 모양은 실행 중에 조립한다(원문에 있으면 프로필 반영 전 비밀값 검사가 막는다).
    expect(await h.prompt(`이 토큰 ${"sk" + "-"}abcdefghijklmnop1234 로 로그인해줘`)).toBeUndefined();
    const sub = harness(async () => "x", "sub");
    expect(await sub.prompt(KOREAN)).toBeUndefined();
    expect(sub.calls).toHaveLength(0);
    const failing = harness(async () => { throw new Error("provider down"); });
    expect(await failing.prompt(KOREAN)).toBeUndefined();
    await failing.userMessage("다른 한국어 끼어들기 메시지");
    expect(failing.sent).toHaveLength(0);
  });

  test("번역기가 abort를 무시해도 기한이 지나면 덧붙이지 않고 원문만 보낸다", async () => {
    const never = harness(() => Promise.withResolvers<string>().promise, "main", false, 0);
    expect(await never.prompt(KOREAN)).toBeUndefined();
    // abort를 받고도 결과를 돌려주는 번역기: 기한 뒤에 온 번역은 붙이지 않는다.
    const late = harness((_text, _ctx, signal) => {
      const { promise, resolve } = Promise.withResolvers<string>();
      signal.addEventListener("abort", () => resolve("late translation"), { once: true });
      return promise;
    }, "main", false, 0);
    expect(await late.prompt(KOREAN)).toBeUndefined();
  });

  test("프롬프트 글의 일부일 뿐인 다른 끼어들기 메시지는 따로 번역한다", async () => {
    const h = harness(async (text) => (text === KOREAN ? "Clean up and compact" : "Only the temp files"));
    await h.prompt(KOREAN);
    await h.userMessage("디스크 임시파일");
    expect(h.calls).toEqual([KOREAN, "디스크 임시파일"]);
    expect(h.sent).toHaveLength(1);
  });
});
