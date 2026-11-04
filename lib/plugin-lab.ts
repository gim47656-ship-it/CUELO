/**
 * Plugin Lab: trial plugins the agent writes for this user's own profile, and the
 * promoted copies the nightly loop ships through the repository.
 *
 * Trial root `<agentDir>/plugin-lab/<id>/`, promoted root `<agentDir>/cuelo-plugins/<id>/`,
 * same layout in both: `plugin.json` plus the files it names. A promoted id shadows the
 * trial copy of the same id (listed with `promoted: true`, never loaded). A broken
 * plugin is listed with `problem` set; it never breaks listing or session start.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { maskSecrets } from "./upkeep/sessions";

export type LabPlugin = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  origin: "trial" | "promoted";
  enabled: boolean;
  promoted: boolean;
  hasExtension: boolean;
  tools: string[];
  hasPanel: boolean;
  problem?: string;
};

export type LabUsage = {
  id: string;
  sessions: number;
  toolCalls: number;
  toolFailures: number;
  panelOpens: number;
  activeDays: number;
  lastUsedAt: string | null;
  /** Tool failures inside the plugin's 3 most recent sessions that called its tools (0 without sessions). */
  recentSessionFailures: number;
};

export type LabExportEntry = { plugin: LabPlugin; usage: LabUsage; files: { path: string; text: string }[] };

export type LabEvent = "panel_open" | "draft";

/** An enabled, loadable extension entry for session start. `signature` changes when any file of the plugin changes. */
export type LabExtensionEntry = { id: string; path: string; signature: string };

export const LAB_EXPORT_LIMIT_BYTES = 64 * 1024;
export const LAB_PANEL_LIMIT_BYTES = 512 * 1024;
/** Headers that keep the panel HTML inert unless the host frames it in `sandbox="allow-scripts"`. */
export const LAB_PANEL_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy":
    "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const EXTENSION_SUFFIXES = [".ts", ".js", ".mjs"];
const MANIFEST = "plugin.json";
const MANIFEST_LIMIT_BYTES = 64 * 1024;
const WALK_FILE_LIMIT = 500;
const TEXT_SUFFIXES = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".json", ".md", ".txt", ".html", ".css", ".svg", ".yml", ".yaml", ".csv",
]);
const YIELD_EVERY_MS = 8;

export function isLabPluginId(id: unknown): id is string {
  return typeof id === "string" && id.length <= 64 && ID_PATTERN.test(id);
}

export function labTrialRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "plugin-lab");
}

export function labPromotedRoot(agentDir = getAgentDir()): string {
  return join(agentDir, "cuelo-plugins");
}

function statePath(agentDir: string): string {
  return join(labTrialRoot(agentDir), "state.json");
}

function usagePath(agentDir: string): string {
  return join(labTrialRoot(agentDir), "usage.jsonl");
}

function loadProblemsPath(agentDir: string): string {
  return join(labTrialRoot(agentDir), "load-problems.json");
}

