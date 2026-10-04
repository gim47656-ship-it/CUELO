import { afterEach, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttachmentReferenceScanner, runAttachmentCleanupPass } from "./attachment-cleanup";
import { DEFAULT_ATTACHMENT_SETTINGS } from "./attachment-settings";
import { AttachmentStore, type ManagedAttachmentRecord } from "./attachment-store";
import { describeStoredAttachment } from "./document-attachments";

const DAY = 24 * 60 * 60 * 1000;
const DRAFT = "6f1c2d1e-8b8a-4b44-9f5e-2f8f0b1c2d3e";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440000";
const settings = { ...DEFAULT_ATTACHMENT_SETTINGS };

const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "cuelo-attachment-cleanup-"));
  bases.push(base);
  let clock = Date.parse("2026-10-04T00:00:00Z");
  const sessionsDir = path.join(base, "sessions");
  const projectDir = path.join(sessionsDir, "--F--CUELO--");
  mkdirSync(projectDir, { recursive: true });
  const store = new AttachmentStore({
    root: path.join(base, "cuelo-attachments"),
    sessionsDir,
    customSessionFilesDir: path.join(base, "custom-session-files"),
    now: () => clock,
  });
  const scanner = new AttachmentReferenceScanner();
  return {
    base,
    store,
    projectDir,
    advance: (ms: number) => { clock += ms; },
    pass: () => runAttachmentCleanupPass(store, { settings, scanner }),
  };
}

/** A sent-and-forgotten upload: committed, then released by its draft. */
async function addUpload(store: AttachmentStore, name = "memo.m4a"): Promise<ManagedAttachmentRecord> {
  const upload = await store.beginUpload();
  writeFileSync(upload.stagingPath, "bytes");
  try {
    return await store.commitUpload({ id: upload.id, stagingPath: upload.stagingPath, sessionId: SESSION_ID, draftId: DRAFT, fileName: name, size: 5, mimeType: "audio/mp4" });
  } finally {
    await upload.release();
    await store.setDraftAttachments(DRAFT, []);
  }
}

/** One persisted user message the way OMP writes it: a JSON line holding the document prompt. */
function sessionLine(text: string): string {
  return `${JSON.stringify({ type: "message", id: "e1", message: { role: "user", content: [{ type: "text", text }] } })}\n`;
}

test("deletes an unreferenced upload exactly seven days after the first scan that found it unreferenced", async () => {
  const { store, advance, pass } = setup();
  const record = await addUpload(store);

  const first = await pass();
  expect(first.complete).toBe(true);
  expect(first.marked).toEqual([record.id]);
  const marked = await store.readRecord(record.id);
  expect(marked?.orphanSince).toBe(new Date(store.now()).toISOString());

  advance(7 * DAY - 1);
  expect((await pass()).deleted).toEqual([]);
  expect(existsSync(record.path)).toBe(true);

  advance(1);
  expect((await pass()).deleted).toEqual([record.id]);
  expect(existsSync(record.path)).toBe(false);
  expect(await store.readRecord(record.id)).toBeNull();
});

test("finds references in every branch, fork, subagent transcript, artifact, and custom session file", async () => {
  const { base, store, projectDir, advance, pass } = setup();
  const sent = await addUpload(store, "sent.m4a");
  const forked = await addUpload(store, "forked.bin");
  const subagent = await addUpload(store, "subagent.bin");
  const utf16 = await addUpload(store, "utf16.bin");
  const custom = await addUpload(store, "custom.bin");
  const unreferenced = await addUpload(store, "forgotten.bin");

  // The prompt text exactly as the composer sends it, JSON-escaped with Windows backslashes.
  const prompt = `User message:\n봐 줘\n\nAttached documents:\n${describeStoredAttachment({ path: sent.path.replace(/\//g, "\\"), size: 5, mimeType: "audio/mp4" })}`;
  writeFileSync(path.join(projectDir, `2026-10-04T00-00-00-000Z_${SESSION_ID}.jsonl`), `{"type":"session"}\n${sessionLine(prompt)}`);
  // A fork written as a separate session, mentioning the file through a file:// URL.
  writeFileSync(path.join(projectDir, "fork.jsonl"), sessionLine(`see file:///${encodeURI(forked.path.replace(/\\/g, "/"))}`));
  // A subagent transcript and its tool output below the parent session's artifact folder.
  const artifacts = path.join(projectDir, `2026-10-04T00-00-00-000Z_${SESSION_ID}`);
  mkdirSync(artifacts);
  writeFileSync(path.join(artifacts, "Reviewer.jsonl"), sessionLine(`read ${subagent.path.toUpperCase()}`));
  writeFileSync(path.join(artifacts, "tool.log"), Buffer.from(`Get-Item ${utf16.path}`, "utf16le"));
  // A session kept outside the session folder, registered through a marker.
  const outside = path.join(base, "elsewhere.jsonl");
  writeFileSync(outside, sessionLine(custom.path));
  mkdirSync(path.join(base, "custom-session-files"));
  writeFileSync(path.join(base, "custom-session-files", "00ab12"), outside);

  const report = await pass();
  expect(report.complete).toBe(true);
  expect(report.marked).toEqual([unreferenced.id]);
  advance(8 * DAY);
  expect((await pass()).deleted).toEqual([unreferenced.id]);
  for (const kept of [sent, forked, subagent, utf16, custom]) {
    expect(existsSync(kept.path)).toBe(true);
    expect((await store.readRecord(kept.id))?.orphanSince).toBeNull();
  }
});

