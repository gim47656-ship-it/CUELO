/**
 * attachment-audio.ts against the real FFmpeg binary on synthetic audio. The provider is a fake
 * recorder: nothing here sends audio anywhere, so passing these tests says nothing about a real
 * transcription. Without the `ffmpeg-static` binary the media cases are skipped, not faked.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_TRANSCRIBE_AUDIO_BYTES } from "./attachment-audio-types";
import {
  AudioFallbackOfferError,
  AudioTranscriptionError,
  FALLBACK_OFFER_TTL_MS,
  planAudioTranscription,
  probeAudioDurationSeconds,
  readAudioTranscriptionRequest,
  respondAudioPlan,
  respondAudioTranscription,
  resolveFfmpegPath,
  transcribeAudioAttachment,
  type AudioSource,
} from "./attachment-audio";
import { TranscriptBlockedError, TranscriptStoppedError } from "./audio-transcribe";

const ffmpeg = await resolveFfmpegPath().catch(() => null);
const work = mkdtempSync(join(tmpdir(), "cuelo-audio-test-"));
const tmpRoot = join(work, "tmp");
const LARGE_SECONDS = 1300;
// Each conversion case runs the real FFmpeg on ~20 MB of audio and took 3.4-3.9 s on the Windows CI
// runner, close to Bun's 5 s default. One case crossed it (run 37627691455); the timed-out case kept
// its in-progress claim on the shared fixture and every later case failed with `in_progress`.
setDefaultTimeout(60_000);

function makeAudio(name: string, args: string[]): string {
  const target = join(work, name);
  const result = spawnSync(ffmpeg!, ["-hide_banner", "-nostdin", "-v", "error", ...args, "-y", target], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`fixture ${name}: ${result.stderr}`);
  return target;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const source = (path: string, mimeType: string): AudioSource => ({ id: "att_" + "0".repeat(32), path, size: statSync(path).size, mimeType });
const tmpEntries = () => readdirSync(tmpRoot);

type Call = { bytes: number; mimeType: string; head: string };
function recorder(fail?: (index: number) => Error | null) {
  const calls: Call[] = [];
  const transcribe = async (audio: Uint8Array, mimeType: string) => {
    const index = calls.length;
    calls.push({ bytes: audio.byteLength, mimeType, head: Buffer.from(audio.subarray(0, 3)).toString("latin1") });
    const error = fail?.(index);
    if (error) throw error;
    return `part ${index + 1} text`;
  };
  return { calls, transcribe };
}

type Options = Parameters<typeof transcribeAudioAttachment>[1];

/** Runs until the primary fails and the fallback is offered, then approves that offer as the user would. */
async function approveFallback(audio: AudioSource, options: Options) {
  const offer = await transcribeAudioAttachment(audio, options).catch((e) => e);
  expect(offer).toBeInstanceOf(AudioFallbackOfferError);
  return transcribeAudioAttachment(audio, { ...options, fallbackToken: (offer as AudioFallbackOfferError).offer.fallbackToken });
}

let large = "";
let largeSha = "";

