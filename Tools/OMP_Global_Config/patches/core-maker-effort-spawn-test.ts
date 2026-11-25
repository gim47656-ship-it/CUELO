// OMP_CORE_PATCH_TARGET=<isolated-patched-core> bun run patches/core-maker-effort-spawn-test.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentSession as Session, CreateAgentSessionResult, ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AgentRef } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { CustomEntry, FileEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import type { Context, Model } from "@oh-my-pi/pi-ai";
import { decideAutoEffort, parseAutoEffortConfig } from "../agent/extensions/lib/auto-effort-policy";

const core = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(core, "an isolated core target is required");
const src = resolve(core, "src");
const packages = resolve(core, "..");
const root = mkdtempSync(join(tmpdir(), "cuelo-routed-maker-"));
const profile = join(root, "profile");
mkdirSync(join(profile, "agents"), { recursive: true });
writeFileSync(join(profile, "agents", "maker.md"), `---\nname: maker\ndescription: Maker fixture\ntools: [read]\nmodel: '@implSonnet'\nthinking-level: auto\n---\nDo the assignment.\n`);
process.env.PI_CODING_AGENT_DIR = profile;
// Import the patched package selected by the harness, not the checkout's SDK.
const { setAgentDir } = await import(`${packages}/pi-utils/src/dirs.ts`);
setAgentDir(profile);
const { createAgentSession } = await import(`${src}/sdk.ts`);
const { Settings } = await import(`${src}/config/settings.ts`);
const { AgentRegistry } = await import(`${src}/registry/agent-registry.ts`);
const { AgentSession }: { AgentSession: abstract new (...args: never[]) => Session } = await import(`${src}/session/agent-session.ts`);
const { AgentLifecycleManager } = await import(`${src}/registry/agent-lifecycle.ts`);
const { revivePersistedSubagent } = await import(`${src}/task/persisted-revive.ts`);
const { SessionManager } = await import(`${src}/session/session-manager.ts`);
const { initializeExtensions } = await import(`${src}/modes/runtime-init.ts`);
const { createAssistantMessageEventStream } = await import(`${packages}/pi-ai/src/utils/event-stream.ts`);
const { resolveModelServiceTier } = await import(`${packages}/pi-ai/src/types.ts`);
const { getBundledModel } = await import(`${packages}/pi-catalog/src/models.ts`);
const { buildTransformedCodexRequestBody } = await import(`${packages}/pi-ai/src/providers/openai-codex-responses.ts`);
const policyKey = Symbol.for("cuelo.autoThinkingPolicy");
const rangeKey = Symbol.for("cuelo.makerEffort");
// The controller test covers the production thresholds. Use four here to
// cross a milestone with actual executor events split over a cold revival.
const effortConfig = parseAutoEffortConfig("autoEffort:\n  escalateChildTools: 4\n");
Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, effortConfig));
const customData = (entries: readonly FileEntry[], type: string) =>
  entries.findLast((entry): entry is CustomEntry => entry.type === "custom" && entry.customType === type)?.data;

