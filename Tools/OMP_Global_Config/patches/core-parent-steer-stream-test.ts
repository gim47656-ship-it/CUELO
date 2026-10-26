// Actual AgentSession + Anthropic HTTP/SSE regression for parent-only request preemption.
// OMP_CORE_PATCH_TARGET=<isolated SDK> bun --no-install patches/core-parent-steer-stream-test.ts
// The fixture owns its server and temporary profile; no provider credentials or paid requests.
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const core = resolve(target, "src");
// SDK process-global stores outlive a session. The parent owns fixture files and
// removes them only after the worker exits, when Windows has released every handle.
if (process.argv[2] !== "--fixture-worker") {
  const root = mkdtempSync(join(tmpdir(), "omp-parent-stream-suite-"));
  let exitCode = 1;
  try {
    exitCode = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, "--fixture-worker", root], {
      env: process.env, stdout: "inherit", stderr: "inherit",
    }).exitCode;
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.exit(exitCode);
}
const fixtureRoot = process.argv[3]!;
// Runtime-selected SDK root is required for isolated patched/unpatched validation.
const { createAgentSession } = await import(`${core}/sdk.ts`);
const { AgentRegistry } = await import(`${core}/registry/agent-registry.ts`);
const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
const { closeModelCache } = await import(`${core}/../../pi-catalog/src/model-cache.ts`);
const encoder = new TextEncoder();
let failures = 0;
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}`, error); }
}
async function within<T>(promise: Promise<T>, label: string, milliseconds = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}: fixture deadline`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
const count = (body: string, text: string) => body.split(text).length - 1;
const turnStart = (id: string) => ({
  type: "message_start", message: { id, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } },
});
interface WireCase {
  mode: "reasoning" | "tool";
  requests: string[];
  controller?: ReadableStreamDefaultController<Uint8Array>;
  cancelled: number;
  requestAt?: number;
  streamAt?: number;
  finishFirst: () => void;
}
let current: WireCase;
function send(controller: ReadableStreamDefaultController<Uint8Array>, frame: { type: string; [key: string]: unknown }) {
  controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`));
}
function end(controller: ReadableStreamDefaultController<Uint8Array>, reason = "end_turn") {
  send(controller, { type: "message_delta", delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 1 } });
  send(controller, { type: "message_stop" });
  controller.close();
}
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    assert.equal(new URL(request.url).pathname, "/v1/messages");
    const state = current;
    state.requestAt ??= performance.now();
    state.requests.push(await request.text());
    const first = state.requests.length === 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        state.streamAt ??= performance.now();
        send(controller, turnStart(`fixture-${state.requests.length}`));
        if (!first) {
          send(controller, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          send(controller, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PARENT_RESUMED" } });
          send(controller, { type: "content_block_stop", index: 0 });
          end(controller);
          return;
        }
        state.controller = controller;
        if (state.mode === "tool") {
          send(controller, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_fixture", name: "parent_probe", input: {} } });
          send(controller, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
          state.finishFirst = () => {
            send(controller, { type: "content_block_stop", index: 0 });
            end(controller, "tool_use");
          };
        } else {
          send(controller, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
          send(controller, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "LEGITIMATE_REASONING" } });
          state.finishFirst = () => {
            send(controller, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fixture_signed_reasoning" } });
            send(controller, { type: "content_block_stop", index: 0 });
            send(controller, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } });
            send(controller, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "NATURAL_COMPLETION" } });
            send(controller, { type: "content_block_stop", index: 1 });
            end(controller);
          };
        }
      },
      cancel() { state.cancelled++; },
    }), { headers: { "content-type": "text/event-stream" } });
  },
});

let sequence = 0;
interface ScenarioContext {
  state: WireCase;
  session: AgentSession;
  agent: Agent;
  done: Promise<void>;
  deliver: (from: string, body: string, wakeRelay?: boolean) => Promise<"injected" | "woken">;
  parent: string;
  toolEntered: PromiseWithResolvers<void>;
  toolRelease: PromiseWithResolvers<void>;
  toolRuns: () => number;
  toolAborts: () => number;
  agentEnds: () => number;
  assistantEnds: () => number;
}
async function scenario(mode: WireCase["mode"], run: (context: ScenarioContext) => Promise<void>) {
  sequence++;
  const child = `ParentStreamChild${sequence}`;
  const parent = `ParentStreamParent${sequence}`;
  const workdir = mkdtempSync(join(fixtureRoot, "cwd-"));
  const agentDir = mkdtempSync(join(fixtureRoot, "profile-"));
  current = { mode, requests: [], cancelled: 0, finishFirst: () => { throw new Error("First response not ready"); } };
  const state = current;
  writeFileSync(join(agentDir, "models.yml"), `providers:\n  parent-stream-fixture:\n    baseUrl: http://127.0.0.1:${server.port}\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n        reasoning: true\n        thinking:\n          mode: adaptive\n          efforts: [low, medium, high, xhigh, max]\n          defaultLevel: low\n`);
  writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: parent-stream-fixture/claude-opus-5-5\n");
  const ready = Promise.withResolvers<void>();
  const toolEntered = Promise.withResolvers<void>();
  const toolRelease = Promise.withResolvers<void>();
  let toolRuns = 0;
  let toolAborts = 0;
  const created = await createAgentSession({
    model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "parent-stream-fixture", baseUrl: `http://127.0.0.1:${server.port}` },
    getApiKey: async () => "example",
    cwd: workdir, agentDir, thinkingLevel: "low", disableExtensionDiscovery: true,
    enableLsp: false, enableMCP: false, skipPythonPreflight: true,
    toolNames: ["parent_probe"], restrictToolNames: true, allowRestrictedCustomTools: true,
    requireYieldTool: false,
    customTools: [{ name: "parent_probe", label: "Parent probe", description: "Local regression tool", parameters: { type: "object", properties: {} },
      async execute(_id: string, _params: unknown, _onUpdate: unknown, _ctx: unknown, signal?: AbortSignal) {
        toolRuns++;
        signal?.addEventListener("abort", () => toolAborts++);
        toolEntered.resolve();
        await toolRelease.promise;
        return { content: [{ type: "text", text: "TOOL_RESULT_ONCE" }], details: {} };
      },
    }],
  });
  const session: AgentSession = created.session;
  // AgentSession preflight uses ModelRegistry, independently of the request resolver.
  // This config-only dummy key belongs to the temporary profile, never the user's auth DB.
  session.modelRegistry.authStorage.keys.setConfig("parent-stream-fixture", "example");
  const agent = session.agent;
  // Both parent instructions must reach the same post-tool request in this fixture.
  agent.setSteeringMode("all");
  AgentRegistry.global().register({ id: child, kind: "sub", parentId: parent, session });
  let agentEnds = 0;
  let assistantEnds = 0;
  const eventCounts: Record<string, number> = {};
  const unsubscribe = agent.subscribe(event => {
    eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    if (event.type === "message_update" && event.message.role === "assistant" && event.message.content.some(block => block.type === "thinking" || block.type === "toolCall")) ready.resolve();
    if (event.type === "agent_end") agentEnds++;
    if (event.type === "message_end" && event.message?.role === "assistant") assistantEnds++;
  });
  const promptAt = performance.now();
  const cpuStart = process.cpuUsage();
  const done = session.prompt("Keep working on this local fixture").then(() => agent.waitForIdle());
  void done.catch(error => ready.reject(error));
  const deliver = (from: string, body: string, wakeRelay = false) => session.deliverIrcMessage({ id: `${child}-${body}`, from, to: child, body, ts: Date.now(), ...(wakeRelay ? { wakeRelay: true } : {}) });
  try {
    try { await within(ready.promise, "first real SSE content"); }
    catch (error) {
      // Failure path only. The same deadline still decides pass or fail; this says which phase never happened
      // (no request, request without stream, stream without events) and whether the process was busy or waiting.
      const cpu = process.cpuUsage(cpuStart);
      // A phase that never happened has no timestamp: NaN serializes as null.
      console.error("DIAG first-SSE wait failed", JSON.stringify({
        scenario: sequence, mode, waitedMs: Math.round(performance.now() - promptAt),
        requestsSeen: state.requests.length, requestAtMs: Math.round((state.requestAt ?? Number.NaN) - promptAt),
        streamOpenedAtMs: Math.round((state.streamAt ?? Number.NaN) - promptAt),
        streaming: session.isStreaming, events: eventCounts, messages: agent.state.messages.map(m => m.role),
        cpuUserMs: Math.round(cpu.user / 1000), cpuSystemMs: Math.round(cpu.system / 1000),
        rssMb: Math.round(process.memoryUsage().rss / 1048576), loadavg: loadavg().map(n => Number(n.toFixed(2))), cpuCount: cpus().length,
        error: String(error),
      }));
      throw error;
    }
    await run({ state, session, agent, done, deliver, parent, toolEntered, toolRelease, toolRuns: () => toolRuns, toolAborts: () => toolAborts, agentEnds: () => agentEnds, assistantEnds: () => assistantEnds });
  } finally {
    agent.clearAllQueues();
    toolRelease.resolve();
    if (session.isStreaming) await session.abort();
    await done.catch(() => {});
    unsubscribe();
    await session.dispose();
    // These stores belong to this fixture, not to a shared application runtime.
    session.modelRegistry.authStorage.close();
    closeModelCache();
  }
}

