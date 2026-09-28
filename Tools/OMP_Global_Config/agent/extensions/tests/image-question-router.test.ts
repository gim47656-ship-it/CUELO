import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { createImageQuestionRouter, imageReadTarget, type ClassifyImageRead } from "../image-question-router";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

function harness(classify: ClassifyImageRead, modelInput: string[] = ["text", "image"]) {
  const handlers: Record<string, Handler[]> = {};
  const calls: Parameters<ClassifyImageRead>[0][] = [];
  createImageQuestionRouter(async (summary, ctx, signal) => {
    calls.push(summary);
    return classify(summary, ctx, signal);
  })({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
  } as unknown as ExtensionAPI);
  const ctx = { cwd: "test", modelRegistry: {}, model: { input: modelInput }, sessionManager: { getSessionId: () => "s" } };
  const emit = (name: string, event: Record<string, unknown>) => handlers[name]?.[0]?.(event, ctx);
  const user = (content: string) => emit("message_start", { message: { role: "user", content } });
  const read = (path: string, intro = "스크린샷에서 오류 문구를 확인하겠습니다.") => emit("tool_call", {
    toolName: "read", toolCallId: "c1", input: { path },
    assistantMessage: { role: "assistant", content: [{ type: "text", text: intro }, { type: "toolCall", id: "c1" }] },
  }) as Promise<{ block?: boolean; reason?: string } | undefined>;
  return { user, read, emit, calls };
}

describe("image question router", () => {
  test("텍스트 확인 용도면 막고 ?q= 재요청을 안내한 뒤, 같은 경로 두 번째 read는 통과시킨다", async () => {
    const h = harness(async () => "question");
    const first = await h.read("shots/err.png");
    expect(first?.block).toBe(true);
    expect(first?.reason).toContain("shots/err.png?q=");
    expect(await h.read("shots/err.png")).toBeUndefined();
    expect(h.calls).toHaveLength(1);
  });

  test.each(["direct", "unknown"] as const)("%s 판정은 read를 막지 않는다", async (route) => {
    const h = harness(async () => route);
    expect(await h.read("a.jpg")).toBeUndefined();
  });

  test("판정 실패는 통과시킨다", async () => {
    const h = harness(async () => { throw new Error("offline"); });
    expect(await h.read("a.png")).toBeUndefined();
  });

  test("판정에는 파일명과 경로·코드를 지운 발췌만 보낸다", async () => {
    const h = harness(async () => "direct");
    await h.user("C:/work/app 화면의 `total` 값을 확인해 줘");
    await h.read("D:/x/y/after.p1.png", "D:/x/y 에서 값을 읽겠습니다.");
    expect(h.calls[0]).toEqual({ file: "after.p1.png", assistant: "[path] 에서 값을 읽겠습니다.", request: "[path] 화면의 [literal] 값을 확인해 줘" });
  });

  test("secret 패턴이 보이면 판정을 부르지 않는다", async () => {
    const h = harness(async () => "question");
    await h.user("이 스크린샷의 api key 를 옮겨 줘");
    expect(await h.read("key.png")).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  test("이미지를 받지 못하는 모델에는 개입하지 않는다", async () => {
    const h = harness(async () => "question", ["text"]);
    expect(await h.read("a.png")).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  test("대상은 ?·URL 없는 이미지 경로뿐이다", () => {
    expect(imageReadTarget("a.PNG")).toBe("a.PNG");
    expect(imageReadTarget("local://image-1.webp")).toBe("local://image-1.webp");
    expect(imageReadTarget("a.png?q=what")).toBeUndefined();
    expect(imageReadTarget("https://x/a.png")).toBeUndefined();
    expect(imageReadTarget("a.pdf")).toBeUndefined();
    expect(imageReadTarget("a.svg")).toBeUndefined();
  });

  test("새 세션은 재요청 기록을 지운다", async () => {
    const h = harness(async () => "question");
    await h.read("a.png");
    await h.emit("session_start", {});
    expect((await h.read("a.png"))?.block).toBe(true);
  });
});
