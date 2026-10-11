// Advisory supervision regression: deterministic clocks plus actual SDK/IRC delivery.
// OMP_CORE_PATCH_TARGET=<source SDK> bun --no-install patches/core-activity-watch-test.ts
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { IrcDeliveryReceipt, IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";
interface FixtureEvent {
  type: string;
  isTerminal?: boolean;
  toolCallId?: string;
  toolName?: string;
  assistantMessageEvent?: { type: string; delta: string };
  partialResult?: { content: { type: string; text?: string }[]; details: { waitingForUser?: boolean } };
}
interface ReceivedMessage { body: string; from: string; to: string }
import { createSettingsTestScope } from "./core-test-settings";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const core = resolve(target, "src");
const { SubagentActivityWatch, attachSubagentActivityWatch } = await import(`${core}/task/executor.ts`);
const { AgentRegistry, formatAgentActivityWatch } = await import(`${core}/registry/agent-registry.ts`);
const { AgentLifecycleManager } = await import(`${core}/registry/agent-lifecycle.ts`);
const { IrcBus } = await import(`${core}/irc/bus.ts`);
const { Agent } = await import(`${core}/../../pi-agent-core/src/agent.ts`);
const { PARENT_REQUEST_STEER } = await import(`${core}/../../pi-agent-core/src/agent-loop.ts`);
const { AskTool } = await import(`${core}/tools/ask.ts`);
const { initThemeSync } = await import(`${core}/../../pi-tui/src/theme/theme.ts`);
const { closeModelCache } = await import(`${core}/../../pi-catalog/src/model-cache.ts`);
initThemeSync();
let passed = 0, failed = 0;
async function check(name: string, body: () => Promise<void> | void) {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: fixture deadline`)), 5_000);
  })]); } finally { clearTimeout(timer); }
}
class Clock {
  time = Date.now();
  jobs = new Map<object, { at: number; run: () => void }>();
  now = () => this.time;
  schedule = (run: () => void, delay: number) => {
    const key = {}; this.jobs.set(key, { at: this.time + delay, run });
    return () => { this.jobs.delete(key); };
  };
  async advance(ms: number) {
    const until = this.time + ms;
    for (;;) {
      const next = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > until) break;
      this.time = next[1].at; this.jobs.delete(next[0]); next[1].run();
      await Promise.resolve(); await Promise.resolve();
    }
    this.time = until;
    await Promise.resolve(); await Promise.resolve();
  }
}
function fixture() {
  const clock = new Clock(), registry = new AgentRegistry(), bus = new IrcBus(registry);
  const events = new Set<(event: FixtureEvent) => void>();
  const disposers: (() => void)[] = [];
  const messages: ReceivedMessage[] = [];
  const agent = new Agent();
  const session = {
    agent, isStreaming: true, sessionManager: { getSessionId: () => "generation-1", getArtifactsDir: () => undefined },
    subscribe: (fn: (event: FixtureEvent) => void) => { events.add(fn); return () => events.delete(fn); },
    addDisposer: (fn: () => void) => disposers.push(fn),
  };
  const emit = (event: FixtureEvent) => { for (const fn of events) fn(event); };
  const stopQueue = agent.onQueueChange(() => emit({ type: "queue_update" }));
  registry.register({ id: "Main", displayName: "Main", kind: "main", status: "idle", session: {
    isStreaming: false, deliverIrcMessage: async (msg: ReceivedMessage) => { messages.push(msg); return "woken"; },
  } });
  const ref = registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session });
  const watch = new SubagentActivityWatch(session, ref, registry, bus, clock);
  return { clock, registry, bus, agent, session, ref, watch, emit, messages,
    close() { watch.dispose(); stopQueue(); },
    text(text = "progress") { emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: text } }); },
    tool(type: string, extra = {}) { emit({ type, toolCallId: "call-1", toolName: "bash", ...extra }); },
  };
}
await check("quiet model attention, bounded repeat, real progress recovery, no prompt leakage", async () => {
  const f = fixture();
  try {
    await f.clock.advance(119_999); assert.equal(f.messages.length, 0);
    f.emit({ type: "usage_update" }); f.emit({ type: "auto_thinking" });
    await f.clock.advance(1); assert.equal(f.messages.length, 1);
    assert.match(f.messages[0].body, /quiet_model/);
    assert.equal(f.bus.sentSince("Child", "Main", 0), false);
    assert.equal(f.watch.snapshot.delivery, "woken");
    await f.clock.advance(299_999); assert.equal(f.messages.length, 1);
    await f.clock.advance(1); assert.equal(f.messages.length, 2);
    f.text("SECRET_CONTENT"); await f.clock.advance(119_999); assert.equal(f.messages.length, 2);
    await f.clock.advance(1); assert.equal(f.messages.length, 3);
    assert.equal(f.watch.snapshot.episode, 2);
    assert.ok(!JSON.stringify(f.messages).includes("SECRET_CONTENT"));
    await f.bus.send({ from: "Child", to: "Main", body: "FINAL_RESULT" });
    assert.equal(f.bus.sentSince("Child", "Main", 0), true);
    assert.equal(f.messages.at(-1)?.body, "FINAL_RESULT");
  } finally { f.close(); }
});
await check("tool progress postpones five-minute attention; human wait does not escalate", async () => {
  const f = fixture();
  try {
    f.tool("tool_execution_start"); await f.clock.advance(299_999); assert.equal(f.messages.length, 0);
    f.tool("tool_execution_update", { partialResult: { content: [{ type: "text", text: "output" }], details: {} } });
    await f.clock.advance(299_999); assert.equal(f.messages.length, 0);
    await f.clock.advance(1); assert.match(f.messages[0].body, /quiet_tool/);
    f.tool("tool_execution_update", { partialResult: { content: [], details: { waitingForUser: true } } });
    await f.clock.advance(900_000); assert.equal(f.messages.length, 1);
    assert.equal(f.watch.snapshot.phase, "user_waiting");
    f.tool("tool_execution_update", { partialResult: { content: [], details: { waitingForUser: false } } });
    await f.clock.advance(300_000); assert.equal(f.messages.length, 2);
    f.tool("tool_execution_end"); assert.equal(f.watch.snapshot.phase, "model_waiting");
  } finally { f.close(); }
});
await check("true queued parent gets attention after sixty seconds while tool runs; clear recovers", async () => {
  const f = fixture();
  try {
    f.tool("tool_execution_start"); await f.clock.advance(20_000);
    f.agent.steer({ role: "user", attribution: "agent", content: "PRIVATE_PARENT", timestamp: f.clock.now(), [PARENT_REQUEST_STEER]: true });
    await f.clock.advance(59_999); assert.equal(f.messages.length, 0);
    await f.clock.advance(1); assert.match(f.messages[0].body, /parent_directive_pending/);
    f.agent.clearSteeringQueue(); assert.equal(f.watch.snapshot.pendingParentSince, null);
    assert.ok(!f.messages[0].body.includes("PRIVATE_PARENT"));
    f.agent.steer({ role: "user", attribution: "agent", content: "PEER", timestamp: f.clock.now() });
    await f.clock.advance(60_000); assert.equal(f.messages.length, 1);
  } finally { f.close(); }
});
await check("terminal, disposal, park and generation replacement retire timers without late wake", async () => {
  for (const action of ["terminal", "dispose", "park", "replace"]) {
    const f = fixture();
    try {
      if (action === "terminal") f.emit({ type: "agent_end", isTerminal: true });
      if (action === "dispose") f.watch.dispose();
      if (action === "park") f.registry.setStatus("Child", "parked");
      if (action === "replace") f.registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: { ...f.session } });
      await f.clock.advance(900_000); assert.equal(f.messages.length, 0, action);
      assert.equal(f.clock.jobs.size, 0, action);
    } finally { f.close(); }
  }
});
await check("retry continuation cannot erase quiet time; resumed run has one new timer", async () => {
  const f = fixture();
  try {
    await f.clock.advance(100_000);
    f.emit({ type: "agent_end", isTerminal: false }); f.emit({ type: "agent_start" });
    await f.clock.advance(20_000); assert.equal(f.messages.length, 1);
    f.emit({ type: "agent_end", isTerminal: true }); assert.equal(f.clock.jobs.size, 0);
    f.emit({ type: "agent_start" }); assert.equal(f.clock.jobs.size, 1);
    await f.clock.advance(120_000); assert.equal(f.messages.length, 2);
    assert.match(formatAgentActivityWatch(f.watch.snapshot, f.clock.now() + 300_001), /"scheduler":"overdue"/);
  } finally { f.close(); }
});
await check("IRC waiter is awakened, advisory does not consume final-answer accounting", async () => {
  const f = fixture();
  try {
    const waiting = f.bus.wait("Main", { from: "Child" }, 0);
    await f.clock.advance(120_000);
    const received = await within<IrcMessage | null>(waiting, "IRC waiter");
    assert.ok(received);
    assert.match(received.body, /quiet_model/); assert.equal(f.messages.length, 0);
    assert.equal(f.bus.sentSince("Child", "Main", 0), false);
    await f.bus.send({ from: "Child", to: "Main", body: "AFTER_ADVISORY_FINAL" });
    assert.deepEqual(f.messages.map(x => x.body), ["AFTER_ADVISORY_FINAL"]);
  } finally { f.close(); }
});
await check("cancel during actual lifecycle revival prevents late advisory injection", async () => {
  const registry = new AgentRegistry(), lifecycle = new AgentLifecycleManager(registry), bus = new IrcBus(registry, lifecycle);
  const gate = Promise.withResolvers<unknown>(); let delivered = 0;
  registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, status: "parked" });
  registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: {} });
  lifecycle.adopt("Main", { idleTtlMs: 0, revive: () => gate.promise });
  const controller = new AbortController();
  const receipt = bus.send({ from: "Child", to: "Main", body: "LATE", wakeRelay: true }, { signal: controller.signal, countsAsReply: false });
  controller.abort();
  gate.resolve({ isStreaming: false, hasPendingAsyncWork: () => false, dispose: async () => {}, deliverIrcMessage: async () => { delivered++; return "woken"; } });
  assert.equal((await within<IrcDeliveryReceipt>(receipt, "revival cancellation")).outcome, "failed");
  assert.equal(delivered, 0); assert.equal(bus.sentSince("Child", "Main", 0), false);
  await lifecycle.dispose();
});
await check("failed advisory is not buffered; ordinary failed messages keep inbox semantics", async () => {
  const f = fixture();
  try {
    f.registry.get("Main").session.deliverIrcMessage = async () => { throw new Error("fixture recipient unavailable"); };
    await f.clock.advance(120_000);
    assert.equal(f.watch.snapshot.delivery, "failed");
    assert.equal(f.bus.unreadCount("Main"), 0);
    await f.bus.send({ from: "Child", to: "Main", body: "ORDINARY_PENDING" });
    assert.equal(f.bus.unreadCount("Main"), 1);
    assert.equal(f.bus.take("Main").body, "ORDINARY_PENDING");
  } finally { f.close(); }
});
await check("agent/proc inspection exposes current monitoring and preserves JSON extraction", async () => {
  const { AgentProtocolHandler } = await import(`${core}/internal-urls/agent-protocol.ts`);
  const { ProcProtocolHandler } = await import(`${core}/internal-urls/proc-protocol.ts`);
  const { AsyncJobManager } = await import(`${core}/async/job-manager.ts`);
  const f = fixture(), root = mkdtempSync(join(tmpdir(), "omp-watch-inspect-"));
  const manager = new AsyncJobManager({});
  const gate = Promise.withResolvers<string>();
  AgentRegistry.resetGlobalForTests();
  const registry = AgentRegistry.global();
  mkdirSync(join(root, "root"));
  writeFileSync(join(root, "root", "Child.md"), JSON.stringify({ answer: 42 }));
  registry.register({ id: "Main", displayName: "Main", kind: "main", session: null, sessionFile: join(root, "root.jsonl"), status: "idle" });
  const ref = registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: f.session });
  registry.setActivityWatch(ref, f.session, f.watch.snapshot);
  const handler = new AgentProtocolHandler();
  const url = (scheme: string, host: string, suffix = "") => Object.assign(new URL(`${scheme}://${host}${suffix}`), { rawHost: host });
  const job = manager.register("task", "inspection fixture", () => gate.promise, { ownerId: "Main", agentId: "Child" });
  try {
    const full = await handler.resolve(url("agent", "Child"), { agentRegistry: registry });
    assert.match(full.content, /Child activity; advisory only/);
    assert.match(full.content, /"transportProgress":"unknown"/);
    const extracted = await handler.resolve(url("agent", "Child", "/answer"), { agentRegistry: registry });
    assert.equal(extracted.content, "42"); assert.equal(extracted.contentType, "application/json");
    assert.equal(await handler.locate(url("agent", "Child"), { agentRegistry: registry }), null);
    const proc = new ProcProtocolHandler();
    const result = await proc.resolve(url("proc", job), { agentRegistry: registry, session: {
      settings: createSettingsTestScope(key => key === "launch.enabled" ? false : undefined),
      asyncJobManager: manager, agentRegistry: registry, getAgentId: () => "Main",
    } });
    assert.match(result.content, /Child activity; advisory only/);
  } finally {
    f.close(); gate.resolve("fixture complete"); await manager.getJob(job).promise;
    rmSync(root, { recursive: true, force: true });
  }
});
await check("actual ask marks only interactive waiting and always clears on answer/error/cancel", async () => {
  const settings = createSettingsTestScope(key => key === "ask.notify" ? "off" : key === "ask.timeout" ? 0 : key === "speech.enabled" ? false : undefined);
  for (const mode of ["answer", "error", "cancel", "headless"]) {
    const updates: boolean[] = [], entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<unknown>(), abort = new AbortController();
    const ask = new AskTool({ hasUI: mode !== "headless", settings } as never);
    const pending = ask.execute("watch-ask", { questions: [{ id: "q", question: "Choice?", options: [{ label: "A" }, { label: "B" }] }] }, abort.signal,
      (value: { details?: { waitingForUser?: boolean } }) => { if (typeof value.details?.waitingForUser === "boolean") updates.push(value.details.waitingForUser); },
      { hasUI: mode !== "headless", abort() {}, ui: { timeoutStartsOnPresentation: false, askDialog: () => { entered.resolve(); return gate.promise; } } } as never);
    if (mode !== "headless") {
      await within(entered.promise, "ask entered"); assert.deepEqual(updates, [true]);
      if (mode === "answer") gate.resolve({ kind: "submit", results: [{ id: "q", question: "Choice?", options: ["A", "B"], multi: false, selectedOptions: ["A"] }] });
      if (mode === "error") gate.reject(new Error("fixture UI error"));
      if (mode === "cancel") abort.abort();
    }
    await within(pending.catch(() => undefined), "ask settles");
    assert.deepEqual(updates, mode === "headless" ? [] : [true, false], mode);
  }
});

