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
import { MAX_TRANSCRIBE_AUDIO_BYTES } from "./attachment-audio-types";
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
const LARGE_SECONDS = 1300;

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

  test("request body accepts nothing, {} or a boolean confirmation only", async () => {
    const make = (body: string) => new Request("http://x/", { method: "POST", body, headers: { "content-type": "application/json" } });
    expect(await readAudioTranscriptionRequest(make(""))).toEqual({ confirmed: false });
    expect(await readAudioTranscriptionRequest(make("{}"))).toEqual({ confirmed: false });
    expect(await readAudioTranscriptionRequest(make('{"confirmed":true}'))).toEqual({ confirmed: true });
    expect(await readAudioTranscriptionRequest(make('{"confirmed":"yes"}'))).toBeNull();
    expect(await readAudioTranscriptionRequest(make("not json"))).toBeNull();
  });
});
