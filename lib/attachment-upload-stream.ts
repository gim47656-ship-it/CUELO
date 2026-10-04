import busboy from "busboy";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";

/**
 * Streaming `multipart/form-data` reader for one uploaded file plus a few short text fields.
 * busboy parses the wire format; the file part is piped to a staging file with backpressure,
 * so an upload never sits in memory whole.
 */

const MAX_FIELD_BYTES = 4 * 1024;
const MAX_FIELDS = 8;
const MAX_PARTS = 16;

export class MultipartFormError extends Error {}

export class UploadTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super(`Upload exceeds ${limitBytes} bytes`);
  }
}

export interface StreamedFilePart {
  fileName: string;
  contentType: string;
  size: number;
}

export interface StreamedUpload {
  fields: Map<string, string>;
  /** Null when the body had no `fileField` part; the staging file then does not exist. */
  file: StreamedFilePart | null;
}

/**
 * Reads the whole body, writing the `fileField` part to `stagingPath` (created exclusively) and
 * collecting the other parts as text. On any failure, including a file over `maxFileBytes` or an
 * aborted request, the staging file is removed before the error propagates.
 */
export async function receiveMultipartUpload(
  request: Request,
  { stagingPath, maxFileBytes, fileField = "file" }: { stagingPath: string; maxFileBytes: number; fileField?: string },
): Promise<StreamedUpload> {
  if (!request.body) throw new MultipartFormError("Request has no body");
  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      // Browsers send the file name as raw UTF-8; busboy's default would read it as latin1.
      defParamCharset: "utf8",
      // Keep the name exactly as sent so `validateUploadFileNames` can refuse path components.
      preservePath: true,
      // busboy emits `limit` on reaching fileSize, so one byte past the cap marks an oversized file.
      limits: { files: 1, fileSize: maxFileBytes + 1, fields: MAX_FIELDS, fieldSize: MAX_FIELD_BYTES, parts: MAX_PARTS },
    });
  } catch (error) {
    throw new MultipartFormError(error instanceof Error ? error.message : String(error));
  }

  // The DOM and `node:stream/web` declarations of the same runtime stream do not unify.
  const source = Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>);
  const fields = new Map<string, string>();
  let file: StreamedFilePart | null = null;
  let fileWrite: Promise<void> | null = null;
  let failure: Error | null = null;
  const parsed = Promise.withResolvers<void>();
  // Settled from events, not from `pipeline(source, parser)`: under Bun that promise can stay
  // pending forever when the source is destroyed after its web stream already closed.
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    source.unpipe(parser);
    // Stop reading the request, and end the open file stream with the error.
    source.destroy();
    parser.destroy(error);
    parsed.reject(error);
  };

  parser.on("field", (name, value, info) => {
    if (info.nameTruncated || info.valueTruncated) fail(new MultipartFormError(`Field ${name} is too long`));
    else fields.set(name, value);
  });
  parser.on("file", (name, stream, info) => {
    if (name !== fileField || fileWrite) {
      // Destroying the parser errors its open file stream; a drained one has no other listener.
      stream.on("error", () => {});
      stream.resume();
      fail(new MultipartFormError(`Unexpected file part ${name}`));
      return;
    }
    stream.on("limit", () => fail(new UploadTooLargeError(maxFileBytes)));
    const target = createWriteStream(stagingPath, { flags: "wx", mode: 0o600 });
    fileWrite = pipeline(stream, target).then(() => {
      if (!stream.truncated) file = { fileName: info.filename ?? "", contentType: info.mimeType, size: target.bytesWritten };
    });
    fileWrite.catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  });
  parser.on("filesLimit", () => fail(new MultipartFormError("Only one file part is allowed")));
  parser.on("fieldsLimit", () => fail(new MultipartFormError("Too many fields")));
  parser.on("partsLimit", () => fail(new MultipartFormError("Too many parts")));
  // busboy reports malformed or truncated bodies ("Unexpected end of form", "Malformed part header") as errors.
  parser.on("error", (error: Error) => fail(failure ? error : new MultipartFormError(error.message)));
  parser.on("finish", () => parsed.resolve());
  // A body stream that errors is a cut-off request (client abort), not a malformed form.
  source.on("error", (error: Error) => fail(error));
  source.pipe(parser);

  try {
    await parsed.promise;
    // The staging file is complete only once its write stream has flushed and closed.
    await (fileWrite as Promise<void> | null)?.catch(() => {});
    if (failure) throw failure;
    return { fields, file };
  } catch (error) {
    // Windows refuses to unlink a file whose write stream is still open, so wait for it first.
    await (fileWrite as Promise<void> | null)?.catch(() => {});
    if (fileWrite) await unlink(stagingPath).catch(() => {});
    throw error;
  }
}
