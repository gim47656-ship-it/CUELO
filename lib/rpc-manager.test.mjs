import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./rpc-manager.ts");
  } catch {
    return import("./rpc-manager.ts");
  }
}

const { AgentSessionWrapper, resolveForkEntryId } = await loadSubject();

function makeEventBus() {
  return { on: () => () => {} };
}

function makeInner(overrides = {}) {
  return Object.assign({
    sessionId: "old-session",
    sessionFile: "/tmp/cuelo-old-session.jsonl",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    configuredThinkingLevel: () => undefined,
    model: undefined,
    agent: { state: {} },
    extensionRunner: undefined,
    queuedMessageCount: 0,
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    getTodoPhases: () => [],
    abort: async () => {},
    abortBash: () => {},
    dispose: async () => {},
    handoff: async () => undefined,
  }, overrides);
}

test("clear_queue preserves queued steering images for composer recall", async () => {
  const image = { type: "image", data: "AQID", mimeType: "image/png" };
  const restored = {
    steering: [{ text: "inspect this", images: [image] }],
    followUp: [{ text: "then continue" }],
  };
  const wrapper = new AgentSessionWrapper(
    makeInner({ clearQueue: () => restored }),
    makeEventBus(),
  );

  assert.deepEqual(await wrapper.send({ type: "clear_queue" }), restored);
});

test("a corrupted image rejection leaves the next text prompt dispatchable", async () => {
  const prompts = [];
  const events = [];
  const wrapper = new AgentSessionWrapper(
    makeInner({
      sessionManager: { getEntries: () => [] },
      prompt: async (message, options) => {
        prompts.push({ message, options });
      },
    }),
    makeEventBus(),
  );
  wrapper.onEvent((event) => events.push(event.type));

  await assert.rejects(
    wrapper.send({
      type: "prompt",
      message: "",
      images: [{ type: "image", data: "AQI", mimeType: "image/png" }],
    }),
    /valid base64 image data/,
  );
  assert.equal(prompts.length, 0);
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);

  await wrapper.send({ type: "prompt", message: "send this next" });
  await Promise.resolve();

  assert.deepEqual(prompts, [{
    message: "send this next",
    options: { userInitiated: true },
  }]);
  assert.equal((await wrapper.send({ type: "get_state" })).isPromptRunning, false);
  assert.deepEqual(events.filter((type) => type === "prompt_done"), ["prompt_done"]);
});

test("RPC session startup reuses the shared omp runtime instead of a per-session one", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /getOmpRuntime\(\)/);
  assert.match(startupSource, /getSettingsForCwd\(sessionCwd\)/);
  assert.match(startupSource, /modelRegistry,/);
});

test("RPC session startup gates untrusted project code before creating the session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const discoverIndex = startupSource.indexOf("discoverSessionExtensionPaths(");
  const gateIndex = startupSource.indexOf("untrustedProjectSessionOptions(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(discoverIndex >= 0);
  assert.ok(gateIndex > discoverIndex);
  assert.ok(createIndex > gateIndex);
  assert.match(startupSource, /discoverCustomToolPaths\(\[\], sessionCwd\)/);
  assert.match(startupSource, /\.\.\.\(untrusted \?\? \{\}\)/);
});

test("RPC session startup applies SYSTEM.md / APPEND_SYSTEM.md to the session options", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveSessionSystemPrompts(sessionCwd)");
  const applyIndex = startupSource.indexOf("applyResolvedSystemPromptInputs(");
  const createIndex = startupSource.indexOf("createAgentSession(sessionOptions)");

  assert.ok(resolveIndex >= 0);
  assert.ok(applyIndex > resolveIndex);
  assert.ok(createIndex > applyIndex);
  assert.match(
    startupSource,
    /applyResolvedSystemPromptInputs\(sessionOptions, systemPrompts\.systemPrompt, systemPrompts\.appendPrompt\)/,
  );
});

test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSession(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.buildSessionContext\(\)\.messages\.length > 0/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /const hasExistingMessages = sessionManager\.getBranch\(\)/);
});

