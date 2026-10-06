import { readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getAdditionalAllowedRoots, normalizeSlashes } from "./allowed-roots";
import { isExistingPathWithinRoots } from "./path-security";
import { getAgentDir, listAllSessions } from "./session-reader";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";

// Short-TTL cache for the allowed-roots set. Without this, every file list/read
// request re-scans every pi session on disk just to check access. 5s is short
// enough that newly-created cwds appear promptly; stored on globalThis so it
// survives Next.js hot-reload.
declare global {
  var __ompAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __cueloLegacyPathMaps: Map<string, LegacyPathPrefix[]> | undefined;
}

const ALLOWED_ROOTS_TTL_MS = 5_000;
const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;
const LEGACY_PATH_MAP_FILE = "cuelo-legacy-paths.json";

/** One Windows path prefix and where its files live on this host. */
export interface LegacyPathPrefix {
  windows: string;
  local: string;
}

export function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

export async function getAllowedFileRoots(): Promise<Set<string>> {
  const now = Date.now();
  const cached = globalThis.__ompAllowedRootsCache;
  if (cached && cached.expiresAt > now) return cached.roots;

  const sessions = await listAllSessions();
  const roots = new Set<string>();
  for (const s of sessions) {
    if (s.cwd) roots.add(normalizeSlashes(s.cwd));
    // The project root (main repo shared by all worktrees) is browsable too —
    // the project dropdown lists it even when only worktrees have sessions.
    if (s.projectRoot) roots.add(normalizeSlashes(s.projectRoot));
  }

  // Also allow ~/omp-cwd-* directories created by the default-cwd endpoint.
  try {
    for (const name of readdirSync(homedir())) {
      if (/^omp-cwd-\d{8}$/.test(name)) {
        roots.add(normalizeSlashes(path.join(homedir(), name)));
      }
    }
  } catch {
    // ignore if home is unreadable
  }

  for (const root of getAdditionalAllowedRoots()) roots.add(root);

  globalThis.__ompAllowedRootsCache = { roots, expiresAt: now + ALLOWED_ROOTS_TTL_MS };
  return roots;
}

export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  for (const root of allowedRoots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) {
      return true;
    }
  }
  return false;
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}

function isLegacyPathPrefix(value: unknown): value is LegacyPathPrefix {
  const entry = value as Partial<LegacyPathPrefix> | null;
  return typeof entry?.windows === "string" && WINDOWS_ABSOLUTE_RE.test(entry.windows)
    && typeof entry.local === "string" && path.posix.isAbsolute(entry.local);
}

/**
 * Explicit Windows → local prefixes from `<agentDir>/cuelo-legacy-paths.json`, written by the WSL
 * profile migration (Tools/CUELO_Setup/wsl/migrate-profile.mjs). Transcripts from before the move keep
 * their Windows paths. Without the file nothing is mapped. Read once per process.
 */
export function readLegacyPathMap(agentDir = getAgentDir()): LegacyPathPrefix[] {
  const cache = (globalThis.__cueloLegacyPathMaps ??= new Map());
  const cached = cache.get(agentDir);
  if (cached) return cached;
  let prefixes: LegacyPathPrefix[] = [];
  try {
    const data = JSON.parse(readFileSync(path.join(agentDir, LEGACY_PATH_MAP_FILE), "utf8")) as { prefixes?: unknown } | null;
    if (Array.isArray(data?.prefixes)) prefixes = data.prefixes.filter(isLegacyPathPrefix);
  } catch {
    // Missing or unreadable: Windows paths stay as they are.
  }
  cache.set(agentDir, prefixes);
  return prefixes;
}

/**
 * Rewrite a drive-absolute Windows path through the longest matching prefix (case-insensitive, whole
 * segments, after `.`/`..` are collapsed so the result stays under the local prefix). Other paths and
 * unmatched Windows paths are returned unchanged; access checks run on the result as usual.
 */
export function mapLegacyWindowsPath(filePath: string, prefixes: LegacyPathPrefix[]): string {
  if (!prefixes.length || !WINDOWS_ABSOLUTE_RE.test(filePath)) return filePath;
  const segmentsOf = (value: string) => path.win32.normalize(value).split("\\").filter(Boolean);
  const segments = segmentsOf(filePath);
  const lower = segments.map((segment) => segment.toLowerCase());
  let best: { length: number; local: string } | null = null;
  for (const prefix of prefixes) {
    const prefixSegments = segmentsOf(prefix.windows).map((segment) => segment.toLowerCase());
    if (prefixSegments.length > lower.length || (best && prefixSegments.length <= best.length)) continue;
    if (prefixSegments.every((segment, index) => segment === lower[index])) {
      best = { length: prefixSegments.length, local: prefix.local };
    }
  }
  return best ? path.posix.join(best.local, ...segments.slice(best.length)) : filePath;
}
