import type { TranslatorLanguage } from "@/lib/translator-languages";

/**
 * Two gpt-realtime-translate WebSockets, one per output language, with shared microphone capture.
 * Codex drafts use only text. Fast interpretation can schedule the PCM released by its direction gate.
 * Only short-lived browser credentials from `/api/live/draft-secret` reach the sockets.
 */

const SOCKET_URL = "wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate";
const CAPTURE_MODULE = "/interpreter-draft/capture.js";
const CAPTURE_PROCESSOR = "interpreter-draft-capture";
/** The rate the translation model takes. */
const SAMPLE_RATE = 24_000;
/** ~100 ms of audio per message. */
const CHUNK_SAMPLES = 2_400;
/** Tries to open both sockets for one call after the first one failed or a socket dropped. */
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2_000;
const CONNECT_TIMEOUT_MS = 15_000;

interface SessionPlan {
  language: TranslatorLanguage;
  secret: string;
}

export type DraftSessionOptions = {
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  onInput: (language: TranslatorLanguage, delta: string) => void;
  onOutput: (language: TranslatorLanguage, delta: string) => void;
} & ({
  fast?: never;
  /** The drafts hear the same silence as Codex while its echo guard blocks the mic. */
  isBlocked: () => boolean;
  onBlockedChange: (listener: (blocked: boolean) => void) => () => void;
} | {
  fast: {
    onAudio: (language: TranslatorLanguage, delta: string) => void;
    onReady: () => void;
    onFailure: (reason: "auth" | "upstream" | "mic-unavailable") => void;
  };
});

export interface DraftSession {
  /** The track the call sends; `null` while it has none. */
  setTrack: (track: MediaStreamTrack | null) => void;
  /** Schedule audible PCM, returning false when the capture/playback graph is not running. */
  play: (samples: Int16Array, turn: number) => boolean;
  cancelPlayback: (turn?: number) => void;
  close: () => void;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function mintSecrets(mine: TranslatorLanguage, theirs: TranslatorLanguage, signal: AbortSignal): Promise<SessionPlan[]> {
  const response = await fetch("/api/live/draft-secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mine: mine.code, theirs: theirs.code }),
    signal,
  });
  if (!response.ok) throw new Error(response.status === 401 ? "auth" : "upstream");
  const body: unknown = await response.json();
  const sessions = body && typeof body === "object" && "sessions" in body && Array.isArray(body.sessions) ? body.sessions : [];
  const plans: SessionPlan[] = [];
  for (const language of [mine, theirs]) {
    const entry: unknown = sessions.find((item: unknown) => item && typeof item === "object" && "language" in item && item.language === language.code);
    const secret = entry && typeof entry === "object" && "secret" in entry ? entry.secret : undefined;
    if (typeof secret !== "string" || !secret) throw new Error("the secret answer was incomplete");
    plans.push({ language, secret });
  }
  return plans;
}

function openSocket(plan: SessionPlan, handlers: Pick<DraftSessionOptions, "onInput" | "onOutput" | "fast"> & { onDown: () => void; register: (socket: WebSocket) => void; signal?: AbortSignal }): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // The browser cannot set headers on a WebSocket; the realtime API takes the secret as a subprotocol.
    const socket = new WebSocket(SOCKET_URL, ["realtime", `openai-insecure-api-key.${plan.secret}`]);
    // Registered at once so a retry or a close also reaches a socket whose partner failed to open.
    handlers.register(socket);
    let opened = false;
    let ready = false;
    const onAbort = () => reject(new Error("upstream"));
    handlers.signal?.addEventListener("abort", onAbort, { once: true });
    socket.onopen = () => {
      opened = true;
      socket.send(JSON.stringify({
        type: "session.update",
        session: {
          audio: {
            input: { transcription: { model: "gpt-realtime-whisper" }, noise_reduction: handlers.fast ? null : { type: "near_field" } },
            output: { language: plan.language.code },
          },
        },
      }));
      if (!handlers.fast) resolve(socket);
    };
    socket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
      const delta = "delta" in parsed && typeof parsed.delta === "string" ? parsed.delta : "";
      if (parsed.type === "session.updated" && handlers.fast && !ready) {
        ready = true;
        handlers.signal?.removeEventListener("abort", onAbort);
        resolve(socket);
      } else if (parsed.type === "session.input_transcript.delta") handlers.onInput(plan.language, delta);
      else if (parsed.type === "session.output_transcript.delta") handlers.onOutput(plan.language, delta);
      else if (parsed.type === "session.output_audio.delta" && delta) handlers.fast?.onAudio(plan.language, delta);
      else if (parsed.type === "error") {
        // The API refused the configuration or the audio: the session is of no use, so it takes the retry path.
        console.warn("[interpreter] a draft session reported an error");
        handlers.onDown();
      }
    };
    socket.onerror = () => {
      if (!opened) reject(new Error("the draft socket could not open"));
      if (handlers.fast) handlers.onDown();
    };
    socket.onclose = () => {
      if (!opened) reject(new Error("the draft socket closed before it opened"));
      if (opened || handlers.fast) handlers.onDown();
    };
  });
}

