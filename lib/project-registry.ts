import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { normalizeProjectKey } from "@/lib/project-ordering";
import { getAgentDir } from "@/lib/session-reader";

export interface ProjectRegistryEntry {
  key: string;
  path?: string;
  alias?: string;
  hidden: boolean;
  order?: number;
}

export interface ProjectRegistryFile {
  version: 1;
  projects: ProjectRegistryEntry[];
}

export interface ProjectRegistryUpdate {
  key: string;
  path?: string;
  alias?: string | null;
  hidden?: boolean;
  order?: number | null;
}

export interface ProjectRegistryFileReadResult {
  status: "missing" | "ok" | "incompatible";
  registry: ProjectRegistryFile;
}

const REGISTRY_FILE = "projects.json";

function incompatibleProjectRegistry(): ProjectRegistryFileReadResult {
  return { status: "incompatible", registry: { version: 1, projects: [] } };
}

/**
 * Parse one registry file while distinguishing an incompatible file from
 * skippable entry-level damage.
 */
export function parseProjectRegistryFile(raw: string): ProjectRegistryFileReadResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return incompatibleProjectRegistry();
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return incompatibleProjectRegistry();
  }
  const candidate = parsed as { version?: unknown; projects?: unknown };
  if (candidate.version !== 1 || !Array.isArray(candidate.projects)) {
    return incompatibleProjectRegistry();
  }

  const projects: ProjectRegistryEntry[] = [];
  const seen = new Set<string>();
  for (const value of candidate.projects) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const item = value as {
      key?: unknown;
      path?: unknown;
      hidden?: unknown;
      alias?: unknown;
      order?: unknown;
    };
    if (typeof item.key !== "string") continue;
    const key = normalizeProjectKey(item.key);
    if (!key || seen.has(key)) continue;
    if ("path" in item && typeof item.path !== "string") continue;
    if ("hidden" in item && typeof item.hidden !== "boolean") continue;
    if ("alias" in item && typeof item.alias !== "string") continue;
    if ("order" in item && (typeof item.order !== "number" || !Number.isFinite(item.order))) {
      continue;
    }

    const alias = typeof item.alias === "string" ? item.alias.trim() : "";
    projects.push({
      key,
      hidden: item.hidden === true,
      ...(typeof item.path === "string" ? { path: item.path } : {}),
      ...(alias ? { alias } : {}),
      ...(typeof item.order === "number" ? { order: item.order } : {}),
    });
    seen.add(key);
  }
  return { status: "ok", registry: { version: 1, projects } };
}

/** Fail-open compatibility wrapper used by callers that only need registry data. */
export function parseProjectRegistry(raw: string): ProjectRegistryFile {
  return parseProjectRegistryFile(raw).registry;
}

export function readProjectRegistryFile(): ProjectRegistryFileReadResult {
  try {
    const file = join(getAgentDir(), REGISTRY_FILE);
    if (!existsSync(file)) {
      return { status: "missing", registry: { version: 1, projects: [] } };
    }
    return parseProjectRegistryFile(readFileSync(file, "utf8"));
  } catch {
    return incompatibleProjectRegistry();
  }
}

export function loadProjectRegistry(): ProjectRegistryFile {
  return readProjectRegistryFile().registry;
}

/** Write beside the registry, then atomically replace it. */
export function saveProjectRegistry(registry: ProjectRegistryFile): void {
  const file = join(getAgentDir(), REGISTRY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export function updateProjectRegistry(
  registry: ProjectRegistryFile,
  updates: readonly ProjectRegistryUpdate[],
): ProjectRegistryFile {
  const byKey = new Map(registry.projects.map((entry) => [entry.key, { ...entry }]));

  for (const update of updates) {
    const key = normalizeProjectKey(update.key);
    if (!key) continue;
    const current = byKey.get(key) ?? { key, hidden: false };
    const next: ProjectRegistryEntry = { ...current, key };

    if (update.path !== undefined) next.path = update.path;
    if (update.alias !== undefined) {
      const alias = update.alias?.trim() ?? "";
      if (alias) next.alias = alias;
      else delete next.alias;
    }
    if (update.hidden !== undefined) next.hidden = update.hidden;
    if (update.order !== undefined) {
      if (update.order === null) delete next.order;
      else next.order = update.order;
    }

    byKey.set(key, next);
  }

  return {
    version: 1,
    projects: [...byKey.values()].filter((entry) => (
      entry.hidden || Boolean(entry.alias?.trim()) || entry.order !== undefined
    )),
  };
}
