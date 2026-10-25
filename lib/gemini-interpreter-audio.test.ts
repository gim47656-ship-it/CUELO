import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, test } from "bun:test";
import { Pcm16Downsampler } from "../public/gemini-interpreter-worklet.js";
import {
  AudioBacklogError,
  CloudRelaySocket,
  RELAY_BATCH_MS,
  RELAY_FRAMES_PER_REQUEST,
  arrayBufferToBase64,
  classifyGeminiClose,
  decodePcm16Base64Into,
  GEMINI_LIVE_WS_URL,
  GeminiAudioPlayer,
  GeminiLiveSession,
  MAX_SOCKET_BACKLOG_BYTES,
  pcm16SampleCount,
  pcmRateFromMime,
  SETUP_TIMEOUT_MS,
  USER_TRANSCRIPT_IDLE_MS,
  USER_TRANSCRIPT_SETTLE_MS,
  type AudioContextLike,
  type GeminiCloseInfo,
  type GeminiSocketLike,
  type GeminiTranscriptEvent,
} from "./gemini-interpreter-audio";

describe("capture downsampler (worklet)", () => {
  test("48 kHz becomes 16 kHz PCM16 frames, emitted only when full and never reused", () => {
    const frames: Int16Array[] = [];
    const downsampler = new Pcm16Downsampler(48_000, (buffer: ArrayBuffer) => frames.push(new Int16Array(buffer)), 16_000, 4);
    downsampler.push(new Float32Array(9).fill(0.5)); // 3 output samples: not a full frame yet
    expect(frames).toHaveLength(0);
    downsampler.push(new Float32Array(3).fill(-1)); // 4th sample completes the frame
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0]!)).toEqual([16_384, 16_384, 16_384, -32_768]);
    downsampler.push(new Float32Array(12).fill(2)); // clamped, written into a fresh frame
    expect(Array.from(frames[0]!)).toEqual([16_384, 16_384, 16_384, -32_768]);
    expect(Array.from(frames[1]!)).toEqual([32_767, 32_767, 32_767, 32_767]);
  });

  test("a non-integer ratio keeps the long-run rate exact", () => {
    let samples = 0;
    const downsampler = new Pcm16Downsampler(44_100, (buffer: ArrayBuffer) => {
      samples += buffer.byteLength / 2;
    }, 16_000, 160);
    for (let quantum = 0; quantum < 44_100 / 128 * 10; quantum += 1) downsampler.push(new Float32Array(128));
    expect(Math.abs(samples - 160_000)).toBeLessThanOrEqual(160);
  });
});

describe("PCM codec", () => {
  test("decodes little-endian PCM16 into floats", () => {
    const bytes = Uint8Array.from([0x00, 0x80, 0xff, 0x7f, 0x01, 0x00, 0xff, 0xff]);
    const base64 = Buffer.from(bytes).toString("base64");
    expect(pcm16SampleCount(base64)).toBe(4);
    const out = new Float32Array(4);
    expect(decodePcm16Base64Into(base64, out)).toBe(4);
    expect(Array.from(out)).toEqual([-1, 32_767 / 32_768, 1 / 32_768, -1 / 32_768]);
  });

  test("sample count honours base64 padding; encoder round-trips", () => {
    expect(pcm16SampleCount(Buffer.alloc(6).toString("base64"))).toBe(3);
    expect(pcm16SampleCount(Buffer.alloc(10).toString("base64"))).toBe(5);
    const source = Uint8Array.from({ length: 70_001 }, (_, i) => (i * 31) & 0xff);
    expect(Buffer.from(arrayBufferToBase64(source.buffer), "base64").equals(Buffer.from(source))).toBe(true);
  });

  test("output rate comes from the MIME type", () => {
    expect(pcmRateFromMime("audio/pcm;rate=24000")).toBe(24_000);
    expect(pcmRateFromMime("audio/pcm; rate=16000")).toBe(16_000);
    expect(pcmRateFromMime("audio/pcm")).toBe(24_000);
  });
});

interface FakeSource {
  startedAt: number | null;
  stopped: boolean;
}

function fakeAudioContext() {
  const sources: FakeSource[] = [];
  const context = {
    currentTime: 10,
    destination: "speaker",
    createBuffer: (_channels: number, length: number, rate: number) => {
      const data = new Float32Array(length);
      return { duration: length / rate, getChannelData: () => data };
    },
    createBufferSource: () => {
      const record: FakeSource = { startedAt: null, stopped: false };
      sources.push(record);
      return {
        buffer: null as unknown,
        onended: null as ((event: Event) => void) | null,
        connect: () => undefined,
        start: (when?: number) => {
          record.startedAt = when ?? 0;
        },
        stop: () => {
          record.stopped = true;
        },
      };
    },
  } satisfies AudioContextLike<string>;
  return { context, sources };
}

const pcm = (samples: number) => Buffer.alloc(samples * 2).toString("base64");

