import { readdirSync, statSync, type Stats } from "fs";
import path from "path";
import { isExistingPathWithinRoots } from "./path-security";

/**
 * Read-only lookup behind the Files empty state shortcuts (current state, document map, recent
 * records). It follows the project document convention: the governing `HANDOFF.md` is the first one
 * met walking up from the work folder to the repository root (never past the allowed roots), and the
 * document map and records sit next to it under `doc/`. Without a `HANDOFF.md` only the work folder
 * itself is consulted, never the repository root, so a multi-project repository cannot hand out another
 * project's documents. Everything here is stat/readdir only and bounded; nothing is created or indexed.
 */

export type ProjectDocState = "found" | "missing" | "denied";

export interface ProjectDocEntry {
  state: ProjectDocState;
  /** Absolute path; set for `found` and `denied`, null for `missing`. */
  path: string | null;
}

export interface ProjectDocRecord {
  /** Absolute path of the record file. */
  path: string;
  /** `YYYY-MM-DD` taken from the `doc/history/YYYY/MM/DD-topic` folder. */
  date: string;
  topic: string;
  fileName: string;
}

export interface ProjectDocShortcuts {
  /** Folder the document map and records were taken from (the HANDOFF folder, or the work folder). */
  projectDir: string;
  handoff: ProjectDocEntry;
  docMap: ProjectDocEntry;
  history: { state: ProjectDocState; records: ProjectDocRecord[] };
}

const HANDOFF_FILE = "HANDOFF.md";
const MAX_ANCESTOR_LEVELS = 32;
export const DEFAULT_RECENT_RECORDS = 5;
const YEAR_RE = /^\d{4}$/;
const MONTH_RE = /^\d{2}$/;
const DAY_FOLDER_RE = /^(\d{2})-(.+)$/;

function statOrNull(target: string): Stats | null {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function isFile(target: string): boolean {
  return statOrNull(target)?.isFile() ?? false;
}

/**
 * Child folders of `directory` (already inside the allowed roots) whose names match `pattern`, newest
 * name first. A symlinked folder is followed only when it resolves inside the allowed roots, so nothing
 * outside them is listed or stat'ed.
 */
function listDirectoryNames(directory: string, pattern: RegExp, allowedRoots: Set<string>): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => {
        if (!pattern.test(entry.name)) return false;
        if (entry.isDirectory()) return true;
        const target = path.join(directory, entry.name);
        return entry.isSymbolicLink()
          && isExistingPathWithinRoots(target, allowedRoots)
          && Boolean(statOrNull(target)?.isDirectory());
      })
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * The work folder up to and including its nearest `.git` ancestor, never past the allowed roots: the walk
 * stops before the first ancestor outside them, so nothing above that boundary is inspected or reported.
 * The level bound also ends the walk with what was collected; reaching the filesystem root without `.git`
 * (not a repository) leaves only the work folder.
 */
function ancestorsToRepositoryRoot(start: string, allowedRoots: Set<string>): string[] {
  const chain: string[] = [];
  let current = start;
  for (let level = 0; level < MAX_ANCESTOR_LEVELS; level += 1) {
    chain.push(current);
    if (statOrNull(path.join(current, ".git"))) return chain;
    const parent = path.dirname(current);
    if (parent === current) return [start];
    if (!isExistingPathWithinRoots(parent, allowedRoots)) return chain;
    current = parent;
  }
  return chain;
}

function entryFor(target: string, allowedRoots: Set<string>): ProjectDocEntry {
  if (!isFile(target)) return { state: "missing", path: null };
  return { state: isExistingPathWithinRoots(target, allowedRoots) ? "found" : "denied", path: target };
}

/** The record file a history folder opens with: `main.md`, else its first Markdown file by name. */
function recordFileOf(folder: string): string | null {
  if (isFile(path.join(folder, "main.md"))) return "main.md";
  try {
    const markdown = readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.name.toLowerCase().endsWith(".md") && isFile(path.join(folder, entry.name)))
      .map((entry) => entry.name)
      .sort();
    return markdown[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Newest records first: by the folder date, then by the record file's modification time for records
 * of the same day. Stops after `limit` records; a month is read only while the list is short.
 */
function recentRecords(historyDir: string, allowedRoots: Set<string>, limit: number): ProjectDocRecord[] {
  const records: ProjectDocRecord[] = [];
  for (const year of listDirectoryNames(historyDir, YEAR_RE, allowedRoots)) {
    for (const month of listDirectoryNames(path.join(historyDir, year), MONTH_RE, allowedRoots)) {
      const monthDir = path.join(historyDir, year, month);
      const byDay = new Map<string, { record: ProjectDocRecord; mtimeMs: number }[]>();
      for (const folder of listDirectoryNames(monthDir, DAY_FOLDER_RE, allowedRoots)) {
        const [, day, topic] = DAY_FOLDER_RE.exec(folder) ?? [];
        const folderPath = path.join(monthDir, folder);
        const fileName = recordFileOf(folderPath);
        if (!fileName) continue;
        const filePath = path.join(folderPath, fileName);
        if (!isExistingPathWithinRoots(filePath, allowedRoots)) continue;
        const sameDay = byDay.get(day) ?? [];
        sameDay.push({
          record: { path: filePath, date: `${year}-${month}-${day}`, topic, fileName },
          mtimeMs: statOrNull(filePath)?.mtimeMs ?? 0,
        });
        byDay.set(day, sameDay);
      }
      for (const day of [...byDay.keys()].sort().reverse()) {
        const sameDay = byDay.get(day) ?? [];
        sameDay.sort((a, b) => b.mtimeMs - a.mtimeMs || b.record.topic.localeCompare(a.record.topic));
        for (const { record } of sameDay) {
          records.push(record);
          if (records.length >= limit) return records;
        }
      }
    }
  }
  return records;
}

/**
 * Resolve the document shortcuts for a work folder. The caller has already checked that `cwd` is an
 * existing directory inside `allowedRoots`; each returned document is re-checked after resolving
 * symbolic links, and documents outside the allowed roots are reported as `denied` without being read.
 */
export function resolveProjectDocs(
  cwd: string,
  allowedRoots: Set<string>,
  limit = DEFAULT_RECENT_RECORDS,
): ProjectDocShortcuts {
  const start = path.resolve(cwd);
  const handoffDir = ancestorsToRepositoryRoot(start, allowedRoots).find((dir) => isFile(path.join(dir, HANDOFF_FILE))) ?? null;
  const projectDir = handoffDir ?? start;
  const handoff = handoffDir
    ? entryFor(path.join(handoffDir, HANDOFF_FILE), allowedRoots)
    : { state: "missing" as const, path: null };
  const docMap = entryFor(path.join(projectDir, "doc", "README.md"), allowedRoots);

  const historyDir = path.join(projectDir, "doc", "history");
  let history: ProjectDocShortcuts["history"];
  if (!statOrNull(historyDir)?.isDirectory()) {
    history = { state: "missing", records: [] };
  } else if (!isExistingPathWithinRoots(historyDir, allowedRoots)) {
    history = { state: "denied", records: [] };
  } else {
    const records = recentRecords(historyDir, allowedRoots, limit);
    history = { state: records.length ? "found" : "missing", records };
  }

  return { projectDir, handoff, docMap, history };
}
