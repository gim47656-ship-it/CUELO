/**
 * Gemini 통역의 브라우저 쪽 전송부: Live 소켓 위의 세션(서버 메시지 해석), 받은 PCM 재생, Cloud 중계 소켓.
 * React와 무관하게 두어 테스트가 가짜 소켓·오디오 컨텍스트로 수명주기를 검사한다.
 *
 * - 설정(setup)은 상류 연결을 연 쪽(Cloud 중계 서버)이 보낸다. 브라우저 세션은 setup을 보내지 않는다.
 * - 전사는 역할마다 따로 쌓는다. Gemini의 `inputTranscription`·`outputTranscription`은 조각(delta)이라
 *   이어 붙여 누적 글로 내보내고, 역할마다 따로 끝낸다. 통역(assistant)은 `generationComplete`·
 *   `interrupted`·`turnComplete`에서, 원문(user)은 `turnComplete` 뒤 잠깐 더 조각이 없을 때 끝낸다.
 *   입력 전사는 다른 메시지와 순서가 보장되지 않아 `turnComplete` 뒤에 늦게 올 수 있기 때문이다.
 * - `close()` 뒤에는 어떤 처리기도 부르지 않는다. 늦게 온 메시지·타이머는 버린다.
 */

/** Gemini Live's input format. */
export const GEMINI_INPUT_MIME = "audio/pcm;rate=16000";
/** Output rate when a chunk's MIME type names none (the Live API's documented default). */
export const GEMINI_DEFAULT_OUTPUT_RATE = 24_000;

/** After `turnComplete`, how long to wait for late input-transcription pieces before closing the user turn. */
export const USER_TRANSCRIPT_SETTLE_MS = 1_200;
/** An open user turn with no new input transcription for this long closes even without `turnComplete`. */
export const USER_TRANSCRIPT_IDLE_MS = 5_000;

/**
 * Gemini Live가 말 대신 전사에 넣는 표시(`<no speech>`, `{pause}`)를 지운다. 2026-10-25 폰 실기에서
 * 통역 칸에 `<no speech>{pause}`가 그대로 나왔다. 공백만 남으면 그 줄은 내지 않는다.
 */
const visibleTranscript = (text: string) => text.replace(/<no[ _]speech>|\{pause\}/giu, "");

/**
 * Unsent bytes the socket may hold before the session fails instead of piling up. About 20 s of
 * base64 PCM16 at 16 kHz; a network that cannot keep up for that long is reconnected.
 */
export const MAX_SOCKET_BACKLOG_BYTES = 1_000_000;
/** Interpreted audio scheduled ahead of the play head before playback is declared stuck. */
export const MAX_QUEUED_OUTPUT_SECONDS = 120;
/** An open socket that has not completed setup by then is failed (and reconnected when live). */
export const SETUP_TIMEOUT_MS = 15_000;

export type GeminiTranscriptRole = "user" | "assistant";

export interface GeminiTranscriptEvent {
  role: GeminiTranscriptRole;
  text: string;
  final: boolean;
}

/** Why the socket closed, from the client's point of view. */
export interface GeminiCloseInfo {
  /** `auth`: the sign-in or permission was refused. `upstream`: quota or service refusal. `failed`: anything else. */
  failure: "auth" | "upstream" | "failed";
  /** A new connection may heal it. */
  retry: boolean;
  /** The server ended the session cleanly (expiry or after GoAway). */
  ended: boolean;
  message: string;
}

export interface GeminiLiveHandlers {
  onReady: () => void;
  onTranscript: (event: GeminiTranscriptEvent) => void;
  onAudio: (base64: string, mimeType: string) => void;
  /** The model's speech was cut off: queued playback must stop. */
  onInterrupted: () => void;
  /** The server will disconnect soon. */
  onGoAway: () => void;
  /** The socket closed or failed on its own. Never called after `close()`. */
  onClose: (info: GeminiCloseInfo) => void;
}

export interface GeminiSocketLike {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
}

export interface GeminiTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

const SOCKET_OPEN = 1;

const defaultTimers: GeminiTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => performance.now(),
};

/** Strip anything token- or key-shaped from text that may reach the screen. */
export function sanitizeGeminiMessage(text: string): string {
  return text
    .replace(/[A-Za-z0-9_\-.]{32,}/g, "[redacted]")
    .slice(0, 300);
}

