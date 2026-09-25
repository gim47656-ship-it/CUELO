import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ACCOUNT_STATE_POLL_INTERVAL_MS,
  CREDENTIAL_ACTION_TIMEOUT_MS,
  MAIN_PRESETS,
  USAGE_POLL_INTERVAL_MS,
  accountIdentities,
  acquireCredentialAction,
  avatarSrcForSeed,
  createSessionAccountPoller,
  createUsagePoller,
  loadModelStats,
  loadUsage,
  mainPresetSelection,
  providerAccountFace,
  redeemCredentialReset,
  setCredentialEnabled,
} = await jiti.import("./hanse-resource-client.ts");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("Main 프리셋 후보는 계정 자리를 보존하고 상담 전용 자리는 뺀다", () => {
  // SHION은 web6 상담 전용이라 Main 후보가 아니다.
  assert.deepEqual(
    MAIN_PRESETS.map((entry) => entry.alias),
    ["YUKI(유키)", "ISANA(이사나)", "RIN(린)", "MIO(미오)", "NOVA(노바)"],
  );
  // 계정이 여럿인 provider는 자리 번호까지 남아야 화면이 계정을 구분할 수 있다.
  assert.deepEqual(
    MAIN_PRESETS.filter((entry) => entry.provider === "anthropic").map((entry) => entry.oauthPosition),
    [0, 1],
  );
  for (const entry of MAIN_PRESETS) {
    assert.notEqual(entry.switchExample, null);
  }
});

test("프리셋 선택 값은 자리의 모델·계정을 그대로 옮긴다", () => {
  const yuki = MAIN_PRESETS.find((entry) => entry.alias === "YUKI(유키)");
  const mio = MAIN_PRESETS.find((entry) => entry.alias === "MIO(미오)");
  assert.deepEqual(mainPresetSelection(yuki), {
    alias: "YUKI(유키)", provider: "openai-codex", modelId: "gpt-6-astra",
  });
  assert.deepEqual(mainPresetSelection(mio), {
    alias: "MIO(미오)", provider: "anthropic", modelId: "claude-opus-5-5", oauthPosition: 1,
  });
});

test("account faces stay in their intended provider lanes", () => {
  const expectedReserved = [
    ["openai-codex", "YUKI(유키)", "/avatars/yuki.webp"],
    ["opencode-go", "NOVA(노바)", "/avatars/nova.webp"],
    ["b-ai", "ISANA(이사나)", "/avatars/isana.webp"],
    ["web6", "SHION(시온)", "/avatars/shion.webp"],
  ];
  for (const [provider, alias, avatar] of expectedReserved) {
    const face = providerAccountFace(provider);
    assert.equal(face?.alias, alias);
    assert.equal(face && avatarSrcForSeed(face.seed), avatar);
  }
  assert.equal(providerAccountFace("anthropic"), null);

  const codex = accountIdentities([
    { provider: "openai-codex", credentialId: 21 },
    { provider: "openai-codex", credentialId: 22 },
  ]);
  assert.deepEqual(codex.map((account) => account.alias), ["YUKI(유키)", "YUKI(유키)"]);
});

test("Anthropic accounts take their faces in account order, not by local credential id", () => {
  const accounts = (firstId, secondId) => accountIdentities([
    { provider: "anthropic", credentialId: firstId, metadata: { email: "first@example.com" } },
    { provider: "anthropic", credentialId: secondId, metadata: { email: "second@example.com" } },
  ]);

  // 같은 두 계정이면 credential id 가 PC 마다 달라도 같은 얼굴이 나온다 — 순서만 본다.
  for (const [firstId, secondId] of [[11, 12], [9, 11], [101, 7]]) {
    const identities = accounts(firstId, secondId);
    assert.deepEqual(identities.map((account) => account.alias), ["RIN(린)", "MIO(미오)"]);
    assert.deepEqual(
      identities.map((account) => avatarSrcForSeed(account.seed)),
      ["/avatars/rin.webp", "/avatars/mio.webp"],
    );
  }

  // 다른 provider 가 목록에 섞여도 그 provider 의 계정은 순서를 밀지 않는다.
  const mixed = accountIdentities([
    { provider: "openai-codex", credentialId: 8 },
    { provider: "anthropic", credentialId: 9 },
    { provider: "anthropic", credentialId: 11 },
    { provider: "opencode-go", credentialId: 12 },
  ]);
  assert.deepEqual(mixed.map((account) => account.alias), ["YUKI(유키)", "RIN(린)", "MIO(미오)", "NOVA(노바)"]);

  // 자산보다 계정이 많으면 이름만 번호로 갈라 둔다.
  const overflow = accountIdentities([
    { provider: "anthropic", credentialId: 1 },
    { provider: "anthropic", credentialId: 2 },
    { provider: "anthropic", credentialId: 3 },
  ]);
  assert.deepEqual(overflow.map((account) => account.alias), ["RIN(린)", "MIO(미오)", "RIN(린)3"]);
});

