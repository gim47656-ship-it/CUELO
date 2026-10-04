import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AttachmentStore, ManagedAttachmentError, UnknownAttachmentError, type ManagedAttachmentRecord } from "./attachment-store";

const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
const STORE_URL = pathToFileURL(path.join(import.meta.dir, "attachment-store.ts")).href;
const DRAFT_A = "6f1c2d1e-8b8a-4b44-9f5e-2f8f0b1c2d3e";
const DRAFT_B = "0b8f9a52-55e4-4c21-9d1a-3c7b2a1e0f99";

const bases: string[] = [];
const children: Bun.Subprocess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
});

function createStore(options: { deletionWaitLimitMs?: number } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "cuelo-attachment-store-"));
  bases.push(base);
  let clock = Date.parse("2026-10-04T00:00:00Z");
  const paths = {
    root: path.join(base, "cuelo-attachments"),
    sessionsDir: path.join(base, "sessions"),
    customSessionFilesDir: path.join(base, "custom-session-files"),
  };
  const store = new AttachmentStore({ ...paths, now: () => clock, ...options });
  return { store, base, paths, advance: (ms: number) => { clock += ms; } };
}

async function addAttachment(store: AttachmentStore, name = "memo.m4a", draftId = DRAFT_A): Promise<ManagedAttachmentRecord> {
  const upload = await store.beginUpload();
  writeFileSync(upload.stagingPath, "audio bytes");
  try {
    return await store.commitUpload({ id: upload.id, stagingPath: upload.stagingPath, sessionId: null, draftId, fileName: name, size: 11, mimeType: "audio/mp4" });
  } finally {
    await upload.release();
  }
}

/** A record whose orphan countdown started `ago` before now and that no draft holds. */
async function addOrphan(store: AttachmentStore, ago = GRACE): Promise<ManagedAttachmentRecord> {
  const record = await addAttachment(store);
  await store.setDraftAttachments(DRAFT_A, []);
  const orphan = { ...record, orphanSince: new Date(store.now() - ago).toISOString() };
  store.writeRecord(orphan);
  return orphan;
}

function leasesDir(store: AttachmentStore): string {
  return path.join(store.root, ".cuelo-managed", "leases");
}

/** Runs `body` in a second Bun process that has `store` (same paths) and `id` in scope. */
async function spawnHelper(paths: Record<string, string>, id: string, body: string): Promise<{ child: Bun.Subprocess<"ignore", "pipe", "inherit">; lines: AsyncGenerator<string> }> {
  const script = `
    const { AttachmentStore } = await import(${JSON.stringify(STORE_URL)});
    const store = new AttachmentStore(${JSON.stringify(paths)});
    const id = ${JSON.stringify(id)};
    ${body}
  `;
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: path.join(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit" });
  children.push(child);
  async function* lines() {
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    let buffered = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffered += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffered.indexOf("\n")) !== -1) {
        yield buffered.slice(0, index).trim();
        buffered = buffered.slice(index + 1);
      }
    }
  }
  return { child, lines: lines() };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "0"]);
  await child.exited;
  return child.pid;
}

test("lends a managed file and refuses malformed, unknown, and tampered ids", async () => {
  const { store } = createStore();
  const record = await addAttachment(store);
  const lent = await store.withManagedAttachment(record.id, async (attachment) => ({ ...attachment, bytes: readFileSync(attachment.path, "utf8") }));
  expect(lent).toEqual({ id: record.id, path: record.path, size: 11, mimeType: "audio/mp4", bytes: "audio bytes" });

  const codeOf = (promise: Promise<unknown>) => promise.then(() => null, (error: unknown) => (error as ManagedAttachmentError).code);
  expect(await codeOf(store.withManagedAttachment("../att", async () => {}))).toBe("invalid_id");
  expect(await codeOf(store.withManagedAttachment(`att_${"0".repeat(32)}`, async () => {}))).toBe("not_found");
  // A record whose path was edited to point elsewhere is not lent out (or ever deleted).
  store.writeRecord({ ...record, path: path.join(store.root, "..", "elsewhere.m4a") });
  expect(await codeOf(store.withManagedAttachment(record.id, async () => {}))).toBe("not_found");
});

