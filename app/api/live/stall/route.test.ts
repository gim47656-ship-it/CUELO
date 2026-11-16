import { afterEach, beforeEach, expect, spyOn, test, type Mock } from "bun:test";
import { POST } from "./route";

let warn: Mock<typeof console.warn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

function request(body: string, contentType = "application/json") {
  return new Request("http://127.0.0.1:30141/api/live/stall", {
    method: "POST",
    headers: { host: "127.0.0.1:30141", "content-type": contentType },
    body,
  });
}

const stall = { kind: "stall", durationMs: 812, phase: "listening", face: true, segmentCount: 42 };

test("a valid report is logged one line per event and answered 204", async () => {
  const response = await POST(request(JSON.stringify({ events: [stall, { kind: "face-on", trigger: "restore", phase: "idle", face: true, segmentCount: 0 }] })));
  expect(response.status).toBe(204);
  expect(warn.mock.calls.map((call) => call[0])).toEqual([
    "[translator] stall 812ms phase=listening face=true segments=42",
    "[translator] face-on trigger=restore phase=idle face=true segments=0",
  ]);
});

test("text fields and bad types are rejected with 400 and nothing is logged", async () => {
  for (const body of [
    JSON.stringify({ events: [{ ...stall, text: "통역 내용" }] }),
    JSON.stringify({ events: [{ ...stall, durationMs: "812" }] }),
    JSON.stringify({ events: [{ ...stall, phase: "listening; rm -rf" }] }),
    "{not json",
    JSON.stringify({ events: [stall], padding: "x".repeat(5000) }),
  ]) {
    expect((await POST(request(body))).status).toBe(400);
  }
  expect(warn).not.toHaveBeenCalled();
});

test("non-JSON content type and cross-site requests are refused", async () => {
  expect((await POST(request(JSON.stringify({ events: [stall] }), "text/plain"))).status).toBe(415);
  const crossSite = new Request("http://127.0.0.1:30141/api/live/stall", {
    method: "POST",
    headers: { host: "127.0.0.1:30141", "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ events: [stall] }),
  });
  expect((await POST(crossSite)).status).toBe(403);
});
