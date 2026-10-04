/**
 * Server-side speech-to-text for audio pasted into the composer. Chat models (Opus and the like)
 * take no audio input, so the file is transcribed once by Gemini 3.8 Flash on the Antigravity
 * account and the text rides the normal document attachment.
 *
 * pi-ai's `transcribeAudio` only dispatches the `openai-transcriptions` API, so there is no Gemini
 * transcription transport. The Google converters (`google-shared.ts` `convertGoogleImagePart`) put
 * an `ImageContent` block on the wire as `inlineData { mimeType, data }` verbatim, which is exactly
 * Gemini's inline audio part, so the audio travels as that block with its real `audio/*` MIME type.
 */
import { MAX_TRANSCRIBE_AUDIO_BYTES } from "./attachment-audio-types";

export const TRANSCRIBE_PROVIDER = "google-antigravity";
export const TRANSCRIBE_MODEL = "gemini-3.8-flash";
/** One request's deadline; a split recording makes one request per part. */
export const TRANSCRIBE_TIMEOUT_MS = 180_000;
const TRANSCRIBE_MAX_TOKENS = 32_768;

export const TRANSCRIBE_PROMPT = [
  "Transcribe the speech in this audio file verbatim.",
  "- Keep the spoken language; do not translate or summarize.",
  "- Output only the transcript text: no heading, quotes, timestamps, or commentary.",
  "- If several people speak, start each speaker change on a new line.",
  "- If there is no intelligible speech, output exactly: [no speech]",
].join("\n");

type TranscribeResult = {
  stopReason: string;
  errorMessage?: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
};

const MAX_ATTEMPTS = 2;
const ERROR_TEXT_CHARS = 160;

/** A reply that stopped with an error; Antigravity's safety filter trips on some clips at random. */
export class TranscriptStoppedError extends Error {}

/** Turns one model reply into the transcript, or throws when it is unusable. */
export function readTranscript(result: TranscribeResult): string {
  const text = result.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("")
    .trim();
  if (result.stopReason !== "stop" && result.stopReason !== "length") {
    // The provider puts its reason (for example a filter notice) in the text, not in errorMessage.
    const detail = [result.errorMessage, text.slice(0, ERROR_TEXT_CHARS)].filter(Boolean).join("; ");
    throw new TranscriptStoppedError(`transcription stopped: ${result.stopReason}${detail ? ` (${detail})` : ""}`);
  }
  if (!text) throw new Error("transcription returned no text");
  return result.stopReason === "length" ? `${text}\n[transcript truncated at the output limit]` : text;
}

/** One transcription through CUELO's shared omp runtime and its stored Antigravity credentials. */
export async function transcribeAudioWithGemini(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
  if (audio.byteLength > MAX_TRANSCRIBE_AUDIO_BYTES) {
    throw new Error(`audio exceeds the ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024} MB transcription limit`);
  }
  const [{ completeSimple }, { getOmpRuntime }] = await Promise.all([
    import("@oh-my-pi/pi-ai"),
    import("@/lib/omp-runtime"),
  ]);
  const { modelRegistry } = await getOmpRuntime();
  const model = modelRegistry.find(TRANSCRIBE_PROVIDER, TRANSCRIBE_MODEL);
  if (!model) throw new Error(`${TRANSCRIBE_PROVIDER}/${TRANSCRIBE_MODEL} is not available`);
  if (!model.input.includes("image")) throw new Error(`${TRANSCRIBE_MODEL} does not accept inline media`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No credentials for ${TRANSCRIBE_PROVIDER}` : auth.error);
  const deadline = AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS);
  const context = {
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: TRANSCRIBE_PROMPT },
        { type: "image" as const, mimeType, data: Buffer.from(audio).toString("base64") },
      ],
      timestamp: Date.now(),
    }],
  };
  const options = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxTokens: TRANSCRIBE_MAX_TOKENS,
    disableReasoning: true,
    cacheRetention: "none" as const,
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  };
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return readTranscript(await completeSimple(model, context, options));
    } catch (error) {
      if (!(error instanceof TranscriptStoppedError) || options.signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}
