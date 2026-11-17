import { expect, test } from "bun:test";
import { createTranscribeSecretHandler } from "./handler";
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://127.0.0.1:31882/api/live/transcribe-secret", { method: "POST", headers: { host: "127.0.0.1:31882", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}
test("transcription secret validates trust and language pair before looking up credentials", async () => {
  let calls = 0;
  const handler = createTranscribeSecretHandler({ withToken: async (run) => { calls++; return run("test-token"); }, fetch: async () => Response.json({ value: "test-secret" }) });
  expect((await handler(request({ mine: "ko", theirs: "ja" }, { origin: "https://evil.example" }))).status).toBe(403);
  expect((await handler(request({ mine: "ko", theirs: "ja" }, { "Content-Type": "text/plain" }))).status).toBe(415);
  expect((await handler(request({ mine: "ko", theirs: "ko" }))).status).toBe(400);
  expect((await handler(request(null))).status).toBe(400);
  expect((await handler(request({ mine: "xx", theirs: "ja" }))).status).toBe(400);
  expect(calls).toBe(0);
});
test("one short-lived transcription session restricts inputs to chosen languages with manual endpoints", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const handler = createTranscribeSecretHandler({ withToken: async (run) => run("test-token"), fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ value: "test-secret" }); } });
  const response = await handler(request({ mine: "ko", theirs: "vi" }));
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(await response.json()).toEqual({ secret: "test-secret" });
  expect(calls).toHaveLength(1);
  expect(calls[0].url).toBe("https://api.openai.com/v1/realtime/client_secrets");
  const body = JSON.parse(String(calls[0].init.body));
  expect(body.expires_after.seconds).toBe(60);
  expect(body.session.type).toBe("transcription");
  expect(body.session.audio.input.transcription).toEqual({ model: "gpt-live-transcribe", delay: "low", languages: ["ko", "vi"] });
  expect(body.session.audio.input.turn_detection).toBeNull();
});
test("upstream auth versus outage errors are clear without reflecting credential or response bodies", async () => {
  for (const [status, expected] of [[401, "live-auth"], [403, "live-auth"], [503, "live-upstream"]] as const) {
    const handler = createTranscribeSecretHandler({ withToken: async (run) => run("secret-token"), fetch: async () => new Response("secret-token", { status }) });
    const response = await handler(request({ mine: "ko", theirs: "ja" }));
    expect(await response.json()).toEqual({ error: expected });
    expect(response.status).toBe(status === 503 ? 502 : 401);
  }
});