describe("output player", () => {
  test("chunks play back to back at the MIME rate; interrupt stops all queued audio", () => {
    const { context, sources } = fakeAudioContext();
    const player = new GeminiAudioPlayer(context);
    player.play(pcm(24_000), "audio/pcm;rate=24000");
    player.play(pcm(12_000), "audio/pcm;rate=24000");
    expect(sources.map((source) => source.startedAt)).toEqual([10, 11]);
    expect(player.queuedSeconds).toBeCloseTo(1.5);
    player.interrupt();
    expect(sources.every((source) => source.stopped)).toBe(true);
    expect(player.queuedSeconds).toBe(0);
    player.play(pcm(2_400), "audio/pcm;rate=24000");
    expect(sources[2]!.startedAt).toBe(10);
  });

  test("a backlog past the cap is an error, not silent loss or growth", () => {
    const { context, sources } = fakeAudioContext();
    const player = new GeminiAudioPlayer(context, 2);
    player.play(pcm(24_000), "audio/pcm;rate=24000");
    expect(() => player.play(pcm(36_000), "audio/pcm;rate=24000")).toThrow(AudioBacklogError);
    expect(sources).toHaveLength(1);
  });
});

class FakeSocket implements GeminiSocketLike {
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "blob";
  onopen: GeminiSocketLike["onopen"] = null;
  onmessage: GeminiSocketLike["onmessage"] = null;
  onerror: GeminiSocketLike["onerror"] = null;
  onclose: GeminiSocketLike["onclose"] = null;
  sent: Record<string, unknown>[] = [];
  closedByClient = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closedByClient = true;
    this.readyState = 3;
    // A real socket reports the close later; the session must ignore it.
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: "" }));
  }

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(message: unknown, binary = false) {
    const text = JSON.stringify(message);
    this.onmessage?.({ data: binary ? new TextEncoder().encode(text).buffer : text });
  }

  serverClose(code: number, reason: string) {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

class ManualTimers {
  next = 1;
  time = 0;
  now = () => this.time;
  pending = new Map<number, { fn: () => void; ms: number }>();
  /** The delay of the one pending timer other than the setup deadline. */
  userDelay() {
    return [...this.pending.values()].filter((timer) => timer.ms !== SETUP_TIMEOUT_MS).map((timer) => timer.ms);
  }
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.pending.set(id, { fn, ms });
    return id;
  };
  clearTimeout = (handle: unknown) => {
    this.pending.delete(handle as number);
  };
  runAll() {
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const timer of due) timer.fn();
  }
  runUser() {
    for (const [id, timer] of this.pending) {
      if (timer.ms === SETUP_TIMEOUT_MS) continue;
      this.pending.delete(id);
      timer.fn();
    }
  }
}

function openSession() {
  const transcripts: GeminiTranscriptEvent[] = [];
  const closes: GeminiCloseInfo[] = [];
  const log: string[] = [];
  const timers = new ManualTimers();
  let socket!: FakeSocket;
  const session = new GeminiLiveSession("auth_tokens/abc", "gemini-3.8-live", {
    onReady: () => log.push("ready"),
    onTranscript: (event) => {
      transcripts.push(event);
      log.push(`${event.role}:${event.final ? "final" : "partial"}`);
    },
    onAudio: () => log.push("audio"),
    onInterrupted: () => log.push("interrupted"),
    onGoAway: () => log.push("goAway"),
    onClose: (info) => {
      closes.push(info);
      log.push("close");
    },
  }, (url) => (socket = new FakeSocket(url)), timers);
  socket.open();
  return { session, socket, transcripts, closes, log, timers };
}

const finals = (events: GeminiTranscriptEvent[]) => events.filter((event) => event.final).map((event) => [event.role, event.text]);

