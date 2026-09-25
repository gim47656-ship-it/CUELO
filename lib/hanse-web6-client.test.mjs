import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createHanseWeb6Client, parseConsultRecord } = await createJiti(import.meta.url)
  .import("./hanse-web6-client.ts");

const record = {
  sessionId: "session-a",
  startedAt: 10,
  finishedAt: 20,
  elapsedMs: 10,
  model: "gpt-6-pro",
  status: "failed",
  error: "relay unavailable",
};

test("sessionId 없는 과거 전역 기록은 귀속하지 않는다", () => {
  const { sessionId: _sessionId, ...legacy } = record;
  assert.equal(parseConsultRecord(legacy), null);
});

test("client는 authoritative sessionId를 query에 싣고 다른 세션 기록을 버린다", async () => {
  let requestedUrl = "";
  const client = createHanseWeb6Client(async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify({
      consults: [record, { ...record, sessionId: "session-b", error: "wrong session" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const consults = await client.listConsults("session-a");
  assert.equal(requestedUrl, "/api/web6/consults?sessionId=session-a");
  assert.equal(consults.length, 1);
  assert.equal(consults[0].sessionId, "session-a");
  assert.equal(consults[0].error, "relay unavailable");
});

test("빈 sessionId는 네트워크 호출 전에 거절한다", async () => {
  let called = false;
  const client = createHanseWeb6Client(async () => {
    called = true;
    return new Response("{}");
  });
  await assert.rejects(client.listConsults("  "), /sessionId/);
  assert.equal(called, false);
});
