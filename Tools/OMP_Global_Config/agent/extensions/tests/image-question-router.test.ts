import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import imageQuestionRouter, { imageRead } from "../image-question-router";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function harness(modelInput: string[] = ["text", "image"]) {
  const handlers: Record<string, Handler[]> = {};
  imageQuestionRouter({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
  } as unknown as ExtensionAPI);
  const ctx = { model: { input: modelInput } };
  const emit = (name: string, event: Record<string, unknown>) => handlers[name]?.[0]?.(event, ctx);
  const read = (path: string) =>
    emit("tool_call", { toolName: "read", toolCallId: "c1", input: { path } }) as { block?: boolean; reason?: string } | undefined;
  return { read, emit };
}

describe("image question router", () => {
  test("질문 없는 이미지 read는 다시 시도해도 막고, 같은 경로로 ?q= 질문을 한 뒤에만 직접 read를 통과시킨다", () => {
    const h = harness();
    const first = h.read("shots\\layout.png");
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain("shots/layout.png?q=");
    expect(h.read("shots/layout.png")?.block).toBe(true);
    expect(h.read("shots/layout.png?q=버튼이 잘렸나")).toBeUndefined();
    expect(h.read("shots\\layout.png")).toBeUndefined();
    expect(h.read("shots/other.png")?.block).toBe(true);
  });

  test("이미지를 받지 못하는 모델에는 개입하지 않는다", () => {
    expect(harness(["text"]).read("a.png")).toBeUndefined();
  });

  test("대상은 URL이 아닌 이미지 경로이고, ?q= 여부를 함께 읽는다", () => {
    expect(imageRead("a.PNG")).toEqual({ target: "a.PNG", asked: false });
    expect(imageRead("local://image-1.webp")).toEqual({ target: "local://image-1.webp", asked: false });
    expect(imageRead("a.png?q=what")).toEqual({ target: "a.png", asked: true });
    expect(imageRead("https://x/a.png")).toBeUndefined();
    expect(imageRead("a.pdf")).toBeUndefined();
    expect(imageRead("a.svg")).toBeUndefined();
  });

  test("새 세션은 질문 기록을 지운다", () => {
    const h = harness();
    h.read("a.png?q=무엇이 보이나");
    h.emit("session_start", {});
    expect(h.read("a.png")?.block).toBe(true);
  });
});