beforeAll(() => {
  mkdirSync(tmpRoot);
  if (!ffmpeg) return;
  // 8 kHz mono 16-bit PCM: 16 KB per second, so 1300 s is ~20.8 MB, above the 14 MiB inline limit.
  large = makeAudio("large.wav", ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=8000:duration=${LARGE_SECONDS}`, "-ac", "1", "-c:a", "pcm_s16le"]);
  largeSha = sha256(large);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("small audio keeps the direct path", () => {
  test("plans one unconfirmed call without touching FFmpeg", async () => {
    const small = join(work, "small.webm");
    writeFileSync(small, Buffer.from("not really audio, never decoded"));
    const plan = await planAudioTranscription(source(small, "audio/webm"), {
      resolveFfmpeg: () => Promise.reject(new Error("FFmpeg must not be resolved for small audio")),
    });
    expect(plan).toMatchObject({ durationSeconds: null, estimatedCalls: 1, requiresConfirmation: false, processing: "direct" });
  });

  test("sends the stored bytes and MIME type as they are, once", async () => {
    const small = join(work, "voice.m4a");
    writeFileSync(small, Buffer.from("m4a-bytes"));
    const { calls, transcribe } = recorder();
    const result = await transcribeAudioAttachment(source(small, "audio/mp4"), {
      resolveFfmpeg: () => Promise.reject(new Error("unused")),
      transcribe,
    });
    expect(result).toEqual({ transcript: "part 1 text", parts: 1 });
    expect(calls).toEqual([{ bytes: 9, mimeType: "audio/mp4", head: "m4a" }]);
  });

  test("a failed direct call is a failure, not a transcript", async () => {
    const small = join(work, "fail.mp3");
    writeFileSync(small, Buffer.from("x"));
    const { transcribe } = recorder(() => new Error("transcription stopped: error (blocked)"));
    const error = await transcribeAudioAttachment(source(small, "audio/mpeg"), { resolveFfmpeg: async () => "unused", transcribe }).catch((e) => e);
    expect(error).toBeInstanceOf(AudioTranscriptionError);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502, details: { completedParts: 0, parts: 1 } });
  });
});

describe.skipIf(!ffmpeg)("large audio with the real FFmpeg binary", () => {
  test("probes the real length and plans one call per 10-minute part", async () => {
    const plan = await planAudioTranscription(source(large, "audio/wav"), { resolveFfmpeg: async () => ffmpeg! });
    expect(plan.processing).toBe("compress-and-split");
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.durationSeconds).toBeGreaterThan(LARGE_SECONDS - 1);
    expect(plan.durationSeconds).toBeLessThan(LARGE_SECONDS + 1);
    expect(plan.estimatedCalls).toBe(3);
    expect(plan.notice).toContain("21:40");
  });

  test("refuses an unconfirmed large file before any conversion or request", async () => {
    const { calls, transcribe } = recorder();
    let resolved = 0;
    const error = await transcribeAudioAttachment(source(large, "audio/wav"), {
      resolveFfmpeg: async () => { resolved += 1; return ffmpeg!; },
      transcribe,
      tmpRoot,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "confirmation_required", status: 409 });
    expect(calls).toHaveLength(0);
    expect(resolved).toBe(0);
    expect(tmpEntries()).toEqual([]);
  });

  test("compresses and splits a copy, sends every part in order under the limit, keeps the original", async () => {
    const { calls, transcribe } = recorder();
    const result = await transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      transcribe,
      tmpRoot,
    });
    expect(result).toEqual({ transcript: "part 1 text\n\npart 2 text\n\npart 3 text", parts: 3 });
    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.mimeType).toBe("audio/mpeg");
      expect(call.bytes).toBeLessThanOrEqual(MAX_TRANSCRIBE_AUDIO_BYTES);
      expect(["ID3", "\xff\xf3", "\xff\xfb"].some((magic) => call.head.startsWith(magic))).toBe(true);
    }
    // 600 s, 600 s, 100 s of 32 kbit/s audio: the last part is clearly the shortest.
    expect(calls[2]!.bytes).toBeLessThan(calls[0]!.bytes / 3);
    expect(tmpEntries()).toEqual([]);
    expect(sha256(large)).toBe(largeSha);
  });

  test("a failed part fails the whole transcription and removes the converted copy", async () => {
    const { calls, transcribe } = recorder((index) => (index === 1 ? new Error("provider exploded") : null));
    const error = await transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      transcribe,
      tmpRoot,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502, details: { completedParts: 1, parts: 3 } });
    expect(error.message).toContain("part 2 of 3");
    expect(error.message).toContain("provider exploded");
    expect(calls).toHaveLength(2);
    expect(tmpEntries()).toEqual([]);
    expect(sha256(large)).toBe(largeSha);
  });

  test("aborting mid-way stops the requests and removes the converted copy", async () => {
    const controller = new AbortController();
    const calls: number[] = [];
    const transcribe = async (_audio: Uint8Array, _mime: string, signal?: AbortSignal) => {
      calls.push(calls.length);
      controller.abort();
      signal?.throwIfAborted();
      return "never";
    };
    const error = await transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      transcribe,
      tmpRoot,
      signal: controller.signal,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "aborted", status: 499 });
    expect(calls).toEqual([0]);
    expect(tmpEntries()).toEqual([]);
    expect(sha256(large)).toBe(largeSha);
  });

  test("aborting once conversion has started stops FFmpeg and removes the converted copy", async () => {
    const controller = new AbortController();
    const { calls, transcribe } = recorder();
    // The first part file appears while FFmpeg is still writing it.
    const watcher = watch(tmpRoot, { recursive: true }, (_event, name) => {
      if (name && /part-\d{4}\.mp3$/.test(String(name))) controller.abort();
    });
    const error = await transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      transcribe,
      tmpRoot,
      signal: controller.signal,
    }).catch((e) => e).finally(() => watcher.close());
    expect(error).toMatchObject({ code: "aborted", status: 499 });
    expect(calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
    expect(sha256(large)).toBe(largeSha);
  });

  test("a part above the provider limit stops before any request", async () => {
    const { calls, transcribe } = recorder();
    const error = await transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      transcribe,
      tmpRoot,
      maxPartBytes: 1024,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "part_too_large" });
    expect(calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
  });

  test("same attachment cannot run twice at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const small = join(work, "busy.mp3");
    writeFileSync(small, Buffer.from("x"));
    const first = transcribeAudioAttachment(source(small, "audio/mpeg"), {
      resolveFfmpeg: async () => ffmpeg!,
      transcribe: async () => { await gate; return "done"; },
    });
    const second = await transcribeAudioAttachment(source(small, "audio/mpeg"), {
      resolveFfmpeg: async () => ffmpeg!,
      transcribe: async () => "dup",
    }).catch((e) => e);
    expect(second).toMatchObject({ code: "in_progress", status: 409 });
    release();
    expect(await first).toEqual({ transcript: "done", parts: 1 });
  });

  test("probes common recording containers", async () => {
    const formats: Array<[string, string[]]> = [
      ["clip.m4a", ["-c:a", "aac"]],
      ["clip.webm", ["-c:a", "libopus"]],
      ["clip.ogg", ["-c:a", "libopus"]],
      ["clip.mp3", ["-c:a", "libmp3lame"]],
      ["clip.flac", ["-c:a", "flac"]],
      ["clip.aiff", ["-c:a", "pcm_s16be"]],
      ["clip.mp4", ["-c:a", "aac"]],
    ];
    for (const [name, codec] of formats) {
      const file = makeAudio(name, ["-f", "lavfi", "-i", "sine=frequency=300:sample_rate=16000:duration=5", ...codec]);
      const seconds = await probeAudioDurationSeconds(ffmpeg!, file);
      expect({ name, close: Math.abs(seconds - 5) < 0.2 }).toEqual({ name, close: true });
    }
  });

  test("rejects playlists and lists that would make the decoder open other files or the network", async () => {
    const wav = makeAudio("target.wav", ["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "pcm_s16le"]);
    const playlists: Array<[string, string]> = [
      ["list.wav", `ffconcat version 1.0\nfile '${wav.replaceAll("\\", "/")}'\n`],
      ["remote.mp3", "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:9/never.ts\n#EXT-X-ENDLIST\n"],
      // A real playlist extension (stored as audio/mpegurl) passes FFmpeg's own HLS sniffing check.
      ["remote.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://127.0.0.1:9/never.ts\n#EXT-X-ENDLIST\n"],
      ["local.m4a", `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nfile:${wav.replaceAll("\\", "/")}\n#EXT-X-ENDLIST\n`],
    ];
    for (const [name, body] of playlists) {
      const file = join(work, name);
      writeFileSync(file, body);
      const error = await probeAudioDurationSeconds(ffmpeg!, file).catch((e) => e);
      expect({ name, code: error?.code }).toEqual({ name, code: "media_unreadable" });
    }
  });

  test("a file without an audio stream is unreadable, not a zero-length plan", async () => {
    const text = join(work, "notes.mp3");
    writeFileSync(text, "plain text pretending to be audio\n".repeat(600_000));
    const error = await planAudioTranscription(source(text, "audio/mpeg"), { resolveFfmpeg: async () => ffmpeg! }).catch((e) => e);
    expect(error).toMatchObject({ code: "media_unreadable", status: 422 });
  });
});

