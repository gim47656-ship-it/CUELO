/**
 * Contract shared by the live voice API routes and the browser hook.
 *
 * The browser owns the microphone and the `RTCPeerConnection`; the server owns
 * the Codex credential, the signaling request and the sideband WebSocket. The
 * only things that cross between them are the two SDP strings and the events
 * below, so no token or upstream URL is ever visible to the page.
 */

export type LiveTranscriptRole = "user" | "assistant";

/** Persisted custom-message contract for finalized live voice turns. */
export const LIVE_TRANSCRIPT_MESSAGE_TYPE = "live-transcript";

export interface LiveTranscriptDetails {
  role: LiveTranscriptRole;
  /** assistant 턴을 실제로 말한 캐릭터와 음성 모드. 판별하지 못했으면 없다. */
  speaker?: { alias: string; mode: "character" | "native" };
}

/** 저장된 details에서 화자를 읽는다. 형식이 어긋나면 화자를 지어내지 않고 없음으로 둔다. */
export function parseLiveTranscriptSpeaker(details: unknown): LiveTranscriptDetails["speaker"] {
  if (!details || typeof details !== "object" || !("speaker" in details)) return undefined;
  const speaker = details.speaker;
  if (!speaker || typeof speaker !== "object") return undefined;
  const { alias, mode } = speaker as { alias?: unknown; mode?: unknown };
  if (typeof alias !== "string" || alias.trim() === "") return undefined;
  if (mode !== "character" && mode !== "native") return undefined;
  return { alias, mode };
}

const LIVE_TRANSCRIPT_PREFIXES: Record<LiveTranscriptRole, string> = {
  user: "User (live voice):\n",
  assistant: "Voice assistant (live voice):\n",
};

/**
 * Keep speaker attribution in the persisted content itself because the SDK
 * converts custom messages to developer context without carrying customType.
 */
export function formatLiveTranscriptContent(role: LiveTranscriptRole, text: string): string {
  return `${LIVE_TRANSCRIPT_PREFIXES[role]}${text}`;
}

/** Recover the clean spoken text for the web transcript projection. */
export function parseLiveTranscriptContent(
  content: unknown,
  details: unknown,
): { role: LiveTranscriptRole; text: string } | null {
  if (!details || typeof details !== "object" || !("role" in details)) return null;
  const role = details.role;
  if (role !== "user" && role !== "assistant") return null;
  if (typeof content !== "string") return null;
  const prefix = LIVE_TRANSCRIPT_PREFIXES[role];
  if (!content.startsWith(prefix)) return null;
  const text = content.slice(prefix.length).trim();
  return text ? { role, text } : null;
}

/**
 * Per-role transcript state for one live call. `itemId` and
 * `finalizedTurnIds` are the wire identifiers the SDK decoder drops
 * (`item.id` on `*_transcript.added`, `turn.id` on `turn.done`); they are the
 * only boundary that separates a retransmitted frame from a genuinely
 * repeated identical sentence. The two ids live in different namespaces and
 * are never compared to each other. `finalizedTurnIds` is one shared set per
 * role that accumulates every finalized `turn.id` for the life of the call,
 * so a retransmitted `turn.done` is dropped even when it arrives after later
 * turns completed.
 */
export interface LiveTranscriptTurn {
  text: string;
  final: boolean;
  /** `item.id` of the transcript item that produced this text, when known. */
  itemId?: string;
  /** Shared per-role set of every `turn.id` already finalized in this call. */
  finalizedTurnIds?: Set<string>;
}

/**
 * Merge one transcript frame into the per-role state, mirroring the SDK live
 * controller's cumulative handling. A `turn.done` whose `turn.id` was already
 * finalized is a retransmission and is dropped regardless of intervening
 * turns; a different `turn.id`/`item.id` after a final starts a new turn even
 * when the text is identical. Frames without an id keep the previous
 * text-equality heuristic, which cannot tell two identical turns apart.
 */
export function updateLiveTranscript(
  previous: LiveTranscriptTurn | undefined,
  text: string,
  final: boolean,
  wireId: string | undefined,
): LiveTranscriptTurn | undefined {
  if (!text) return undefined;
  let next: string;
  if (!previous?.text) {
    next = text;
  } else if (previous.final) {
    if (final) {
      if (wireId !== undefined && previous.finalizedTurnIds?.has(wireId)) return undefined;
      if (wireId === undefined && text === previous.text) return undefined;
      next = text;
    } else {
      if (wireId !== undefined && previous.itemId !== undefined && wireId === previous.itemId) return undefined;
      if (wireId === undefined && (text === previous.text || previous.text.endsWith(text))) return undefined;
      next = text;
    }
  } else if (final) {
    if (wireId !== undefined && previous.finalizedTurnIds?.has(wireId)) return undefined;
    next = previous.text.startsWith(text) && previous.text.length > text.length ? previous.text : text;
  } else if (text.startsWith(previous.text)) {
    next = text;
  } else if (previous.text.endsWith(text)) {
    next = previous.text;
  } else {
    next = previous.text + text;
  }
  next = next.trim();
  if (!next) return undefined;
  return {
    text: next,
    final,
    itemId: final ? previous?.itemId : (wireId ?? previous?.itemId),
    // One set per role, created lazily and shared by every state of that
    // role; the id is added only when a final frame is accepted.
    finalizedTurnIds:
      final && wireId !== undefined
        ? (previous?.finalizedTurnIds ?? new Set<string>()).add(wireId)
        : previous?.finalizedTurnIds,
  };
}

type LiveWireRecord = Record<string, unknown>;