test("deletes an expired orphan only once nothing holds it, removing file, folder, and record", async () => {
  const { store } = createStore();
  const record = await addOrphan(store);
  await store.withManagedAttachment(record.id, async () => {
    expect(await store.deleteOrphan(record.id, GRACE)).toBe(false);
  });
  expect(existsSync(record.path)).toBe(true);
  expect(readdirSync(leasesDir(store))).toEqual([]);

  expect(await store.deleteOrphan(record.id, GRACE)).toBe(true);
  expect(existsSync(record.path)).toBe(false);
  expect(existsSync(path.dirname(record.path))).toBe(false);
  expect(await store.readRecord(record.id)).toBeNull();
  // A hold that arrives afterwards finds nothing to lend.
  await expect(store.withManagedAttachment(record.id, async () => {})).rejects.toMatchObject({ code: "not_found" });
});

test("never deletes before the grace period, while a draft holds the file, or when drafts cannot be read", async () => {
  const { store } = createStore();
  const young = await addOrphan(store, GRACE - 1);
  expect(await store.deleteOrphan(young.id, GRACE)).toBe(false);

  const drafted = await addOrphan(store);
  await store.setDraftAttachments(DRAFT_B, [drafted.id]);
  expect(await store.deleteOrphan(drafted.id, GRACE)).toBe(false);

  const other = await addOrphan(store);
  writeFileSync(path.join(store.root, ".cuelo-managed", "drafts", `${DRAFT_A}.json`), "{ broken");
  expect((await store.readDraftReferences()).complete).toBe(false);
  expect(await store.deleteOrphan(other.id, GRACE)).toBe(false);
  for (const kept of [young, drafted, other]) expect(existsSync(kept.path)).toBe(true);
});

test("draft updates replace the set, move between drafts, and keep the previous set on unknown ids", async () => {
  const { store } = createStore();
  const first = await addAttachment(store, "a.bin", DRAFT_A);
  const second = await addAttachment(store, "b.bin", DRAFT_A);
  expect([...(await store.readDraftReferences()).ids].sort()).toEqual([first.id, second.id].sort());

  const missing = `att_${"f".repeat(32)}`;
  const error = await store.setDraftAttachments(DRAFT_A, [first.id, missing]).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(UnknownAttachmentError);
  expect((error as UnknownAttachmentError).missing).toEqual([missing]);
  expect([...(await store.readDraftReferences()).ids].sort()).toEqual([first.id, second.id].sort());

  // Restoring a failed send into another composer: add to B first, then release A.
  expect(await store.setDraftAttachments(DRAFT_B.toUpperCase(), [second.id])).toEqual([second.id]);
  await store.setDraftAttachments(DRAFT_A, []);
  expect([...(await store.readDraftReferences()).ids]).toEqual([second.id]);
  expect(existsSync(path.join(store.root, ".cuelo-managed", "drafts", `${DRAFT_A}.json`))).toBe(false);
});

test("a live lease in another process blocks deletion; the lease of an exited process is reclaimed", async () => {
  const { store, paths } = createStore();
  const record = await addOrphan(store);
  const { child, lines } = await spawnHelper(paths, record.id, `
    await store.withManagedAttachment(id, async () => {
      console.log("held");
      await new Promise(() => {});
    });
  `);
  expect((await lines.next()).value).toBe("held");
  expect(await store.deleteOrphan(record.id, GRACE)).toBe(false);
  expect(existsSync(record.path)).toBe(true);

  child.kill();
  await child.exited;
  expect(readdirSync(leasesDir(store)).some((name) => name.endsWith(".lease"))).toBe(true);
  expect(await store.deleteOrphan(record.id, GRACE)).toBe(true);
  expect(readdirSync(leasesDir(store))).toEqual([]);
});

test("a hold waits while another live process deletes the id, then proceeds once that owner is gone", async () => {
  const { store } = createStore({ deletionWaitLimitMs: 10_000 });
  const record = await addAttachment(store);
  const sleeper = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"]);
  children.push(sleeper);
  const marker = path.join(leasesDir(store), `${record.id}~${sleeper.pid}~0123456789ab.deleting`);
  writeFileSync(marker, "");

  let lent = false;
  const holding = store.withManagedAttachment(record.id, async () => {
    lent = true;
  });
  // Real time on purpose: the hold polls the other process's marker on the wall clock.
  await Bun.sleep(300);
  expect(lent).toBe(false);
  sleeper.kill();
  await sleeper.exited;
  await holding;
  expect(lent).toBe(true);
  expect(existsSync(marker)).toBe(false);
});