export function classifyGeminiClose(code: number, reason: string): GeminiCloseInfo {
  const message = sanitizeGeminiMessage(reason || `socket closed (${code})`);
  // Close reasons are cut to about 123 bytes, so match the words that come early in Google's text.
  if (/quota|exceeded|RESOURCE_EXHAUSTED|billing|rate limit|credits are depleted|prepayment/i.test(reason)) {
    return { failure: "upstream", retry: false, ended: false, message };
  }
  if (/api key|PERMISSION_DENIED|UNAUTHENTICATED|unauthori[sz]ed|permission/i.test(reason)) {
    return { failure: "auth", retry: false, ended: false, message };
  }
  return { failure: "failed", retry: true, ended: code === 1000, message };
}

export function pcmRateFromMime(mimeType: string): number {
  const match = /rate=(\d+)/i.exec(mimeType);
  const rate = match ? Number(match[1]) : NaN;
  return Number.isFinite(rate) && rate >= 8_000 && rate <= 96_000 ? rate : GEMINI_DEFAULT_OUTPUT_RATE;
}

/** Sample count of a base64 PCM16 payload without decoding it. */
export function pcm16SampleCount(base64: string): number {
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return Math.floor(((base64.length * 3) / 4 - padding) / 2);
}

/** Decode little-endian PCM16 into `target` (length from `pcm16SampleCount`). Returns samples written. */
export function decodePcm16Base64Into(base64: string, target: Float32Array): number {
  const binary = atob(base64);
  const samples = Math.min(target.length, binary.length >> 1);
  for (let i = 0; i < samples; i += 1) {
    const value = (binary.charCodeAt(2 * i) | (binary.charCodeAt(2 * i + 1) << 8)) << 16 >> 16;
    target[i] = value / 0x8000;
  }
  return samples;
}

type Base64Capable = Uint8Array & { toBase64?: () => string };

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer) as Base64Capable;
  if (typeof bytes.toBase64 === "function") return bytes.toBase64();
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + CHUNK) as unknown as number[]);
  }
  return btoa(binary);
}

interface RoleTurn {
  text: string;
  open: boolean;
}

const decoder = new TextDecoder();

/** One property of parsed server JSON, or `undefined` when `value` is not an object holding it. */
function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === "object" && key in value ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * One Gemini Live connection. Opens the socket on construction, sends the setup, and reports
 * through `handlers` until it closes. `close()` is idempotent and silences every handler.
 */
