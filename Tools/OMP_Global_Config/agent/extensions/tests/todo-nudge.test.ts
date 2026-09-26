import { describe, expect, test } from "bun:test";
import todoNudge from "../todo-nudge";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function harness(branch: unknown[] = []) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const ctx = { sessionManager: { getBranch: () => branch } };
  todoNudge({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown) => { sent.push(message); },
  } as unknown as Parameters<typeof todoNudge>[0]);
  const emit = (name: string, event: Record<string, unknown>) => {
    for (const handler of handlers[name] ?? []) handler(event, ctx);
  };
  const calls = (names: string[]) => { for (const toolName of names) emit("tool_call", { toolName }); };
  emit("session_start", {});
  return { emit, calls, sent };
}

describe("todo nudge", () => {
  test("사용자 요청에서 todo 없이 도구를 세 번 부르면 요청마다 한 번만 안내한다", () => {
    const h = harness();
    h.emit("input", { source: "interactive" });
    h.calls(["read", "bash"]);
    expect(h.sent).toHaveLength(0);
    h.calls(["read", "edit", "bash", "read"]);
    expect(h.sent).toHaveLength(1);
    h.emit("input", { source: "rpc" });
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(2);
  });

  test("그 요청에서 todo 를 먼저 쓰면 안내하지 않는다", () => {
    const h = harness();
    h.emit("input", { source: "interactive" });
    h.calls(["read", "todo", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
  });

  test("사용자 직접 입력이 없는 세션(child)과 확장 입력에는 개입하지 않는다", () => {
    const h = harness();
    h.calls(["read", "bash", "read", "edit", "bash"]);
    h.emit("input", { source: "extension" });
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
  });

  test("진행 중인 todo 가 남아 있으면 새 요청에서도 새 목록을 강요하지 않는다", () => {
    const h = harness();
    h.emit("input", { source: "interactive" });
    h.emit("tool_result", {
      toolName: "todo", isError: false,
      details: { phases: [{ tasks: [{ content: "work", status: "in_progress" }] }] },
    });
    h.emit("input", { source: "interactive" });
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
    h.emit("tool_result", {
      toolName: "todo", isError: false,
      details: { phases: [{ tasks: [{ content: "work", status: "completed" }] }] },
    });
    h.emit("input", { source: "interactive" });
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(1);
  });
});
