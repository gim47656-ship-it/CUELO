import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import todoNudge from "../todo-nudge";

type Handler = (event: Record<string, unknown>, ctx: unknown) => void;

function harness(branch: unknown[] = [], kind: "main" | "sub" = "main") {
  const handlers: Record<string, Handler[]> = {};
  const sent: unknown[] = [];
  const deliveries: unknown[] = [];
  const ctx = { cwd: "test", agent: { kind }, sessionManager: { getBranch: () => branch, getSessionId: () => "session" } };
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
  const todoState = (...statuses: string[]) => emit("tool_result", {
    toolName: "todo", isError: false,
    details: { phases: [{ tasks: statuses.map((status, i) => ({ content: `work${i}`, status })) }] },
  });
  const notice = (customType = "async-result") => emit("message_start", { message: { role: "custom", customType } });
  emit("session_start", {});
  return { emit, input, calls, todoState, notice, sent, deliveries };
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

describe("todo nudge on job-completion notices", () => {
  test("활성 todo 가 있을 때 작업 종료·DM 알림에서 한 번 aside 안내하고 todo 호출 뒤 다시 안내한다", () => {
    const h = harness();
    h.todoState("blocked", "completed");
    h.notice("async-result");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ customType: "todo-nudge", display: false, attribution: "agent" });
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
    h.notice("irc:incoming");
    expect(h.sent).toHaveLength(1);
    h.calls(["bash", "todo"]);
    h.notice("irc:incoming");
    expect(h.sent).toHaveLength(2);
  });

  test("활성 todo 가 없거나 알림이 아니거나 서브 에이전트면 안내하지 않는다", () => {
    const none = harness();
    none.notice();
    none.todoState("completed", "abandoned");
    none.notice();
    none.todoState("in_progress");
    none.notice("steering-reply-gate");
    expect(none.sent).toHaveLength(0);
    const child = harness([], "sub");
    child.todoState("in_progress");
    child.notice();
    expect(child.sent).toHaveLength(0);
  });

  test("재개한 세션의 저장된 todo 도 활성으로 본다", () => {
    const entry = (tasks: Array<{ content: string; status: string }>) => ({
      type: "message",
      message: { role: "toolResult", toolName: "todo", isError: false, details: { phases: [{ tasks }] } },
    });
    const h = harness([entry([{ content: "resume", status: "pending" }])]);
    h.notice();
    expect(h.sent).toHaveLength(1);
  });
});
