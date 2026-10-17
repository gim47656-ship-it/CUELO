import { expect, test } from "bun:test";
import { gunzipSync } from "node:zlib";
import { acceptsGzip, compressedJson } from "./compressed-json";

test("gzip를 받는 요청에는 압축해 보내고, 풀면 원래 JSON이다", async () => {
  const body = { context: { messages: Array.from({ length: 200 }, (_, i) => ({ role: "user", content: `메시지 ${i}` })) } };
  const res = compressedJson(new Request("http://x/", { headers: { "accept-encoding": "gzip, deflate, br" } }), body, { status: 201 });
  expect(res.status).toBe(201);
  expect(res.headers.get("content-encoding")).toBe("gzip");
  expect(res.headers.get("vary")).toContain("Accept-Encoding");
  const raw = new Uint8Array(await res.arrayBuffer());
  expect(JSON.parse(gunzipSync(raw).toString("utf8"))).toEqual(body);
});

test("gzip를 받지 않는 요청에는 평문 JSON을 보낸다", async () => {
  const res = compressedJson(new Request("http://x/"), { ok: true });
  expect(res.headers.get("content-encoding")).toBeNull();
  expect(await res.json()).toEqual({ ok: true });
});

test("q=0으로 거절한 gzip은 받지 않는 것으로 본다", () => {
  expect(acceptsGzip("gzip;q=0, br")).toBe(false);
  expect(acceptsGzip("br, *;q=0")).toBe(false);
  expect(acceptsGzip("br, gzip;q=0.5")).toBe(true);
  expect(acceptsGzip("identity")).toBe(false);
  // 명시한 gzip 거절은 와일드카드보다 우선한다.
  expect(acceptsGzip("gzip;q=0, *;q=1")).toBe(false);
  expect(acceptsGzip("*;q=0, gzip")).toBe(true);
});
