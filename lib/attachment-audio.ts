/**
 * Transcription of one stored audio attachment. Audio up to the provider's inline limit goes out
 * as it is in one request. Larger audio gets a compressed mono copy split into 10-minute parts
 * (FFmpeg from `ffmpeg-static`), and each part goes out in order as its own request. The stored
 * original is only ever read; the copy lives in a private temp folder removed when the run ends.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import { TRANSCRIBE_TIMEOUT_MS, TranscriptBlockedError } from "./audio-transcribe";
import {
  MAX_TRANSCRIBE_AUDIO_BYTES,
  type AudioFallbackOffer,
  type AudioTranscriptionPlan,
  type AudioTranscriptionRequest,
  type AudioTranscriptionResult,
} from "./attachment-audio-types";

/** Ten minutes of speech stays far below the provider's 32k-token reply limit. */
export const SEGMENT_SECONDS = 600;
/** 32 kbit/s mono MP3 at 16 kHz: about 2.4 MB per 10-minute part, every provider takes MP3. */
const PART_ENCODING = ["-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k"];
const PART_MIME_TYPE = "audio/mpeg";
const PART_FILE = /^part-\d{4}\.mp3$/;
/**
 * Demuxers for ordinary recordings. Playlist and list formats (HLS, concat, image sequences, ...)
 * are not in it, so a crafted file cannot make the decoder open other files or URLs.
 */
const RECORDING_FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,mp3,wav,ogg,flac,matroska,webm,aac,aiff";
const OUTPUT_TAIL_CHARS = 4096;

export type AudioSource = { id: string; path: string; size: number; mimeType: string };
export type TranscribeAudioPart = (audio: Uint8Array, mimeType: string, signal?: AbortSignal) => Promise<string>;

export type AudioTranscriptionErrorCode =
  | "not_audio"
  | "confirmation_required"
  | "in_progress"
  | "media_unreadable"
  | "media_tool_unavailable"
  | "part_too_large"
  | "transcription_failed"
  | "fallback_confirmation_required"
  | "fallback_confirmation_expired"
  | "aborted";

/** A classified failure; its message is safe to show and never carries FFmpeg output or paths. */
export class AudioTranscriptionError extends Error {
  constructor(
    readonly code: AudioTranscriptionErrorCode,
    message: string,
    readonly status: number,
    readonly details: Record<string, number> = {},
  ) {
    super(message);
    this.name = "AudioTranscriptionError";
  }
}

/** The primary failed and the fallback waits for the user's choice; nothing went to the fallback. */
export class AudioFallbackOfferError extends AudioTranscriptionError {
  constructor(readonly offer: AudioFallbackOffer) {
    super(offer.code, offer.error, 409, { completedParts: offer.completedParts, parts: offer.parts });
    this.name = "AudioFallbackOfferError";
  }
}

const cancelled = () => new AudioTranscriptionError("aborted", "Transcription was cancelled", 499);
const unreadable = () => new AudioTranscriptionError("media_unreadable", "The attachment has no readable audio stream", 422);
const offerGone = () =>
  new AudioTranscriptionError("fallback_confirmation_expired", "This fallback choice expired or was already used; nothing was sent. Start the transcription again.", 409);

type PlanOptions = { resolveFfmpeg: () => Promise<string>; signal?: AbortSignal };
/** Second transcriber for audio the primary failed on, fed short MP3 chunks cut from that audio. */
export type AudioFallback = { transcribe: TranscribeAudioPart; chunkSeconds: number };

type TranscribeOptions = PlanOptions & {
  confirmed?: boolean;
  /**
   * Token of the fallback offer the user approved for this attachment. The run resumes at the part
   * the primary failed on and sends it and the rest to the fallback only.
   */
  fallbackToken?: string;
  transcribe: TranscribeAudioPart;
  /** Offered for the failed part and every part after it; absent, a primary failure fails the run. */
  fallback?: AudioFallback;
  /** Parent of the per-run temp folder; the OS temp dir by default. */
  tmpRoot?: string;
  maxPartBytes?: number;
};

/** The FFmpeg binary `ffmpeg-static` installed (or its `FFMPEG_BIN` override). */
export async function resolveFfmpegPath(): Promise<string> {
  // Null on an unsupported platform; missing when the package's install download did not run.
  if (!ffmpegStaticPath || !existsSync(ffmpegStaticPath)) {
    throw new AudioTranscriptionError("media_tool_unavailable", "FFmpeg is not available on this server; reinstall CUELO to restore it", 503);
  }
  return ffmpegStaticPath;
}

