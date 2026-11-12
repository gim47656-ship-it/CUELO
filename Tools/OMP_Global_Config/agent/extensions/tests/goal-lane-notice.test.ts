import { expect, test } from "bun:test";
import { z } from "zod";
import goalLane from "../../cuelo-plugins/goal-lane/index";

type ContextNotice = { additionalContext: string } | undefined;
type Handler = (event: Record<string, unknown>, ctx: unknown) => ContextNotice | void | Promise<ContextNotice | void>;
type GoalTool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: { text: string }[] }> };

test("pending reminder retains IDs, status exposes full checks, and verified evidence clears the reminder", async () => {
 const handlers = new Map<string, Handler[]>();
 let tool: GoalTool;
 const notices: { customType: string; content: string }[] = [];
 const entries: { type: string; customType: string; data: unknown }[] = [];
 const ctx = { cwd: process.cwd(), agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { setWidget() {} } };
 goalLane({
  zod: z,
  on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerTool(value: GoalTool) { tool = value; },
  sendMessage(value: { customType: string; content: string }) { notices.push(value); },
  appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
 } as never, { resolveJudge: async () => { throw new Error("No provider in this focused test"); } });
 const emit = async (name: string, event: Record<string, unknown>) => Promise.all((handlers.get(name) ?? []).map(handler => handler(event, ctx)));
 const call = (params: unknown) => tool.execute("goal-test", params, undefined, undefined, ctx);
 await emit("session_start", {});
 await emit("input", { source: "rpc", text: "Verify the report." });
 const check = "bun test test/report-consumer.test.ts --case detailed-observable-result";
 await call({ op: "frame", goal: "A checked report", size: "normal", deliverables: [{ id: "report", what: "A detailed report", check }] });
 const result = await emit("tool_result", { toolName: "task", input: {}, content: [], isError: false });
 expect(result[0]?.additionalContext).toContain("report[");
 expect(result[0]?.additionalContext).not.toContain(check);
 const status = await call({ op: "status" });
 expect(status.content[0].text).toContain(check);
 expect(status.content[0].text).toContain("A detailed report");
 await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: "The result is ready." }] }] });
 expect(notices[0].customType).toBe("goal-lane");
 expect(notices[0].content).toContain("report[");
 await emit("tool_result", { toolName: "bash", input: { command: check }, details: { exitCode: 0 }, content: [], isError: false });
 await call({ op: "evidence", id: "report", kind: "command", value: check });
 const checked = await emit("tool_result", { toolName: "task", input: {}, content: [], isError: false });
 expect(checked).toEqual([undefined]);
 expect((await call({ op: "status" })).content[0].text).toContain("[확인됨] report");
});

test("frames never change the system prompt; the frame is re-shown as a message only when the conversation lost it", async () => {
 type StartResult = { systemPrompt: string[]; message?: { customType: string; content: string; details: { at: string } } } | undefined;
 const handlers = new Map<string, Handler[]>();
 let tool: GoalTool;
 const entries: Record<string, unknown>[] = [];
 const ctx = { cwd: process.cwd(), agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { setWidget() {} } };
 goalLane({
  zod: z,
  on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerTool(value: GoalTool) { tool = value; },
  sendMessage() {},
  appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
 } as never, { resolveJudge: async () => { throw new Error("No provider in this focused test"); } });
 const emit = async (name: string, event: Record<string, unknown>) => Promise.all((handlers.get(name) ?? []).map(handler => handler(event, ctx)));
 const start = async () => (await emit("before_agent_start", { reason: "prompt", prompt: "next", systemPrompt: ["base"] }))[0] as StartResult;
 const frame = (goal: string) => tool.execute("goal-test", { op: "frame", goal, size: "normal", deliverables: [{ id: "d", what: "w", check: "c" }] }, undefined, undefined, ctx);
 await emit("session_start", {});
 const before = await start();
 await frame("First goal");
 const afterFirst = await start();
 await frame("Second goal");
 const afterSecond = await start();
 expect(afterFirst?.systemPrompt).toEqual(before?.systemPrompt);
 expect(afterSecond?.systemPrompt).toEqual(before?.systemPrompt);
 // The `frame` tool result already shows it.
 expect(afterFirst?.message).toBeUndefined();
 expect(afterSecond?.message).toBeUndefined();

 await emit("session_compact", {});
 const afterCompact = await start();
 expect(afterCompact?.systemPrompt).toEqual(before?.systemPrompt);
 expect(afterCompact?.message?.content).toContain("Second goal");
 expect((await start())?.message).toBeUndefined();

 // A restart restores from the branch: a compaction after the frame means the conversation no longer shows it.
 const at = afterCompact!.message!.details.at;
 entries.push({ type: "compaction" });
 await emit("session_start", {});
 expect((await start())?.message?.content).toContain("Second goal");
 entries.push({ type: "custom_message", customType: afterCompact!.message!.customType, details: { at } });
 await emit("session_start", {});
 expect((await start())?.message).toBeUndefined();
});
