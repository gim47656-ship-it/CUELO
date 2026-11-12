import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import * as subject from "./rpc-manager.ts";

const model = getBundledModel("anthropic", "claude-sonnet-5-5");
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
const blocks = (prompt) => prompt.map((text, index) => ({ index, label: text.split("\n", 1)[0].slice(0, 48), hash: hash(text) }));
const captures = new WeakMap();

export async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cuelo-resume-prefix-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
  const sessions = [];
  t.after(async () => {
    for (const session of sessions.reverse()) await session.dispose();
    authStorage.close();
    await rm(root, { recursive: true, force: true });
  });
  const settings = Settings.isolated({
    "goal.enabled": true, "tools.xdev": false, "memory.backend": "off",
    "skills.enabled": false, "includeWorkspaceTree": false,
  });
  const create = async (manager, extra = {}) => {
    const { session } = await createAgentSession({
      cwd, agentDir, authStorage, modelRegistry, settings, model,
      sessionManager: manager, getApiKey: () => "test-key-not-used",
      enableMCP: false, enableLsp: false, enableIrc: false,
      disableExtensionDiscovery: true, preloadedCustomToolPaths: [],
      rules: [], skills: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      skipPythonPreflight: true, cacheWarming: false, deferSkillDescriptionCompression: true,
      ...extra,
    });
    sessions.push(session);
    session.agent.streamFn = (requestModel, context, options) => streamAnthropic(requestModel, context, {
      ...options, apiKey: "test-key-not-used", maxRetries: 0,
      onPayload(params) { captures.set(session, structuredClone(params)); throw new Error("captured before network"); },
    });
    return session;
  };
  return { cwd, root, create };
}

// Use the real core Agent preparation and Anthropic request builder. onPayload
// runs after replay/requestControls construction; throwing prevents any HTTP call.
export async function capture(session) {
  captures.delete(session);
  await session.agent.prompt("fixture request");
  const payload = captures.get(session);
  assert.ok(payload, "the real Anthropic request builder reached onPayload");
  const reply = session.agent.state.messages.at(-1);
  assert.equal(reply?.role, "assistant");
  assert.match(reply.errorMessage ?? "", /captured before network/);
  return { payload, controls: reply.requestControls, prompt: session.agent.state.systemPrompt };
}

async function reload(f, session, reply, extra = {}) {
  // Persist a successful reply carrying the captured provider controls.
  const manager = session.sessionManager;
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "fixture request" }], timestamp: 1 });
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "fixture reply" }],
    api: model.api, provider: model.provider, model: model.id, timestamp: 2,
    stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    requestControls: { ...reply.controls, messageIndex: 1 },
  });
  manager.appendCustomEntry("session_exit", { reason: "idle" });
  await manager.flush();
  const file = manager.getSessionFile();
  await session.dispose();
  return f.create(await SessionManager.open(file), extra);
}

for (const goalActive of [true, false]) {
  test(`reload preserves declared order with a ${goalActive ? "selected" : "paused"} goal`, async (t) => {
    const f = await fixture(t);
    const before = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
    await before.setActiveToolsByName(["read", "bash", "goal"]);
    if (!goalActive) {
      // The definition was sent while goal mode was active, then withdrawn.
      const first = await capture(before);
      before.agent.replaceMessages([{ role: "user", content: "fixture request", timestamp: 1 }, {
        ...before.agent.state.messages.at(-1), stopReason: "stop", errorMessage: undefined,
        content: [{ type: "text", text: "fixture reply" }], requestControls: { ...first.controls, messageIndex: 1 },
      }]);
      await before.setActiveToolsByName(["read", "bash"]);
    }
    const previous = await capture(before);
    const resumed = await reload(f, before, previous);
    await subject.restoreRpcSessionTools(resumed);
    const next = await capture(resumed);
    assert.deepEqual(next.controls.tools.declared, previous.controls.tools.declared);
    assert.deepEqual(next.controls.tools.active, previous.controls.tools.active);
    assert.deepEqual(next.payload.tools, previous.payload.tools);
    console.log(JSON.stringify({ goalActive, before: blocks(previous.prompt), after: blocks(next.prompt) }));
    if (goalActive) assert.deepEqual(blocks(next.prompt), blocks(previous.prompt));
  });
}

test("fresh sessions and explicit startup presets bypass recorded replay", async (t) => {
  const f = await fixture(t);
  const session = await f.create(SessionManager.inMemory(f.cwd));
  const stream = session.agent.streamFn;
  const active = session.getEnabledToolNames();
  assert.equal(await subject.restoreRpcSessionTools(session), undefined);
  assert.equal(session.agent.streamFn, stream);
  const before = await capture(session);
  assert.equal(await subject.restoreRpcSessionTools(session, []), undefined);
  const after = await capture(session);
  assert.deepEqual(after.payload.tools, before.payload.tools);
  assert.deepEqual(session.getEnabledToolNames(), active);
});

