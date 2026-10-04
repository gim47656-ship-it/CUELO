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

export type AudioTranscriptionRequest = { confirmed?: boolean };

export type AudioTranscriptionResult = { transcript: string; parts: number };