function isInside(child: string, root: string): boolean {
  const rel = relative(root, child);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * Real path of `rel` inside `dir`, or a reason it is refused: absolute paths, `..`
 * segments, missing files, non-files, and symlinks that land outside the folder.
 */
export async function resolvePluginFile(dir: string, rel: unknown): Promise<{ path: string } | { problem: string }> {
  if (typeof rel !== "string" || rel.trim() === "") return { problem: "path must be a non-empty string" };
  if (isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes("\\")) return { problem: `path must be relative: ${rel}` };
  if (rel.split("/").some((part) => part === "..")) return { problem: `path leaves the plugin folder: ${rel}` };
  let realDir: string;
  let real: string;
  try {
    realDir = await realpath(dir);
    real = await realpath(resolve(dir, rel));
  } catch {
    return { problem: `file not found: ${rel}` };
  }
  if (!isInside(real, realDir)) return { problem: `path leaves the plugin folder: ${rel}` };
  const info = await stat(real);
  if (!info.isFile()) return { problem: `not a file: ${rel}` };
  return { path: real };
}

type Manifest = {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  extension?: string;
  tools: string[];
  panel?: string;
};

type ScannedPlugin = {
  plugin: LabPlugin;
  dir: string;
  manifest?: Manifest;
  /** Real path of the extension entry when it resolved. */
  extensionPath?: string;
  /** Real path of the panel file when it resolved. */
  panelPath?: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function parseManifest(raw: unknown, id: string): Manifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("plugin.json must be a JSON object");
  const value = raw as Record<string, unknown>;
  if (value.id !== id) fail(`plugin.json id must equal the folder name "${id}"`);
  const text = (key: string): string => {
    const field = value[key];
    if (typeof field !== "string" || field.trim() === "") fail(`plugin.json "${key}" must be a non-empty string`);
    return field;
  };
  const name = text("name");
  const description = text("description");
  const createdAt = text("createdAt");
  // ISO 8601 date-time only; Date.parse alone also takes free-form dates such as "March 1, 2026".
  if (!ISO_DATE_TIME.test(createdAt) || Number.isNaN(Date.parse(createdAt))) fail('plugin.json "createdAt" must be an ISO date string');
  const manifest: Manifest = { id, name, description, createdAt, tools: [] };
  if (value.extension !== undefined) {
    const entry = text("extension");
    if (!EXTENSION_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
      fail(`plugin.json "extension" must end with ${EXTENSION_SUFFIXES.join(", ")}`);
    }
    manifest.extension = entry;
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string" && TOOL_NAME_PATTERN.test(tool))) {
      fail('plugin.json "tools" must be an array of tool names (letters, digits, "_" or "-")');
    }
    if (value.tools.length > 0 && manifest.extension === undefined) fail('plugin.json "tools" needs an "extension" that registers them');
    manifest.tools = [...new Set(value.tools as string[])];
  }
  if (value.panel !== undefined) {
    const panel = text("panel");
    if (!panel.endsWith(".html")) fail('plugin.json "panel" must be an .html file');
    manifest.panel = panel;
  }
  return manifest;
}

async function readJson(path: string, limit: number): Promise<unknown> {
  const info = await stat(path);
  if (info.size > limit) fail(`${path.split(sep).pop()} is larger than ${limit} bytes`);
  return JSON.parse(await readFile(path, "utf8"));
}

type LabState = { disabled: string[]; problem?: string };

/**
 * A missing state file means nothing is disabled. A state file that exists but cannot be read
 * fails closed: `scanAll` keeps every plugin off rather than re-enabling what the user disabled.
 */
