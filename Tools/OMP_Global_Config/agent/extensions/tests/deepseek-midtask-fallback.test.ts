import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { join } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { cfgRetryFallbackChains, cfgRetryFallbackRevertPolicy } from "@oh-my-pi/pi-coding-agent/session/settings";
import { runSubagentRunRequest, subagentRunRequest } from "@oh-my-pi/pi-coding-agent/task/executor";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { createJevRuntime } from "../jev-runtime";
import { createRoutingLedger } from "../lib/routing-ledger";
import { SUBAGENT_EVENT_CHANNEL } from "../lib/start-reject-fallback";

const DEEPSEEK = "hive/deepseek-ai/deepseek-v4.1-flash-1017";
const SONNET = "anthropic/claude-sonnet-5-5";
const OTHER_SONNET = "anthropic/claude-sonnet-5-4";
// Synthetic provider errors: the production classifier, not an injected verdict, decides which is a usage limit.
const LIMIT = '429 {"error":{"code":"insufficient_quota","message":"Usage limit reached"}}';
const SONNET_LIMIT = '429 {"error":{"code":"insufficient_quota","message":"Sonnet usage limit reached"}}';
const TRANSIENT = "429 Too many requests per minute; retry-after-ms: 1";
const TASK = "Write the marker and finish this assignment.";
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

const edit = (id: string, path: string) => ({ type: "toolCall" as const, id, name: "write", arguments: { path, content: id } });
const done = (text: string) => ({ type: "text" as const, text });
type Step = { error: string } | Extract<AssistantMessage["content"][number], { type: "text" | "toolCall" }>;
type Request = { model: string; messages: Context["messages"] };

