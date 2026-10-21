// Required observation of a long Main-owned background job (harness-policy mainLane.waitContract.requiredObservation).
// Actual AgentSession, bash async job, WaitTool, proc:// read and async delivery with jev-runtime loaded as an
// inline extension. Only the observation clock is virtual; the provider is a local scripted SSE server.
// OMP_CORE_PATCH_TARGET=<isolated patched core> bun run patches/core-job-observation-test.ts
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import { createJevRuntime } from "../agent/extensions/jev-runtime";

const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required; never test the live core");
const core = resolve(target, "src");
// The SDK keeps process-global stores under the first profile; a worker process releases them before cleanup.
if (process.argv[2] !== "--fixture-worker") {
  const root = mkdtempSync(join(tmpdir(), "omp-job-observation-"));
  let exitCode = 1;
  try {
    exitCode = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, "--fixture-worker", root], {
      env: process.env, stdout: "inherit", stderr: "inherit",
    }).exitCode;
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.exit(exitCode);
}
const fixtureRoot = process.argv[3]!;
// Module roots are runtime-selected by OMP_CORE_PATCH_TARGET so the test never imports the live installation.
const { createAgentSession } = await import(`${core}/sdk.ts`);
const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
const { Settings } = await import(`${core}/config/settings.ts`);
const { AgentRegistry } = await import(`${core}/registry/agent-registry.ts`);
const { IrcBus } = await import(`${core}/irc/bus.ts`);
const { closeModelCache } = await import(`${core}/../../pi-catalog/src/model-cache.ts`);
const { initializeExtensions } = await import(`${core}/modes/runtime-init.ts`);