export class GeminiLiveSession {
  readonly #socket: GeminiSocketLike;
  readonly #handlers: GeminiLiveHandlers;
  readonly #timers: GeminiTimers;
  #closed = false;
  #ready = false;
  readonly #turns: Record<GeminiTranscriptRole, RoleTurn> = {
    user: { text: "", open: false },
    assistant: { text: "", open: false },
  };
  #userTimer: unknown = undefined;
  #setupTimer: unknown = undefined;
  /** A `turnComplete` belongs to the open user turn: its remaining late pieces get the short window. */
  #userSawTurnComplete = false;
  #lastTurnCompleteAt = Number.NEGATIVE_INFINITY;

  /** `createSocket` opens the Live connection; whoever opens it owns the session setup. */
  constructor(
    createSocket: () => GeminiSocketLike,
    handlers: GeminiLiveHandlers,
    timers: GeminiTimers = defaultTimers,
  ) {
    this.#handlers = handlers;
    this.#timers = timers;
    const socket = createSocket();
    this.#socket = socket;
    // Text frames decode synchronously from an ArrayBuffer; a Blob would need an await that
    // could outlive `close()`.
    socket.binaryType = "arraybuffer";
    this.#setupTimer = timers.setTimeout(() => {
      this.#setupTimer = undefined;
      if (!this.#ready) this.#fail({ failure: "failed", retry: true, ended: false, message: "Gemini did not finish setting up the session." });
    }, SETUP_TIMEOUT_MS);
    // The setup is sent by the side that opened the upstream connection (the Cloud relay).
    socket.onopen = () => {};
    socket.onmessage = (event) => {
      if (this.#closed) return;
      const raw = typeof event.data === "string"
        ? event.data
        : event.data instanceof ArrayBuffer ? decoder.decode(event.data) : null;
      if (raw !== null) this.#handleMessage(raw);
    };
    // `error` is always followed by `close`, which carries the code and reason.
    socket.onerror = () => {};
    socket.onclose = (event) => {
      if (this.#closed) return;
      // What was already heard stays: open turns close as final before the session reports the end.
      this.finishTranscripts();
      this.#closed = true;
      this.#clearTimers();
      this.#handlers.onClose(classifyGeminiClose(event.code, event.reason));
    };
  }

  get ready(): boolean {
    return this.#ready && !this.#closed;
  }

  /**
   * Send one PCM16 16 kHz frame. Frames before setup completes are refused (the caller only wires
   * the microphone after `onReady`). A backlog the network cannot drain fails the session instead of
   * growing without bound; returns `false` then.
   */
  sendAudio(frame: ArrayBuffer): boolean {
    if (!this.ready || this.#socket.readyState !== SOCKET_OPEN) return false;
    if (this.#socket.bufferedAmount > MAX_SOCKET_BACKLOG_BYTES) {
      this.#fail({ failure: "failed", retry: true, ended: false, message: "The network could not keep up with the microphone audio." });
      return false;
    }
    this.#socket.send(JSON.stringify({ realtimeInput: { audio: { data: arrayBufferToBase64(frame), mimeType: GEMINI_INPUT_MIME } } }));
    return true;
  }

  /** Close every open transcript turn as final (used before a reconnect replaces this session). */
  finishTranscripts(): void {
    if (this.#closed) return;
    this.#finish("user");
    this.#finish("assistant");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearTimers();
    try {
      this.#socket.close(1000, "client closed");
    } catch {
      // Already closing.
    }
  }

  #fail(info: GeminiCloseInfo): void {
    if (this.#closed) return;
    this.finishTranscripts();
    this.close();
    this.#handlers.onClose(info);
  }

  #clearUserTimer(): void {
    if (this.#userTimer !== undefined) this.#timers.clearTimeout(this.#userTimer);
    this.#userTimer = undefined;
  }

  #clearTimers(): void {
    this.#clearUserTimer();
    if (this.#setupTimer !== undefined) this.#timers.clearTimeout(this.#setupTimer);
    this.#setupTimer = undefined;
  }

  #armUserTimer(ms: number): void {
    this.#clearUserTimer();
    this.#userTimer = this.#timers.setTimeout(() => {
      this.#userTimer = undefined;
      if (!this.#closed) this.#finish("user");
    }, ms);
  }

  #append(role: GeminiTranscriptRole, piece: string): void {
    const turn = this.#turns[role];
    if (!turn.open) {
      turn.text = "";
      turn.open = true;
    }
    turn.text += piece;
    // 조각 끝에 반쯤 온 표시(`<no spe`)는 다음 조각을 볼 때까지 화면에 내지 않는다.
    const text = visibleTranscript(turn.text).replace(/<[^>]*$|\{[^}]*$/u, "");
    if (text.trim()) this.#handlers.onTranscript({ role, text, final: false });
  }

  #finish(role: GeminiTranscriptRole): void {
    const turn = this.#turns[role];
    if (role === "user") {
      this.#clearUserTimer();
      this.#userSawTurnComplete = false;
    }
    if (!turn.open) return;
    turn.open = false;
    const text = visibleTranscript(turn.text);
    if (text.trim()) this.#handlers.onTranscript({ role, text, final: true });
    turn.text = "";
  }

  #handleMessage(raw: string): void {
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (field(message, "setupComplete") !== undefined) {
      this.#ready = true;
      if (this.#setupTimer !== undefined) this.#timers.clearTimeout(this.#setupTimer);
      this.#setupTimer = undefined;
      this.#handlers.onReady();
      return;
    }
    if (field(message, "goAway") !== undefined) {
      this.#handlers.onGoAway();
      return;
    }
    const server = field(message, "serverContent");
    if (server === undefined) return;

    const parts = field(field(server, "modelTurn"), "parts");
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const inline = field(part, "inlineData");
        const data = field(inline, "data");
        if (typeof data === "string" && data) {
          const mimeType = field(inline, "mimeType");
          this.#handlers.onAudio(data, typeof mimeType === "string" ? mimeType : "");
          if (this.#closed) return;
        }
      }
    }
    const output = field(field(server, "outputTranscription"), "text");
    if (typeof output === "string" && output) this.#append("assistant", output);
    const input = field(field(server, "inputTranscription"), "text");
    if (typeof input === "string" && input) {
      this.#append("user", input);
      // Input transcription is unordered against the model turn: pieces that come after this
      // utterance's turnComplete (even its first piece) only get the short window to join it.
      if (this.#timers.now() - this.#lastTurnCompleteAt <= USER_TRANSCRIPT_SETTLE_MS) this.#userSawTurnComplete = true;
      this.#armUserTimer(this.#userSawTurnComplete ? USER_TRANSCRIPT_SETTLE_MS : USER_TRANSCRIPT_IDLE_MS);
    }
    if (field(server, "interrupted") === true) {
      this.#finish("assistant");
      this.#handlers.onInterrupted();
      if (this.#closed) return;
    }
    if (field(server, "generationComplete") === true) this.#finish("assistant");
    if (field(server, "turnComplete") === true) {
      this.#finish("assistant");
      this.#lastTurnCompleteAt = this.#timers.now();
      if (this.#turns.user.open) {
        this.#userSawTurnComplete = true;
        this.#armUserTimer(USER_TRANSCRIPT_SETTLE_MS);
      }
    }
  }
}

