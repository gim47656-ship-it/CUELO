import { afterEach, describe, expect, test } from "bun:test";
import { findTranslatorLanguage } from "@/lib/translator-languages";
import { openDraftSession, type DraftSession } from "./draft-session";

/**
 * Faked boundaries: `fetch` (the secret request), `WebSocket`, `MediaStream`, `AudioContext`,
 * `AudioWorkletNode` and `window`'s timers. The module under test is the real `draft-session.ts`;
 * the Codex call is a different module and never runs here, so "Codex is unaffected" is shown by
 * this module owning nothing outside its own sockets, context and listener.
 *
 * Timers are a counting stub, not real waits: a scheduled reconnect shows up as an entry instead of
 * firing, so the test never depends on wall-clock time.
 */

const globals = globalThis as unknown as Record<string, unknown>;
const originals = {
  fetch: globals.fetch,
  WebSocket: globals.WebSocket,
  AudioContext: globals.AudioContext,
  AudioWorkletNode: globals.AudioWorkletNode,
  MediaStream: globals.MediaStream,
  window: globals.window,
};

const flush = async (rounds = 60) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

const deferred = <T>() => Promise.withResolvers<T>();

function language(code: string) {
  const found = findTranslatorLanguage(code);
  if (!found) throw new Error(`the test language ${code} is missing`);
  return found;
}

const ko = language("ko");
const vi = language("vi");
/** Only its presence matters: the capture path builds a `MediaStream` around whatever it gets. */
const micTrack = { kind: "audio" } as unknown as MediaStreamTrack;

class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState = Socket.CONNECTING;
  closeCalls = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  readonly sent: string[] = [];
  constructor(url: string) {
    this.url = url;
    opened.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closeCalls += 1;
    this.readyState = Socket.CLOSED;
  }
  /** The handshake finishes on its own, as a real socket's does. */
  open() {
    if (this.readyState !== Socket.CONNECTING) return;
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
}

class Context {
  static readonly instances: Context[] = [];
  state = "suspended";
  closeCalls = 0;
  readonly sampleRate: number;
  readonly audioWorklet: { addModule: (url: string) => Promise<void> };
  constructor(options: { sampleRate?: number }) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.audioWorklet = { addModule: (url) => moduleRequest(url, this) };
    Context.instances.push(this);
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.closeCalls += 1;
    this.state = "closed";
  }
  createMediaStreamSource() {
    return { connect: () => {}, disconnect: () => {} };
  }
}

class Node {
  static readonly instances: Node[] = [];
  disconnected = 0;
  readonly posted: unknown[] = [];
  readonly port = {
    onmessage: null as ((event: { data: ArrayBuffer }) => void) | null,
    postMessage: (message: unknown) => void this.posted.push(message),
  };
  constructor() {
    Node.instances.push(this);
  }
  connect() {}
  disconnect() {
    this.disconnected += 1;
  }
}

let opened: Socket[] = [];
let moduleRequest: (url: string, context: Context) => Promise<void> = async () => {};
let secretRequest: () => Promise<{ ok: boolean; json: () => Promise<unknown> }> = async () => ({ ok: true, json: async () => ({}) });
let secretRequests = 0;
let blockedListeners = 0;
let retryTimers: { fn: () => void; ms: number }[] = [];
let withWorklet = true;

const secrets = async () => ({
  ok: true,
  json: async () => ({ sessions: [{ language: "ko", secret: "synthetic-ko" }, { language: "vi", secret: "synthetic-vi" }] }),
});

function install(options: {
  secret?: () => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  module?: (url: string, context: Context) => Promise<void>;
  worklet?: boolean;
}) {
  opened = [];
  Context.instances.length = 0;
  Node.instances.length = 0;
  secretRequests = 0;
  blockedListeners = 0;
  retryTimers = [];
  withWorklet = options.worklet ?? true;
  secretRequest = options.secret ?? secrets;
  moduleRequest = options.module ?? (async () => {});

  globals.fetch = (url: string) => {
    expect(String(url)).toBe("/api/live/draft-secret");
    secretRequests += 1;
    return secretRequest();
  };
  globals.WebSocket = Socket;
  globals.AudioContext = Context;
  if (withWorklet) globals.AudioWorkletNode = Node;
  else delete globals.AudioWorkletNode;
  globals.MediaStream = class {
    constructor(readonly tracks: unknown[]) {}
  };
  globals.window = {
    setTimeout: (fn: () => void, ms: number) => {
      retryTimers.push({ fn, ms });
      return retryTimers.length;
    },
    clearTimeout: (id: number | undefined) => {
      if (id !== undefined) retryTimers = retryTimers.filter((_, index) => index !== id - 1);
    },
  };
}

