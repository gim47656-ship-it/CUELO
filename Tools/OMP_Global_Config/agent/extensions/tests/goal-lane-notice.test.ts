import { expect, test } from "bun:test";
import { z } from "zod";
import goalLane, { judgeUnstated } from "../../cuelo-plugins/goal-lane/index";

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

// 11-14 home measurement E4/E5: a no-edit condition from an earlier message fell outside the last 4000 characters
// sent to the judge, which then answered not-stated for a condition it never saw.
test("an explicit condition outside the recent tail is still sent to the judge with that tail", async () => {
 const calls: { state: Record<string, unknown> }[] = [];
 const condition = "이번 세션에서는 RULES.md, AGENTS.md, harness-policy.json 파일을 고치지 않는다";
 const later = Array.from({ length: 200 }, (_, i) => `진행 상황 확인 ${i}번째 메시지입니다. 계속 해 주세요.`).join("\n");
 const userWords = `\n안녕\n${condition}. 조사만 해 줘.\n${later}`;
 expect(userWords.length).toBeGreaterThan(4_000);
 const judge = async () => ({ judge: async (call: { state: Record<string, unknown> }) => {
  calls.push(call);
  return { answers: { asked: { type: "choice", choice: "stated", probabilities: { stated: 0.9 } } } };
 } }) as never;
 await judgeUnstated([condition], userWords, {} as never, judge, 1_000);
 const sent = String(calls[0]?.state.userMessages);
 expect(sent).toContain("harness-policy.json 파일을 고치지 않는다");
 expect(sent).toContain("199번째 메시지");
 expect(sent.length).toBeLessThanOrEqual(4_000);
 // A line crossing the 4000-character cut is sent whole, so its negation stays with the condition.
 calls.length = 0;
 await judgeUnstated(["astronomy"], `astronomy was rejected\n${"x".repeat(3987)}`, {} as never, judge, 1_000);
 expect(String(calls[0]?.state.userMessages)).toContain("astronomy was rejected");
 // A condition already inside the last 4000 characters is sent as before, even within a long line.
 calls.length = 0;
 await judgeUnstated(["astronomy"], `${"x".repeat(2100)} astronomy was rejected\n${"y".repeat(2000)}`, {} as never, judge, 1_000);
 expect(String(calls[0]?.state.userMessages)).toContain("astronomy was rejected");
 // A long earlier line keeps the part around the condition, not just its start.
 calls.length = 0;
 await judgeUnstated(["astronomy"], `${"x".repeat(3000)} astronomy was rejected\n${"y".repeat(4000)}`, {} as never, judge, 1_000);
 expect(String(calls[0]?.state.userMessages)).toContain("astronomy was rejected");
 // An earlier line that fits the head is sent whole, qualification first.
 calls.length = 0;
 await judgeUnstated(["astronomy"], `Rejected request (padding: ${"x".repeat(1500)}): astronomy\n${"y".repeat(4000)}`, {} as never, judge, 1_000);
 expect(String(calls[0]?.state.userMessages)).toContain("Rejected request");
});

// 11-14 home measurement C1/C3/C7/C12/C18/C19: endings that wait on the user's decision or input missed the confirmation
// regex, so the closing judge never ran and the turn-end goal reminder was posted over a legitimate wait.
test("an ending that waits on the user's decision or input draws no turn-end reminder", async () => {
 const endings = [
  "VM LINE 설치는 사용자님의 약관 동의를 기다리고 있어요. 「약관 동의해」라고 해 주시면 체크하고 설치를 마칠게요.",
  "이제 두 가지만 정해 주시면 돼요. 제 추천은 비용이 들지 않는 쪽부터예요.",
  "작업 정리가 끝나면 \"지금 종료해줘\"라고 알려줘. 실제 깨우기는 아직 미검증이야.",
  "등록된 키를 지울지도 네 결정이야. 지우면 다른 수단이 필요해.",
  "아직 아무것도 제출하지 않았어요. 정보를 주시면 거기서 바로 이어갈게요.",
 ];
 for (const ending of endings) {
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
  await emit("session_start", {});
  await emit("input", { source: "rpc", text: "Install it." });
  await tool!.execute("goal-test", { op: "frame", goal: "Installed app", size: "normal", deliverables: [{ id: "app", what: "App installed", check: "app --version" }] }, undefined, undefined, ctx);
  await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text: `설치 창을 열었어요.\n\n${ending}` }] }] });
  expect({ ending, notices: notices.filter((notice) => notice.customType === "goal-lane").length }).toEqual({ ending, notices: 0 });
 }
});