let passed = 0, failed = 0;
async function check(name: string, body: () => Promise<void>) {
  try { await body(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error); }
}
async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: fixture deadline`)), 10_000);
  })]); } finally { clearTimeout(timer); }
}
function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}
class Clock {
  time = Date.now();
  jobs = new Map<object, { at: number; run: () => void }>();
  now = () => this.time;
  schedule = (run: () => void, delay: number) => {
    const key = {}; this.jobs.set(key, { at: this.time + delay, run });
    return () => { this.jobs.delete(key); };
  };
  advance(ms: number) {
    this.time += ms;
    for (;;) {
      const next = [...this.jobs].filter(([, job]) => job.at <= this.time).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) return;
      this.jobs.delete(next[0]); next[1].run();
    }
  }
}

const MIN = 60_000;
const encoder = new TextEncoder();
type ToolUse = { id: string; name: string; input: Record<string, unknown> };
function sse(call: ToolUse | undefined): Response {
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, data: { type: string; [key: string]: unknown }) =>
    controller.enqueue(encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`));
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    send(controller, { type: "message_start", message: { id: "observation", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } });
    send(controller, { type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: call.id, name: call.name, input: {} } : { type: "text", text: "" } });
    send(controller, { type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: "Fixture done." } });
    send(controller, { type: "content_block_stop", index: 0 });
    send(controller, { type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
    send(controller, { type: "message_stop" }); controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}

await check("actual SDK: due observation returns the wait, re-wait is refused until proc read, the job keeps running and delivers once", async () => {
  AgentRegistry.resetGlobalForTests(); IrcBus.resetGlobalForTests();
  const root = mkdtempSync(join(fixtureRoot, "scenario-")), profile = join(root, "profile");
  mkdirSync(profile);
  const gate = join(root, "gate").replace(/\\/g, "/");
  const clock = new Clock();
  const requests: string[] = [];
  let session: AgentSession | undefined;
  let jobId = "";
  // One scripted assistant step per provider request, in order.
  const script: Array<() => ToolUse | undefined> = [
    () => ({ id: "start-job", name: "bash", input: { command: `printf 'observation-step-1\\n'; while [ ! -f '${gate}' ]; do sleep 0.05; done; printf 'observation-step-2\\n'`, async: true } }),
    () => {
      jobId = session!.asyncJobManager!.getRunningJobs({ ownerId: "Main" }).find(job => job.type === "bash")!.id;
      return { id: "wait-1", name: "wait", input: {} };
    },
    () => ({ id: "wait-2", name: "wait", input: {} }),
    () => ({ id: "inspect", name: "read", input: { path: `proc://${jobId}` } }),
    () => ({ id: "wait-3", name: "wait", input: {} }),
    () => undefined,
  ];
  const server = Bun.serve({ port: 0, async fetch(request) {
    requests.push(await request.text());
    return sse(script[requests.length - 1]?.());
  } });
  writeFileSync(join(profile, "models.yml"), `providers:\n  observation-fixture:\n    baseUrl: http://127.0.0.1:${server.port}\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n`);
  try {
    const { session: active } = await createAgentSession({
      model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "observation-fixture", baseUrl: `http://127.0.0.1:${server.port}` },
      getApiKey: async () => "example", cwd: root, agentDir: profile, agentId: "Main", thinkingLevel: "off",
      settings: Settings.isolated({ "async.enabled": true, "launch.enabled": false }),
      disableExtensionDiscovery: true, enableLsp: false, enableMCP: false, skipPythonPreflight: true,
      toolNames: ["bash", "wait", "read"], requireYieldTool: false,
      extensions: [createJevRuntime({
        ledgerPath: join(root, "routing-ledger.jsonl"),
        findScopedSettings: () => undefined,
        resolveJudge: () => { throw new Error("no judge in this fixture"); },
        jobObservationClock: clock,
      })],
    });
    session = active;
    active.modelRegistry.authStorage.keys.setConfig("observation-fixture", "example");
    const extensionErrors: unknown[] = [];
    // The same runtime binding print and RPC modes use: real aside delivery, then session_start.
    await initializeExtensions(active, {
      reportSendError: (_action: string, error: Error) => { extensionErrors.push(error); },
      reportRuntimeError: (error: unknown) => { extensionErrors.push(error); },
    });
    const results = new Map<string, { isError: boolean; text: string }>();
    let waitStarts = 0;
    let inspectedStatus: unknown;
    active.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_start" && event.toolName === "wait") waitStarts++;
      if (event.type !== "tool_execution_end") return;
      const content = field(event.result, "content");
      const text = Array.isArray(content) ? content.map(block => String(field(block, "text") ?? "")).join("") : "";
      results.set(event.toolCallId, { isError: event.isError ?? false, text });
      if (event.toolCallId === "inspect" && !event.isError) {
        inspectedStatus = field(field(field(field(event.result, "details"), "proc"), "job"), "status");
        // The genuine observation saw the job; only now let it finish.
        writeFileSync(gate, "");
      }
    });
    const turn = active.prompt("OBSERVATION_FIXTURE");
    await within((async () => { while (!(waitStarts === 1 && clock.jobs.size === 1)) await Bun.sleep(5); })(), "first wait armed its observation timer");
    await Bun.sleep(300);
    assert.equal(results.has("wait-1"), false, "the wait keeps blocking before the due time");
    // core stamps job.startTime with the real clock; the one armed due must be exactly start + 5 minutes.
    const [armed] = [...clock.jobs.values()];
    assert.equal(armed!.at, active.asyncJobManager!.getJob(jobId)!.startTime + 5 * MIN, "first due is the 5-minute fallback from job start");
    clock.advance(armed!.at - clock.time - 1);
    await Bun.sleep(300);
    assert.equal(results.has("wait-1"), false, "one millisecond before the due the wait is still running");
    clock.advance(1);
    await within(turn, "scripted turn completes");
    await active.agent.waitForIdle();

    assert.equal(results.get("wait-1")?.text, "Wait interrupted by message.", "the due observation returned the wait");
    assert.ok(requests[2]!.includes("[JevRuntime:wait-observation-due]"), "the next model request carries the observation notice");
    assert.equal(results.get("wait-2")?.isError, true, "re-wait before inspection is refused");
    assert.ok(results.get("wait-2")!.text.includes("[JevRuntime:pre-wait-observation]"), results.get("wait-2")!.text);
    assert.equal(inspectedStatus, "running", "the proc read saw the job still running after the wake");
    assert.equal(results.get("wait-3")?.isError, false);
    const waitDelivered = results.get("wait-3")!.text.includes(jobId) && results.get("wait-3")!.text.includes("observation-step-2");
    const job = active.asyncJobManager!.getJob(jobId)!;
    assert.equal(job.status, "completed");
    assert.equal(active.asyncJobManager!.isJobResultConsumed(jobId), true);
    const asyncDeliveries = active.messages.filter((message: unknown) => field(message, "customType") === "async-result" && JSON.stringify(message).includes(jobId));
    // The job may finish between the proc read and wait-3. Either the wait or the normal async
    // delivery owns the result; requiring the wait to win makes a valid earlier delivery fail.
    assert.equal(Number(waitDelivered) + asyncDeliveries.length, 1, "the terminal result is delivered exactly once, by wait or async delivery");
    if (asyncDeliveries.length) {
      assert.ok(JSON.stringify(asyncDeliveries[0]).includes("observation-step-2"), "the async delivery carries the completed job output");
    }
    const count = requests.length;
    clock.advance(60 * MIN); await Bun.sleep(300);
    assert.equal(requests.length, count, "no late observation wake after completion");
    assert.equal(clock.jobs.size, 0);
    assert.deepEqual(extensionErrors, [], "the extension sends and handlers raised no error");
    console.log(`SDK observation: ${jobId} wait woke at virtual +5min, re-wait refused, proc read saw running, completion delivered once via ${waitDelivered ? "wait" : "async-result"} (${requests.length} requests)`);
  } finally {
    // Let the fixture job end even when an assertion failed, so settling never waits on its deadline.
    writeFileSync(gate, "");
    if (session) {
      session.agent.clearAllQueues();
      if (session.isStreaming) await session.abort();
      await session.settleAsyncWork();
      await session.dispose();
      session.modelRegistry.authStorage.close();
    }
    closeModelCache();
    server.stop(true);
  }
});

console.log(`RESULT: ${passed} pass, ${failed} fail`);
process.exitCode = failed ? 1 : 0;