/** Decoder input restricted to a local file read by an ordinary recording demuxer. */
function recordingInput(path: string): string[] {
  return ["-protocol_whitelist", "file", "-format_whitelist", RECORDING_FORMATS, "-i", `file:${path}`];
}

/** Runs FFmpeg with an argument list (no shell) and resolves with the tail of its stdout. */
function runFfmpeg(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) return Promise.reject(cancelled());
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn(binary, ["-hide_banner", "-nostdin", "-v", "error", ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    signal,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-OUTPUT_TAIL_CHARS); });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-OUTPUT_TAIL_CHARS); });
  child.on("error", () => {
    // A process that never started has nothing to wait for; a killed one still reports `close`.
    if (child.pid === undefined) {
      reject(signal?.aborted ? cancelled() : new AudioTranscriptionError("media_tool_unavailable", "FFmpeg could not be started", 503));
    }
  });
  child.on("close", (code) => {
    if (signal?.aborted) return reject(cancelled());
    if (code === 0) return resolve(stdout);
    console.warn(`[attachment-audio] ffmpeg exited with ${code}: ${stderr.trim()}`);
    reject(unreadable());
  });
  return promise;
}

/** Length of the first audio stream, read by copying its packets to a null output (no decoding). */
export async function probeAudioDurationSeconds(binary: string, path: string, signal?: AbortSignal): Promise<number> {
  const progress = await runFfmpeg(
    binary,
    [...recordingInput(path), "-map", "0:a:0", "-c", "copy", "-f", "null", "-progress", "pipe:1", "-nostats", "-"],
    signal,
  );
  const microseconds = Number([...progress.matchAll(/^out_time_us=(\d+)\s*$/gm)].at(-1)?.[1]);
  if (!Number.isFinite(microseconds) || microseconds <= 0) throw unreadable();
  return microseconds / 1_000_000;
}