test("RPC session startup opens an existing session file only once and trusts its cwd", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = sessionManager\.getCwd\(\)/);
  assert.match(startupSource, /untrustedProjectSessionOptions\(sessionCwd, agentDir, \{ extensionPaths, customToolPaths \}\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle and running-state maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const notifySource = source.slice(
    source.indexOf("export function notifyRunningChange"),
    source.indexOf("export async function startRpcSession"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.match(startSource, /RUNNING_STATE_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /if \(listeners\.size === 0\)/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(forkSource, /await this\.shutdownAfterCommittedFork\(newSessionId\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("RPC session startup keeps explicit model, thinking, and tool selections session-local", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /\.\.\.\(initial\.model \? \{ model: initial\.model \} : \{\}\)/);
  assert.match(startupSource, /\.\.\.\(initial\.thinkingLevel \? \{ thinkingLevel: initial\.thinkingLevel \} : \{\}\)/);
  assert.match(
    startupSource,
    /\.\.\.\(toolsOption !== undefined \? \{ toolNames: toolsOption, restrictToolNames: true \} : \{\}\)/,
  );
  assert.match(startupSource, /createAgentSession\(sessionOptions\)/);
  assert.match(startupSource, /session\.setActiveToolsByName\(withExtensionTools\(session, toolNames\)\)/);
  assert.doesNotMatch(startupSource, /persistExplicitStartupPreferences/);
  assert.doesNotMatch(startupSource, /runtime\.settings/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("aborting an extension ask closes only its browser request and leaves the session running", async () => {
  let sessionAborts = 0;
  const wrapper = new AgentSessionWrapper(
    makeInner({
      abort: async () => {
        sessionAborts += 1;
      },
    }),
    makeEventBus(),
  );
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const context = wrapper.createExtensionUiContext();
  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  const questions = [{
    id: "direction",
    question: "Continue?",
    options: [{ label: "Continue" }],
  }];

  const first = context.askDialog(questions, { signal: firstAbort.signal });
  const second = context.askDialog(questions, { signal: secondAbort.signal });
  const [firstRequest, secondRequest] = events;
  assert.equal(firstRequest.method, "ask");
  assert.equal(secondRequest.method, "ask");
  assert.notEqual(firstRequest.id, secondRequest.id);

  firstAbort.abort();
  assert.equal(await first, undefined);
  assert.deepEqual(events[2], { ...firstRequest, closed: true });
  assert.equal(events[2].id, firstRequest.id);
  assert.notEqual(events[2].id, secondRequest.id);
  assert.equal(sessionAborts, 0);

  const replayed = [];
  wrapper.onEvent((event) => replayed.push(event));
  assert.deepEqual(replayed, [secondRequest]);

  secondAbort.abort();
  assert.equal(await second, undefined);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.inner\.reload\(\)/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);\s*invalidateModelsCache\(\)/);
});

test("RPC command bridge dispatches omp text-mode slash builtins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const commandSource = source.slice(
    source.indexOf('case "execute_slash_command"'),
    source.indexOf('case "set_tools"'),
  );

  assert.match(commandSource, /executeAcpBuiltinSlashCommand\(/);
  assert.match(commandSource, /output\.push\(text\)/);
  assert.match(commandSource, /handled: true/);
  assert.match(commandSource, /prompt: result\.prompt/);
});
test("RPC state retains completed subagent snapshots for history", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "get_subagent_messages"'),
  );

  assert.match(source, /private readonly subagentHistory = new Map<string, SubagentSnapshot>\(\)/);
  assert.match(source, /private getSubagentSnapshots\(\)/);
  assert.match(stateSource, /subagents: this\.getSubagentSnapshots\(\)/);
  assert.match(source, /this\.subagentHistory\.clear\(\)/);
  assert.match(source, /this\.subagents\.getSubagents\(\)\.length > 0/);
});

test("AgentSessionLike declares the handoff member matching the SDK result", async () => {
  const ompTypesSource = await readFile(new URL("./omp-types.ts", import.meta.url), "utf8");
  const likeSource = ompTypesSource.slice(ompTypesSource.indexOf("export interface AgentSessionLike"));

  // The structural view mirrors the SDK's session.handoff(): custom instructions
  // in, a document/savedPath result out, undefined meaning cancelled.
  assert.match(
    likeSource,
    /handoff\(customInstructions\?: string\): Promise<\{ document: string; savedPath\?: string \} \| undefined>;/,
  );
});

test("latest-session fork resolution is atomic and preserves explicit tree targets", () => {
  const branch = [
    { id: "user-old", type: "message", message: { role: "user" } },
    { id: "assistant", type: "message", message: { role: "assistant" } },
    { id: "custom", type: "custom" },
    { id: "user-latest", type: "message", message: { role: "user" } },
  ];

  assert.equal(resolveForkEntryId(branch), "user-latest");
  assert.equal(resolveForkEntryId(branch, "explicit-entry"), "explicit-entry");
  assert.equal(resolveForkEntryId([{ id: "assistant", type: "message", message: { role: "assistant" } }]), undefined);
});

test("RPC handoff reports distinct running state and rejects concurrent mutations", async () => {
  let finishHandoff;
  const inner = makeInner({
    handoff: () => new Promise((resolve) => {
      finishHandoff = resolve;
    }),
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());
  const handoff = wrapper.send({ type: "handoff", customInstructions: "focus" });
  await Promise.resolve();

  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isHandoffRunning, true);
  assert.equal(state.isCompacting, false);
  await assert.rejects(
    wrapper.send({ type: "fork" }),
    /Cannot modify the session while a handoff is in progress/,
  );
  await assert.rejects(
    wrapper.send({ type: "handoff" }),
    /Cannot modify the session while a handoff is in progress/,
  );

  finishHandoff(undefined);
  assert.deepEqual(await handoff, { cancelled: true });
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});

test("RPC handoff compacts in place and keeps the session serving", async () => {
  let receivedInstructions;
  const inner = makeInner({
    handoff: async (instructions) => {
      receivedInstructions = instructions;
      return { document: "handoff context" };
    },
  });
  const wrapper = new AgentSessionWrapper(inner, makeEventBus());

  // omp 18 commits the handoff document as this session's compaction entry
  // instead of minting a replacement, so there is no id to hand back and the
  // wrapper must survive to keep serving the same session.
  assert.deepEqual(
    await wrapper.send({ type: "handoff", customInstructions: "focus exactly here" }),
    { cancelled: false },
  );

  assert.equal(receivedInstructions, "focus exactly here");
  assert.equal(inner.sessionId, "old-session");
  assert.equal(inner.sessionFile, "/tmp/cuelo-old-session.jsonl");
  assert.equal(wrapper.isAlive(), true);
  wrapper.destroy();
});
