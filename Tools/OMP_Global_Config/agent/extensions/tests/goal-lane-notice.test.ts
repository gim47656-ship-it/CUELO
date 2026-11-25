import { expect, test } from "bun:test";
import { z } from "zod";
import goalLane, { judgeUnstated } from "../../cuelo-plugins/goal-lane/index";

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;
type GoalTool = { execute(id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown): Promise<{ content: { text: string }[] }> };

test("status exposes full checks and verified evidence is observed, with no reminder at any step", async () => {
 const { call, frame, ran, notices } = await lane("Verify the report.");
 const check = "bun test test/report-consumer.test.ts --case detailed-observable-result";
 await frame([{ id: "report", what: "A detailed report", check }]);
 const status = await call({ op: "status" });
 expect(status).toContain(check);
 expect(status).toContain("A detailed report");
 expect(status).toContain("[근거 없음] report");
 await ran(check, 0);
 await call({ op: "evidence", id: "report", kind: "command", value: check });
 expect(await call({ op: "status" })).toContain("[근거 관측됨] report");
 expect(notices).toEqual([]);
});

test("a size:small frame registers without deliverables and says no separate evidence call is needed", async () => {
 const { call, ran, notices } = await lane("Fix the typo in the heading.");
 const framed = await call({ op: "frame", goal: "Fix a heading typo", size: "small" });
 expect(framed).toContain("별도 evidence 호출은 필요 없다");
 await ran("bun test", 0);
 expect(notices).toEqual([]);
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

type Deliverable = { id: string; what: string; check: string; path?: string };

async function lane(text = "Check the output.", resolveJudge: NonNullable<Parameters<typeof goalLane>[1]>["resolveJudge"] = async () => { throw new Error("No provider in this focused test"); }) {
 const handlers = new Map<string, Handler[]>();
 let tool: GoalTool;
 const entries: { type: string; customType: string; data: unknown }[] = [];
 const notices: unknown[] = [];
 const ctx = { cwd: process.cwd(), agent: { kind: "main" }, sessionManager: { getBranch: () => entries }, ui: { setWidget() {} } };
 goalLane({
  zod: z,
  on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerTool(value: GoalTool) { tool = value; },
  sendMessage(message: unknown) { notices.push(message); },
  appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
 } as never, { resolveJudge });
 const emit = async (name: string, event: Record<string, unknown>) => Promise.all((handlers.get(name) ?? []).map(handler => handler(event, ctx)));
 const call = async (params: unknown) => (await tool.execute("goal-test", params, undefined, undefined, ctx)).content[0].text;
 await emit("session_start", {});
 await emit("input", { source: "rpc", text });
 const frame = (deliverables: Deliverable[]) => call({ op: "frame", goal: "Output", size: "normal", deliverables });
 const ran = (command: string, exitCode: number) => emit("tool_result", { toolName: "bash", input: { command }, details: { exitCode }, content: [], isError: exitCode !== 0 });
 return { call, emit, frame, ran, ctx, notices };
}

test("a successful but unrelated command is reported as observed evidence, never as a met requirement", async () => {
 const { call, frame, ran } = await lane();
 await frame([{ id: "out", what: "The report renders every section", check: "open the report and compare every section" }]);
 expect(await call({ op: "status" })).toContain("[근거 없음] out");
 await ran("true", 0);
 const text = await call({ op: "evidence", id: "out", kind: "command", value: "true" });
 expect(text).toContain("out: 근거 관측됨");
 expect(text).toContain("요구 충족 여부와 근거의 관련성은 Main이 직접 판단한다");
 expect(text).not.toMatch(/검증됐다|확인됨|확인 방법대로 검증/);
 expect((await call({ op: "status" }))).toContain("[근거 관측됨] out");
});

test("a cross_review reviewId this session resolved with pass is observed command evidence; an open or failed one is not", async () => {
 const { call, emit, frame } = await lane();
 await frame([{ id: "review", what: "Reviewed change", check: "cross_review passes" }]);
 const resolve = (reviewId: string, pass: boolean, isError = false) => emit("tool_result", {
  toolName: "cross_review", input: { action: "resolve", reviewId },
  content: [{ type: "text", text: JSON.stringify({ reviewId, pass, open: pass ? [] : ["R1-OAI-1"] }) }], isError,
 });
 await resolve("xr-20261122135346-aaaaaa", false);
 await resolve("xr-20261122135347-bbbbbb", true, true);
 for (const reviewId of ["xr-20261122135346-aaaaaa", "xr-20261122135347-bbbbbb", "xr-20261122135348-cccccc"]) {
  expect(await call({ op: "evidence", id: "review", kind: "command", value: reviewId })).toContain("review: 자기 보고만");
 }
 await resolve("xr-20261122135349-dddddd", true);
 const text = await call({ op: "evidence", id: "review", kind: "command", value: "xr-20261122135349-dddddd" });
 expect(text).toContain("review: 근거 관측됨");
 expect(text).toContain("통과(pass)로 닫았다");
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
