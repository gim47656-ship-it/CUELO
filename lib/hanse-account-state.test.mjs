import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true });
const { getSessionAccountState } = await jiti.import("./hanse-account-state.ts");

const now = Date.now();
function fixture(provider = "openai-codex") {
  let selected = 1;
  let siblingHealth = "depleted";
  const session = {
    model: { provider, id: provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-5.4" },
    listCurrentProviderOAuthAccounts: async () => ({ provider, accounts: [1, 2].map(id => ({
      credentialId: id, position: id - 1, email: "same@example.test", accountId: `workspace-${id}`, active: id === selected,
    })) }),
    settings: { getGroup: () => ({ minBlockedMinutes: 60, keepCredits: 0, salvageHorizonHours: 12 }) },
    modelRegistry: { authStorage: { health: { model: async () => ({
      state: siblingHealth === "depleted" ? "depleted" : siblingHealth,
      accounts: [{ credentialId: 1, state: "depleted" }, { credentialId: 2, state: siblingHealth }],
    }) } } },
  };
  const report = {
    provider, credentialId: 1, disabled: false, fetchedAt: now,
    metadata: { accountId: "workspace-1", email: "same@example.test", limitReached: true },
    limits: [{ id: provider === "anthropic" ? "anthropic:5h" : "openai-codex:primary",
      amount: { usedFraction: 1, unit: "percent" }, status: "exhausted",
      scope: { provider }, window: { id: "5h", durationMs: 5 * 3_600_000, resetsAt: now + 2 * 3_600_000 } }],
    savedReset: { state: "available", availableCount: 1, redeemableCount: 1, eligible: true,
      nextCreditId: "credit-1",
      credits: [{ id: "credit-1", expiresAt: new Date(now + 48 * 3_600_000).toISOString(),
        usable: true, remainingCount: 1, clears: ["anthropic:5h"], blocking: ["anthropic:5h"] }] },
  };
  const readUsage = async () => ({ brokerOk: true, reports: [report] });
  return { session, report, readUsage, select: id => { selected = id; }, sibling: state => { siblingHealth = state; } };
}

test("active evidence is the exact live pin, not reset active or a recent usage timestamp", async () => {
  const f = fixture();
  const state = await getSessionAccountState("s", f.session, f.readUsage, now);
  assert.equal(state.credentialId, 1);
  assert.equal(state.source, "session-pin");
  f.select(2);
  assert.equal((await getSessionAccountState("s", f.session, f.readUsage, now)).credentialId, 2);
  f.select(undefined);
  f.report.lastUsedAtMs = now;
  f.report.savedReset.active = true;
  const unpinned = await getSessionAccountState("s", f.session, f.readUsage, now);
  assert.equal(unpinned.state, "unresolved");
  assert.equal(unpinned.credentialId, undefined);
  assert.equal(unpinned.source, undefined);
});

test("absent and unsupported sessions do not start or query management", async () => {
  const forbidden = async () => { throw new Error("should not query"); };
  assert.equal((await getSessionAccountState("missing", undefined, forbidden, now)).state, "not-running");
  assert.equal((await getSessionAccountState("api-key", { model: { provider: "openai", id: "m" } }, forbidden, now)).state, "unsupported");
});

test("healthy, reserve and unknown siblings prevent a blocked-account recommendation", async () => {
  const f = fixture();
  const blocked = await getSessionAccountState("s", f.session, f.readUsage, now);
  assert.deepEqual(blocked.resetRecommendations, [{
    credentialId: 1, reason: "blocked-account", naturalResetAt: now + 2 * 3_600_000,
    expiresAt: f.report.savedReset.credits[0].expiresAt,
  }]);
  for (const state of ["healthy", "reserve", "unknown"]) {
    f.sibling(state);
    assert.deepEqual((await getSessionAccountState("s", f.session, f.readUsage, now)).resetRecommendations, []);
  }
});

test("recommendation uses core salvage threshold and ignores OFF or stale reports", async () => {
  const f = fixture();
  f.sibling("healthy");
  f.report.savedReset.credits[0].expiresAt = new Date(now + 11 * 3_600_000).toISOString();
  f.report.limits[0].amount.usedFraction = 0.25;
  const result = await getSessionAccountState("s", f.session, f.readUsage, now);
  assert.equal(result.resetRecommendations[0].reason, "expiring-credit");
  assert.equal(result.resetRecommendations[0].usedFraction, 0.25);
  assert.equal(result.resetRecommendations[0].window, "5h");
  f.report.limits[0].amount.usedFraction = 0.249;
  assert.deepEqual((await getSessionAccountState("s", f.session, f.readUsage, now)).resetRecommendations, []);
  f.report.limits[0].amount.usedFraction = 1;
  f.report.disabled = true;
  assert.deepEqual((await getSessionAccountState("s", f.session, f.readUsage, now)).resetRecommendations, []);
  f.report.disabled = false;
  f.report.fetchedAt = now - 11 * 60_000;
  assert.deepEqual((await getSessionAccountState("s", f.session, f.readUsage, now)).resetRecommendations, []);
});

test("Anthropic recommendations require an exhausted window covered by the selected reset", async () => {
  const fiveHour = fixture("anthropic");
  const fiveHourState = await getSessionAccountState("claude", fiveHour.session, fiveHour.readUsage, now);
  assert.deepEqual(fiveHourState.resetRecommendations, [{
    credentialId: 1,
    reason: "blocked-account",
    naturalResetAt: now + 2 * 3_600_000,
    expiresAt: fiveHour.report.savedReset.credits[0].expiresAt,
    window: "5h",
    scope: "5시간 한도",
  }]);

  const weeklyOnly = fixture("anthropic");
  weeklyOnly.report.limits = [{
    id: "anthropic:7d",
    status: "exhausted",
    amount: { usedFraction: 1, unit: "percent" },
    scope: { provider: "anthropic" },
    window: { resetsAt: now + 6 * 24 * 3_600_000 },
  }];
  weeklyOnly.report.savedReset.credits[0].blocking = [];
  assert.deepEqual((await getSessionAccountState("claude", weeklyOnly.session, weeklyOnly.readUsage, now)).resetRecommendations, []);

});

test("unavailable Anthropic reset status or usage read does not invent a recommendation", async () => {
  const f = fixture("anthropic");
  f.report.savedReset = { state: "unavailable", availableCount: null, credits: [] };
  assert.deepEqual((await getSessionAccountState("claude", f.session, f.readUsage, now)).resetRecommendations, []);
  const state = await getSessionAccountState("claude", f.session, async () => { throw new Error("offline"); }, now);
  assert.deepEqual(state.resetRecommendations, []);
});

test("pin changes during quota IO do not return the old badge or recommendation", async () => {
  const f = fixture();
  const result = await getSessionAccountState("s", f.session, async () => {
    f.select(2);
    return f.readUsage();
  }, now);
  assert.equal(result.state, "unresolved");
  assert.equal(result.credentialId, undefined);
  assert.deepEqual(result.resetRecommendations, []);
});