const SOL = "gpt-6.2-sol", ASTRA = "gpt-6.2-astra";
const HARNESS_MODEL = "claude-opus-5-5";
const requests: Record<string, unknown>[] = [];
let hardSolReads = 0;
writeFileSync(join(root, "sample.txt"), "Maker effort smoke fixture.\n");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  if (request.method === "GET") return Response.json({ data: [] });
  const body = await request.json() as Record<string, unknown>;
  requests.push(body);
  const messages = JSON.stringify(body.messages);
  const readCount = messages.includes("Implement fixture HARD Sol")
    ? hardSolReads === 0 ? 3 : hardSolReads === 3 && messages.includes("Continue this shared assignment.") ? 1 : 0
    : 0;
  const firstRead = hardSolReads;
  hardSolReads += readCount;
  const textFrames = [
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Fixture complete." } },
    { type: "content_block_stop", index: 0 },
  ];
  const readFrames = Array.from({ length: readCount }, (_, index) => [
    { type: "content_block_start", index, content_block: { type: "tool_use", id: `read-fixture-${firstRead + index}`, name: "read", input: {} } },
    { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify({ path: "sample.txt" }) } },
    { type: "content_block_stop", index },
  ]).flat();
  const frames = [
    { type: "message_start", message: { id: "maker-effort", type: "message", role: "assistant", model: HARNESS_MODEL, content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    ...(readCount ? readFrames : textFrames),
    { type: "message_delta", delta: { stop_reason: readCount ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
} });
const fixtureUrl = `http://127.0.0.1:${server.port}`;
writeFileSync(join(profile, "models.yml"), `providers:\n  openai:\n    baseUrl: ${fixtureUrl}\n    api: anthropic-messages\n    apiKey: example\n    models:\n${[SOL, ASTRA].map(id => `      - id: ${id}\n        reasoning: true\n        thinking: { mode: effort, efforts: [low, medium, high, xhigh, max], defaultLevel: medium }`).join("\n")}\n`);
const settings = Settings.isolated({
  defaultThinkingLevel: "auto", modelRoles: { implSonnet: `openai/${SOL}:auto` },
  "async.enabled": false, "task.batch": true, "task.structured": false, "task.maxEffort": "xhigh",
  "task.agentServiceTierOverrides": { maker: { openai: "priority" } },
  "task.isolation.enabled": false, "launch.enabled": false,
});
const task = {
  context: "maker effort smoke",
  tasks: [
    // A profile name only becomes a usable model through the routing hook's revision.
    { name: "HardSol", agent: "maker", task: "Implement fixture HARD Sol", model: "NORMAL_SOL", solutionSpace: "fixed contract" },
    { name: "BoundedSol", agent: "maker", task: "Implement fixture bounded Sol", model: `openai/${SOL}:auto`, solutionSpace: "bounded choice" },
    { name: "Astra", agent: "maker", task: "Implement fixture Astra", model: `openai/${ASTRA}:auto`, solutionSpace: "open design" },
  ],
};
let routedTask = "";
const parentHeads: string[] = [];
const runtimeErrors: unknown[] = [];
const rootModel = { ...getBundledModel("anthropic", HARNESS_MODEL), provider: "fixture-parent", baseUrl: fixtureUrl };
let parent: CreateAgentSessionResult | undefined;
try {
  const active: CreateAgentSessionResult = await createAgentSession({
    cwd: root, agentDir: profile, agentId: "Main", model: rootModel, getApiKey: () => "example", settings,
    sessionManager: SessionManager.create(root, join(root, "sessions")), thinkingLevel: "off", spawns: "maker",
    enableLsp: false, enableMCP: false, enableIrc: false, skipPythonPreflight: true,
    toolNames: ["task"], skills: [], rules: [], contextFiles: [], disableExtensionDiscovery: true,
    extensions: [
      (pi: ExtensionAPI) => pi.on("tool_call", event => {
        if (event.toolName !== "task") return;
        assert.match(JSON.stringify(event.input), /"model":"NORMAL_SOL"/);
        // Routing resolves the profile name to the canonical model and attaches each range
        // before returning its revision, as beforeTask does.
        const items = (event.input.tasks as typeof task.tasks).map(item => item.model === "NORMAL_SOL" ? { ...item, model: `openai/${SOL}:auto` } : item);
        items.forEach((item, i) => Reflect.set(item, rangeKey, { start: i === 0 ? "medium" : "high", max: "xhigh" }));
        return { input: { ...event.input, tasks: items } };
      }),
      (pi: ExtensionAPI) => pi.on("tool_call", event => {
        if (event.toolName !== "task") return;
        // A later guard rebuilds the task from the input it receives; the routed model and range must survive.
        routedTask = JSON.stringify(event.input);
        const items = event.input.tasks as typeof task.tasks;
        assert.ok(items.every(item => Reflect.has(item, rangeKey)), "the guard receives routing's ranged items");
        return { input: { ...event.input, tasks: items.map(item => ({ ...item })) } };
      }),
    ],
  });
  parent = active;
  const { session } = active;
  session.modelRegistry.authStorage.keys.setConfig("fixture-parent", "example");
  let sent = false;
  session.agent.streamFn = ((model: Model, context: Context) => {
    parentHeads.push(JSON.stringify({ system: context.systemPrompt, tools: context.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }));
    const stream = createAssistantMessageEventStream();
    const call = sent ? undefined : { type: "toolCall" as const, id: "task-routed-makers", name: "task", arguments: task };
    sent = true;
    const message = {
      role: "assistant", content: call ? [call] : [{ type: "text", text: "Fixture complete." }],
      api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (call) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      stream.end(message);
    });
    return stream;
  }) as typeof session.agent.streamFn;
  await initializeExtensions(session, { reportSendError: (_action: string, error: unknown) => runtimeErrors.push(error), reportRuntimeError: (error: unknown) => runtimeErrors.push(error) });
  await session.prompt("Dispatch the three fixture Makers.");
  assert.deepEqual(runtimeErrors, []);
  const taskCall = session.messages.flatMap(m => m.role === "assistant" ? m.content : []).find(block => block.type === "toolCall" && block.id === "task-routed-makers");
  assert.ok(taskCall && taskCall.type === "toolCall");
  assert.equal(JSON.stringify(taskCall.arguments), routedTask, "only the routed model, never admission data, reaches serialized task arguments");
  assert.equal(parentHeads.length, 2);
  assert.equal(parentHeads[1], parentHeads[0], "the same task schema, tool descriptions and Main system prompt are replayed");
  assert.doesNotMatch(parentHeads[0]!, /cuelo[.-]maker[.-]?effort|startEffort|maxEffort/i);
  const result = session.messages.find(m => m.role === "toolResult" && m.toolCallId === "task-routed-makers");
  assert.ok(result && result.role === "toolResult" && !result.isError, JSON.stringify(result));
  assert.equal(requests.length, 4, "three children start; HardSol makes one follow-up after reading");
  const registry = AgentRegistry.global();
  const lifecycle = AgentLifecycleManager.global();
  for (const [index, item] of task.tasks.entries()) {
    const refs: AgentRef[] = registry.list();
    const ref = refs.find(row => row.parentId === "Main" && row.id.includes(item.name));
    assert.ok(ref?.session instanceof AgentSession && ref.sessionFile, `missing child ${item.name}: ${refs.map(row => row.id).join(", ")}`);
    const expected = { start: index === 0 ? "medium" : "high", max: "xhigh" };
    const entries = ref.session.sessionManager.getEntries();
    if (index === 0) {
      const starts = entries.filter(entry => entry.type === "custom" && entry.customType === "tool_execution_start");
      const results = entries.filter(entry => entry.type === "message" && entry.message.role === "toolResult" && !entry.message.isError);
      assert.equal(starts.length, 3);
      assert.equal(results.length, 3);
      console.log(`HardSol persisted read tools: ${starts.length} tool_execution_start entries; ${results.length} successful toolResult messages`);
    }
    assert.deepEqual(customData(entries, "cuelo-maker-effort"), expected);
    const decision = customData(entries, "auto-thinking-decision") as { applied?: string } | undefined;
    assert.equal(decision?.applied, expected.start);
    const tiers = ref.session.serviceTierByFamily;
    assert.equal(tiers?.openai, "priority");
    // GPT-6.2 is discovered online, not bundled. The offline row represents
    // the same Codex route with no explicit service-tier advertisement.
    const codex = { ...getBundledModel("openai-codex", "gpt-5.6-sol"), id: item.model.includes(ASTRA) ? ASTRA : SOL, serviceTiers: undefined };
    const body = await buildTransformedCodexRequestBody(codex, { messages: [{ role: "user", content: "tier check", timestamp: 0 }] }, { serviceTier: resolveModelServiceTier(tiers, codex) });
    assert.equal(body.service_tier, "priority", item.name);
    console.log(`${item.name}: started ${expected.start}, max ${expected.max}, Codex wire tier ${body.service_tier}`);
    await lifecycle.park(ref.id);
    const parked = registry.get(ref.id)!;
    assert.equal(parked.session, null);
    const revived = await revivePersistedSubagent({
      id: ref.id, displayName: ref.displayName, parentId: ref.parentId, sessionFile: ref.sessionFile,
      taskDepth: 1, root: session, rootAgentId: "Main", costGate: session.costGate,
      asyncJobManager: session.asyncJobManager, artifactManager: session.sessionManager.getArtifactManager() ?? undefined,
      preparedExtensions: session.preparedExtensions, authStorage: session.modelRegistry.authStorage,
      modelRegistry: session.modelRegistry, settings, enableLsp: false, eventBus: active.eventBus,
      subagentEventBus: active.subagentEventBus,
    }, parked);
    try {
      assert.equal(revived.configuredThinkingLevel(), "auto");
      await revived.prompt("Continue this shared assignment.", { attribution: "agent" });
      const resumed: FileEntry[] = revived.sessionManager.getEntries();
      const latest = customData(resumed, "auto-thinking-decision") as {
        floor?: string; ceiling?: string; counters?: { tools: number; errors: number };
      } | undefined;
      assert.equal(latest?.floor, expected.start);
      assert.equal(latest?.ceiling, expected.max);
      if (index === 0) {
        assert.deepEqual(latest?.counters, { tools: 4, errors: 0 });
        assert.equal(revived.thinkingLevel, "high");
        console.log("HardSol cold revive crossed the fixture milestone on its fourth real read");
      } else {
        assert.equal(revived.thinkingLevel, expected.start);
      }
      assert.equal(revived.serviceTierByFamily.openai, "priority");
      console.log(`${item.name}: cold revive restored Auto ${latest?.floor}/${latest?.ceiling} and Fast`);
    } finally { await revived.dispose(); }
  }
  assert.equal(requests.length, 8, "all revived sessions requested; HardSol also continued after its fourth read");
  for (const request of requests) assert.doesNotMatch(JSON.stringify(request), /cuelo[.-]maker[.-]?effort|startEffort|maxEffort/i);
  console.log("Admission, parallel child startup, persisted revival, Fast, and request-head isolation verified.");
} finally {
  if (parent) await parent.session.dispose();
  server.stop(true);
  Reflect.deleteProperty(globalThis, policyKey);
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