// Actual AgentSession and local HTTP/SSE. Only the observer's clock is accelerated;
// provider requests, queue delivery and idle/busy Main behavior use the real SDK.
const { createAgentSession } = await import(`${core}/sdk.ts`);
const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
const encoder = new TextEncoder();
const held = new Map<string, { ready: PromiseWithResolvers<void>; finish?: () => void; requests: string[] }>();
function send(controller: ReadableStreamDefaultController<Uint8Array>, data: { type: string; [key: string]: unknown }) {
  controller.enqueue(encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`));
}
const server = Bun.serve({ port: 0, async fetch(request) {
  const body = await request.text();
  const key = body.includes("CHILD_FIXTURE") ? "child" : "parent";
  const state = held.get(key)!; state.requests.push(body);
  const hold = state.requests.length === 1 && !body.includes("[Child activity advisory");
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    send(controller, { type: "message_start", message: { id: `fixture-${key}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    send(controller, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send(controller, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "LOCAL_PROGRESS" } });
    const finish = () => {
      send(controller, { type: "content_block_stop", index: 0 });
      send(controller, { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send(controller, { type: "message_stop" }); controller.close();
    };
    state.finish = finish; state.ready.resolve(); if (!hold) finish();
  } }), { headers: { "content-type": "text/event-stream" } });
} });
async function realScenario(busy: boolean) {
  AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
  const root = mkdtempSync(join(tmpdir(), "omp-activity-watch-"));
  const profile = join(root, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "models.yml"), `providers:\n  activity-fixture:\n    baseUrl: http://127.0.0.1:${server.port}\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n`);
  const sessions: AgentSession[] = [], done: Promise<void>[] = [], detach: (() => void)[] = [];
  for (const key of ["child", "parent"]) held.set(key, { ready: Promise.withResolvers<void>(), requests: [] });
  const make = async () => {
    const { session } = await createAgentSession({
      model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "activity-fixture", baseUrl: `http://127.0.0.1:${server.port}` },
      getApiKey: async () => "example", cwd: root, agentDir: profile, thinkingLevel: "off", disableExtensionDiscovery: true,
      enableLsp: false, enableMCP: false, skipPythonPreflight: true, toolNames: [], restrictToolNames: true, requireYieldTool: false,
    });
    session.modelRegistry.authStorage.keys.setConfig("activity-fixture", "example"); sessions.push(session); return session;
  };
  try {
    const parent = await make(), child = await make(), registry = AgentRegistry.global(), clock = new Clock();
    registry.register({ id: "Main", displayName: "Main", kind: "main", session: parent, status: "idle" });
    const childRef = registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: child });
    detach.push(attachSubagentActivityWatch(child, "Child", () => {}, clock));
    detach.push(attachSubagentActivityWatch(child, "Child", () => {}, clock));
    const childDelta = Promise.withResolvers<void>();
    detach.push(child.subscribe((event: AgentSessionEvent) => { if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") childDelta.resolve(); }));
    if (busy) { done.push(parent.prompt("PARENT_FIXTURE").then(() => parent.agent.waitForIdle())); await within(held.get("parent")!.ready.promise, "busy Main starts"); }
    done.push(child.prompt("CHILD_FIXTURE").then(() => child.agent.waitForIdle()));
    await within(childDelta.promise, "real child text delta");
    assert.equal(childRef.activityWatch?.phase, "model_streaming"); assert.equal(clock.jobs.size, 1);
    await clock.advance(120_000); await Bun.sleep(20);
    assert.equal(IrcBus.global().sentSince("Child", "Main", 0), false);
    assert.equal(childRef.activityWatch.delivery, busy ? "injected" : "woken");
    if (busy) {
      assert.equal(parent.isStreaming, true); assert.equal(held.get("parent")!.requests.length, 1);
      held.get("parent")!.finish!(); await within(done[0], "busy Main consumes advisory");
    } else { await within(held.get("parent")!.ready.promise, "idle Main wakes"); await parent.agent.waitForIdle(); }
    assert.ok(held.get("parent")!.requests.some(body => body.includes("[Child activity advisory")));
    held.get("child")!.finish!(); await within(done.at(-1)!, "child normal completion");
    assert.equal(childRef.activityWatch.watcher, "inactive"); assert.equal(clock.jobs.size, 0);
    const count = held.get("parent")!.requests.length;
    await clock.advance(900_000); assert.equal(held.get("parent")!.requests.length, count);
    console.log(`SDK ${busy ? "busy injection" : "idle wake"}: actual parent request contains advisory; child completes naturally; one observer/timer; no late wake`);
  } finally {
    for (const fn of detach) fn();
    for (const session of sessions) {
      session.agent.clearAllQueues();
      if (session.isStreaming) await session.abort();
      await session.dispose();
      // This fixture owns the per-profile store; AgentSession does not own shared auth.
      session.modelRegistry.authStorage.close();
    }
    await Promise.allSettled(done);
    closeModelCache(); // Process-shared models.db must close before Windows directory removal.
    rmSync(root, { recursive: true, force: true });
  }
}
try {
  await check("actual SDK idle Main wakes from quiet-child advisory", () => realScenario(false));
  await check("actual SDK busy Main receives advisory without interrupting its request", () => realScenario(true));
} finally { server.stop(true); }
console.log(`RESULT: ${passed} pass, ${failed} fail`);
process.exitCode = failed ? 1 : 0;