test("a new reference resets the countdown, and losing it starts a fresh one", async () => {
  const { store, projectDir, advance, pass } = setup();
  const record = await addUpload(store);
  await pass();
  advance(6 * DAY);

  const transcript = path.join(projectDir, "session.jsonl");
  writeFileSync(transcript, sessionLine(`File saved at: ${record.path}`));
  expect((await pass()).reset).toEqual([record.id]);
  expect((await store.readRecord(record.id))?.orphanSince).toBeNull();

  rmSync(transcript);
  advance(DAY);
  expect((await pass()).marked).toEqual([record.id]);
  advance(6 * DAY);
  expect((await pass()).deleted).toEqual([]);
  advance(DAY);
  expect((await pass()).deleted).toEqual([record.id]);
});

test("an incomplete view never starts or finishes a countdown", async () => {
  const { base, store, advance, pass } = setup();
  const record = await addUpload(store);
  const sessionsDir = path.join(base, "sessions");

  // No session folder at all is not "no references".
  rmSync(sessionsDir, { recursive: true });
  const missing = await pass();
  expect(missing.complete).toBe(false);
  expect(missing.marked).toEqual([]);
  mkdirSync(sessionsDir);

  await pass();
  advance(8 * DAY);
  // A transcript stored compressed hides its references.
  writeFileSync(path.join(sessionsDir, "archived.jsonl.gz"), "");
  const compressed = await pass();
  expect(compressed.complete).toBe(false);
  expect(compressed.deleted).toEqual([]);
  rmSync(path.join(sessionsDir, "archived.jsonl.gz"));

  // A marker that does not name a file cannot be followed.
  mkdirSync(path.join(base, "custom-session-files"));
  writeFileSync(path.join(base, "custom-session-files", "bad"), "not a path");
  expect((await pass()).deleted).toEqual([]);
  rmSync(path.join(base, "custom-session-files", "bad"));

  // An unreadable draft might hold any id.
  writeFileSync(path.join(store.root, ".cuelo-managed", "drafts", `${DRAFT}.json`), "{");
  expect((await pass()).deleted).toEqual([]);
  rmSync(path.join(store.root, ".cuelo-managed", "drafts", `${DRAFT}.json`));
  expect(existsSync(record.path)).toBe(true);

  expect((await pass()).deleted).toEqual([record.id]);
});

test("drafts, running holds, and the disabled setting keep files; legacy files are never touched", async () => {
  const { store, advance, pass } = setup();
  const drafted = await addUpload(store, "drafted.bin");
  const leased = await addUpload(store, "leased.bin");
  await store.setDraftAttachments(DRAFT, [drafted.id]);
  const legacyDir = path.join(store.root, SESSION_ID);
  const legacy = path.join(legacyDir, "old-report.xlsx");
  writeFileSync(legacy, "legacy");

  await pass();
  advance(8 * DAY);
  await store.withManagedAttachment(leased.id, async () => {
    const report = await pass();
    expect(report.deleted).toEqual([]);
    expect(report.marked).toEqual([]);
  });
  expect((await store.readRecord(drafted.id))?.orphanSince).toBeNull();

  const disabled = await runAttachmentCleanupPass(store, { settings: { ...settings, autoCleanupEnabled: false }, scanner: new AttachmentReferenceScanner() });
  expect(disabled.skipped).toBe("disabled");

  advance(8 * DAY);
  await pass();
  advance(8 * DAY);
  const report = await pass();
  expect(report.deleted).toEqual([leased.id]);
  expect(existsSync(drafted.path)).toBe(true);
  expect(existsSync(legacy)).toBe(true);
});

