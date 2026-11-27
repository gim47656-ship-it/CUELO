import type { Element, Root } from "hast";

/** 1-based inclusive line range carried by a file link such as `file.ts#L10-L25` or `file.ts:10-25`. */
export interface FileLineRange {
  startLine: number;
  endLine: number;
}

/** Opens a local file in the side file viewer; `lines`, when given, is scrolled to and highlighted. */
export type OpenFileHandler = (filePath: string, lines?: FileLineRange) => void;

const COLON_LINE_SUFFIX = /:(-?\d+)(?:-(-?\d+)|:\d+)?$/;
const HASH_LINE_SUFFIX = /^L(-?\d+)(?:-L?(-?\d+))?$/;

// Bare filename locations look like URL schemes to the Markdown sanitizers.
// Only rewrite that shape; the regular URL and HTML checks still run afterwards.
export function rehypeFileLineLinks() {
  return (root: Root) => {
    function visit(node: Root | Element) {
      if (node.type === "element" && node.tagName === "a") {
        const href = node.properties.href;
        if (typeof href === "string") {
          const path = href.split(/[?#]/, 1)[0];
          const suffix = COLON_LINE_SUFFIX.exec(path);
          if (suffix && /^[^:/\\\s]+\.[^:/\\\s.]+$/.test(path.slice(0, suffix.index))) {
            node.properties.href = `./${href}`;
          }
        }
      }
      for (const child of node.children) {
        if (child.type === "element") visit(child);
      }
    }
    visit(root);
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function normalizeFilePathSlashes(filePath: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\")) {
    return filePath.replace(/\\/g, "/");
  }
  return filePath;
}

function stripLineSuffix(filePath: string): string {
  return filePath.replace(/:\d+(?::\d+)?$/, "");
}

function normalizeLocalPath(filePath: string): string {
  const normalized = normalizeFilePathSlashes(filePath);
  const isWindowsDrive = /^[a-zA-Z]:\//.test(normalized);
  const isUnc = normalized.startsWith("//");
  const leadingSlash = normalized.startsWith("/") && !isWindowsDrive && !isUnc;
  const parts: string[] = [];

  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!leadingSlash && !isWindowsDrive && !isUnc) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const joined = parts.join("/");
  if (isWindowsDrive) return joined;
  if (isUnc) return `//${joined}`;
  return leadingSlash ? `/${joined}` : joined;
}

function isPathInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizeLocalPath(candidate).replace(/\/+$/, "");
  const normalizedRoot = normalizeLocalPath(root).replace(/\/+$/, "");
  const useCaseInsensitive = /^[a-zA-Z]:\//.test(normalizedCandidate) || /^[a-zA-Z]:\//.test(normalizedRoot);
  const filePath = useCaseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate;
  const rootPath = useCaseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  return filePath === rootPath || filePath.startsWith(`${rootPath}/`);
}

function looksLikeRelativeFileHref(href: string): boolean {
  if (href.startsWith("#") || href.startsWith("?")) return false;
  if (href.startsWith("./") || href.startsWith("../")) return true;
  if (href.includes("/")) return true;
  return /(^|\/)\.?[^/]+\.[^/.]+$/.test(href);
}

function fileUrlToPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "file:") return null;
    const pathname = safeDecode(url.pathname);
    if (url.hostname) {
      return `//${url.hostname}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
    }
    if (/^\/[a-zA-Z]:\//.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return null;
  }
}

export function resolveLocalFileHref(
  href: string | undefined,
  baseDir?: string,
  relativeRoot = baseDir,
): string | null {
  if (!href) return null;

  const cleanHref = href.split("#", 1)[0].split("?", 1)[0].trim();
  if (!cleanHref) return null;

  let candidate: string | null = null;
  let candidateKind: "absolute" | "relative" | null = null;
  const decodedHref = safeDecode(cleanHref);
  const isBackslashUncPath = decodedHref.startsWith("\\\\");
  const normalizedHref = normalizeFilePathSlashes(decodedHref);
  const lowerHref = normalizedHref.toLowerCase();

  if (lowerHref.startsWith("/api/") || lowerHref.startsWith("/_next/")) return null;
  if (!isBackslashUncPath && normalizedHref.startsWith("//")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/i.test(normalizedHref) && !lowerHref.startsWith("file:") && !/^[a-zA-Z]:\//.test(normalizedHref)) {
    return null;
  }

  if (lowerHref.startsWith("file:")) {
    candidate = fileUrlToPath(normalizedHref);
    candidateKind = candidate ? "absolute" : null;
  } else if (/^[a-zA-Z]:\//.test(normalizedHref)) {
    candidate = normalizedHref;
    candidateKind = "absolute";
  } else if (normalizedHref.startsWith("/")) {
    candidate = normalizedHref;
    candidateKind = "absolute";
  } else if (baseDir && looksLikeRelativeFileHref(normalizedHref)) {
    candidate = `${normalizeFilePathSlashes(baseDir).replace(/\/+$/, "")}/${normalizedHref}`;
    candidateKind = "relative";
  }

  if (!candidate) return null;

  const filePath = stripLineSuffix(normalizeLocalPath(candidate));
  if (candidateKind === "relative" && relativeRoot && !isPathInside(filePath, relativeRoot)) return null;
  return filePath;
}

/** Resolve a Markdown file link while retaining a valid source line or range. */
export function resolveLocalFileLink(href: string | undefined, baseDir?: string, relativeRoot = baseDir) {
  if (!href) return null;

  const [reference, fragment] = href.trim().split("#", 2);
  const path = reference.split("?", 1)[0].trim();
  const colon = COLON_LINE_SUFFIX.exec(path);
  const hash = fragment === undefined ? null : HASH_LINE_SUFFIX.exec(fragment);
  const filePath = resolveLocalFileHref(colon ? path.slice(0, colon.index) : path, baseDir, relativeRoot);
  if (!filePath) return null;

  const location = hash ?? colon;
  if (!location) return { filePath };

  const start = Number(location[1]);
  const end = location[2] === undefined ? start : Number(location[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) return { filePath };

  return { filePath, lines: { startLine: Math.min(start, end), endLine: Math.max(start, end) } };
}

/** Resolve a filesystem path without applying URL or source-location syntax. */
export function resolveLocalFilePath(filePath: string | undefined, baseDir?: string): string | null {
  if (!filePath) return null;

  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(filePath) ||
    filePath.startsWith("\\\\") ||
    (baseDir !== undefined && (/^[a-zA-Z]:[\\/]/.test(baseDir) || baseDir.startsWith("\\\\")));
  const normalizeSlashes = (value: string) => windowsStyle ? value.replace(/\\/g, "/") : value;
  const normalizedPath = normalizeSlashes(filePath);
  const normalizedBase = baseDir ? normalizeSlashes(baseDir).replace(/\/+$/, "") : undefined;

  const isDriveAbsolute = /^[a-zA-Z]:\//.test(normalizedPath);
  const isUncAbsolute = normalizedPath.startsWith("//");
  let candidate: string;

  if (isDriveAbsolute || isUncAbsolute) {
    candidate = normalizedPath;
  } else if (normalizedPath.startsWith("/")) {
    const windowsRoot = normalizedBase?.match(/^([a-zA-Z]:)(?:\/|$)/)?.[1]
      ?? normalizedBase?.match(/^(\/\/[^/]+\/[^/]+)(?:\/|$)/)?.[1];
    candidate = windowsRoot ? `${windowsRoot}${normalizedPath}` : normalizedPath;
  } else {
    if (!normalizedBase) return null;
    candidate = `${normalizedBase}/${normalizedPath}`;
  }

  return normalizeLocalPath(candidate);
}
