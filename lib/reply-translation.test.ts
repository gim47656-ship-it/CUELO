import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createKoreanReplyGuard } from "../Tools/OMP_Global_Config/agent/extensions/korean-reply-guard";
import { attachReplyTranslations, REPLY_TRANSLATION_CUSTOM_TYPE } from "./reply-translation";
import { buildTranscriptRenderPlan, partitionTranscriptPlan } from "./transcript-plan";
import type { AgentMessage, AssistantMessage, CustomMessage } from "./types";

const ENGLISH_A = "I'm now going to inspect the extension loader and then write the focused regression test for it.";
const ENGLISH_B = "Next I will compare the session reader output with the live stream and report what differs.";

const user = (text: string): AgentMessage => ({ role: "user", content: text });
const assistant = (text: string, timestamp: number, extra: AssistantMessage["content"] = []): AssistantMessage => ({
  role: "assistant", provider: "anthropic", model: "m", timestamp, content: [{ type: "text", text }, ...extra],
});

/** 실제 확장이 이 assistant 메시지에 대해 보내는 번역 통지를 받는다(hash 계약을 손으로 복제하지 않는다). */
async function translationFor(source: AssistantMessage, translate: () => Promise<string> = async () => "번역문"): Promise<CustomMessage> {
  const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
  const sent: CustomMessage[] = [];
  createKoreanReplyGuard(translate)({
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: Omit<CustomMessage, "role">) => { sent.push({ role: "custom", ...message }); },
  } as unknown as ExtensionAPI);
  handlers.message_end![0]!({ message: structuredClone(source) }, { agent: { kind: "main" }, isIdle: () => true });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const translation = sent.find((message) => message.customType === REPLY_TRANSLATION_CUSTOM_TYPE);
  if (!translation) throw new Error("확장이 번역 통지를 보내지 않았다");
  return translation;
}

const translationOf = (messages: AgentMessage[], idx: number) => (messages[idx] as AssistantMessage).replyTranslation;

describe("attachReplyTranslations", () => {
  test("순서가 뒤바뀌어 도착한 번역도 각자 원문 말풍선에 붙는다", async () => {
    const a = assistant(ENGLISH_A, 1000);
    const b = assistant(ENGLISH_B, 2000);
    const tb = await translationFor(b, async () => "B 번역");
    const ta = await translationFor(a, async () => "A 번역");
    const out = attachReplyTranslations([user("질문"), a, b, tb, ta]);
    expect(translationOf(out, 1)).toEqual({ kind: "translated", text: "A 번역", original: ENGLISH_A });
    expect(translationOf(out, 2)).toEqual({ kind: "translated", text: "B 번역", original: ENGLISH_B });
  });

  test("timestamp가 달라도 텍스트 hash가 같은 원문 하나를 찾는다", async () => {
    const a = assistant(ENGLISH_A, 1000);
    const ta = await translationFor(a);
    const out = attachReplyTranslations([user("질문"), { ...a, timestamp: 999 }, ta]);
    expect(translationOf(out, 1)?.text).toBe("번역문");
  });

  test("같은 밀리초의 두 답은 텍스트 hash로 가르고, hash까지 같으면 어느 쪽에도 붙이지 않는다", async () => {
    const a = assistant(ENGLISH_A, 1000);
    const b = assistant(ENGLISH_B, 1000);
    const ta = await translationFor(a);
    const split = attachReplyTranslations([user("질문"), a, b, ta]);
    expect(translationOf(split, 1)?.text).toBe("번역문");
    expect(translationOf(split, 2)).toBeUndefined();

    const twin = assistant(ENGLISH_A, 1000);
    const ambiguous = attachReplyTranslations([user("질문"), a, twin, ta]);
    expect(translationOf(ambiguous, 1)).toBeUndefined();
    expect(translationOf(ambiguous, 2)).toBeUndefined();
    expect((ambiguous[3] as CustomMessage).details).toBeUndefined();
  });

  test("생략·실패 통지는 안내 한 줄로 붙고 잘린 번역은 잘림 안내를 그대로 가진다", async () => {
    const a = assistant(`${ENGLISH_A} token sk-ant-api03-${"x".repeat(40)}`, 1000);
    const b = assistant(ENGLISH_B, 2000);
    const c = assistant(`${ENGLISH_A} again`, 3000);
    const skipped = await translationFor(a);
    const failed = await translationFor(b, async () => { throw new Error("down"); });
    const cut = await translationFor(c, async () => "앞부분\n\n[번역이 모델 출력 한도에서 끊겼다. 나머지는 원문을 본다.]");
    const out = attachReplyTranslations([user("질문"), a, b, c, skipped, failed, cut]);
    expect(translationOf(out, 1)?.kind).toBe("skipped");
    expect(translationOf(out, 1)?.text).toStartWith("[번역 생략]");
    expect(translationOf(out, 2)?.kind).toBe("failed");
    expect(translationOf(out, 2)?.text).toStartWith("[번역 실패]");
    expect(translationOf(out, 3)?.text).toContain("[번역이 모델 출력 한도에서 끊겼다.");
  });

  test("연결 없는 옛 번역은 그대로 상자로 남고 연결된 번역은 작업 로그에서 빠진다", async () => {
    const a = assistant(ENGLISH_A, 1000, [{ type: "toolCall", toolCallId: "t1", toolName: "read", input: {} }]);
    const b = assistant(ENGLISH_B, 2000);
    const legacy: CustomMessage = { role: "custom", customType: REPLY_TRANSLATION_CUSTOM_TYPE, content: "[한국어 번역]\n옛 번역", display: true };
    const linked = await translationFor(a);
    // 끝에 사용자 질문이 없어 busy일 때 이 턴은 평평한 라이브 꼬리 경로를 탄다.
    const messages = attachReplyTranslations([user("질문"), a, legacy, linked, b]);
    expect(messages[2]).toBe(legacy);
    for (const busy of [false, true]) {
      const { process } = partitionTranscriptPlan(messages, buildTranscriptRenderPlan(messages, { sessionBusy: busy }));
      const processIdx = process.flatMap((group) => group.entries.map((entry) => entry.idx));
      expect(processIdx).toContain(2);
      expect(processIdx).not.toContain(3);
    }
  });
});
