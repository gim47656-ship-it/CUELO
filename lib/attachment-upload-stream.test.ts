import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MultipartFormError, UploadTooLargeError, receiveMultipartUpload } from "./attachment-upload-stream";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stagingPath(): string {
  const root = mkdtempSync(join(tmpdir(), "cuelo-upload-stream-"));
  roots.push(root);
  return join(root, "upload.part");
}

/** A browser-encoded multipart body, so the parser is checked against the real wire format. */
async function encode(form: FormData): Promise<{ bytes: Uint8Array; contentType: string }> {
  const request = new Request("http://127.0.0.1/", { method: "POST", body: form });
  // Bun fills the generated multipart content type in lazily; read it before the body.
  const contentType = request.headers.get("content-type") ?? "";
  return { bytes: new Uint8Array(await request.arrayBuffer()), contentType };
}

function requestOf(body: ReadableStream<Uint8Array>, contentType: string): Request {
  return new Request("http://127.0.0.1/api/attachments", {
    method: "POST",
    body,
    headers: { "content-type": contentType },
    duplex: "half",
  } as RequestInit);
}

function streamOf(bytes: Uint8Array, chunkSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}

test("reads the file and the text fields whatever the chunk boundaries are", async () => {
  // Bytes that look like a delimiter prefix must stay part of the file.
  const content = new Uint8Array([...new TextEncoder().encode("a\r\n--\r\n-"), 0, 255, 13, 10, 45, 45]);
  const form = new FormData();
  form.append("sessionId", "550e8400-e29b-41d4-a716-446655440000");
  form.append("file", new File([content], "회의 메모 (1).m4a", { type: "audio/mp4" }));
  form.append("draftId", "6f1c2d1e-8b8a-4b44-9f5e-2f8f0b1c2d3e");
  const { bytes, contentType } = await encode(form);

  for (const chunkSize of [1, 3, 7, 64, bytes.byteLength]) {
    const target = stagingPath();
    const result = await receiveMultipartUpload(requestOf(streamOf(bytes, chunkSize), contentType), { stagingPath: target, maxFileBytes: 1024 });
    expect(result.file).toEqual({ fileName: "회의 메모 (1).m4a", contentType: "audio/mp4", size: content.byteLength });
    expect(result.fields.get("sessionId")).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(result.fields.get("draftId")).toBe("6f1c2d1e-8b8a-4b44-9f5e-2f8f0b1c2d3e");
    expect(new Uint8Array(readFileSync(target))).toEqual(content);
  }
});

test("accepts a file of exactly the limit and removes the staging file one byte past it", async () => {
  const exact = new FormData();
  exact.append("file", new File([new Uint8Array(4096)], "a.bin"));
  const fits = await encode(exact);
  const result = await receiveMultipartUpload(requestOf(streamOf(fits.bytes, 1000), fits.contentType), { stagingPath: stagingPath(), maxFileBytes: 4096 });
  expect(result.file?.size).toBe(4096);

  const over = new FormData();
  over.append("file", new File([new Uint8Array(4097)], "a.bin"));
  const tooBig = await encode(over);
  const overTarget = stagingPath();
  const error = await receiveMultipartUpload(requestOf(streamOf(tooBig.bytes, 1000), tooBig.contentType), { stagingPath: overTarget, maxFileBytes: 4096 })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UploadTooLargeError);
  expect(existsSync(overTarget)).toBe(false);
});

test("answers promptly when the limit is crossed by the last file byte of a streamed body", async () => {
  // Regression: crossing the limit in the final chunk, after the body stream had already closed,
  // left the upload pending forever.
  const boundary = "----limitBoundary";
  const head = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.bin"\r\n\r\n`);
  const tail = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
  const limit = 1024 * 1024;
  let sent = -1;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent === -1) {
        controller.enqueue(head);
        sent = 0;
      } else if (sent > limit) {
        controller.enqueue(tail);
        controller.close();
      } else {
        const size = Math.min(256 * 1024, limit + 1 - sent);
        controller.enqueue(new Uint8Array(size));
        sent += size;
      }
    },
  });
  const target = stagingPath();
  await expect(receiveMultipartUpload(requestOf(body, `multipart/form-data; boundary=${boundary}`), { stagingPath: target, maxFileBytes: limit }))
    .rejects.toBeInstanceOf(UploadTooLargeError);
  expect(existsSync(target)).toBe(false);
}, 5_000);

test("removes the partial file when the upload is cut off or aborted", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(10_000)], "a.bin"));
  const { bytes, contentType } = await encode(form);

  const truncatedTarget = stagingPath();
  await expect(receiveMultipartUpload(requestOf(streamOf(bytes.slice(0, 6000), 1000), contentType), { stagingPath: truncatedTarget, maxFileBytes: 1 << 20 }))
    .rejects.toBeInstanceOf(MultipartFormError);
  expect(existsSync(truncatedTarget)).toBe(false);

  const abortedTarget = stagingPath();
  let sent = 0;
  const aborting = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 3) {
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      controller.enqueue(bytes.slice(sent * 1000, (sent + 1) * 1000));
      sent += 1;
    },
  });
  await expect(receiveMultipartUpload(requestOf(aborting, contentType), { stagingPath: abortedTarget, maxFileBytes: 1 << 20 }))
    .rejects.toThrow(/aborted/);
  expect(existsSync(abortedTarget)).toBe(false);
});

test("rejects a second file part, an unexpected file field, and an oversized text field", async () => {
  const twoFiles = new FormData();
  twoFiles.append("file", new File(["a"], "a.txt"));
  twoFiles.append("file", new File(["b"], "b.txt"));
  const first = await encode(twoFiles);
  const target = stagingPath();
  await expect(receiveMultipartUpload(requestOf(streamOf(first.bytes, 64), first.contentType), { stagingPath: target, maxFileBytes: 1024 }))
    .rejects.toThrow(/Only one file part/);
  expect(existsSync(target)).toBe(false);

  const otherFile = new FormData();
  otherFile.append("attachment", new File(["a"], "a.txt"));
  const second = await encode(otherFile);
  await expect(receiveMultipartUpload(requestOf(streamOf(second.bytes, 64), second.contentType), { stagingPath: stagingPath(), maxFileBytes: 1024 }))
    .rejects.toThrow(/Unexpected file part/);

  const longField = new FormData();
  longField.append("sessionId", "x".repeat(5000));
  const third = await encode(longField);
  await expect(receiveMultipartUpload(requestOf(streamOf(third.bytes, 64), third.contentType), { stagingPath: stagingPath(), maxFileBytes: 1024 }))
    .rejects.toThrow(/too long/);

  await expect(receiveMultipartUpload(requestOf(streamOf(new Uint8Array(1), 1), "application/json"), { stagingPath: stagingPath(), maxFileBytes: 1024 }))
    .rejects.toBeInstanceOf(MultipartFormError);
});
