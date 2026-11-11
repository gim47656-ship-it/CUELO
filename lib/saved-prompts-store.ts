import { randomUUID } from "crypto";
import { mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { derivePromptTitle, type SavedPrompt } from "./saved-prompts";

export const MAX_SAVED_PROMPT_BYTES = 20 * 1024;
const FILE_NAME = "cuelo-saved-prompts.json";

export class SavedPromptInputError extends Error {}

export function listSavedPrompts(agentDir = getAgentDir()): SavedPrompt[] {
  let raw: string;
  try {
    raw = readFileSync(join(agentDir, FILE_NAME), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error("Cannot read saved prompts", { cause: error });
  }
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 1 || !Array.isArray(data.prompts)) throw new Error("Invalid store");
    const ids = new Set<string>();
    for (const entry of data.prompts) {
      if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
        || typeof entry.title !== "string" || typeof entry.body !== "string"
        || typeof entry.createdAt !== "string" || typeof entry.updatedAt !== "string") {
        throw new Error("Invalid entry");
      }
      ids.add(entry.id);
    }
    return data.prompts;
  } catch (error) {
    throw new Error("Saved prompts file is corrupt or unsupported; it was not changed", { cause: error });
  }
}

function writePrompts(prompts: SavedPrompt[], agentDir: string): void {
  mkdirSync(agentDir, { recursive: true });
  writePrivateFileAtomicSync(join(agentDir, FILE_NAME), `${JSON.stringify({ version: 1, prompts }, null, 2)}\n`);
}

// Synchronous read-modify-write keeps concurrent requests in this server from losing updates.
export function createSavedPrompt(input: { title?: unknown; body?: unknown }, agentDir = getAgentDir()): SavedPrompt {
  if (typeof input.body !== "string" || !input.body.trim()) throw new SavedPromptInputError("Prompt body is required");
  if (Buffer.byteLength(input.body, "utf8") > MAX_SAVED_PROMPT_BYTES) throw new SavedPromptInputError("Prompt body exceeds 20 KB");
  if (input.title !== undefined && typeof input.title !== "string") throw new SavedPromptInputError("Prompt title must be text");
  const prompts = listSavedPrompts(agentDir);
  const now = new Date().toISOString();
  const prompt: SavedPrompt = {
    id: randomUUID(), title: derivePromptTitle(typeof input.title === "string" && input.title.trim() ? input.title : input.body),
    body: input.body, createdAt: now, updatedAt: now,
  };
  writePrompts([...prompts, prompt], agentDir);
  return prompt;
}

export function deleteSavedPrompt(id: string, agentDir = getAgentDir()): boolean {
  const prompts = listSavedPrompts(agentDir);
  const remaining = prompts.filter((prompt) => prompt.id !== id);
  if (remaining.length === prompts.length) return false;
  writePrompts(remaining, agentDir);
  return true;
}
