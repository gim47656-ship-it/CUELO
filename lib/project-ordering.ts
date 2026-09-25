export interface ProjectOrderEntry {
  key: string;
  order?: number;
  path?: string;
}

/**
 * Normalize a project path for registry lookups without touching the file
 * system. Windows drive and UNC paths are case-insensitive; POSIX paths keep
 * their case. Both slash styles produce the same key.
 */
export function normalizeProjectKey(project: string): string {
  let normalized = project.trim().replace(/\\/g, "/");
  const unc = normalized.startsWith("//");
  normalized = unc
    ? `//${normalized.slice(2).replace(/\/{2,}/g, "/")}`
    : normalized.replace(/\/{2,}/g, "/");

  const isRoot = normalized === "/" || /^[a-zA-Z]:\/$/.test(normalized);
  if (!isRoot) normalized = normalized.replace(/\/+$/, "");

  return /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** A session's project identity and how recently it was touched. */
export interface ProjectPathCandidate {
  cwd: string;
  projectRoot?: string | null;
  modified: string;
}

/**
 * The parent path of a project folder — the part that tells two folders with
 * the same name apart. A drive or filesystem root has no parent, and neither
 * has a bare folder name, so both answer with an empty string.
 */
export function projectParentPath(project: string): string {
  const trimmed = project.trim().replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return cut <= 0 ? "" : trimmed.slice(0, cut);
}

/**
 * The displayed names that more than one project claims. A row whose name is in
 * this set is drawn with its parent path, because the name alone would not tell
 * the two folders apart. Names compare case-insensitively — two rows that read
 * the same have to be told apart the same way on every platform.
 */
export function ambiguousProjectNames(names: readonly string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const name of names) {
    const key = name.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
}

/**
 * The distinct projects of a session list, most recent activity first.
 *
 * Identity is the normalized path, not the raw string: the same folder reaches
 * the list as `V:\Projects\Tools` from one session and `V:/Projects/Tools` from
 * another, and the sidebar has to draw one row for it. The row keeps the
 * spelling of the project's most recent session, so the path the user sees
 * stays the one the newest session recorded.
 */
export function recentProjectPaths(sessions: readonly ProjectPathCandidate[]): string[] {
  const latestByKey = new Map<string, { project: string; modified: string }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const key = normalizeProjectKey(root);
    const previous = latestByKey.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByKey.set(key, { project: root, modified: session.modified });
    }
  }
  return [...latestByKey.values()]
    .sort((left, right) => right.modified.localeCompare(left.modified))
    .map((entry) => entry.project);
}

/**
 * Merge registry-only projects into the caller's existing project list, then
 * place explicitly ordered projects first. Projects without a manual position
 * retain their existing relative order.
 */
export function mergeProjectOrder(
  projects: readonly string[],
  registryEntries: readonly ProjectOrderEntry[],
): string[] {
  const orderByKey = new Map<string, number>();
  for (const entry of registryEntries) {
    if (typeof entry.order === "number" && Number.isFinite(entry.order)) {
      orderByKey.set(normalizeProjectKey(entry.key), entry.order);
    }
  }

  const mergedProjects = [...projects];
  const knownKeys = new Set(projects.map(normalizeProjectKey));
  for (const entry of registryEntries) {
    const key = normalizeProjectKey(entry.key);
    if (!key || knownKeys.has(key)) continue;
    mergedProjects.push(entry.path ?? entry.key);
    knownKeys.add(key);
  }

  return mergedProjects
    .map((project, defaultIndex) => ({
      project,
      defaultIndex,
      order: orderByKey.get(normalizeProjectKey(project)),
    }))
    .sort((left, right) => {
      const leftManual = left.order !== undefined;
      const rightManual = right.order !== undefined;
      if (leftManual !== rightManual) return leftManual ? -1 : 1;
      if (leftManual && rightManual && left.order !== right.order) {
        return left.order! - right.order!;
      }
      return left.defaultIndex - right.defaultIndex;
    })
    .map(({ project }) => project);
}
