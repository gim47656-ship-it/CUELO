import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { handleAttachmentUpload, saveChatAttachment, toSafeAttachmentFileName } = await jiti.import("./chat-attachments.ts");
const { MAX_STORED_ATTACHMENT_BYTES } = await jiti.import("./document-attachments.ts");

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";

async function withRoot(run) {
  const base = await mkdtemp(path.join(tmpdir(), "cuelo-attachments-test-"));
  try {
    await run(path.join(base, "cuelo-attachments"), base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function upload(file, fields = {}) {
  const form = new FormData();
  form.append("file", file, file.name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return new Request("http://127.0.0.1/api/attachments", { method: "POST", body: form });
}

const noTranscribe = async () => {
  throw new Error("transcribe must not run for this file");
};

test("saves a file in the session folder and reports its absolute path, size, and type", async () => {
  await withRoot(async (root) => {
    const response = await handleAttachmentUpload(
      upload(new File(["PK\u0003\u0004"], "report.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), { sessionId: SESSION_ID }),
      { root, transcribe: noTranscribe },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, path.join(await realpath(root), SESSION_ID, "report.docx"));
    assert.equal(body.size, 4);
    assert.equal(body.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(body.transcript, undefined);
    assert.equal(await readFile(body.path, "latin1"), "PK\u0003\u0004");
  });
});

test("rejects file names that try to leave the session folder", async () => {
  await withRoot(async (root, base) => {
    for (const name of ["../escape.txt", "..\\escape.txt", "..", "nested/escape.txt"]) {
      const response = await handleAttachmentUpload(upload(new File(["x"], name)), { root, transcribe: noTranscribe });
      assert.equal(response.status, 400, name);
      assert.equal((await response.json()).code, "invalid_name", name);
    }
    assert.deepEqual((await readdir(base)).filter((entry) => entry.startsWith("escape")), []);
  });
});

test("rejects a session id that is not a session UUID", async () => {
  await withRoot(async (root) => {
    const response = await handleAttachmentUpload(upload(new File(["x"], "a.bin"), { sessionId: "../../sessions" }), { root, transcribe: noTranscribe });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_session");
  });
});

test("rejects a file over the per-file cap and accepts one past the old 10MB proxy default", async () => {
  await withRoot(async (root) => {
    const tooLarge = await handleAttachmentUpload(
      upload(new File([new Uint8Array(MAX_STORED_ATTACHMENT_BYTES + 1)], "huge.bin")),
      { root, transcribe: noTranscribe },
    );
    assert.equal(tooLarge.status, 413);
    assert.equal((await tooLarge.json()).code, "file_too_large");

    const twelveMegabytes = 12 * 1024 * 1024;
    const accepted = await handleAttachmentUpload(
      upload(new File([new Uint8Array(twelveMegabytes)], "big.bin")),
      { root, transcribe: noTranscribe },
    );
    assert.equal(accepted.status, 200);
    assert.equal((await stat((await accepted.json()).path)).size, twelveMegabytes);
  });
});

test("never overwrites an existing attachment with the same name", async () => {
  await withRoot(async (root) => {
    const first = await saveChatAttachment(root, SESSION_ID, "notes.xlsx", new TextEncoder().encode("first"));
    const second = await saveChatAttachment(root, SESSION_ID.toUpperCase(), "notes.xlsx", new TextEncoder().encode("second"));
    assert.equal(path.basename(second), "notes (2).xlsx");
    assert.equal(path.dirname(second), path.dirname(first));
    assert.equal(await readFile(first, "utf8"), "first");
    assert.equal(await readFile(second, "utf8"), "second");
  });
});

test("refuses to write through a junction planted at the session folder", async () => {
  await withRoot(async (root, base) => {
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(root, { recursive: true });
    await symlink(outside, path.join(root, SESSION_ID), "junction");
    await assert.rejects(saveChatAttachment(root, SESSION_ID, "a.txt", new Uint8Array(1)), /outside the attachment root/);
    assert.deepEqual(await readdir(outside), []);
  });
});

test("makes Windows-reserved names safe without changing ordinary ones", () => {
  assert.equal(toSafeAttachmentFileName("회의록 v2.hwp"), "회의록 v2.hwp");
  assert.equal(toSafeAttachmentFileName("con.txt"), "_con.txt");
  assert.equal(toSafeAttachmentFileName('a:b?"c|.log'), "a_b__c_.log");
  assert.equal(toSafeAttachmentFileName("trailing. . "), "trailing");
  const long = toSafeAttachmentFileName(`${"x".repeat(300)}.xlsx`);
  assert.equal(long.length, 150);
  assert.equal(long.endsWith(".xlsx"), true);
});

test("adds the transcript for audio, or the reason when transcription fails", async () => {
  await withRoot(async (root) => {
    const calls = [];
    const ok = await handleAttachmentUpload(upload(new File(["RIFF"], "memo.m4a")), {
      root,
      transcribe: async (audio, mimeType) => {
        calls.push([audio.byteLength, mimeType]);
        return "빌드는 3시 15분에 통과했습니다.";
      },
    });
    const okBody = await ok.json();
    assert.deepEqual(calls, [[4, "audio/mp4"]]);
    assert.equal(okBody.transcript, "빌드는 3시 15분에 통과했습니다.");
    assert.equal(okBody.mimeType, "audio/mp4");
    assert.equal(path.basename(path.dirname(okBody.path)), "new");

    const failed = await handleAttachmentUpload(upload(new File(["RIFF"], "memo.m4a")), {
      root,
      transcribe: async () => {
        throw new Error("blocked by Gemini's filters");
      },
    });
    const failedBody = await failed.json();
    assert.equal(failed.status, 200);
    assert.equal(failedBody.transcript, undefined);
    assert.equal(failedBody.transcriptError, "blocked by Gemini's filters");
    assert.equal(path.basename(failedBody.path), "memo (2).m4a");
  });
});
