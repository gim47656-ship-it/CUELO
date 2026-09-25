// Model-free regression for scoped lifecycle shutdown, pending job receipts, and ask steering preemption.
// bun run patches/core-stall-test.ts (OMP_CORE_PATCH_TARGET is required)
import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { createSettingsTestScope } from "./core-test-settings";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live registry");
const core = resolve(target, "src");
// Dynamic imports deliberately select the isolated patched/unpatched module tree.
const { AgentRegistry } = await import(`${core}/registry/agent-registry.ts`);
const { AgentLifecycleManager } = await import(`${core}/registry/agent-lifecycle.ts`);
const { AsyncJobManager } = await import(`${core}/async/job-manager.ts`);
// 18.3.0은 `hub` 도구를 없애고 top-level 전용 `wait`(tools/wait.ts)로 대체했다.
const { WaitTool } = await import(`${core}/tools/wait.ts`);
const agentCore = resolve(target, "../pi-agent-core/src");
const piAi = resolve(target, "../pi-ai/src");
const piCatalog = resolve(target, "../pi-catalog/src");
// theme 는 18.2.5 에서 pi-coding-agent/src/modes/theme 에서 pi-tui/src/theme 로 옮겨졌다.
// 형제 패키지 해석은 전역 설치·isolated 사본 모두에서 같은 상대 위치로 성립한다.
const piTui = resolve(target, "../pi-tui/src");
const { Agent } = await import(`${agentCore}/agent.ts`);
const { createAssistantMessageEventStream } = await import(`${piAi}/utils/event-stream.ts`);
const { getBundledModel } = await import(`${piCatalog}/models.ts`);
const { AskTool } = await import(`${core}/tools/ask.ts`);
const { initThemeSync } = await import(`${piTui}/theme/theme.ts`);
initThemeSync();
let failures = 0;
async function test(name: string, run: () => Promise<void>) {
 try { await run(); console.log(`PASS ${name}`); }
 catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
async function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
 let timer: NodeJS.Timeout | undefined;
 try {
  return await Promise.race([
   promise,
   new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
   }),
  ]);
 } finally {
  clearTimeout(timer);
 }
}
await test("closing one root preserves another root and its revival", async () => {
 const registry = new AgentRegistry();
 const lifecycle = new AgentLifecycleManager(registry);
 const disposed: string[] = [];
 const session = (id: string) => ({ dispose: async () => { disposed.push(id); }, isStreaming: false });
 const a = registry.register({ id: "Main", kind: "main", session: session("Main") });
 registry.register({ id: "Main#2", kind: "main", session: session("Main#2") });
 registry.register({ id: "A", kind: "sub", parentId: "Main", session: session("A"), status: "idle" });
 registry.register({ id: "B", kind: "sub", parentId: "Main#2", session: session("B"), status: "idle" });
 lifecycle.adopt("A", { idleTtlMs: 0 });
 lifecycle.adopt("B", { idleTtlMs: 0, revive: async () => session("B-revived") });
 try {
  await lifecycle.dispose(undefined, a);
  assert.deepEqual(disposed, ["A"]);
  assert.equal(registry.get("A"), undefined);
  assert.ok(registry.get("B")?.session);
  await lifecycle.park("B");
  assert.ok(await lifecycle.ensureLive("B"));
 } finally { await lifecycle.dispose(); }
});
await test("late revival cannot reattach after its root closes", async () => {
 const registry = new AgentRegistry();
 const lifecycle = new AgentLifecycleManager(registry);
 const root = registry.register({ id: "Main", kind: "main", session: {} });
 const other = registry.register({ id: "Main#2", kind: "main", session: {} });
 const gate = Promise.withResolvers<{ dispose: () => Promise<void> }>();
 let disposed = 0;
 registry.register({ id: "A", kind: "sub", parentId: "Main", session: null, status: "parked" });
 lifecycle.adopt("A", { idleTtlMs: 0, revive: () => gate.promise });
 const pending = lifecycle.ensureLive("A").then(() => false, () => true);
 await lifecycle.dispose(undefined, root);
 gate.resolve({ dispose: async () => { disposed++; } });
 assert.equal(await pending, true);
 assert.equal(disposed, 1);
 assert.equal(registry.get("A"), undefined);
 assert.equal(registry.get("Main#2"), other);
 await lifecycle.dispose();
});
await test("bare wait recovers settled result despite another running job; no duplicate or cross-owner result", async () => {
 const manager = new AsyncJobManager({});
 const receipt = Promise.withResolvers<void>();
 const deliveryStarted = Promise.withResolvers<void>();
 manager.registerDeliverySink("owner-A", async () => { deliveryStarted.resolve(); await receipt.promise; });
 const settings = createSettingsTestScope(key => key === "async.enabled" ? true : undefined);
 const session = { settings, asyncJobManager: manager, getAgentId: () => "owner-A" };
 const waitTool = new WaitTool(session);
 const gate = Promise.withResolvers<string>();
 const running = manager.register("bash", "still running", () => gate.promise, { ownerId: "owner-A" });
 const done = manager.register("bash", "finished", async () => "STALL-RESULT-A", { ownerId: "owner-A" });
 const foreign = manager.register("bash", "foreign", async () => "PRIVATE-B", { ownerId: "owner-B" });
 await manager.getJob(done).promise;
 await manager.getJob(foreign).promise;
 await deliveryStarted.promise;
 try {
  // 18.3.0 `wait` 는 인자가 없다. 미전달 terminal 결과가 있으면 실행 중 job 을 기다리지 않고
  // 즉시 회수한다(tools/wait.ts:78-81).
  const result = await waitTool.execute("stall-wait", {});
  assert.ok(JSON.stringify(result).includes("STALL-RESULT-A"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE-B"));
  assert.equal(manager.isJobResultConsumed(done), true);
  assert.equal(manager.isJobResultConsumed(foreign), false);
  // 회수된 결과는 다시 나오지 않는다. 남은 실행 중 job 을 끝내 다음 사건으로 wait 를 깨운다.
  gate.resolve("done");
  const again = await within(waitTool.execute("stall-wait-again", {}), 5_000, "second wait");
  assert.ok(!JSON.stringify(again).includes("STALL-RESULT-A"));
 } finally {
  receipt.resolve();
  gate.resolve("done");
  await manager.getJob(running).promise;
  await manager.dispose({ timeoutMs: 100 });
 }
});
await test("cold revival and nested parked descendants stay released; replacement root is untouched", async () => {
 const registry = new AgentRegistry();
 const lifecycle = new AgentLifecycleManager(registry);
 const root = registry.register({ id: "Main", kind: "main", session: {} });
 registry.register({ id: "A", kind: "sub", parentId: "Main", session: null, status: "parked", sessionFile: "a.jsonl" });
 registry.register({ id: "Nested", kind: "sub", parentId: "A", session: null, status: "parked" });
 const gate = Promise.withResolvers<() => Promise<{ dispose: () => Promise<void> }>>();
 let created = 0;
 lifecycle.setPersistedSubagentReviverFactory(() => gate.promise, 0);
 const pending = lifecycle.ensureLive("A").then(() => false, () => true);
 await lifecycle.dispose(undefined, root);
 gate.resolve(async () => { created++; return { dispose: async () => {} }; });
 assert.equal(await pending, true);
 assert.equal(created, 0);
 assert.equal(lifecycle.has("A"), false);
 assert.equal(registry.get("Nested"), undefined);
 const replacement = registry.register({ id: "Main", kind: "main", session: {} });
 registry.register({ id: "New", kind: "sub", parentId: "Main", session: {}, status: "idle" });
 await lifecycle.dispose(undefined, root);
 assert.equal(registry.get("Main"), replacement);
 assert.ok(registry.get("New")?.session);
 await lifecycle.dispose(undefined, replacement);
 await lifecycle.dispose();
});
await test("bare wait with only a failed job recovers the error and then stops replaying", async () => {
 const manager = new AsyncJobManager({});
 const session = { settings: createSettingsTestScope(() => undefined), asyncJobManager: manager, getAgentId: () => "owner" };
 const waitTool = new WaitTool(session);
 const id = manager.register("bash", "failed", async () => { throw new Error("STALL-FAILURE"); }, { ownerId: "owner" });
 await manager.getJob(id).promise;
 try {
  const first = await waitTool.execute("failure", {});
  assert.ok(JSON.stringify(first).includes("STALL-FAILURE"));
  const second = await waitTool.execute("consumed", {});
  assert.ok(!JSON.stringify(second).includes("STALL-FAILURE"));
 } finally { await manager.dispose({ timeoutMs: 0 }); }
});
await test("queued steering interrupts a running ask, skips a later ask, and reaches the next model step", async () => {
 const settings = createSettingsTestScope(key => {
  if (key === "ask.notify") return "off";
  if (key === "ask.timeout") return 0;
  if (key === "speech.enabled") return false;
  return undefined;
 });
 const ask = new AskTool({ hasUI: true, settings } as never);
 const askStarted = Promise.withResolvers<void>();
 let askSignal: AbortSignal | undefined;
 const toolContext = {
  hasUI: true,
  abort: () => assert.fail("steering ask preemption must not abort the session"),
  ui: {
   timeoutStartsOnPresentation: false,
   askDialog: (_questions: unknown, options?: { signal?: AbortSignal }) => {
    askSignal = options?.signal;
    askStarted.resolve();
    // The real dialog owns this wait. `untilAborted` in AskTool races it against
    // the agent-core tool signal, so it need not resolve to acknowledge a steer.
    return new Promise<never>(() => {});
   },
  },
 };
 const model = getBundledModel("openai", "gpt-4o-mini");
 assert.ok(model);
 let providerCalls = 0;
 let sawSteerAtProvider = false;
 const usage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
 });
 const streamFn = (_model: unknown, context: { messages: unknown[] }) => {
  const stream = createAssistantMessageEventStream();
  const call = ++providerCalls;
  queueMicrotask(() => {
   if (call === 1) {
    const questions = [{
     id: "direction",
     question: "Continue waiting?",
     options: [{ label: "Continue" }, { label: "Stop" }],
     recommended: 0,
    }];
    const firstAsk = {
     type: "toolCall" as const,
     id: "ask-steering-running",
     name: "ask",
     arguments: { questions, i: "Waiting for user direction" },
    };
    const secondAsk = {
     type: "toolCall" as const,
     id: "ask-steering-not-started",
     name: "ask",
     arguments: { questions, i: "Waiting for user direction" },
    };
    const message = {
     role: "assistant" as const,
     content: [firstAsk, secondAsk],
     api: model.api,
     provider: model.provider,
     model: model.id,
     usage: usage(),
     stopReason: "toolUse" as const,
     timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: message });
    stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: firstAsk, partial: message });
    stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
    stream.push({ type: "toolcall_end", contentIndex: 1, toolCall: secondAsk, partial: message });
    stream.push({ type: "done", reason: "toolUse", message });
    stream.end();
    return;
   }
   sawSteerAtProvider = JSON.stringify(context.messages).includes("STEER-NOW");
   const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "Steering handled" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    stopReason: "stop" as const,
    timestamp: Date.now(),
   };
   stream.push({ type: "start", partial: message });
   stream.push({ type: "done", reason: "stop", message });
   stream.end();
  });
  return stream;
 };
 const agent = new Agent({
  initialState: { systemPrompt: [], model, tools: [ask], messages: [] },
  streamFn: streamFn as never,
  getToolContext: () => toolContext as never,
 });
 const askResultDetails = new Map<string, unknown>();
 const unsubscribe = agent.subscribe(event => {
  if (event.type === "tool_execution_end" && event.toolName === "ask") {
   askResultDetails.set(event.toolCallId, event.result.details);
  }
 });
 try {
  const prompt = agent.prompt("Start");
  await within(askStarted.promise, 1_000, "ask start");
  const steeredAt = Date.now();
  agent.steer({
   role: "user",
   content: "STEER-NOW",
   steering: true,
   attribution: "user",
   timestamp: steeredAt,
  });
  await within(prompt, 1_000, "steering preemption");
  assert.equal(askSignal?.aborted, true);
  assert.ok(Date.now() - steeredAt < 1_000);
  assert.deepEqual(askResultDetails.get("ask-steering-running"), {
   __interrupted: true,
   source: "interrupt_skipped",
   execution: "started",
  });
  assert.deepEqual(askResultDetails.get("ask-steering-not-started"), {
   __synthetic: true,
   source: "interrupt_skipped",
   executed: false,
  });
  assert.equal(sawSteerAtProvider, true);
  assert.equal(providerCalls, 2);
 } finally {
  unsubscribe();
 }
});
await test("ordinary ask completion still returns the selected answer", async () => {
 const settings = createSettingsTestScope(key => {
  if (key === "ask.notify") return "off";
  if (key === "ask.timeout") return 0;
  if (key === "speech.enabled") return false;
  return undefined;
 });
 const ask = new AskTool({ hasUI: true, settings } as never);
 const result = await ask.execute(
  "ordinary-ask",
  {
   questions: [{
    id: "direction",
    question: "Continue?",
    options: [{ label: "Continue" }, { label: "Stop" }],
    recommended: 0,
   }],
  },
  undefined,
  undefined,
  {
   hasUI: true,
   abort: () => assert.fail("ordinary ask must not abort"),
   ui: {
    timeoutStartsOnPresentation: false,
    askDialog: async () => ({
     kind: "submit",
     results: [{
      id: "direction",
      question: "Continue?",
      options: ["Continue", "Stop"],
      multi: false,
      selectedOptions: ["Continue"],
     }],
    }),
   },
  } as never,
 );
 assert.equal(result.isError, undefined);
 assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, "User selected: Continue");
 assert.deepEqual(result.details?.selectedOptions, ["Continue"]);
});
console.log(`STALL regression failures: ${failures}`);
process.exitCode = failures ? 1 : 0;
