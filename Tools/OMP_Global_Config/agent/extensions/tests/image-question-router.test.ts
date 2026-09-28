import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import imageQuestionRouter, { imageReadTarget } from "../image-question-router";

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
  test("첫 이미지 read는 용도와 무관하게 막고 ?q= 재요청을 안내하며, 같은 경로 두 번째 read는 통과시킨다", () => {
    const h = harness();
    const first = h.read("shots\\layout.png");
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain("shots/layout.png?q=");
    expect(h.read("shots/layout.png")).toBeUndefined();
    expect(h.read("shots/other.png")?.block).toBe(true);
  });

  test("이미지를 받지 못하는 모델에는 개입하지 않는다", () => {
    expect(harness(["text"]).read("a.png")).toBeUndefined();
  });

  test("대상은 ?·URL 없는 이미지 경로뿐이다", () => {
    expect(imageReadTarget("a.PNG")).toBe("a.PNG");
    expect(imageReadTarget("local://image-1.webp")).toBe("local://image-1.webp");
    expect(imageReadTarget("a.png?q=what")).toBeUndefined();
    expect(imageReadTarget("https://x/a.png")).toBeUndefined();
    expect(imageReadTarget("a.pdf")).toBeUndefined();
    expect(imageReadTarget("a.svg")).toBeUndefined();
  });

  test("새 세션은 재요청 기록을 지운다", () => {
    const h = harness();
    h.read("a.png");
    h.emit("session_start", {});
    expect(h.read("a.png")?.block).toBe(true);
  });
});
