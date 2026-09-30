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

const timedQuestions = [{
  id: "storage",
  question: "Database?",
  options: [{ label: "SQLite" }, { label: "Postgres" }],
  recommended: 1,
}];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a timed ask that nobody answers settles with its recommendation and closes the browser request", async () => {
  const wrapper = new AgentSessionWrapper(makeInner(), makeEventBus());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const context = wrapper.createExtensionUiContext();

  const answer = context.askDialog(timedQuestions, { timeout: 40 });
  const [request] = events;
  assert.equal(request.timeout, 40);
  assert.deepEqual(await answer, {
    kind: "submit",
    results: [{
      id: "storage",
      question: "Database?",
      options: ["SQLite", "Postgres"],
      multi: false,
      selectedOptions: ["Postgres"],
      timedOut: true,
    }],
  });
  assert.deepEqual(events.at(-1), { ...request, closed: true });
  const replayed = [];
  wrapper.onEvent((event) => replayed.push(event));
  assert.deepEqual(replayed, []);

  // A late browser answer for the closed request is ignored.
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: "{}" });
});

test("choosing or typing in a timed ask restarts its wait so the recommendation never overwrites the answer", async () => {
  const wrapper = new AgentSessionWrapper(makeInner(), makeEventBus());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const context = wrapper.createExtensionUiContext();

  let settled = false;
  const answer = context.askDialog(timedQuestions, { timeout: 80 }).then((value) => {
    settled = true;
    return value;
  });
  const [request] = events;
  await delay(50);
  await wrapper.send({ type: "extension_ui_input", id: request.id, data: "activity" });
  await delay(50);
  assert.equal(settled, false, "the original deadline passed but activity extended it");
  assert.equal(events.length, 1, "activity does not re-send the request to the browser");
  const replayed = [];
  wrapper.onEvent((event) => replayed.push(event));
  assert.equal(replayed[0].id, request.id);
  assert.ok(replayed[0].expiresAt > request.expiresAt, "a reconnect replay carries the extended deadline");

  const submitted = { kind: "submit", results: [{ id: "storage", question: "Database?", options: ["SQLite", "Postgres"], multi: false, selectedOptions: ["SQLite"] }] };
  await wrapper.send({ type: "extension_ui_response", id: request.id, value: JSON.stringify(submitted) });
  assert.deepEqual(await answer, submitted);
  await delay(100);
  assert.equal(events.some((event) => event.closed), false, "the cleared timer never fires after the answer");
});

test("an ask without a valid recommendation still cancels at its deadline and ignores activity when untimed", async () => {
  const wrapper = new AgentSessionWrapper(makeInner(), makeEventBus());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const context = wrapper.createExtensionUiContext();

  const noRecommendation = [{ ...timedQuestions[0], recommended: undefined }];
  assert.equal(await context.askDialog(noRecommendation, { timeout: 20 }), undefined);
  assert.equal(events.at(-1).closed, true);

  const untimed = context.askDialog(timedQuestions, {});
  const request = events.at(-1);
  await wrapper.send({ type: "extension_ui_input", id: request.id, data: "activity" });
  await wrapper.send({ type: "extension_ui_response", id: request.id, cancelled: true });
  assert.equal(await untimed, undefined);
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

async function loadJobManager() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("@oh-my-pi/pi-coding-agent/async/job-manager");
  } catch {
    return import("@oh-my-pi/pi-coding-agent/async/job-manager");
  }
}

test("drain stop cancels a running background task job as a shutdown, waits for its process to exit, and delivers nothing", async () => {
  const { spawn } = await import("node:child_process");
  const { AsyncJobManager, ASYNC_JOB_MANAGER_SHUTDOWN_REASON } = await loadJobManager();
  const delivered = [];
  const manager = new AsyncJobManager({ maxRunningJobs: 4, onJobComplete: (jobId) => delivered.push(jobId) });
  const started = Promise.withResolvers();
  let childPid = 0;
  // task child job과 같은 계약: job signal이 abort되면 그 안에서 돌던 프로세스가 끝나야 job이 끝난다.
  let abortReason;
  const jobId = manager.register("task", "ScalpExitBacktest", async ({ signal }) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    childPid = child.pid;
    const exited = Promise.withResolvers();
    child.once("exit", exited.resolve);
    signal.addEventListener("abort", () => { abortReason = signal.reason; child.kill(); }, { once: true });
    started.resolve();
    await exited.promise;
    return "child finished";
  });
  await started.promise;
  const wrapper = new AgentSessionWrapper(makeInner({ asyncJobManager: manager }), makeEventBus());

  assert.equal(await wrapper.stopBackgroundWorkForDrain(5_000), true);
  assert.equal(manager.getJob(jobId).status, "cancelled");
  // 이 이유여야 코어 실행기가 task child를 tombstone 없이 park해 재시작 뒤 되살릴 수 있다.
  assert.equal(abortReason, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
  assert.throws(() => process.kill(childPid, 0), /ESRCH/);
  // 취소된 job은 결과를 배달하지 않아 drain된 세션의 턴을 다시 깨우지 않는다.
  const settle = Promise.withResolvers();
  setTimeout(settle.resolve, 50);
  await settle.promise;
  assert.deepEqual(delivered, []);
  wrapper.destroy();
  await manager.dispose({ timeoutMs: 1_000 });
});

test("drain stop reports a job that ignores cancellation as unsettled within the deadline", async () => {
  const { AsyncJobManager } = await loadJobManager();
  const manager = new AsyncJobManager({ maxRunningJobs: 4 });
  const stuck = Promise.withResolvers();
  manager.register("task", "stuck-child", () => stuck.promise);
  const wrapper = new AgentSessionWrapper(makeInner({ asyncJobManager: manager }), makeEventBus());

  const startedAt = Date.now();
  assert.equal(await wrapper.stopBackgroundWorkForDrain(200), false);
  assert.ok(Date.now() - startedAt < 2_000);

  stuck.resolve("late");
  wrapper.destroy();
  await manager.dispose({ timeoutMs: 1_000 });
});
