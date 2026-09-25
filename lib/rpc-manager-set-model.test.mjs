import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

// Stand-in for the SDK's ModelRegistry. `find` mirrors the real (provider, modelId)
// signature and fails the same way the SDK does when it is handed a single pre-joined
// "provider/modelId" selector — the regression that made the model picker unusable.
//
// `refreshProvider` is the provider-scoped online pass a lookup miss now uses. The
// full offline reload (`refresh`) used to be called here and could never repair a
// model this process never discovered, so it is counted to prove it stays unused.
function createRegistry({ models, appearAfterDiscovery = false, discoveryGate }) {
  const findCalls = [];
  const refreshProviderCalls = [];
  let fullRefreshes = 0;
  let visible = appearAfterDiscovery ? [] : models;
  const knownProviders = new Set(models.map((model) => model.provider));

  return {
    findCalls,
    refreshProviderCalls,
    fullRefreshes: () => fullRefreshes,
    registry: {
      find(...args) {
        findCalls.push(args);
        const [provider, modelId] = args;
        if (typeof modelId !== "string") {
          throw new TypeError("undefined is not an object (evaluating 'modelId.trim')");
        }
        const wantProvider = provider.trim().toLowerCase();
        const wantModel = modelId.trim().toLowerCase();
        return visible.find(
          (model) => model.provider.toLowerCase() === wantProvider && model.id.toLowerCase() === wantModel,
        );
      },
      hasProvider: (provider) => knownProviders.has(provider),
      getAll: () => models,
      getAvailable: () => visible,
      async refreshProvider(provider, strategy) {
        refreshProviderCalls.push([provider, strategy]);
        if (discoveryGate) await discoveryGate.promise;
        visible = models;
      },
      async refresh() {
        fullRefreshes += 1;
        visible = models;
      },
    },
  };
}

function createWrapper(modelRegistry) {
  const setModelCalls = [];
  const inner = {
    sessionId: "test-session",
    modelRegistry,
    async setModel(model, role) {
      setModelCalls.push([model, role]);
    },
  };
  const eventBus = { on: () => () => {}, off: () => {}, emit: () => {} };
  return { wrapper: new AgentSessionWrapper(inner, eventBus), setModelCalls };
}

test("set_model looks the model up with (provider, modelId), not a joined selector", async () => {
  const { registry, findCalls, refreshProviderCalls, fullRefreshes } = createRegistry({
    models: [{ provider: "openai", id: "gpt-5" }],
  });
  const { wrapper, setModelCalls } = createWrapper(registry);

  const result = await wrapper.send({ type: "set_model", provider: "openai", modelId: "gpt-5" });

  // A hit resolves on the first lookup: no discovery pass is added to the normal path.
  assert.deepEqual(findCalls, [["openai", "gpt-5"]]);
  assert.deepEqual(refreshProviderCalls, []);
  assert.equal(fullRefreshes(), 0);
  assert.deepEqual(result, { id: "gpt-5", provider: "openai" });
  assert.deepEqual(setModelCalls, [[{ provider: "openai", id: "gpt-5" }, undefined]]);
});

test("set_model retries with both arguments after one provider-scoped online discovery pass", async () => {
  const { registry, findCalls, refreshProviderCalls, fullRefreshes } = createRegistry({
    models: [{ provider: "litellm", id: "claude-opus-5" }],
    appearAfterDiscovery: true,
  });
  const { wrapper } = createWrapper(registry);

  const result = await wrapper.send({ type: "set_model", provider: "litellm", modelId: "claude-opus-5" });

  // "online" is forced: the cached row is exactly what the loader discards, so an
  // offline or cache-honoring pass could not bring this model back.
  assert.deepEqual(refreshProviderCalls, [["litellm", "online"]]);
  assert.equal(fullRefreshes(), 0);
  assert.deepEqual(findCalls, [
    ["litellm", "claude-opus-5"],
    ["litellm", "claude-opus-5"],
  ]);
  assert.deepEqual(result, { id: "claude-opus-5", provider: "litellm" });
});

