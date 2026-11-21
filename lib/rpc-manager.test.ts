import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { AuthStorage, createAssistantMessageEventStream, type AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { GET as getEvents } from "../app/api/agent/[id]/events/route";
import { POST as postCommand } from "../app/api/agent/[id]/route";
import { AgentSessionWrapper } from "./rpc-manager";
import { handleInterruptRequest } from "./update-interrupt";
import { cacheSessionPath } from "./session-reader";

const fixtureSessionId = "a0000000-0000-0000-0000-000000000001";
const requestId = "a".repeat(32);
const interruptId = `update-${requestId}`;
const stageHash = "b".repeat(64);
const blocked = /CUELO update (DRAINING|QUIESCENT|CUTOVER)/;

function user(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

const model = getBundledModel("anthropic", "claude-sonnet-5-5")!;
function assistant(): AssistantMessage {
  return {
    role: "assistant", content: [{ type: "text", text: "fixture reply" }],
    api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function withDrain(run: (fixture: {
  root: string;
  sessionId: string;
  manager: SessionManager | undefined;
  agent: Agent;
  wrapper: AgentSessionWrapper;
  accepted: string[];
  calls: string[];
  command: (phase: string, revision: number) => void;
  ack: () => Promise<{ settled?: string[]; unsettled: string[] }>;
  lock: () => void;
  fail: () => void;
}) => Promise<void>, options: { cold?: boolean; startUnlocked?: boolean } = {}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cuelo-g5-"));
  const previousRoot = process.env.CUELO_EXTERNAL_UPDATE_ROOT;
  const previousRegistry = globalThis.__ompSessions;
  const manager = options.cold ? SessionManager.create(root, join(root, "sessions")) : undefined;
  const sessionId = manager?.getSessionId() ?? fixtureSessionId;
  const maintenanceDirectory = join(root, "maintenance", requestId);
  const resultPath = join(root, "results", `${requestId}.json`);
  const write = (path: string, value: object) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const command = (phase: string, revision: number) => write(join(maintenanceDirectory, "command.json"), {
    schemaVersion: 2, requestId, stageHash, phase, revision,
  });
  const calls: string[] = [];
  const accepted: string[] = [];
  const agent = new Agent({
    initialState: { model },
    getApiKey: () => "fixture-not-sent",
    streamFn: (_model, context) => {
      calls.push(context.messages.at(-1)?.role ?? "empty");
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: "stop", message: assistant() });
      return stream;
    },
  });
  const wrapper = new AgentSessionWrapper({
    sessionId,
    agent,
    get isStreaming() { return agent.state.isStreaming; },
    get queuedMessageCount() { return agent.peekSteeringQueue().length + agent.peekFollowUpQueue().length; },
    sessionManager: { getCwd: () => root, getEntries: () => [] },
    prompt: (text: string) => {
      accepted.push(text);
      return agent.prompt(text);
    },
    sendUserMessage: (text: string) => agent.prompt(text),
    steer: async (text: string) => agent.steer(user(text)),
    followUp: async (text: string) => agent.followUp(user(text)),
  } as never, { on: () => () => {} } as never);
  process.env.CUELO_EXTERNAL_UPDATE_ROOT = root;
  globalThis.__ompSessions = new Map([[sessionId, wrapper]]);
  try {
    write(join(root, "requests", `${requestId}.json`), {
      schemaVersion: 2, requestId, maintenanceDirectory, resultPath,
      transactionReceiptPath: join(root, "transactions", `${requestId}.json`),
    });
    const lock = () => write(join(root, "active.json"), { schemaVersion: 2, requestId });
    if (!options.startUnlocked) lock();
    command("DRAINING", 1);
    const ack = async () => {
      write(join(root, "interrupts", "request.json"), {
        schemaVersion: 1, id: interruptId, reason: "update-drain-timeout", atUtc: new Date().toISOString(),
        targetSessionIds: [sessionId],
      });
      expect(await handleInterruptRequest(new Set(), new Set())).toBe(true);
      return JSON.parse(readFileSync(join(root, "interrupts", `${interruptId}.ack.json`), "utf8"));
    };
    await run({ root, sessionId, manager, agent, wrapper, accepted, calls, command, ack, lock,
      fail: () => write(resultPath, { status: "failed" }) });
  } finally {
    await agent.waitForIdle();
    wrapper.destroy();
    globalThis.__ompSessions = previousRegistry;
    if (previousRoot === undefined) delete process.env.CUELO_EXTERNAL_UPDATE_ROOT;
    else process.env.CUELO_EXTERNAL_UPDATE_ROOT = previousRoot;
    rmSync(root, { recursive: true, force: true });
  }
}

test("G5: after a real drain ack the same wrapper rejects prompts, then reopens on failure", async () => {
  await withDrain(async ({ sessionId, agent, wrapper, accepted, calls, ack, command, fail }) => {
    expect(await ack()).toMatchObject({ settled: [sessionId], unsettled: [] });
    await expect(wrapper.sendInternalPrompt("internal wake")).rejects.toThrow(blocked);
    command("QUIESCENT", 2);
    await expect(wrapper.send({ type: "prompt", message: "late HTTP input" })).rejects.toThrow(blocked);
    command("CUTOVER", 3);
    await expect(wrapper.send({ type: "steer", message: "late steer" })).rejects.toThrow(blocked);
    await expect(wrapper.send({ type: "follow_up", message: "late follow-up" })).rejects.toThrow(blocked);
    expect(accepted).toEqual([]);
    expect(calls).toEqual([]);

    fail();
    await wrapper.sendInternalPrompt("failure resume");
    await agent.waitForIdle();
    expect(accepted).toEqual(["failure resume"]);
    expect(calls).toEqual(["user"]);
  });
});

test("G5: an SDK continuation scheduled before ack cannot consume steering or follow-up work under the fence", async () => {
  await withDrain(async ({ sessionId, agent, wrapper, calls, ack, fail }) => {
    const gate = Promise.withResolvers<void>();
    const scheduled = gate.promise.then(() => agent.continue());
    expect(await ack()).toMatchObject({ settled: [sessionId], unsettled: [] });
    const steer = user("steering payload");
    const followUp = user("follow-up payload");
    agent.steer(steer);
    agent.followUp(followUp);
    gate.resolve();
    await expect(scheduled).rejects.toThrow(blocked);
    expect(calls).toEqual([]);
    expect(agent.peekSteeringQueue()).toEqual([steer]);
    expect(agent.peekFollowUpQueue()).toEqual([followUp]);
    await expect(agent.prompt("autonomous SDK wake")).rejects.toThrow(blocked);

    fail();
    await wrapper.sendInternalPrompt("resume after failure");
    await agent.waitForIdle();
    expect(agent.state.messages.filter((message) => message === steer || message === followUp)).toEqual([steer, followUp]);
    expect(agent.hasQueuedMessages()).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });
});

test("G5: an idle agent with an accepted queued message does not get a settled ack", async () => {
  await withDrain(async ({ sessionId, agent, ack, fail }) => {
    const pending = user("already queued");
    agent.followUp(pending);
    expect(await ack()).toMatchObject({ unsettled: [sessionId] });
    expect(agent.peekFollowUpQueue()).toEqual([pending]);
    // This ack cannot lead to cutover. Let the SDK finish the work without
    // waiting for terminal failure, including for an already-finished target.
    await agent.continue();
    expect(agent.state.messages).toContainEqual(pending);
    fail();
  });
});

test("G5: a detached extension send is visibly rejected only for the acked ID", async () => {
  await withDrain(async ({ agent, wrapper, ack }) => {
    await ack();
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message) => { warnings.push(String(message)); };
    try {
      const { sendUserMessage } = wrapper.inner as unknown as { sendUserMessage(text: string): Promise<void> };
      await expect(sendUserMessage("detached extension work")).rejects.toThrow(blocked);
    } finally {
      console.warn = warn;
    }
    expect(warnings.join("\n")).toContain("SDK turn rejected");
    expect(agent.state.messages).toEqual([]);

    let allowed = false;
    const unrelatedAgent = { continue: async () => { allowed = true; } };
    const other = new AgentSessionWrapper({
      sessionId: "a0000000-0000-0000-0000-000000000002",
      agent: unrelatedAgent,
    } as never, { on: () => () => {} } as never);
    try {
      await unrelatedAgent.continue();
      expect(allowed).toBe(true);
    } finally {
      other.destroy();
    }
  });
});

test("G5: POST admitted before ack retains the 503 maintenance response if dispatch is too late", async () => {
  await withDrain(async ({ sessionId, wrapper, ack, lock }) => {
    const params = Promise.withResolvers<{ id: string }>();
    const pending = postCommand(new Request("http://localhost/api/agent/" + sessionId, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify({ type: "prompt", message: "late" }),
    }), { params: params.promise });
    lock();
    expect(await ack()).toMatchObject({ settled: [sessionId], unsettled: [] });
    expect(wrapper.isAlive()).toBe(true);
    params.resolve({ id: sessionId });
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "CUELO update DRAINING", code: "update_draining", accepted: false, requestId,
    });
  }, { startUnlocked: true });
});

