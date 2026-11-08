import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDraftSecretHandler } = await jiti.import("./handler.ts");

const URL_ = "http://localhost:30141/api/live/draft-secret";

function request(body, headers = {}) {
  return new Request(URL_, {
    method: "POST",
    headers: { host: "localhost:30141", "content-type": "application/json", origin: "http://localhost:30141", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A handler whose token and upstream are fakes; `upstream` answers each mint request. */
function setup(upstream) {
  const calls = [];
  let tokens = 0;
  const handler = createDraftSecretHandler({
    withToken: async (attempt) => {
      tokens += 1;
      return await attempt("test-access-token");
    },
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, auth: init.headers.Authorization, language: body.session.audio.output.language, model: body.session.model });
      return upstream(body.session.audio.output.language);
    },
  });
  return { handler, calls, tokens: () => tokens };
}

const ok = (language) => new Response(JSON.stringify({ value: `secret-for-${language}`, expires_at: 1 }), { status: 200 });

test("rejects what is not a trusted JSON request for two different known languages", async () => {
  const { handler, calls } = setup(ok);
  assert.equal((await handler(request({ mine: "ko", theirs: "vi" }, { origin: "https://evil.example" }))).status, 403);
  assert.equal((await handler(request({ mine: "ko", theirs: "vi" }, { "content-type": "text/plain" }))).status, 415);
  assert.equal((await handler(request("not json"))).status, 400);
  assert.equal((await handler(request({ mine: "ko" }))).status, 400);
  assert.equal((await handler(request({ mine: "ko", theirs: "ko" }))).status, 400);
  assert.equal((await handler(request({ mine: "ko", theirs: "xx" }))).status, 400);
  assert.deepEqual(calls, [], "nothing reached the credential or OpenAI");
});

test("mints one secret per language, mine first, with the right output language", async () => {
  const { handler, calls } = setup(ok);
  const response = await handler(request({ mine: "ko", theirs: "vi" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    sessions: [{ language: "ko", secret: "secret-for-ko" }, { language: "vi", secret: "secret-for-vi" }],
  });
  assert.deepEqual(calls.map((call) => [call.language, call.model, call.auth]).sort(), [
    ["ko", "gpt-realtime-translate", "Bearer test-access-token"],
    ["vi", "gpt-realtime-translate", "Bearer test-access-token"],
  ]);
  assert.ok(calls.every((call) => call.url === "https://api.openai.com/v1/realtime/translations/client_secrets"));
});

test("one credential lookup serves both mints", async () => {
  const { handler, tokens } = setup(ok);
  await handler(request({ mine: "en", theirs: "ja" }));
  assert.equal(tokens(), 1);
});

test("an upstream refusal maps to auth or upstream and never carries the token", async () => {
  const unauthorized = setup(() => new Response("expired", { status: 401 }));
  let response = await unauthorized.handler(request({ mine: "ko", theirs: "vi" }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "live-auth");

  const broken = setup(() => new Response("overloaded", { status: 503 }));
  response = await broken.handler(request({ mine: "ko", theirs: "vi" }));
  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error, "live-upstream");
  assert.ok(!JSON.stringify(body).includes("test-access-token"));

  const empty = setup(() => new Response(JSON.stringify({}), { status: 200 }));
  response = await empty.handler(request({ mine: "ko", theirs: "vi" }));
  assert.equal(response.status, 502, "an answer without a secret is not a success");
});

test("a missing credential is the sign-in failure", async () => {
  const handler = createDraftSecretHandler({
    withToken: async () => {
      throw new Error("No Codex OAuth credential is available for the draft captions.");
    },
    fetch: async () => ok("ko"),
  });
  const response = await handler(request({ mine: "ko", theirs: "vi" }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "live-auth");
});