test("an already-dropped goal stays dropped and explicit set_tools disables seeding", async (t) => {
  const f = await fixture(t);
  const session = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
  await session.setActiveToolsByName(["read", "bash"]);
  const previous = await capture(session);
  const resumed = await reload(f, session, previous);
  const stop = await subject.restoreRpcSessionTools(resumed);
  assert.deepEqual((await capture(resumed)).controls.tools, previous.controls.tools);
  const wrapper = new subject.AgentSessionWrapper(resumed, { on: () => () => {} }, stop);
  await wrapper.send({ type: "set_tools", toolNames: [] });
  assert.deepEqual((await capture(resumed)).payload.tools ?? [], []);
});

test("resume seeding does not leak into an in-place new session", async (t) => {
  const f = await fixture(t);
  const session = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
  await session.setActiveToolsByName(["read", "bash", "goal"]);
  const resumed = await reload(f, session, await capture(session));
  await subject.restoreRpcSessionTools(resumed);
  await resumed.newSession();
  await resumed.setActiveToolsByName(["read", "bash"]);
  assert.equal((await capture(resumed)).controls.tools.declared.includes("goal"), false);
});

for (const mode of ["goal_paused", "goal"]) {
  test(`a persisted ${mode} after the last reply wins over its active tools`, async (t) => {
    const f = await fixture(t);
    const session = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
    await session.setActiveToolsByName(mode === "goal_paused" ? ["read", "bash", "goal"] : ["read", "bash"]);
    const resumed = await reload(f, session, await capture(session));
    resumed.sessionManager.appendModeChange(mode);
    await subject.restoreRpcSessionTools(resumed);
    assert.equal((await capture(resumed)).controls.tools.active.includes("goal"), mode === "goal");
  });
}

test("API refusal controls are ignored just as in core provider replay", async (t) => {
  const f = await fixture(t);
  const session = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
  await session.setActiveToolsByName(["read", "bash"]);
  const previous = await capture(session);
  const resumed = await reload(f, session, previous);
  const reply = resumed.sessionManager.buildSessionContext().messages.findLast((message) => message.role === "assistant");
  resumed.sessionManager.appendMessage({
    ...reply, stopReason: "error", stopDetails: { type: "refusal" },
    requestControls: { ...reply.requestControls, tools: { declared: ["read", "goal"], active: ["read", "goal"], deferred: [] } },
  });
  await subject.restoreRpcSessionTools(resumed);
  assert.deepEqual((await capture(resumed)).controls.tools.active, previous.controls.tools.active);
});

for (const allOff of [false, true]) {
  test(`a new plugin ${allOff ? "does not override all-off" : "is appended after the recorded tools"}`, async (t) => {
    const f = await fixture(t);
    const session = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
    await session.setActiveToolsByName(allOff ? [] : ["read", "bash"]);
    const previous = await capture(session);
    const resumed = await reload(f, session, previous, {
      customTools: [{ name: "fixture_plugin", label: "Fixture", description: "fixture",
        parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) }],
    });
    await subject.restoreRpcSessionTools(resumed);
    const next = await capture(resumed);
    assert.deepEqual(next.controls.tools.declared, allOff ? [] : [...previous.controls.tools.declared, "fixture_plugin"]);
  });
}

test("all-off plus a new goal does not enable new plugins, and missing tools do not imply all-off", async (t) => {
  const f = await fixture(t);
  const plugin = { name: "fixture_plugin", label: "Fixture", description: "fixture",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };
  const session = await f.create(SessionManager.create(f.cwd, join(f.root, "sessions")));
  await session.setActiveToolsByName([]);
  const resumed = await reload(f, session, await capture(session), { customTools: [plugin] });
  resumed.sessionManager.appendModeChange("goal");
  const stop = await subject.restoreRpcSessionTools(resumed);
  assert.equal(stop.allOff, false);
  assert.deepEqual(resumed.getEnabledToolNames(), ["goal"]);
  const missing = await f.create(SessionManager.create(f.cwd, join(f.root, "other-sessions")), { customTools: [plugin] });
  await missing.setActiveToolsByName(["fixture_plugin"]);
  const reopened = await reload(f, missing, await capture(missing));
  const missingStop = await subject.restoreRpcSessionTools(reopened);
  assert.equal(missingStop.allOff, false);
  assert.deepEqual(reopened.getEnabledToolNames(), []);
});
