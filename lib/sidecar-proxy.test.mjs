import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  SIDECAR_MAX_REQUEST_BODY_BYTES,
  proxySidecarRequest,
  resolveSidecarTarget,
} = await jiti.import("./sidecar-proxy.ts");

test("resolves only the fixed sidecar service, path, and method contracts", () => {
  const allowed = [
    ["GET", "resource", ["usage"], "http://127.0.0.1:30142/usage"],
    ["GET", "resource", ["models"], "http://127.0.0.1:30142/models"],
    ["POST", "resource", ["credential", "27", "enable"], "http://127.0.0.1:30142/credential/27/enable"],
    ["POST", "resource", ["credential", "27", "reset"], "http://127.0.0.1:30142/credential/27/reset"],
    ["POST", "sidechat", ["ask"], "http://127.0.0.1:30143/ask"],
    ["GET", "subagent", ["archive"], "http://127.0.0.1:30144/archive"],
    ["GET", "subagent", ["transcript"], "http://127.0.0.1:30144/transcript"],
  ];
  for (const [method, service, path, url] of allowed) {
    assert.equal(resolveSidecarTarget(method, service, path)?.url, url);
  }

  const denied = [
    ["DELETE", "resource", ["usage"]],
    ["POST", "resource", ["usage"]],
    ["GET", "resource", ["credential", "27", "enable"]],
    ["POST", "resource", ["credential", "0", "enable"]],
    ["POST", "resource", ["credential", "27/../../ask", "enable"]],
    ["POST", "resource", ["allocation", "disable"]],
    ["POST", "resource", ["allocation", "enable"]],
    ["GET", "resource", ["..", "usage"]],
    ["GET", "sidechat", ["ask"]],
    ["POST", "sidechat", ["ask", "extra"]],
    ["POST", "subagent", ["archive"]],
    ["GET", "subagent", ["archive", "extra"]],
    ["GET", "other", ["archive"]],
  ];
  for (const [method, service, path] of denied) {
    assert.equal(resolveSidecarTarget(method, service, path), null);
  }
});

test("forwards fixed URLs and query strings without caller credentials or unsafe response headers", async () => {
  let call;
  const response = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/subagent/archive?session=abc%2Fdef", {
      headers: {
        Host: "localhost",
        Accept: "text/html",
        Authorization: "Basic secret",
        Cookie: "session=secret",
        "X-Forwarded-Host": "attacker.example",
      },
    }),
    "subagent",
    ["archive"],
    async (url, init) => {
      call = { url: String(url), init };
      return new Response("{}", {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          ETag: '"archive-1"',
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "http://127.0.0.1:30141",
          "Set-Cookie": "sidecar=secret",
        },
      });
    },
  );

  assert.equal(call.url, "http://127.0.0.1:30144/archive?session=abc%2Fdef");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "manual");
  assert.deepEqual(Object.fromEntries(call.init.headers), { accept: "application/json" });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.fromEntries(response.headers), {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    etag: '"archive-1"',
  });
});

test("sets the fixed local OMP WEB origin for resource mutations", async () => {
  let forwardedHeaders;
  const response = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/resource/credential/27/disable", {
      method: "POST",
      headers: { Host: "localhost", Origin: "https://omp.example.ts.net" },
    }),
    "resource",
    ["credential", "27", "disable"],
    async (_url, init) => {
      forwardedHeaders = Object.fromEntries(init.headers);
      return Response.json({ ok: true, credentialId: 27, disabled: true });
    },
  );

  assert.equal(response.status, 403, "cross-origin callers are rejected before reaching the sidecar");
  assert.equal(forwardedHeaders, undefined);

  const trustedResponse = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/resource/credential/27/disable", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://localhost" },
    }),
    "resource",
    ["credential", "27", "disable"],
    async (_url, init) => {
      forwardedHeaders = Object.fromEntries(init.headers);
      return Response.json({ ok: true, credentialId: 27, disabled: true });
    },
  );

  assert.equal(trustedResponse.status, 200);
  assert.deepEqual(forwardedHeaders, {
    accept: "application/json",
    origin: "http://127.0.0.1:30141",
  });
});

test("accepts an empty streamed body for bodyless credential POST requests", async () => {
  let forwarded = false;
  const emptyBody = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  const response = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/resource/credential/27/enable", {
      method: "POST",
      headers: { Host: "localhost", Origin: "http://localhost" },
      body: emptyBody,
      duplex: "half",
    }),
    "resource",
    ["credential", "27", "enable"],
    async () => {
      forwarded = true;
      return Response.json({ ok: true, credentialId: 27, disabled: false });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(forwarded, true);
});

