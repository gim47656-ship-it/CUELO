import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

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

test("dispatches an advertised skill as a user-attributed custom prompt with queued images", async () => {
  const calls = [];
  const image = { type: "image", data: "AQID", mimeType: "image/png" };
  const skillFile = new URL("./fixtures/slash-skill/SKILL.md", import.meta.url);
  let dispatched;
  const dispatchedPromise = new Promise((resolve) => { dispatched = resolve; });
  const wrapper = new AgentSessionWrapper(
    makeInner({
      sessionManager: { getEntries: () => [] },
      skillsSettings: { enableSkillCommands: true },
      skills: [{
        name: "slash-fixture",
        description: "Focused test skill",
        filePath: fileURLToPath(skillFile),
        baseDir: fileURLToPath(new URL("./fixtures/slash-skill/", import.meta.url)),
      }],
      prompt: async (...args) => { calls.push(["plain", ...args]); },
      promptCustomMessage: async (message, options) => {
        calls.push(["skill", message, options]);
        dispatched();
        return true;
      },
    }),
    makeEventBus(),
  );
  await wrapper.send({
    type: "prompt",
    message: "/skill:slash-fixture verify",
    images: [image],
    streamingBehavior: "steer",
  });
  await dispatchedPromise;
  assert.equal(calls.length, 1);
  const [, message, options] = calls[0];
  assert.equal(message.attribution, "user");
  assert.equal(message.details.name, "slash-fixture");
  assert.equal(message.details.args, "verify");
  assert.match(message.content[0].text, /Inspect the supplied argument and attached image together/);
  assert.deepEqual(message.content[1], image);
  assert.deepEqual(options, { streamingBehavior: "steer", queueChipText: "/skill:slash-fixture verify" });
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
