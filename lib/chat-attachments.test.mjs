import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const { handleAttachmentUpload } = await import("./chat-attachments.ts");
const { AttachmentStore, toSafeAttachmentFileName } = await import("./attachment-store.ts");
const { DEFAULT_ATTACHMENT_SETTINGS } = await import("./attachment-settings.ts");

const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const DRAFT_ID = "6F1C2D1E-8B8A-4B44-9F5E-2F8F0B1C2D3E";

async function withStore(run) {
  const base = await mkdtemp(path.join(tmpdir(), "cuelo-attachments-test-"));
  try {
    const store = new AttachmentStore({
      root: path.join(base, "cuelo-attachments"),
      sessionsDir: path.join(base, "sessions"),
      customSessionFilesDir: path.join(base, "custom-session-files"),
    });
    await run(store, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function upload(file, fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  form.append("file", file, file.name);
  return new Request("http://127.0.0.1/api/attachments", { method: "POST", body: form });
}

const settings = (uploadLimitMb = DEFAULT_ATTACHMENT_SETTINGS.uploadLimitMb) => ({ ...DEFAULT_ATTACHMENT_SETTINGS, uploadLimitMb });

async function stagedFiles(store) {
  return readdir(path.join(await realpath(store.root), ".cuelo-managed", "uploads"));
}

test("streams a file into its own managed folder and registers it with the draft", async () => {
  await withStore(async (store) => {
    const response = await handleAttachmentUpload(
      upload(new File(["PK\u0003\u0004"], "report.docx", { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), { sessionId: SESSION_ID, draftId: DRAFT_ID }),
      { store, settings: settings() },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.id, /^att_[0-9a-f]{32}$/);
    assert.equal(body.draftId, DRAFT_ID.toLowerCase());
    assert.equal(body.path, path.join(await realpath(store.root), SESSION_ID, body.id, "report.docx"));
    assert.equal(body.size, 4);
    assert.equal(body.mimeType, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    assert.equal(body.transcript, undefined);
    assert.equal(await readFile(body.path, "latin1"), "PK\u0003\u0004");

    const record = await store.readRecord(body.id);
    assert.equal(record?.path, body.path);
    assert.equal(record?.orphanSince, null);
    assert.equal((await store.readDraftReferences()).ids.has(body.id), true);
    assert.deepEqual(await stagedFiles(store), []);
  });
});

test("issues a draft id when none is sent and keeps same-name uploads apart", async () => {
  await withStore(async (store) => {
    const first = await (await handleAttachmentUpload(upload(new File(["first"], "notes.xlsx"), { sessionId: SESSION_ID }), { store, settings: settings() })).json();
    const second = await (await handleAttachmentUpload(upload(new File(["second"], "notes.xlsx"), { sessionId: SESSION_ID.toUpperCase(), draftId: first.draftId }), { store, settings: settings() })).json();
    assert.match(first.draftId, /^[0-9a-f-]{36}$/);
    assert.equal(second.draftId, first.draftId);
    assert.notEqual(second.path, first.path);
    assert.equal(path.basename(second.path), "notes.xlsx");
    assert.equal(path.dirname(path.dirname(second.path)), path.dirname(path.dirname(first.path)));
    assert.equal(await readFile(first.path, "utf8"), "first");
    assert.equal(await readFile(second.path, "utf8"), "second");
    const draft = await store.readDraftReferences();
    assert.deepEqual([...draft.ids].sort(), [first.id, second.id].sort());
  });
});

test("rejects names, session ids, and draft ids that do not validate, leaving nothing behind", async () => {
  await withStore(async (store, base) => {
    for (const name of ["../escape.txt", "..\\escape.txt", "..", "nested/escape.txt"]) {
      const response = await handleAttachmentUpload(upload(new File(["x"], name)), { store, settings: settings() });
      assert.equal(response.status, 400, name);
      assert.equal((await response.json()).code, "invalid_name", name);
    }
    const badSession = await handleAttachmentUpload(upload(new File(["x"], "a.bin"), { sessionId: "../../sessions" }), { store, settings: settings() });
    assert.equal((await badSession.json()).code, "invalid_session");
    const badDraft = await handleAttachmentUpload(upload(new File(["x"], "a.bin"), { draftId: "../drafts/x" }), { store, settings: settings() });
    assert.equal((await badDraft.json()).code, "invalid_draft");

    assert.deepEqual((await readdir(base)).filter((entry) => entry.startsWith("escape")), []);
    assert.deepEqual(await stagedFiles(store), []);
    assert.deepEqual(await store.listRecords(), []);
  });
});

test("enforces the configured limit while streaming and before reading a declared oversized body", async () => {
  await withStore(async (store) => {
    const mebibyte = 1024 * 1024;
    const exact = await handleAttachmentUpload(upload(new File([new Uint8Array(mebibyte)], "exact.bin")), { store, settings: settings(1) });
    assert.equal(exact.status, 200);
    assert.equal((await stat((await exact.json()).path)).size, mebibyte);

    const over = await handleAttachmentUpload(upload(new File([new Uint8Array(mebibyte + 1)], "over.bin")), { store, settings: settings(1) });
    assert.equal(over.status, 413);
    assert.deepEqual(await over.json(), { code: "file_too_large", error: "Attachments must be 1MB or smaller", limitBytes: mebibyte });

    const declared = new Request("http://127.0.0.1/api/attachments", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x", "content-length": String(5 * mebibyte) },
      body: "--x--",
    });
    assert.equal((await handleAttachmentUpload(declared, { store, settings: settings(1) })).status, 413);

    // The same 3 MiB file passes once the limit is raised.
    const raised = await handleAttachmentUpload(upload(new File([new Uint8Array(3 * mebibyte)], "big.bin")), { store, settings: settings(3) });
    assert.equal(raised.status, 200);
    assert.deepEqual(await stagedFiles(store), []);
  });
});

test("refuses to write through a junction planted at the session folder", async () => {
  await withStore(async (store, base) => {
    const outside = path.join(base, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(store.root, { recursive: true });
    await symlink(outside, path.join(store.root, SESSION_ID), "junction");
    await assert.rejects(
      handleAttachmentUpload(upload(new File(["x"], "a.txt"), { sessionId: SESSION_ID }), { store, settings: settings() }),
      /outside the attachment root/,
    );
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(await stagedFiles(store), []);
  });
});

test("stores audio without transcribing it", async () => {
  await withStore(async (store) => {
    const body = await (await handleAttachmentUpload(upload(new File(["RIFF"], "memo.m4a")), { store, settings: settings() })).json();
    assert.equal(body.mimeType, "audio/mp4");
    assert.equal(body.transcript, undefined);
    assert.equal(body.transcriptError, undefined);
    assert.equal(path.basename(path.dirname(path.dirname(body.path))), "new");
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

test("the upload route checks the password itself before reading the body", async () => {
  const previous = process.env.CUELO_PASSWORD;
  process.env.CUELO_PASSWORD = "route-test-password";
  try {
    const { POST } = await import("../app/api/attachments/route.ts");
    let pulled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.close();
      },
    });
    const response = await POST(new Request("http://127.0.0.1:30141/api/attachments", {
      method: "POST",
      headers: { host: "127.0.0.1:30141", "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="cuelo", charset="UTF-8"');
    assert.equal(pulled, false);
  } finally {
    if (previous === undefined) delete process.env.CUELO_PASSWORD;
    else process.env.CUELO_PASSWORD = previous;
  }
});