describe("HTTP responders", () => {
  test("missing media tool is reported, never replaced", async () => {
    const big = join(work, "big.bin");
    writeFileSync(big, Buffer.alloc(MAX_TRANSCRIBE_AUDIO_BYTES + 1));
    const response = await respondAudioPlan(source(big, "audio/wav"), {
      resolveFfmpeg: () => Promise.reject(new AudioTranscriptionError("media_tool_unavailable", "FFmpeg is not installed", 503)),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "media_tool_unavailable" });
  });

  test("an unconfirmed large file answers 409 with the plan to show", async () => {
    if (!ffmpeg) return;
    const { calls, transcribe } = recorder();
    const response = await respondAudioTranscription(source(large, "audio/wav"), {}, {
      resolveFfmpeg: async () => ffmpeg!,
      transcribe,
      tmpRoot,
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "confirmation_required", plan: { estimatedCalls: 3, requiresConfirmation: true } });
    expect(calls).toHaveLength(0);
  });

  test("non-audio attachments are refused", async () => {
    const doc = join(work, "doc.pdf");
    writeFileSync(doc, "%PDF-1.4");
    const response = await respondAudioPlan(source(doc, "application/pdf"), { resolveFfmpeg: async () => "unused" });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ code: "not_audio" });
  });

  test("request body accepts nothing, {}, a boolean confirmation or a fallback answer only", async () => {
    const make = (body: string) => new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json" } });
    const token = "ab".repeat(16);
    expect(await readAudioTranscriptionRequest(make(""))).toEqual({ confirmed: false });
    expect(await readAudioTranscriptionRequest(make("{}"))).toEqual({ confirmed: false });
    expect(await readAudioTranscriptionRequest(make('{"confirmed":true}'))).toEqual({ confirmed: true });
    expect(await readAudioTranscriptionRequest(make('{"confirmed":"yes"}'))).toBeNull();
    expect(await readAudioTranscriptionRequest(make("not json"))).toBeNull();
    expect(await readAudioTranscriptionRequest(make(JSON.stringify({ fallbackToken: token, approve: true })))).toEqual({ fallbackToken: token, approve: true });
    expect(await readAudioTranscriptionRequest(make(JSON.stringify({ fallbackToken: token, approve: false })))).toEqual({ fallbackToken: token, approve: false });
    // A large-file confirmation is not a fallback answer, and the two never travel together.
    expect(await readAudioTranscriptionRequest(make(JSON.stringify({ fallbackToken: token, approve: true, confirmed: true })))).toBeNull();
    expect(await readAudioTranscriptionRequest(make(JSON.stringify({ fallbackToken: token })))).toBeNull();
    expect(await readAudioTranscriptionRequest(make(JSON.stringify({ fallbackToken: "x", approve: true })))).toBeNull();
    expect(await readAudioTranscriptionRequest(make(JSON.stringify({ approve: true })))).toBeNull();
  });
});