async function runScenario({ agent = "maker", primary = DEEPSEEK, sonnet = `${SONNET}:auto`, steps, secondPrompt = false,
  sourceEffort, competingChain = false, suppressSonnet = false, sonnetUnavailableAtDispatch = false }: {
  agent?: string;
  primary?: string;
  sonnet?: string;
  steps: Step[];
  secondPrompt?: boolean;
  sourceEffort?: "high";
  competingChain?: boolean;
  suppressSonnet?: boolean;
  sonnetUnavailableAtDispatch?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), "deepseek-midtask-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  const auth = await AuthStorage.create(join(agentDir, "agent.db"));
  const registry = new ModelRegistry(auth, join(agentDir, "models.yml"));
  const sessions = SessionManager.create(root, join(root, "sessions"));
  const bus = new EventBus();
  const ledgerPath = join(agentDir, "routing-ledger.jsonl");
  const modelRoles = { implDeepSeek: `${DEEPSEEK}:auto`, ...(sonnet && { implSonnet: sonnet }) };
  const fallbackChains = {
    [DEEPSEEK]: sonnetUnavailableAtDispatch ? [OTHER_SONNET] : [],
    [SONNET]: [DEEPSEEK], [OTHER_SONNET]: [DEEPSEEK],
    ...(sourceEffort && competingChain && { [`${DEEPSEEK}:${sourceEffort}`]: [OTHER_SONNET] }),
  };
  const settings = Settings.isolated({
    modelRoles,
    "retry.fallbackOn": "usage-limit", "retry.fallbackChains": fallbackChains,
    "retry.maxRetries": 1, "retry.baseDelayMs": 1, "retry.maxDelayMs": 10,
    "retry.fallbackRevertPolicy": "cooldown-expiry", "retry.usageAwareFallback": suppressSonnet,
    "tools.approvalMode": "yolo",
  });
  const calls: Request[] = [];
  const events: Array<{ id: string; event: { type: string; [key: string]: unknown } }> = [];
  const notices: string[] = [];
  const runtimeErrors: unknown[] = [];
  const sends: Promise<unknown>[] = [];
  const runtime = createJevRuntime({ ledgerPath, resolveJudge: () => { throw new Error("No judge expected"); } });
  bus.on(SUBAGENT_EVENT_CHANNEL, payload => {
    const frame = payload as typeof events[number];
    events.push(frame);
    if (secondPrompt && frame.event.type === "retry_fallback_applied") {
      // Simulate the failed route's cooldown expiring before the next step.
      const from = String(frame.event.from);
      expect(registry.isSelectorSuppressed(from)).toBe(true);
      registry.suppressSelector(from, 0);
    }
  });
  let cursor = 0;
  function streamSimple(model: Model, context: Context) {
    calls.push({ model: `${model.provider}/${model.id}`, messages: structuredClone(context.messages) });
    const step = steps[cursor++] ?? { error: LIMIT };
    const error = "error" in step;
    const stopReason = error ? "error" : step.type === "toolCall" ? "toolUse" : "stop";
    const message: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), usage, content: error ? [] : [step], stopReason,
      ...(error && { errorMessage: step.error, errorStatus: 429 }),
    };
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      if (error) stream.push({ type: "error", reason: "error", error: message });
      else {
        if (step.type === "toolCall") stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: step, partial: message });
        stream.push({ type: "done", reason: step.type === "toolCall" ? "toolUse" : "stop", message });
      }
      stream.end();
    });
    return stream;
  }
  const modelSpec = (id: string) => ({
    id, name: id, reasoning: !!sourceEffort && id.startsWith("deepseek-ai/"), input: ["text" as const], cost: usage.cost,
    contextWindow: 128000, maxTokens: 4096,
  });
  registry.registerProvider("hive", {
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture", api: "fixture-deepseek-midtask",
    models: [modelSpec(DEEPSEEK.slice("hive/".length))], streamSimple,
  });
  registry.registerProvider("anthropic", {
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "fixture", api: "fixture-anthropic-midtask",
    models: [modelSpec(SONNET.slice("anthropic/".length)), modelSpec(OTHER_SONNET.slice("anthropic/".length))], streamSimple,
  });
  if (suppressSonnet) registry.suppressSelector(`${SONNET}:auto`, Date.now() + 60_000);
  if (sonnetUnavailableAtDispatch) {
    const hasConfiguredAuth = registry.hasConfiguredAuth.bind(registry);
    registry.hasConfiguredAuth = model => `${model.provider}/${model.id}` !== SONNET && hasConfiguredAuth(model);
  }
  const mainModel = registry.find("hive", DEEPSEEK.slice("hive/".length))!;
  const { session } = await createAgentSession({
    cwd: root, agentDir, agentId: "Main", model: mainModel, modelRegistry: registry, sessionManager: sessions, settings, eventBus: bus,
    disableExtensionDiscovery: true, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
    skills: [], rules: [], contextFiles: [], toolNames: ["write"], extensions: [runtime],
  });
  try {
    await initializeExtensions(session, {
      reportSendError: (_action, error) => { runtimeErrors.push(error); },
      reportRuntimeError: error => { runtimeErrors.push(error); },
      trackExtensionSend: send => { sends.push(send); },
    });
    const result = agent === "main"
      ? await session.prompt(TASK)
      : await runSubagentRunRequest(subagentRunRequest({
        cwd: root, settings, modelRegistry: registry, authStorage: auth, eventBus: bus,
        agent: { name: agent, source: "user", description: "Scripted child", systemPrompt: "Fixture", tools: ["write"] },
        modelOverride: `${primary}:${sourceEffort ?? "auto"}`, description: "Fixture", task: TASK, index: 0,
        id: `agent-fallback-${agent}`, keepAlive: false, enableLsp: false, enableMCP: false, enableIrc: false,
        taskDepth: 0, sessionFile: null, rules: [], skills: [], contextFiles: [],
        preloadedPreparedExtensions: [{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: runtime, error: null }],
        ...(secondPrompt && { steps: [TASK, "Finish the next step in the same child."] }),
      }));
    // Parent notices are asynchronous bus delivery, followed by session-scoped aside sends.
    await setImmediate();
    await Promise.all(sends);
    for (const message of session.messages) {
      if (message.role === "custom" && typeof message.content === "string") notices.push(message.content);
    }
    expect(runtimeErrors).toEqual([]);
    expect(cfgRetryFallbackChains.get(settings)).toEqual(fallbackChains);
    expect(cfgRetryFallbackRevertPolicy.get(settings)).toBe("cooldown-expiry");
    const records = await Bun.file(ledgerPath).exists()
      ? readFileSync(ledgerPath, "utf8").trim().split("\n").map(line => JSON.parse(line))
      : [];
    if (records.length > 0) {
      const ledger = createRoutingLedger(ledgerPath);
      expect(ledger.read()).toEqual([]);
      expect(ledger.read(sessions.getSessionId())).toEqual([]);
    }
    const marker = await Bun.file(join(root, "before.txt")).exists() ? readFileSync(join(root, "before.txt"), "utf8") : undefined;
    return { calls, events, notices, records, result, marker };
  } finally {
    await session.dispose();
    await sessions.close();
    auth.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const models = (calls: Request[]) => calls.map(call => call.model);

// The first provider call, attempted edit, failing call, replacement calls and notice all run through core's SDK.
test.each([false, true])("SDK: DeepSeek Maker keeps its completed tool and stays on Sonnet (competing effort key: %s)", async competingChain => {
  const { calls, events, result, notices, records, marker } = await runScenario({
    steps: [edit("before-write", "before.txt"), { error: LIMIT }, edit("after-write", "after.txt"), done("Resumed after limit."), done("Still on Sonnet.")],
    secondPrompt: true,
    sourceEffort: "high",
    competingChain,
  });
  expect(models(calls)).toEqual([DEEPSEEK, DEEPSEEK, SONNET, SONNET, SONNET]);
  expect(result).toMatchObject({ id: "agent-fallback-maker", exitCode: 0, resolvedModelIsFallback: true, output: expect.stringContaining("Still on Sonnet.") });
  expect(marker).toBe("before-write");
  expect(calls[2]!.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(TASK))).toBe(true);
  expect(calls[2]!.messages.filter(message => message.role === "toolResult").map(message => message.toolCallId)).toEqual(["before-write"]);
  expect(events.filter(({ event }) => event.type === "tool_execution_start").map(({ id, event }) => [id, event.toolCallId]))
    .toEqual([["agent-fallback-maker", "before-write"], ["agent-fallback-maker", "after-write"]]);
  expect(events.filter(({ event }) => event.type === "retry_fallback_applied").map(({ event }) => [event.from, event.to, event.role]))
    .toEqual([[`${DEEPSEEK}:high`, `${SONNET}:auto`, competingChain ? `${DEEPSEEK}:high` : DEEPSEEK]]);
  const limitNotices = notices.filter(notice => notice.includes(JSON.stringify(LIMIT)));
  expect(limitNotices).toHaveLength(1);
  expect(limitNotices[0]).toContain(DEEPSEEK);
  expect(limitNotices[0]).toContain(SONNET);
  expect(records).toContainEqual(expect.objectContaining({ agentId: "agent-fallback-maker", fromModel: DEEPSEEK, toModel: SONNET, error: LIMIT }));
  console.log("SDK smoke: DeepSeek wrote before.txt once; the same child kept its tool result and remained on Sonnet after cooldown expiry; idle Main received the notice and ledger row without making a request.");
});

