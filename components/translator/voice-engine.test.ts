import { expect, test } from "bun:test";
import { VoiceEngine } from "./voice-engine";
import { TRANSLATOR_LANGUAGES } from "@/lib/translator-languages";

function environment(media?: Promise<MediaStream>, moduleFailure?: Error) {
  const names = ["fetch", "navigator", "Worker", "WebSocket", "AudioContext", "AudioWorkletNode", "window", "SpeechSynthesisUtterance"];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const sockets: Socket[] = [], workers: LocalWorker[] = [], nodes: Node[] = [], states: { state: string; failure?: string }[] = [];
  const spoken: { text: string; lang: string; onstart?: () => void; onend?: () => void }[] = [];
  const updates: string[] = [];
  const modelStates: string[] = [];
  const enrollmentStates: { side: string | null; seconds: number; failed?: boolean }[] = [];
  let requests = 0, stops = 0, cancels = 0;
  const stream = { getTracks: () => [{ stop: () => { stops++; } }] } as unknown as MediaStream;
  class Socket {
    static OPEN = 1;
    readyState = 0;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor() { sockets.push(this); }
    send() {}
    event(value: object) { this.onmessage?.({ data: JSON.stringify(value) }); }
    ready() { this.readyState = 1; this.event({ type: "session.created" }); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  class LocalWorker {
    onmessage: ((event: { data: object }) => void) | null = null;
    onerror: (() => void) | null = null;
    messages: { type: string; side?: string }[] = [];
    constructor() { workers.push(this); }
    postMessage(data: { type: string; side?: string }) { this.messages.push(data); }
    terminate() {}
  }
  class Node {
    port = { onmessage: null as ((event: { data: ArrayBuffer }) => void) | null, postMessage() {} };
    constructor() { nodes.push(this); }
    disconnect() {}
  }
  class Context {
    audioWorklet = { addModule: async () => { if (moduleFailure) throw moduleFailure; } };
    resume() { return Promise.resolve(); }
    close() { return Promise.resolve(); }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  }
  const values: Record<string, unknown> = {
    Worker: LocalWorker, WebSocket: Socket, AudioContext: Context, AudioWorkletNode: Node,
    navigator: { mediaDevices: { getUserMedia: () => media ?? Promise.resolve(stream) } },
    window: { setTimeout, clearTimeout, speechSynthesis: { getVoices: () => [{ lang: "ja-JP" }, { lang: "ko-KR" }], speak: (utterance: typeof spoken[number]) => spoken.push(utterance), cancel: () => { cancels++; } } },
    SpeechSynthesisUtterance: class { lang = ""; constructor(readonly text: string) {} },
    fetch: async (url: string) => {
      requests++;
      return url.includes("transcribe-secret") ? Response.json({ secret: "test-secret" }) : new Response(`data: ${JSON.stringify({ type: "done", text: "translated", source: "ko", target: "ja" })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
    },
  };
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const engine = new VoiceEngine({ mine: TRANSLATOR_LANGUAGES[0], theirs: TRANSLATOR_LANGUAGES[3], profile: {},
    onUpdate: (item) => updates.push(item.text), onState: (state, failure) => states.push({ state, failure }),
    onModels: (state) => modelStates.push(state), onEnrollment: (side, seconds, failed) => enrollmentStates.push({ side, seconds, failed }), onOverlap() {}, playback: () => ({ enabled: true, echoGuard: true }),
  });
  return { engine, sockets, workers, nodes, states, updates, spoken, stream, modelStates, enrollmentStates, requests: () => requests, stops: () => stops, cancels: () => cancels,
    restore() { engine.dispose(); for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } },
  };
}
async function tick() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function speech(node: { port: { onmessage: ((event: { data: ArrayBuffer }) => void) | null } }) {
  for (let i = 0; i < 10; i++) node.port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
  for (let i = 0; i < 7; i++) node.port.onmessage?.({ data: new Int16Array(2400).buffer });
}
test("R1-ANT-4 / ADV-2: stop during socket handshake stays idle", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); expect(env.sockets).toHaveLength(1);
    await env.engine.stop(); await starting;
    expect(env.states.at(-1)?.state).toBe("idle");
  } finally { env.restore(); }
});
test("R1-ANT-5 / ADV-2: disposed stop continuation emits no stale updates or state", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "얼마예요" });
    const stopping = env.engine.stop(); env.engine.dispose(); const count = env.states.length, updates = env.updates.length;
    let finished = false; void stopping.then(() => { finished = true; }); await tick();
    expect(finished).toBe(true);
    expect(env.states).toHaveLength(count); expect(env.updates).toHaveLength(updates);
  } finally { env.restore(); }
});
test("R1-ANT-8: permission is resolved before minting the expiring secret", async () => {
  const permission = Promise.withResolvers<MediaStream>(), env = environment(permission.promise);
  try {
    const starting = env.engine.start(); await tick(); expect(env.requests()).toBe(0);
    permission.resolve(env.stream); await tick(); env.sockets[0].ready(); await starting;
  } finally { permission.resolve(env.stream); env.restore(); }
});
test("R1-ADV-3: missing microphone maps to the existing recoverable error", async () => {
  const env = environment(Promise.reject(new DOMException("Requested device not found", "NotFoundError")));
  try { await env.engine.start(); expect(env.states.at(-1)).toEqual({ state: "error", failure: "mic-unavailable" }); }
  finally { env.restore(); }
});
test("R1-ANT-3: guessed or default side never silently enrolls a voice", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    env.workers[0].onmessage?.({ data: { type: "speaker-ready" } }); env.engine.skipEnrollment();
    speech(env.nodes[0]);
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "1234" });
    await tick();
    expect(env.workers[0].messages.filter((message) => message.type === "enroll")).toEqual([]);
  } finally { env.restore(); }
});
test("R1-ADV-4: socket loss while stopping drains recognized partials without waiting 15 seconds", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "얼마예요" });
    const stopping = env.engine.stop(); env.sockets[0].close();
    let finished = false; void stopping.then(() => { finished = true; }); await tick();
    expect(finished).toBe(true);
  } finally { env.restore(); }
});
test("voice playback queues both final interpretations and never cancels the previous one", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting; env.engine.skipEnrollment();
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "첫 문장" }); await tick();
    env.spoken[0]?.onstart?.();
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "다음 문장" }); await tick();
    expect(env.spoken).toHaveLength(1);
    env.spoken[0].onend?.(); await tick();
    expect(env.spoken.map((utterance) => utterance.text)).toEqual(["translated", "translated"]); expect(env.cancels()).toBe(0);
  } finally { env.restore(); }
});
test("R2-ANT-4: a failed sample can retry without disabling loaded speaker models", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    const worker = env.workers[0]; worker.onmessage?.({ data: { type: "speaker-ready" } });
    speech(env.nodes[0]); env.engine.nextEnrollment(); worker.onmessage?.({ data: { type: "enrolled", side: "me", ok: true } });
    speech(env.nodes[0]); env.engine.nextEnrollment(); worker.onmessage?.({ data: { type: "enrolled", side: "them", ok: false } });
    expect(env.modelStates.at(-1)).toBe("ready");
  } finally { env.restore(); }
});
test("R2-ANT-5: transcription failure during Stop drains without a timeout", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting; speech(env.nodes[0]);
    const stopping = env.engine.stop();
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.failed", item_id: "a" });
    let finished = false; void stopping.then(() => { finished = true; }); await tick(); expect(finished).toBe(true);
    expect(env.states.at(-1)).toEqual({ state: "idle", failure: undefined });
  } finally { env.restore(); }
});
test("R2-ANT-6: worklet asset failure is upstream, not a microphone permission failure", async () => {
  const env = environment(undefined, new DOMException("Capture asset unavailable", "AbortError"));
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    expect(env.states.at(-1)).toEqual({ state: "error", failure: "upstream" });
  } finally { env.restore(); }
});
test("R2-ANT-7: Skip releases the forced enrollment direction for its pending utterance", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    env.workers[0].onmessage?.({ data: { type: "speaker-ready" } });
    for (let i = 0; i < 10; i++) env.nodes[0].port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
    env.engine.skipEnrollment(); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "この料理をください" });
    await tick(); expect(env.engine.session.utterances.get(0)?.side).toBe("them");
  } finally { env.restore(); }
});
test("R3-ANT-2: second-step Skip retains the confirmed first voice", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    const worker = env.workers[0]; worker.onmessage?.({ data: { type: "speaker-ready" } });
    speech(env.nodes[0]); env.engine.nextEnrollment(); worker.onmessage?.({ data: { type: "enrolled", side: "me", ok: true } });
    env.engine.skipEnrollment();
    expect(worker.messages.filter((message) => message.type === "reset")).toEqual([]);
  } finally { env.restore(); }
});
test("R3-ANT-3: enrollment retry stays visible while gathering the replacement sample", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    const worker = env.workers[0]; worker.onmessage?.({ data: { type: "speaker-ready" } });
    speech(env.nodes[0]); env.engine.nextEnrollment(); worker.onmessage?.({ data: { type: "enrolled", side: "me", ok: false } });
    env.nodes[0].port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
    expect(env.enrollmentStates.at(-1)?.failed).toBe(true);
  } finally { env.restore(); }
});
for (const firstScore of [0.4, 0.75]) test(`R4-ANT-1 / ADV-1: uncertainty never turns mixed text into a voice change (${firstScore})`, async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    const worker = env.workers[0]; worker.onmessage?.({ data: { type: "speaker-ready" } });
    speech(env.nodes[0]); env.engine.nextEnrollment(); worker.onmessage?.({ data: { type: "enrolled", side: "me", ok: true } });
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "등록 문장" }); await tick();
    env.engine.skipEnrollment();
    for (let i = 0; i < 15; i++) env.nodes[0].port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.delta", item_id: "b", delta: "네" });
    worker.onmessage?.({ data: { type: "analysis", endMs: 2900, matches: [{ side: "me", score: firstScore }] } });
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.delta", item_id: "b", delta: " この店のおすすめは" });
    for (let i = 0; i < 3; i++) env.nodes[0].port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
    worker.onmessage?.({ data: { type: "analysis", endMs: 3200, matches: [{ side: "me", score: 0.4 }] } });
    expect(env.engine.session.utterances.size).toBe(2);
    expect(env.engine.session.utterances.get(1)?.side).toBe("me");
    expect(worker.messages.filter((message) => message.type === "enroll")).toHaveLength(1);
  } finally { env.restore(); }
});
test("R5-ANT-1: uncertain intermediate scores do not erase the last confident boundary anchor", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting;
    const worker = env.workers[0]; worker.onmessage?.({ data: { type: "speaker-ready" } });
    speech(env.nodes[0]); env.engine.nextEnrollment(); worker.onmessage?.({ data: { type: "enrolled", side: "me", ok: true } });
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "등록 문장" }); await tick();
    env.engine.skipEnrollment();
    // Hold the original 5.4 s capture clock despite the extra 300 ms of endpoint silence.
    for (let i = 0; i < 37; i++) env.nodes[0].port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
    worker.onmessage?.({ data: { type: "analysis", endMs: 4400, matches: [{ side: "me", score: .8 }] } });
    worker.onmessage?.({ data: { type: "analysis", endMs: 4650, matches: [{ side: "me", score: .35 }] } });
    worker.onmessage?.({ data: { type: "analysis", endMs: 4900, matches: [{ side: "me", score: .1 }] } });
    expect(env.engine.session.utterances.get(1)?.endMs).toBe(4150);
  } finally { env.restore(); }
});
test("chain2 R1-ANT-1: one failed transcription keeps the session live and later utterances still translate", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting; env.engine.skipEnrollment();
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.delta", item_id: "a", delta: "얼마예요" });
    env.sockets[0].event({ type: "conversation.item.input_audio_transcription.failed", item_id: "a" });
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "다음 문장" }); await tick();
    expect(env.states.at(-1)?.state).toBe("live"); expect(env.stops()).toBe(0);
    expect(env.engine.session.utterances.get(0)).toMatchObject({ text: "얼마예요", closed: true });
    expect(env.engine.session.utterances.get(1)).toMatchObject({ translation: "translated", final: true });
  } finally { env.restore(); }
});
test("chain2 R1-ANT-3: dispose cancels this engine's queued interpretations", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting; env.engine.skipEnrollment();
    speech(env.nodes[0]); env.sockets[0].event({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "첫 문장" }); await tick();
    expect(env.spoken).toHaveLength(1);
    env.engine.dispose();
    expect(env.cancels()).toBe(1);
  } finally { env.restore(); }
});
test("chain2 R1-ANT-4: correction audio stays bounded over a long conversation", async () => {
  const env = environment();
  try {
    const starting = env.engine.start(); await tick(); env.sockets[0].ready(); await starting; env.engine.skipEnrollment();
    for (let turn = 0; turn < 30; turn++) speech(env.nodes[0]);
    for (let i = 0; i < 60; i++) env.nodes[0].port.onmessage?.({ data: new Int16Array(2400).fill(8000).buffer });
    // Retained correction audio is private and has no public surface; the test reads it directly.
    const internals = env.engine as unknown as { audio: Map<number, { chunks: Int16Array[] }> };
    const audio = internals.audio;
    expect(audio.size).toBeLessThanOrEqual(20);
    for (const kept of audio.values()) expect(kept.chunks.reduce((size, chunk) => size + chunk.length, 0)).toBeLessThanOrEqual(24000 * 3);
  } finally { env.restore(); }
});
test("chain2 R1-ADV-1: dispose while the secret response is read opens no transcription socket", async () => {
  const env = environment();
  try {
    Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true,
      value: async () => ({ ok: true, status: 200, json: async () => { env.engine.dispose(); return { secret: "test-secret" }; } }) });
    await env.engine.start();
    expect(env.sockets).toHaveLength(0);
  } finally { env.restore(); }
});
