import { realpathSync } from "fs";
import path from "path";

const WINDOWS_ABSOLUTE_RE = /^[a-zA-Z]:[\\/]/;

function isWindowsAbsolutePath(filePath: string): boolean {
  return WINDOWS_ABSOLUTE_RE.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("//");
}

function isPathWithinRoot(target: string, root: string): boolean {
  const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
  const resolver = useWindowsRules ? path.win32 : path;
  const sep = useWindowsRules ? "\\" : path.sep;
  const normalized = resolver.resolve(target);
  const normalizedRoot = resolver.resolve(root);
  const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
  const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
  const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparable === comparableRoot || comparable.startsWith(rootWithSep);
}

export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    if (isPathWithinRoot(target, root)) return true;
  }
  return false;
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }

  // Try lexical ancestors first, but authorize only their freshly resolved paths.
  // The second pass retains roots reached through aliases/symlinks. No realpath
  // is cached: retargeting or removing a root must affect the next request.
  for (let pass = 0; pass < 2; pass++) {
    for (const root of roots) {
      if (isPathWithinRoot(target, root) !== (pass === 0)) continue;
      try {
        if (isPathWithinRoot(realTarget, realpathSync(root))) return true;
      } catch {
        // Ignore stale roots derived from removed sessions or worktrees.
      }
    }
  }
  return false;
}
