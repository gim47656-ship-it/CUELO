import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");

function request(body, headers = {}) {
  return new Request("http://localhost/api/gpt6/web6-session", {
    method: "POST",
    headers: {
      host: "localhost",
      "x-forwarded-for": "127.0.0.1",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

test("sessionId와 requestId가 없으면 handle을 발급하지 않고 400으로 거절한다", async () => {
  const response = await POST(request({ sessionId: "session-a" }));
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_argument");
});

test("브라우저 교차 출처 요청은 평문 handleKey 발급 전에 거절한다", async () => {
  const response = await POST(request(
    { sessionId: "session-a", requestId: "request-a" },
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  ));
  assert.equal(response.status, 403);
});

test("JSON이 아닌 요청은 발급 전에 415로 거절한다", async () => {
  const response = await POST(request(
    { sessionId: "session-a", requestId: "request-a" },
    { "content-type": "text/plain" },
  ));
  assert.equal(response.status, 415);
});
