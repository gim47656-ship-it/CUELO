/**
 * AI noise suppression (RNNoise) for the interpreter microphone: the raw mic stream goes through
 * an AudioWorklet and comes out as a new track that replaces the raw one on the call's sender.
 *
 * Interpreting never depends on this. `createNoiseSuppressor` rejects whenever AudioWorklet, WASM
 * or the 48 kHz context is unavailable, and the caller then keeps the raw track. A graph that
 * dies later reports through `onBroken` so the caller can switch back.
 */

import type { RnnoiseWorkletNode } from "@sapphi-red/web-noise-suppressor";

/** The worklet and both wasm builds are copies of the package files, served from `public/`. */
export const RNNOISE_ASSETS = {
  worklet: "/interpreter-noise/rnnoiseWorklet.js",
  wasm: "/interpreter-noise/rnnoise.wasm",
  simdWasm: "/interpreter-noise/rnnoise_simd.wasm",
} as const;

/** RNNoise works on 48 kHz audio only. */
const RNNOISE_SAMPLE_RATE = 48_000;

/** Time constant of the mute fade, short enough to follow the echo guard and long enough to avoid a click. */
const MUTE_FADE_SECONDS = 0.005;

export interface NoiseSuppressor {
  /** The denoised track, to put on the sender in place of the raw one. */
  track: MediaStreamTrack;
  /** Silence the denoised track (the echo guard) or let it through again. */
  setMuted: (muted: boolean) => void;
  /** Stop the graph and the track and close its AudioContext. Safe to call twice. */
  close: () => void;
}

const hasWasmMagic = (binary: ArrayBuffer) => {
  const head = new Uint8Array(binary, 0, Math.min(4, binary.byteLength));
  return head.length === 4 && head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d;
};

/**
 * `signal` cancels a setup that is still loading (a stalled asset request must not hold an
 * AudioContext open): the context is closed and the promise rejects.
 */
export async function createNoiseSuppressor(
  stream: MediaStream,
  onBroken: (reason: string) => void,
  signal?: AbortSignal,
  assets: typeof RNNOISE_ASSETS = RNNOISE_ASSETS,
): Promise<NoiseSuppressor> {
  if (typeof AudioContext !== "function" || typeof AudioWorkletNode !== "function" || typeof WebAssembly !== "object") {
    throw new Error("AudioWorklet or WebAssembly is not available");
  }
  if (stream.getAudioTracks().length === 0) throw new Error("the stream has no audio track");

  // Imported here: the package extends `AudioWorkletNode` when it loads, which a server render lacks.
  // The chunk request can stall too, so the cancel signal races it.
  const cancelled = Promise.withResolvers<never>();
  cancelled.promise.catch(() => {});
  const cancel = () => cancelled.reject(new Error("setup cancelled"));
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  // `addModule` and `resume` take no signal of their own, and a stalled one keeps its promise pending
  // after the context closes, so every setup wait races this cancellation. The race also attaches the
  // rejection handler, so a wait that loses and rejects later stays handled.
  const settled = <T>(work: Promise<T>): Promise<T> => Promise.race([work, cancelled.promise]);

  let context: AudioContext | null = null;
  let closed = false;
  let source: MediaStreamAudioSourceNode | null = null;
  let node: RnnoiseWorkletNode | null = null;
  let gate: GainNode | null = null;
  let track: MediaStreamTrack | null = null;

  const close = () => {
    if (closed) return;
    closed = true;
    const current = context;
    if (!current) return;
    current.onstatechange = null;
    if (node) {
      node.onprocessorerror = null;
      node.destroy();
      node.disconnect();
    }
    source?.disconnect();
    gate?.disconnect();
    track?.stop();
    if (current.state !== "closed") void current.close().catch(() => {});
  };
  signal?.addEventListener("abort", close, { once: true });

  try {
    if (signal?.aborted) throw new Error("setup cancelled");
    const pkg = await settled(import("@sapphi-red/web-noise-suppressor"));
    if (signal?.aborted) throw new Error("setup cancelled");
    const { RnnoiseWorkletNode, loadRnnoise } = pkg;
    const created = new AudioContext({ sampleRate: RNNOISE_SAMPLE_RATE, latencyHint: "interactive" });
    context = created;
    const [wasmBinary] = await Promise.all([
      settled(loadRnnoise({ url: assets.wasm, simdUrl: assets.simdWasm }, signal ? { signal } : undefined)),
      settled(created.audioWorklet.addModule(assets.worklet)),
    ]);
    if (closed) throw new Error("setup cancelled");
    // `loadRnnoise` hands back whatever the server answered, a 404 page included.
    if (!hasWasmMagic(wasmBinary)) throw new Error("the RNNoise wasm did not load");
    if (created.sampleRate !== RNNOISE_SAMPLE_RATE) throw new Error(`the browser ran the context at ${created.sampleRate} Hz`);
    // A suspended context would turn the microphone into silence; without a running one there is no suppressor.
    await settled(created.resume());
    if (created.state !== "running" || closed) throw new Error(`the audio context is ${created.state}`);

    source = created.createMediaStreamSource(stream);
    node = new RnnoiseWorkletNode(created, { maxChannels: 2, wasmBinary });
    gate = created.createGain();
    const destination = created.createMediaStreamDestination();
    source.connect(node);
    node.connect(gate);
    gate.connect(destination);
    track = destination.stream.getAudioTracks()[0] ?? null;
    if (!track) throw new Error("the audio graph produced no track");

    node.onprocessorerror = () => {
      if (!closed) onBroken("the RNNoise processor failed");
    };
    created.onstatechange = () => {
      if (!closed && created.state !== "running") onBroken(`the audio context is ${created.state}`);
    };
  } catch (error) {
    close();
    throw error;
  } finally {
    signal?.removeEventListener("abort", close);
    // Registered for the whole setup: `addModule` and `resume` have no signal of their own.
    signal?.removeEventListener("abort", cancel);
  }
  const output = gate;
  let muted = false;
  const setMuted = (next: boolean) => {
    // The echo guard calls this every few milliseconds; only a change schedules a fade.
    if (closed || next === muted) return;
    muted = next;
    output.gain.setTargetAtTime(next ? 0 : 1, context.currentTime, MUTE_FADE_SECONDS);
  };
  return { track, setMuted, close };
}
