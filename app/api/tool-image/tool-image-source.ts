import { readFileSync, statSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import { toolCommandDispatches } from "@oh-my-pi/pi-coding-agent/tools/tool-commands";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { isExistingPathWithinRoots } from "@/lib/path-security";
import { IMAGE_PREVIEW_MAX_BYTES, getImageMime } from "@/lib/file-types";
import type { SessionEntry, ToolResultMessage } from "@/lib/types";

/**
 * 대화창 썸네일이 가리킬 수 있는 이미지의 출처. 세션 기록의 그 도구 결과에 실제로 나온 것만
 * 목록에 오른다 — 임의 경로를 받아 여는 길은 없다.
 *
 * - `data`: 도구 결과 content 의 base64 image 블록(`read` 이미지 등). 세션 로더가 blob 참조를
 *   이미 풀어 둔 값이다.
 * - `file`: `generate_image` 가 임시 폴더에 쓴 결과 파일. 직접 호출은 `details.imagePaths`,
 *   xd:// 장치 호출은 `details.xdev.inner.imagePaths` 에 남는다(코어 `tools/image-gen.ts`).
 */
export type ToolImageSource =
  | { kind: "data"; data: string }
  | { kind: "file"; path: string };

export type ToolImageBody =
  | { ok: true; bytes: Buffer; mime: string }
  | { ok: false; status: 404 | 413 | 415; error: string };

/**
 * 세션의 그 도구 결과. 세션이 없으면 `null`, 도구 결과가 없으면 `undefined`. 살아 있는 세션은
 * 메모리의 기록을, 아니면 저장된 파일을 읽는다(`app/api/sessions/[id]/route.ts` 와 같은 순서).
 */
export async function findToolResult(sessionId: string, toolCallId: string): Promise<ToolResultMessage | null | undefined> {
  const rpc = getRpcSession(sessionId);
  let entries: readonly SessionEntry[];
  if (rpc?.isAlive()) {
    entries = rpc.inner.sessionManager.getEntries() as unknown as SessionEntry[];
  } else {
    const filePath = await resolveSessionPath(sessionId);
    if (!filePath) return null;
    entries = (await SessionManager.open(filePath)).getEntries() as unknown as SessionEntry[];
  }
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId) {
      return entry.message;
    }
  }
  return undefined;
}

function imagePathsOf(details: unknown): string[] {
  if (typeof details !== "object" || details === null || !("imagePaths" in details) || !Array.isArray(details.imagePaths)) {
    return [];
  }
  return details.imagePaths.filter((value): value is string => typeof value === "string");
}

/** 이 도구 결과가 대화창에 내놓는 이미지. 순서가 곧 `index` 다. */
export function toolImageSources(result: ToolResultMessage): ToolImageSource[] {
  const details = result.details;
  const xdev = typeof details === "object" && details !== null && "xdev" in details ? details.xdev : undefined;
  const commands = result.toolName === "bash" ? toolCommandDispatches("bash", result) : [];
  const commandPaths = commands.flatMap(({ tool, mode, exitCode, inner }) =>
    tool === "generate_image" && mode === "execute" && exitCode === 0 ? imagePathsOf(inner) : []);
  const generated = result.toolName === "generate_image"
    ? imagePathsOf(details)
    : typeof xdev === "object" && xdev !== null && "tool" in xdev && xdev.tool === "generate_image" && "inner" in xdev
      ? imagePathsOf(xdev.inner)
      : [];
  const sources: ToolImageSource[] = [];
  let imageIndex = 0;
  // Bash merges unrelated images. Match the resolved content to the core's
  // content-addressed filename rather than guessing which command emitted it.
  const attached = commandPaths.length > 0 ? new Map<string, number>() : undefined;
  for (const block of result.content ?? []) {
    if (block.type !== "image") continue;
    const imagePath = generated[imageIndex++];
    // A resolved attachment and its on-disk copy occupy the same image slot.
    const data = "data" in block && typeof block.data === "string"
      ? block.data
      : block.source?.type === "base64" ? block.source.data : undefined;
    if (data && !data.startsWith("blob:")) {
      sources.push({ kind: "data", data });
      if (attached && Math.floor(data.length * 3 / 4) <= IMAGE_PREVIEW_MAX_BYTES + 3) {
        const key = Bun.hash(Buffer.from(data, "base64")).toString(16);
        attached.set(key, (attached.get(key) ?? 0) + 1);
      }
    } else if (imagePath) sources.push({ kind: "file", path: imagePath });
  }
  for (const imagePath of generated.slice(imageIndex)) sources.push({ kind: "file", path: imagePath });
  for (const imagePath of commandPaths) {
    const key = /^omp-image-([0-9a-f]+)\./.exec(path.basename(imagePath))?.[1];
    const matching = key === undefined ? 0 : attached?.get(key) ?? 0;
    if (attached && key !== undefined && matching > 0) attached.set(key, matching - 1);
    else sources.push({ kind: "file", path: imagePath });
  }
  return sources;
}

/** 실제 바이트가 어떤 그림인지. SVG 처럼 스크립트를 담을 수 있는 형식은 받지 않는다. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  return null;
}

/** `generate_image` uses this filename family for both historical IDs and content hashes. */
const GENERATED_IMAGE_NAME = /^omp-image-[A-Za-z0-9]+\.(?:png|jpe?g|gif|webp)$/i;
const NOT_FOUND: ToolImageBody = { ok: false, status: 404, error: "Image not found" };

export function readToolImage(source: ToolImageSource): ToolImageBody {
  if (source.kind === "data") {
    // base64 네 글자가 세 바이트다. 풀기 전에 크기를 막는다.
    if (Math.floor(source.data.length * 3 / 4) > IMAGE_PREVIEW_MAX_BYTES + 3) {
      return { ok: false, status: 413, error: "Image too large" };
    }
    const bytes = Buffer.from(source.data, "base64");
    const mime = sniffImageMime(bytes);
    return mime ? { ok: true, bytes, mime } : { ok: false, status: 415, error: "Not an image" };
  }

  // 기록에 적힌 경로라도 임시 폴더 안의 그 이름 결과 파일이 아니면 열지 않는다. 링크로 밖을
  // 가리키는 경우는 실경로 비교가 막는다.
  const imagePath = source.path;
  if (!path.isAbsolute(imagePath) || !GENERATED_IMAGE_NAME.test(path.basename(imagePath))) return NOT_FOUND;
  if (!isExistingPathWithinRoots(imagePath, new Set([tmpdir()]))) return NOT_FOUND;
  const stat = statSync(imagePath);
  if (!stat.isFile()) return NOT_FOUND;
  if (stat.size > IMAGE_PREVIEW_MAX_BYTES) return { ok: false, status: 413, error: "Image too large" };
  const bytes = readFileSync(imagePath);
  const mime = sniffImageMime(bytes);
  // 확장자와 실제 바이트가 같은 형식이어야 한다.
  if (!mime || mime !== getImageMime(imagePath)) return { ok: false, status: 415, error: "Not an image" };
  return { ok: true, bytes, mime };
}
