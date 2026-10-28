/**
 * The Codex dictation transport against a local Bun.serve stub. Nothing here reaches ChatGPT, so a pass
 * proves the request CUELO builds and how it reacts to replies, not that the live endpoint accepts it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createCodexTranscriber } from "./codex-transcribe";

type Seen = { method: string; path: string; headers: Headers; fileName: string; fileType: string; fileBytes: number; fields: string[] };

let server: Server<undefined>;
let baseUrl = "";
const seen: Seen[] = [];
let respond: () => Response | Promise<Response> = () => Response.json({ text: "  안녕하세요  " });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const form = await request.formData();
      const file = form.get("file") as File;
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        fileName: file.name,
        fileType: file.type,
        fileBytes: file.size,
        fields: [...form.keys()],
      });
      return respond();
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/backend-api`;
});
afterAll(() => server.stop(true));

const TOKEN = "stub-access-token";
const transcriber = (extra: Partial<Parameters<typeof createCodexTranscriber>[0]> = {}) =>
  createCodexTranscriber({
    getAccess: async () => ({ accessToken: TOKEN, accountId: "acct_stub" }),
    fetch: (input, init) => fetch(input, init),
    baseUrl,
    ...extra,
  });
const mp3 = new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3, 4, 5]);

describe("request", () => {
  test("posts one multipart MP3 named audio.mp3 with the Codex identity and no language field", async () => {
    seen.length = 0;
    respond = () => Response.json({ text: "  안녕하세요  " });
    const text = await transcriber()(mp3, "audio/mpeg");
    expect(text).toBe("안녕하세요");
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request).toMatchObject({ method: "POST", path: "/backend-api/transcribe", fileName: "audio.mp3", fileType: "audio/mpeg", fileBytes: mp3.byteLength });
    expect(request!.fields).toEqual(["file"]);
    expect(request!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request!.headers.get("chatgpt-account-id")).toBe("acct_stub");
    expect(request!.headers.get("originator")).toBe("Codex Desktop");
    expect(request!.headers.get("user-agent")).toMatch(/^Codex Desktop\//);
  });

  test("anything but MP3 is refused locally, before credentials or the network", async () => {
    seen.length = 0;
    let credentialReads = 0;
    const run = transcriber({ getAccess: async () => { credentialReads += 1; return { accessToken: TOKEN }; } });
    await expect(run(mp3, "audio/ogg")).rejects.toThrow(/only MP3/);
    expect(credentialReads).toBe(0);
    expect(seen).toHaveLength(0);
  });

  test("a missing credential fails without a request", async () => {
    seen.length = 0;
    await expect(transcriber({ getAccess: async () => undefined })(mp3, "audio/mpeg")).rejects.toThrow(/No Codex OAuth credential/);
    expect(seen).toHaveLength(0);
  });
});

describe("replies", () => {
  test("an error status is one failed attempt whose message carries only the status, and no retry", async () => {
    seen.length = 0;
    respond = () => new Response(`Error in ASR API ${"x".repeat(2000)}`, { status: 500 });
    const error = await transcriber()(mp3, "audio/mpeg").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toBe("Codex transcription failed (HTTP 500)");
    expect(error.message).not.toContain(TOKEN);
    expect(seen).toHaveLength(1);
  });

  test("an error body that echoes the token or the request headers is not forwarded", async () => {
    respond = () => new Response(`upstream said: Authorization: Bearer ${TOKEN} chatgpt-account-id: acct_stub`, { status: 502 });
    const error = await transcriber()(mp3, "audio/mpeg").catch((e) => e);
    expect(error.message).toContain("HTTP 502");
    expect(error.message).not.toMatch(new RegExp(`${TOKEN}|acct_stub|Authorization`));
  });

  test("a body that is not JSON or has no text is a failure, an empty text is an empty transcript", async () => {
    respond = () => new Response("<html>gateway</html>", { status: 200 });
    await expect(transcriber()(mp3, "audio/mpeg")).rejects.toThrow(/not JSON/);
    respond = () => Response.json({ transcript: "wrong field" });
    await expect(transcriber()(mp3, "audio/mpeg")).rejects.toThrow(/no text/);
    respond = () => Response.json({ text: "" });
    expect(await transcriber()(mp3, "audio/mpeg")).toBe("");
  });

  test("the caller's abort and the request deadline both cancel the request", async () => {
    const release = Promise.withResolvers<void>();
    const arrived = Promise.withResolvers<void>();
    seen.length = 0;
    respond = async () => { arrived.resolve(); await release.promise; return Response.json({ text: "late" }); };
    const controller = new AbortController();
    const pending = transcriber()(mp3, "audio/mpeg", controller.signal);
    await arrived.promise;
    controller.abort();
    await expect(pending).rejects.toThrow();
    // The deadline is the code under test's own timer; 1 ms makes it fire against the still-held reply.
    await expect(transcriber({ timeoutMs: 1 })(mp3, "audio/mpeg")).rejects.toThrow();
    release.resolve();
  });
});
