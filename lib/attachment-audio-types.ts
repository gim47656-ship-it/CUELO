/**
 * Client-safe shapes of `GET`/`POST /api/attachments/{id}/transcription`. No runtime imports, so
 * the composer can import these types without pulling the server transcriber into its bundle.
 */

/**
 * Gemini caps a request carrying inline data at 20 MB. Base64 grows the audio by 4/3, so 14 MB of
 * audio (~18.7 MB encoded) leaves room for the prompt. Larger audio is compressed and split first.
 */
export const MAX_TRANSCRIBE_AUDIO_BYTES = 14 * 1024 * 1024;

/** What transcribing one stored audio attachment will take, shown before anything is sent. */
export type AudioTranscriptionPlan = {
  /** Measured length of the audio stream; null for small files sent as they are. */
  durationSeconds: number | null;
  /** Transcription requests the attachment needs, one per part. */
  estimatedCalls: number;
  /** True when `POST` must carry `{ confirmed: true }` before any request is made. */
  requiresConfirmation: boolean;
  processing: "direct" | "compress-and-split";
  notice: string;
};

/**
 * The `POST` body. `{}` starts transcribing (large audio needs `confirmed: true`); a fallback offer
 * is answered with its token: `approve: true` continues with the fallback, `approve: false` drops it.
 */
export type AudioTranscriptionRequest = { confirmed?: boolean } | { fallbackToken: string; approve: boolean };

/**
 * `409` body when the primary failed and the fallback (another provider) waits for the user. Nothing
 * has gone to the fallback yet; the offer is bound to this attachment, usable once, and expires.
 */
export type AudioFallbackOffer = {
  code: "fallback_confirmation_required";
  /** Why the primary failed. */
  error: string;
  /** Parts the primary finished; they are kept on the server and not sent again. */
  completedParts: number;
  parts: number;
  fallbackToken: string;
  /** What continuing sends where, shown before the user decides. */
  notice: string;
  expiresInSeconds: number;
};

export type AudioTranscriptionResult = { transcript: string; parts: number };
