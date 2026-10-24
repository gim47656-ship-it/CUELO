import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { LIVE_PACES, type LivePace } from "./live-types";

/**
 * Speaking pace of live and interpreter calls, CUELO's own setting in
 * `<agentDir>/cuelo-live-settings.json`.
 *
 * Codex live signaling takes `session.audio.output.speed` without complaint, but the call
 * then never connects (6 of 6 measured on 2026-10-24), so the pace is a rule in the call's
 * instructions instead. Only the slow rule measurably lengthened the spoken interpretation;
 * a "speak faster" rule changed nothing, so there is no fast pace.
 */
export const LIVE_SETTINGS_FILE_NAME = "cuelo-live-settings.json";

export function isLivePace(value: unknown): value is LivePace {
  return typeof value === "string" && (LIVE_PACES as readonly string[]).includes(value);
}

function settingsPath(): string {
  return path.join(getAgentDir(), LIVE_SETTINGS_FILE_NAME);
}

/** The saved pace; a missing or unreadable file means `normal`. */
export async function readLivePace(): Promise<LivePace> {
  let text: string;
  try {
    text = await readFile(settingsPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "normal";
    throw error;
  }
  try {
    const pace = (JSON.parse(text) as { pace?: unknown } | null)?.pace;
    return isLivePace(pace) ? pace : "normal";
  } catch {
    return "normal";
  }
}

export function writeLivePace(pace: LivePace): void {
  mkdirSync(getAgentDir(), { recursive: true });
  writePrivateFileAtomicSync(settingsPath(), `${JSON.stringify({ pace })}\n`);
}

/** The block a call's instructions end with for this pace; empty for `normal`. */
export function livePaceInstructions(pace: LivePace): string {
  if (pace !== "slow") return "";
  return "<delivery>\nSpeak slowly and clearly, at about 70% of your normal speaking rate, with short pauses between phrases.\n</delivery>";
}