function formatDuration(totalSeconds: number): string {
  const rounded = Math.round(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = String(rounded % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

function assertAudio(source: AudioSource): void {
  if (!source.mimeType.toLowerCase().startsWith("audio/")) {
    throw new AudioTranscriptionError("not_audio", "Only audio attachments can be transcribed", 415);
  }
}

const FALLBACK_DETAILS =
  "It splits fallback audio into 15-second MP3 chunks, which can increase request counts and account usage beyond the estimate. " +
  "This endpoint is private and undocumented. A response included asset_ttl='30d'; actual retention and deletion policies remain unverified.";
/** Added to every plan notice: the fallback is a second provider and its requests are not in the estimate. */
const FALLBACK_NOTICE =
  `If primary transcription fails, CUELO asks before sending the failing segment and remaining audio to ChatGPT/Codex using your existing sign-in. ${FALLBACK_DETAILS}`;
/** Shown with a fallback offer, before the user decides. */
const FALLBACK_OFFER_NOTICE =
  `Continuing sends the failed segment and remaining audio to ChatGPT/Codex using your existing sign-in. ${FALLBACK_DETAILS}`;

export async function planAudioTranscription(source: AudioSource, { resolveFfmpeg, signal }: PlanOptions): Promise<AudioTranscriptionPlan> {
  assertAudio(source);
  if (source.size <= MAX_TRANSCRIBE_AUDIO_BYTES) {
    return {
      durationSeconds: null,
      estimatedCalls: 1,
      requiresConfirmation: false,
      processing: "direct",
      notice: `The audio is sent as it is in one transcription request to the model service of the draft role. ${FALLBACK_NOTICE}`,
    };
  }
  const durationSeconds = await probeAudioDurationSeconds(await resolveFfmpeg(), source.path, signal);
  const estimatedCalls = Math.ceil(durationSeconds / SEGMENT_SECONDS);
  return {
    durationSeconds,
    estimatedCalls,
    requiresConfirmation: true,
    processing: "compress-and-split",
    notice: [
      `The audio is ${formatDuration(durationSeconds)} long.`,
      `A compressed copy is split into ${estimatedCalls} part${estimatedCalls === 1 ? "" : "s"} of up to ${SEGMENT_SECONDS / 60} minutes,`,
      `sent one after another as ${estimatedCalls} transcription request${estimatedCalls === 1 ? "" : "s"} billed to that model service's account.`,
      `Each request can take up to ${TRANSCRIBE_TIMEOUT_MS / 60_000} minutes. The original file stays unchanged.`,
      FALLBACK_NOTICE,
    ].join(" "),
  };
}

/** Attachment ids with a transcription running, shared across Next module reloads. */
function activeTranscriptions(): Set<string> {
  const state = globalThis as typeof globalThis & { __cueloAudioTranscriptions?: Set<string> };
  state.__cueloAudioTranscriptions ??= new Set();
  return state.__cueloAudioTranscriptions;
}

/** How long an offered fallback can be approved; afterwards the run starts over from the primary. */
export const FALLBACK_OFFER_TTL_MS = 30 * 60_000;

/** A primary failure the fallback may take over once the user approves it. */
type FallbackOffer = {
  token: string;
  expiresAt: number;
  /** The leased file the offer was made for; an approval must find the same one. */
  source: AudioSource;
  /** Primary transcripts of the parts before `failedIndex`. Kept here, never taken from the client. */
  texts: string[];
  failedIndex: number;
  parts: number;
  primaryFailure: string;
  timer: ReturnType<typeof setTimeout>;
};

/** At most one open offer per attachment id, in this process only, shared across Next module reloads. */
function fallbackOffers(): Map<string, FallbackOffer> {
  const state = globalThis as typeof globalThis & { __cueloAudioFallbackOffers?: Map<string, FallbackOffer> };
  state.__cueloAudioFallbackOffers ??= new Map();
  return state.__cueloAudioFallbackOffers;
}

/** Removes the attachment's offer, or only `offer` when given and still the current one. */
function dropFallbackOffer(id: string, offer?: FallbackOffer): void {
  const offers = fallbackOffers();
  const current = offers.get(id);
  if (!current || (offer && current !== offer)) return;
  clearTimeout(current.timer);
  offers.delete(id);
}

function offerFallback(source: AudioSource, state: Pick<FallbackOffer, "texts" | "failedIndex" | "parts" | "primaryFailure">): AudioFallbackOffer {
  dropFallbackOffer(source.id);
  const offer: FallbackOffer = {
    ...state,
    texts: [...state.texts],
    source: { ...source },
    token: randomBytes(16).toString("hex"),
    expiresAt: Date.now() + FALLBACK_OFFER_TTL_MS,
    timer: setTimeout(() => dropFallbackOffer(source.id, offer), FALLBACK_OFFER_TTL_MS),
  };
  offer.timer.unref?.();
  fallbackOffers().set(source.id, offer);
  return {
    code: "fallback_confirmation_required",
    error: state.primaryFailure,
    completedParts: state.failedIndex,
    parts: state.parts,
    fallbackToken: offer.token,
    notice: FALLBACK_OFFER_NOTICE,
    expiresInSeconds: FALLBACK_OFFER_TTL_MS / 1000,
  };
}

/** Consumes the attachment's open offer named by `token`; an unknown, used or expired one sends nothing. */
function takeFallbackOffer(source: AudioSource, token: string): FallbackOffer {
  const offer = fallbackOffers().get(source.id);
  if (!offer || offer.token !== token) throw offerGone();
  dropFallbackOffer(source.id, offer);
  const sameFile = offer.source.path === source.path && offer.source.size === source.size && offer.source.mimeType === source.mimeType;
  if (!sameFile || Date.now() >= offer.expiresAt) throw offerGone();
  return offer;
}

/** Drops the attachment's open offer named by `token` (the user skipped or removed the audio). */
export function discardAudioFallback(attachmentId: string, token: string): boolean {
  const offer = fallbackOffers().get(attachmentId);
  if (!offer || offer.token !== token) return false;
  dropFallbackOffer(attachmentId, offer);
  return true;
}

/**
 * Sends each part to the fallback transcriber as `chunkSeconds` MP3 chunks, in order. Every chunk is
 * encoded on its own from the source (private temp folder, removed afterwards): cutting a finished MP3
 * instead drops about 0.1 s of audio at each boundary. Returns one text per part; a part whose chunks
 * all came back empty (silence) is an empty string. Any failure here fails the run.
 */
async function transcribeChunks(
  parts: string[],
  fallback: AudioFallback,
  options: Pick<TranscribeOptions, "resolveFfmpeg" | "tmpRoot" | "signal">,
): Promise<string[]> {
  const { signal } = options;
  const folder = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "cuelo-audio-chunks-"));
  try {
    const binary = await options.resolveFfmpeg();
    const chunkFile = join(folder, "chunk.mp3");
    const texts: string[] = [];
    for (const part of parts) {
      // ceil(duration / chunkSeconds) chunks of equal source length, so none exceeds `chunkSeconds` and
      // no tiny tail chunk is left over; the last one runs to the end of the source.
      const duration = await probeAudioDurationSeconds(binary, part, signal);
      const count = Math.max(1, Math.ceil(duration / fallback.chunkSeconds));
      const step = duration / count;
      const starts = Array.from({ length: count }, (_, i) => i * step);
      const chunkTexts: string[] = [];
      for (const [chunkIndex, start] of starts.entries()) {
        if (signal?.aborted) throw cancelled();
        const isLast = chunkIndex === starts.length - 1;
        await runFfmpeg(
          binary,
          [
            "-ss", String(start),
            ...recordingInput(part),
            ...(isLast ? [] : ["-t", String(step)]),
            "-map", "0:a:0",
            ...PART_ENCODING,
            "-y", chunkFile,
          ],
          signal,
        );
        try {
          const text = await fallback.transcribe(await readFile(chunkFile), PART_MIME_TYPE, signal);
          if (text.trim()) chunkTexts.push(text.trim());
        } catch (error) {
          if (error instanceof AudioTranscriptionError) throw error;
          throw new Error(`chunk ${chunkIndex + 1} of ${starts.length}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      texts.push(chunkTexts.join(" "));
    }
    return texts;
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Sends each part in order; any failed part fails the whole run with no partial transcript. With a
 * fallback, the first part the primary fails on (a content block excepted, which must not be sent to
 * another provider) ends the run with an offer instead: nothing goes to the fallback until the user
 * approves it. `approved` resumes that run, sending the failed part and every part after it to the
 * fallback and keeping the parts the primary already finished as they are.
 */
async function transcribeParts(
  source: AudioSource,
  parts: string[],
  mimeType: string,
  options: Pick<TranscribeOptions, "transcribe" | "fallback" | "resolveFfmpeg" | "tmpRoot" | "signal">,
  approved: FallbackOffer | null,
): Promise<AudioTranscriptionResult> {
  const { transcribe, fallback, signal } = options;
  const failure = (message: string, completedParts: number) =>
    new AudioTranscriptionError("transcription_failed", message, 502, { completedParts, parts: parts.length });
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (approved) {
    // A recording re-split into a different number of parts no longer matches the kept transcripts.
    if (!fallback || approved.parts !== parts.length) throw offerGone();
    const { failedIndex, primaryFailure } = approved;
    let fallbackTexts: string[];
    try {
      fallbackTexts = await transcribeChunks(parts.slice(failedIndex), fallback, options);
    } catch (fallbackError) {
      if (signal?.aborted || (fallbackError instanceof AudioTranscriptionError && fallbackError.code === "aborted")) throw cancelled();
      throw failure(`${primaryFailure}; fallback transcription failed: ${message(fallbackError)}`, failedIndex);
    }
    const transcript = [...approved.texts, ...fallbackTexts].filter(Boolean).join("\n\n");
    if (!transcript) throw failure(`${primaryFailure}; fallback transcription failed: transcription returned no text`, 0);
    return { transcript, parts: parts.length };
  }
  const texts: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (signal?.aborted) throw cancelled();
    const audio = new Uint8Array(await readFile(part));
    try {
      texts.push(await transcribe(audio, mimeType, signal));
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      const where = parts.length === 1 ? "" : `part ${index + 1} of ${parts.length} failed: `;
      const primaryFailure = `${where}${message(error)}`;
      if (!fallback || error instanceof TranscriptBlockedError) throw failure(primaryFailure, index);
      // The fallback re-cuts the audio with FFmpeg; without it there is nothing to offer.
      try {
        await options.resolveFfmpeg();
      } catch (toolError) {
        throw failure(`${primaryFailure}; fallback transcription failed: ${message(toolError)}`, index);
      }
      if (signal?.aborted) throw cancelled();
      throw new AudioFallbackOfferError(offerFallback(source, { texts, failedIndex: index, parts: parts.length, primaryFailure }));
    }
  }
  const transcript = texts.filter(Boolean).join("\n\n");
  if (!transcript) throw failure("transcription returned no text", 0);
  return { transcript, parts: parts.length };
}

/** Compresses and splits a copy of large audio into the temp folder and transcribes the parts. */
async function transcribeSplitCopy(source: AudioSource, options: TranscribeOptions, approved: FallbackOffer | null): Promise<AudioTranscriptionResult> {
  const binary = await options.resolveFfmpeg();
  const maxPartBytes = options.maxPartBytes ?? MAX_TRANSCRIBE_AUDIO_BYTES;
  const folder = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "cuelo-audio-"));
  try {
    await runFfmpeg(
      binary,
      [
        ...recordingInput(source.path),
        "-map", "0:a:0",
        ...PART_ENCODING,
        "-f", "segment", "-segment_time", String(SEGMENT_SECONDS), "-reset_timestamps", "1",
        join(folder, "part-%04d.mp3"),
      ],
      options.signal,
    );
    const parts = (await readdir(folder)).filter((name) => PART_FILE.test(name)).sort().map((name) => join(folder, name));
    if (parts.length === 0) throw unreadable();
    for (const part of parts) {
      if ((await stat(part)).size > maxPartBytes) {
        throw new AudioTranscriptionError("part_too_large", "A converted part is larger than the transcription limit", 500);
      }
    }
    return await transcribeParts(source, parts, PART_MIME_TYPE, options, approved);
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Transcribes one attachment. Large audio needs `confirmed: true`; without it nothing is converted
 * or sent. A primary failure the fallback could take over ends with an offer; `fallbackToken` names
 * the approved offer and resumes it (the offer itself proves a confirmed run made it). One run per
 * attachment id at a time; a new run drops the attachment's open offer.
 */
export async function transcribeAudioAttachment(source: AudioSource, options: TranscribeOptions): Promise<AudioTranscriptionResult> {
  assertAudio(source);
  const large = source.size > MAX_TRANSCRIBE_AUDIO_BYTES;
  const token = options.fallbackToken;
  const resuming = token !== undefined;
  if (large && !resuming && options.confirmed !== true) {
    throw new AudioTranscriptionError("confirmation_required", "Large audio needs confirmation before it is transcribed", 409);
  }
  const active = activeTranscriptions();
  if (active.has(source.id)) {
    throw new AudioTranscriptionError("in_progress", "This attachment is already being transcribed", 409);
  }
  const approved = resuming ? takeFallbackOffer(source, token) : null;
  if (!resuming) dropFallbackOffer(source.id);
  active.add(source.id);
  try {
    return large
      ? await transcribeSplitCopy(source, options, approved)
      : await transcribeParts(source, [source.path], source.mimeType, options, approved);
  } finally {
    active.delete(source.id);
  }
}

function errorResponse(error: unknown): Response {
  if (error instanceof AudioFallbackOfferError) return Response.json(error.offer, { status: error.status });
  if (error instanceof AudioTranscriptionError) {
    return Response.json({ code: error.code, error: error.message, ...error.details }, { status: error.status });
  }
  console.error("[attachment-audio] unexpected failure", error);
  return Response.json({ code: "internal", error: "Transcription failed unexpectedly" }, { status: 500 });
}

/** `GET /api/attachments/{id}/transcription` once the attachment is leased. */
export async function respondAudioPlan(source: AudioSource, options: PlanOptions): Promise<Response> {
  try {
    return Response.json(await planAudioTranscription(source, options));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * `POST /api/attachments/{id}/transcription` once the attachment is leased. Answering an offer with
 * `approve: false` only drops it and sends nothing.
 */
export async function respondAudioTranscription(
  source: AudioSource,
  request: AudioTranscriptionRequest,
  options: Omit<TranscribeOptions, "confirmed" | "fallbackToken">,
): Promise<Response> {
  if ("fallbackToken" in request && !request.approve) {
    return Response.json({ discarded: discardAudioFallback(source.id, request.fallbackToken) });
  }
  const command = "fallbackToken" in request ? { fallbackToken: request.fallbackToken } : { confirmed: request.confirmed === true };
  try {
    return Response.json(await transcribeAudioAttachment(source, { ...options, ...command }));
  } catch (error) {
    if (!(error instanceof AudioTranscriptionError) || error.code !== "confirmation_required") return errorResponse(error);
    try {
      const plan = await planAudioTranscription(source, options);
      return Response.json({ code: error.code, error: error.message, plan }, { status: error.status });
    } catch (planError) {
      return errorResponse(planError);
    }
  }
}

const FALLBACK_TOKEN = /^[0-9a-f]{32}$/;

/**
 * The POST body: empty, `{}`, `{ confirmed: boolean }` or `{ fallbackToken, approve: boolean }`;
 * null for anything else, including a token mixed with `confirmed`.
 */
export async function readAudioTranscriptionRequest(
  request: Request,
): Promise<{ confirmed: boolean } | { fallbackToken: string; approve: boolean } | null> {
  const text = await request.text();
  if (!text.trim()) return { confirmed: false };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { confirmed, fallbackToken, approve } = body as { confirmed?: unknown; fallbackToken?: unknown; approve?: unknown };
  if (fallbackToken !== undefined) {
    if (typeof fallbackToken !== "string" || !FALLBACK_TOKEN.test(fallbackToken) || typeof approve !== "boolean" || confirmed !== undefined) return null;
    return { fallbackToken, approve };
  }
  if (approve !== undefined) return null;
  if (confirmed !== undefined && typeof confirmed !== "boolean") return null;
  return { confirmed: confirmed === true };
}
