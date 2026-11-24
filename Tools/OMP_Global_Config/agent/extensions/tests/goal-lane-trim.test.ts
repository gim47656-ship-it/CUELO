import { expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema/wire";
import goalLane from "../../cuelo-plugins/goal-lane/index";

type CustomMessage = { customType: string; content: string };
type Result = { systemPrompt?: string[]; message?: CustomMessage; additionalContext?: string } | undefined;
type Handler = (event: Record<string, unknown>, ctx: unknown) => Result | void | Promise<Result | void>;
type Tool = Parameters<typeof toolWireSchema>[0] & { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<unknown> };

function lane() {
  const handlers = new Map<string, Handler>();
  const entries: Record<string, unknown>[] = [];
  const ctx = { cwd: process.cwd(), agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { setWidget() {} } };
  let tool!: Tool;
  goalLane({
    zod,
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerTool(value: Tool) { tool = value; },
    sendMessage() {},
    appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data: structuredClone(data) }); },
  } as never, { resolveJudge: async () => { throw new Error("No provider in this focused test"); } });
  const emit = async (name: string, event: Record<string, unknown> = {}) => (await handlers.get(name)?.(event, ctx)) ?? undefined;
  const input = (text: string) => emit("input", { source: "rpc", text });
  const result = async (toolName: string, args: object = {}, isError = false) =>
    (await emit("tool_result", { toolName, input: args, content: [], isError }))?.additionalContext;
  const call = (params: object) => tool.execute("goal-test", params, undefined, undefined, ctx);
  const frame = (goal: string, count = 2) => call({
    op: "frame", goal,
    deliverables: [{ id: "a", what: "Output A", check: "check a" }, { id: "b", what: "Output B", check: "check b" }].slice(0, count),
  });
  const base = ["base"];
  const start = async (prompt: string) => {
    const output = await emit("before_agent_start", { reason: "prompt", prompt, systemPrompt: base });
    const system = output?.systemPrompt ?? base;
    const tools = JSON.stringify([{ name: tool.name, description: tool.description, parameters: toolWireSchema(tool) }]);
    return { system, tools, head: Buffer.from(system.join("\n") + "\n" + tools), message: output?.message };
  };
  return { emit, input, result, call, frame, start, entries };
}

test("identical reminders are suppressed per request and goal/evidence state, not across different text", async () => {
  const { emit, input, result, call, frame } = lane();
  await emit("session_start");
  await input("Check outputs.");
  await frame("First goal");
  await result("lab_goal", { op: "frame" });
  const first = await result("task");
  expect(first).toContain("a[근거 없음], b[근거 없음]");
  expect(first).toContain("이 안내는 승인이 아니며 권한을 더하지 않는다.");
  const image = await result("generate_image");
  expect(image).toContain("이미지가 생성됐다");
  expect(await result("wait")).toBeUndefined();
  expect(await result("generate_image")).toBeUndefined();

  // A reframe may change the goal but not the printed list of pending IDs.
  await frame("Changed goal");
  expect(await result("task")).toBe(first);
  const record = (value: string) => call({ op: "evidence", id: "a", kind: "command", value });
  await record("check a attempt 1");
  const self = await result("wait");
  expect(self).toContain("a[자기 보고만]");
  await record("check a attempt 2");
  expect(await result("task")).toBe(self);
  expect(await result("wait")).toBeUndefined();

  await frame("Changed pending targets", 1);
  const pending = await result("task");
  expect(pending).toContain("a[자기 보고만].");
  expect(pending).not.toContain("b[");
  await emit("input", { source: "rpc", text: "[자동 재개] 이어서 진행합니다." });
  await emit("message_start", { message: { role: "user", attribution: "agent", content: "Internal update" } });
  expect(await result("task")).toBeUndefined();

  await input("Check outputs."); // Even identical human requests are separate requests.
  expect(await result("wait")).toBe(pending);
  await emit("message_start", { message: { role: "user", content: "Check outputs." } });
  expect(await result("task")).toBeUndefined();
  await emit("message_start", { message: { role: "user", content: "Check outputs." } }); // Steering, not another input event.
  expect(await result("task")).toBe(pending);
});

test("an active frame adds guidance as a message, never changing head bytes mid-session", async () => {
  const { emit, input, frame, start, result } = lane();
  await emit("session_start");
  await input("Check the heading.");
  const unframed = await start("Check the heading.");
  await frame("Write a checked report");
  const framed = await start("What remains?");
  console.log(`goal-lane unit head bytes (JSON tool schema): unframed=${unframed.head.length} framed=${framed.head.length}; system=${Buffer.byteLength(unframed.system.join("\n"))}/${Buffer.byteLength(framed.system.join("\n"))}; tools=${Buffer.byteLength(unframed.tools)}`);
  expect(unframed.head.equals(framed.head)).toBe(true);
  expect(unframed.message).toBeUndefined();
  expect(unframed.system).toEqual(["base"]);
  expect(framed.message?.content).toContain("# Goal lane (Main only)");
  expect(await result("lab_goal", { op: "frame" })).toBeUndefined();
  expect((await start("Next check")).message).toBeUndefined();
  await emit("session_compact");
  const compacted = await start("Continue after compaction");
  expect(compacted.head.equals(framed.head)).toBe(true);
  expect(compacted.message?.content).toContain("# Goal lane (Main only)");
  expect(compacted.message?.content).toContain("Write a checked report");
});

test("observed frame, dispatch and risk signals deliver guidance on the current tool path", async () => {
  for (const [name, args] of [["lab_goal", { op: "frame" }], ["maker_route", {}], ["cross_review", { action: "review", highRisk: true }]] as const) {
    const { emit, input, frame, result } = lane();
    await emit("session_start");
    await input("Check the heading.");
    expect(await result("read")).toBeUndefined();
    expect(await result("cross_review", { action: "review", highRisk: false })).toBeUndefined();
    expect(await result(name, args, true)).toBeUndefined();
    if (name === "lab_goal") await frame("Write a checked report");
    expect(await result(name, args)).toContain("# Goal lane (Main only)");
    expect(await result(name, args)).toBeUndefined();
  }
});

test("branch restore credits previously delivered tool notices to the same human request", async () => {
  const { emit, input, frame, entries, start, result } = lane();
  await emit("session_start");
  await input("Check the report.");
  entries.push({ type: "message", message: { role: "user", content: "Check the report." } });
  await frame("Checked report");
  const guidance = await result("lab_goal", { op: "frame" });
  const pending = await result("task");
  expect(guidance).toContain("# Goal lane (Main only)");
  expect(pending).toContain("근거가 관측되지 않은 산출물");
  entries.push({
    type: "message", message: { role: "developer", attribution: "agent", content: [
      { type: "text", text: `Other extension's note.\n\n${guidance}\n\n${pending}` },
    ] },
  });
  await emit("session_start");
  await input("[자동 재개] 이어서 진행합니다.");
  expect((await start("Resume")).message).toBeUndefined();
  expect(await result("wait")).toBeUndefined();
  await input("Check the report.");
  expect(await result("wait")).toBe(pending);
});