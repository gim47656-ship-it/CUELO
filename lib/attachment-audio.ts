/**
 * Transcription of one stored audio attachment. Audio up to the provider's inline limit goes out
 * as it is in one request. Larger audio gets a compressed mono copy split into 10-minute parts
 * (FFmpeg from `ffmpeg-static`), and each part goes out in order as its own request. The stored
 * original is only ever read; the copy lives in a private temp folder removed when the run ends.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import { TRANSCRIBE_TIMEOUT_MS } from "./audio-transcribe";
import {
  MAX_TRANSCRIBE_AUDIO_BYTES,
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

type PlanOptions = { resolveFfmpeg: () => Promise<string>; signal?: AbortSignal };
type TranscribeOptions = PlanOptions & {
  confirmed?: boolean;
  transcribe: TranscribeAudioPart;
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

export async function planAudioTranscription(source: AudioSource, { resolveFfmpeg, signal }: PlanOptions): Promise<AudioTranscriptionPlan> {
  assertAudio(source);
  if (source.size <= MAX_TRANSCRIBE_AUDIO_BYTES) {
    return {
      durationSeconds: null,
      estimatedCalls: 1,
      requiresConfirmation: false,
      processing: "direct",
      notice: "The audio is sent as it is in one transcription request on the Antigravity account.",
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
      `sent one after another as ${estimatedCalls} transcription request${estimatedCalls === 1 ? "" : "s"} that count toward the Antigravity account's usage.`,
      `Each request can take up to ${TRANSCRIBE_TIMEOUT_MS / 60_000} minutes. The original file stays unchanged.`,
    ].join(" "),
  };
}

/** Attachment ids with a transcription running, shared across Next module reloads. */
function activeTranscriptions(): Set<string> {
  const state = globalThis as typeof globalThis & { __cueloAudioTranscriptions?: Set<string> };
  state.__cueloAudioTranscriptions ??= new Set();
  return state.__cueloAudioTranscriptions;
}

/** Sends each part in order; any failed part fails the whole run with no partial transcript. */
async function transcribeParts(
  parts: string[],
  mimeType: string,
  { transcribe, signal }: Pick<TranscribeOptions, "transcribe" | "signal">,
): Promise<AudioTranscriptionResult> {
  const texts: string[] = [];
  for (const [index, part] of parts.entries()) {
    if (signal?.aborted) throw cancelled();
    const audio = new Uint8Array(await readFile(part));
    try {
      texts.push(await transcribe(audio, mimeType, signal));
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      const reason = error instanceof Error ? error.message : String(error);
      throw new AudioTranscriptionError(
        "transcription_failed",
        parts.length === 1 ? reason : `part ${index + 1} of ${parts.length} failed: ${reason}`,
        502,
        { completedParts: index, parts: parts.length },
      );
    }
  }
  return { transcript: texts.join("\n\n"), parts: parts.length };
}

/** Compresses and splits a copy of large audio into the temp folder and transcribes the parts. */
async function transcribeSplitCopy(source: AudioSource, options: TranscribeOptions): Promise<AudioTranscriptionResult> {
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
    return await transcribeParts(parts, PART_MIME_TYPE, options);
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Transcribes one attachment. Large audio needs `confirmed: true`; without it nothing is converted
 * or sent. One run per attachment id at a time.
 */
export async function transcribeAudioAttachment(source: AudioSource, options: TranscribeOptions): Promise<AudioTranscriptionResult> {
  assertAudio(source);
  const large = source.size > MAX_TRANSCRIBE_AUDIO_BYTES;
  if (large && options.confirmed !== true) {
    throw new AudioTranscriptionError("confirmation_required", "Large audio needs confirmation before it is transcribed", 409);
  }
  const active = activeTranscriptions();
  if (active.has(source.id)) {
    throw new AudioTranscriptionError("in_progress", "This attachment is already being transcribed", 409);
  }
  active.add(source.id);
  try {
    return large ? await transcribeSplitCopy(source, options) : await transcribeParts([source.path], source.mimeType, options);
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
  { confirmed }: AudioTranscriptionRequest,
  options: Omit<TranscribeOptions, "confirmed">,
): Promise<Response> {
  try {
    return Response.json(await transcribeAudioAttachment(source, { ...options, confirmed }));
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

/** The POST body: empty, `{}`, or `{ confirmed: boolean }`; null for anything else. */
export async function readAudioTranscriptionRequest(request: Request): Promise<{ confirmed: boolean } | null> {
  const text = await request.text();
  if (!text.trim()) return { confirmed: false };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const { confirmed } = body as AudioTranscriptionRequest;
  if (confirmed !== undefined && typeof confirmed !== "boolean") return null;
  return { confirmed: confirmed === true };
}