test("bounds JSON request bodies and streams NDJSON responses without buffering", async () => {
  const payload = JSON.stringify({ sessionPath: "C:/sessions/a.jsonl", question: "hello", history: [] });
  let call;
  let streamController;
  const upstreamStream = new ReadableStream({
    start(controller) {
      streamController = controller;
      controller.enqueue(new TextEncoder().encode('{"t":"d","v":"hel"}\n'));
    },
  });
  const response = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/sidechat/ask?trace=1", {
      method: "POST",
      headers: {
        Host: "localhost",
        Origin: "http://localhost",
        Authorization: "Basic secret",
        Cookie: "session=secret",
        Accept: "text/html",
        "Content-Type": "application/json; charset=utf-8",
      },
      body: payload,
    }),
    "sidechat",
    ["ask"],
    async (url, init) => {
      call = { url: String(url), init };
      return new Response(upstreamStream, {
        status: 202,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "http://127.0.0.1:30141",
        },
      });
    },
  );

  assert.equal(response.status, 202);
  assert.equal(call.url, "http://127.0.0.1:30143/ask?trace=1");
  assert.deepEqual(Object.fromEntries(call.init.headers), {
    accept: "application/x-ndjson, application/json",
    "content-type": "application/json",
  });
  assert.equal(new TextDecoder().decode(call.init.body), payload);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("connection"), null);

  const reader = response.body.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), '{"t":"d","v":"hel"}\n');
  streamController.enqueue(new TextEncoder().encode('{"t":"done","v":"hello"}\n'));
  streamController.close();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), '{"t":"done","v":"hello"}\n');
  assert.equal((await reader.read()).done, true);
});

test("returns bounded JSON errors for oversized, invalid, and unavailable requests", async () => {
  let fetchCalls = 0;
  const oversized = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/sidechat/ask", {
      method: "POST",
      headers: {
        Host: "localhost",
        "Content-Type": "application/json",
      },
      body: "x".repeat(SIDECAR_MAX_REQUEST_BODY_BYTES + 1),
    }),
    "sidechat",
    ["ask"],
    async () => {
      fetchCalls += 1;
      return new Response();
    },
  );
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: "Request body too large" });

  const unsupportedType = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/sidechat/ask", {
      method: "POST",
      headers: { Host: "localhost", "Content-Type": "text/plain" },
      body: "{}",
    }),
    "sidechat",
    ["ask"],
    async () => {
      fetchCalls += 1;
      return new Response();
    },
  );
  assert.equal(unsupportedType.status, 415);
  assert.deepEqual(await unsupportedType.json(), { error: "Content-Type must be application/json" });

  const escaped = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/resource/usage/extra", {
      headers: { Host: "localhost" },
    }),
    "resource",
    ["usage", "extra"],
    async () => {
      fetchCalls += 1;
      return new Response();
    },
  );
  assert.equal(escaped.status, 404);
  assert.deepEqual(await escaped.json(), { error: "Sidecar route not found" });

  const unavailable = await proxySidecarRequest(
    new Request("http://localhost/api/sidecars/subagent/archive", {
      headers: { Host: "localhost" },
    }),
    "subagent",
    ["archive"],
    async () => {
      fetchCalls += 1;
      throw new Error("secret internal path");
    },
  );
  assert.equal(unavailable.status, 502);
  assert.deepEqual(await unavailable.json(), { error: "Sidecar unavailable" });
  assert.equal(fetchCalls, 1);
});

test("reset forwards only JSON with fixed Origin and preserves business outcomes", async () => {
  let calls = 0;
  const request = new Request("http://localhost/api/sidecars/resource/credential/27/reset", {
    method: "POST", headers: {
      Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json",
      Authorization: "Bearer caller-secret", Cookie: "secret=cookie",
    },
    body: JSON.stringify({ confirm: true, creditId: "exact-credit" }),
  });
  const result = await proxySidecarRequest(request, "resource", ["credential", "27", "reset"], async (_url, init) => {
    calls += 1;
    assert.deepEqual(JSON.parse(new TextDecoder().decode(init.body)), { confirm: true, creditId: "exact-credit" });
    assert.deepEqual(Object.fromEntries(init.headers), {
      accept: "application/json", "content-type": "application/json", origin: "http://127.0.0.1:30141",
    });
    return Response.json({ ok: false, credentialId: 27, creditId: "exact-credit", code: "nothing_to_reset" });
  });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).code, "nothing_to_reset");
  assert.equal(calls, 1);
});

test("a failed reset transport reports unknown outcome without a second upstream call", async () => {
  let calls = 0;
  const result = await proxySidecarRequest(new Request("http://localhost/api/sidecars/resource/credential/27/reset", {
    method: "POST", headers: { Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true, creditId: "exact-credit" }),
  }), "resource", ["credential", "27", "reset"], async () => {
    calls += 1;
    throw new Error("transport-secret");
  });
  assert.equal(result.status, 502);
  assert.deepEqual(await result.json(), {
    error: "Reset outcome unknown", code: "reset_outcome_unknown", outcomeUnknown: true,
  });
  assert.equal(calls, 1);
});
