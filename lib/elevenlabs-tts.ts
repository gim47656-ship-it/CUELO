import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";

/** TTS-only key created for CUELO (`<agentDir>/elevenlabs-cuelo-api-key`, mode 600). Missing file = feature off. */
const KEY_FILE = "elevenlabs-cuelo-api-key";
/** Premade multilingual voice "Sarah". Premade legacy voices such as Rachel return voice_not_found. */
const VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
/** Latest real-time model (2026-11-23 docs, ~100 ms server latency); unlike Flash v2.5 it also reads Thai. */
const MODEL_ID = "eleven_v4_turbo";

export async function readElevenLabsKey(agentDir = getAgentDir()): Promise<string | null> {
  try {
    return (await readFile(join(agentDir, KEY_FILE), "utf8")).trim() || null;
  } catch {
    return null;
  }
}

/** Streams MP3 for one finished line; the caller passes the body through without buffering. */
export async function synthesizeElevenLabs(text: string, key: string, signal: AbortSignal,
  fetcher: typeof fetch = fetch): Promise<Response> {
  return fetcher(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?output_format=mp3_44100_128`, {
    method: "POST", signal, redirect: "error", headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({ text, model_id: MODEL_ID }),
  });
}
