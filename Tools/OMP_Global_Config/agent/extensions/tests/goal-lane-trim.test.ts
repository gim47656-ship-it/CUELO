import { expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import goalLane from "../../cuelo-plugins/goal-lane/index";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type Tool = { description: string; execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: { text: string }[] }> };

function lane() {
  const handlers = new Map<string, Handler>();
  const entries: Record<string, unknown>[] = [];
  const sent: unknown[] = [];
  const ctx = { cwd: process.cwd(), agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { setWidget() {} } };
  let tool!: Tool;
  goalLane({
    zod,
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerTool(value: Tool) { tool = value; },
    sendMessage(message: unknown) { sent.push(message); },
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
  } as never, { resolveJudge: async () => { throw new Error("No provider in this focused test"); } });
  const emit = async (name: string, event: Record<string, unknown> = {}) => handlers.get(name)?.(event, ctx);
  const call = async (params: object) => (await tool.execute("goal-test", params, undefined, undefined, ctx)).content[0]!.text;
  return { handlers, emit, call, entries, sent, tool: () => tool };
}

const deliverables = [{ id: "a", what: "Output A", check: "check a" }, { id: "b", what: "Output B", check: "check b" }];

test("goal-lane is an optional tool: no event hook injects guidance, reminders or messages", async () => {
  const { handlers, emit, call, sent, tool } = lane();
  // Only bookkeeping hooks remain; nothing listens to turn start, agent end or compaction.
  expect([...handlers.keys()].sort()).toEqual(["input", "message_start", "session_shutdown", "session_start", "session_switch", "tool_result"]);
  expect(tool().description).toContain("Optional");
  expect(tool().description).toContain("not required before dispatch");
  await emit("session_start");
  await emit("input", { source: "rpc", text: "Deploy the exporter and delete the old bucket." });
  await call({ op: "frame", goal: "Exporter deployed", deliverables });
  for (const [toolName, args] of [
    ["task", {}], ["wait", {}], ["generate_image", {}], ["lab_goal", { op: "frame" }], ["read", {}],
    ["cross_review", { action: "review", highRisk: true }],
  ] as const) {
    expect(await emit("tool_result", { toolName, input: args, content: [], isError: false })).toBeUndefined();
  }
  await emit("message_start", { message: { role: "user", content: "Deploy to staging instead." } });
  expect(sent).toEqual([]);
});

test("the frame and its evidence are restored from the session branch after a reload", async () => {
  const { emit, call, entries } = lane();
  await emit("session_start");
  await emit("input", { source: "rpc", text: "Check outputs." });
  await call({ op: "frame", goal: "Checked outputs", deliverables });
  await emit("tool_result", { toolName: "bash", input: { command: "check a" }, details: { exitCode: 0 }, content: [], isError: false });
  await call({ op: "evidence", id: "a", kind: "command", value: "check a" });
  expect(entries).toHaveLength(2);
  await emit("session_start");
  const status = await call({ op: "status" });
  expect(status).toContain("목표: Checked outputs");
  expect(status).toContain("[근거 관측됨] a");
  expect(status).toContain("[근거 없음] b");
  await emit("session_switch");
  expect(await call({ op: "status" })).toContain("[근거 관측됨] a");
});

test("CUELO restart and update notices are not the user's words for explicit conditions", async () => {
  const { emit, call } = lane();
  await emit("session_start");
  await emit("input", { source: "rpc", text: "Deploy the exporter." });
  await emit("input", { source: "rpc", text: "[자동 재개] CUELO 업데이트 때문에 진행 중 작업이 중단됐다. 서버가 새 버전으로 다시 떴다." });
  await emit("message_start", { message: { role: "user", content: "[하네스 통지] 이 세션이 시작한 CUELO 업데이트가 끝나 런타임이 새 버전으로 교체됐습니다." } });
  const text = await call({
    op: "frame", goal: "Exporter deployed",
    explicit: ["Deploy the exporter", "서버가 새 버전으로 다시 떴다"],
    deliverables: [{ id: "a", what: "Output", check: "check" }],
  });
  expect(text).toContain("사용자 명시: Deploy the exporter");
  expect(text).toContain("사용자 원문에 없는 조건을 assumptions로 옮겼다: 서버가 새 버전으로 다시 떴다");
});
