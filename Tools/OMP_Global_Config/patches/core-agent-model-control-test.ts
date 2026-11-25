// agent://<id>/model and /effort writes stay rejected (2026-11-26 decision on core 19.2.1): a running
// agent's model and effort change only through `task` model selection. Real AgentSession + local SSE.
// OMP_CORE_PATCH_TARGET=<source SDK> bun --no-install patches/core-agent-model-control-test.ts
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const target = process.env.OMP_CORE_PATCH_TARGET;
if (!target) throw new Error("OMP_CORE_PATCH_TARGET is required");
const core = resolve(target, "src");
// The SDK keeps process-global stores under the first profile; a worker process owns them.
if (process.argv[2] !== "--fixture-worker") {
  const root = mkdtempSync(join(tmpdir(), "omp-agent-model-control-"));
  let exitCode = 1;
  try {
    exitCode = Bun.spawnSync([process.execPath, ...process.execArgv, import.meta.path, "--fixture-worker", root], {
      env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: join(root, "profile") }, stdout: "inherit", stderr: "inherit",
    }).exitCode;
  } finally { rmSync(root, { recursive: true, force: true }); }
  process.exit(exitCode);
}
const root = process.argv[3]!;
// 19.2.1 added the model-control branch; older cores reject the path as a JSON-path suffix.
const controls = (await Bun.file(`${core}/internal-urls/agent-protocol.ts`).text()).includes("function controlTarget(");
// The core under test is chosen at run time (OMP_CORE_PATCH_TARGET), so its modules load dynamically.
const { createAgentSession } = await import(`${core}/sdk.ts`);
const { Settings } = await import(`${core}/config/settings.ts`);
const { AgentRegistry } = await import(`${core}/registry/agent-registry.ts`);
const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
const { closeModelCache } = await import(`${core}/../../pi-catalog/src/model-cache.ts`);

const writes = [
  { id: "effort-write", path: "agent://Main/effort", content: "high" },
  { id: "model-write", path: "agent://Main/model", content: "task" },
];
const bodies: string[] = [];
const encoder = new TextEncoder();
const server = Bun.serve({ port: 0, async fetch(request) {
  const body = await request.text();
  bodies.push(body);
  const tool = writes.find(write => !body.includes(`"tool_use_id":"${write.id}"`));
  const sse = (data: Record<string, unknown>) => encoder.encode(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(sse({ type: "message_start", message: { id: `m${bodies.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }));
    if (tool) {
      controller.enqueue(sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: tool.id, name: "write", input: {} } }));
      controller.enqueue(sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: tool.path, content: tool.content }) } }));
    } else {
      controller.enqueue(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
      controller.enqueue(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }));
    }
    controller.enqueue(sse({ type: "content_block_stop", index: 0 }));
    controller.enqueue(sse({ type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }));
    controller.enqueue(sse({ type: "message_stop" }));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
} });

const profile = join(root, "profile");
mkdirSync(profile, { recursive: true });
writeFileSync(join(profile, "models.yml"), `providers:\n  control-fixture:\n    baseUrl: http://127.0.0.1:${server.port}\n    api: anthropic-messages\n    apiKey: example\n    models:\n      - id: claude-opus-5-5\n`);
AgentRegistry.resetGlobalForTests();
const { session } = await createAgentSession({
  model: { ...getBundledModel("anthropic", "claude-opus-5-5"), provider: "control-fixture", baseUrl: `http://127.0.0.1:${server.port}` },
  getApiKey: async () => "example", cwd: root, agentDir: profile, thinkingLevel: "low", disableExtensionDiscovery: true,
  settings: Settings.isolated({ "launch.enabled": false }), agentId: "Main", enableIrc: true,
  enableLsp: false, enableMCP: false, skipPythonPreflight: true, toolNames: ["write"], requireYieldTool: false,
});
try {
  session.modelRegistry.authStorage.keys.setConfig("control-fixture", "example");
  AgentRegistry.global().register({ id: "Main", displayName: "Main", kind: "main", session, status: "idle" });
  let applied = 0;
  const apply = session.applyAgentModelChange;
  if (typeof apply === "function") session.applyAgentModelChange = (...args: unknown[]) => { applied++; return apply.apply(session, args); };
  const results = new Map<string, { isError: boolean; text: string }>();
  session.subscribe((event: { type: string; toolName?: string; toolCallId?: string; isError?: boolean; result?: unknown }) => {
    if (event.type !== "tool_execution_end" || event.toolName !== "write" || !event.toolCallId) return;
    const result = event.result;
    const content = result && typeof result === "object" && "content" in result && Array.isArray(result.content) ? result.content : [];
    const text = content.map((part: unknown) => (part && typeof part === "object" && "text" in part ? String(part.text) : "")).join("\n");
    results.set(event.toolCallId, { isError: event.isError === true, text });
  });
  const before = { model: session.model?.id, effort: session.thinkingLevel };
  await session.prompt("Change your own model and effort.");
  await session.agent.waitForIdle();

  for (const write of writes) {
    const result = results.get(write.id);
    assert.ok(result, `${write.path}: write tool ran`);
    assert.equal(result.isError, true, `${write.path} must be rejected: ${result.text}`);
    if (controls) assert.match(result.text, /task model selection/, `${write.path} names the task route: ${result.text}`);
  }
  assert.equal(applied, 0, "applyAgentModelChange is never reached");
  assert.deepEqual({ model: session.model?.id, effort: session.thinkingLevel }, before, "model and effort unchanged");
  assert.ok(!bodies[0]!.includes("write agent://<id>/model with a permitted task agent kind"), "prompt does not advertise model writes");
  console.log(`PASS agent:// model/effort writes rejected (${controls ? "19.2.1 controls" : "pre-19.2.1 path"}); model=${before.model} effort=${before.effort}`);
} finally {
  await session.dispose();
  session.modelRegistry.authStorage.close();
  closeModelCache();
  server.stop(true);
}
