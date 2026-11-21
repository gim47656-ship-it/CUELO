/** Transcribe a stored recording as short MP3 chunks without changing the original. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import { CODEX_CHUNK_SECONDS } from "./codex-transcribe";
import type { AudioTranscriptionPlan, AudioTranscriptionRequest, AudioTranscriptionResult } from "./attachment-audio-types";

const PART_ENCODING = ["-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k"];
const PART_MIME_TYPE = "audio/mpeg";
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
  | "transcription_failed"
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

const cancelled = () => new AudioTranscriptionError("aborted", "Transcription was cancelled", 499);
const unreadable = () => new AudioTranscriptionError("media_unreadable", "The attachment has no readable audio stream", 422);
const offerGone = () =>
  new AudioTranscriptionError("fallback_confirmation_expired", "This fallback choice expired; nothing was sent. Start the transcription again.", 409);

type PlanOptions = { resolveFfmpeg: () => Promise<string>; signal?: AbortSignal };
type TranscribeOptions = PlanOptions & {
  confirmed?: boolean;
  transcribe: TranscribeAudioPart;
  tmpRoot?: string;
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

const TRANSCRIPTION_NOTICE =
  "CUELO sends up to 15 seconds of MP3 audio per request to ChatGPT/Codex using your existing sign-in. " +
  "This endpoint is private and undocumented. A response included asset_ttl='30d'; actual retention and deletion policies remain unverified.";

export async function planAudioTranscription(source: AudioSource, { resolveFfmpeg, signal }: PlanOptions): Promise<AudioTranscriptionPlan> {
  assertAudio(source);
  const durationSeconds = await probeAudioDurationSeconds(await resolveFfmpeg(), source.path, signal);
  return {
    durationSeconds,
    estimatedCalls: Math.ceil(durationSeconds / CODEX_CHUNK_SECONDS),
    requiresConfirmation: true,
    processing: "compress-and-split",
    notice: `The audio is ${formatDuration(durationSeconds)} long. ${TRANSCRIPTION_NOTICE}`,
  };
}

/** Attachment ids with a transcription running, shared across Next module reloads. */
function activeTranscriptions(): Set<string> {
  const state = globalThis as typeof globalThis & { __cueloAudioTranscriptions?: Set<string> };
  state.__cueloAudioTranscriptions ??= new Set();
  return state.__cueloAudioTranscriptions;
}

/** Encode each equal share from the source, avoiding tiny tails and gaps from re-cutting an MP3. */
async function transcribeChunks(source: AudioSource, options: TranscribeOptions): Promise<AudioTranscriptionResult> {
  const { signal } = options;
  const binary = await options.resolveFfmpeg();
  const duration = await probeAudioDurationSeconds(binary, source.path, signal);
  const parts = Math.ceil(duration / CODEX_CHUNK_SECONDS);
  const step = duration / parts;
  const folder = await mkdtemp(join(options.tmpRoot ?? tmpdir(), "cuelo-audio-chunks-"));
  try {
    const chunkFile = join(folder, "chunk.mp3");
    const texts: string[] = [];
    for (let index = 0; index < parts; index++) {
      if (signal?.aborted) throw cancelled();
      await runFfmpeg(binary, [
        "-ss", String(index * step),
        ...recordingInput(source.path),
        ...(index + 1 === parts ? [] : ["-t", String(step)]),
        "-map", "0:a:0",
        ...PART_ENCODING,
        "-y", chunkFile,
      ], signal);
      const audio = await readFile(chunkFile);
      if (signal?.aborted) throw cancelled();
      try {
        const text = (await options.transcribe(audio, PART_MIME_TYPE, signal)).trim();
        if (signal?.aborted) throw cancelled();
        if (text) texts.push(text);
      } catch (error) {
        if (signal?.aborted) throw cancelled();
        const detail = error instanceof Error ? error.message : String(error);
        throw new AudioTranscriptionError("transcription_failed", `Part ${index + 1} of ${parts}: ${detail}`, 502, {
          completedParts: index,
          parts,
        });
      }
    }
    const transcript = texts.join("\n\n");
    if (!transcript) throw new AudioTranscriptionError("transcription_failed", "Transcription returned no text", 502);
    return { transcript, parts };
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** One confirmed run per attachment id; an unconfirmed request never sends audio. */
export async function transcribeAudioAttachment(source: AudioSource, options: TranscribeOptions): Promise<AudioTranscriptionResult> {
  assertAudio(source);
  if (options.confirmed !== true) {
    throw new AudioTranscriptionError("confirmation_required", "Audio needs confirmation before it is transcribed", 409);
  }
  const active = activeTranscriptions();
  if (active.has(source.id)) {
    throw new AudioTranscriptionError("in_progress", "This attachment is already being transcribed", 409);
  }
  active.add(source.id);
  try {
    return await transcribeChunks(source, options);
  } finally {
    active.delete(source.id);
  }
}

function errorResponse(error: unknown): Response {
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

/** `POST /api/attachments/{id}/transcription` once the attachment is leased. */
export async function respondAudioTranscription(
  source: AudioSource,
  request: AudioTranscriptionRequest,
  options: Omit<TranscribeOptions, "confirmed">,
): Promise<Response> {
  if ("fallbackToken" in request) return errorResponse(offerGone());
  try {
    return Response.json(await transcribeAudioAttachment(source, { ...options, confirmed: request.confirmed }));
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