test("concurrent misses on one provider share a single discovery pass", async () => {
  const gate = Promise.withResolvers();
  const { registry, refreshProviderCalls } = createRegistry({
    models: [{ provider: "b-ai", id: "deepseek-v4.1-flash" }],
    appearAfterDiscovery: true,
    discoveryGate: gate,
  });
  const { wrapper } = createWrapper(registry);

  const first = wrapper.send({ type: "set_model", provider: "b-ai", modelId: "deepseek-v4.1-flash" });
  const second = wrapper.send({ type: "set_model", provider: "b-ai", modelId: "deepseek-v4.1-flash" });
  gate.resolve();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(refreshProviderCalls, [["b-ai", "online"]]);
  assert.deepEqual(firstResult, { id: "deepseek-v4.1-flash", provider: "b-ai" });
  assert.deepEqual(secondResult, { id: "deepseek-v4.1-flash", provider: "b-ai" });
});

test("set_model reports an unknown model instead of surfacing an SDK TypeError", async () => {
  const { registry, refreshProviderCalls } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper } = createWrapper(registry);

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "openai", modelId: "does-not-exist" }),
    /Model openai\/does-not-exist is not in the model list after refreshing discovery for provider "openai"/,
  );
  assert.deepEqual(refreshProviderCalls, [["openai", "online"]]);
});

test("set_model names the registered-provider miss when the provider is unknown", async () => {
  const { registry } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper } = createWrapper(registry);

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "not-a-provider", modelId: "gpt-5" }),
    /Unknown model provider "not-a-provider"/,
  );
});

test("set_model passes the role through when one is given", async () => {
  const { registry } = createRegistry({ models: [{ provider: "openai", id: "gpt-5" }] });
  const { wrapper, setModelCalls } = createWrapper(registry);

  const result = await wrapper.send({ type: "set_model", provider: "openai", modelId: "gpt-5", role: "plan" });

  assert.deepEqual(result, { id: "gpt-5", provider: "openai", role: "plan" });
  assert.deepEqual(setModelCalls, [[{ provider: "openai", id: "gpt-5" }, "plan"]]);
});

// 계정 자리 선택은 코어 AuthStorage의 목록·pin 메서드로만 이뤄진다 — 목록에서 자리를
// 해석하고 그 자격증명을 그대로 선호로 설정한 뒤, 같은 목록을 다시 읽어 그 자리가 실제로
// 설정됐는지 확인한다. 단언은 소비자가 보는 최종 상태(모델·configured thinking·선호 계정)와
// 거절 여부로 한다 — 오류 문구나 mock 호출 기록을 고정하지 않는다.
function createAccountWrapper(modelRegistry, {
  accounts,
  pinAccepted = true,
  restorePinAccepted,
  pinTakesEffect = true,
  failListingAfterPin = false,
  model,
  thinking = "auto",
  branch = [],
  failThinkingLevel,
  accountsGate,
  setModelGates = [],
} = {}) {
  const pinCalls = [];
  const thinkingCalls = [];
  let activeCredentialId = accounts.find((account) => account.active)?.credentialId;
  let failNextListing = false;
  const inner = {
    sessionId: "test-session",
    model,
    thinking,
    modelRegistry: {
      ...modelRegistry,
      authStorage: {
        // accountsGate는 목록을 다시 읽기 전에 멈춰 「transaction 진행 중」 창을 만든다.
        async reload() {
          if (accountsGate) await accountsGate;
        },
        oauth: {
          accounts: () => {
            if (failNextListing) {
              failNextListing = false;
              throw new Error("credential store unavailable");
            }
            return accounts.map((account) => ({ ...account, active: account.credentialId === activeCredentialId }));
          },
        },
        sessions: {
          pin(_provider, _sessionId, credentialId) {
            pinCalls.push(credentialId);
            // 첫 pin은 요청한 자리, 그 뒤(복원)는 별도 정책으로 본다.
            const accepted = pinCalls.length === 1 ? pinAccepted : (restorePinAccepted ?? pinAccepted);
            if (!accepted) return false;
            if (pinTakesEffect) activeCredentialId = credentialId;
            if (failListingAfterPin && pinCalls.length === 1) failNextListing = true;
            return true;
          },
          release() {
            activeCredentialId = undefined;
            return true;
          },
        },
      },
    },
    async setModel(next, role) {
      const gate = setModelGates.shift();
      if (gate) await gate.promise;
      inner.model = next;
    },
    setThinkingLevel(level) {
      thinkingCalls.push(level);
      if (level === failThinkingLevel) throw new Error("thinking level is not supported by this model");
      inner.thinking = level;
    },
    configuredThinkingLevel: () => inner.thinking,
    sessionManager: { getBranch: () => branch },
  };
  const eventBus = { on: () => () => {}, off: () => {}, emit: () => {} };
  return {
    wrapper: new AgentSessionWrapper(inner, eventBus),
    inner,
    thinkingCalls,
    activeAccount: () => activeCredentialId,
  };
}

