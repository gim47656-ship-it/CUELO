import { afterEach, describe, expect, test } from "bun:test";
import {
  CLOUD_MAX_CALLS,
  CLOUD_MAX_PENDING_BYTES,
  CLOUD_MAX_UPSTREAM_BACKLOG_BYTES,
  CloudInterpreterError,
  cloudAuthHeaders,
  cloudLiveUrl,
  createCloudCall,
  hasCloudCredentials,
  readCloudConfig,
  requireCloudConfig,
  sendCloudAudio,
  stopCloudCall,
  subscribeCloudCall,
  type CloudRelayEvent,
  type CloudUpstreamSocket,
} from "./cloud-interpreter";
import { classifyGeminiClose } from "./gemini-interpreter-audio";
import { parseInterpreterContext } from "./translator-context";
import { GET as eventsGET } from "../app/api/live/interpret/cloud/events/route";

class Upstream implements CloudUpstreamSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  onopen: CloudUpstreamSocket["onopen"] = null;
  onmessage: CloudUpstreamSocket["onmessage"] = null;
  onerror: CloudUpstreamSocket["onerror"] = null;
  onclose: CloudUpstreamSocket["onclose"] = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  readonly whenClosed = Promise.withResolvers<void>();

  constructor(readonly url: string, readonly headers: Record<string, string>) {}

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    this.whenClosed.resolve();
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
}

const KO = { code: "ko", tag: "ko-KR", englishName: "Korean", nativeName: "한국어" };
const EN = { code: "en", tag: "en-US", englishName: "English", nativeName: "English" };
const CONFIG = { project: "demo-project-1", location: "us-central1" };
const FRAME = Buffer.from(new Uint8Array(640)).toString("base64");

const opened: string[] = [];

/** A reader that keeps every event and has nothing left unsent. */
const collect = (events: CloudRelayEvent[]) => (event: CloudRelayEvent) => {
  events.push(event);
  return 0;
};

async function open(options: { attachTimeoutMs?: number; getToken?: () => Promise<string> } = {}) {
  let upstream!: Upstream;
  const { callId, model } = await createCloudCall({
    config: CONFIG,
    getToken: options.getToken ?? (async () => "token-for-test"),
    mine: KO,
    theirs: EN,
    context: parseInterpreterContext(undefined),
    pace: "normal",
    attachTimeoutMs: options.attachTimeoutMs,
    createSocket: (url, headers) => (upstream = new Upstream(url, headers)),
  });
  opened.push(callId);
  return { callId, model, upstream };
}

afterEach(() => {
  for (const callId of opened.splice(0)) stopCloudCall(callId);
});

