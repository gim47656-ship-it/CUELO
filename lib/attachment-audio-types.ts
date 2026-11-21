/**
 * Client-safe shapes of `GET`/`POST /api/attachments/{id}/transcription`. No runtime imports, so
 * the composer can import these types without pulling the server transcriber into its bundle.
 */

/** What transcribing one stored audio attachment will take, shown before anything is sent. */
export type AudioTranscriptionPlan = {
  /** Measured length; older servers may return null for a direct request. */
  durationSeconds: number | null;
  /** Transcription requests the attachment needs, one per part. */
  estimatedCalls: number;
  /** True when `POST` must carry `{ confirmed: true }` before any request is made. */
  requiresConfirmation: boolean;
  processing: "direct" | "compress-and-split";
  notice: string;
};

/** Old clients can still answer an expired fallback offer; that request never sends audio. */
export type AudioTranscriptionRequest = { confirmed?: boolean } | { fallbackToken: string; approve: boolean };
export type AudioTranscriptionResult = { transcript: string; parts: number };
