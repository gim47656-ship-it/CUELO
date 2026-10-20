import type { AssistantContentBlock, ToolResultMessage } from "./types";
import { resolveLocalFilePath } from "./file-links";
import { isEditToolName, isWriteToolName } from "./tool-names";

export interface WrittenFile {
  /** Resolved absolute path of a file this turn wrote. */
  filePath: string;
}

function isFileWritingToolName(toolName: string): boolean {
  return isWriteToolName(toolName) || isEditToolName(toolName);
}

function readToolPath(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  const value = input.file_path ?? input.path;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readResultPath(entry: unknown, includeDeleted: boolean): string | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (record.op === "delete" && !includeDeleted) return null;
  const value = record.path ?? record.resolvedPath;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The paths a write/edit call wrote. A path argument wins; the hashline `edit` carries its targets
 * only inside `input` text, so its result `details` (`path`, or `perFileResults[].path` for a
 * multi-file edit) is the record of what was written. Files the edit deleted are listed only with
 * `includeDeleted`.
 */
function readWrittenPaths(input: Record<string, unknown> | undefined, result: ToolResultMessage, includeDeleted = false): string[] {
  const details = result.details as Record<string, unknown> | undefined;
  const argument = readToolPath(input);
  if (argument) return !includeDeleted && details && typeof details === "object" && details.op === "delete" ? [] : [argument];
  if (!details || typeof details !== "object") return [];
  if (Array.isArray(details.perFileResults)) {
    return details.perFileResults.map((entry) => readResultPath(entry, includeDeleted)).filter((path): path is string => path !== null);
  }
  const single = readResultPath(details, includeDeleted);
  return single ? [single] : [];
}

/**
 * Every path a write/edit call touched, deleted files included, as the raw tool path. Before the result
 * arrives only a path argument is known (a hashline edit in flight names none). Scheme targets are left out.
 */
function readTouchedPaths(input: Record<string, unknown> | undefined, result: ToolResultMessage | undefined): string[] {
  const argument = readToolPath(input);
  const paths = result ? readWrittenPaths(input, result, true) : argument ? [argument] : [];
  return paths.filter(isFilesystemPathLiteral);
}

/**
 * A write/edit call whose every touched path is scratch (`isScratchPath`): an investigation artifact, not a
 * change to the work. A call that names no path yet (a hashline edit still in flight) is not.
 */
export function isScratchOnlyWrite(input: Record<string, unknown> | undefined, result: ToolResultMessage | undefined, cwd?: string): boolean {
  const paths = readTouchedPaths(input, result);
  return paths.length > 0 && paths.every((path) => isScratchPath(path, cwd));
}

/**
 * What the omp core loads from a `.omp/` folder, so writing there is configuration, not scratch
 * (`@oh-my-pi/pi-coding-agent` 18.12.3 discovery; sources in the work record). A user profile is
 * `.omp/agent/` or `.omp/profiles/<name>/agent/`, read whole. `.omp/wt/` holds the agent-managed
 * worktrees (task isolation, PR checkouts), which are the work itself.
 */
const OMP_CONFIG_ENTRIES = [
  "skills", "commands", "rules", "prompts", "extensions", "instructions", "hooks", "tools", "agents", "plugins",
  "mcp.json", ".mcp.json", "SYSTEM.md", "SYSTEM_TEMPLATE.md", "APPEND_SYSTEM.md", "AGENTS.md", "settings.json", "config.yml", "secrets.yml",
];
const OMP_CONFIG_BY_LOWER = new Map(OMP_CONFIG_ENTRIES.map((name) => [name.toLowerCase(), name]));

/** OS temp folders: POSIX and macOS `os.tmpdir()`, and Windows temp folders on a drive or under WSL `/mnt/<x>`. */
const TEMP_FOLDERS = [
  /^\/(?:private\/)?(?:var\/)?tmp(?:\/|$)/,
  /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/,
  /^(?:[a-z]:|\/mnt\/[a-z])\/(?:windows\/)?temp(?:\/|$)/i,
  /^(?:[a-z]:|\/mnt\/[a-z])\/users\/[^/]+\/appdata\/local\/temp(?:\/|$)/i,
];

/** Under the first `.omp` segment, anything but omp configuration is scratch. */
function isOmpScratch(segments: readonly string[], caseless: boolean): boolean {
  const same = (segment: string | undefined, name: string) => segment !== undefined && (caseless ? segment.toLowerCase() === name : segment === name);
  const at = segments.findIndex((segment) => same(segment, ".omp"));
  if (at < 0 || at === segments.length - 1) return false;
  const next = segments[at + 1];
  if (same(next, "agent") || same(next, "wt") || (same(next, "profiles") && same(segments[at + 3], "agent"))) return false;
  const config = OMP_CONFIG_BY_LOWER.get(next.toLowerCase());
  return !(config !== undefined && (caseless || config === next));
}

/**
 * Whether a write lands in a scratch location rather than in the work: a `.omp` folder other than omp
 * configuration, or an OS temp folder. Decided from the path alone. Inside the session cwd only the part
 * below cwd counts, so a session working in a temp folder or in `~/.omp/agent` keeps its own files;
 * a relative path with no known cwd is read as inside it.
 */
function isScratchPath(rawPath: string, cwd?: string): boolean {
  const resolved = resolveLocalFilePath(rawPath, cwd);
  const base = cwd ? resolveLocalFilePath(cwd)?.replace(/\/+$/, "") : undefined;
  const subject = resolved ?? rawPath.replace(/\\/g, "/");
  const caseless = /^(?:[a-zA-Z]:\/|\/\/|\/mnt\/[a-zA-Z](?:\/|$))/.test(subject) || (base !== undefined && /^(?:[a-zA-Z]:\/|\/\/)/.test(base));
  const fold = (value: string) => (caseless ? value.toLowerCase() : value);
  const inside = resolved === null || (base !== undefined && (fold(resolved) === fold(base) || fold(resolved).startsWith(`${fold(base)}/`)));
  const own = resolved !== null && inside && base !== undefined ? resolved.slice(base.length) : subject;
  if (isOmpScratch(own.split("/").filter((segment) => segment !== "" && segment !== "."), caseless)) return true;
  return !inside && TEMP_FOLDERS.some((folder) => folder.test(subject));
}

/**
 * 도구의 path 인자는 파일시스템 리터럴이다. `xd://recall` 같은 내부/디바이스 URI를
 * 상대경로로 resolve하면 실제로는 없는 파일이 "Files changed"에 올라 열기가 Not found로
 * 끝나므로 `scheme://` 형태만 후보에서 뺀다. `report.md:42`나 `C:\…`처럼 콜론을 쓰는
 * 실제 파일명·드라이브 경로는 스킴이 아니므로 그대로 둔다.
 */
function isFilesystemPathLiteral(value: string): boolean {
  // `C:\…`·`C://…` 같은 드라이브 절대경로는 스킴이 아니다 — 기존 resolve가 정규화하던
  // 경로를 먼저 보존하고, 그 다음에 `scheme://` 형태만 걸러낸다.
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}
/**
 * Collect the distinct files a single assistant turn actually wrote.
 *
 * Every entry is derived from a `write`/`edit` tool call whose result arrived
 * and did not error — never from the reply text. A path the assistant merely
 * mentions in prose is not evidence that any file was touched, so it is not a
 * source here; the tool call is the record of what happened. Scratch writes
 * (`isScratchPath`) are not changes to the work and are left out.
 *
 * Paths are resolved against `cwd`, deduped, and kept in first-seen order.
 */
export function extractTurnWrittenFiles(
  content: AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  cwd?: string,
): WrittenFile[] {
  const seen = new Set<string>();
  const writtenFiles: WrittenFile[] = [];

  for (const block of content) {
    if (block.type !== "toolCall") continue;
    if (!isFileWritingToolName(block.toolName)) continue;

    // No result yet (still streaming) or the call failed — nothing was written.
    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;

    for (const rawPath of readWrittenPaths(block.input, result)) {
      if (!isFilesystemPathLiteral(rawPath)) continue;

      // Tool arguments are filesystem paths, not hrefs: preserve characters such
      // as #, ?, and :digits that have special meaning in links and source refs.
      const filePath = resolveLocalFilePath(rawPath, cwd);
      if (!filePath || isScratchPath(rawPath, cwd)) continue;

      if (seen.has(filePath)) continue;
      seen.add(filePath);
      writtenFiles.push({ filePath });
    }
  }

  return writtenFiles;
}