describe("a fallback offer is bound to its attachment and used once", () => {
  // Every check here ends before any audio is cut, so FFmpeg is never run.
  const voice = (name: string) => {
    const file = join(work, name);
    writeFileSync(file, Buffer.from("m4a-bytes"));
    return source(file, "audio/mp4");
  };
  function offerRun() {
    const primary = recorder(() => new Error("primary unavailable"));
    const fallbackCalls: number[] = [];
    const fallback = { chunkSeconds: 15, transcribe: async () => { fallbackCalls.push(1); return "fallback text"; } };
    const options: Options = { resolveFfmpeg: async () => "never-run", tmpRoot, transcribe: primary.transcribe, fallback };
    return { primary, fallbackCalls, options };
  }
  const offerOf = async (audio: AudioSource, options: Options) => {
    const error = await transcribeAudioAttachment(audio, options).catch((e) => e);
    expect(error).toBeInstanceOf(AudioFallbackOfferError);
    return (error as AudioFallbackOfferError).offer;
  };
  afterEach(() => setSystemTime());

  test("a token that was never offered is refused and the real offer stays usable", async () => {
    const audio = voice("forged.m4a");
    const { fallbackCalls, options } = offerRun();
    const offer = await offerOf(audio, options);
    const forged = await transcribeAudioAttachment(audio, { ...options, fallbackToken: "0".repeat(32) }).catch((e) => e);
    expect(forged).toMatchObject({ code: "fallback_confirmation_expired", status: 409 });
    const discarded = await respondAudioTranscription(audio, { fallbackToken: offer.fallbackToken, approve: false }, options);
    expect(await discarded.json()).toEqual({ discarded: true });
    expect(fallbackCalls).toHaveLength(0);
  });

  test("declining drops the offer, so a later approval sends nothing", async () => {
    const audio = voice("declined.m4a");
    const { primary, fallbackCalls, options } = offerRun();
    const offer = await offerOf(audio, options);
    const response = await respondAudioTranscription(audio, { fallbackToken: offer.fallbackToken, approve: false }, options);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ discarded: true });
    const late = await respondAudioTranscription(audio, { fallbackToken: offer.fallbackToken, approve: true }, options);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ code: "fallback_confirmation_expired" });
    expect(primary.calls).toHaveLength(1);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("an offer expires, and approving it afterwards sends nothing", async () => {
    const audio = voice("expired.m4a");
    const { fallbackCalls, options } = offerRun();
    const offer = await offerOf(audio, options);
    setSystemTime(new Date(Date.now() + FALLBACK_OFFER_TTL_MS + 1));
    const error = await transcribeAudioAttachment(audio, { ...options, fallbackToken: offer.fallbackToken }).catch((e) => e);
    expect(error).toMatchObject({ code: "fallback_confirmation_expired", status: 409 });
    expect(fallbackCalls).toHaveLength(0);
  });

  test("starting over drops the open offer", async () => {
    const audio = voice("restart.m4a");
    const { primary, fallbackCalls, options } = offerRun();
    const first = await offerOf(audio, options);
    const second = await offerOf(audio, options);
    expect(second.fallbackToken).not.toBe(first.fallbackToken);
    const stale = await transcribeAudioAttachment(audio, { ...options, fallbackToken: first.fallbackToken }).catch((e) => e);
    expect(stale).toMatchObject({ code: "fallback_confirmation_expired" });
    expect(primary.calls).toHaveLength(2);
    expect(fallbackCalls).toHaveLength(0);
  });

  test("an approval for a different file behind the same id sends nothing", async () => {
    const audio = voice("changed.m4a");
    const { fallbackCalls, options } = offerRun();
    const offer = await offerOf(audio, options);
    const changed = { ...audio, size: audio.size + 1 };
    const error = await transcribeAudioAttachment(changed, { ...options, fallbackToken: offer.fallbackToken }).catch((e) => e);
    expect(error).toMatchObject({ code: "fallback_confirmation_expired" });
    // The mismatch consumed the offer: the original file cannot use it either.
    const retry = await transcribeAudioAttachment(audio, { ...options, fallbackToken: offer.fallbackToken }).catch((e) => e);
    expect(retry).toMatchObject({ code: "fallback_confirmation_expired" });
    expect(fallbackCalls).toHaveLength(0);
  });
});

