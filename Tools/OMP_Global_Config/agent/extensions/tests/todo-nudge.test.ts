import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import todoNudge from "../todo-nudge";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function harness(branch: unknown[] = []) {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const deliveries: unknown[] = [];
  const ctx = { cwd: "test", sessionManager: { getBranch: () => branch, getSessionId: () => "session" } };
  todoNudge({
    on: (name: string, handler: Handler) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: unknown, options: unknown) => { sent.push(message); deliveries.push(options); },
  } as unknown as ExtensionAPI);
  const emit = (name: string, event: Record<string, unknown>) => {
    for (const handler of handlers[name] ?? []) handler(event, ctx);
  };
  const input = (text = "첫째를 조사하고, 둘째를 수정하고, 셋째를 검증해줘", source = "interactive") =>
    emit("input", { source, text });
  const calls = (names: string[]) => { for (const toolName of names) emit("tool_call", { toolName }); };
  emit("session_start", {});
  return { emit, input, calls, sent, deliveries };
}

describe("todo nudge", () => {
  test("사용자 직접 입력마다 세 번째 비-todo 도구에서 한 번만 aside 안내한다", () => {
    const h = harness();
    h.input("단일 파일을 읽어줘");
    h.calls(["read", "bash"]);
    expect(h.sent).toHaveLength(0);
    h.calls(["read", "edit", "bash"]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ customType: "todo-nudge", display: false, attribution: "agent" });
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
    h.input("새 작업을 조사하고 수정하고 검증해줘", "rpc");
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(2);
  });

  test("그 요청에서 todo 를 먼저 쓰면 안내하지 않는다", () => {
    const h = harness();
    h.input();
    h.calls(["read", "todo", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
  });

  test("사용자 직접 입력이 없는 세션(child)과 확장 입력에는 안내가 없다", () => {
    const h = harness();
    h.calls(["read", "bash", "read", "edit", "bash"]);
    h.input("세 단계 작업", "extension");
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
  });

  test("진행 중인 todo 가 남아 있으면 새 요청에서도 새 목록을 강요하지 않는다", () => {
    const h = harness();
    h.input();
    h.emit("tool_result", {
      toolName: "todo", isError: false,
      details: { phases: [{ tasks: [{ content: "work", status: "in_progress" }] }] },
    });
    h.input();
    h.calls(["read", "bash", "read", "edit", "bash"]);
    expect(h.sent).toHaveLength(0);
    h.emit("tool_result", {
      toolName: "todo", isError: false,
      details: { phases: [{ tasks: [{ content: "work", status: "completed" }] }] },
    });
    h.input();
    h.calls(["read", "bash", "read"]);
    expect(h.sent).toHaveLength(1);
  });
});