function restore() {
  for (const key of Object.keys(originals) as (keyof typeof originals)[]) {
    if (originals[key] === undefined) delete globals[key];
    else globals[key] = originals[key];
  }
}

function open(listener?: () => void): DraftSession {
  return openDraftSession({
    mine: ko,
    theirs: vi,
    isBlocked: () => false,
    onBlockedChange: (next) => {
      blockedListeners += 1;
      listener?.();
      return () => {
        blockedListeners -= 1;
        next(false);
      };
    },
    onInput: () => {},
    onOutput: () => {},
  });
}

/** Everything a session that ended must show: each resource released once, nothing left to revive it. */
function expectOwnResourcesReleased() {
  for (const socket of opened) {
    expect(socket.readyState).toBe(Socket.CLOSED);
    expect(socket.closeCalls).toBe(1);
    expect(socket.onclose).toBeNull();
    expect(socket.onmessage).toBeNull();
  }
  for (const context of Context.instances) {
    expect(context.state).toBe("closed");
    expect(context.closeCalls).toBe(1);
  }
  expect(Node.instances).toHaveLength(0);
  expect(blockedListeners).toBe(0);
  expect(retryTimers).toHaveLength(0);
}

afterEach(restore);

describe("openDraftSession when the capture cannot start", () => {
  test("a capture module rejection ends this session's sockets, context and listener", async () => {
    const moduleGate = deferred<void>();
    install({ module: () => moduleGate.promise });
    const session = open();
    session.setTrack(micTrack);
    await flush();
    expect(secretRequests).toBe(1);
    expect(opened).toHaveLength(2);
    for (const socket of opened) socket.open();
    await flush();
    expect(Context.instances).toHaveLength(1);

    moduleGate.reject(new Error("synthetic addModule rejection"));
    await flush();

    expectOwnResourcesReleased();
    session.close();
    expectOwnResourcesReleased();
  });

  test("a missing AudioWorklet ends the session before it mints a secret", async () => {
    install({ worklet: false });
    const session = open();
    await flush();

    expect(secretRequests).toBe(0);
    expect(opened).toHaveLength(0);
    expect(Context.instances).toHaveLength(0);
    expect(blockedListeners).toBe(0);
    expect(retryTimers).toHaveLength(0);
    session.close();
  });

  test("a secret request still in flight does not open sockets after the capture failed", async () => {
    const secretGate = deferred<{ ok: boolean; json: () => Promise<unknown> }>();
    install({ secret: () => secretGate.promise, module: async () => Promise.reject(new Error("synthetic addModule rejection")) });
    const session = open();
    await flush();
    expect(opened).toHaveLength(0);

    secretGate.resolve(secrets());
    await flush();

    expect(opened).toHaveLength(0);
    expect(Context.instances[0].closeCalls).toBe(1);
    expect(retryTimers).toHaveLength(0);
    session.close();
    expect(Context.instances[0].closeCalls).toBe(1);
  });

  test("a capture that finishes after close is not resurrected", async () => {
    const moduleGate = deferred<void>();
    install({ module: () => moduleGate.promise });
    const session = open();
    session.setTrack(micTrack);
    await flush();
    for (const socket of opened) socket.open();
    await flush();
    session.close();
    expect(opened.every((socket) => socket.readyState === Socket.CLOSED)).toBe(true);

    moduleGate.resolve();
    await flush(120);

    expect(Node.instances).toHaveLength(0);
    expect(blockedListeners).toBe(0);
    expect(Context.instances[0].closeCalls).toBe(1);
    expect(retryTimers).toHaveLength(0);
  });
});

describe("openDraftSession success control", () => {
  test("a started capture stays open and close releases everything exactly once", async () => {
    install({});
    const session = open();
    session.setTrack(micTrack);
    await flush();
    for (const socket of opened) socket.open();
    await flush();

    expect(opened).toHaveLength(2);
    expect(opened.every((socket) => socket.readyState === Socket.OPEN)).toBe(true);
    expect(Context.instances).toHaveLength(1);
    expect(Context.instances[0].state).toBe("running");
    expect(Node.instances).toHaveLength(1);
    expect(Node.instances[0].port.onmessage).toBeTypeOf("function");
    expect(blockedListeners).toBe(1);
    // The echo guard's state is pushed once when the capture starts.
    expect(Node.instances[0].posted).toEqual([{ muted: false }]);
    expect(retryTimers).toHaveLength(0);

    session.close();
    session.close();

    expect(opened.every((socket) => socket.closeCalls === 1)).toBe(true);
    expect(Context.instances[0].closeCalls).toBe(1);
    expect(Node.instances[0].disconnected).toBe(1);
    expect(Node.instances[0].port.onmessage).toBeNull();
    expect(blockedListeners).toBe(0);
  });
});