describe.skipIf(!ffmpeg)("fallback transcriber for audio the primary failed on", () => {
  const CHUNK_SECONDS = 15;
  let spoken = "";
  beforeAll(() => {
    // 40 s of 8 kHz mono PCM (~640 KB): inline-sized, so the direct path, but longer than one chunk.
    spoken = makeAudio("spoken40.wav", ["-f", "lavfi", "-i", "sine=frequency=330:sample_rate=8000:duration=40", "-ac", "1", "-c:a", "pcm_s16le"]);
  });

  const primaryFails = (error: Error = new Error("primary unavailable")) => recorder(() => error);

  /** A fallback that keeps every chunk it receives so its real length can be probed afterwards. */
  function chunkRecorder(options: { failAt?: number; text?: (index: number) => string; onCall?: (index: number) => void } = {}) {
    const calls: Call[] = [];
    const files: string[] = [];
    const transcribe = async (audio: Uint8Array, mimeType: string) => {
      const index = calls.length;
      calls.push({ bytes: audio.byteLength, mimeType, head: Buffer.from(audio.subarray(0, 3)).toString("latin1") });
      const file = join(work, `fallback-chunk-${files.length}-${Date.now()}.mp3`);
      writeFileSync(file, audio);
      files.push(file);
      options.onCall?.(index);
      if (index === options.failAt) throw new Error("codex exploded");
      return options.text ? options.text(index) : `chunk ${index + 1}`;
    };
    return { calls, files, transcribe, fallback: { transcribe, chunkSeconds: CHUNK_SECONDS } };
  }

  const options = (extra: Omit<Options, "resolveFfmpeg" | "tmpRoot">): Options => ({ resolveFfmpeg: async () => ffmpeg!, tmpRoot, ...extra });

  test("an ordinary primary failure is offered, not sent: the fallback gets no request before approval", async () => {
    const primary = primaryFails();
    const chunks = chunkRecorder();
    const error = await transcribeAudioAttachment(source(spoken, "audio/wav"), options({ transcribe: primary.transcribe, fallback: chunks.fallback })).catch((e) => e);
    expect(error).toMatchObject({ code: "fallback_confirmation_required", status: 409, details: { completedParts: 0, parts: 1 } });
    expect(chunks.calls).toHaveLength(0);
    expect(primary.calls).toHaveLength(1);
    expect(tmpEntries()).toEqual([]);
  });

  test("the HTTP answer to an ordinary primary failure is the offer to show, with no fallback request", async () => {
    const chunks = chunkRecorder();
    const response = await respondAudioTranscription(source(spoken, "audio/wav"), {}, options({ transcribe: primaryFails().transcribe, fallback: chunks.fallback }));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ code: "fallback_confirmation_required", error: "primary unavailable", completedParts: 0, parts: 1, expiresInSeconds: 1800 });
    expect(body.fallbackToken).toMatch(/^[0-9a-f]{32}$/);
    expect(body.notice).toContain("ChatGPT/Codex");
    expect(body.notice).toContain("asset_ttl='30d'");
    expect(chunks.calls).toHaveLength(0);
  });

  test("an approval resumes once without the primary; a repeated approval sends nothing more", async () => {
    const audio = source(spoken, "audio/wav");
    const primary = primaryFails();
    let duplicate: unknown = null;
    const chunks = chunkRecorder({
      onCall: (index) => {
        // The same approval arriving while the resumed run works is refused, not run twice.
        if (index === 0) duplicate = transcribeAudioAttachment(audio, { ...opts, fallbackToken: token }).catch((e) => e);
      },
    });
    const opts = options({ transcribe: primary.transcribe, fallback: chunks.fallback });
    const offer = await transcribeAudioAttachment(audio, opts).catch((e) => e);
    const token: string = offer.offer.fallbackToken;
    const result = await transcribeAudioAttachment(audio, { ...opts, fallbackToken: token });
    expect(result).toEqual({ transcript: "chunk 1 chunk 2 chunk 3", parts: 1 });
    expect(await duplicate).toMatchObject({ code: "in_progress" });
    const again = await transcribeAudioAttachment(audio, { ...opts, fallbackToken: token }).catch((e) => e);
    expect(again).toMatchObject({ code: "fallback_confirmation_expired" });
    expect(primary.calls).toHaveLength(1);
    expect(chunks.calls).toHaveLength(3);
    expect(tmpEntries()).toEqual([]);
  });

  test("a finished primary never reaches the fallback", async () => {
    const primary = recorder();
    const chunks = chunkRecorder();
    const result = await transcribeAudioAttachment(source(spoken, "audio/wav"), options({ transcribe: primary.transcribe, fallback: chunks.fallback }));
    expect(result).toEqual({ transcript: "part 1 text", parts: 1 });
    expect(chunks.calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
  });

  test("a failed direct file is re-cut into 15 s MP3 chunks sent in order, then joined", async () => {
    const before = sha256(spoken);
    const primary = primaryFails();
    const chunks = chunkRecorder();
    const result = await approveFallback(source(spoken, "audio/wav"), options({ transcribe: primary.transcribe, fallback: chunks.fallback }));
    expect(result).toEqual({ transcript: "chunk 1 chunk 2 chunk 3", parts: 1 });
    expect(primary.calls).toHaveLength(1);
    expect(chunks.calls.map((c) => c.mimeType)).toEqual(["audio/mpeg", "audio/mpeg", "audio/mpeg"]);
    expect(chunks.calls.map((c) => c.head)).toEqual(["ID3", "ID3", "ID3"]);
    const lengths = await Promise.all(chunks.files.map((file) => probeAudioDurationSeconds(ffmpeg!, file)));
    // 40 s in ceil(40 / 15) = 3 balanced chunks of about 13.3 s, none above the 15 s cap.
    for (const length of lengths) {
      expect(length).toBeLessThanOrEqual(15.1);
      expect(length).toBeGreaterThan(13);
    }
    // Each chunk is encoded on its own, so no audio is lost at the boundaries (a cut MP3 loses ~0.1 s each).
    expect(lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(39.85);
    expect(tmpEntries()).toEqual([]);
    expect(sha256(spoken)).toBe(before);
  });

  test("a split recording keeps the finished part, and after approval the failed part and later ones go to the fallback", async () => {
    const audio = source(large, "audio/wav");
    const primary = recorder((index) => (index === 1 ? new Error("quota exhausted") : null));
    const chunks = chunkRecorder({ text: (index) => `c${index + 1}` });
    const offer = await transcribeAudioAttachment(audio, options({ confirmed: true, transcribe: primary.transcribe, fallback: chunks.fallback })).catch((e) => e);
    // The large-file confirmation covered the primary only: nothing has gone to the fallback yet.
    expect(offer).toMatchObject({ code: "fallback_confirmation_required", status: 409, details: { completedParts: 1, parts: 3 } });
    expect(offer.message).toBe("part 2 of 3 failed: quota exhausted");
    expect(chunks.calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
    // The approval alone resumes: the copy is cut again locally and the primary is not asked again.
    const result = await transcribeAudioAttachment(audio, options({ transcribe: primary.transcribe, fallback: chunks.fallback, fallbackToken: offer.offer.fallbackToken }));
    // 1300 s -> parts of 600, 600 and 100 s; parts 2 and 3 -> 40 + 7 chunks; the primary is not tried on part 3.
    expect(primary.calls).toHaveLength(2);
    expect(chunks.calls).toHaveLength(47);
    const part2 = Array.from({ length: 40 }, (_, i) => `c${i + 1}`).join(" ");
    const part3 = Array.from({ length: 7 }, (_, i) => `c${i + 41}`).join(" ");
    expect(result.parts).toBe(3);
    expect(result.transcript).toBe(`part 1 text\n\n${part2}\n\n${part3}`);
    expect(tmpEntries()).toEqual([]);
    expect(sha256(large)).toBe(largeSha);
  });

  test("a content block is not sent to another provider", async () => {
    const primary = primaryFails(new TranscriptBlockedError("transcription stopped: error (Generation failed with finish reason: SAFETY)"));
    const chunks = chunkRecorder();
    const error = await transcribeAudioAttachment(source(spoken, "audio/wav"), options({ transcribe: primary.transcribe, fallback: chunks.fallback })).catch((e) => e);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502, details: { completedParts: 0, parts: 1 } });
    expect(error.message).toContain("finish reason: SAFETY");
    expect(chunks.calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
  });

  test("an ordinary stopped reply is still offered to the fallback", async () => {
    const primary = primaryFails(new TranscriptStoppedError("transcription stopped: error (Generation failed with finish reason: OTHER)"));
    const chunks = chunkRecorder();
    const result = await approveFallback(source(spoken, "audio/wav"), options({ transcribe: primary.transcribe, fallback: chunks.fallback }));
    expect(result.transcript).toBe("chunk 1 chunk 2 chunk 3");
  });

  test("aborting after the primary failed starts no fallback request", async () => {
    const controller = new AbortController();
    const chunks = chunkRecorder();
    const transcribe = async () => {
      controller.abort();
      throw new Error("primary unavailable");
    };
    const error = await transcribeAudioAttachment(source(spoken, "audio/wav"), options({ transcribe, fallback: chunks.fallback, signal: controller.signal })).catch((e) => e);
    expect(error).toMatchObject({ code: "aborted", status: 499 });
    expect(chunks.calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
  });

  test("aborting during the fallback stops the remaining chunks and removes the chunk folder", async () => {
    const controller = new AbortController();
    const chunks = chunkRecorder({ onCall: (index) => index === 1 && controller.abort() });
    const error = await approveFallback(source(spoken, "audio/wav"), options({ transcribe: primaryFails().transcribe, fallback: chunks.fallback, signal: controller.signal })).catch((e) => e);
    expect(error).toMatchObject({ code: "aborted", status: 499 });
    expect(chunks.calls).toHaveLength(2);
    expect(tmpEntries()).toEqual([]);
  });

  test("a failed chunk fails the whole run with both reasons and no partial transcript", async () => {
    const chunks = chunkRecorder({ failAt: 1 });
    const error = await approveFallback(source(spoken, "audio/wav"), options({ transcribe: primaryFails().transcribe, fallback: chunks.fallback })).catch((e) => e);
    expect(error).toBeInstanceOf(AudioTranscriptionError);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502, details: { completedParts: 0, parts: 1 } });
    expect(error.message).toContain("primary unavailable");
    expect(error.message).toContain("fallback transcription failed: chunk 2 of 3: codex exploded");
    expect(chunks.calls).toHaveLength(2);
    expect(tmpEntries()).toEqual([]);
  });

  test("silent chunks are skipped, and a run where every chunk is empty is a no-text failure", async () => {
    const mixed = await approveFallback(
      source(spoken, "audio/wav"),
      options({ transcribe: primaryFails().transcribe, fallback: chunkRecorder({ text: (index) => (index === 1 ? "  " : `chunk ${index + 1}`) }).fallback }),
    );
    expect(mixed.transcript).toBe("chunk 1 chunk 3");
    const error = await approveFallback(
      source(spoken, "audio/wav"),
      options({ transcribe: primaryFails().transcribe, fallback: chunkRecorder({ text: () => "" }).fallback }),
    ).catch((e) => e);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502 });
    expect(error.message).toContain("no text");
  });

  test("when the primary failed and every chunk is empty, the failure names the primary reason too", async () => {
    const error = await approveFallback(
      source(spoken, "audio/wav"),
      options({ transcribe: primaryFails().transcribe, fallback: chunkRecorder({ text: () => "" }).fallback }),
    ).catch((e) => e);
    expect(error.message).toContain("primary unavailable");
    expect(error.message).toContain("no text");
  });

  test("an unconfirmed large file starts neither FFmpeg, the primary nor the fallback", async () => {
    const primary = recorder();
    const chunks = chunkRecorder();
    const error = await transcribeAudioAttachment(source(large, "audio/wav"), {
      resolveFfmpeg: () => Promise.reject(new Error("FFmpeg must not be resolved")),
      tmpRoot,
      transcribe: primary.transcribe,
      fallback: chunks.fallback,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "confirmation_required", status: 409 });
    expect(primary.calls).toHaveLength(0);
    expect(chunks.calls).toHaveLength(0);
  });

  test("a playlist whose primary request failed is not opened by the chunker", async () => {
    const wav = makeAudio("playlist-target.wav", ["-f", "lavfi", "-i", "sine=duration=1", "-c:a", "pcm_s16le"]);
    const list = join(work, "fallback-list.wav");
    writeFileSync(list, `ffconcat version 1.0\nfile '${wav.replaceAll("\\", "/")}'\n`);
    const chunks = chunkRecorder();
    const error = await approveFallback(source(list, "audio/wav"), options({ transcribe: primaryFails().transcribe, fallback: chunks.fallback })).catch((e) => e);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502 });
    expect(error.message).toContain("fallback transcription failed");
    expect(chunks.calls).toHaveLength(0);
    expect(tmpEntries()).toEqual([]);
  });

  test("a missing FFmpeg makes the fallback fail instead of being skipped", async () => {
    const chunks = chunkRecorder();
    const error = await transcribeAudioAttachment(source(spoken, "audio/wav"), {
      resolveFfmpeg: () => Promise.reject(new AudioTranscriptionError("media_tool_unavailable", "FFmpeg is not available", 503)),
      tmpRoot,
      transcribe: primaryFails().transcribe,
      fallback: chunks.fallback,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: "transcription_failed", status: 502 });
    expect(error.message).toContain("FFmpeg is not available");
    expect(tmpEntries()).toEqual([]);
  });
});

