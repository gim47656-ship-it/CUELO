import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

/**
 * Mirrors the SDK model-controls contract: a model with no service-tier family
 * refuses `/fast` entirely; a family may be set to priority yet not realized on
 * the wire (`active` false), e.g. after the provider rejected Anthropic fast mode.
 */
function fakeSession({ family = "anthropic", realized = true, initial = false } = {}) {
  const calls = [];
  let tier = initial;
  const inner = {
    sessionId: "fast-session",
    sessionFile: "/tmp/cuelo-fast.jsonl",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: true,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    agent: { state: { thinkingLevel: "high" } },
    configuredThinkingLevel: () => "high",
    queuedMessageCount: 0,
    getContextUsage: () => undefined,
    getQueuedMessages: () => ({ steering: [], followUp: [] }),
    getTodoPhases: () => [],
    setThinkingLevel: (level) => calls.push(["thinking", level]),
    isFastModeEnabled: () => tier,
    isFastModeActive: () => tier && realized,
    setFastMode(enabled) {
      calls.push(["fast", enabled]);
      if (!family) return false;
      tier = enabled;
      return true;
    },
  };
  return { wrapper: new AgentSessionWrapper(inner, { on: () => () => {} }), calls, inner };
}

test("켜기·끄기는 세션이 실제로 가진 요청·적용 상태를 돌려주고 추론 강도는 건드리지 않는다", async () => {
  const { wrapper, calls } = fakeSession();
  assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: true }), { enabled: true, active: true });
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.fastModeEnabled, true);
  assert.equal(state.fastModeActive, true);
  assert.equal(state.thinkingLevel, "high");
  assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: false }), { enabled: false, active: false });
  assert.deepEqual(calls, [["fast", true], ["fast", false]]);
});

test("요청은 걸렸지만 이 모델·계정에서 실리지 않으면 active false로 따로 알린다", async () => {
  const { wrapper } = fakeSession({ realized: false });
  assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: true }), { enabled: true, active: false });
});

test("Fast가 없는 모델에서 켜기는 실패하고, 끄기 거절은 오류로 보지 않는다", async () => {
  const { wrapper } = fakeSession({ family: null });
  await assert.rejects(wrapper.send({ type: "set_fast_mode", enabled: true }), /unavailable for the current model/);
  assert.deepEqual(await wrapper.send({ type: "set_fast_mode", enabled: false }), { enabled: false, active: false });
});

test("이미 켜져 있던 세션은 상태 조회로 켜짐을 알린다", async () => {
  const { wrapper } = fakeSession({ initial: true });
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.fastModeEnabled, true);
});

test("값이 없는 요청은 아무것도 바꾸지 않는다", async () => {
  const { wrapper, calls } = fakeSession();
  await assert.rejects(wrapper.send({ type: "set_fast_mode" }), /boolean enabled/);
  assert.deepEqual(calls, []);
});