const ANTHROPIC_ACCOUNTS = [
  { credentialId: 7, position: 0, active: false },
  { credentialId: 9, position: 1, active: true },
];
const OPUS = { provider: "anthropic", id: "claude-opus-5" };
const DEEPSEEK = { provider: "b-ai", id: "deepseek-v4.1-flash" };

test("set_model pins the stored account named by its position", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, activeAccount } = createAccountWrapper(registry, { accounts: ANTHROPIC_ACCOUNTS, model: DEEPSEEK });

  const result = await wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 1 });

  // 자리 1의 durable credential id가 세션의 선호 계정이 된다 — 자리와 credential id는 다른 값이다.
  assert.equal(activeAccount(), 9);
  assert.deepEqual(result, { id: "claude-opus-5", provider: "anthropic" });
});

test("set_model keeps the previous model and preference when the account position is gone", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner, activeAccount } = createAccountWrapper(registry, {
    accounts: [{ credentialId: 7, position: 0, active: true }],
    model: DEEPSEEK,
  });

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 1 }),
  );
  // 다른 계정으로 대체하지 않고, 모델과 선호 계정이 스냅샷 그대로 남는다.
  assert.equal(inner.model, DEEPSEEK);
  assert.equal(activeAccount(), 7);
});

test("set_model keeps the previous model and preference when the pin is refused", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner, activeAccount } = createAccountWrapper(registry, {
    accounts: ANTHROPIC_ACCOUNTS,
    pinAccepted: false,
    model: DEEPSEEK,
  });

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 0 }),
  );
  assert.equal(inner.model, DEEPSEEK);
  assert.equal(activeAccount(), 9);
});

test("set_model keeps the model when the account pin fails on the same model", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner } = createAccountWrapper(registry, {
    accounts: ANTHROPIC_ACCOUNTS,
    pinAccepted: false,
    model: OPUS,
  });

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 0 }),
  );
  // 같은 모델을 다시 고른 경우에는 되돌릴 것이 없다 — 모델은 그대로다.
  assert.equal(inner.model, OPUS);
});

test("set_model reports a failure when the pinned position is not the session preference", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner, activeAccount } = createAccountWrapper(registry, {
    accounts: ANTHROPIC_ACCOUNTS,
    // pin이 true를 돌려줘도 목록의 선호가 그 자리로 바뀌지 않으면 성공이 아니다.
    pinTakesEffect: false,
    model: DEEPSEEK,
  });

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 0 }),
  );
  assert.equal(inner.model, DEEPSEEK);
  assert.equal(activeAccount(), 9);
});

test("set_model applies thinking Auto in the same command", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner } = createAccountWrapper(registry, {
    accounts: ANTHROPIC_ACCOUNTS,
    model: DEEPSEEK,
    thinking: "high",
  });

  const result = await wrapper.send({
    type: "set_model",
    provider: "anthropic",
    modelId: "claude-opus-5",
    oauthPosition: 1,
    thinkingLevel: "auto",
  });

  assert.equal(inner.thinking, "auto");
  assert.deepEqual(result, { id: "claude-opus-5", provider: "anthropic" });
});

test("set_model restores model, account, and thinking when the thinking level fails", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner, activeAccount } = createAccountWrapper(registry, {
    accounts: [{ credentialId: 7, position: 0, active: true }, { credentialId: 9, position: 1, active: false }],
    model: DEEPSEEK,
    thinking: "high",
    failThinkingLevel: "auto",
    branch: [{ type: "model_change", model: "b-ai/deepseek-v4.1-flash", role: "default" }],
  });

  await assert.rejects(
    wrapper.send({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-opus-5",
      oauthPosition: 1,
      thinkingLevel: "auto",
    }),
  );
  // 실패한 프리셋은 세 단계를 모두 스냅샷으로 되돌린다.
  assert.equal(inner.model, DEEPSEEK);
  assert.equal(inner.thinking, "high");
  assert.equal(activeAccount(), 7);
});

test("set_model restores the account when the preference cannot be confirmed after pinning", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner, activeAccount } = createAccountWrapper(registry, {
    accounts: [{ credentialId: 7, position: 0, active: true }, { credentialId: 9, position: 1, active: false }],
    model: DEEPSEEK,
    // pin은 자리를 바꿨지만 그 뒤 확인 조회가 실패한다.
    failListingAfterPin: true,
  });

  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 1 }),
  );
  assert.equal(inner.model, DEEPSEEK);
  assert.equal(activeAccount(), 7);
});