test("a reference that appears between the first scan and the deletion recheck keeps the file", async () => {
  const { store, projectDir, advance } = setup();
  const record = await addUpload(store);
  const scanner = new AttachmentReferenceScanner();
  await runAttachmentCleanupPass(store, { settings, scanner });
  advance(8 * DAY);

  // The first scan of this pass sees nothing; the recheck right before deleting sees the new message.
  let scans = 0;
  const racing = {
    scan: async (sources: { sessionsDir: string; customSessionFilesDir: string }) => {
      scans += 1;
      if (scans === 2) writeFileSync(path.join(projectDir, "late.jsonl"), sessionLine(record.path));
      return scanner.scan(sources);
    },
  } as unknown as AttachmentReferenceScanner; // Only `scan` is used by the pass.
  const report = await runAttachmentCleanupPass(store, { settings, scanner: racing });
  expect(report.deleted).toEqual([]);
  expect(report.reset).toEqual([record.id]);
  expect(existsSync(record.path)).toBe(true);
});

test("the deletion recheck rereads files even when a rewrite kept their size and modification time", async () => {
  const { store, projectDir, advance, pass } = setup();
  const record = await addUpload(store);
  const transcript = path.join(projectDir, "session.jsonl");
  // Same length as the real id, so the rewrite below keeps the size.
  const other = `att_${"0".repeat(32)}`;
  const pinned = 1_790_000_000;
  writeFileSync(transcript, sessionLine(other));
  utimesSync(transcript, pinned, pinned);
  expect((await pass()).marked).toEqual([record.id]);
  advance(8 * DAY);

  // The conversation now refers to the upload, but the file looks unchanged to a size/mtime cache.
  writeFileSync(transcript, sessionLine(record.id));
  utimesSync(transcript, pinned, pinned);
  const report = await pass();
  expect(report.deleted).toEqual([]);
  expect(report.reset).toEqual([record.id]);
  expect(existsSync(record.path)).toBe(true);
});

test("a handoff ends only on a fresh read of the conversation, not on a cached earlier mention", async () => {
  const { store, projectDir, pass } = setup();
  const record = await addUpload(store);
  const transcript = path.join(projectDir, "session.jsonl");
  const pinned = 1_790_000_000;
  writeFileSync(transcript, sessionLine(record.id));
  utimesSync(transcript, pinned, pinned);
  await pass();

  // The mention is gone (same size and mtime), then the file is sent in a message not yet on disk.
  writeFileSync(transcript, sessionLine(`att_${"0".repeat(32)}`));
  utimesSync(transcript, pinned, pinned);
  await store.setDraftAttachments(DRAFT, [], [record.id]);
  const report = await pass();
  expect(report.handedOver).toEqual([]);
  expect((await store.readHandoffs()).ids.has(record.id)).toBe(true);
});

test("a scan is incomplete when a file keeps changing while read; an already-deleted marker target is no gap", async () => {
  const { base, projectDir } = setup();
  const sources = { sessionsDir: path.join(base, "sessions"), customSessionFilesDir: path.join(base, "custom-session-files") };
  // Big enough that reading it takes many I/O turns, during which the appender below runs.
  const busy = path.join(projectDir, "a-busy.jsonl");
  writeFileSync(busy, Buffer.alloc(16 * 1024 * 1024, 0x20));
  let appending = true;
  const append = () => {
    if (!appending) return;
    appendFileSync(busy, " ");
    setImmediate(append);
  };
  setImmediate(append);
  const changing = await new AttachmentReferenceScanner().scan(sources, { fresh: true });
  appending = false;
  expect(changing.complete).toBe(false);
  expect(changing.failures.some((failure) => failure.startsWith("changed while reading"))).toBe(true);

  // A marker whose session file was already deleted (OMP prunes markers later) is not a gap.
  rmSync(busy);
  mkdirSync(sources.customSessionFilesDir);
  writeFileSync(path.join(sources.customSessionFilesDir, "dangling"), path.join(base, "deleted-session.jsonl"));
  const dangling = await new AttachmentReferenceScanner().scan(sources);
  expect(dangling.complete).toBe(true);
});

