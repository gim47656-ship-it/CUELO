import { randomUUID } from "node:crypto";
import { attachmentUploadLimitBytes, type AttachmentSettings } from "./attachment-settings";
import type { AttachmentStore } from "./attachment-store";
import { MultipartFormError, UploadTooLargeError, receiveMultipartUpload } from "./attachment-upload-stream";
import { getAudioMimeType, isAttachmentDraftId, type UploadedAttachment } from "./document-attachments";
import { validateUploadFileNames } from "./file-upload";
import { isValidSessionId } from "./session-file-references-core";

/** Multipart boundaries and the small text fields around the one file. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function errorResponse(status: number, code: string, error: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ code, error, ...extra }, { status });
}

function tooLarge(limitBytes: number): Response {
  return errorResponse(413, "file_too_large", `Attachments must be ${limitBytes / 1024 / 1024}MB or smaller`, { limitBytes });
}

function declaredContentLength(request: Request): number | null {
  const value = request.headers.get("content-length");
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * `POST /api/attachments` after the request guard: one multipart `file` plus optional `sessionId`
 * and `draftId`. The file streams to disk under the configured size limit and becomes a managed
 * attachment held by the draft (a new draft id is issued when none is sent). Uploads only store;
 * audio is transcribed through `/api/attachments/<id>/transcription`.
 */
export async function handleAttachmentUpload(
  request: Request,
  { store, settings }: { store: AttachmentStore; settings: AttachmentSettings },
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "multipart/form-data") {
    return errorResponse(415, "unsupported", "multipart/form-data body required");
  }
  const limitBytes = attachmentUploadLimitBytes(settings);
  const declared = declaredContentLength(request);
  if (declared !== null && declared > limitBytes + MULTIPART_OVERHEAD_BYTES) {
    await request.body?.cancel().catch(() => {});
    return tooLarge(limitBytes);
  }

  const upload = await store.beginUpload();
  let committed = false;
  try {
    let received;
    try {
      received = await receiveMultipartUpload(request, { stagingPath: upload.stagingPath, maxFileBytes: limitBytes });
    } catch (error) {
      if (error instanceof UploadTooLargeError) return tooLarge(limitBytes);
      if (error instanceof MultipartFormError) return errorResponse(400, "invalid_form", "Malformed multipart body");
      // The client went away mid-upload; nobody reads this reply.
      if (request.signal.aborted) return errorResponse(400, "aborted", "Upload aborted");
      throw error;
    }

    const { file, fields } = received;
    if (!file) return errorResponse(400, "missing_file", "file is required");
    const nameError = validateUploadFileNames([file.fileName]);
    if (nameError) return errorResponse(400, "invalid_name", nameError);
    const sessionId = fields.get("sessionId") || null;
    if (sessionId !== null && !isValidSessionId(sessionId)) {
      return errorResponse(400, "invalid_session", "Invalid session id");
    }
    const draftField = fields.get("draftId");
    if (draftField && !isAttachmentDraftId(draftField)) {
      return errorResponse(400, "invalid_draft", "Invalid draft id");
    }
    const draftId = (draftField || randomUUID()).toLowerCase();

    const record = await store.commitUpload({
      id: upload.id,
      stagingPath: upload.stagingPath,
      sessionId,
      draftId,
      fileName: file.fileName,
      size: file.size,
      mimeType: getAudioMimeType({ name: file.fileName, type: file.contentType }) ?? (file.contentType || "application/octet-stream"),
    });
    committed = true;
    const result: UploadedAttachment = { id: record.id, draftId, path: record.path, size: record.size, mimeType: record.mimeType };
    return Response.json(result);
  } finally {
    // A rejected or failed upload leaves no staged bytes behind; a committed one has moved them.
    if (!committed) await store.discardStagedUpload(upload.stagingPath);
    await upload.release();
  }
}
