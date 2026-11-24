import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry, Settings } from "@oh-my-pi/pi-coding-agent";
import { __resetDirsFromEnvForTests, getAgentDir, refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { startNewRpcSession, startRpcSession, type AgentSessionWrapper } from "./rpc-manager";

async function toolNames(session: AgentSessionWrapper, activeOnly = true): Promise<string[]> {
  const tools = await session.send({ type: "get_tools" }) as { name: string; active: boolean }[];
  return tools.filter((tool) => !activeOnly || tool.active).map((tool) => tool.name).sort();
}

async function installTool(agentDir: string, name: string, atStartup = false): Promise<void> {
  const id = name.replaceAll("_", "-");
  const plugin = join(agentDir, "cuelo-plugins", id);
  await mkdir(plugin, { recursive: true });
  await writeFile(join(plugin, "plugin.json"), JSON.stringify({
    id, name, description: "Selection fixture", createdAt: "2026-11-24T00:00:00Z",
    extension: "index.ts", tools: [name],
  }));
  const register = `pi.registerTool({ name: ${JSON.stringify(name)}, label: "Fixture", description: "Selection fixture",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) });`;
  await writeFile(join(plugin, "index.ts"), `export default function(pi) {
    ${atStartup ? `pi.on("session_start", () => { ${register} });` : register}
  }`);
}

async function stop(session: AgentSessionWrapper): Promise<void> {
  await session.shutdown("tool-selection-test");
  await session.inner.dispose?.();
}

const models = [
  ["anthropic-messages", "anthropic", "claude-sonnet-5-5"],
  ["openai-codex-responses", "openai-codex", "gpt-6-sol"],
] as const;

test.each(models)("cold resume preserves %s explicit tool selection", async (api, provider, modelId) => {
  const root = await mkdtemp(join(tmpdir(), "cuelo-tool-selection-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousUpdateRoot = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  const previousRuntime = globalThis.__ompRuntimePromise;
  const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = root;
  refreshDirsFromEnv();
  const settings = Settings.isolated({
    "tools.commands": false, "memory.backend": "off", "goal.enabled": true,
    "skills.enabled": false, "includeWorkspaceTree": false,
  });
  const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
  authStorage.keys.setRuntime(provider, "fixture-key-no-network");
  globalThis.__ompRuntimePromise = Promise.resolve({ agentDir, settings, authStorage, modelRegistry });
  let session: AgentSessionWrapper | undefined;
  try {
    expect(getAgentDir()).toBe(agentDir);
    await installTool(agentDir, "selected_fixture");
    const started = await startNewRpcSession(undefined, cwd, { initialModel: { provider, modelId } });
    const { realSessionId } = started;
    session = started.session;
    await session.waitUntilReady();
    expect(session.inner.model).toMatchObject({ api, provider, id: modelId });
    const defaults = await toolNames(session);
    expect(defaults).toEqual(expect.arrayContaining(["read", "bash", "selected_fixture"]));

    const manager = session.inner.sessionManager;
    manager.appendMessage({ role: "user", content: "fixture request", timestamp: 1 });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: "fixture reply" }], api, provider, model: modelId,
      timestamp: 2, stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    await manager.flush();
    const file = session.sessionFile!;
    const reopen = async (toolNames?: string[]) => {
      const previousSession = session!;
      await stop(previousSession);
      ({ session } = await startRpcSession(realSessionId, file, undefined, { toolNames }));
      expect(session).not.toBe(previousSession);
      await session.waitUntilReady();
      expect(session.inner.model).toMatchObject({ api, provider, id: modelId });
    };

    await reopen();
    expect(await toolNames(session)).toEqual(defaults);
    await session.send({ type: "set_tools", toolNames: ["read"] });
    const selected = await toolNames(session);
    expect(selected).toContain("selected_fixture");
    expect(selected).not.toContain("bash");
    await installTool(agentDir, "late_fixture");
    await reopen();
    expect(await toolNames(session, false)).toContain("late_fixture");
    expect(await toolNames(session)).toEqual(selected);

    await installTool(agentDir, "startup_fixture", true);
    await reopen(["read", "bash", "edit", "write"]);
    expect(await toolNames(session, false)).toContain("startup_fixture");
    expect(await toolNames(session)).toEqual(selected);

    const append = spyOn(session.inner.sessionManager, "appendEntriesAtomically")
      .mockRejectedValueOnce(new Error("fixture write failed"));
    try {
      await expect(session.send({ type: "set_tools", toolNames: [] })).rejects.toThrow("fixture write failed");
      expect(await toolNames(session)).toEqual(selected);
    } finally {
      append.mockRestore();
    }
    await reopen();
    expect(await toolNames(session)).toEqual(selected);

    await session.send({ type: "set_tools", toolNames: [] });
    expect(await toolNames(session)).toEqual([]);
    await reopen();
    expect(await toolNames(session)).toEqual([]);
    expect(session.inner.agent.state?.systemPrompt).toEqual([]);

    await session.send({ type: "goal", args: "fixture objective" });
    await session.send({ type: "set_tools", toolNames: [] });
    const goalTools = await toolNames(session);
    expect(goalTools).toContain("goal");
    await reopen();
    expect(await toolNames(session)).toEqual(goalTools);
    expect(session.inner.getGoalModeState?.()?.goal.status).toBe("paused");

    await stop(session);
    const restrictTools = ["read", "bash"];
    const draft = await startNewRpcSession(undefined, cwd, { initialModel: { provider, modelId }, restrictTools });
    session = draft.session;
    expect(await toolNames(session)).toEqual(["bash", "read"]);
    await session.send({ type: "set_tools", toolNames: ["read", "write"] });
    const draftFile = session.sessionFile!;
    expect(await Bun.file(draftFile).exists()).toBe(true);
    await stop(session);
    ({ session } = await startRpcSession(draft.realSessionId, draftFile, undefined, { restrictTools }));
    expect(await toolNames(session)).toEqual(["read"]);
    expect(await toolNames(session, false)).toEqual(["bash", "read"]);
  } finally {
    if (session) await stop(session);
    globalThis.__ompRuntimePromise = previousRuntime;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    if (previousUpdateRoot === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
    else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previousUpdateRoot;
    __resetDirsFromEnvForTests();
    authStorage.close();
    await rm(root, { recursive: true, force: true });
  }
}, { timeout: 15_000 });