async function readLabState(agentDir: string): Promise<LabState> {
  let raw: unknown;
  try {
    raw = await readJson(statePath(agentDir), MANIFEST_LIMIT_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { disabled: [] };
    return { disabled: [], problem: `plugin-lab/state.json is unreadable (${(error as Error).message})` };
  }
  const disabled = (raw as { disabled?: unknown } | null)?.disabled;
  if (!Array.isArray(disabled)) return { disabled: [], problem: 'plugin-lab/state.json has no "disabled" list' };
  return { disabled: [...new Set(disabled.filter(isLabPluginId))] };
}

async function readLoadProblems(agentDir: string): Promise<Record<string, string>> {
  try {
    const raw = await readJson(loadProblemsPath(agentDir), MANIFEST_LIMIT_BYTES);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).filter(
        (entry): entry is [string, string] => isLabPluginId(entry[0]) && typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

async function scanRoot(root: string, origin: LabPlugin["origin"]): Promise<ScannedPlugin[]> {
  let names: string[];
  try {
    names = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const scanned: ScannedPlugin[] = [];
  for (const name of names) {
    const dir = join(root, name);
    let info;
    try {
      info = await lstat(dir);
    } catch {
      continue;
    }
    // Files next to the plugins (state.json, usage.jsonl) are not plugins.
    if (!info.isDirectory() && !info.isSymbolicLink()) continue;
    if (name.startsWith(".")) continue;
    const plugin: LabPlugin = {
      id: name, name, description: "", createdAt: "", origin, enabled: false, promoted: false,
      hasExtension: false, tools: [], hasPanel: false,
    };
    const entry: ScannedPlugin = { plugin, dir };
    scanned.push(entry);
    if (!isLabPluginId(name)) {
      plugin.problem = "folder name must be a kebab-case plugin id (a-z, 0-9, single dashes)";
      continue;
    }
    if (info.isSymbolicLink()) {
      plugin.problem = "plugin folder must be a real folder, not a symlink";
      continue;
    }
    try {
      const manifestFile = await resolvePluginFile(dir, MANIFEST);
      if ("problem" in manifestFile) fail(`plugin.json: ${manifestFile.problem}`);
      const manifest = parseManifest(await readJson(manifestFile.path, MANIFEST_LIMIT_BYTES), name);
      entry.manifest = manifest;
      Object.assign(plugin, {
        name: manifest.name, description: manifest.description, createdAt: manifest.createdAt, tools: manifest.tools,
      });
      if (manifest.extension) {
        const resolved = await resolvePluginFile(dir, manifest.extension);
        if ("problem" in resolved) fail(`extension: ${resolved.problem}`);
        entry.extensionPath = resolved.path;
        plugin.hasExtension = true;
      }
      if (manifest.panel) {
        const resolved = await resolvePluginFile(dir, manifest.panel);
        if ("problem" in resolved) fail(`panel: ${resolved.problem}`);
        entry.panelPath = resolved.path;
        plugin.hasPanel = true;
      }
    } catch (error) {
      plugin.problem = error instanceof SyntaxError ? `plugin.json is not valid JSON: ${error.message}` : (error as Error).message;
    }
  }
  return scanned;
}

async function scanAll(agentDir: string): Promise<ScannedPlugin[]> {
  const [trial, promoted, state, loadProblems] = await Promise.all([
    scanRoot(labTrialRoot(agentDir), "trial"),
    scanRoot(labPromotedRoot(agentDir), "promoted"),
    readLabState(agentDir),
    readLoadProblems(agentDir),
  ]);
  const promotedIds = new Set(promoted.map((entry) => entry.plugin.id));
  const disabled = new Set(state.disabled);
  const all = [...promoted, ...trial];
  for (const { plugin } of all) {
    plugin.promoted = plugin.origin === "promoted" || promotedIds.has(plugin.id);
    const shadowed = plugin.origin === "trial" && promotedIds.has(plugin.id);
    plugin.enabled = !shadowed && plugin.problem === undefined && state.problem === undefined && !disabled.has(plugin.id);
    if (plugin.problem === undefined && state.problem !== undefined) plugin.problem = `${state.problem}; every plugin stays off until it is fixed`;
    if (plugin.problem === undefined && !shadowed && loadProblems[plugin.id]) plugin.problem = loadProblems[plugin.id];
  }
  return all;
}

/** Every plugin in both roots: promoted first, then trial copies (a shadowed trial copy has `promoted: true`). */
export async function listLabPlugins(agentDir = getAgentDir()): Promise<LabPlugin[]> {
  return (await scanAll(agentDir)).map((entry) => entry.plugin);
}

/** The copy that would load for `id`: the promoted one when it exists. */
async function activePlugin(id: string, agentDir: string): Promise<ScannedPlugin | undefined> {
  const all = await scanAll(agentDir);
  return all.find((entry) => entry.plugin.id === id && entry.plugin.origin === "promoted")
    ?? all.find((entry) => entry.plugin.id === id);
}

export async function getLabPlugin(id: string, agentDir = getAgentDir()): Promise<LabPlugin | undefined> {
  if (!isLabPluginId(id)) return undefined;
  return (await activePlugin(id, agentDir))?.plugin;
}

/** One state write at a time in this process, so concurrent toggles cannot drop each other's change. */
let stateWrites: Promise<unknown> = Promise.resolve();

/** Turn a plugin on or off for new sessions and `/reload`. Returns the updated plugin, or `undefined` for an unknown id. */
export async function setLabPluginEnabled(id: string, enabled: boolean, agentDir = getAgentDir()): Promise<LabPlugin | undefined> {
  const write = stateWrites.then(async () => {
    if (!isLabPluginId(id) || !(await activePlugin(id, agentDir))) return undefined;
    const state = await readLabState(agentDir);
    // Rewriting an unreadable file would silently re-enable everything it disabled.
    if (state.problem) throw new Error(`${state.problem}; fix or remove it before changing plugins`);
    const disabled = new Set(state.disabled);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    await mkdir(labTrialRoot(agentDir), { recursive: true });
    const file = statePath(agentDir);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify({ disabled: [...disabled].sort() }, null, 2)}\n`, "utf8");
    await rename(temp, file);
    return (await activePlugin(id, agentDir))?.plugin;
  });
  stateWrites = write.catch(() => undefined);
  return write;
}

/**
 * Every file's relative path, size and mtime: any edit, addition or removal changes it. A
 * folder past the walk cap cannot be fingerprinted, so it gets a fresh value each time and
 * every `/reload` restarts the session rather than keep possibly stale code.
 */
async function folderFingerprint(dir: string): Promise<string> {
  const parts: string[] = [];
  let seen = 0;
  const walk = async (current: string): Promise<boolean> => {
    let names: string[];
    try {
      names = (await readdir(current)).sort();
    } catch {
      return true;
    }
    for (const name of names) {
      if (++seen > WALK_FILE_LIMIT) return false;
      const path = join(current, name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      // ctime moves on every write and cannot be set back, unlike mtime.
      parts.push(`${relative(dir, path)}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`);
      if (info.isDirectory() && !(await walk(path))) return false;
    }
    return true;
  };
  return (await walk(dir)) ? parts.join(",") : `too-many-files:${randomUUID()}`;
}

/** Enabled extension entries to load into a session, in listing order. */
export async function labExtensionEntries(agentDir = getAgentDir()): Promise<LabExtensionEntry[]> {
  const entries: LabExtensionEntry[] = [];
  for (const scanned of await scanAll(agentDir)) {
    const { plugin, extensionPath } = scanned;
    if (!plugin.enabled || !extensionPath) continue;
    entries.push({ id: plugin.id, path: extensionPath, signature: `${plugin.id}:${extensionPath}:${await folderFingerprint(scanned.dir)}` });
  }
  return entries;
}

/**
 * Store what happened when a session loaded the lab extensions: an error string sets the
 * plugin's `problem`, `null` clears it. Ids not mentioned keep their last record.
 */
export async function recordLabLoadResults(results: Record<string, string | null>, agentDir = getAgentDir()): Promise<void> {
  const ids = Object.keys(results).filter(isLabPluginId);
  if (ids.length === 0) return;
  const current = await readLoadProblems(agentDir);
  let changed = false;
  for (const id of ids) {
    const error = results[id];
    if (error === null) {
      if (id in current) {
        delete current[id];
        changed = true;
      }
    } else if (current[id] !== error) {
      current[id] = error.slice(0, 2000);
      changed = true;
    }
  }
  if (!changed) return;
  await mkdir(labTrialRoot(agentDir), { recursive: true });
  await writeFile(loadProblemsPath(agentDir), `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

export async function recordLabEvent(id: string, event: LabEvent, agentDir = getAgentDir()): Promise<void> {
  if (!isLabPluginId(id)) throw new Error(`invalid plugin id: ${String(id)}`);
  if (event !== "panel_open" && event !== "draft") throw new Error(`invalid lab event: ${String(event)}`);
  await mkdir(labTrialRoot(agentDir), { recursive: true });
  await appendFile(usagePath(agentDir), `${JSON.stringify({ ts: new Date().toISOString(), id, event })}\n`, "utf8");
}

/** The panel HTML of the active copy of `id`, or `undefined` when there is none to serve. */
export async function readLabPanel(id: string, agentDir = getAgentDir()): Promise<string | undefined> {
  if (!isLabPluginId(id)) return undefined;
  const scanned = await activePlugin(id, agentDir);
  if (!scanned?.panelPath) return undefined;
  const info = await stat(scanned.panelPath);
  if (info.size > LAB_PANEL_LIMIT_BYTES) return undefined;
  return readFile(scanned.panelPath, "utf8");
}

async function listSessionFiles(dir: string, sinceMs: number): Promise<string[]> {
  const files: string[] = [];
  const walk = async (current: string): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(current);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(current, name);
      const info = await lstat(path).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) await walk(path);
      else if (info.isFile() && name.endsWith(".jsonl") && info.mtimeMs >= sinceMs) files.push(path);
    }
  };
  await walk(dir);
  return files;
}

type UsageCounter = {
  /** Session file → last call time and failed results in that session. */
  sessions: Map<string, { last: number; failures: number }>;
  toolCalls: number;
  toolFailures: number;
  panelOpens: number;
  days: Set<string>;
  last: number;
};

const RECENT_SESSIONS = 3;

type SessionLine = {
  timestamp?: string;
  message?: { role?: string; content?: unknown; toolName?: string; isError?: boolean; timestamp?: number };
};

/**
 * Per-plugin use since `sinceMs`: tool calls and failed results of the tools each manifest
 * declares, read from the session JSONL files, and panel opens from the lab usage log.
 */
export async function readLabUsage(sinceMs: number, sessionsDir: string, agentDir = getAgentDir()): Promise<LabUsage[]> {
  const plugins = await listLabPlugins(agentDir);
  const counters = new Map<string, UsageCounter>();
  const toolOwner = new Map<string, string>();
  for (const plugin of plugins) {
    if (!counters.has(plugin.id)) {
      counters.set(plugin.id, { sessions: new Map(), toolCalls: 0, toolFailures: 0, panelOpens: 0, days: new Set(), last: 0 });
    }
    // The copy that loads owns its tools: promoted entries come first in the listing.
    for (const tool of plugin.tools) if (!toolOwner.has(tool)) toolOwner.set(tool, plugin.id);
  }
  const touch = (counter: UsageCounter, at: number) => {
    counter.days.add(new Date(at).toISOString().slice(0, 10));
    counter.last = Math.max(counter.last, at);
  };

  if (toolOwner.size > 0) {
    let lastYield = Date.now();
    for (const file of await listSessionFiles(sessionsDir, sinceMs)) {
      const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
      for await (const line of lines) {
        if (Date.now() - lastYield > YIELD_EVERY_MS) {
          await yieldEventLoop();
          lastYield = Date.now();
        }
        if (!line.includes('"toolCall"') && !line.includes('"toolResult"')) continue;
        let entry: SessionLine;
        try {
          entry = JSON.parse(line) as SessionLine;
        } catch {
          continue;
        }
        const at = Date.parse(entry.timestamp ?? "") || entry.message?.timestamp || 0;
        if (at < sinceMs || !entry.message) continue;
        const { role, content, toolName, isError } = entry.message;
        if (role === "assistant" && Array.isArray(content)) {
          for (const block of content as { type?: string; name?: string }[]) {
            const owner = block?.type === "toolCall" && block.name ? toolOwner.get(block.name) : undefined;
            const counter = owner ? counters.get(owner) : undefined;
            if (!counter) continue;
            counter.toolCalls += 1;
            const session = counter.sessions.get(file) ?? { last: 0, failures: 0 };
            session.last = Math.max(session.last, at);
            counter.sessions.set(file, session);
            touch(counter, at);
          }
        } else if (role === "toolResult" && isError === true && toolName) {
          const owner = toolOwner.get(toolName);
          const counter = owner ? counters.get(owner) : undefined;
          if (!counter) continue;
          counter.toolFailures += 1;
          const session = counter.sessions.get(file);
          if (session) session.failures += 1;
        }
      }
    }
  }

  try {
    const text = await readFile(usagePath(agentDir), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event: { ts?: string; id?: string; event?: string };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const at = Date.parse(event.ts ?? "");
      const counter = event.id ? counters.get(event.id) : undefined;
      if (!counter || !(at >= sinceMs)) continue;
      if (event.event === "panel_open") counter.panelOpens += 1;
      else if (event.event !== "draft") continue;
      touch(counter, at);
    }
  } catch {
    // No usage log yet.
  }

  return [...counters].map(([id, counter]) => ({
    id,
    sessions: counter.sessions.size,
    toolCalls: counter.toolCalls,
    toolFailures: counter.toolFailures,
    panelOpens: counter.panelOpens,
    activeDays: counter.days.size,
    lastUsedAt: counter.last > 0 ? new Date(counter.last).toISOString() : null,
    recentSessionFailures: [...counter.sessions.values()]
      .sort((a, b) => b.last - a.last)
      .slice(0, RECENT_SESSIONS)
      .reduce((sum, session) => sum + session.failures, 0),
  }));
}

function isTextName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot > 0 && TEXT_SUFFIXES.has(name.slice(dot).toLowerCase());
}

async function readPluginTextFiles(dir: string): Promise<{ files: { path: string; text: string }[]; problem?: string }> {
  const files: { path: string; text: string }[] = [];
  let bytes = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  // A symlinked plugin folder could point anywhere; only real folders are exported.
  if (!(await lstat(dir)).isDirectory()) return { files: [], problem: "plugin folder is not a real folder; not exported" };
  const walk = async (current: string): Promise<string | undefined> => {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const path = join(current, name);
      const info = await lstat(path);
      // Symlinks are skipped so an export never reads outside the plugin folder.
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        const problem = await walk(path);
        if (problem) return problem;
        continue;
      }
      if (!info.isFile() || !isTextName(name)) continue;
      if (info.size > LAB_EXPORT_LIMIT_BYTES) return `plugin text exceeds ${LAB_EXPORT_LIMIT_BYTES} bytes`;
      const raw = await readFile(path);
      let text: string;
      try {
        text = decoder.decode(raw);
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue;
      const masked = maskSecrets(text);
      bytes += Buffer.byteLength(masked, "utf8");
      if (bytes > LAB_EXPORT_LIMIT_BYTES) return `plugin text exceeds ${LAB_EXPORT_LIMIT_BYTES} bytes`;
      files.push({ path: relative(dir, path).split(sep).join("/"), text: masked });
    }
    return undefined;
  };
  const problem = await walk(dir);
  return problem ? { files: [], problem } : { files };
}

/**
 * Trial plugins (not yet promoted) with their usage and masked text files for the nightly
 * bundle. A plugin whose text exceeds 64 KiB travels with `files: []` and `problem` set.
 */
export async function collectLabExport(sinceMs: number, sessionsDir: string, agentDir = getAgentDir()): Promise<LabExportEntry[]> {
  const [scanned, usage] = await Promise.all([scanAll(agentDir), readLabUsage(sinceMs, sessionsDir, agentDir)]);
  const usageById = new Map(usage.map((entry) => [entry.id, entry]));
  const entries: LabExportEntry[] = [];
  for (const { plugin, dir } of scanned) {
    if (plugin.origin !== "trial" || plugin.promoted) continue;
    const read = await readPluginTextFiles(dir).catch((error: Error) => ({ files: [], problem: `export failed: ${error.message}` }));
    entries.push({
      plugin: read.problem ? { ...plugin, problem: plugin.problem ? `${plugin.problem}; ${read.problem}` : read.problem } : plugin,
      usage: usageById.get(plugin.id) ?? {
        id: plugin.id, sessions: 0, toolCalls: 0, toolFailures: 0, panelOpens: 0, activeDays: 0, lastUsedAt: null, recentSessionFailures: 0,
      },
      files: read.files,
    });
  }
  return entries;
}

/** Where a plugin lives, for the `plugin_lab check` action. */
export type LabPluginLocation = { plugin: LabPlugin; dir: string; extensionPath?: string };

/**
 * The `plugin_lab` harness tool runs inside this server process but ships in the agent
 * profile, which cannot import CUELO source. It reaches this module through this
 * process-global host instead of keeping a second copy of the manifest rules.
 */
export type PluginLabHost = {
  version: 1;
  roots(): { trial: string; promoted: string };
  list(): Promise<LabPlugin[]>;
  usage(sinceMs: number): Promise<LabUsage[]>;
  setEnabled(id: string, enabled: boolean): Promise<LabPlugin | undefined>;
  locate(id: string): Promise<LabPluginLocation | undefined>;
};

declare global {
  var __cueloPluginLab: PluginLabHost | undefined;
}

globalThis.__cueloPluginLab = {
  version: 1,
  roots: () => ({ trial: labTrialRoot(), promoted: labPromotedRoot() }),
  list: () => listLabPlugins(),
  usage: (sinceMs) => readLabUsage(sinceMs, getSessionsDir(getAgentDir())),
  setEnabled: (id, enabled) => setLabPluginEnabled(id, enabled),
  locate: async (id) => {
    if (!isLabPluginId(id)) return undefined;
    const scanned = await activePlugin(id, getAgentDir());
    return scanned ? { plugin: scanned.plugin, dir: scanned.dir, ...(scanned.extensionPath ? { extensionPath: scanned.extensionPath } : {}) } : undefined;
  },
};
