import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { adoptLegacyStateFile } from "../bin/web-auth-store.js";
import { getAgentDir } from "@/lib/session-reader";

// Frontend-only session archive: a flat registry of session ids kept outside
// the session files themselves. Archiving never moves or edits a session, so
// the omp CLI and --resume are unaffected; restoring is a flag flip.
const REGISTRY_FILE = "cuelo-archived.json";
const LEGACY_REGISTRY_FILE = "omp-web-archived.json";

/** The ids in a registry file's text; throws when the text is not a registry. */
function parseRegistry(text: string): Set<string> {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || !("archived" in data) || !Array.isArray(data.archived)) {
    throw new Error("not an archive registry");
  }
  return new Set(data.archived.filter((v): v is string => typeof v === "string"));
}

export function readArchivedIds(): Set<string> {
  try {
    const file = join(getAgentDir(), REGISTRY_FILE);
    adoptLegacyStateFile(file, LEGACY_REGISTRY_FILE);
    if (!existsSync(file)) return new Set();
    return parseRegistry(readFileSync(file, "utf8"));
  } catch {
    // A corrupt registry must never break the session list; worst case the
    // archive marks are lost, the sessions themselves are untouched.
    return new Set();
  }
}

/**
 * The archived ids for a caller that must not write and must not read a broken
 * registry as "nothing archived": a legacy registry is read where it is instead
 * of being adopted, and an unreadable or corrupt registry throws.
 */
export function readArchivedIdsReadOnly(): Set<string> {
  const dir = getAgentDir();
  for (const name of [REGISTRY_FILE, LEGACY_REGISTRY_FILE]) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    return parseRegistry(text);
  }
  return new Set();
}

export function setSessionArchived(id: string, archived: boolean): void {
  const ids = readArchivedIds();
  if (archived) ids.add(id);
  else ids.delete(id);
  const file = join(getAgentDir(), REGISTRY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ archived: [...ids].sort() }, null, 2));
  renameSync(tmp, file);
}
