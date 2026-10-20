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
  args?: unknown;
  result?: unknown;
  message?: { role: string; usage?: { output: number } };
  isError?: boolean;
}
interface ReceivedMessage { body: string; from: string; to: string }
import { createSettingsTestScope } from "./core-test-settings";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const core = resolve(target, "src");
// The SDK keeps process-global stores under the first profile. Let OS process
// teardown release them before the parent removes its fixture tree on Windows.
if (process.argv[2] !== "--fixture-worker") {
  const root = mkdtempSync(join(tmpdir(), "omp-activity-watch-suite-"));
  let exitCode = 1;
  try {
    exitCode = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, "--fixture-worker", root], {
      env: process.env, stdout: "inherit", stderr: "inherit",
    }).exitCode;
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.exit(exitCode);
}
const fixtureRoot = process.argv[3]!;
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
function fixture(assignment?: string) {
  const clock = new Clock(), registry = new AgentRegistry(), bus = new IrcBus(registry);
  const events = new Set<(event: FixtureEvent) => void>();
  const parentEvents = new Set<(event: FixtureEvent) => void>();
  const parentEmit = (event: FixtureEvent) => { for (const fn of parentEvents) fn(event); };
  const disposers: (() => void)[] = [];
  const messages: ReceivedMessage[] = [];
  const agent = new Agent();
  const jobs: { running: object[] } = { running: [] };
  const session = {
    agent, isStreaming: true, sessionManager: { getSessionId: () => "generation-1", getArtifactsDir: () => undefined },
    subscribe: (fn: (event: FixtureEvent) => void) => { events.add(fn); return () => events.delete(fn); },
    addDisposer: (fn: () => void) => disposers.push(fn),
    getAsyncJobSnapshot: () => ({ running: jobs.running }),
  };
  const emit = (event: FixtureEvent) => { for (const fn of events) fn(event); };
  const stopQueue = agent.onQueueChange(() => emit({ type: "queue_update" }));
  registry.register({ id: "Main", displayName: "Main", kind: "main", status: "idle", session: {
    isStreaming: false, deliverIrcMessage: async (msg: ReceivedMessage) => { messages.push(msg); return "woken"; },
    subscribe: (fn: (event: FixtureEvent) => void) => { parentEvents.add(fn); return () => parentEvents.delete(fn); },
  } });
  const ref = registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session });
  const watch = new SubagentActivityWatch(session, ref, registry, bus, clock, assignment);
  return { clock, registry, bus, agent, session, ref, watch, emit, messages, parentEmit, jobs,
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
await check("inspection and directive are distinct, successful, current-episode observations", async () => {
  const f = fixture();
  const start = (id: string, toolName = "read", path = "agent://Child") =>
    f.parentEmit({ type: "tool_execution_start", toolCallId: id, toolName, args: { path } });
  const end = (id: string, content: string, extra = {}) =>
    f.parentEmit({ type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [{ type: "text", text: content }] }, ...extra });
  try {
    await f.clock.advance(120_000);
    assert.equal(f.watch.snapshot.inspectedAt, null);
    const visible = formatAgentActivityWatch(f.watch.snapshot);
    start("truncated"); end("truncated", visible.slice(0, -20));
    start("failed"); end("failed", visible, { isError: true });
    start("other", "read", "agent://Other"); end("other", visible);
    start("omitted"); end("omitted", "Only earlier result content");
    start("failed-write", "write");
    f.parentEmit({ type: "tool_execution_end", toolCallId: "failed-write", toolName: "write",
      result: { details: { message: { receipts: [{ to: "Child", outcome: "failed" }] } } } });
    assert.equal(f.watch.snapshot.actionAt, null);
    assert.equal(f.watch.snapshot.inspectedAt, null);
    start("read"); end("read", visible);
    assert.equal(f.watch.snapshot.inspectedAt, f.clock.now());
    assert.equal(f.watch.snapshot.actionAt, null);
    assert.equal(f.watch.snapshot.episodeState, "attention");
    start("write", "write");
    f.parentEmit({ type: "tool_execution_end", toolCallId: "write", toolName: "write",
      result: { details: { message: { receipts: [{ to: "Child", outcome: "injected" }] } } } });
    assert.equal(f.watch.snapshot.action, "parent_directive_delivered");
    assert.equal(f.watch.snapshot.episodeState, "attention");
    await f.clock.advance(300_000);
    assert.equal(f.messages.length, 2, "inspection/action do not suppress existing repeat");
    start("late"); f.text(); await f.clock.advance(120_000); end("late", visible);
    assert.equal(f.watch.snapshot.episode, 2);
    assert.equal(f.watch.snapshot.inspectedAt, null);
    assert.equal(f.watch.snapshot.actionAt, null);
    start("replaced");
    f.registry.register({ id: "Main", displayName: "Main", kind: "main", session: {
      subscribe: () => () => {}, deliverIrcMessage: async () => "woken",
    } });
    end("replaced", formatAgentActivityWatch(f.watch.snapshot));
    assert.equal(f.watch.snapshot.inspectedAt, null);
    f.registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: { ...f.session } });
    end("late-child", visible);
    assert.equal(f.watch.snapshot.inspectedAt, null);
    assert.equal(f.clock.jobs.size, 0);
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
// Generation-heavy supervision (2026-10-20): a Maker spent 92 min with 92% model time and 275 long responses while the
// only advisories were quiet_model. One cycle = streaming deltas every 30 s, a response end with `tokens` output, then a tool.
interface WatchFixture {
  clock: Clock; messages: ReceivedMessage[];
  emit(event: FixtureEvent): void; text(): void; tool(type: string, extra?: object): void;
}
async function cycle(f: WatchFixture, modelMs: number, tokens: number, toolMs = 0) {
  for (let left = modelMs; left > 0; left -= 30_000) { f.text(); await f.clock.advance(Math.min(30_000, left)); }
  f.emit({ type: "message_end", message: { role: "assistant", usage: { output: tokens } } });
  if (toolMs > 0) { f.tool("tool_execution_start"); await f.clock.advance(toolMs); f.tool("tool_execution_end"); }
}
const advisories = (f: WatchFixture) => f.messages.map(m => JSON.parse(m.body.slice(m.body.indexOf("\n") + 1)));
await check("generation_heavy fires once on the measured long-response pattern, with numbers", async () => {
  const f = fixture();
  try {
    // Measured Task D shape: ~170 s responses of 13k tokens, ~10 s tools => ~94% model time.
    for (let i = 0; i < 4; i++) await cycle(f, 170_000, 13_000 + i * 100, 10_000);
    assert.equal(f.messages.length, 1, "fires within ~12 min, before any quiet reason");
    const [advice] = advisories(f);
    assert.equal(advice.reason, "generation_heavy");
    assert.ok(advice.stats.elapsedMs >= 600_000 && advice.stats.elapsedMs <= 900_000, String(advice.stats.elapsedMs));
    assert.ok(advice.stats.modelShare >= 0.9, String(advice.stats.modelShare));
    assert.ok(advice.stats.modelMs > advice.stats.toolMs * 10);
    assert.ok(advice.stats.responses >= 3 && advice.stats.outputTokens >= 39_000);
    assert.equal(advice.stats.maxResponseOutputTokens >= 13_000, true);
    assert.equal(advice.stats.heavyResponses15m >= 3, true);
    assert.deepEqual(advice.stats.recentOutputTokens.slice(0, 3), [13_000, 13_100, 13_200]);
    assert.equal(advice.stats.expectedMinutes, null);
    assert.match(advice.intervention, /compact/i);
    // Same episode: more long responses never repeat the advisory.
    for (let i = 0; i < 6; i++) await cycle(f, 170_000, 13_000, 10_000);
    assert.equal(f.messages.length, 1);
    // The episode ends once long responses stop for the window; the next burst is a new episode.
    for (let i = 0; i < 6; i++) await cycle(f, 60_000, 500, 60_000);
    for (let i = 0; i < 5; i++) await cycle(f, 170_000, 13_000, 10_000);
    assert.deepEqual(advisories(f).map(a => a.reason), ["generation_heavy", "generation_heavy"]);
  } finally { f.close(); }
});
await check("normal runs do not report generation_heavy", async () => {
  for (const [name, model, tokens, tool] of [
    ["short responses, mixed tools", 40_000, 600, 20_000],
    ["short responses, model bound", 60_000, 1_500, 5_000],
    ["long responses but tool bound", 60_000, 13_000, 120_000],
    ["mid-size responses, model bound", 100_000, 6_000, 8_000],
  ] as const) {
    const f = fixture();
    try {
      for (let elapsed = 0; elapsed < 45 * 60_000; elapsed += model + tool) await cycle(f, model, tokens, tool);
      assert.equal(f.messages.length, 0, `${name}: ${f.messages.map(m => m.body).join("|")}`);
    } finally { f.close(); }
  }
});
await check("over_expected needs EXPECTED_MINUTES in the assignment and fires once when exceeded", async () => {
  const run = async (assignment: string | undefined, minutes: number) => {
    const f = fixture(assignment);
    try { for (let i = 0; i < minutes; i++) await cycle(f, 50_000, 400, 10_000); return advisories(f); }
    finally { f.close(); }
  };
  assert.deepEqual(await run("TASK_GUARD:\nWORK_CLASS: feature\nEXPECTED_MINUTES: 20\nDONE_WHEN: tests pass", 19), []);
  const over = await run("TASK_GUARD:\nWORK_CLASS: feature\nEXPECTED_MINUTES: 20\nDONE_WHEN: tests pass", 30);
  assert.deepEqual(over.map(a => a.reason), ["over_expected"]);
  assert.equal(over[0].stats.expectedMinutes, 20);
  assert.ok(over[0].stats.elapsedMs > 20 * 60_000 && over[0].stats.elapsedMs < 22 * 60_000, String(over[0].stats.elapsedMs));
  assert.deepEqual(await run(undefined, 30), [], "no field: behaviour unchanged");
  assert.deepEqual(await run("EXPECTED_MINUTES: soon", 30), [], "unparseable value is ignored");
  assert.deepEqual(await run("see EXPECTED_MINUTES: 5 in the text", 30), [], "only a metadata line counts");
  for (const bad of ["20.5", "1e9", "1440.5", "0", "1441", "20min", "-5"]) {
    assert.deepEqual(await run(`EXPECTED_MINUTES: ${bad}`, 30), [], `${bad} is not a whole integer token in 1..1440`);
  }
  assert.deepEqual((await run("EXPECTED_MINUTES: 20  \nDONE_WHEN: x", 30)).map(a => a.reason), ["over_expected"], "trailing whitespace is fine");
});
await check("over_expected never aborts a pending generation_heavy delivery", async () => {
  const f = fixture("EXPECTED_MINUTES: 10");
  const sends: { reason: string; signal: AbortSignal }[] = [];
  // First send stays pending (a parked Main being revived) and rejects only if it is aborted; later sends succeed at once.
  f.bus.send = (msg: { body: string }, opts: { signal: AbortSignal }) => {
    sends.push({ reason: JSON.parse(msg.body.slice(msg.body.indexOf("\n") + 1)).reason, signal: opts.signal });
    if (sends.length > 1) return Promise.resolve({ to: "Main", outcome: "woken" });
    const { promise, reject } = Promise.withResolvers<never>();
    opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
    return promise;
  };
  try {
    for (let i = 0; i < 12; i++) await cycle(f, 100_000, 13_000, 10_000);
    assert.deepEqual(sends.map(s => s.reason), ["generation_heavy", "over_expected"]);
    assert.equal(sends[0].signal.aborted, false, "the pending generation_heavy delivery must survive the over_expected send");
  } finally { f.close(); }
});
// A child that ends its turn on its OWN background job (agent_end awaitingAsyncWork) stays inert until the job settles.
// Main cannot read or cancel owner-scoped jobs, so the watch must keep supervising instead of reporting idle. 2026-10-20.
await check("awaiting_own_job: child waiting on its own job gets one attention advisory, wake resets quiet time, terminal stops", async () => {
  const f = fixture();
  f.jobs.running = [{ id: "bg_7", type: "eval", status: "running", label: "S2-S10 batch", startTime: f.clock.time }];
  try {
    f.tool("tool_execution_start", { toolName: "eval" }); f.tool("tool_execution_end", { toolName: "eval" });
    const before = { ...f.watch.snapshot.stats };
    f.emit({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
    assert.equal(f.watch.snapshot.phase, "awaiting_own_job");
    assert.equal(f.watch.snapshot.watcher, "scheduled");
    assert.deepEqual(f.watch.snapshot.ownedJobs.map((job: { id: string }) => job.id), ["bg_7"]);
    await f.clock.advance(299_999); assert.equal(f.messages.length, 0);
    await f.clock.advance(1); assert.equal(f.messages.length, 1);
    const [advice] = advisories(f);
    assert.equal(advice.reason, "awaiting_own_job");
    assert.deepEqual(advice.ownedJobs.map((job: { id: string; ageMs: number }) => [job.id, job.ageMs]), [["bg_7", 300_000]]);
    assert.match(advice.intervention, /no automatic kill/);
    // Waiting on a job is not model time: it must not inflate modelShare toward generation_heavy.
    assert.equal(f.watch.snapshot.stats.modelMs, before.modelMs);
    assert.ok(f.watch.snapshot.stats.toolMs >= before.toolMs + 300_000);
    // The job settles and its delivery wakes the child: that is progress, not 5 minutes of a quiet model.
    f.jobs.running = [];
    f.emit({ type: "agent_start" });
    assert.equal(f.watch.snapshot.phase, "model_waiting");
    assert.deepEqual(f.watch.snapshot.ownedJobs, []);
    await f.clock.advance(119_999); assert.equal(f.messages.length, 1);
    await f.clock.advance(1); assert.equal(f.messages.length, 2);
    assert.equal(advisories(f)[1].reason, "quiet_model");
    // Back on a job, then the run ends for good: no late advisory and no stale job list.
    f.text();
    f.jobs.running = [{ id: "bg_8", type: "bash", status: "running", label: "bun test", startTime: f.clock.time }];
    f.emit({ type: "agent_end", isTerminal: false, yielded: true, awaitingAsyncWork: true });
    assert.equal(f.watch.snapshot.phase, "awaiting_own_job");
    f.emit({ type: "agent_end", isTerminal: true, yielded: true });
    assert.equal(f.watch.snapshot.phase, "idle"); assert.equal(f.watch.snapshot.watcher, "inactive");
    assert.deepEqual(f.watch.snapshot.ownedJobs, []);
    await f.clock.advance(30 * 60_000); assert.equal(f.messages.length, 2);
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
const { Settings } = await import(`${core}/config/settings.ts`);
const encoder = new TextEncoder();
const held = new Map<string, { ready: PromiseWithResolvers<void>; finish?: () => void; requests: string[] }>();
let inspectionScheme = "agent";
function send(controller: ReadableStreamDefaultController<Uint8Array>, data: { type: string; [key: string]: unknown }) {
  controller.enqueue(encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`));
}
const server = Bun.serve({ port: 0, async fetch(request) {
  const body = await request.text();
  const key = body.includes("CHILD_FIXTURE") ? "child" : "parent";
  const state = held.get(key)!; state.requests.push(body);
  const hold = state.requests.length === 1 && !body.includes("[Child activity advisory");
  const inspect = key === "parent" && body.includes("[Child activity advisory") && !body.includes('"tool_use_id":"inspect-child"');
  const direct = key === "parent" && body.includes('"tool_use_id":"inspect-child"') && !body.includes('"tool_use_id":"direct-child"');
  const tool = inspect ? { id: "inspect-child", name: "read", input: { path: `${inspectionScheme}://Child` } }
    : direct ? { id: "direct-child", name: "write", input: { path: "agent://Child", content: "Continue the assigned work safely." } } : undefined;
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    send(controller, { type: "message_start", message: { id: `fixture-${key}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    send(controller, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send(controller, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "LOCAL_PROGRESS" } });
    const finish = () => {
      send(controller, { type: "content_block_stop", index: 0 });
      if (tool) {
        send(controller, { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: tool.id, name: tool.name, input: {} } });
        send(controller, { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) } });
        send(controller, { type: "content_block_stop", index: 1 });
      }
      send(controller, { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send(controller, { type: "message_stop" }); controller.close();
    };
    state.finish = finish; state.ready.resolve(); if (!hold) finish();
  } }), { headers: { "content-type": "text/event-stream" } });
} });
async function realScenario(busy: boolean) {
  inspectionScheme = busy ? "proc" : "agent";
  AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
  const root = mkdtempSync(join(fixtureRoot, "scenario-"));
  const profile = join(root, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "models.yml"), `providers:\n  activity-fixture:\n    baseUrl: http://127.0.0.1:${server.port}\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n`);
  const sessions: AgentSession[] = [], done: Promise<void>[] = [], detach: (() => void)[] = [];
  for (const key of ["child", "parent"]) held.set(key, { ready: Promise.withResolvers<void>(), requests: [] });
  const make = async (agentId: string) => {
    const { session } = await createAgentSession({
      model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "activity-fixture", baseUrl: `http://127.0.0.1:${server.port}` },
      getApiKey: async () => "example", cwd: root, agentDir: profile, thinkingLevel: "off", disableExtensionDiscovery: true,
      settings: Settings.isolated({ "launch.enabled": false }),
      agentId, ...(agentId === "Child" ? { parentAgentId: "Main", taskDepth: 1 } : {}), enableIrc: true,
      enableLsp: false, enableMCP: false, skipPythonPreflight: true, toolNames: agentId === "Main" ? ["read", "write"] : [], restrictToolNames: agentId !== "Main", requireYieldTool: false,
    });
    session.modelRegistry.authStorage.keys.setConfig("activity-fixture", "example"); sessions.push(session); return session;
  };
  try {
    const parent = await make("Main"), child = await make("Child"), registry = AgentRegistry.global(), clock = new Clock();
    registry.register({ id: "Main", displayName: "Main", kind: "main", session: parent, status: "idle" });
    const childRef = registry.register({ id: "Child", displayName: "Child", kind: "sub", parentId: "Main", session: child });
    detach.push(attachSubagentActivityWatch(child, "Child", () => {}, clock));
    detach.push(attachSubagentActivityWatch(child, "Child", () => {}, clock));
    const childDelta = Promise.withResolvers<void>();
    const followed = Promise.withResolvers<void>();
    detach.push(parent.subscribe(event => {
      if (event.type === "tool_execution_end" && event.toolName === "write") {
        console.log("SDK directive result", JSON.stringify(event.result), "watch", JSON.stringify(childRef.activityWatch));
        followed.resolve();
      }
    }));
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
    await within(followed.promise, "actual parent read and directive");
    assert.ok(childRef.activityWatch.inspectedAt !== null, "actual read snapshot observed");
    assert.ok(childRef.activityWatch.actionAt !== null, "actual directive receipt observed");
    assert.equal(childRef.activityWatch.action, "parent_directive_delivered");
    if (child.isStreaming && held.get("child")!.requests.length === 1) held.get("child")!.finish!();
    await within(done.at(-1)!, "child normal completion");
    assert.equal(childRef.activityWatch.watcher, "inactive"); assert.equal(clock.jobs.size, 0);
    const count = held.get("parent")!.requests.length;
    await clock.advance(900_000); assert.equal(held.get("parent")!.requests.length, count);
    console.log(`SDK ${busy ? "busy injection" : "idle wake"}: actual advisory -> read snapshot -> delivered directive; child completes; no late wake`);
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
  }
}
try {
  await check("actual SDK idle Main wakes from quiet-child advisory", () => realScenario(false));
  await check("actual SDK busy Main receives advisory without interrupting its request", () => realScenario(true));
} finally { server.stop(true); }
await check("actual SDK task producer preserves long terminal evidence through async delivery and proc", async () => {
  AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
  const report = { revision: "completion-fixture", padding: "evidence ".repeat(1200), validation: { smoke: "observed" } };
  let parentRequests = 0;
  const local = Bun.serve({ port: 0, async fetch(request) {
    const input = await request.json() as { tools?: { name: string }[] };
    const yieldName = input.tools?.find(tool => tool.name === "yield" || tool.name === "_yield")?.name;
    const call = yieldName ? { id: "long-yield", name: yieldName, input: { data: report } }
      // 18.11.3 upstream (seance) rejects `model` on a non-maker agent; the child inherits the parent's fixture model.
      : parentRequests++ === 0 ? { id: "spawn-long", name: "task", input: { context: "Local completion fixture", tasks: [
        { name: "EvidenceChild", agent: "task", task: "Return the fixture report.", solutionSpace: "Return supplied fixture only.", isolated: false },
      ] } } : undefined;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      send(controller, { type: "message_start", message: { id: "completion", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
      send(controller, { type: "content_block_start", index: 0, content_block: call
        ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } });
      send(controller, { type: "content_block_delta", index: 0, delta: call
        ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "Fixture handled." } });
      send(controller, { type: "content_block_stop", index: 0 });
      send(controller, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
      send(controller, { type: "message_stop" }); controller.close();
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const root = mkdtempSync(join(fixtureRoot, "completion-")), profile = join(root, "profile");
  mkdirSync(profile);
  writeFileSync(join(profile, "models.yml"), `providers:\n  activity-fixture:\n    baseUrl: http://127.0.0.1:${local.port}\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n`);
  // CUELO config.yml sets task.structured (default false since core 18.10.2), so the child gets `yield`; 18.9.1 ignores the key.
  writeFileSync(join(profile, "config.yml"), "task:\n  structured: true\n");
  const { session } = await createAgentSession({
    model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "activity-fixture", baseUrl: `http://127.0.0.1:${local.port}` },
    getApiKey: async () => "example", cwd: root, agentDir: profile, agentId: "Main", thinkingLevel: "off",
    disableExtensionDiscovery: true, enableLsp: false, enableMCP: false, skipPythonPreflight: true, toolNames: ["task"],
  });
  session.modelRegistry.authStorage.keys.setConfig("activity-fixture", "example");
  try {
    await within(session.prompt("Produce the local completion fixture."), "parent spawns evidence child");
    const job = session.asyncJobManager?.getAllJobs({ ownerId: "Main" }).find(job => job.type === "task" && job.agentId?.startsWith("EvidenceChild"));
    assert.ok(job, `real task registered a job: ${JSON.stringify(session.messages.filter(message => message.role === "toolResult"))}`);
    await within(job.promise, "actual child terminal yield");
    assert.equal(job.status, "completed", job.errorText);
    assert.deepEqual(JSON.parse(job.completion.output), report);
    assert.equal(job.completion.startTime, job.startTime);
    assert.equal(job.completion.agentId, job.agentId);
    assert.ok(Object.isFrozen(job.completion));
    assert.ok(!job.resultText.includes('"smoke": "observed"'), "preview cannot substitute for full validation evidence");
    const { buildAsyncResultBatchMessage } = await import(`${core}/session/async-job-delivery.ts`);
    const delivered = buildAsyncResultBatchMessage([{ jobId: job.id, result: job.resultText, durationMs: 1, job }]);
    assert.deepEqual(JSON.parse(delivered.details.jobs[0].completion.output), report);
    const { snapshotJobs } = await import(`${core}/async/job-control.ts`);
    const toolSession = { asyncJobManager: session.asyncJobManager, agentRegistry: AgentRegistry.global(),
      settings: createSettingsTestScope(key => key === "launch.enabled" ? false : undefined), getAgentId: () => "Main" };
    assert.deepEqual(snapshotJobs(toolSession, [job], { includeResults: true })[0].completion, job.completion);
    assert.equal(snapshotJobs(toolSession, [job], { includeResults: false })[0].completion, undefined);
    const { ProcProtocolHandler } = await import(`${core}/internal-urls/proc-protocol.ts`);
    const uri = Object.assign(new URL(`proc://${job.id}`), { rawHost: job.id });
    const proc = await new ProcProtocolHandler().resolve(uri, { session: toolSession, agentRegistry: AgentRegistry.global() });
    assert.deepEqual(proc.details.proc.job.completion, job.completion);
    await assert.rejects(new ProcProtocolHandler().resolve(uri, { session: { ...toolSession, getAgentId: () => "Other" } }), /not found/i);
    const newer = { ...job, startTime: job.startTime + 1, completion: { agentId: job.agentId, startTime: job.startTime + 1, output: "new run" } };
    const staleView = snapshotJobs({ ...toolSession, asyncJobManager: {
      getJob: () => newer, isJobResultConsumed: () => false,
    } }, [job], { includeResults: true })[0];
    assert.deepEqual(staleView.completion, job.completion, "old row never reads replacement run evidence");
    assert.equal(buildAsyncResultBatchMessage([{ jobId: "unknown", result: "preview", durationMs: 1 }]).details.jobs[0].completion, undefined);
    await session.agent.waitForIdle();
    const receipt = await IrcBus.global().send({ from: "Main", to: job.agentId, body: "Return the fixture once more." });
    assert.notEqual(receipt.outcome, "failed");
    const wake = session.asyncJobManager.getAllJobs({ ownerId: "Main" }).find(candidate => candidate.id !== job.id && candidate.agentId === job.agentId);
    assert.ok(wake, "IRC wake registered a distinct collision-safe job");
    await within(wake.promise, "IRC re-yield completes");
    assert.deepEqual(JSON.parse(wake.completion.output), report);
    assert.equal(wake.completion.startTime, wake.startTime);
    assert.equal(wake.completion.agentId, job.agentId);
    assert.notEqual(wake.id, job.id);
    assert.equal(job.completion.startTime, job.startTime, "original completion is untouched");
    console.log(`SDK terminal evidence: ${job.completion.output.length} chars; exact identity; preview truncated; async/wait/proc preserve validation; other owner denied`);
  } finally {
    await session.settleAsyncWork();
    for (const ref of AgentRegistry.global().list()) if (ref.session && ref.session !== session) await ref.session.dispose();
    await session.dispose(); session.modelRegistry.authStorage.close(); closeModelCache(); local.stop(true);
  }
});
console.log(`RESULT: ${passed} pass, ${failed} fail`);
process.exitCode = failed ? 1 : 0;