try {
  await check("true parent non-wake IRC replaces silent reasoning request in the same run", () => scenario("reasoning", async (c) => {
    assert.equal(c.agent.state.isStreaming, true);
    await c.deliver(c.parent, "AUTHORITATIVE_PARENT_STEER");
    await within(c.done, "parent response resumes");
    assert.equal(c.state.requests.length, 2);
    assert.equal(count(c.state.requests[1], "AUTHORITATIVE_PARENT_STEER"), 1);
    assert.equal(count(c.state.requests[1], "LEGITIMATE_REASONING"), 0);
    assert.equal(c.agentEnds(), 1);
    assert.equal(c.assistantEnds(), 1);
    const assistants = c.agent.state.messages.filter(m => m.role === "assistant");
    assert.deepEqual(assistants.map(m => m.stopReason), ["stop"]);
    console.log("WIRE parent: requests=2 parent occurrences=1 discarded reasoning=0 agent_end=1 assistant_end=1");
  }));
  await check("peer, wake relay, unmarked agent and synthetic steering do not abort legitimate reasoning", () => scenario("reasoning", async (c) => {
    await c.deliver("ParentStreamPeer", "PEER_REPORT");
    await c.deliver(c.parent, "PARENT_WAKE_RELAY", true);
    c.agent.steer({ role: "user", content: "UNMARKED_AGENT", attribution: "agent", timestamp: Date.now(), steering: true });
    c.agent.steer({ role: "user", content: "SYNTHETIC_USER", attribution: "user", synthetic: true, timestamp: Date.now(), steering: true });
    // A deterministic event-loop barrier, not a product timeout policy.
    await Bun.sleep(30);
    assert.equal(c.state.requests.length, 1);
    assert.equal(c.agent.state.isStreaming, true);
    c.state.finishFirst();
    await within(c.done, "natural reasoning completion");
    assert.equal(c.agent.state.messages.filter(m => m.role === "assistant")[0].stopReason, "stop");
    assert.ok(JSON.stringify(c.agent.state.messages).includes("NATURAL_COMPLETION"));
    assert.equal(c.agentEnds(), 1);
    console.log("WIRE exclusions: original response preserved through explicit natural completion");
  }));
  await check("parent steering does not abort streamed or executing tools and tool executes once", () => scenario("tool", async (c) => {
    await c.deliver(c.parent, "PARENT_DURING_TOOL_STREAM");
    await Bun.sleep(30);
    assert.equal(c.state.requests.length, 1);
    c.state.finishFirst();
    await within(c.toolEntered.promise, "tool entered");
    await c.deliver(c.parent, "PARENT_DURING_TOOL_EXECUTION");
    assert.equal(c.toolRuns(), 1);
    assert.equal(c.toolAborts(), 0);
    c.toolRelease.resolve();
    await within(c.done, "tool then parent response");
    assert.equal(c.toolRuns(), 1);
    assert.equal(c.toolAborts(), 0);
    assert.equal(c.state.requests.length, 2);
    assert.equal(count(c.state.requests[1], "TOOL_RESULT_ONCE"), 1);
    assert.equal(count(c.state.requests[1], "PARENT_DURING_TOOL_STREAM"), 1);
    assert.equal(count(c.state.requests[1], "PARENT_DURING_TOOL_EXECUTION"), 1);
    assert.equal(c.agentEnds(), 1);
    console.log("WIRE tools: executions=1 tool aborts=0 requests=2 result/each parent occurrence=1");
  }));
  await check("explicit cancellation settles the silent request once", () => scenario("reasoning", async (c) => {
    await c.session.abort();
    await within(c.done, "cancel settles");
    assert.equal(c.agentEnds(), 1);
    assert.equal(c.state.requests.length, 1);
    assert.equal(c.agent.state.messages.filter(m => m.role === "assistant" && m.stopReason === "aborted").length, 1);
    console.log("WIRE cancellation: requests=1 aborted assistant=1 agent_end=1");
  }));
} finally { server.stop(true); }
console.log(`RESULT: ${4 - failures} pass, ${failures} fail`);
process.exit(failures === 0 ? 0 : 1);
