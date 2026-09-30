import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper, restoreThinkingCeiling } = await jiti.import("./rpc-manager.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { SessionManager } = await jiti.import("@oh-my-pi/pi-coding-agent");

// 실제 SessionManager(메모리)에 쓰고, 모델 문맥은 omp 자신의 buildSessionContext로 본다.
function createSession() {
  const sessionManager = SessionManager.inMemory(process.cwd());
  sessionManager.appendMessage({ role: "user", content: "안녕", timestamp: Date.now() });
  const ceilingCalls = [];
  const inner = {
    sessionId: sessionManager.getSessionId(),
    sessionManager,
    thinkingLevelCeiling: undefined,
    setThinkingLevelCeiling(ceiling, record) {
      ceilingCalls.push([ceiling, record]);
      inner.thinkingLevelCeiling = ceiling;
    },
  };
  const eventBus = { on: () => () => {}, off: () => {}, emit: () => {} };
  return { wrapper: new AgentSessionWrapper(inner, eventBus), inner, sessionManager, ceilingCalls };
}

const ceilingEntries = (sessionManager) =>
  sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "cuelo-thinking-ceiling");

test("set_thinking_ceiling applies the ceiling and records a custom entry the model never sees", async () => {
  const { wrapper, sessionManager, ceilingCalls } = createSession();

  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "high" });

  assert.deepEqual(ceilingCalls, [["high", undefined]]);
  assert.deepEqual(ceilingEntries(sessionManager).map((entry) => entry.data), [{ ceiling: "high" }]);
  const modelContext = JSON.stringify(sessionManager.buildSessionContext().messages);
  assert.equal(modelContext.includes("cuelo-thinking-ceiling"), false);
  assert.equal(sessionManager.buildSessionContext().messages.length, 1);
  // 화면 transcript에도 메시지로 나오지 않고, 상한으로만 읽힌다.
  const shown = buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId());
  assert.equal(shown.messages.length, 1);
  assert.equal(shown.thinkingCeiling, "high");
});

test("a restart restores the latest ceiling without writing to the session", async () => {
  const { wrapper, sessionManager } = createSession();
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "low" });
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "medium" });
  const entriesBefore = sessionManager.getEntries().length;

  const restoredCalls = [];
  restoreThinkingCeiling({
    sessionManager,
    setThinkingLevelCeiling: (ceiling, record) => restoredCalls.push([ceiling, record]),
  });

  assert.deepEqual(restoredCalls, [["medium", false]]);
  assert.equal(sessionManager.getEntries().length, entriesBefore);
});

test("clearing the ceiling records null and a restart restores nothing", async () => {
  const { wrapper, sessionManager, ceilingCalls } = createSession();
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "xhigh" });
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: null });

  assert.deepEqual(ceilingCalls.at(-1), [undefined, undefined]);
  assert.deepEqual(ceilingEntries(sessionManager).map((entry) => entry.data), [{ ceiling: "xhigh" }, { ceiling: null }]);
  assert.equal(buildSessionContext(sessionManager.getEntries(), sessionManager.getLeafId()).thinkingCeiling, null);

  const restoredCalls = [];
  restoreThinkingCeiling({ sessionManager, setThinkingLevelCeiling: (...args) => restoredCalls.push(args) });
  assert.deepEqual(restoredCalls, []);
});

test("an unchanged ceiling is applied again but not recorded twice", async () => {
  const { wrapper, sessionManager, ceilingCalls } = createSession();
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "high" });
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "high" });
  // 기록이 없는 세션에서 해제는 이미 해제 상태라 기록하지 않는다.
  const fresh = createSession();
  await fresh.wrapper.send({ type: "set_thinking_ceiling", ceiling: null });

  assert.equal(ceilingCalls.length, 2);
  assert.equal(ceilingEntries(sessionManager).length, 1);
  assert.equal(ceilingEntries(fresh.sessionManager).length, 0);
});

test("an invalid ceiling is rejected before anything changes", async () => {
  const { wrapper, sessionManager, ceilingCalls } = createSession();

  await assert.rejects(wrapper.send({ type: "set_thinking_ceiling", ceiling: "turbo" }), /Invalid thinking ceiling/);

  assert.deepEqual(ceilingCalls, []);
  assert.equal(ceilingEntries(sessionManager).length, 0);
});

test("get_state reports the session ceiling", async () => {
  const { wrapper, inner } = createSession();
  Object.assign(inner, {
    isStreaming: false,
    isBashRunning: false,
    isCompacting: false,
    queuedMessageCount: 0,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    getContextUsage: () => undefined,
    agent: { state: { thinkingLevel: "medium" } },
    configuredThinkingLevel: () => "auto",
    getTodoPhases: () => [],
  });

  assert.equal((await wrapper.send({ type: "get_state" })).thinkingCeiling, null);
  await wrapper.send({ type: "set_thinking_ceiling", ceiling: "medium" });
  assert.equal((await wrapper.send({ type: "get_state" })).thinkingCeiling, "medium");
});
