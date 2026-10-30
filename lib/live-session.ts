import { readFileSync } from "fs";
import { join } from "path";
import { userInfo } from "os";
import { isAuthRetryableError, withOAuthAccess, type OAuthAccess } from "@oh-my-pi/pi-ai";
import { getProxyForUrl, wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
  CODEX_BASE_URL,
  CODEX_CLIENT_VERSION,
  getCodexAccountId,
  OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { prompt } from "@oh-my-pi/pi-utils";
import { getPackageDir } from "@oh-my-pi/pi-coding-agent/config";
import { generateCodexAttestation } from "@oh-my-pi/pi-coding-agent/live/attestation";
import {
  buildDelegationContextAppend,
  buildLiveSessionPayload,
  buildSessionClose,
  buildSessionContextAppend,
  chunkLiveContext,
  parseLiveServerEvent,
  type LiveClientMessage,
  type LiveContextChannel,
  type LiveServerEvent,
} from "@oh-my-pi/pi-coding-agent/live/protocol";
import { cfgLiveVoice } from "@oh-my-pi/pi-coding-agent/live/settings";
import { LIVE_VOICE_OPTIONS } from "@oh-my-pi/pi-coding-agent/live/voices";
import {
  createCustomMessage,
  LIVE_DELEGATION_MESSAGE_TYPE,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import { getRpcSession, startRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { livePaceInstructions, readLivePace } from "./live-pace";
import { invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { getOmpRuntime, getSettingsForCwd } from "./omp-runtime";
import { resolveLiveCharacter } from "./live-character";
import {
  extractLiveWireId,
  formatLiveTranscriptContent,
  LIVE_TRANSCRIPT_MESSAGE_TYPE,
  parseLiveTranscriptContent,
  parseLiveWirePayload,
  updateLiveTranscript,
  type LiveEvent,
  type LiveOfferRequest,
  type LivePace,
  type LiveOfferResponse,
  type LiveState,
  type LiveTranscriptDetails,
  type LiveTranscriptRole,
  type LiveTranscriptTurn,
  type LiveVoices,
} from "./live-types";

/**
 * Server half of the browser live voice surface.
 *
 * The CLI's `CodexLiveTransport` owns a native WebRTC peer because a terminal
 * has no media stack. A browser already is one, so the split here is different:
 * the page holds the peer connection and the microphone, and this module holds
 * everything the page must never see — the Codex OAuth credential, the
 * signaling request, and the sideband WebSocket that carries delegation.
 *
 * Wire format, session payload, event parsing and the 500-byte context chunking
 * are imported from the SDK rather than restated, so a protocol change upstream
 * cannot silently diverge here.
 */

const SIGNALING_URL = `${CODEX_BASE_URL}/codex/realtime/calls?intent=quicksilver&architecture=avas`;
const LIVE_PROVIDER = "openai-codex";
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/;
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
/**
 * How long a call may stay open with no SSE reader attached. A browser that
 * navigates away cannot send its DELETE, and an orphaned call would otherwise
 * hold a live upstream socket open forever.
 */
const ORPHAN_GRACE_MS = 60_000;
/** Session history handed to the live model at call start; each entry is clipped first. */
const HISTORY_DIGEST_CHARS = 2_400;
const HISTORY_ENTRY_CHARS = 400;

export class LiveError extends Error {
  constructor(
    message: string,
    readonly kind: "bad-request" | "live-auth" | "not-found" | "live-upstream",
    readonly status: number,
  ) {
    super(message);
    this.name = "LiveError";
  }
}

/**
 * The part of a live call the shared signaling, sideband and event helpers
 * touch. Session calls extend it below; the sessionless interpreter call
 * (`lib/translator-live.ts`) uses it as is.
 */
export interface LiveCallCore {
  callId: string;
  sideband: WebSocket;
  state: LiveState;
  listeners: Set<(event: LiveEvent) => void>;
  sendTail: Promise<void>;
  transcripts: Record<LiveTranscriptRole, LiveTranscriptTurn>;
  lastTranscript: Extract<LiveEvent, { type: "transcript" }> | undefined;
  orphanTimer: NodeJS.Timeout | undefined;
  closed: boolean;
}

interface LiveCall extends LiveCallCore {
  sessionId: string;
  detachAgent: () => void;
  activeDelegationId: string | undefined;
  persistTail: Promise<void>;
  /**
   * The Main character this call is attributed to, resolved when the call opens.
   * It only labels transcript turns; the voice is always the Codex voice.
   */
  alias: string | null;
}

declare global {
  var __liveCalls: Map<string, LiveCall> | undefined;
}

function liveCalls(): Map<string, LiveCall> {
  globalThis.__liveCalls ??= new Map();
  return globalThis.__liveCalls;
}

/**
 * The Codex voice a call uses when the request names none: `live.voice` as the
 * scope sees it now. Read per call rather than from the session's own settings
 * so a change saved from Settings applies to the next call of an open session.
 */
export async function configuredLiveVoice(cwd: string | undefined): Promise<string> {
  return cfgLiveVoice.get(await getSettingsForCwd(cwd));
}

export async function getLiveVoices(): Promise<LiveVoices> {
  return {
    voices: LIVE_VOICE_OPTIONS.map((option) => ({ value: option.value, label: option.label })),
    defaultVoice: await configuredLiveVoice(undefined),
    pace: await readLivePace(),
  };
}

/** The `rtc_*` id Codex assigns to an accepted call, carried in the Location header. */
function parseCallId(location: string | null): string | undefined {
  if (!location) return undefined;
  return location
    .split("?", 1)[0]
    ?.split("/")
    .find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}

function sidebandUrl(callId: string): string {
  const url = new URL(`https://api.openai.com/v1/live/${encodeURIComponent(callId)}`);
  url.protocol = "wss:";
  return url.toString();
}

function liveHeaders(
  access: OAuthAccess,
  sessionId: string,
  realtimeSessionId: string,
  attestation: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${access.accessToken}`,
    "OpenAI-Alpha": "quicksilver=v2",
    "User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
    "x-session-id": realtimeSessionId,
    [OPENAI_HEADERS.ORIGINATOR]: LIVE_ORIGINATOR,
    [OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
    [OPENAI_HEADERS.SCOPED_SESSION_ID]: sessionId,
    [OPENAI_HEADERS.THREAD_ID]: sessionId,
  };
  const accountId = access.accountId ?? getCodexAccountId(access.accessToken);
  if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
  if (attestation) headers["x-oai-attestation"] = attestation;
  return headers;
}

/**
 * Spoken language for a call, keyed by the UI locale the browser sent.
 *
 * The SDK prompt is written in English and states no language rule, so the
 * model defaults to speaking English no matter which locale the page runs in.
 * These lines are appended, never substituted, so the delegation persona in
 * the SDK prompt stays byte-identical to the TUI's.
 */
const SPOKEN_LANGUAGE_RULES: Record<string, string> = {
  ko: "MUST speak Korean by default, including the first greeting. Keep code identifiers, file paths, commands, and API names in their original form.",
  "zh-CN": "MUST speak Simplified Chinese by default, including the first greeting. Keep code identifiers, file paths, commands, and API names in their original form.",
  en: "MUST speak English by default, including the first greeting.",
};

/** Follow the speaker once they choose a language; the locale only sets the default. */
const LANGUAGE_FOLLOW_RULE = "If the user speaks a different language, MUST switch to that language for the rest of the call.";

function spokenLanguageSection(locale: string | undefined): string {
  // The locale arrives from the browser, so the lookup is restricted to own
  // keys: a bare index would answer `constructor` or `toString` with an
  // inherited value and splice it into the prompt.
  const rule = locale && Object.hasOwn(SPOKEN_LANGUAGE_RULES, locale) ? SPOKEN_LANGUAGE_RULES[locale] : undefined;
  if (!rule) return "";
  return `\n\n<language>\n${rule}\n${LANGUAGE_FOLLOW_RULE}\n</language>`;
}

/**
 * The live model's own system prompt. Read from the installed SDK so the web
 * surface speaks with exactly the persona the TUI does, including the rule that
 * all repository work is delegated rather than attempted in the voice turn.
 */
function liveInstructions(locale: string | undefined, pace: LivePace): string {
  const packageDir = getPackageDir();
  if (!packageDir) {
    throw new Error("omp package assets are unavailable, so live instructions cannot be loaded.");
  }
  const template = readFileSync(join(packageDir, "src", "live", "prompts", "live-instructions.md"), "utf8");
  let username = "user";
  try {
    const candidate = userInfo().username.trim();
    if (candidate) username = candidate;
  } catch {
    // Sandboxed runtimes may not expose OS account information.
  }
  const firstName = username.split(/[._\-\s]+/).find((part) => part.length > 0) ?? "there";
  const paceSection = livePaceInstructions(pace);
  return prompt.render(template, { username, firstName }) + spokenLanguageSection(locale) + (paceSection ? `\n\n${paceSection}` : "");
}

/** Marks the agent's visible answer so the live model reads it out as its own. */
function finalMessageContext(message: string): string {
  const packageDir = getPackageDir();
  if (!packageDir) return message;
  const template = readFileSync(join(packageDir, "src", "live", "prompts", "agent-final-message.md"), "utf8");
  return prompt.render(template, { message });
}

function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (!("type" in block) || block.type !== "text") continue;
    if (!("text" in block) || typeof block.text !== "string" || !block.text) continue;
    parts.push(block.text);
  }
  return parts.join("\n");
}

function emit(call: LiveCallCore, event: LiveEvent): void {
  if (event.type === "transcript") call.lastTranscript = event;
  for (const listener of call.listeners) {
    try {
      listener(event);
    } catch {
      // A dead SSE writer must not stop the call or the other readers.
    }
  }
}

function setState(call: LiveCallCore, state: LiveState): void {
  if (call.state === state) return;
  call.state = state;
  emit(call, { type: "state", state });
}

/**
 * Match the SDK live controller's cumulative transcript handling, extended
 * with the wire turn/item ids the SDK decoder drops. Distinct turns that
 * happen to carry identical text are kept, while retransmitted frames of one
 * turn are still dropped. Frames without an id keep the text heuristic.
 */
function updateTranscript(
  call: LiveCallCore,
  role: LiveTranscriptRole,
  text: string,
  final: boolean,
  wireId: string | undefined,
): string | undefined {
  const next = updateLiveTranscript(call.transcripts[role], text, final, wireId);
  if (!next) return undefined;
  call.transcripts[role] = next;
  return next.text;
}

/**
 * Persist only terminal turns. We mirror the SDK's idle no-trigger append path
 * directly so the next ordinary model turn sees the transcript without
 * scheduling a prompt or live steer while the delegated agent is streaming.
 */
function queueFinalTranscript(
  call: LiveCall,
  wrapper: AgentSessionWrapper,
  role: LiveTranscriptRole,
  text: string,
): void {
  call.persistTail = call.persistTail.then(async () => {
    // 화자는 통화가 열릴 때 확인한 Main 캐릭터다. 모르면 남기지 않는다.
    const details: LiveTranscriptDetails = role === "assistant" && call.alias
      ? { role, speaker: { alias: call.alias, mode: "native" } }
      : { role };
    const manager = wrapper.inner.sessionManager;
    const content = formatLiveTranscriptContent(role, text);
    const attribution = role === "user" ? "user" : "agent";
    const timestamp = Date.now();
    wrapper.inner.agent.appendMessage(
      createCustomMessage(
        LIVE_TRANSCRIPT_MESSAGE_TYPE,
        content,
        true,
        details,
        new Date(timestamp).toISOString(),
        attribution,
      ),
    );
    manager.appendCustomMessageEntry(
      LIVE_TRANSCRIPT_MESSAGE_TYPE,
      content,
      true,
      details,
      attribution,
      timestamp,
    );
    // Voice can be the first conversation in a lazily-created session.
    await manager.ensureOnDisk();
    await manager.flush();
    invalidateSessionListCache();
    emit(call, { type: "transcript", role, text, final: true });
  }).catch((error: unknown) => {
    emit(call, { type: "error", message: error instanceof Error ? error.message : String(error) });
    setState(call, "error");
  });
}

/** Serialize sideband writes: the wire expects one complete JSON frame at a time. */
function queueSend(call: LiveCallCore, message: LiveClientMessage): void {
  call.sendTail = call.sendTail.then(() => {
    if (call.closed || call.sideband.readyState !== WebSocket.OPEN) return;
    call.sideband.send(JSON.stringify(message));
  }).catch((error: unknown) => {
    emit(call, { type: "error", message: error instanceof Error ? error.message : String(error) });
  });
}

function appendDelegationContext(call: LiveCall, text: string, commentary: boolean): void {
  const delegationId = call.activeDelegationId;
  if (!delegationId) return;
  for (const chunk of chunkLiveContext(text)) {
    queueSend(call, buildDelegationContextAppend(delegationId, chunk, commentary ? "commentary" : undefined));
  }
}

function appendSessionContext(call: LiveCall, text: string, channel?: LiveContextChannel): void {
  for (const chunk of chunkLiveContext(text)) queueSend(call, buildSessionContextAppend(chunk, channel));
}

/** One history line for the live model: typed turns, Main answers and earlier voice turns. */
function historyLine(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("role" in message)) return undefined;
  const record = message as { role: unknown; content?: unknown; customType?: unknown; details?: unknown };
  let speaker: string;
  let text: string;
  if (record.role === "user" || record.role === "assistant") {
    speaker = record.role === "user" ? "User" : "Assistant";
    text = assistantText(record.content).trim();
  } else if (record.role === "custom" && record.customType === LIVE_TRANSCRIPT_MESSAGE_TYPE) {
    const turn = parseLiveTranscriptContent(record.content, record.details);
    if (!turn) return undefined;
    speaker = turn.role === "user" ? "User (voice)" : "Assistant (voice)";
    text = turn.text;
  } else {
    return undefined;
  }
  if (!text) return undefined;
  return `${speaker}: ${text.length <= HISTORY_ENTRY_CHARS ? text : `${text.slice(0, HISTORY_ENTRY_CHARS).trimEnd()}…`}`;
}

/**
 * The live model starts with only its system prompt, so "아까 그거" means nothing
 * to it. Hand it the recent session as silent commentary when the call opens.
 */
function sendSessionHistory(call: LiveCall, wrapper: AgentSessionWrapper): void {
  const lines: string[] = [];
  let size = 0;
  const messages = wrapper.inner.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const line = historyLine(messages[index]);
    if (!line) continue;
    if (size + line.length > HISTORY_DIGEST_CHARS && lines.length > 0) break;
    lines.push(line);
    size += line.length;
  }
  if (lines.length === 0) return;
  lines.reverse();
  appendSessionContext(
    call,
    `Conversation in this session before the call, oldest first. Background for continuity only; do not read it aloud.\n${lines.join("\n")}`,
    "commentary",
  );
}

/**
 * A Main turn the call did not delegate (typed in chat during the call) still
 * answers the same user, so its result is read out like a delegated one.
 */
function relayMainAnswer(call: LiveCall, messages: readonly unknown[]): void {
  let answer = "";
  for (let index = messages.length - 1; index >= 0 && !answer; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
    if (message?.role === "assistant") answer = assistantText(message.content).trim();
  }
  if (!answer) return;
  const request = historyLine(messages.find((message) => (message as { role?: unknown } | undefined)?.role === "user"));
  if (request) appendSessionContext(call, `Typed in chat during the call. ${request}`, "commentary");
  appendSessionContext(call, finalMessageContext(answer));
}

/**
 * A delegation is a normal agent turn. It is injected as a custom message with
 * `triggerTurn`, which is the same path the TUI uses, so the work lands in the
 * session transcript the user is already watching.
 */
function startDelegation(call: LiveCall, wrapper: AgentSessionWrapper, itemId: string, request: string): void {
  call.activeDelegationId = itemId;
  setState(call, "working");
  emit(call, { type: "delegation", status: "started", request });
  void wrapper.inner
    .sendCustomMessage(
      {
        customType: LIVE_DELEGATION_MESSAGE_TYPE,
        content: request,
        display: true,
        attribution: "agent",
      },
      { triggerTurn: true },
    )
    .catch((error: unknown) => {
      call.activeDelegationId = undefined;
      setState(call, "live");
      emit(call, { type: "error", message: error instanceof Error ? error.message : String(error) });
    });
}

/** Main session events during a call. Exported so the relay to the live model can be tested without a socket. */
export function handleAgentEvent(call: LiveCall, event: AgentSessionEvent): void {
  if (!call.activeDelegationId) {
    if (event.type === "agent_end" && event.isTerminal !== false) relayMainAnswer(call, event.messages);
    return;
  }
  if (event.type === "message_end") {
    // Tool-use turns are progress, not an answer: send them on the commentary
    // channel so the model can stay conversational without reciting them.
    if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return;
    const progress = assistantText(event.message.content).trim();
    if (progress) appendDelegationContext(call, progress, true);
    return;
  }
  if (event.type !== "agent_end" || event.isTerminal === false) return;
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index];
    if (!message || message.role !== "assistant") continue;
    const text = assistantText(message.content).trim();
    if (!text) continue;
    appendDelegationContext(call, finalMessageContext(text), false);
    break;
  }
  call.activeDelegationId = undefined;
  emit(call, { type: "delegation", status: "completed" });
  setState(call, "live");
}

/** One decoded sideband event. Exported so the relay to the live model can be tested without a socket. */
export function handleServerEvent(call: LiveCall, wrapper: AgentSessionWrapper, event: LiveServerEvent, wireId: string | undefined): void {
  // `session.started` can arrive before the sideband connects and never reach
  // us (seen on interpreter calls); any later non-error frame still proves the
  // session is up. Leave "connecting" once, sending the history digest once.
  if (call.state === "connecting" && event.type !== "error") {
    setState(call, "live");
    sendSessionHistory(call, wrapper);
  }
  switch (event.type) {
    case "session.started":
      return;
    case "input_transcript.added": {
      const text = updateTranscript(call, "user", event.item.text, false, wireId);
      if (!text) return;
      emit(call, { type: "transcript", role: "user", text, final: false });
      return;
    }
    case "output_transcript.added": {
      const text = updateTranscript(call, "assistant", event.item.text, false, wireId);
      if (!text) return;
      emit(call, { type: "transcript", role: "assistant", text, final: false });
      return;
    }
    case "turn.done": {
      const text = updateTranscript(call, event.turn.role, event.turn.transcript, true, wireId);
      if (!text) return;
      queueFinalTranscript(call, wrapper, event.turn.role, text);
      return;
    }
    case "delegation.created": {
      const request = event.item.content
        .filter((content) => content.type === "input_text")
        .map((content) => content.text)
        .join("\n")
        .trim();
      if (request) startDelegation(call, wrapper, event.item.id, request);
      return;
    }
    case "error":
      emit(call, { type: "error", message: event.message });
      setState(call, "error");
      return;
    default:
      // session.updated, output_audio.delta and unknown wire types carry no
      // browser-visible state: the audio itself arrives over WebRTC.
      return;
  }
}

/**
 * Open the sideband WebSocket of an accepted call. Every text frame is decoded
 * once: the SDK parser drops `turn.id`/`item.id`, so they are read off the
 * parsed frame first and handed over with the event, which lets identical
 * sentences on distinct turns survive. The decoded frame itself goes along for
 * wire types the SDK parser reports only as `unknown`.
 */
export function openLiveSideband(
  callId: string,
  headers: Record<string, string>,
  onEvent: (event: LiveServerEvent, wireId: string | undefined, frame: Record<string, unknown>) => void,
  onClose: (reason: string) => void,
): Promise<WebSocket> {
  const url = sidebandUrl(callId);
  // Bun's WebSocket accepts request headers through a second constructor
  // argument the DOM type does not describe; the SDK opens its sideband the
  // same way. Codex rejects the upgrade without the Authorization header.
  const socket = Reflect.construct(WebSocket, [url, { headers, proxy: getProxyForUrl(LIVE_PROVIDER, new URL(url)) }]) as WebSocket;
  const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
  let opened = false;
  const timeout = setTimeout(() => {
    if (opened) return;
    socket.close(1000, "connect timeout");
    reject(new Error("Codex live sideband connection timed out"));
  }, SIDEBAND_CONNECT_TIMEOUT_MS);
  socket.onopen = () => {
    opened = true;
    clearTimeout(timeout);
    resolve(socket);
  };
  socket.onerror = () => {
    if (opened) return;
    clearTimeout(timeout);
    reject(new Error("Codex live sideband connection failed"));
  };
  socket.onmessage = (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    const record = parseLiveWirePayload(event.data);
    const parsed = record && parseLiveServerEvent(record);
    if (record && parsed) onEvent(parsed, extractLiveWireId(record), record);
  };
  socket.onclose = (event: CloseEvent) => {
    clearTimeout(timeout);
    if (!opened) {
      reject(new Error(`Codex live sideband closed before connecting (${event.code})`));
      return;
    }
    onClose(event.reason || `sideband closed (${event.code})`);
  };
  return promise;
}

async function resolveWrapper(sessionId: string): Promise<AgentSessionWrapper> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) return existing;
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new LiveError("Session not found", "not-found", 404);
  const { session } = await startRpcSession(sessionId, filePath, undefined);
  return session;
}

/** Result of a completed Codex signaling exchange. */
export interface LiveSignalingResult {
  answer: string;
  callId: string;
  /** Reused verbatim for the sideband upgrade, which Codex authenticates the same way. */
  headers: Record<string, string>;
}

export interface LiveSignalingRequest {
  /** Offer SDP produced by the browser peer connection. */
  sdp: string;
  /** The live model's whole system prompt for this call. */
  instructions: string;
  voice: string;
  /** Sent as the Codex scoped session / thread id. */
  threadId: string;
  /** Session id for Codex credential stickiness; omitted when the call belongs to no session. */
  credentialSessionId?: string;
  /**
   * Also send `instructions` as a developer message in `session.initial_items`. Codex Live does not
   * hold an interpreter to `session.instructions` alone: it answered "근처 식당 추천해 줄 수 있어요?"
   * itself and created a delegation (5/5 on a phone, 2026-10-30), while the same text as a developer
   * item kept it interpreting (7/7). `session.update` cannot add it later (`immutable_field_update`).
   */
  developerInstructions?: boolean;
}

/** The `session` object of the signaling body. */
function liveSessionPayload(request: LiveSignalingRequest): Record<string, unknown> {
  const session: Record<string, unknown> = { ...buildLiveSessionPayload(request.instructions, request.voice) };
  if (request.developerInstructions) {
    session.initial_items = [
      { type: "message", role: "developer", content: [{ type: "input_text", text: request.instructions }] },
    ];
  }
  return session;
}

/** Sign the browser's offer with the Codex OAuth credential and post it to Codex signaling. */
export async function signalLiveCall(request: LiveSignalingRequest): Promise<LiveSignalingResult> {
  const realtimeSessionId = crypto.randomUUID();
  let attestation: string | undefined;
  try {
    attestation = await generateCodexAttestation();
  } catch {
    // Device attestation is only available on some platforms; Codex accepts
    // the call without it, exactly as the CLI does here.
  }
  const fetchImpl = wrapFetchForProxy(fetch, LIVE_PROVIDER);

  const { authStorage } = await getOmpRuntime();
  return await withOAuthAccess(
    authStorage,
    LIVE_PROVIDER,
    async (access: OAuthAccess) => {
      const headers = liveHeaders(access, request.threadId, realtimeSessionId, attestation);
      const response = await fetchImpl(SIGNALING_URL, {
        method: "POST",
        headers: { ...headers, Accept: "*/*", "Content-Type": "application/json" },
        body: JSON.stringify({ sdp: request.sdp, session: liveSessionPayload(request) }),
      });
      const body = await response.text();
      if (!response.ok) {
        const detail = body.trim().replaceAll(/\s+/g, " ").slice(0, MAX_ERROR_BODY_LENGTH) || response.statusText;
        throw new LiveError(`Codex live signaling failed (${response.status}): ${detail}`, "live-upstream", 502);
      }
      if (!body.trim()) {
        throw new LiveError("Codex live signaling returned an empty SDP answer", "live-upstream", 502);
      }
      const callId = parseCallId(response.headers.get("location"));
      if (!callId) {
        throw new LiveError("Codex live signaling returned no valid call ID", "live-upstream", 502);
      }
      return { answer: body, callId, headers };
    },
    {
      ...(request.credentialSessionId ? { sessionId: request.credentialSessionId } : {}),
      isAuthError: isAuthRetryableError,
      missingAccessMessage: "No Codex OAuth credential is available for a live call.",
    },
  );
}

/**
 * The Main character this call's transcript is attributed to. Local state only:
 * the live voice is the Codex voice either way.
 */
async function resolveCallAlias(wrapper: AgentSessionWrapper): Promise<string | null> {
  const session = wrapper.inner;
  return await resolveLiveCharacter(session, {
    pinCredential: async () => {
      if (session.model) await session.modelRegistry.getApiKey?.(session.model, session.sessionId);
    },
  });
}

/** Exchange the browser's offer for a Codex answer and attach the sideband. */
export async function createLiveCall(request: LiveOfferRequest): Promise<LiveOfferResponse> {
  const wrapper = await resolveWrapper(request.sessionId);
  const alias = await resolveCallAlias(wrapper);
  const { answer, callId, headers } = await signalLiveCall({
    sdp: request.sdp,
    instructions: liveInstructions(request.locale, await readLivePace()),
    voice: request.voice?.trim() || await configuredLiveVoice(wrapper.cwd),
    threadId: request.sessionId,
    credentialSessionId: request.sessionId,
  });

  const call: LiveCall = {
    callId,
    sessionId: request.sessionId,
    // Replaced immediately below; the socket needs the call to route events.
    sideband: undefined as unknown as WebSocket,
    state: "connecting",
    listeners: new Set(),
    detachAgent: () => {},
    activeDelegationId: undefined,
    sendTail: Promise.resolve(),
    persistTail: Promise.resolve(),
    transcripts: {
      user: { text: "", final: false },
      assistant: { text: "", final: false },
    },
    lastTranscript: undefined,
    orphanTimer: undefined,
    closed: false,
    alias,
  };

  const socket = await openLiveSideband(
    callId,
    headers,
    (event, wireId) => {
      if (call.closed) return;
      handleServerEvent(call, wrapper, event, wireId);
    },
    (reason) => {
      if (call.closed) return;
      // A terminal transcript may have arrived immediately before the socket
      // closed. Let its durable append and final SSE notification win the race.
      void call.persistTail.then(() => {
        if (call.closed) return;
        emit(call, { type: "error", message: reason });
        void closeLiveCall(callId);
      });
    },
  );
  call.sideband = socket;
  call.detachAgent = wrapper.inner.subscribe((event: AgentSessionEvent) => {
    if (call.closed) return;
    handleAgentEvent(call, event);
  });

  liveCalls().set(callId, call);
  // Nothing is reading yet: the browser subscribes right after this response.
  armLiveOrphanTimer(call, () => void closeLiveCall(callId));
  return { callId, sdp: answer };
}

/** Close a call nobody reads after {@link ORPHAN_GRACE_MS}. */
export function armLiveOrphanTimer(call: LiveCallCore, close: () => void): void {
  call.orphanTimer = setTimeout(close, ORPHAN_GRACE_MS);
}

/**
 * Attach one SSE reader and replay the current state to it. The returned
 * detach re-arms the orphan timer once the last reader is gone.
 */
export function attachLiveListener(call: LiveCallCore, listener: (event: LiveEvent) => void, close: () => void): () => void {
  if (call.orphanTimer) {
    clearTimeout(call.orphanTimer);
    call.orphanTimer = undefined;
  }
  call.listeners.add(listener);
  listener({ type: "state", state: call.state });
  return () => {
    call.listeners.delete(listener);
    if (call.listeners.size > 0 || call.closed) return;
    armLiveOrphanTimer(call, close);
  };
}

/** Attach an SSE reader. Returns `null` when the call is already gone. */
export function subscribeLiveCall(callId: string, listener: (event: LiveEvent) => void): (() => void) | null {
  const call = liveCalls().get(callId);
  if (!call || call.closed) return null;
  const detach = attachLiveListener(call, listener, () => void closeLiveCall(callId));
  if (call.lastTranscript) listener(call.lastTranscript);
  return detach;
}

/**
 * Last step of every hang-up, after the caller marked the call closed and
 * settled its own work: ask Codex to end the session, tell the readers, and
 * release the sideband.
 */
export function finishLiveCall(call: LiveCallCore): void {
  if (call.sideband.readyState === WebSocket.OPEN) {
    try {
      call.sideband.send(JSON.stringify(buildSessionClose()));
    } catch {
      // The socket may already be tearing down; the close below still runs.
    }
  }
  setState(call, "closed");
  call.listeners.clear();
  if (call.sideband.readyState === WebSocket.OPEN || call.sideband.readyState === WebSocket.CONNECTING) {
    call.sideband.close(1000, "done");
  }
}

export async function closeLiveCall(callId: string): Promise<boolean> {
  const call = liveCalls().get(callId);
  if (!call) return false;
  liveCalls().delete(callId);
  if (call.closed) return true;
  call.closed = true;
  clearTimeout(call.orphanTimer);
  call.detachAgent();
  await call.persistTail;
  finishLiveCall(call);
  return true;
}

export {
  emit as emitLiveEvent,
  setState as setLiveState,
  updateTranscript as updateLiveCallTranscript,
};