describe("live session", () => {
  test("connects with the token and sends only the model in its setup frame", () => {
    const { socket } = openSession();
    expect(socket.url).toBe(`${GEMINI_LIVE_WS_URL}?access_token=auth_tokens%2Fabc`);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(socket.sent).toEqual([{ setup: { model: "models/gemini-3.8-live" } }]);
  });

  test("audio is refused before setupComplete and sent as 16 kHz PCM after it", () => {
    const { session, socket } = openSession();
    expect(session.sendAudio(new ArrayBuffer(4))).toBe(false);
    socket.receive({ setupComplete: {} }, true);
    expect(session.sendAudio(Uint8Array.from([1, 2, 3, 4]).buffer)).toBe(true);
    expect(socket.sent[1]).toEqual({ realtimeInput: { audio: { data: "AQIDBA==", mimeType: "audio/pcm;rate=16000" } } });
  });

  test("each role accumulates and completes on its own; late input after turnComplete stays in its turn", () => {
    const { socket, transcripts, timers } = openSession();
    socket.receive({ setupComplete: {} });
    socket.receive({ serverContent: { inputTranscription: { text: "안녕하세요," } } });
    socket.receive({ serverContent: { outputTranscription: { text: "Hello," } } });
    socket.receive({ serverContent: { outputTranscription: { text: " nice day." } } });
    socket.receive({ serverContent: { generationComplete: true } });
    socket.receive({ serverContent: { turnComplete: true } });
    // Input transcription is unordered against the model turn: this piece arrives after turnComplete.
    socket.receive({ serverContent: { inputTranscription: { text: " 날씨가 좋네요." } } });
    expect(timers.pending.size).toBe(1);
    expect([...timers.pending.values()][0]!.ms).toBe(USER_TRANSCRIPT_SETTLE_MS);
    timers.runAll();
    expect(transcripts.filter((event) => !event.final).map((event) => event.text)).toEqual([
      "안녕하세요,", "Hello,", "Hello, nice day.", "안녕하세요, 날씨가 좋네요.",
    ]);
    expect(finals(transcripts)).toEqual([["assistant", "Hello, nice day."], ["user", "안녕하세요, 날씨가 좋네요."]]);
    // The next utterance opens a new user turn.
    socket.receive({ serverContent: { inputTranscription: { text: "네" } } });
    expect(transcripts.at(-1)).toEqual({ role: "user", text: "네", final: false });
  });

  test("after a settled turn, the next utterance waits the idle window again (R1-OAI-2)", () => {
    const { socket, transcripts, timers } = openSession();
    socket.receive({ setupComplete: {} });
    socket.receive({ serverContent: { inputTranscription: { text: "A" } } });
    socket.receive({ serverContent: { turnComplete: true } });
    timers.runUser();
    expect(finals(transcripts)).toEqual([["user", "A"]]);
    timers.time += 3_000;
    socket.receive({ serverContent: { inputTranscription: { text: "B" } } });
    expect(timers.userDelay()).toEqual([USER_TRANSCRIPT_IDLE_MS]);
  });

  test("a first input piece right after turnComplete only gets the short window (R1-OAI-2)", () => {
    const { socket, timers } = openSession();
    socket.receive({ setupComplete: {} });
    socket.receive({ serverContent: { outputTranscription: { text: "Hi" } } });
    socket.receive({ serverContent: { turnComplete: true } });
    timers.time += 400;
    socket.receive({ serverContent: { inputTranscription: { text: "늦게 온 원문" } } });
    expect(timers.userDelay()).toEqual([USER_TRANSCRIPT_SETTLE_MS]);
    timers.time += 2_000;
    socket.receive({ serverContent: { inputTranscription: { text: " 이어짐" } } });
    expect(timers.userDelay()).toEqual([USER_TRANSCRIPT_SETTLE_MS]);
  });

  test("a socket that never completes setup fails within the deadline; setupComplete cancels it (R1-OAI-5)", () => {
    const stalled = openSession();
    expect([...stalled.timers.pending.values()].map((timer) => timer.ms)).toEqual([SETUP_TIMEOUT_MS]);
    stalled.timers.runAll();
    expect(stalled.closes).toEqual([expect.objectContaining({ failure: "failed", retry: true })]);
    expect(stalled.socket.closedByClient).toBe(true);

    const healthy = openSession();
    healthy.socket.receive({ setupComplete: {} });
    expect(healthy.timers.pending.size).toBe(0);
  });

  test("interruption closes the cut-off interpretation and reports it", () => {
    const { socket, transcripts, log } = openSession();
    socket.receive({ serverContent: { outputTranscription: { text: "Two bo" } } });
    socket.receive({ serverContent: { interrupted: true } });
    expect(finals(transcripts)).toEqual([["assistant", "Two bo"]]);
    expect(log.at(-1)).toBe("interrupted");
  });

  test("after close() nothing reaches the handlers: late frames, timers or the socket's own close", async () => {
    const { session, socket, log, timers } = openSession();
    socket.receive({ serverContent: { inputTranscription: { text: "abc" } } });
    const before = log.length;
    session.close();
    expect(socket.closedByClient).toBe(true);
    expect(timers.pending.size).toBe(0);
    socket.receive({ serverContent: { outputTranscription: { text: "late" }, modelTurn: { parts: [{ inlineData: { data: "AAAA", mimeType: "audio/pcm;rate=24000" } }] } } });
    socket.serverClose(1011, "late");
    await Promise.resolve();
    expect(log.length).toBe(before);
  });

  test("a server close keeps what was heard (final) and classifies the cause", () => {
    const { socket, transcripts, closes, log } = openSession();
    socket.receive({ serverContent: { inputTranscription: { text: "긴 문장의 앞부분" } } });
    socket.serverClose(1011, "You exceeded your current quota, please check your plan and billing details.");
    expect(finals(transcripts)).toEqual([["user", "긴 문장의 앞부분"]]);
    expect(log.slice(-2)).toEqual(["user:final", "close"]);
    expect(closes[0]).toMatchObject({ failure: "upstream", retry: false });
  });

  test("a socket that cannot drain fails the session instead of queueing without bound", () => {
    const { session, socket, closes } = openSession();
    socket.receive({ setupComplete: {} });
    socket.bufferedAmount = MAX_SOCKET_BACKLOG_BYTES + 1;
    expect(session.sendAudio(new ArrayBuffer(4))).toBe(false);
    expect(socket.sent).toHaveLength(1);
    expect(closes).toEqual([expect.objectContaining({ failure: "failed", retry: true })]);
    expect(session.sendAudio(new ArrayBuffer(4))).toBe(false);
  });

  test("close reasons: auth and quota do not retry, a clean end does, secrets are redacted", () => {
    expect(classifyGeminiClose(1008, "API key not valid. Please pass a valid API key.")).toMatchObject({ failure: "auth", retry: false });
    expect(classifyGeminiClose(1011, "RESOURCE_EXHAUSTED")).toMatchObject({ failure: "upstream", retry: false });
    // Observed 2026-10-25: Google's reason, cut by the WebSocket close-reason limit before "billing".
    expect(classifyGeminiClose(1011, "Your prepayment credits are depleted. Please go to AI Studio at https://ai.studio/projects to manage your project and billi"))
      .toMatchObject({ failure: "upstream", retry: false });
    expect(classifyGeminiClose(1000, "")).toMatchObject({ failure: "failed", retry: true, ended: true });
    expect(classifyGeminiClose(1011, "Internal error")).toMatchObject({ failure: "failed", retry: true, ended: false });
    const longValue = `example${"0123456789".repeat(4)}`;
    const message = classifyGeminiClose(1007, `bad token auth_tokens/abcdef and ${longValue}`).message;
    expect(message).not.toContain("abcdef");
    expect(message).not.toContain(longValue);
  });
});

