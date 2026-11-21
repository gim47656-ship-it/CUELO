import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { createAgentSession, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { execFileSync } from "node:child_process";

const allowed = ["read", "grep", "glob", "web_search"];
const answer = { role: "assistant", content: [{ type: "text", text: "fixture reply" }], api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-5-5", timestamp: 2, stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

test("SDK hard restriction survives session reload and cold resume", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cuelo-restricted-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
  authStorage.keys.setRuntime("anthropic", "fixture-key-no-network");
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
  const sessions = [];
  t.after(async () => {
    for (const s of sessions) await s.dispose();
    authStorage.close(); await rm(root, { recursive: true, force: true });
  });
  const create = async (manager) => {
    const { session } = await createAgentSession({
      cwd, agentDir, authStorage, modelRegistry,
      settings: Settings.isolated({ "tools.commands": true, "memory.backend": "off", "skills.enabled": false, "includeWorkspaceTree": false }),
      model: getBundledModel("anthropic", "claude-sonnet-5-5"),
      sessionManager: manager, getApiKey: () => "test-key-not-used",
      toolNames: allowed, restrictToolNames: true,
      rules: [], skills: [], contextFiles: [], promptTemplates: [], slashCommands: [],
      cacheWarming: "off", skipPythonPreflight: true,
    });
    sessions.push(session); return session;
  };
  const check = (s) => {
    assert.ok(s.getAllToolNames().includes("read"));
    assert.ok(s.getAllToolNames().every((name) => allowed.includes(name)), JSON.stringify(s.getAllToolNames()));
    assert.equal(s.getToolByName("bash"), undefined);
    assert.equal(s.getToolByName("write"), undefined);
    console.log("restricted registry", JSON.stringify(s.getAllToolNames()));
  };
  const s = await create(SessionManager.create(cwd, join(root, "sessions")));
  check(s);
  const beforeRole = s.settings.getModelRole("default");
  await s.setModel(getBundledModel("anthropic", "claude-sonnet-5-5"), undefined, { persist: false });
  assert.equal(s.settings.getModelRole("default"), beforeRole);
  console.log("non-persisting model selection leaves default role unchanged", beforeRole);
  s.sessionManager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
  s.sessionManager.appendMessage(answer);
  s.sessionManager.appendCustomEntry("restriction-fixture", {});
  await s.sessionManager.flush();
  const file = s.sessionFile;
  assert.ok(file);
  await s.reload(); check(s);
  const resumed = await create(await SessionManager.open(file));
  check(resumed);
  assert.equal(resumed.sessionId, s.sessionId);
});

if (process.env.CUELO_RESTRICTED_RPC_CHILD === "1") {
  test("RPC opt-in policy holds for new/resumed/reloaded/plugin-restarted sessions and cannot widen", async (t) => {
    const { startNewRpcSession, startRpcSession, getRpcSession } = await import("./rpc-manager.ts");
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const cwd = join(agentDir, "project");
    await mkdir(cwd);
    const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
    const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
    const settings = Settings.isolated({ "tools.commands": false, "memory.backend": "off", "skills.enabled": false, "includeWorkspaceTree": false });
    globalThis.__ompRuntimePromise = Promise.resolve({ agentDir, settings, authStorage, modelRegistry });
    const wrappers = [];
    t.after(async () => { for (const w of wrappers) if (w.isAlive()) await w.shutdown(); authStorage.close(); });
    const options = { restrictTools: allowed, initialModel: { provider: "anthropic", modelId: "claude-sonnet-5-5" } };
    const check = async (w) => {
      const names = (await w.send({ type: "get_tools" })).map((tool) => tool.name);
      assert.ok(names.includes("read"));
      assert.ok(names.every((name) => allowed.includes(name)), JSON.stringify(names));
      assert.deepEqual(w.restrictTools, allowed);
      console.log("RPC restricted registry", JSON.stringify(names));
    };
    const first = await startNewRpcSession(undefined, cwd, options);
    wrappers.push(first.session);
    await first.session.waitUntilReady();
    await check(first.session);
    await first.session.send({ type: "set_tools", toolNames: ["read", "write", "bash", "fixture_extension"] });
    assert.deepEqual((await first.session.send({ type: "get_tools" })).filter((x) => x.active).map((x) => x.name), ["read"]);
    await assert.rejects(first.session.send({ type: "bash", command: "echo forbidden" }), /restricted session/);
    const manager = first.session.inner.sessionManager;
    manager.appendMessage({ role: "user", content: "fixture", timestamp: 1 });
    manager.appendMessage(answer);
    manager.appendCustomEntry("restriction-fixture", {});
    await manager.flush();
    const file = first.session.sessionFile;
    await first.session.send({ type: "reload" });
    await check(first.session);
    await first.session.shutdown();
    const cold = await startRpcSession(first.realSessionId, file, cwd, options);
    wrappers.push(cold.session);
    await cold.session.waitUntilReady();
    assert.equal(cold.realSessionId, first.realSessionId);
    await check(cold.session);
    const pluginDir = join(agentDir, "cuelo-plugins", "restriction-fixture");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ id: "restriction-fixture", name: "Fixture", description: "Restriction fixture", createdAt: "2026-11-16T00:00:00Z", extension: "index.ts", tools: ["fixture_extension"] }));
    await writeFile(join(pluginDir, "index.ts"), 'export default function(pi) { pi.registerTool({name:"fixture_extension",label:"Fixture",description:"Fixture",parameters:{type:"object",properties:{}},execute:async()=>({content:[{type:"text",text:"ok"}]})}); }');
    assert.deepEqual(await cold.session.send({ type: "reload" }), { success: true, restarted: true });
    const restarted = getRpcSession(first.realSessionId);
    assert.ok(restarted); assert.notEqual(restarted, cold.session);
    wrappers.push(restarted);
    await restarted.waitUntilReady();
    await check(restarted);
    const unrestricted = await startNewRpcSession(undefined, cwd, { toolNames: ["read"], initialModel: options.initialModel });
    wrappers.push(unrestricted.session);
    await unrestricted.session.waitUntilReady();
    const tools = await unrestricted.session.send({ type: "get_tools" });
    assert.equal(tools.find((x) => x.name === "fixture_extension")?.active, true);
    assert.equal(unrestricted.session.restrictTools, undefined);
    console.log("unrestricted extension retained", tools.find((x) => x.name === "fixture_extension"));
  }, { timeout: 30000 });
} else {
  test("RPC restriction integration runs with its own runtime and agent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cuelo-rpc-policy-"));
    try {
      const result = execFileSync(process.execPath, ["test", import.meta.filename], {
        env: { ...process.env, CUELO_RESTRICTED_RPC_CHILD: "1", PI_CODING_AGENT_DIR: root, ANTHROPIC_API_KEY: "fixture-key-no-network" },
        encoding: "utf8", timeout: 60000,
      });
      console.log(result);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, { timeout: 70000 });
}