/**
 * Open the two sessions and the microphone capture. Returns at once; sockets and the capture come up
 * in the background and are retried a bounded number of times before the drafts give up quietly.
 */
export function openDraftSession(options: DraftSessionOptions): DraftSession {
  const abort = new AbortController();
  const sockets: WebSocket[] = [];
  let context: AudioContext | null = null;
  let worklet: AudioWorkletNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let track: MediaStreamTrack | null = null;
  let unsubscribeBlocked: (() => void) | undefined;
  let retryTimer: number | undefined;
  let retries = 0;
  let closed = false;
  let captureStopped = false;
  let playback: GainNode | null = null;
  const playing = new Map<AudioBufferSourceNode, { turn: number; ends: number }>();
  let playbackEnd = 0;
  let connectTimeout: number | undefined;
  let fastReady = false;
  let socketsReady = false;

  const cancelPlayback = (turn?: number) => {
    for (const [node, queued] of playing) {
      if (turn !== undefined && queued.turn !== turn) continue;
      node.stop();
      playing.delete(node);
    }
    playbackEnd = 0;
    for (const queued of playing.values()) playbackEnd = Math.max(playbackEnd, queued.ends);
  };

  const closeSockets = () => {
    for (const socket of sockets.splice(0)) {
      socket.onclose = null;
      socket.onmessage = null;
      socket.onerror = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
    }
  };

  const connectSource = () => {
    source?.disconnect();
    source = null;
    if (!context || !worklet || !track) return;
    try {
      source = context.createMediaStreamSource(new MediaStream([track]));
      source.connect(worklet);
      if (options.fast && track.readyState !== "live") fail("mic-unavailable");
    } catch {
      console.warn("[interpreter] draft captions cannot read the microphone");
      if (options.fast) fail("mic-unavailable");
    }
  };

  /** Release the microphone capture (also when the drafts give up: nothing is listening to it any more). */
  const stopCapture = () => {
    captureStopped = true;
    cancelPlayback();
    playback?.disconnect();
    playback = null;
    unsubscribeBlocked?.();
    unsubscribeBlocked = undefined;
    source?.disconnect();
    source = null;
    if (worklet) worklet.port.onmessage = null;
    worklet?.disconnect();
    worklet = null;
    if (context && context.state !== "closed") void context.close().catch(() => {});
    context = null;
  };

  const retryOrGiveUp = () => {
    if (options.fast) {
      fail("upstream");
      return;
    }
    closeSockets();
    if (closed || retryTimer !== undefined) return;
    if (retries >= MAX_RETRIES) {
      console.warn("[interpreter] draft captions stopped; the interpretation goes on without them");
      stopCapture();
      return;
    }
    retries += 1;
    retryTimer = window.setTimeout(() => {
      retryTimer = undefined;
      void connect();
    }, RETRY_DELAY_MS);
  };

  /**
   * End the drafts for good. Only this session's own resources go: the call's microphone and the
   * Codex call belong to someone else. A capture that cannot start has nothing left to feed, so it
   * takes this path instead of leaving its sockets and audio context open with no listener.
   */
  const end = () => {
    if (closed) return;
    closed = true;
    abort.abort();
    window.clearTimeout(retryTimer);
    retryTimer = undefined;
    window.clearTimeout(connectTimeout);
    closeSockets();
    stopCapture();
  };

  const fail = (reason: Parameters<NonNullable<DraftSessionOptions["fast"]>["onFailure"]>[0]) => {
    if (closed) return;
    end();
    options.fast?.onFailure(reason);
  };

  const checkReady = () => {
    if (options.fast && !closed && !fastReady && source && socketsReady) {
      fastReady = true;
      window.clearTimeout(connectTimeout);
      options.fast.onReady();
    }
  };

  const connect = async () => {
    if (closed) return;
    if (options.fast) connectTimeout = window.setTimeout(() => fail("upstream"), CONNECT_TIMEOUT_MS);
    try {
      const plans = await mintSecrets(options.mine, options.theirs, abort.signal);
      if (closed) return;
      const register = (socket: WebSocket) => void sockets.push(socket);
      await Promise.all(plans.map((plan) => openSocket(plan, {
        onInput: options.onInput, onOutput: options.onOutput, fast: options.fast, onDown: retryOrGiveUp, register,
        signal: options.fast ? abort.signal : undefined,
      })));
      socketsReady = true;
      if (closed) closeSockets();
      else checkReady();
    } catch (error) {
      if (options.fast) {
        fail(error instanceof Error && error.message === "auth" ? "auth" : "upstream");
        return;
      }
      // The reason can name the request; the drafts are optional, so the details stay out of the log.
      retryOrGiveUp();
    }
  };

  const startCapture = async () => {
    if (typeof AudioContext !== "function" || typeof AudioWorkletNode !== "function") {
      console.warn("[interpreter] draft captions need AudioWorklet");
      if (options.fast) fail("mic-unavailable");
      else end();
      return;
    }
    try {
      const next = new AudioContext({ sampleRate: SAMPLE_RATE });
      context = next;
      // Fast starts from the button gesture, before permission or network awaits.
      const resume = options.fast ? next.resume() : null;
      await Promise.all([next.audioWorklet.addModule(CAPTURE_MODULE), resume]);
      if (closed || captureStopped) return;
      if (!resume) await next.resume().catch(() => {});
      if (closed || captureStopped) return;
      const node = new AudioWorkletNode(next, CAPTURE_PROCESSOR, {
        numberOfOutputs: 0,
        numberOfInputs: options.fast ? 2 : 1,
        processorOptions: { chunkSamples: CHUNK_SAMPLES, cancelPlayback: Boolean(options.fast) },
      });
      node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (options.fast && !fastReady) return;
        if (!sockets.some((socket) => socket.readyState === WebSocket.OPEN)) return;
        const message = JSON.stringify({ type: "session.input_audio_buffer.append", audio: toBase64(new Uint8Array(event.data)) });
        for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
      };
      worklet = node;
      if (options.fast) {
        playback = next.createGain();
        playback.connect(next.destination);
        playback.connect(node, 0, 1);
      } else {
        // Muted at the moment the guard mutes Codex's microphone, and opened at the moment it opens.
        node.port.postMessage({ muted: options.isBlocked() });
        unsubscribeBlocked = options.onBlockedChange((blocked) => node.port.postMessage({ muted: blocked }));
      }
      connectSource();
      checkReady();
    } catch {
      console.warn("[interpreter] draft captions cannot capture the microphone");
      // Without a capture the drafts have nothing to translate: their sockets would stay open unused.
      if (options.fast) fail("mic-unavailable");
      else end();
    }
  };

  void startCapture();
  if (!options.fast) void connect();

  return {
    setTrack: (next) => {
      if (closed) return;
      const startWithTrack = options.fast && next && !track;
      track = next;
      connectSource();
      if (startWithTrack && !closed) void connect();
    },
    play: (samples, turn) => {
      if (context?.state !== "running" || !playback || !samples.length) return false;
      const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;
      const node = context.createBufferSource();
      node.buffer = buffer;
      node.connect(playback);
      node.onended = () => { playing.delete(node); node.disconnect(); };
      const begin = Math.max(playbackEnd, context.currentTime);
      playbackEnd = begin + buffer.duration;
      playing.set(node, { turn, ends: playbackEnd });
      node.start(begin);
      return true;
    },
    cancelPlayback,
    close: () => {
      end();
    },
  };
}