// ---------------------------------------------------------------------------------------------
// Hook lifecycle. The hook runs on a fake React (state applied after a microtask, effects after
// render) with fake fetch, WebSocket, microphone and AudioContext. The hook source is copied with
// `react` and `@/` imports rewritten, the same isolation `hooks/useAgentSession.test.mjs` uses, so
// no module mock leaks into other test files.

type Cell = { value?: unknown; current?: unknown; deps?: unknown[]; cleanup?: (() => void) | undefined; effect?: boolean };

function createHookRenderer() {
  let cells: Cell[] = [];
  let cursor = 0;
  let render: (() => void) | null = null;
  let scheduled = false;
  const changed = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    !a || !b || a.length !== b.length || a.some((value, index) => !Object.is(value, b[index]));
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render?.();
    });
  };
  let pending: (() => void)[] = [];
  const react = {
    useState(initial: unknown) {
      const index = cursor++;
      cells[index] ??= { value: initial };
      const cell = cells[index]!;
      return [cell.value, (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(cell.value) : next;
        if (Object.is(value, cell.value)) return;
        cell.value = value;
        schedule();
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      cells[index] ??= { current: initial };
      return cells[index];
    },
    useCallback(fn: unknown, deps: unknown[]) {
      const index = cursor++;
      const cell = cells[index];
      if (!cell || changed(cell.deps, deps)) cells[index] = { value: fn, deps };
      return cells[index]!.value;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = cursor++;
      const cell = cells[index];
      if (cell && !changed(cell.deps, deps)) return;
      const slot: Cell = { deps, effect: true, cleanup: cell?.cleanup };
      cells[index] = slot;
      pending.push(() => {
        slot.cleanup?.();
        const cleanup = effect();
        slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
      });
    },
  };
  return {
    react,
    mount(component: () => void) {
      render = () => {
        cursor = 0;
        pending = [];
        component();
        const effects = pending;
        pending = [];
        for (const run of effects) run();
      };
      render();
    },
    unmount() {
      render = null;
      for (const cell of cells) if (cell?.effect) cell.cleanup?.();
      cells = [];
    },
  };
}

interface HookController {
  state: string;
  failure: string | null;
  detail: string | null;
  reconnecting: boolean;
  prepare: (mine: unknown, theirs: unknown, profile: unknown) => void;
  start: (mine: unknown, theirs: unknown, profile: unknown) => void;
  stop: () => void;
}

interface HookOptions {
  onTranscript: (event: GeminiTranscriptEvent) => void;
  getHistory: () => { role: string; text: string }[];
  onReconnect: () => void;
  credentialId: number | null;
}

type HookTransport = { endpoint: string; needsCredential: boolean };
type HookModule = {
  useGeminiInterpreterCall: (options: HookOptions) => HookController;
  useLiveInterpreterCall: (options: HookOptions, transport: HookTransport) => HookController;
};

const RENDERER_KEY = "__geminiInterpreterHookRenderer";
let hookModule: Promise<HookModule> | undefined;
let hookDirectory: string | undefined;

afterAll(async () => {
  if (hookDirectory) await rm(hookDirectory, { recursive: true, force: true });
});

function loadHook(): Promise<HookModule> {
  hookModule ??= (async () => {
    const directory = await mkdtemp(join(tmpdir(), "cuelo-gemini-hook-"));
    hookDirectory = directory;
    const fakeReact = join(directory, "react.mjs");
    await writeFile(fakeReact, ["useState", "useRef", "useCallback", "useEffect"]
      .map((name) => `export const ${name} = (...args) => globalThis.${RENDERER_KEY}.react.${name}(...args);`)
      .join("\n"));
    const root = new URL("../", import.meta.url);
    const source = await readFile(new URL("../hooks/useGeminiInterpreterCall.ts", import.meta.url), "utf8");
    const subject = join(directory, "useGeminiInterpreterCall.ts");
    await writeFile(subject, source
      .replace('from "react";', `from ${JSON.stringify(pathToFileURL(fakeReact).href)};`)
      .replace(/from "@\/([^"]+)";/g, (_match, path: string) => `from ${JSON.stringify(new URL(path, root).href)};`));
    // Runtime-selected path: the rewritten copy only exists once the test wrote it.
    return (await import(subject)) as HookModule;
  })();
  return hookModule;
}

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeNode {
  connections: unknown[] = [];
  port = { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null };
  connect(target: unknown) {
    this.connections.push(target);
  }
  disconnect() {
    this.connections = [];
  }
}

function installBrowser() {
  const keys = ["window", "fetch", "WebSocket", "navigator", "AudioContext", "AudioWorkletNode", RENDERER_KEY] as const;
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const fetches: { url: string; body: Record<string, unknown> | null; resolve: (response: Response) => void }[] = [];
  const tracks: FakeTrack[] = [];
  const contexts: { closed: boolean; source: FakeNode; sources: FakeSource[] }[] = [];
  const worklets: FakeNode[] = [];
  let micRequests = 0;
  FakeSocket.instances = [];
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define("window", globalThis);
  define("fetch", (url: string, init?: RequestInit) => {
    const { promise, resolve } = Promise.withResolvers<Response>();
    fetches.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null, resolve });
    return promise;
  });
  define("WebSocket", FakeSocket);
  define("navigator", {
    mediaDevices: {
      getUserMedia: async () => {
        micRequests += 1;
        const track = new FakeTrack();
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      },
    },
  });
  define("AudioContext", class {
    readonly record;
    state = "running";
    audioWorklet = { addModule: async () => undefined };
    constructor() {
      const { context, sources } = fakeAudioContext();
      this.record = { closed: false, source: new FakeNode(), sources };
      Object.assign(this, { currentTime: context.currentTime, destination: context.destination });
      this.createBuffer = context.createBuffer;
      this.createBufferSource = context.createBufferSource;
      contexts.push(this.record);
    }
    createBuffer;
    createBufferSource;
    resume = async () => undefined;
    close = async () => {
      this.record.closed = true;
      this.state = "closed";
    };
    createMediaStreamSource = () => this.record.source;
  });
  define("AudioWorkletNode", class extends FakeNode {
    constructor() {
      super();
      worklets.push(this);
    }
  });
  const renderer = createHookRenderer();
  define(RENDERER_KEY, renderer);
  return {
    renderer,
    fetches,
    tracks,
    contexts,
    worklets,
    micRequests: () => micRequests,
    restore() {
      renderer.unmount();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globals[key];
      }
    },
  };
}