test("markers and leases whose owner cannot be identified are kept and keep protecting", async () => {
  const { store } = createStore({ deletionWaitLimitMs: 200 });
  const record = await addOrphan(store);
  const marker = path.join(leasesDir(store), `${record.id}~unknown~m.deleting`);
  writeFileSync(marker, "");
  await expect(store.withManagedAttachment(record.id, async () => {})).rejects.toMatchObject({ code: "busy" });
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);

  const lease = path.join(leasesDir(store), `${record.id}~unknown~l.lease`);
  writeFileSync(lease, "");
  expect(await store.deleteOrphan(record.id, GRACE)).toBe(false);
  expect(existsSync(lease)).toBe(true);
  expect(existsSync(record.path)).toBe(true);

  // The same names with a pid that has certainly exited are crash leftovers and are reclaimed.
  rmSync(lease);
  writeFileSync(path.join(leasesDir(store), `${record.id}~${await deadPid()}~l.lease`), "");
  expect(await store.deleteOrphan(record.id, GRACE)).toBe(true);
});

test("racing a reader in another process against deletion never pulls the file from under a lease", async () => {
  const { store, paths } = createStore();
  const record = await addOrphan(store);
  const { lines } = await spawnHelper(paths, record.id, `
    const { readFileSync } = await import("node:fs");
    let reads = 0, violations = 0;
    console.log("ready");
    for (let i = 0; i < 400; i += 1) {
      try {
        await store.withManagedAttachment(id, async (attachment) => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          try { readFileSync(attachment.path); reads += 1; } catch { violations += 1; }
        });
      } catch (error) {
        if (error.code !== "not_found") throw error;
        break;
      }
    }
    console.log(JSON.stringify({ reads, violations }));
  `);
  expect((await lines.next()).value).toBe("ready");
  let deleted = false;
  for (let attempt = 0; attempt < 2000 && !deleted; attempt += 1) {
    deleted = await store.deleteOrphan(record.id, GRACE);
  }
  const result = JSON.parse((await lines.next()).value as string) as { reads: number; violations: number };
  expect(result.violations).toBe(0);
  expect(deleted).toBe(true);
  expect(existsSync(record.path)).toBe(false);
}, 30_000);

test("only one process at a time gets the cleanup lock; an exited holder's lock is reclaimed", async () => {
  const { store, paths } = createStore();
  const release = await store.acquireCleanupLock();
  expect(release).not.toBeNull();
  const second = new AttachmentStore(paths);
  expect(await second.acquireCleanupLock()).toBeNull();
  await release!();
  const again = await second.acquireCleanupLock();
  expect(again).not.toBeNull();
  await again!();

  writeFileSync(path.join(leasesDir(store), `cleanup~${await deadPid()}~x.cleanup-lock`), "");
  const reclaimed = await store.acquireCleanupLock();
  expect(reclaimed).not.toBeNull();
  await reclaimed!();
  writeFileSync(path.join(leasesDir(store), "cleanup~unknown~x.cleanup-lock"), "");
  expect(await store.acquireCleanupLock()).toBeNull();
});

test("removes only staging files that are old and that no running upload owns", async () => {
  const { store, advance } = createStore();
  const running = await store.beginUpload();
  writeFileSync(running.stagingPath, "partial");
  const abandoned = path.join(path.dirname(running.stagingPath), `att_${"a".repeat(32)}.part`);
  writeFileSync(abandoned, "partial");
  const old = new Date(store.now() - 2 * DAY);
  utimesSync(abandoned, old, old);
  utimesSync(running.stagingPath, old, old);
  mkdirSync(path.join(path.dirname(running.stagingPath), "unrelated"));

  advance(0);
  expect(await store.removeStaleUploads(DAY)).toBe(1);
  expect(existsSync(abandoned)).toBe(false);
  expect(existsSync(running.stagingPath)).toBe(true);
  await running.release();
});
