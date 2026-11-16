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
 expect((await call({ op: "status" })).content[0].text).toContain("[근거 관측됨] report");
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

type Deliverable = { id: string; what: string; check: string; path?: string };

async function lane() {
 const handlers = new Map<string, Handler[]>();
 let tool: GoalTool;
 const entries: { type: string; customType: string; data: unknown }[] = [];
 const ctx = { cwd: process.cwd(), agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { setWidget() {} } };
 goalLane({
  zod: z,
  on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerTool(value: GoalTool) { tool = value; },
  sendMessage() {},
  appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
 } as never, { resolveJudge: async () => { throw new Error("No provider in this focused test"); } });
 const emit = async (name: string, event: Record<string, unknown>) => Promise.all((handlers.get(name) ?? []).map(handler => handler(event, ctx)));
 const call = async (params: unknown) => (await tool.execute("goal-test", params, undefined, undefined, ctx)).content[0].text;
 await emit("session_start", {});
 await emit("input", { source: "rpc", text: "Check the output." });
 const frame = (deliverables: Deliverable[]) => call({ op: "frame", goal: "Output", size: "normal", deliverables });
 const ran = (command: string, exitCode: number) => emit("tool_result", { toolName: "bash", input: { command }, details: { exitCode }, content: [], isError: exitCode !== 0 });
 const reminder = async () => ((await emit("tool_result", { toolName: "task", input: {}, content: [], isError: false }))[0] as ContextNotice)?.additionalContext;
 return { call, frame, ran, reminder, ctx };
}

test("a successful but unrelated command is reported as observed evidence, never as a met requirement", async () => {
 const { call, frame, ran, reminder } = await lane();
 await frame([{ id: "out", what: "The report renders every section", check: "open the report and compare every section" }]);
 expect(await reminder()).toContain("out[근거 없음]");
 await ran("true", 0);
 const text = await call({ op: "evidence", id: "out", kind: "command", value: "true" });
 expect(text).toContain("out: 근거 관측됨");
 expect(text).toContain("요구 충족 여부와 근거의 관련성은 Main이 직접 판단한다");
 expect(text).not.toMatch(/검증됐다|확인됨|확인 방법대로 검증/);
 expect((await call({ op: "status" }))).toContain("[근거 관측됨] out");
 expect(await reminder()).toBeUndefined();
});

test("pending guidance says observed evidence is not acceptance and Main assesses relevance", async () => {
 const { frame, reminder } = await lane();
 await frame([{ id: "out", what: "w", check: "c" }]);
 const text = await reminder();
 expect(text).toContain("요구 충족 증명이 아니며");
 expect(text).toContain("Main이 직접 판단한다");
 expect(text).not.toContain("검증된 근거");
});

test("evidence carries over a re-frame only for an identical id, check, what and normalized path", async () => {
 const { call, frame, ran, ctx } = await lane();
 const base: Deliverable = { id: "out", what: "The report", check: "node check.js" };
 const cwd = (ctx as { cwd: string }).cwd;
 const state = async () => ((await call({ op: "status" })).match(/\[([^\]]+)\] out/) ?? [])[1];
 const seed = async (item: Deliverable) => {
  await frame([item]);
  await ran(item.check, 0);
  await call({ op: "evidence", id: "out", kind: "command", value: item.check });
  expect(await state()).toBe("근거 관측됨");
 };
 const cases: [string, Deliverable, Deliverable, string][] = [
  ["identical, both paths absent", base, { ...base }, "근거 관측됨"],
  ["trim-equal check and what", base, { ...base, what: "  The report ", check: " node check.js " }, "근거 관측됨"],
  ["what changed", base, { ...base, what: "A different report" }, "근거 없음"],
  ["check changed", base, { ...base, check: "node other.js" }, "근거 없음"],
  ["path absent to present", base, { ...base, path: "out.txt" }, "근거 없음"],
  ["path present to absent", { ...base, path: "out.txt" }, base, "근거 없음"],
  ["path changed", { ...base, path: "out.txt" }, { ...base, path: "other.txt" }, "근거 없음"],
  ["relative and absolute path agree", { ...base, path: "out/../out.txt" }, { ...base, path: `${cwd}/./out.txt` }, "근거 관측됨"],
 ];
 for (const [name, before, after, expected] of cases) {
  await seed(before);
  await frame([after]);
  expect({ name, state: await state() }).toEqual({ name, state: expected });
 }
});

test("a later failure revokes the same command's success while independent evidence stays", async () => {
 const { call, frame, ran } = await lane();
 await frame([{ id: "out", what: "w", check: "c" }]);
 await ran("first-check", 0);
 await call({ op: "evidence", id: "out", kind: "command", value: "first-check" });
 await ran("first-check", 1);
 await call({ op: "evidence", id: "out", kind: "command", value: "first-check" });
 expect(await call({ op: "status" })).toContain("[자기 보고만] out");
 await ran("second-check", 0);
 await call({ op: "evidence", id: "out", kind: "command", value: "second-check" });
 expect(await call({ op: "status" })).toContain("[근거 관측됨] out");
 await ran("second-check", 1);
 await call({ op: "evidence", id: "out", kind: "command", value: "second-check" });
 expect(await call({ op: "status" })).toContain("[자기 보고만] out");
});

test("panel parses and renders old and new observed labels with the same tally", async () => {
 const html = await Bun.file(new URL("../../cuelo-plugins/goal-lane/panel.html", import.meta.url)).text();
 const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
 type Node = { tag: string; className: string; text: string; dataset: Record<string, string>; children: Node[]; title?: string };
 const make = (tag: string): Node & Record<string, unknown> => {
  const node: Node & Record<string, unknown> = {
   tag, className: "", text: "", dataset: {}, children: [],
   set textContent(value: string) { node.text = value; },
   append(...items: (Node | string)[]) { for (const item of items) node.children.push(typeof item === "string" ? { ...make("#text"), text: item } : item); },
   replaceChildren(...items: Node[]) { node.children = items; },
   setAttribute() {}, cloneNode() { return node; }, childNodes: [],
  } as never;
  return node;
 };
 const root = make("main");
 let listener: (event: { data: unknown }) => void = () => {};
 const document = {
  documentElement: { dataset: {} },
  getElementById: () => root,
  createElement: make,
  createTextNode: (text: string) => ({ ...make("#text"), text }),
 };
 new Function("document", "window", "parent", script)(document, { addEventListener: (_: string, fn: typeof listener) => { listener = fn; } }, { postMessage() {} });
 const dump = (node: Node): string => `${node.text}${node.children.map(dump).join("|")}`;
 const render = (state: string) => {
  listener({ data: { type: "cuelo-lab:state", lines: ["목표: g", "크기: normal", `[${state}] a: What — 확인: check — command: ran`, "[파일 존재만] b: File — 확인: c2"] } });
  return dump(root);
 };
 const modern = render("근거 관측됨");
 const legacy = render("확인됨");
 for (const out of [modern, legacy]) {
  expect(out).toContain("1| / 2 근거 관측됨");
  expect(out).toContain("근거 관측됨");
 }
 expect(legacy).not.toContain("|확인됨");
 expect(legacy.replace(/확인됨/g, "")).toBe(modern.replace(/확인됨/g, ""));
});