const flush = async () => {
  for (let round = 0; round < 6; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const tokenReply = () => Response.json({ token: "auth_tokens/t", model: "gemini-3.8-live" });
const KO = { code: "ko", tag: "ko-KR", englishName: "Korean", nativeName: "한국어" };
const EN = { code: "en", tag: "en-US", englishName: "English", nativeName: "English" };
const PROFILE = { mood: "polite", gender: "male", age: "40s" };

async function mountHook(credentialId: number | null = 27, transport?: HookTransport) {
  const { useGeminiInterpreterCall, useLiveInterpreterCall } = await loadHook();
  const browser = installBrowser();
  const events: string[] = [];
  const transcripts: GeminiTranscriptEvent[] = [];
  let controller!: HookController;
  browser.renderer.mount(() => {
    const options: HookOptions = {
      onTranscript: (event) => {
        transcripts.push(event);
        events.push(`${event.role}:${event.final ? "final" : "partial"}`);
      },
      getHistory: () => [{ role: "user", text: "earlier" }],
      onReconnect: () => events.push("reconnect"),
      credentialId,
    };
    controller = transport ? useLiveInterpreterCall(options, transport) : useGeminiInterpreterCall(options);
  });
  return { browser, events, transcripts, current: () => controller };
}

describe("useGeminiInterpreterCall lifecycle", () => {
  test("prepare opens the session without the microphone; start reuses it and goes live once both are ready", async () => {
    const hook = await mountHook();
    try {
      hook.current().prepare(KO, EN, PROFILE);
      expect(hook.browser.fetches).toHaveLength(1);
      expect(hook.browser.fetches[0]!.body).toEqual({
        mine: "ko",
        theirs: "en",
        credentialId: 27,
        context: { profile: PROFILE, history: [{ role: "user", text: "earlier" }] },
      });
      hook.browser.fetches[0]!.resolve(tokenReply());
      await flush();
      const socket = FakeSocket.instances[0]!;
      socket.open();
      socket.receive({ setupComplete: {} });
      expect(hook.browser.micRequests()).toBe(0);
      expect(hook.browser.contexts).toHaveLength(0);

      hook.current().start(KO, EN, PROFILE);
      await flush();
      expect(hook.browser.fetches).toHaveLength(1);
      expect(hook.browser.micRequests()).toBe(1);
      expect(hook.current().state).toBe("live");
      expect(hook.browser.contexts[0]!.source.connections).toEqual([hook.browser.worklets[0]]);
      hook.browser.worklets[0]!.port.onmessage?.({ data: Uint8Array.from([1, 2]).buffer });
      expect(socket.sent.at(-1)).toEqual({ realtimeInput: { audio: { data: "AQI=", mimeType: "audio/pcm;rate=16000" } } });
    } finally {
      hook.browser.restore();
    }
  });

  test("stop releases microphone, AudioContext and socket, and late frames are ignored", async () => {
    const hook = await mountHook();
    try {
      hook.current().start(KO, EN, PROFILE);
      hook.browser.fetches[0]!.resolve(tokenReply());
      await flush();
      const socket = FakeSocket.instances[0]!;
      socket.open();
      socket.receive({ setupComplete: {} });
      await flush();
      expect(hook.current().state).toBe("live");

      hook.current().stop();
      await flush();
      expect(hook.current().state).toBe("idle");
      expect(hook.browser.tracks.every((track) => track.stopped)).toBe(true);
      expect(hook.browser.contexts[0]!.closed).toBe(true);
      expect(socket.closedByClient).toBe(true);
      socket.receive({ serverContent: { outputTranscription: { text: "late" } } });
      socket.serverClose(1011, "late failure");
      await flush();
      expect(hook.transcripts).toHaveLength(0);
      expect(hook.current().state).toBe("idle");
      expect(hook.current().failure).toBeNull();
    } finally {
      hook.browser.restore();
    }
  });

  test("a token that arrives after stop never opens a socket", async () => {
    const hook = await mountHook();
    try {
      hook.current().start(KO, EN, PROFILE);
      hook.current().stop();
      hook.browser.fetches[0]!.resolve(tokenReply());
      await flush();
      expect(FakeSocket.instances).toHaveLength(0);
      expect(hook.browser.tracks.every((track) => track.stopped)).toBe(true);
    } finally {
      hook.browser.restore();
    }
  });

  test("a clean server end reconnects with the mic kept, old audio stopped and heard text kept final", async () => {
    const hook = await mountHook();
    try {
      hook.current().start(KO, EN, PROFILE);
      hook.browser.fetches[0]!.resolve(tokenReply());
      await flush();
      const first = FakeSocket.instances[0]!;
      first.open();
      first.receive({ setupComplete: {} });
      await flush();
      first.receive({ serverContent: { inputTranscription: { text: "아직 말하는 중" } } });
      first.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm(2_400), mimeType: "audio/pcm;rate=24000" } }] } } });
      const played = hook.browser.contexts[0]!.sources;
      expect(played).toHaveLength(1);

      first.serverClose(1000, "");
      await flush();
      expect(hook.events).toEqual(["user:partial", "user:final", "reconnect"]);
      expect(played[0]!.stopped).toBe(true);
      expect(hook.current().reconnecting).toBe(true);
      expect(hook.browser.fetches).toHaveLength(2);
      // A late frame from the replaced socket must not reach the new call.
      first.receive({ serverContent: { outputTranscription: { text: "stale" } } });
      expect(hook.transcripts.map((event) => event.text)).not.toContain("stale");

      hook.browser.fetches[1]!.resolve(tokenReply());
      await flush();
      const second = FakeSocket.instances[1]!;
      second.open();
      second.receive({ setupComplete: {} });
      await flush();
      expect(hook.current().state).toBe("live");
      expect(hook.current().reconnecting).toBe(false);
      expect(hook.browser.micRequests()).toBe(1);
    } finally {
      hook.browser.restore();
    }
  });

  test("a WebSocket constructor that throws fails the call and releases the mic (R1-OAI-3)", async () => {
    const hook = await mountHook();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        writable: true,
        value: class {
          constructor() {
            throw new DOMException("blocked", "SecurityError");
          }
        },
      });
      hook.current().start(KO, EN, PROFILE);
      hook.browser.fetches[0]!.resolve(tokenReply());
      await flush();
      expect([hook.current().state, hook.current().failure, hook.current().detail]).toEqual(["error", "failed", "blocked"]);
      expect(hook.browser.tracks.every((track) => track.stopped)).toBe(true);
      expect(hook.browser.contexts[0]!.closed).toBe(true);
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
      hook.browser.restore();
    }
  });

  test("no selected key or an unavailable key stops with an auth failure and no fallback", async () => {
    const none = await mountHook(null);
    try {
      none.current().start(KO, EN, PROFILE);
      await flush();
      expect([none.current().state, none.current().failure]).toEqual(["error", "auth"]);
      expect(none.browser.fetches).toHaveLength(0);
      expect(none.browser.micRequests()).toBe(0);
    } finally {
      none.browser.restore();
    }

    const unavailable = await mountHook(27);
    try {
      unavailable.current().start(KO, EN, PROFILE);
      unavailable.browser.fetches[0]!.resolve(Response.json(
        { error: "credential-unavailable", message: "The selected Google API key is not available." },
        { status: 409 },
      ));
      await flush();
      expect([unavailable.current().state, unavailable.current().failure]).toEqual(["error", "auth"]);
      expect(unavailable.browser.fetches).toHaveLength(1);
      expect(FakeSocket.instances).toHaveLength(0);
      expect(unavailable.browser.tracks.every((track) => track.stopped)).toBe(true);
      expect(unavailable.browser.contexts[0]!.closed).toBe(true);
    } finally {
      unavailable.browser.restore();
    }
  });

  test("Cloud opens without a chosen key, sends no credential, and reads the relay's events for the returned call", async () => {
    const { CLOUD_TRANSPORT } = await import("../hooks/useCloudInterpreterCall");
    const hook = await mountHook(null, CLOUD_TRANSPORT);
    try {
      hook.current().prepare(KO, EN, PROFILE);
      expect(hook.browser.fetches.map((fetch) => [fetch.url, fetch.body])).toEqual([[
        "/api/live/interpret/cloud",
        { mine: "ko", theirs: "en", context: { profile: PROFILE, history: [{ role: "user", text: "earlier" }] } },
      ]]);
      hook.browser.fetches[0]!.resolve(Response.json({ callId: "call-1", model: "gemini-3.8-live" }));
      await flush();
      expect(hook.browser.fetches[1]!.url).toBe("/api/live/interpret/cloud/events?callId=call-1");
      expect(FakeSocket.instances).toHaveLength(0);
      expect(hook.browser.micRequests()).toBe(0);
    } finally {
      hook.browser.restore();
    }
  });

  test("a Cloud call whose open answer arrives after stop is released on the server", async () => {
    const { CLOUD_TRANSPORT } = await import("../hooks/useCloudInterpreterCall");
    const hook = await mountHook(null, CLOUD_TRANSPORT);
    try {
      hook.current().prepare(KO, EN, PROFILE);
      hook.current().stop();
      hook.browser.fetches[0]!.resolve(Response.json({ callId: "late-call", model: "gemini-3.8-live" }));
      await flush();
      expect(hook.browser.fetches.slice(1).map((fetch) => fetch.url)).toEqual(["/api/live/interpret/cloud?callId=late-call"]);
    } finally {
      hook.browser.restore();
    }
  });
});

