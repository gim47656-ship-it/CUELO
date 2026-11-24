import { describe, expect, test } from "bun:test";
import { createEditLessons } from "../edit-lessons";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

/** 재시작 직후 복원만 시험한다: developer 기록을 넣고 session_start 뒤 x.ts 편집에 붙는 기억을 본다. */
async function editAfterRestore(content: string | Array<{ type: "text"; text: string }>, ids: string[]): Promise<string | undefined> {
  const handlers: Record<string, Handler[]> = {};
  createEditLessons({})({ on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler), logger: { debug: () => {} } } as never);
  const entries = [{ type: "message", message: { role: "developer", content } }];
  const items = ids.map((id) => ({ id, content: `x.ts 교훈 ${id}`, source: "coding-agent-learn", score: 0.5 }));
  const ctx = {
    cwd: "/repo",
    sessionManager: { getSessionId: () => "s", getEntries: () => entries },
    memory: { search: async () => ({ items }) },
  };
  handlers.session_start!.forEach((handler) => handler({}, ctx));
  const result = await handlers.tool_call![0]!({ type: "tool_call", toolName: "edit", toolCallId: "t", input: { path: "x.ts" } }, ctx) as { additionalContext?: string } | undefined;
  return result?.additionalContext;
}

describe("edit-lessons 복원 범위", () => {
  test("다른 텍스트 조각이 '- '로 시작해도 앞 블록의 기억으로 세지 않는다", async () => {
    const out = await editAfterRestore([
      { type: "text", text: "[edit-lessons] x.ts\n- earlier (memory://x, 2026-10-05)" },
      { type: "text", text: "- See also (memory://y)" },
    ], ["x", "y"]);
    expect(out).not.toContain("memory://x");
    expect(out).toContain("memory://y");
  });

  test("본문에서 [edit-lessons]를 언급만 한 줄은 머리줄이 아니다", async () => {
    const out = await editAfterRestore("[other] References used by [edit-lessons]\r\n- See also (memory://beef)", ["beef"]);
    expect(out).toContain("memory://beef");
  });

  test("요약 속 괄호의 memory 링크가 아니라 줄 끝 메타의 id를 읽는다", async () => {
    const out = await editAfterRestore("[edit-lessons] x.ts\n- x.ts compare (memory://beef, previous result… (memory://cafe, 2026-10-05)", ["beef", "cafe"]);
    expect(out).toContain("memory://beef");
    expect(out).not.toContain("memory://cafe");
  });
});
