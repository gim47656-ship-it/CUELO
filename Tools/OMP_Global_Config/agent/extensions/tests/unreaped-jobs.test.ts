import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createTurnEndGuard } from "../turn-end-guard";
import unreapedJobs from "../../cuelo-plugins/unreaped-jobs";

function harness(enabled = true) {
  const handlers: Record<string, ((event: Record<string, unknown>, ctx: unknown) => unknown)[]> = {};
  const sent: { content: string }[] = [];
  const deliveries: unknown[] = [];
  const ctx = { cwd: process.cwd(), isIdle: () => true, sessionManager: { getBranch: () => [], getSessionId: () => "main-session" } };
  const pi = {
    events: new EventEmitter(),
    on: (name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) => { (handlers[name] ??= []).push(handler); },
    sendMessage: (message: { content: string }, options: unknown) => { sent.push(message); deliveries.push(options); },
  };
  createTurnEndGuard(undefined, undefined, async () => ({ answered: [], solo: "unknown" }))(pi as never);
  if (enabled) unreapedJobs(pi as never);
  const emit = async (name: string, event: Record<string, unknown>) => {
    for (const handler of handlers[name] ?? []) await handler(event, ctx);
  };
  const todo = (statuses: string[]) => emit("tool_result", { toolName: "todo", isError: false,
    details: { phases: [{ tasks: statuses.map((status, index) => ({ content: `work-${index}`, status })) }] } });
  const end = (text: string, extra: Record<string, unknown> = {}) => emit("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text }] }], ...extra,
  });
  return { emit, todo, end, sent, deliveries, ctx };
}

test("disabled unreaped plugin leaves the TODO nudge but removes only the jobs fragment", async () => {
  for (const enabled of [true, false]) {
    const h = harness(enabled);
    Object.assign(h.ctx, { getAsyncJobSnapshot: () => ({ running: [{ id: "bg_toggle", type: "bash", status: "running", startTime: 1 }] }) });
    await h.todo(["pending"]);
    await h.end("원인은 확인했습니다.");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.content).toContain("pending");
    expect(h.sent[0]!.content.includes("bg_toggle")).toBe(enabled);
  }
});

test("continuing, aborted and shutdown turns never collect jobs", async () => {
  const h = harness();
  Object.assign(h.ctx, { getAsyncJobSnapshot: () => ({ running: [{ id: "bg_skip", type: "bash", status: "running", startTime: 1 }] }) });
  await h.end("진행 중", { willContinue: true });
  await h.end("중지", { messages: [{ role: "assistant", stopReason: "aborted", content: [] }] });
  await h.emit("session_shutdown", {});
  await h.end("종료");
  expect(h.sent).toEqual([]);
  await h.emit("session_switch", {});
  await h.end("진행 중");
  expect(h.sent[0]!.content).toContain("bg_skip");
});