test("set_model reports the account restore failure instead of claiming a full rollback", async () => {
  const { registry } = createRegistry({ models: [OPUS] });
  const { wrapper, inner, activeAccount } = createAccountWrapper(registry, {
    accounts: [{ credentialId: 7, position: 0, active: true }, { credentialId: 9, position: 1, active: false }],
    model: DEEPSEEK,
    thinking: "high",
    failThinkingLevel: "auto",
    // 첫 pin(자리 1)은 되지만 복원 pin(자리 0)은 거부된다.
    restorePinAccepted: false,
  });

  const error = await wrapper
    .send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", oauthPosition: 1, thinkingLevel: "auto" })
    .then(() => null, (reason) => reason);

  assert.ok(error, "thinking 실패는 오류로 끝나야 한다");
  // 되돌아간 것과 안 된 것이 실제 상태와 일치해야 한다: 모델·강도는 복원, 계정은 실패.
  assert.equal(inner.model, DEEPSEEK);
  assert.equal(inner.thinking, "high");
  assert.equal(activeAccount(), 9);
  assert.match(String(error.message), /계정 선호/);
});

test("set_model refuses a conflicting model change while a preset is being applied", async () => {
  const gate = Promise.withResolvers();
  const { registry } = createRegistry({ models: [OPUS, DEEPSEEK] });
  const { wrapper, inner } = createAccountWrapper(registry, {
    accounts: ANTHROPIC_ACCOUNTS,
    model: DEEPSEEK,
    accountsGate: gate.promise,
  });

  const preset = wrapper.send({
    type: "set_model",
    provider: "anthropic",
    modelId: "claude-opus-5",
    oauthPosition: 1,
    thinkingLevel: "auto",
  });
  // 목록 조회에서 멈춘 상태 = 프리셋 transaction 진행 중.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5" }),
  );
  await assert.rejects(
    wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5", thinkingLevel: "high" }),
  );
  await assert.rejects(
    wrapper.send({ type: "prompt", content: "hello" }),
  );
  // 무관한 명령은 이 잠금의 대상이 아니다 — steer는 프리셋 오류로 거절되지 않는다.
  const steerOutcome = await wrapper.send({ type: "steer", content: "hello" }).then(
    () => "resolved",
    (error) => String(error?.message ?? error),
  );
  assert.equal(/Main preset|another model change/.test(steerOutcome), false);

  gate.resolve();
  await preset;
  // 거절된 명령은 모델을 건드리지 않았고, transaction이 끝나면 잠금이 풀린다.
  assert.equal(inner.model, OPUS);
  await wrapper.send({ type: "set_model", provider: "b-ai", modelId: "deepseek-v4.1-flash" });
  assert.equal(inner.model, DEEPSEEK);
});

test("a plain model change in flight still blocks a preset until every plain change finishes", async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const { registry } = createRegistry({ models: [OPUS, DEEPSEEK] });
  const { wrapper, inner } = createAccountWrapper(registry, {
    accounts: ANTHROPIC_ACCOUNTS,
    model: DEEPSEEK,
    setModelGates: [first, second],
  });

  // 평범한 모델 변경 둘은 기존처럼 겹쳐서 진행된다.
  const plainA = wrapper.send({ type: "set_model", provider: "anthropic", modelId: "claude-opus-5" });
  const plainB = wrapper.send({ type: "set_model", provider: "b-ai", modelId: "deepseek-v4.1-flash" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // 하나만 끝난 상태에서는 아직 프리셋을 받지 않는다 — 남은 plain이 진행 중이다.
  first.resolve();
  await plainA;
  await assert.rejects(
    wrapper.send({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-opus-5",
      oauthPosition: 1,
      thinkingLevel: "auto",
    }),
  );

  // 둘 다 끝나면 프리셋이 정상 적용된다.
  second.resolve();
  await plainB;
  const result = await wrapper.send({
    type: "set_model",
    provider: "anthropic",
    modelId: "claude-opus-5",
    oauthPosition: 1,
    thinkingLevel: "auto",
  });
  assert.deepEqual(result, { id: "claude-opus-5", provider: "anthropic" });
  assert.equal(inner.model, OPUS);
});