/** The slice of `AudioContext` the player uses; `Destination` is the context's output node type. */
export interface AudioContextLike<Destination = unknown> {
  readonly currentTime: number;
  readonly destination: Destination;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioSourceLike<Destination>;
}

export interface AudioBufferLike {
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface AudioSourceLike<Destination = unknown> {
  buffer: unknown;
  onended: ((event: Event) => void) | null;
  connect(destination: Destination): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export class AudioBacklogError extends Error {}

/**
 * Plays Gemini's PCM chunks back to back on one AudioContext. Chunks arrive faster than real time,
 * so each is scheduled at the end of the previous one. `interrupt()` stops everything queued.
 */
export class GeminiAudioPlayer<Destination = unknown> {
  readonly #context: AudioContextLike<Destination>;
  readonly #maxQueuedSeconds: number;
  readonly #sources = new Set<AudioSourceLike<Destination>>();
  #nextTime = 0;

  constructor(context: AudioContextLike<Destination>, maxQueuedSeconds = MAX_QUEUED_OUTPUT_SECONDS) {
    this.#context = context;
    this.#maxQueuedSeconds = maxQueuedSeconds;
  }

  /** Seconds of audio scheduled ahead of the play head. */
  get queuedSeconds(): number {
    return Math.max(0, this.#nextTime - this.#context.currentTime);
  }

  /** Schedule one chunk. Throws `AudioBacklogError` instead of growing past the cap. */
  play(base64: string, mimeType: string): void {
    const samples = pcm16SampleCount(base64);
    if (samples <= 0) return;
    const rate = pcmRateFromMime(mimeType);
    if (this.queuedSeconds + samples / rate > this.#maxQueuedSeconds) {
      throw new AudioBacklogError(`Interpreted audio backed up past ${this.#maxQueuedSeconds} s.`);
    }
    const buffer = this.#context.createBuffer(1, samples, rate);
    decodePcm16Base64Into(base64, buffer.getChannelData(0));
    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.#context.destination);
    source.onended = () => {
      this.#sources.delete(source);
    };
    const startAt = Math.max(this.#context.currentTime, this.#nextTime);
    source.start(startAt);
    this.#nextTime = startAt + buffer.duration;
    this.#sources.add(source);
  }

  interrupt(): void {
    for (const source of this.#sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Not started yet or already stopped.
      }
    }
    this.#sources.clear();
    this.#nextTime = 0;
  }
}

/** Microphone frames sent per input request at most; the rest wait for the next one. */
export const RELAY_FRAMES_PER_REQUEST = 10;
/** How long frames gather before an input request goes out (keeps requests near 8 per second). */
export const RELAY_BATCH_MS = 120;

const RELAY_CLOSED = 3;
/** The relay's own input refusals (call gone, not open, backlog): it ends the call and the event stream says why. */
const RELAY_ENDING_STATUSES = new Set([404, 409, 503]);

type RelayFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Stop a relayed call on the server (also for an answer that arrived after its open was cancelled). */
export function releaseCloudRelayCall(callId: string, fetchImpl: RelayFetch = (input, init) => fetch(input, init)): void {
  void fetchImpl(`/api/live/interpret/cloud?callId=${encodeURIComponent(callId)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

/**
 * A `GeminiSocketLike` over CUELO's Cloud relay (`/api/live/interpret/cloud/*`): Vertex's messages
 * arrive as SSE and microphone frames go up in small batched POSTs, one request at a time. Unsent
 * frames count as `bufferedAmount`, so `GeminiLiveSession`'s backlog limit applies unchanged. The
 * relay sends the real setup itself; the session's own setup frame is dropped here.
 */
export class CloudRelaySocket implements GeminiSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  readonly #callId: string;
  readonly #fetch: RelayFetch;
  readonly #timers: GeminiTimers;
  readonly #abort = new AbortController();
  #frames: string[] = [];
  #inFlight = false;
  #batchTimer: unknown = undefined;

  constructor(callId: string, fetchImpl: RelayFetch = (input, init) => fetch(input, init), timers: GeminiTimers = defaultTimers) {
    this.#callId = callId;
    this.#fetch = fetchImpl;
    this.#timers = timers;
    void this.#read();
  }

  async #read(): Promise<void> {
    let closeEvent = { code: 1006, reason: "The interpreter stream ended." };
    try {
      const response = await this.#fetch(`/api/live/interpret/cloud/events?callId=${encodeURIComponent(this.#callId)}`, {
        signal: this.#abort.signal,
        cache: "no-store",
      });
      if (!response.ok || !response.body) throw new Error(`events ${response.status}`);
      const reader = response.body.getReader();
      // Per stream: a multi-byte character split across chunks must not leak into another call.
      const streamDecoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done || this.readyState === RELAY_CLOSED) break;
        buffered += streamDecoder.decode(value, { stream: true });
        let end = buffered.indexOf("\n\n");
        while (end >= 0) {
          const block = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          end = buffered.indexOf("\n\n");
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (!data) continue;
          const event = JSON.parse(data) as { type?: string; data?: unknown; code?: unknown; reason?: unknown };
          if (event.type === "open" && this.readyState === 0) {
            this.readyState = SOCKET_OPEN;
            this.onopen?.({});
          } else if (event.type === "message" && typeof event.data === "string") {
            this.onmessage?.({ data: event.data });
          } else if (event.type === "close") {
            closeEvent = { code: typeof event.code === "number" ? event.code : 1006, reason: typeof event.reason === "string" ? event.reason : "" };
            await reader.cancel().catch(() => {});
            break;
          }
          if (this.readyState === RELAY_CLOSED) return;
        }
      }
    } catch (error) {
      if (this.readyState === RELAY_CLOSED) return;
      closeEvent = { code: 1006, reason: error instanceof Error ? error.message : String(error) };
    }
    this.#closed(closeEvent);
  }

  #closed(event: { code: number; reason: string }): void {
    if (this.readyState === RELAY_CLOSED) return;
    this.readyState = RELAY_CLOSED;
    this.#timers.clearTimeout(this.#batchTimer);
    this.#frames = [];
    this.bufferedAmount = 0;
    this.onclose?.(event);
  }

  send(data: string): void {
    if (this.readyState !== SOCKET_OPEN) return;
    const audio = field(field(JSON.parse(data), "realtimeInput"), "audio");
    const frame = field(audio, "data");
    // The relay owns the setup; anything other than microphone audio is not relayed.
    if (typeof frame !== "string") return;
    this.#frames.push(frame);
    this.bufferedAmount += frame.length;
    if (this.#batchTimer === undefined && !this.#inFlight) {
      this.#batchTimer = this.#timers.setTimeout(() => {
        this.#batchTimer = undefined;
        void this.#flush();
      }, RELAY_BATCH_MS);
    }
  }

  async #flush(): Promise<void> {
    if (this.#inFlight || this.readyState !== SOCKET_OPEN || this.#frames.length === 0) return;
    const batch = this.#frames.splice(0, RELAY_FRAMES_PER_REQUEST);
    this.#inFlight = true;
    let ending = false;
    let failure: string | null = null;
    try {
      const response = await this.#fetch("/api/live/interpret/cloud/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callId: this.#callId, frames: batch }),
      });
      if (!response.ok) {
        if (RELAY_ENDING_STATUSES.has(response.status)) ending = true;
        else failure = `Audio could not reach the interpreter (HTTP ${response.status}).`;
      }
    } catch (error) {
      failure = `Audio could not reach the interpreter: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.#inFlight = false;
      const sent = batch.reduce((total, frame) => total + frame.length, 0);
      this.bufferedAmount = Math.max(0, this.bufferedAmount - sent);
    }
    // Anything else would keep the call looking live while the microphone goes nowhere.
    if (failure !== null) this.#end(1011, failure);
    else if (!ending && this.#frames.length > 0) void this.#flush();
  }

  close(): void {
    this.#end(1000, "");
  }

  #end(code: number, reason: string): void {
    if (this.readyState === RELAY_CLOSED) return;
    this.#abort.abort();
    releaseCloudRelayCall(this.#callId, this.#fetch);
    this.#closed({ code, reason });
  }
}
