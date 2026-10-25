import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { $env } from "@oh-my-pi/pi-utils";
import { getVertexAccessToken, userAdcPath } from "@oh-my-pi/pi-ai/providers/google-auth";
import { geminiInterpreterSetup, GEMINI_INTERPRETER_MODEL } from "./gemini-interpreter";
import type { InterpreterContext } from "./translator-context";
import type { TranslatorLanguage } from "./translator-languages";
import type { LivePace } from "./live-types";

/**
 * 설정과 인증. Google Cloud 크레딧은 Cloud 프로젝트의 Vertex AI 사용에만 붙는다. 이 프로젝트는 조직
 * 정책상 API 키를 허용하지 않으므로 Application Default Credentials만 쓴다(pi-ai의 Vertex 관례:
 * `GOOGLE_APPLICATION_CREDENTIALS` 파일, 아니면 `gcloud auth application-default login`의 사용자 자격).
 * 접근 토큰은 서버에서만 쓰고 화면에는 가지 않는다. 프로젝트와 위치는 비밀이 아니지만 저장소에 박지
 * 않고 pi-ai의 환경 변수 관례를 따른다(`~/.env`, `~/.omp/agent/.env` 등을 `$env`가 읽는다).
 */

export interface CloudInterpreterConfig {
  project: string;
  location: string;
}

export type CloudInterpreterErrorKind = "not-configured" | "live-auth" | "live-upstream" | "busy";

export class CloudInterpreterError extends Error {
  readonly kind: CloudInterpreterErrorKind;
  readonly status: number;