test("usage polling starts immediately, repeats every 60 seconds, and reserves refresh=1 for manual refresh", async () => {
  const urls = [];
  let scheduled = null;
  let scheduledDelay = null;
  let cleared = false;
  const results = [];
  const poller = createUsagePoller({
    fetchImpl: async (url) => {
      urls.push(String(url));
      return jsonResponse({ generatedAt: urls.length, reports: [] });
    },
    onResult: (result) => results.push(result),
    setIntervalImpl(callback, delay) {
      scheduled = callback;
      scheduledDelay = delay;
      return 41;
    },
    clearIntervalImpl(handle) {
      assert.equal(handle, 41);
      cleared = true;
    },
  });

  poller.start();
  await settle();
  assert.equal(scheduledDelay, USAGE_POLL_INTERVAL_MS);
  assert.deepEqual(urls, ["/api/sidecars/resource/usage"]);
  assert.equal(results.at(-1).status, "fresh");

  await poller.refresh();
  assert.equal(urls.at(-1), "/api/sidecars/resource/usage?refresh=1");

  scheduled();
  await settle();
  assert.equal(urls.at(-1), "/api/sidecars/resource/usage");
  assert.equal(urls.length, 3);

  poller.setPaused(true);
  scheduled();
  await settle();
  assert.equal(urls.length, 3, "credential work pauses automatic polling");

  poller.setPaused(false);
  scheduled();
  await settle();
  assert.equal(urls.length, 4);
  poller.stop();
  assert.equal(cleared, true);
});

test("model aggregation performs only requested loads and manual refresh uses refresh=1", async () => {
  const urls = [];
  const body = {
    generatedAt: 1,
    range: {},
    overall: { requests: 0, failedRequests: 0, cost: 0, tokens: 0 },
    models: [],
    agents: [],
    daily: [],
  };
  const fetchImpl = async (url) => {
    urls.push(String(url));
    return jsonResponse(body);
  };

  assert.equal((await loadModelStats({ fetchImpl })).status, "fresh");
  await settle();
  assert.deepEqual(urls, ["/api/sidecars/resource/models"], "models do not create an automatic poll");

  assert.equal((await loadModelStats({ fetchImpl, refresh: true })).status, "fresh");
  assert.deepEqual(urls, [
    "/api/sidecars/resource/models",
    "/api/sidecars/resource/models?refresh=1",
  ]);
});

test("failed refresh returns tagged stale data while a first-load failure is a hard error", async () => {
  const previous = { generatedAt: 10, reports: [] };
  const fetchImpl = async () => { throw new TypeError("sidecar unavailable"); };

  const stale = await loadUsage({ fetchImpl, previous, refresh: true });
  assert.equal(stale.status, "stale");
  assert.equal(stale.data, previous);
  assert.equal(stale.error.kind, "network");

  const hardFailure = await loadUsage({ fetchImpl });
  assert.equal(hardFailure.status, "error");
  assert.equal(hardFailure.data, null);
  assert.equal(hardFailure.error.kind, "network");
});

test("credential actions use the exact enable and disable POST contracts", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = String(url);
    calls.push({ url: path, method: init.method, signal: init.signal });
    const disabled = path.endsWith("/disable");
    return jsonResponse({ ok: true, credentialId: 27, disabled });
  };

  const disabled = await setCredentialEnabled(27, false, { fetchImpl });
  const enabled = await setCredentialEnabled(27, true, { fetchImpl });

  assert.deepEqual(disabled, { ok: true, credentialId: 27, disabled: true });
  assert.deepEqual(enabled, { ok: true, credentialId: 27, disabled: false });
  assert.deepEqual(calls.map(({ url, method }) => ({ url, method })), [
    { url: "/api/sidecars/resource/credential/27/disable", method: "POST" },
    { url: "/api/sidecars/resource/credential/27/enable", method: "POST" },
  ]);
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal));
});

