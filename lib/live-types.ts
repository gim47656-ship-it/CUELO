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
}

export interface LiveVoiceOption {
  value: string;
  label: string;
}

export interface LiveVoices {
  voices: LiveVoiceOption[];
  defaultVoice: string;
}

export type LiveEvent =
  | { type: "state"; state: LiveState }
  | { type: "transcript"; role: LiveTranscriptRole; text: string; final: boolean }
  | { type: "delegation"; status: "started" | "completed"; request?: string }
  | { type: "error"; message: string };

export interface LiveErrorBody {
  error: "bad-request" | "live-auth" | "not-found" | "live-upstream";
  message?: string;
}
