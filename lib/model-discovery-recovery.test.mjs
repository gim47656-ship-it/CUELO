import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createMissingModelRecovery, describeMissingModel, MISSING_MODEL_REFRESH_INTERVAL_MS } = await jiti.import(
  "./model-discovery-recovery.ts",
);
const { findModelWithRecovery, missingModelRecoveryFor, recoverMissingModelRefs } = await jiti.import("./omp-runtime.ts");

function createRegistry({ fail, onRefresh } = {}) {
  const calls = [];
  return {
    calls,
    registry: {
      find() {
        return undefined;
      },
      hasProvider(provider) {
        return provider === "b-ai" || provider === "opencode-go";
      },
      async refreshProvider(provider, strategy) {
        calls.push([provider, strategy]);
        if (fail) throw new Error(fail);
        await onRefresh?.(provider, calls.length);
      },
    },
  };
}

test("concurrent misses share one provider-scoped online pass", async () => {
  const { registry, calls } = createRegistry();
  const recovery = createMissingModelRecovery(registry);

  const [first, second] = await Promise.all([recovery.recover("b-ai"), recovery.recover("b-ai")]);

  assert.deepEqual(calls, [["b-ai", "online"]]);
  assert.deepEqual(first, { outcome: "refreshed", shared: false });
  assert.deepEqual(second, { outcome: "refreshed", shared: true });
});

test("a provider that stays missing is not fetched again inside the window", async () => {
  let clock = 1_000;
  const { registry, calls } = createRegistry();
  const recovery = createMissingModelRecovery(registry, { now: () => clock });

  assert.equal((await recovery.recover("b-ai")).outcome, "refreshed");
  assert.equal((await recovery.recover("b-ai")).outcome, "throttled");
  // A different provider has its own window.
  assert.equal((await recovery.recover("opencode-go")).outcome, "refreshed");
  assert.deepEqual(calls, [
    ["b-ai", "online"],
    ["opencode-go", "online"],
  ]);

  clock += MISSING_MODEL_REFRESH_INTERVAL_MS;
  assert.equal((await recovery.recover("b-ai")).outcome, "refreshed");
  assert.deepEqual(calls, [
    ["b-ai", "online"],
    ["opencode-go", "online"],
    ["b-ai", "online"],
  ]);
});

test("a discovery failure is reported once and does not retry in a loop", async () => {
  const { registry, calls } = createRegistry({ fail: "connect ETIMEDOUT" });
  const recovery = createMissingModelRecovery(registry);

  const failed = await recovery.recover("b-ai");
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.error, "ETIMEDOUT");
  // The failed attempt still consumed the window: the next miss does not fetch again.
  assert.equal((await recovery.recover("b-ai")).outcome, "throttled");
  assert.equal(calls.length, 1);
});

test("a forced lookup bypasses the window, registers the model, and resets the background window", async () => {
  const model = { provider: "b-ai", id: "deepseek-v4.1-flash" };
  let registered = false;
  const calls = [];
  const registry = {
    find(provider, modelId) {
      return registered && provider === model.provider && modelId === model.id ? model : undefined;
    },
    hasProvider(provider) {
      return provider === "b-ai";
    },
    async refreshProvider(provider, strategy) {
      calls.push([provider, strategy]);
      if (calls.length === 2) registered = true;
    },
  };

  assert.equal((await missingModelRecoveryFor(registry).recover("b-ai")).outcome, "refreshed");
  const lookup = await findModelWithRecovery(registry, model.provider, model.id, { forceDiscovery: true });

  assert.deepEqual(lookup, { model });
  assert.equal((await missingModelRecoveryFor(registry).recover("b-ai")).outcome, "throttled");
  assert.deepEqual(calls, [
    ["b-ai", "online"],
    ["b-ai", "online"],
  ]);
});

test("concurrent forced lookups share one provider-scoped online pass", async () => {
  const gate = Promise.withResolvers();
  const calls = [];
  const recovery = createMissingModelRecovery({
    async refreshProvider(provider, strategy) {
      calls.push([provider, strategy]);
      await gate.promise;
    },
  });

  const leader = recovery.recover("b-ai", { force: true });
  const joiner = recovery.recover("b-ai", { force: true });
  gate.resolve();
  const [leaderResult, joinerResult] = await Promise.all([leader, joiner]);

  assert.deepEqual(calls, [["b-ai", "online"]]);
  assert.deepEqual(leaderResult, { outcome: "refreshed", shared: false });
  assert.deepEqual(joinerResult, { outcome: "refreshed", shared: true });
});

test("configured role recovery keeps the normal provider throttle", async () => {
  const { registry, calls } = createRegistry();
  const refs = [{ provider: "b-ai", modelId: "deepseek-v4.1-flash" }];

  await recoverMissingModelRefs(registry, refs);
  await recoverMissingModelRefs(registry, refs);

  assert.deepEqual(calls, [["b-ai", "online"]]);
});

test("a forced discovery failure reports a safe reason instead of a stale-window message", async () => {
  const { registry } = createRegistry({
    fail: 'HTTP 401 Unauthorized; headers={"authorization":"Bearer header-secret"}; body={"apiKey":"body-secret"}',
  });

  const lookup = await findModelWithRecovery(registry, "b-ai", "deepseek-v4.1-flash", { forceDiscovery: true });
  assert.ok(lookup.miss);
  const message = describeMissingModel(lookup.miss);

  assert.match(message, /provider authentication failed \(HTTP 401\)/);
  assert.doesNotMatch(message, /refreshed recently|header-secret|body-secret|authorization|apiKey/);
});

test("a joined pass carries the leader's failure to the joiner", async () => {
  const gate = Promise.withResolvers();
  const calls = [];
  const recovery = createMissingModelRecovery({
    async refreshProvider(provider, strategy) {
      calls.push([provider, strategy]);
      await gate.promise;
      throw new Error("502 bad gateway");
    },
  });

  const leader = recovery.recover("b-ai");
  const joiner = recovery.recover("b-ai");
  gate.resolve();
  const [leaderResult, joinerResult] = await Promise.all([leader, joiner]);

  assert.deepEqual(calls, [["b-ai", "online"]]);
  assert.deepEqual(leaderResult, { outcome: "failed", shared: false, error: "HTTP 502" });
  assert.deepEqual(joinerResult, { outcome: "failed", shared: true, error: "HTTP 502" });
});

test("the miss description names the selector and what discovery actually did", () => {
  const refreshed = { outcome: "refreshed", shared: false };
  assert.equal(
    describeMissingModel({ selector: "b-ai/deepseek-v4.1-flash", provider: "b-ai", providerKnown: true, recovery: refreshed }),
    'Model b-ai/deepseek-v4.1-flash is not in the model list after refreshing discovery for provider "b-ai".',
  );
  assert.match(
    describeMissingModel({ selector: "b-ai/x", provider: "b-ai", providerKnown: true, recovery: { outcome: "throttled", shared: false } }),
    /refreshed recently, so this lookup did not fetch again/,
  );
  assert.match(
    describeMissingModel({
      selector: "b-ai/x",
      provider: "b-ai",
      providerKnown: true,
      recovery: { outcome: "failed", shared: false, error: "connect ETIMEDOUT" },
    }),
    /discovery refresh for provider "b-ai" failed: connect ETIMEDOUT/,
  );
  assert.match(
    describeMissingModel({ selector: "typo/gpt-5", provider: "typo", providerKnown: false, recovery: refreshed }),
    /Unknown model provider "typo"/,
  );
});