  constructor(kind: CloudInterpreterErrorKind, status: number, message: string) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// Google Cloud project ids: 6-30 chars, lowercase letters, digits and hyphens, starting with a letter.
const PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
// Region names (`us-central1`) or `global`; also keeps the value safe inside a host name.
const LOCATION = /^(?:global|[a-z]+-[a-z]+\d{1,2})$/;

type Env = Record<string, string | undefined>;

const firstSet = (env: Env, names: readonly string[]) => names.map((name) => env[name]?.trim()).find((value) => value) ?? "";

/** The configured project and location, or `null` (no fallback) when either is missing or malformed. */
export function readCloudConfig(env: Env = $env): CloudInterpreterConfig | null {
  const project = firstSet(env, ["GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT"]);
  const location = firstSet(env, ["GOOGLE_CLOUD_LOCATION", "GOOGLE_VERTEX_LOCATION", "VERTEX_LOCATION"]);
  return PROJECT_ID.test(project) && LOCATION.test(location) ? { project, location } : null;
}

export function requireCloudConfig(env?: Env): CloudInterpreterConfig {
  const config = readCloudConfig(env);
  if (!config) {
    throw new CloudInterpreterError(
      "not-configured",
      503,
      "Google Cloud interpreting is not set up: set GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION on the server.",
    );
  }
  return config;
}

/** Whether a credential file ADC would read exists (a service-account file, or the gcloud user login). */
export function hasCloudCredentials(env: Env = $env, exists: (path: string) => boolean = existsSync): boolean {
  const file = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  return exists(file || userAdcPath());
}

/** The Live API WebSocket endpoint of a location. */
export function cloudLiveUrl(location: string): string {
  const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  return `wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`;
}

/**
 * Upstream request headers from ADC. pi-ai refreshes and caches the access token; a missing or
 * refused credential becomes `live-auth` with a fixed message (Google's text is never echoed).
 */
export async function cloudAuthHeaders(getToken: () => Promise<string> = getVertexAccessToken): Promise<Record<string, string>> {
  let token: string;
  try {
    token = await getToken();
  } catch {
    throw new CloudInterpreterError(
      "live-auth",
      401,
      "No usable Google Cloud sign-in on the server. Run `gcloud auth application-default login` for the project owner.",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

/**
 * Cloud(Vertex AI) 통역의 서버 중계. Vertex의 Live API는 서버 간 인증만 받고 일회용 토큰이 없으므로,
 * 자격(ADC 접근 토큰)은 서버에 두고 서버가 Vertex에 WebSocket을 연다. 브라우저는 이 중계의 호출 번호로
 * 오디오 묶음을 POST하고(`/api/live/interpret/cloud/input`), Vertex가 보낸 메시지를 SSE로 그대로
 * 받는다(`/api/live/interpret/cloud/events`). 메시지 해석·전사 마감·재생은 브라우저의 기존 Gemini
 * 코드가 한다. 설정(모델·통역 지시·전사)은 서버가 첫 프레임으로 보내며 브라우저의 setup은 버린다.
 *
 * 묶음마다 상한이 있다. 아직 읽히지 않은 내려받기, 올려보내기 적체, 동시 호출 수가 넘치면 그 호출을
 * 이유와 함께 닫는다. 아무도 이벤트를 읽으러 오지 않거나 읽던 연결이 끊기면 Vertex 연결도 닫는다.
 */

/** Concurrent relayed calls. One device needs one; a few more cover a reconnect overlap. */
export const CLOUD_MAX_CALLS = 4;
/** A created call whose event stream is not opened by then is closed. */
export const CLOUD_ATTACH_TIMEOUT_MS = 15_000;
/** Downstream bytes waiting for the event stream before the call is failed instead of growing. */
export const CLOUD_MAX_PENDING_BYTES = 4_000_000;
/** Upstream bytes the socket may hold before input is refused (about 20 s of 16 kHz PCM). */
export const CLOUD_MAX_UPSTREAM_BACKLOG_BYTES = 1_000_000;
/** Frames one input request may carry (40 ms each). */
export const CLOUD_MAX_FRAMES_PER_REQUEST = 50;
/** One frame of 16 kHz PCM16 in base64 is about 1.7 KB; this leaves room and refuses abuse. */
const MAX_FRAME_BASE64_CHARS = 64_000;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

/** What the browser's relay socket receives, in order. `message` carries Vertex's JSON text verbatim. */
export type CloudRelayEvent =
  | { type: "open" }
  | { type: "message"; data: string }
  | { type: "close"; code: number; reason: string };

export interface CloudUpstreamSocket {
  readyState: number;
  bufferedAmount: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type CloudSocketFactory = (url: string, headers: Record<string, string>) => CloudUpstreamSocket;

// Bun's WebSocket takes request headers; the access token never goes into the URL.
const defaultSocketFactory: CloudSocketFactory = (url, headers) =>
  new (WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => CloudUpstreamSocket)(url, { headers });

interface CloudRelayCall {
  id: string;
  socket: CloudUpstreamSocket;
  pending: CloudRelayEvent[];
  pendingBytes: number;
  /** The attached reader. Returns how many bytes it has accepted but not yet handed to the browser. */
  subscriber: ((event: CloudRelayEvent) => number) | null;
  attached: boolean;
  /** Vertex accepted the WebSocket handshake. */
  opened: boolean;
  closed: boolean;
  attachTimer: ReturnType<typeof setTimeout> | undefined;
}

declare global {
  var __cloudInterpreterCalls: Map<string, CloudRelayCall> | undefined;
  var __cloudInterpreterEnded: Map<string, CloudRelayEvent> | undefined;
}

function relayCalls(): Map<string, CloudRelayCall> {
  globalThis.__cloudInterpreterCalls ??= new Map();
  return globalThis.__cloudInterpreterCalls;
}

/** The close event of calls that ended before their reader attached, kept for one attach window. */
function endedCalls(): Map<string, CloudRelayEvent> {
  globalThis.__cloudInterpreterEnded ??= new Map();
  return globalThis.__cloudInterpreterEnded;
}

const textDecoder = new TextDecoder();

function messageText(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return textDecoder.decode(data);
  if (ArrayBuffer.isView(data)) return textDecoder.decode(data);
  return null;
}

function eventBytes(event: CloudRelayEvent): number {
  return event.type === "message" ? event.data.length : 64;
}

function deliver(call: CloudRelayCall, event: CloudRelayEvent): void {
  if (call.subscriber) {
    // An attached reader that stops draining (a stalled download) gets the same cap as no reader.
    const unread = call.subscriber(event);
    if (unread > CLOUD_MAX_PENDING_BYTES && event.type !== "close") finish(call, 1011, "The interpreter stream was not read in time.");
    return;
  }
  call.pending.push(event);
  call.pendingBytes += eventBytes(event);
  if (call.pendingBytes > CLOUD_MAX_PENDING_BYTES && event.type !== "close") {
    finish(call, 1011, "The interpreter stream was not read in time.");
  }
}

/** Close the call once: tell the reader why, close Vertex, forget the call. */
function finish(call: CloudRelayCall, code: number, reason: string): void {
  if (call.closed) return;
  call.closed = true;
  clearTimeout(call.attachTimer);
  relayCalls().delete(call.id);
  const { socket } = call;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  if (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN) {
    try {
      socket.close(1000);
    } catch {
      // Already closing.
    }
  }
  const event: CloudRelayEvent = { type: "close", code, reason };
  if (call.subscriber) {
    call.subscriber(event);
    return;
  }
  call.pending = [];
  call.pendingBytes = 0;
  if (call.attached) return;
  // A reader that attaches late (a refused handshake can beat it) still learns why, not just "gone".
  const ended = endedCalls();
  ended.set(call.id, event);
  const expire = setTimeout(() => ended.delete(call.id), CLOUD_ATTACH_TIMEOUT_MS);
  (expire as { unref?: () => void }).unref?.();
}

export interface CloudCallRequest {
  config: CloudInterpreterConfig;
  /** ADC access-token source; tests inject one. */
  getToken?: () => Promise<string>;
  mine: TranslatorLanguage;
  theirs: TranslatorLanguage;
  context: InterpreterContext;
  pace: LivePace;
  createSocket?: CloudSocketFactory;
  attachTimeoutMs?: number;
}

/** The setup frame: the same interpreter setup as the Developer API path, with Vertex's model path. */
export function cloudInterpreterSetup(config: CloudInterpreterConfig, request: Pick<CloudCallRequest, "mine" | "theirs" | "context" | "pace">) {
  return {
    ...geminiInterpreterSetup(request.mine, request.theirs, request.context, request.pace),
    model: `projects/${config.project}/locations/${config.location}/publishers/google/models/${GEMINI_INTERPRETER_MODEL}`,
  };
}

/**
 * Open a relayed Vertex Live session. Throws `CloudInterpreterError` before any connection when the
 * server has no usable sign-in or the relay is full.
 */
export async function createCloudCall(request: CloudCallRequest): Promise<{ callId: string; model: string }> {
  const headers = await cloudAuthHeaders(request.getToken);
  // Checked after the await so concurrent opens cannot all pass it.
  if (relayCalls().size >= CLOUD_MAX_CALLS) {
    throw new CloudInterpreterError("busy", 429, "Too many Google Cloud interpreter calls are open. Stop one and try again.");
  }
  const setup = cloudInterpreterSetup(request.config, request);
  const socket = (request.createSocket ?? defaultSocketFactory)(cloudLiveUrl(request.config.location), headers);
  const call: CloudRelayCall = {
    id: randomUUID(),
    socket,
    pending: [],
    pendingBytes: 0,
    subscriber: null,
    attached: false,
    opened: false,
    closed: false,
    attachTimer: undefined,
  };
  relayCalls().set(call.id, call);
  socket.binaryType = "arraybuffer";
  socket.onopen = () => {
    if (call.closed) return;
    socket.send(JSON.stringify({ setup }));
    call.opened = true;
    deliver(call, { type: "open" });
  };
  socket.onmessage = (event) => {
    if (call.closed) return;
    const text = messageText(event.data);
    if (text !== null) deliver(call, { type: "message", data: text });
  };
  // `error` is always followed by `close`, which carries the code and reason.
  socket.onerror = () => {};
  socket.onclose = (event) => {
    if (call.closed) return;
    // A refused handshake (expired sign-in, API off, no permission) closes without a reason: name it. A drop
    // after the handshake keeps its own code so the browser reconnects.
    const reason = event.reason || (!call.opened ? "Google Cloud refused the connection: check the sign-in permission, project and Vertex AI API." : "");
    finish(call, event.code, reason);
  };
  call.attachTimer = setTimeout(() => {
    if (!call.attached) finish(call, 1011, "The interpreter stream was never opened.");
  }, request.attachTimeoutMs ?? CLOUD_ATTACH_TIMEOUT_MS);
  return { callId: call.id, model: GEMINI_INTERPRETER_MODEL };
}

/**
 * Attach the single reader of a call: queued events are replayed first. `send` returns the bytes the
 * reader holds unsent. Returns the detach function, or `null` when the call is unknown or already has
 * a reader. Detaching ends the call: a closed reader means the browser stopped or went away. A call
 * that already ended unread replays only its close event.
 */
export function subscribeCloudCall(callId: string, send: (event: CloudRelayEvent) => number): (() => void) | null {
  const call = relayCalls().get(callId);
  if (!call) {
    const ended = endedCalls().get(callId);
    if (!ended) return null;
    endedCalls().delete(callId);
    send(ended);
    return () => {};
  }
  if (call.attached) return null;
  call.attached = true;
  clearTimeout(call.attachTimer);
  const pending = call.pending;
  call.pending = [];
  call.pendingBytes = 0;
  call.subscriber = send;
  for (const event of pending) {
    if (call.closed) break;
    deliver(call, event);
  }
  return () => {
    call.subscriber = null;
    finish(call, 1000, "");
  };
}

export type CloudInputResult = "sent" | "not-found" | "not-open" | "backlog" | "bad-request";

/** Forward microphone frames (base64 PCM16 16 kHz) as Live realtime input. */
export function sendCloudAudio(callId: string, frames: unknown): CloudInputResult {
  if (!Array.isArray(frames) || frames.length === 0 || frames.length > CLOUD_MAX_FRAMES_PER_REQUEST) return "bad-request";
  if (!frames.every((frame) => typeof frame === "string" && frame.length > 0 && frame.length <= MAX_FRAME_BASE64_CHARS && /^[A-Za-z0-9+/]+=*$/.test(frame))) {
    return "bad-request";
  }
  const call = relayCalls().get(callId);
  if (!call || call.closed) return "not-found";
  if (call.socket.readyState !== SOCKET_OPEN) return "not-open";
  if (call.socket.bufferedAmount > CLOUD_MAX_UPSTREAM_BACKLOG_BYTES) {
    finish(call, 1011, "The network could not keep up with the microphone audio.");
    return "backlog";
  }
  for (const frame of frames as string[]) {
    call.socket.send(JSON.stringify({ realtimeInput: { audio: { data: frame, mimeType: "audio/pcm;rate=16000" } } }));
  }
  return "sent";
}

/** Stop a call from the browser. Unknown ids are ignored (already gone). */
export function stopCloudCall(callId: string): void {
  const call = relayCalls().get(callId);
  if (call) finish(call, 1000, "");
}