test("credential actions enforce a finite timeout and report it distinctly", async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });

  await assert.rejects(
    setCredentialEnabled(9, false, { fetchImpl, timeoutMs: 5 }),
    (error) => error.name === "ResourceClientError" && error.kind === "timeout",
  );
  assert.equal(CREDENTIAL_ACTION_TIMEOUT_MS, 20_000);
});

test("a caller abort is forwarded without being misreported as a network failure", async () => {
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  });
  const controller = new AbortController();
  const pending = loadUsage({ fetchImpl, signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(result.status, "error");
  assert.equal(result.error.kind, "aborted");
});

test("live account polling clears on session change and suppresses the stale response", async () => {
  const pending = new Map();
  const cleared = [];
  const results = [];
  let scheduledDelay = null;
  const poller = createSessionAccountPoller({
    fetchImpl: (url) => new Promise((resolve) => pending.set(String(url), resolve)),
    onClear: (sessionId) => cleared.push(sessionId),
    onResult: (result) => results.push(result.data?.sessionId ?? null),
    setIntervalImpl(_callback, delay) {
      scheduledDelay = delay;
      return 71;
    },
    clearIntervalImpl() {},
  });

  poller.setSessionId("old/session");
  poller.setSessionId("new-session");
  assert.deepEqual(cleared, ["old/session", "new-session"]);
  assert.equal(scheduledDelay, ACCOUNT_STATE_POLL_INTERVAL_MS);

  pending.get("/api/agent/new-session/account")(jsonResponse({
    sessionId: "new-session",
    observedAt: 2,
    state: "resolved",
    credentialId: 22,
    source: "session-pin",
    resetRecommendations: [],
  }));
  await settle();
  assert.deepEqual(results, ["new-session"]);

  pending.get("/api/agent/old%2Fsession/account")(jsonResponse({
    sessionId: "old/session",
    observedAt: 1,
    state: "resolved",
    credentialId: 11,
    source: "session-pin",
    resetRecommendations: [],
  }));
  await settle();
  assert.deepEqual(results, ["new-session"], "late responses from the prior session are discarded");
  poller.stop();
});

test("reset redeem sends exact confirmation data and preserves business outcomes", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({
      url: String(url),
      method: init.method,
      contentType: new Headers(init.headers).get("Content-Type"),
      body: JSON.parse(init.body),
    });
    return jsonResponse({
      ok: false,
      credentialId: 27,
      creditId: "credit-1",
      code: "already_redeemed",
    });
  };
  const result = await redeemCredentialReset(27, "credit-1", { fetchImpl });
  assert.deepEqual(result, {
    ok: false,
    credentialId: 27,
    creditId: "credit-1",
    code: "already_redeemed",
  });
  assert.deepEqual(calls, [{
    url: "/api/sidecars/resource/credential/27/reset",
    method: "POST",
    contentType: "application/json",
    body: { confirm: true, creditId: "credit-1" },
  }]);
});

test("credential action lock makes a double reset submission issue one client request", async () => {
  const lock = new Set();
  let calls = 0;
  let resolveRequest;
  const fetchImpl = () => {
    calls += 1;
    return new Promise((resolve) => {
      resolveRequest = resolve;
    });
  };
  const submit = async () => {
    const release = acquireCredentialAction(lock, 27);
    if (!release) return;
    try {
      return await redeemCredentialReset(27, "credit-1", { fetchImpl });
    } finally {
      release();
    }
  };

  const first = submit();
  const second = submit();
  await settle();
  assert.equal(calls, 1);
  assert.equal(await second, undefined);
  resolveRequest(jsonResponse({ ok: true, credentialId: 27, creditId: "credit-1", code: "reset" }));
  assert.equal((await first).code, "reset");
  assert.equal(lock.size, 0);
});

test("reset infrastructure errors retain code and uncertain-outcome state", async () => {
  await assert.rejects(
    redeemCredentialReset(27, "credit-1", {
      fetchImpl: async () => jsonResponse({
        error: "consume response was lost",
        code: "transport_failed",
        outcomeUnknown: true,
      }, 502),
    }),
    (error) => error.name === "ResourceClientError"
      && error.code === "transport_failed"
      && error.outcomeUnknown === true,
  );
});
