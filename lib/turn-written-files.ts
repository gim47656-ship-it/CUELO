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
 * source here; the tool call is the record of what happened.
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

    const rawPath = readToolPath(block.input);
    if (!rawPath || !isFilesystemPathLiteral(rawPath)) continue;

    // Tool arguments are filesystem paths, not hrefs: preserve characters such
    // as #, ?, and :digits that have special meaning in links and source refs.
    const filePath = resolveLocalFilePath(rawPath, cwd);
    if (!filePath) continue;

    if (seen.has(filePath)) continue;
    seen.add(filePath);
    writtenFiles.push({ filePath });
  }

  return writtenFiles;
}