describe.skipIf(!ffmpeg)("fallback chunk boundaries", () => {
  /** Dominant frequency of an MP3 chunk, from the zero crossings of its decoded samples. */
  function toneOf(file: string): number {
    const decoded = spawnSync(ffmpeg!, ["-hide_banner", "-nostdin", "-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { maxBuffer: 1 << 26 });
    const samples = new Int16Array(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength >> 1);
    let crossings = 0;
    for (let i = 1; i < samples.length; i += 1) if (samples[i - 1]! < 0 !== samples[i]! < 0) crossings += 1;
    return crossings / 2 / (samples.length / 8000);
  }

  /** One tone per equal share of the clip, so a chunk's pitch tells which part of the source it holds. */
  function toneClip(name: string, tones: number[], totalSeconds: number): string {
    const each = totalSeconds / tones.length;
    const inputs = tones.flatMap((hz) => ["-f", "lavfi", "-i", `sine=frequency=${hz}:sample_rate=8000:duration=${each}`]);
    const concat = `${tones.map((_, i) => `[${i}:a]`).join("")}concat=n=${tones.length}:v=0:a=1`;
    return makeAudio(name, [...inputs, "-filter_complex", concat, "-ac", "1", "-c:a", "pcm_s16le"]);
  }

  async function fallbackChunks(clip: string) {
    const files: string[] = [];
    const transcribe = async (audio: Uint8Array) => {
      const file = join(work, `boundary-chunk-${files.length}-${Date.now()}.mp3`);
      writeFileSync(file, audio);
      files.push(file);
      return `chunk ${files.length}`;
    };
    await approveFallback(source(clip, "audio/wav"), {
      resolveFfmpeg: async () => ffmpeg!,
      tmpRoot,
      transcribe: async () => { throw new Error("primary unavailable"); },
      fallback: { transcribe, chunkSeconds: 15 },
    });
    const lengths = await Promise.all(files.map((file) => probeAudioDurationSeconds(ffmpeg!, file)));
    return { lengths, tones: files.map(toneOf) };
  }

  // Codec padding and frame rounding move a measured length by well under 0.1 s.
  const PADDING = 0.1;

  test.each([
    [16.5, [440, 880]],
    [31, [440, 660, 880]],
  ])("a %f s source is split into balanced chunks of at most 15 s that cover it in order", async (seconds, tones) => {
    const clip = toneClip(`boundary-${seconds}.wav`, tones, seconds);
    const { lengths, tones: heard } = await fallbackChunks(clip);
    expect(lengths).toHaveLength(Math.ceil(seconds / 15));
    for (const length of lengths) expect(length).toBeLessThanOrEqual(15 + PADDING);
    expect(lengths.reduce((a, b) => a + b, 0)).toBeGreaterThan(seconds - PADDING);
    // Each standalone chunk may carry up to PADDING of encoder padding, so the sum can exceed the source by that much per chunk.
    expect(lengths.reduce((a, b) => a + b, 0)).toBeLessThan(seconds + PADDING * lengths.length);
    // The tones change at 1/n of the source, which is exactly where balanced chunks end.
    heard.forEach((hz, index) => expect(hz).toBeCloseTo(tones[index]!, -1));
    expect(tmpEntries()).toEqual([]);
  });
});