describe("Cloud relay call", () => {
  test("connects to the regional endpoint with the bearer header and sends the Vertex setup on open", async () => {
    const { upstream, model } = await open();
    expect(model).toBe("gemini-3.8-live");
    expect(upstream.url).toStartWith("wss://us-central1-aiplatform.googleapis.com/");
    expect(upstream.url).not.toContain("token-for-test");
    expect(upstream.headers).toEqual({ Authorization: "Bearer token-for-test" });
    expect(upstream.sent).toHaveLength(0);
    upstream.open();
    const setup = upstream.sent[0]?.setup as Record<string, unknown>;
    expect(setup.model).toBe("projects/demo-project-1/locations/us-central1/publishers/google/models/gemini-3.8-live");
    expect(setup.systemInstruction).toBeDefined();
  });

  test("events before the reader attaches are replayed in order; a second reader is refused", async () => {
    const { callId, upstream } = await open();
    upstream.open();
    upstream.onmessage?.({ data: '{"serverContent":{}}' });
    upstream.onmessage?.({ data: new TextEncoder().encode('{"usage":1}').buffer });
    const events: CloudRelayEvent[] = [];
    const detach = subscribeCloudCall(callId, collect(events));
    expect(detach).not.toBeNull();
    upstream.onmessage?.({ data: '{"after":true}' });
    expect(events).toEqual([
      { type: "open" },
      { type: "message", data: '{"serverContent":{}}' },
      { type: "message", data: '{"usage":1}' },
      { type: "message", data: '{"after":true}' },
    ]);
    expect(subscribeCloudCall(callId, () => 0)).toBeNull();
  });

  test("detaching the reader ends the call and closes Vertex", async () => {
    const { callId, upstream } = await open();
    upstream.open();
    const detach = subscribeCloudCall(callId, () => 0)!;
    detach();
    expect(upstream.closed).toBe(true);
    expect(sendCloudAudio(callId, [FRAME])).toBe("not-found");
  });

  test("a refused handshake closes with a reason the browser classifies as auth without retry", async () => {
    const { callId, upstream } = await open();
    const events: CloudRelayEvent[] = [];
    subscribeCloudCall(callId, collect(events));
    upstream.readyState = 3;
    upstream.onclose?.({ code: 1006, reason: "" });
    const close = events.at(-1);
    expect(close?.type).toBe("close");
    const info = close?.type === "close" ? classifyGeminiClose(close.code, close.reason) : null;
    expect([info?.failure, info?.retry]).toEqual(["auth", false]);
    expect(sendCloudAudio(callId, [FRAME])).toBe("not-found");
  });

  test("a handshake refused before the reader attaches still reaches that reader with its reason", async () => {
    const { callId, upstream } = await open();
    upstream.readyState = 3;
    upstream.onclose?.({ code: 1006, reason: "" });
    const events: CloudRelayEvent[] = [];
    expect(subscribeCloudCall(callId, collect(events))).not.toBeNull();
    expect(events).toHaveLength(1);
    const close = events[0]!;
    const info = close.type === "close" ? classifyGeminiClose(close.code, close.reason) : null;
    expect([info?.failure, info?.retry]).toEqual(["auth", false]);
    // Told once: a second reader finds nothing.
    expect(subscribeCloudCall(callId, collect([]))).toBeNull();
  });

  test("a drop after the handshake keeps its code and reason", async () => {
    const { callId, upstream } = await open();
    const events: CloudRelayEvent[] = [];
    subscribeCloudCall(callId, collect(events));
    upstream.open();
    upstream.onclose?.({ code: 1011, reason: "Internal error" });
    expect(events.at(-1)).toEqual({ type: "close", code: 1011, reason: "Internal error" });
  });

  test("a call nobody reads is closed after the attach timeout and a late reader learns why", async () => {
    const { callId, upstream } = await open({ attachTimeoutMs: 1 });
    await upstream.whenClosed.promise;
    expect(upstream.closed).toBe(true);
    const events: CloudRelayEvent[] = [];
    subscribeCloudCall(callId, collect(events));
    expect(events).toEqual([{ type: "close", code: 1011, reason: "The interpreter stream was never opened." }]);
  });

  test("unread downstream past the cap fails the call instead of growing", async () => {
    const { callId, upstream } = await open();
    upstream.open();
    const big = "x".repeat(Math.ceil(CLOUD_MAX_PENDING_BYTES / 2) + 1);
    upstream.onmessage?.({ data: big });
    expect(upstream.closed).toBe(false);
    upstream.onmessage?.({ data: big });
    expect(upstream.closed).toBe(true);
    const events: CloudRelayEvent[] = [];
    // The late reader gets only the reason, not the dropped backlog; input is refused.
    subscribeCloudCall(callId, collect(events));
    expect(events).toEqual([{ type: "close", code: 1011, reason: "The interpreter stream was not read in time." }]);
    expect(sendCloudAudio(callId, [FRAME])).toBe("not-found");
  });

  test("an attached reader that stops draining hits the same cap", async () => {
    const { callId, upstream } = await open();
    const events: CloudRelayEvent[] = [];
    let unread = 0;
    subscribeCloudCall(callId, (event) => {
      events.push(event);
      if (event.type === "message") unread += event.data.length;
      return unread;
    });
    upstream.open();
    const big = "x".repeat(Math.ceil(CLOUD_MAX_PENDING_BYTES / 2) + 1);
    upstream.onmessage?.({ data: big });
    expect(upstream.closed).toBe(false);
    upstream.onmessage?.({ data: big });
    expect(upstream.closed).toBe(true);
    expect(events.at(-1)).toEqual({ type: "close", code: 1011, reason: "The interpreter stream was not read in time." });
    expect(sendCloudAudio(callId, [FRAME])).toBe("not-found");
  });

  test("the events route reports what the browser has not downloaded, so a stalled download hits the cap", async () => {
    const { callId, upstream } = await open();
    const response = eventsGET(new Request(`http://localhost:3000/api/live/interpret/cloud/events?callId=${callId}`, {
      headers: { host: "localhost:3000" },
    }));
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    upstream.open();
    const big = "x".repeat(Math.ceil(CLOUD_MAX_PENDING_BYTES / 2) + 1);
    upstream.onmessage?.({ data: big });
    expect(upstream.closed).toBe(false);
    upstream.onmessage?.({ data: big });
    expect(upstream.closed).toBe(true);
    const text = await response.text();
    expect(text.endsWith(`data: ${JSON.stringify({ type: "close", code: 1011, reason: "The interpreter stream was not read in time." })}\n\n`)).toBe(true);
  });

  test("the events route replays an early close and starts no heartbeat for the ended stream", async () => {
    const { callId, upstream } = await open();
    upstream.readyState = 3;
    upstream.onclose?.({ code: 1006, reason: "" });
    const realSetInterval = globalThis.setInterval;
    let intervals = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervals += 1;
      return realSetInterval(...args);
    }) as typeof setInterval;
    try {
      const response = eventsGET(new Request(`http://localhost:3000/api/live/interpret/cloud/events?callId=${callId}`, {
        headers: { host: "localhost:3000" },
      }));
      const text = await response.text();
      expect(text).toContain('"type":"close","code":1006');
      expect(text).toContain("Google Cloud refused the connection");
      expect(intervals).toBe(0);
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });

  test("a missing sign-in fails before any connection", async () => {
    let created = 0;
    let error: unknown;
    try {
      await createCloudCall({
        config: CONFIG,
        getToken: async () => {
          throw new Error("no adc");
        },
        mine: KO,
        theirs: EN,
        context: parseInterpreterContext(undefined),
        pace: "normal",
        createSocket: (url, headers) => {
          created += 1;
          return new Upstream(url, headers);
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect((error as CloudInterpreterError).kind).toBe("live-auth");
    expect(created).toBe(0);
  });

  test("more than the call limit is refused as busy", async () => {
    for (let index = 0; index < CLOUD_MAX_CALLS; index += 1) await open();
    let error: unknown;
    try {
      await open();
    } catch (caught) {
      error = caught;
    }
    expect([(error as CloudInterpreterError).kind, (error as CloudInterpreterError).status]).toEqual(["busy", 429]);
  });
});

describe("Cloud relay input", () => {
  test("valid frames go up as realtime audio once the socket is open", async () => {
    const { callId, upstream } = await open();
    expect(sendCloudAudio(callId, [FRAME])).toBe("not-open");
    upstream.open();
    expect(sendCloudAudio(callId, [FRAME, FRAME])).toBe("sent");
    expect(upstream.sent.slice(1)).toEqual([
      { realtimeInput: { audio: { data: FRAME, mimeType: "audio/pcm;rate=16000" } } },
      { realtimeInput: { audio: { data: FRAME, mimeType: "audio/pcm;rate=16000" } } },
    ]);
  });

  test("malformed batches are refused without touching the call", async () => {
    const { callId, upstream } = await open();
    upstream.open();
    for (const frames of [[], "AAAA", [""], ["not base64!"], [42], Array.from({ length: 51 }, () => FRAME)]) {
      expect(sendCloudAudio(callId, frames)).toBe("bad-request");
    }
    expect(upstream.sent).toHaveLength(1);
    expect(upstream.closed).toBe(false);
  });

  test("an upstream backlog past the cap ends the call", async () => {
    const { callId, upstream } = await open();
    const events: CloudRelayEvent[] = [];
    subscribeCloudCall(callId, collect(events));
    upstream.open();
    upstream.bufferedAmount = CLOUD_MAX_UPSTREAM_BACKLOG_BYTES + 1;
    expect(sendCloudAudio(callId, [FRAME])).toBe("backlog");
    expect(upstream.closed).toBe(true);
    expect(events.at(-1)?.type).toBe("close");
  });
});

describe("Cloud interpreter config", () => {
  test("reads project and location from the Vertex env conventions", () => {
    expect(readCloudConfig({ GOOGLE_CLOUD_PROJECT: "demo-project-1", GOOGLE_CLOUD_LOCATION: "us-central1" }))
      .toEqual({ project: "demo-project-1", location: "us-central1" });
    expect(readCloudConfig({ GCLOUD_PROJECT: " demo-project-1 ", VERTEX_LOCATION: "global" }))
      .toEqual({ project: "demo-project-1", location: "global" });
  });

  test("missing or malformed values give no config instead of a guess", () => {
    expect(readCloudConfig({ GOOGLE_CLOUD_PROJECT: "demo-project-1" })).toBeNull();
    expect(readCloudConfig({ GOOGLE_CLOUD_LOCATION: "us-central1" })).toBeNull();
    expect(readCloudConfig({ GOOGLE_CLOUD_PROJECT: "Demo_Project", GOOGLE_CLOUD_LOCATION: "us-central1" })).toBeNull();
    expect(readCloudConfig({ GOOGLE_CLOUD_PROJECT: "demo-project-1", GOOGLE_CLOUD_LOCATION: "evil.example.com/x" })).toBeNull();
  });

  test("requireCloudConfig fails as not-configured with 503", () => {
    let error: unknown;
    try {
      requireCloudConfig({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudInterpreterError);
    expect([(error as CloudInterpreterError).kind, (error as CloudInterpreterError).status]).toEqual(["not-configured", 503]);
  });

  test("the Live endpoint is regional, or the global host", () => {
    expect(cloudLiveUrl("us-central1")).toBe(
      "wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent",
    );
    expect(cloudLiveUrl("global")).toStartWith("wss://aiplatform.googleapis.com/ws/");
  });
});

describe("Cloud interpreter sign-in", () => {
  test("signed in follows the explicit credential file, else the gcloud user login file", () => {
    const seen: string[] = [];
    const exists = (path: string) => {
      seen.push(path);
      return path === "/srv/sa.json";
    };
    expect(hasCloudCredentials({ GOOGLE_APPLICATION_CREDENTIALS: "/srv/sa.json" }, exists)).toBe(true);
    expect(hasCloudCredentials({}, exists)).toBe(false);
    expect(seen[1]).toEndWith("application_default_credentials.json");
  });

  test("headers carry the ADC access token as a bearer", async () => {
    expect(await cloudAuthHeaders(async () => "token-for-test")).toEqual({ Authorization: "Bearer token-for-test" });
  });

  test("no usable sign-in becomes live-auth 401 without echoing Google's error", async () => {
    let error: unknown;
    try {
      await cloudAuthHeaders(async () => {
        throw new Error("invalid_grant: detail-from-google");
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CloudInterpreterError);
    const failure = error as CloudInterpreterError;
    expect([failure.kind, failure.status]).toEqual(["live-auth", 401]);
    expect(failure.message).not.toContain("detail-from-google");
  });
});