test("a sent attachment stays protected without expiry until its conversation reference is found", async () => {
  const { store, projectDir, advance, pass } = setup();
  const upload = await store.beginUpload();
  writeFileSync(upload.stagingPath, "bytes");
  const record = await store.commitUpload({ id: upload.id, stagingPath: upload.stagingPath, sessionId: SESSION_ID, draftId: DRAFT, fileName: "sent.m4a", size: 5, mimeType: "audio/mp4" });
  await upload.release();
  // Sent: it leaves the draft, but the message is not on disk yet.
  await store.setDraftAttachments(DRAFT, [], [record.id]);
  expect((await store.readDraftReferences()).ids.has(record.id)).toBe(false);
  expect((await store.readHandoffs()).ids.has(record.id)).toBe(true);

  for (let day = 0; day < 30; day += 1) {
    const report = await pass();
    expect(report.marked).toEqual([]);
    expect(report.deleted).toEqual([]);
    advance(DAY);
  }
  expect(existsSync(record.path)).toBe(true);

  // The conversation recorded it: the handoff ends and the normal countdown takes over from there.
  const transcript = path.join(projectDir, "session.jsonl");
  writeFileSync(transcript, sessionLine(record.path));
  expect((await pass()).handedOver).toEqual([record.id]);
  expect((await store.readHandoffs()).ids.size).toBe(0);
  rmSync(transcript);
  expect((await pass()).marked).toEqual([record.id]);
  advance(7 * DAY);
  expect((await pass()).deleted).toEqual([record.id]);
});

test("a sent attachment back in a draft drops its handoff; unreadable handoffs and drafts block deletion", async () => {
  const { store, advance, pass } = setup();
  const record = await addUpload(store);
  await store.setDraftAttachments(DRAFT, [], [record.id]);
  // A failed send restored into another composer: the draft protects it again, the handoff goes.
  const otherDraft = "0b8f9a52-55e4-4c21-9d1a-3c7b2a1e0f99";
  await store.setDraftAttachments(otherDraft, [record.id]);
  expect((await store.readHandoffs()).ids.size).toBe(0);
  // Removed from that draft without being sent: plain release, the countdown may start.
  await store.setDraftAttachments(otherDraft, []);
  expect((await pass()).marked).toEqual([record.id]);
  advance(8 * DAY);

  const handoffs = path.join(store.root, ".cuelo-managed", "handoffs");
  writeFileSync(path.join(handoffs, "not-an-id.json"), "{}");
  const blocked = await pass();
  expect(blocked.complete).toBe(false);
  expect(blocked.deleted).toEqual([]);
  rmSync(path.join(handoffs, "not-an-id.json"));

  // The store's own last check sees a handoff written after the pass began.
  writeFileSync(path.join(handoffs, `${record.id}.json`), JSON.stringify({ version: 1, id: record.id }));
  expect(await store.deleteOrphan(record.id, 7 * DAY)).toBe(false);
  rmSync(path.join(handoffs, `${record.id}.json`));
  expect((await pass()).deleted).toEqual([record.id]);
});

test("a sent id that no longer exists is ignored, and a failed handoff write keeps the previous draft", async () => {
  const { store } = setup();
  const record = await addUpload(store);
  await store.setDraftAttachments(DRAFT, [record.id]);
  await store.setDraftAttachments(DRAFT, [record.id], [`att_${"e".repeat(32)}`]);
  expect((await store.readHandoffs()).ids.size).toBe(0);

  // A directory where the handoff file should go makes the write fail.
  const handoffs = path.join(store.root, ".cuelo-managed", "handoffs");
  mkdirSync(path.join(handoffs, `${record.id}.json`));
  await expect(store.setDraftAttachments(DRAFT, [], [record.id])).rejects.toThrow();
  expect((await store.readDraftReferences()).ids.has(record.id)).toBe(true);
});

test("skips reading sessions when nothing is managed, and yields to another process's pass", async () => {
  const { base, store, pass } = setup();
  rmSync(path.join(base, "sessions"), { recursive: true });
  const empty = await pass();
  expect(empty.complete).toBe(true);
  expect(empty.failures).toEqual([]);

  const release = await new AttachmentStore({ root: store.root, sessionsDir: store.sessionsDir, customSessionFilesDir: store.customSessionFilesDir }).acquireCleanupLock();
  expect((await pass()).skipped).toBe("locked");
  await release!();
});