test("G5: the drain cannot settle an ID whose old wrapper dies while replacement is starting", async () => {
  await withDrain(async ({ sessionId, wrapper, ack }) => {
    const cleanupStarted = Promise.withResolvers<void>();
    const cleanupFinished = Promise.withResolvers<void>();
    wrapper.stopBackgroundWorkForDrain = async () => {
      cleanupStarted.resolve();
      await cleanupFinished.promise;
      return true;
    };
    const receipt = ack();
    await cleanupStarted.promise;
    // Cold startup cannot expose a replacement in the wrapper registry yet;
    // keep the old dead wrapper indexed to exercise the harder stale lookup.
    wrapper.destroy();
    cleanupFinished.resolve();
    expect(await receipt).toMatchObject({ unsettled: [sessionId] });
    expect((await receipt).settled).toBeUndefined();
  });
});

test("G5: cold SSE retries for an acked ID, then opens the same session after failure", async () => {
  await withDrain(async ({ root, sessionId, manager, ack, fail }) => {
    if (!manager) throw new Error("Missing cold session fixture");
    manager.appendMessage(user("previous message"));
    manager.appendMessage(assistant());
    manager.appendCustomEntry("fixture", {});
    await manager.flush();
    cacheSessionPath(sessionId, manager.getSessionFile()!);
    expect(await ack()).toMatchObject({ settled: [sessionId], unsettled: [] });
    globalThis.__ompSessions!.delete(sessionId);

    const agentDir = join(root, "agent");
    mkdirSync(agentDir);
    const previousDir = process.env.PI_CODING_AGENT_DIR;
    const previousRuntime = globalThis.__ompRuntimePromise;
    const authStorage = await AuthStorage.create(join(agentDir, "agent.db"));
    authStorage.keys.setRuntime("anthropic", "fixture-key-no-network");
    const settings = Settings.isolated({
      "memory.backend": "off", "tools.xdev": false, "skills.enabled": false, "includeWorkspaceTree": false,
    });
    const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    globalThis.__ompRuntimePromise = Promise.resolve({ agentDir, settings, authStorage, modelRegistry });
    const abort = new AbortController();
    const events = () => getEvents(new Request(`http://localhost/api/agent/${sessionId}/events?entries=1`, {
      headers: { host: "localhost" }, signal: abort.signal,
    }), { params: Promise.resolve({ id: sessionId }) });
    try {
      const waiting = await events();
      expect(waiting.status).toBe(200);
      expect(waiting.headers.get("content-type")).toBe("text/event-stream");
      expect(await waiting.text()).toBe("retry: 1000\n\n");
      expect(globalThis.__ompSessions?.has(sessionId)).toBe(false);

      fail();
      const connected = await events();
      expect(connected.status).toBe(200);
      const chunk = await connected.body!.getReader().read();
      expect(new TextDecoder().decode(chunk.value)).toContain(`"type":"connected","sessionId":"${sessionId}"`);
      expect(globalThis.__ompSessions?.get(sessionId)?.isAlive()).toBe(true);
    } finally {
      abort.abort();
      await globalThis.__ompSessions?.get(sessionId)?.shutdown();
      globalThis.__ompRuntimePromise = previousRuntime;
      if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousDir;
      authStorage.close();
    }
  }, { cold: true });
}, { timeout: 15_000 });
