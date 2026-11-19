import assert from "node:assert/strict";
import test from "node:test";

const listeners = new Map();
globalThis.self = {
  location: {
    href: "https://pi.test/sw.js?v=test",
    origin: "https://pi.test",
  },
  addEventListener: (type, listener) => listeners.set(type, listener),
  clients: null,
};

await import("./sw.js");

function dispatchNotificationClick(data) {
  let pending;
  let closed = false;
  listeners.get("notificationclick")({
    notification: {
      data,
      close: () => { closed = true; },
    },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, wasClosed: () => closed };
}

test("notification click focuses an existing client at the session URL", async () => {
  const calls = [];
  const focusedClient = {
    url: "https://pi.test/?session=session-1",
    focus: async () => { calls.push("focus"); },
    navigate: async () => assert.fail("exact client should not navigate"),
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, ["focus"]);
});

test("notification click navigates an existing client to the session", async () => {
  const calls = [];
  const navigatedClient = {
    focus: async () => { calls.push("focus"); },
  };
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      return navigatedClient;
    },
    focus: async () => assert.fail("the navigated client should be focused"),
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    ["navigate", "https://pi.test/?session=session-1"],
    "focus",
  ]);
});

test("notification click opens a window and rejects cross-origin targets", async () => {
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/"]);
});

function dispatchNavigation(url = "https://pi.test/?session=session-1") {
  let pending;
  listeners.get("fetch")({
    request: { method: "GET", mode: "navigate", url },
    respondWith: (promise) => { pending = promise; },
  });
  return pending;
}

async function navigateWith(fetchImpl, { cached = true } = {}) {
  const cacheLookups = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  globalThis.caches = {
    match: async (url) => {
      cacheLookups.push(url);
      return cached ? new Response("OFFLINE_RECOVERY", { status: 200 }) : undefined;
    },
  };
  try {
    const response = await dispatchNavigation();
    return { status: response.status, body: await response.text(), cacheLookups };
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.caches;
  }
}

test("navigation shows the recovery page when the server cannot be reached", async () => {
  const result = await navigateWith(async () => { throw new TypeError("network down"); });
  assert.deepEqual(result, { status: 200, body: "OFFLINE_RECOVERY", cacheLookups: ["/offline.html"] });
});

test("navigation shows the recovery page for gateway errors from a proxy in front of CUELO", async () => {
  for (const status of [502, 504]) {
    const result = await navigateWith(async () => new Response(`GATEWAY_${status}`, { status }));
    assert.deepEqual(result, { status: 200, body: "OFFLINE_RECOVERY", cacheLookups: ["/offline.html"] }, `HTTP ${status}`);
  }
});

test("navigation keeps the server's own 503 so its message stays visible", async () => {
  const result = await navigateWith(async () => new Response("credential file could not be read", { status: 503 }));
  assert.deepEqual(result, { status: 503, body: "credential file could not be read", cacheLookups: [] });
});

test("navigation keeps the gateway error when the recovery page is not cached", async () => {
  const result = await navigateWith(async () => new Response("GATEWAY_502", { status: 502 }), { cached: false });
  assert.deepEqual(result, { status: 502, body: "GATEWAY_502", cacheLookups: ["/offline.html"] });
});