test("SDK: first-request usage limit goes to the configured Sonnet, then a second limit stops without a loop", async () => {
  const { calls, result, notices, records } = await runScenario({ sonnet: `${OTHER_SONNET}:auto`, steps: [{ error: LIMIT }, { error: SONNET_LIMIT }] });
  expect(models(calls)).toEqual([DEEPSEEK, OTHER_SONNET]);
  expect(result).toMatchObject({ exitCode: 1 });
  expect(notices.filter(notice => notice.includes(OTHER_SONNET))).toHaveLength(2);
  expect(records).toContainEqual(expect.objectContaining({ fromModel: DEEPSEEK, toModel: OTHER_SONNET, error: LIMIT, replacementError: SONNET_LIMIT }));
});

test.each(["main", "reviewer"])("SDK: a %s session on DeepSeek does not get the Maker exception", async agent => {
  const { calls, notices } = await runScenario({ agent, steps: [{ error: LIMIT }] });
  expect(models(calls)).toEqual([DEEPSEEK]);
  expect(notices).toEqual([]);
});

test("SDK: Sonnet-origin Maker keeps its normal usage-limit chain", async () => {
  const { calls, notices } = await runScenario({ primary: SONNET, steps: [{ error: SONNET_LIMIT }, { error: LIMIT }] });
  expect(models(calls)).toEqual([SONNET, DEEPSEEK]);
  expect(notices).toEqual([]);
});

test("SDK: a Sonnet dispatch already substituted onto DeepSeek at startup keeps the original policy", async () => {
  const { calls, notices, records, result } = await runScenario({
    primary: SONNET, sonnetUnavailableAtDispatch: true, steps: [{ error: LIMIT }, done("Existing fallback worked.")],
  });
  expect(models(calls)).toEqual([DEEPSEEK, OTHER_SONNET]);
  expect(result).toMatchObject({ exitCode: 0, modelOverride: `${SONNET}:auto`, resolvedModel: OTHER_SONNET });
  expect(notices).toEqual([]);
  expect(records).toEqual([]);
});

test("SDK: transient 429 is retried on DeepSeek without a Maker fallback", async () => {
  expect(AIError.is(AIError.classifyMessage({ errorStatus: 429, errorMessage: LIMIT }), AIError.Flag.UsageLimit)).toBe(true);
  expect(AIError.is(AIError.classifyMessage({ errorStatus: 429, errorMessage: TRANSIENT }), AIError.Flag.UsageLimit)).toBe(false);
  const { calls, notices } = await runScenario({ steps: [{ error: TRANSIENT }, done("Retry succeeded.")] });
  expect(models(calls)).toEqual([DEEPSEEK, DEEPSEEK]);
  expect(notices).toEqual([]);
});

test("SDK: an unresolved Sonnet slot fails closed with a parent notice", async () => {
  const { calls, result, notices, records } = await runScenario({ sonnet: "anthropic/claude-sonnet-missing:auto", steps: [{ error: LIMIT }] });
  expect(models(calls)).toEqual([DEEPSEEK]);
  expect(result).toMatchObject({ exitCode: 1 });
  expect(notices).toEqual([expect.stringContaining("NORMAL_SONNET")]);
  expect(records).toContainEqual(expect.objectContaining({ stage: "no-replacement", fromModel: DEEPSEEK, error: LIMIT }));
});

test("SDK: a suppressed Sonnet slot cannot expose a competing scoped effort chain", async () => {
  const { calls, result, records } = await runScenario({ sourceEffort: "high", competingChain: true, suppressSonnet: true, steps: [{ error: LIMIT }] });
  expect(models(calls)).toEqual([DEEPSEEK]);
  expect(result).toMatchObject({ exitCode: 1 });
  expect(records).toContainEqual(expect.objectContaining({ stage: "no-replacement", fromModel: DEEPSEEK }));
});
