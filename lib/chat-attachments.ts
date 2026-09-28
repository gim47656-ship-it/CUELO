import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFormDataWithinLimit, RequestBodyTooLargeError } from "./bounded-form-data";
import { MAX_STORED_ATTACHMENT_BYTES, getAudioMimeType, type StoredAttachment } from "./document-attachments";
import { MAX_TRANSCRIBE_AUDIO_BYTES } from "./audio-transcribe";
import { validateUploadFileNames } from "./file-upload";
import { isValidSessionId } from "./session-file-references-core";

/** Folder under the agent dir: `<agentDir>/cuelo-attachments/<sessionId | new>/<file>`. */
export const ATTACHMENTS_DIR_NAME = "cuelo-attachments";
const UNSENT_SESSION_FOLDER = "new";
/** Multipart boundaries and the small text fields around the one file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
const MAX_FILE_NAME_CHARS = 150;
const MAX_NAME_SUFFIX = 1000;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

export type TranscribeAudio = (audio: Uint8Array, mimeType: string, signal: AbortSignal) => Promise<string>;

/**
 * A Windows-safe name for a basename that already passed `validateUploadFileNames`: reserved
 * characters become `_`, trailing dots and spaces go, device names get a `_` prefix, and long
 * names keep their extension.
 */
export function toSafeAttachmentFileName(name: string): string {
  let safe = name.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
  if (!safe) return "attachment";
  const characters = Array.from(safe);
  if (characters.length > MAX_FILE_NAME_CHARS) {
    const extension = Array.from(path.extname(safe)).slice(0, 20).join("");
    safe = characters.slice(0, MAX_FILE_NAME_CHARS - extension.length).join("") + extension;
  }
  return WINDOWS_RESERVED_NAME.test(safe) ? `_${safe}` : safe;
}

/**
 * Writes the bytes as a new file in the session folder and returns its absolute path. Existing
 * files are never replaced: a taken name becomes `name (2).ext`, `name (3).ext`, and so on.
 */
export async function saveChatAttachment(
  root: string,
  sessionId: string | null,
  fileName: string,
  bytes: Uint8Array,
): Promise<string> {
  // Session ids match case-insensitively; one lowercase folder keeps the realpath check exact on Windows.
  const folder = (sessionId ?? UNSENT_SESSION_FOLDER).toLowerCase();
  await mkdir(root, { recursive: true });
  const realRoot = await realpath(root);
  const directory = path.join(realRoot, folder);
  await mkdir(directory, { recursive: true });
  // A junction or symlink planted at the session folder must not redirect the write.
  if (path.relative(realRoot, await realpath(directory)) !== folder) {
    throw new Error("Attachment folder resolves outside the attachment root");
  }

  const safeName = toSafeAttachmentFileName(fileName);
  const extension = path.extname(safeName);
  const stem = safeName.slice(0, safeName.length - extension.length);
  for (let index = 1; index <= MAX_NAME_SUFFIX; index += 1) {
    const target = path.join(directory, index === 1 ? safeName : `${stem} (${index})${extension}`);
    try {
      await writeFile(target, bytes, { flag: "wx" });
      return target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`Too many attachments named ${safeName}`);
}

function errorResponse(status: number, code: string, error: string): Response {
  return Response.json({ code, error }, { status });
}

/**
 * `POST /api/attachments` after the request-origin check: one multipart `file` plus an optional
 * `sessionId`. Saves the file and, for audio, adds the transcript or the reason there is none.
 */
export async function handleAttachmentUpload(
  request: Request,
  { root, transcribe }: { root: string; transcribe: TranscribeAudio },
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
    return errorResponse(415, "unsupported", "multipart/form-data body required");
  }
  let form: FormData;
  try {
    form = await parseFormDataWithinLimit(request, MAX_STORED_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return errorResponse(413, "file_too_large", "Attachments must be 25MB or smaller");
    }
    return errorResponse(400, "invalid_form", "Malformed multipart body");
  }

  const file = form.get("file");
  if (!file || typeof file === "string") return errorResponse(400, "missing_file", "file is required");
  if (file.size > MAX_STORED_ATTACHMENT_BYTES) {
    return errorResponse(413, "file_too_large", "Attachments must be 25MB or smaller");
  }
  const nameError = validateUploadFileNames([file.name]);
  if (nameError) return errorResponse(400, "invalid_name", nameError);
  const sessionField = form.get("sessionId");
  const sessionId = typeof sessionField === "string" && sessionField ? sessionField : null;
  if (sessionId !== null && !isValidSessionId(sessionId)) {
    return errorResponse(400, "invalid_session", "Invalid session id");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const savedPath = await saveChatAttachment(root, sessionId, file.name, bytes);
  const audioMimeType = getAudioMimeType(file);
  const result: StoredAttachment = {
    path: savedPath,
    size: bytes.byteLength,
    mimeType: audioMimeType ?? (file.type || "application/octet-stream"),
  };
  if (audioMimeType) {
    if (bytes.byteLength > MAX_TRANSCRIBE_AUDIO_BYTES) {
      result.transcriptError = `audio is larger than the ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024} MB transcription limit`;
    } else {
      try {
        result.transcript = await transcribe(bytes, audioMimeType, request.signal);
      } catch (error) {
        result.transcriptError = error instanceof Error ? error.message : String(error);
      }
    }
  }
  return Response.json(result);
}