function relayHarness() {
  const timers = new ManualTimers();
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const requests: { url: string; init?: RequestInit; resolve: (response: Response) => void }[] = [];
  const fetchImpl = (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/live/interpret/cloud/events")) {
      const body = new ReadableStream<Uint8Array>({ start: (controller) => void (stream = controller) });
      init?.signal?.addEventListener("abort", () => stream.error(new Error("aborted")));
      requests.push({ url, init, resolve: () => {} });
      return Promise.resolve(new Response(body, { headers: { "Content-Type": "text/event-stream" } }));
    }
    const { promise, resolve } = Promise.withResolvers<Response>();
    requests.push({ url, init, resolve });
    return promise;
  };
  const socket = new CloudRelaySocket("call/1", fetchImpl, timers);
  const log: string[] = [];
  socket.onopen = () => log.push("open");
  socket.onmessage = (event) => log.push(`message:${String(event.data)}`);
  socket.onclose = (event) => log.push(`close:${event.code}:${event.reason}`);
  const emit = (event: unknown) => stream.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  const posts = () => requests.filter((request) => request.url === "/api/live/interpret/cloud/input");
  return { socket, timers, log, requests, posts, emit, raw: (bytes: Uint8Array) => stream.enqueue(bytes), end: () => stream.close() };
}