function isLiveWireRecord(value: unknown): value is LiveWireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Decode one sideband frame once so the caller can read fields the SDK parser
 * drops before handing the parsed object to `parseLiveServerEvent`.
 */
export function parseLiveWirePayload(payload: unknown): LiveWireRecord | null {
  let parsed = payload;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return isLiveWireRecord(parsed) ? parsed : null;
}

/**
 * The per-turn identifier a frame carries on the wire: `turn.id` on
 * `turn.done`, `item.id` on `*_transcript.added`. `parseLiveServerEvent`
 * drops both, so they must be read from the parsed payload directly.
 */
export function extractLiveWireId(record: LiveWireRecord): string | undefined {
  const container =
    record.type === "turn.done"
      ? record.turn
      : record.type === "input_transcript.added" || record.type === "output_transcript.added"
        ? record.item
        : undefined;
  if (!isLiveWireRecord(container)) return undefined;
  const id = container.id;
  return typeof id === "string" && id ? id : undefined;
}

/**
 * A finalized user turn that is, in its entirety, a request to end the call
 * ("끊어", "아, 끊어", "아… 일단 끊어", "통화 종료해 줘"). Matching is deliberately
 * whole-utterance only: negations ("끊지 마"), quotations ("끊어라고 하면") and
 * commands about something else must never hang up a call. Leading fillers are a
 * closed list of neutral discourse words; nothing else may precede the request.
 */
const HANGUP_UTTERANCE = new RegExp(
  "^(?:아|어|음|응|네|자|그럼|이제|일단|그만|좀)*"
  + "(?:(?:통화|전화)(?:를|좀|그만)*)?"
  + "(?:좀|그만)*"
  + "(?:끊어|끊을게|끊자|끊겠습니다)(?:줘|주세요|요)?$"
  + "|^(?:아|어|음|응|네|자|그럼|이제|일단|그만|좀)*(?:통화|전화)(?:를|좀|그만)*(?:종료|종료해|종료할게|종료하자)(?:줘|주세요|요)?$",
  "u",
);

export function isLiveHangupRequest(text: string): boolean {
  const compact = text.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, "");
  return compact.length > 0 && HANGUP_UTTERANCE.test(compact);
}

export type LiveState =
  | "idle"
  | "connecting"
  /** Call is up: the model is listening and speaking. */
  | "live"
  /** The live model delegated work; the session agent is running it. */
  | "working"
  | "error"
  | "closed";

export interface LiveOfferRequest {
  sessionId: string;
  /** Offer SDP produced by the browser peer connection. */
  sdp: string;
  voice?: string;
  /**
   * UI language the call should speak, as a locale id (`ko`, `en`, `zh-CN`).
   * The live prompt ships in English, so without this the model answers in
   * English even when the surface around it is Korean.
   */
  locale?: string;
}

export interface LiveOfferResponse {
  callId: string;
  /** Answer SDP returned verbatim by Codex signaling. */
  sdp: string;
  /**
   * Who speaks this call. The browser reads it before applying the answer, so
   * in character mode the native Codex track is never attached and the two
   * voices cannot overlap.
   */
  voice: LiveVoiceMode;
}

export interface LiveVoiceOption {
  value: string;
  label: string;
}

export interface LiveVoices {
  voices: LiveVoiceOption[];
  defaultVoice: string;
}

/**
 * - `character`: the server synthesizes the assistant transcript with this
 *   character's private Cartesia voice and streams PCM over the event stream.
 * - `native`: the Codex voice plays over WebRTC. `reason` says why a
 *   configured installation is not using the character voice; `no-key` is the
 *   ordinary Codex-only flow and shows nothing.
 */
export type LiveVoiceMode =
  | { mode: "character"; alias: string; tuning: "accepted" | "provisional" }
  | { mode: "native"; alias: string | null; reason: "no-key" | "character-unknown" | "voice-not-ready" };

/** Character speech arrives as raw mono `pcm_s16le` at this rate, base64 per event. */
export const LIVE_SPEECH_SAMPLE_RATE = 24_000;

export type LiveEvent =
  | { type: "state"; state: LiveState }
  | { type: "transcript"; role: LiveTranscriptRole; text: string; final: boolean }
  | { type: "delegation"; status: "started" | "completed"; request?: string }
  | { type: "voice"; voice: LiveVoiceMode }
  /** One PCM chunk. Chunks from an `epoch` older than the latest reset are stale. */
  | { type: "speech"; epoch: number; audio: string }
  /** Drop every queued and playing chunk; only chunks of `epoch` or later play. */
  | { type: "speech-reset"; epoch: number }
  /** Character speech can no longer be produced; the call ends instead of going silent. */
  | { type: "speech-error"; message: string }
  | { type: "error"; message: string };

export interface LiveErrorBody {
  error: "bad-request" | "live-auth" | "not-found" | "live-upstream";
  message?: string;
}

export type LiveCharacterVoiceState =
  | "ready"
  | "not-prepared"
  | "preparing"
  /** A paid request may have landed; the next preparation reconciles the owned list first. */
  | "needs-check"
  | "failed"
  | "missing-asset";

export interface LiveCharacterVoiceStatus {
  id: string;
  alias: string;
  state: LiveCharacterVoiceState;
  tuning?: "accepted" | "provisional";
  error?: string;
}

/** `GET /api/live/character-voice`. Local state only: reading it never calls the provider. */
export interface LiveCharacterVoiceSettings {
  configured: boolean;
  /** Masked key (`sk_car_…abcd`), never the key itself. */
  keyHint: string | null;
  preparing: boolean;
  acknowledgedAt: string | null;
  characters: LiveCharacterVoiceStatus[];
  lastError: string | null;
}
