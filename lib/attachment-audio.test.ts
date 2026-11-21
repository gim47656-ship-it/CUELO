/**
 * attachment-audio.ts against the real FFmpeg binary on synthetic audio. The provider is a fake
 * recorder: nothing here sends audio anywhere, so passing these tests says nothing about a real
 * transcription. Without the `ffmpeg-static` binary the media cases are skipped, not faked.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AudioTranscriptionError,
  planAudioTranscription,
  probeAudioDurationSeconds,
  readAudioTranscriptionRequest,
  respondAudioPlan,
  respondAudioTranscription,
  resolveFfmpegPath,
  transcribeAudioAttachment,
  type AudioSource,
} from "./attachment-audio";

const ffmpeg = await resolveFfmpegPath().catch(() => null);
const work = mkdtempSync(join(tmpdir(), "cuelo-audio-test-"));
const tmpRoot = join(work, "tmp");
const RECORDING_SECONDS = 40;

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

let large = "";
let largeSha = "";

beforeAll(() => {
  mkdirSync(tmpRoot);
  if (!ffmpeg) return;
  large = makeAudio("recording.wav", ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=8000:duration=${RECORDING_SECONDS}`, "-ac", "1", "-c:a", "pcm_s16le"]);
  largeSha = sha256(large);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

describe.skipIf(!ffmpeg)("short recordings", () => {
  test("plans one Codex request and sends MP3 only after approval", async () => {
    const small = makeAudio("short.wav", ["-f", "lavfi", "-i", "sine=duration=2", "-c:a", "pcm_s16le"]);
    const recording = source(small, "audio/wav");
    const { calls, transcribe } = recorder();
    const opts = { resolveFfmpeg: async () => ffmpeg!, tmpRoot, transcribe };
    const plan = await planAudioTranscription(recording, opts);
    expect(plan).toMatchObject({ estimatedCalls: 1, requiresConfirmation: true });
    expect(plan.durationSeconds).toBeCloseTo(2, 1);
    expect(plan.notice).toContain("ChatGPT/Codex");
    expect(plan.notice).toContain("asset_ttl='30d'");
    const unconfirmed = await respondAudioTranscription(recording, {}, opts);
    expect(unconfirmed.status).toBe(409);
    expect(calls).toHaveLength(0);
    const confirmed = await respondAudioTranscription(recording, { confirmed: true }, opts);
    expect(await confirmed.json()).toEqual({ transcript: "part 1 text", parts: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ mimeType: "audio/mpeg", head: "ID3" });
  });
});

describe.skipIf(!ffmpeg)("large audio with the real FFmpeg binary", () => {
  test("probes the real length and plans one call per short MP3 part", async () => {
    const plan = await planAudioTranscription(source(large, "audio/wav"), { resolveFfmpeg: async () => ffmpeg! });
    expect(plan.processing).toBe("compress-and-split");
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.durationSeconds).toBeGreaterThan(RECORDING_SECONDS - 1);
    expect(plan.durationSeconds).toBeLessThan(RECORDING_SECONDS + 1);
    expect(plan.estimatedCalls).toBe(3);
    expect(plan.notice).toContain("0:40");
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
      expect(["ID3", "\xff\xf3", "\xff\xfb"].some((magic) => call.head.startsWith(magic))).toBe(true);
    }
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
    expect(error.message).toContain("Part 2 of 3");
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
      if (name && /chunk\.mp3$/.test(String(name))) controller.abort();
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


  test("same attachment cannot run twice at once", async () => {
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const first = transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      tmpRoot,
      transcribe: async () => { entered(); await gate; return "done"; },
    });
    await started;
    const second = await transcribeAudioAttachment(source(large, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      transcribe: async () => "dup",
    }).catch((e) => e);
    expect(second).toMatchObject({ code: "in_progress", status: 409 });
    release();
    expect(await first).toEqual({ transcript: "done\n\ndone\n\ndone", parts: 3 });
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
    writeFileSync(text, "plain text pretending to be audio\n");
    const error = await planAudioTranscription(source(text, "audio/mpeg"), { resolveFfmpeg: async () => ffmpeg! }).catch((e) => e);
    expect(error).toMatchObject({ code: "media_unreadable", status: 422 });
  });
});

describe("HTTP responders", () => {
  test("missing media tool is reported, never replaced", async () => {
    const big = join(work, "big.bin");
    writeFileSync(big, "unused");
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

  test("a legacy fallback token never sends audio", async () => {
    const { calls, transcribe } = recorder();
    const response = await respondAudioTranscription(
      { id: "old", path: "unused", size: 10, mimeType: "audio/wav" },
      { fallbackToken: "ab".repeat(16), approve: true },
      { resolveFfmpeg: async () => "unused", transcribe },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "fallback_confirmation_expired" });
    expect(calls).toHaveLength(0);
  });
});

describe.skipIf(!ffmpeg)("transcription chunk boundaries", () => {
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

  async function recordChunks(clip: string) {
    const files: string[] = [];
    const transcribe = async (audio: Uint8Array) => {
      const file = join(work, `boundary-chunk-${files.length}-${Date.now()}.mp3`);
      writeFileSync(file, audio);
      files.push(file);
      return `chunk ${files.length}`;
    };
    await transcribeAudioAttachment(source(clip, "audio/wav"), {
      confirmed: true,
      resolveFfmpeg: async () => ffmpeg!,
      tmpRoot,
      transcribe,
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
    const { lengths, tones: heard } = await recordChunks(clip);
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
