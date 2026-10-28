/**
 * Server-side speech-to-text for audio pasted into the composer. Chat models (Opus and the like)
 * take no audio input, so the file is transcribed once by the model of the `draft` role (falling
 * back to Gemini 4 Argon on Google Cloud Vertex when the role is unset or names no known model)
 * and the text rides the normal document attachment.
 *
 * pi-ai's `transcribeAudio` only dispatches the `openai-transcriptions` API, so there is no Gemini
 * transcription transport. The Google converters (`google-shared.ts` `convertGoogleImagePart`) put
 * an `ImageContent` block on the wire as `inlineData { mimeType, data }` verbatim, which is exactly
 * Gemini's inline audio part, so the audio travels as that block with its real `audio/*` MIME type.
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Flag, is } from "@oh-my-pi/pi-ai/error";
import { parseModelString } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { MAX_TRANSCRIBE_AUDIO_BYTES } from "./attachment-audio-types";

/** Role whose model transcribes; the same slot that writes drafts. */
export const TRANSCRIBE_ROLE = "draft";
/** Used when the role is unset or its model is not in the registry. */
export const TRANSCRIBE_PROVIDER = "google-vertex";
export const TRANSCRIBE_MODEL = "gemini-4-argon";
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
  /** The SDK's structured error classifier (`AssistantMessage.errorId`). */
  errorId?: number;
  content: ReadonlyArray<{ type: string; text?: string }>;
};

/**
 * Only the Google transports put an `image` block on the wire as `inlineData` with its real MIME
 * type, which is how audio travels. Any other API would transmit the audio as an image or drop it.
 */
const INLINE_AUDIO_APIS: Readonly<Record<string, true>> = { "google-generative-ai": true, "google-vertex": true };

/** Throws, before any credential lookup or request, unless the model's API can carry inline audio. */
export function assertInlineAudioModel(model: Pick<Model<Api>, "provider" | "id" | "api" | "input">): void {
  const name = `${model.provider}/${model.id}`;
  if (!Object.hasOwn(INLINE_AUDIO_APIS, model.api)) throw new Error(`${name} (${model.api}) cannot carry audio`);
  if (!model.input.includes("image")) throw new Error(`${name} does not accept inline media`);
}

const MAX_ATTEMPTS = 2;
const ERROR_TEXT_CHARS = 160;

/** A reply that stopped with an error; Gemini's safety filter trips on some clips at random. */
export class TranscriptStoppedError extends Error {}

/**
 * A stop the provider reported as a content block. The fallback must not take it as a reason to send
 * the same audio to another provider.
 */
export class TranscriptBlockedError extends TranscriptStoppedError {}

/**
 * Google finish reasons the SDK maps to an error stop with the message
 * `Generation failed with finish reason: <reason>` (pi-ai `google-shared.ts` `mapStopReason`). No
 * structured flag is set for them, so the reason text is the only marker. Other stops (`OTHER`,
 * `LANGUAGE`, a stream without a finish reason, quota, network, auth) are ordinary failures.
 */
const BLOCKED_FINISH_REASON = /finish reason:\s*(?:SAFETY|BLOCKLIST|PROHIBITED_CONTENT|SPII|IMAGE_SAFETY|IMAGE_PROHIBITED_CONTENT|IMAGE_RECITATION|RECITATION)\b/;

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
    const message = `transcription stopped: ${result.stopReason}${detail ? ` (${detail})` : ""}`;
    const blocked = is(result.errorId, Flag.ContentBlocked) || BLOCKED_FINISH_REASON.test(result.errorMessage ?? "");
    throw blocked ? new TranscriptBlockedError(message) : new TranscriptStoppedError(message);
  }
  if (!text) throw new Error("transcription returned no text");
  return result.stopReason === "length" ? `${text}\n[transcript truncated at the output limit]` : text;
}

/**
 * The model that transcribes: the `draft` role's `provider/model` (any `:level` suffix dropped),
 * or the built-in Vertex Gemini when the role is unset, malformed, or names a model the registry lacks.
 */
export function resolveTranscribeModel(
  settings: { getModelRole(role: string): string | undefined },
  registry: { find(provider: string, modelId: string): Model<Api> | undefined },
): Model<Api> | undefined {
  const parsed = parseModelString(settings.getModelRole(TRANSCRIBE_ROLE)?.trim() ?? "");
  const configured = parsed ? registry.find(parsed.provider, parsed.id) : undefined;
  return configured ?? registry.find(TRANSCRIBE_PROVIDER, TRANSCRIBE_MODEL);
}

/** One transcription through CUELO's shared omp runtime and the credentials of the model it resolves. */
export async function transcribeAudioWithGemini(audio: Uint8Array, mimeType: string, signal?: AbortSignal): Promise<string> {
  if (audio.byteLength > MAX_TRANSCRIBE_AUDIO_BYTES) {
    throw new Error(`audio exceeds the ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024} MB transcription limit`);
  }
  const [{ completeSimple }, { getOmpRuntime }] = await Promise.all([
    import("@oh-my-pi/pi-ai"),
    import("@/lib/omp-runtime"),
  ]);
  const { modelRegistry, settings } = await getOmpRuntime();
  const model = resolveTranscribeModel(settings, modelRegistry);
  if (!model) throw new Error(`${TRANSCRIBE_PROVIDER}/${TRANSCRIBE_MODEL} is not available`);
  assertInlineAudioModel(model);
  const name = `${model.provider}/${model.id}`;
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No credentials for ${name}` : auth.error);
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
  let blocked: TranscriptBlockedError | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      return readTranscript(await completeSimple(model, context, options));
    } catch (error) {
      if (error instanceof TranscriptBlockedError) blocked = error;
      // A block the provider reported once is not overturned by a later ordinary failure of the retry.
      if (!(error instanceof TranscriptStoppedError) || options.signal.aborted) throw blocked ?? error;
      lastError = error;
    }
  }
  throw blocked ?? lastError;
}