// Real SDK load/bind proves shared session event-bus composition, independent of factory mocks.
test("SDK plugin loading and single-disable isolation for all four features", async () => {
  const ids = ["goal-budget-hint", "unreaped-jobs", "tool-recovery-hint", "todo-language"];
  for (const disabled of [undefined, ...ids]) {
    const paths = [new URL("../turn-end-guard.ts", import.meta.url).pathname,
      ...ids.filter(id => id !== disabled).map(id => new URL(`../../cuelo-plugins/${id}/index.ts`, import.meta.url).pathname)];
    const loaded = await loadExtensions(paths, process.cwd());
    expect(loaded.errors).toEqual([]);
    const sent: { customType?: string; content: string }[] = [];
    const session = { getCwd: () => process.cwd(), getBranch: () => [], getSessionId: () => "toggle-sdk", getSessionFile: () => undefined };
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, process.cwd(), session as never, {} as never,
      undefined, undefined, undefined, () => ({ running: [{ id: "bg_sdk", type: "bash", status: "running", startTime: 1 }], recent: [], delivery: [] }) as never);
    runner.onError(error => { throw new Error(error.error); });
    loaded.runtime.sendMessage = (message) => { sent.push(message as { customType?: string; content: string }); };
    await runner.emit({ type: "session_start" });
    await runner.emitInput("코드 확인", undefined, "rpc");
    await runner.emitToolCall({ type: "tool_call", toolName: "goal", toolCallId: "goal", input: { token_budget: 100 } });
    const todo = await runner.emitToolCall({ type: "tool_call", toolName: "todo", toolCallId: "todo", input: { op: "init", items: ["確認する"] } });
    const recovery = await runner.emitToolResult({ type: "tool_result", toolName: "eval", toolCallId: "eval", input: {}, isError: true, content: [{ type: "text", text: "ENOBUFS" }] });
    await runner.emitToolResult({ type: "tool_result", toolName: "todo", toolCallId: "progress", input: {}, isError: false,
      content: [], details: { phases: [{ tasks: [{ content: "확인", status: "pending" }] }] } });
    await runner.emit({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "완료했습니다." }] }] } as never);
    expect(sent.some(message => message.customType === "goal-budget-hint")).toBe(disabled !== "goal-budget-hint");
    expect(todo?.block === true).toBe(disabled !== "todo-language");
    expect(JSON.stringify(recovery ?? {}).includes("[다시 하는 법]")).toBe(disabled !== "tool-recovery-hint");
    expect(sent.some(message => message.content.includes("bg_sdk"))).toBe(disabled !== "unreaped-jobs");
    const turnMessages = sent.filter(message => message.customType === "turn-end-guard");
    expect(turnMessages).toHaveLength(1);
    expect(turnMessages[0]!.content).toContain("pending");
    if (disabled !== "unreaped-jobs") {
      expect(turnMessages[0]!.content.split("bg_sdk")).toHaveLength(2);
      expect(turnMessages[0]!.content.indexOf("pending")).toBeLessThan(turnMessages[0]!.content.indexOf("bg_sdk"));
    }
    console.log(`SDK toggle ${disabled ?? "all-enabled"}: isolated behavior observed`);
    await runner.emit({ type: "session_shutdown" });
  }
});
describe("turn-end unreaped jobs", () => {
  const job = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "bash", status: "running", startTime: 1, label: "watch", ...extra });
  const withJobs = (rows: unknown[], kind?: "sub") => {
    const h = harness();
    Object.assign(h.ctx, { getAsyncJobSnapshot: () => ({ running: rows, recent: [], delivery: [] }), agent: kind ? { kind } : undefined });
    return h;
  };
  const texts = (h: { sent: unknown[] }) => (h.sent as { content: string }[]).map((message) => message.content);

  test("a Main turn ending with its own bash or eval job running gets one aside naming it", async () => {
    const h = withJobs([job("bg_1"), job("bg_2", { type: "eval" })]);
    await h.emit("input", { source: "rpc", text: "빌드 돌려 줘" });
    await h.end("빌드를 돌리는 중입니다.");
    expect(texts(h)).toHaveLength(1);
    expect(texts(h)[0]).toContain("bg_1");
    expect(texts(h)[0]).toContain("bg_2");
    expect(h.deliveries[0]).toEqual({ deliverAs: "aside" });
  });

  test("the same run is not announced twice, while a new job or a restarted id is", async () => {
    const rows = [job("bg_1")];
    const h = withJobs(rows);
    await h.emit("input", { source: "rpc", text: "첫 요청" });
    await h.end("진행 중입니다.");
    await h.end("아직 진행 중입니다.");
    await h.emit("input", { source: "rpc", text: "다음 요청" });
    await h.end("여전히 진행 중입니다.");
    expect(texts(h)).toHaveLength(1);
    rows.push(job("bg_9"));
    rows[0] = job("bg_1", { startTime: 2 });
    await h.emit("input", { source: "rpc", text: "또 다음" });
    await h.end("진행 중입니다.");
    expect(texts(h)).toHaveLength(2);
    expect(texts(h)[1]).toContain("bg_9");
    expect(texts(h)[1]).toContain("bg_1");
  });

  test("task-backed jobs, settled jobs and child sessions stay silent", async () => {
    const h = withJobs([job("task_1", { type: "task" }), job("bg_3", { agentId: "0-Maker" }), job("bg_4", { status: "completed" })]);
    await h.emit("input", { source: "rpc", text: "맡겨 줘" });
    await h.end("맡겼습니다.");
    expect(texts(h)).toHaveLength(0);
    const child = withJobs([job("bg_5")], "sub");
    await child.end("끝났습니다.");
    expect(texts(child)).toHaveLength(0);
  });

  test("a named bash service is announced until proc:// shows it gone or test_session takes it over", async () => {
    const service = (name: string) => ({ toolName: "bash", isError: false, input: { command: "next start" }, details: { service: { name, state: "ready" } } });
    const h = withJobs([]);
    await h.emit("input", { source: "rpc", text: "서버 띄워 줘" });
    await h.emit("tool_result", service("dev-a"));
    await h.emit("tool_result", service("dev-b"));
    await h.emit("tool_result", service("dev-c"));
    await h.emit("tool_result", { toolName: "read", isError: false, input: { path: "proc://" }, details: { proc: { daemons: [{ name: "dev-a", state: "running" }, { name: "dev-c", state: "running" }] } } });
    await h.emit("tool_result", { toolName: "test_session", isError: false, input: { action: "track", service: "dev-c" }, details: {} });
    await h.emit("tool_result", service("dev-c"));
    await h.end("서버를 띄웠습니다.");
    expect(texts(h)).toHaveLength(1);
    expect(texts(h)[0]).toContain("dev-a");
    expect(texts(h)[0]).not.toContain("dev-b");
    expect(texts(h)[0]).not.toContain("dev-c");
  });

  test("the job notice joins the TODO nudge in the same single aside", async () => {
    const plain = withJobs([]);
    await plain.emit("input", { source: "rpc", text: "고쳐 줘" });
    await plain.todo(["in_progress"]);
    await plain.end("원인은 확인했습니다.");
    const h = withJobs([job("bg_7")]);
    await h.emit("input", { source: "rpc", text: "고쳐 줘" });
    await h.todo(["in_progress"]);
    await h.end("원인은 확인했습니다.");
    expect(texts(h)).toHaveLength(1);
    expect(texts(h)[0].startsWith(texts(plain)[0])).toBe(true);
    expect(texts(h)[0]).toContain("bg_7");
    expect(texts(h)[0]!.split("bg_7")).toHaveLength(2);
    expect(h.deliveries).toEqual([{ deliverAs: "aside" }]);
  });
});