const audioFrame = (data: string) => JSON.stringify({ realtimeInput: { audio: { data, mimeType: "audio/pcm;rate=16000" } } });

describe("Cloud relay socket", () => {
  test("reads the call's event stream: open, Vertex messages verbatim, then the relay's close", async () => {
    const relay = relayHarness();
    expect(relay.requests[0]!.url).toBe("/api/live/interpret/cloud/events?callId=call%2F1");
    relay.emit({ type: "open" });
    relay.emit({ type: "message", data: '{"setupComplete":{}}' });
    // An SSE block split mid-way, with a multi-byte character cut across the chunks.
    const block = new TextEncoder().encode(`data: ${JSON.stringify({ type: "message", data: "안녕" })}\n\n`);
    relay.raw(block.slice(0, 22));
    relay.raw(block.slice(22));
    relay.emit({ type: "close", code: 1011, reason: "Internal error" });
    await flush();
    expect(relay.log).toEqual(["open", 'message:{"setupComplete":{}}', "message:안녕", "close:1011:Internal error"]);
    expect(relay.socket.readyState).toBe(3);
  });

  test("a stream that ends without a close event reports an abnormal close", async () => {
    const relay = relayHarness();
    relay.emit({ type: "open" });
    relay.end();
    await flush();
    expect(relay.log).toEqual(["open", "close:1006:The interpreter stream ended."]);
  });

  test("drops the session's setup, batches audio frames into one request at a time, and counts unsent frames", async () => {
    const relay = relayHarness();
    relay.socket.send(audioFrame("AAAA"));
    relay.emit({ type: "open" });
    await flush();
    relay.socket.send(JSON.stringify({ setup: { model: "x" } }));
    for (let index = 0; index < RELAY_FRAMES_PER_REQUEST + 2; index += 1) relay.socket.send(audioFrame(`AA${index}A`.slice(0, 4)));
    expect(relay.timers.userDelay()).toEqual([RELAY_BATCH_MS]);
    expect(relay.posts()).toHaveLength(0);
    const queued = relay.socket.bufferedAmount;
    expect(queued).toBe((RELAY_FRAMES_PER_REQUEST + 2) * 4);
    relay.timers.runAll();
    expect(relay.posts()).toHaveLength(1);
    const first = JSON.parse(String(relay.posts()[0]!.init?.body)) as { callId: string; frames: string[] };
    expect([first.callId, first.frames.length]).toEqual(["call/1", RELAY_FRAMES_PER_REQUEST]);
    // One request in flight: more frames wait instead of opening a second request.
    relay.socket.send(audioFrame("BBBB"));
    expect(relay.posts()).toHaveLength(1);
    relay.posts()[0]!.resolve(new Response(null, { status: 204 }));
    await flush();
    expect(relay.posts()).toHaveLength(2);
    expect((JSON.parse(String(relay.posts()[1]!.init?.body)) as { frames: string[] }).frames).toHaveLength(3);
    expect(relay.socket.bufferedAmount).toBe(3 * 4);
    relay.posts()[1]!.resolve(new Response(null, { status: 204 }));
    await flush();
    expect(relay.socket.bufferedAmount).toBe(0);
  });

  test("close stops reading, deletes the relay call, and reports a normal close once", async () => {
    const relay = relayHarness();
    relay.emit({ type: "open" });
    await flush();
    relay.socket.send(audioFrame("AAAA"));
    relay.socket.close();
    relay.socket.close();
    await flush();
    const deletes = relay.requests.filter((request) => request.init?.method === "DELETE");
    expect(deletes.map((request) => [request.url, request.init?.keepalive])).toEqual([["/api/live/interpret/cloud?callId=call%2F1", true]]);
    expect(relay.log).toEqual(["open", "close:1000:"]);
    expect([relay.socket.bufferedAmount, relay.timers.pending.size]).toEqual([0, 0]);
  });

  test("an input request the relay did not refuse itself ends the call visibly instead of dropping audio", async () => {
    const relay = relayHarness();
    relay.emit({ type: "open" });
    await flush();
    relay.socket.send(audioFrame("AAAA"));
    relay.timers.runAll();
    relay.posts()[0]!.resolve(new Response("Bad Gateway", { status: 502 }));
    await flush();
    expect(relay.log).toEqual(["open", "close:1011:Audio could not reach the interpreter (HTTP 502)."]);
    expect(relay.requests.filter((request) => request.init?.method === "DELETE")).toHaveLength(1);
    const info = classifyGeminiClose(1011, "Audio could not reach the interpreter (HTTP 502).");
    expect([info.failure, info.retry]).toEqual(["failed", true]);
  });

  test("a relay refusal (call gone) leaves the reason to the event stream", async () => {
    const relay = relayHarness();
    relay.emit({ type: "open" });
    await flush();
    relay.socket.send(audioFrame("AAAA"));
    relay.timers.runAll();
    relay.posts()[0]!.resolve(Response.json({ error: "not-found" }, { status: 404 }));
    await flush();
    expect(relay.log).toEqual(["open"]);
    relay.emit({ type: "close", code: 1011, reason: "Internal error" });
    await flush();
    expect(relay.log).toEqual(["open", "close:1011:Internal error"]);
  });
});
