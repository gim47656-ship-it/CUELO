import { createReadStream } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { ATTACHMENT_ORPHAN_GRACE_DAYS, type AttachmentSettings } from "./attachment-settings";
import { getAttachmentStore, readAttachmentSettings, type AttachmentStore } from "./attachment-store";

/**
 * Reference scan and the daily cleanup pass for managed chat attachments.
 *
 * A managed upload's path contains its `att_<32 hex>` id, and every way a conversation keeps that
 * path — the sent prompt, tool calls and results, branches and forks in the same JSONL, forked
 * sessions, subagent transcripts and artifacts below the session folder — keeps the id as plain
 * ASCII: JSON escaping only touches quotes, backslashes, and control characters; slash direction,
 * `file://`, and percent-encoding leave `[a-z0-9_]` alone. The scan therefore reads every file under
 * OMP's session folder (plus the session files OMP records outside it) as raw bytes and collects the
 * ids, in UTF-8/ASCII and in UTF-16LE. Any read it cannot complete makes the scan incomplete, and an
 * incomplete scan never starts or finishes an orphan countdown.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const ATTACHMENT_ORPHAN_GRACE_MS = ATTACHMENT_ORPHAN_GRACE_DAYS * DAY_MS;
/** Staging files of uploads that died with their process. */
const STALE_UPLOAD_MS = DAY_MS;
const SCAN_CHUNK_BYTES = 1024 * 1024;
const ID_RE = /att_[0-9a-f]{32}/gi;
const UTF16_ID_RE = /a\0t\0t\0_\0(?:[0-9a-f]\0){32}/gi;
/** Longest match minus one: the tail carried across chunk boundaries. */
const CARRY_CHARS = 72;
/** A transcript OMP stored compressed would hide its references from a raw scan. */
const COMPRESSED_TRANSCRIPT_RE = /\.jsonl\.(?:gz|zst|br|xz|bz2)$/i;

interface CachedFileScan {
  size: number;
  mtimeMs: number;
  ids: string[];
}

export interface ReferenceScan {
  /** True only when every session file was listed and read. */
  complete: boolean;
  ids: Set<string>;
  files: number;
  /** Why the scan is incomplete, one entry per failure. */
  failures: string[];
}

async function scanFileForIds(file: string): Promise<string[]> {
  const ids = new Set<string>();
  let carry = "";
  const stream = createReadStream(file, { highWaterMark: SCAN_CHUNK_BYTES });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    // latin1 maps each byte to one char, so ASCII ids and UTF-16LE ids both survive decoding.
    const text = carry + chunk.toString("latin1");
    for (const match of text.matchAll(ID_RE)) ids.add(match[0].toLowerCase());
    for (const match of text.matchAll(UTF16_ID_RE)) ids.add(match[0].replace(/\0/g, "").toLowerCase());
    carry = text.slice(-CARRY_CHARS);
  }
  return [...ids];
}

/**
 * Finds every managed attachment id the sessions mention. File results are cached by size and
 * modification time, so a routine pass rereads only transcripts that changed since the last one;
 * `fresh` ignores the cache (a rewrite can keep both). A file whose size or modification time moved
 * while it was read is read once more and, if it moves again, makes the scan incomplete. This only
 * notices writes that change those two values; it is not a snapshot of every concurrent write.
 */
export class AttachmentReferenceScanner {
  readonly #cache = new Map<string, CachedFileScan>();

  async scan(
    { sessionsDir, customSessionFilesDir }: { sessionsDir: string; customSessionFilesDir: string },
    { fresh = false }: { fresh?: boolean } = {},
  ): Promise<ReferenceScan> {
    const ids = new Set<string>();
    const failures: string[] = [];
    const seen = new Set<string>();
    const visitedDirectories = new Set<string>();

    /** `listed`: the file came from a directory listing, so vanishing before it is read is a gap. */
    const scanFile = async (file: string, listed: boolean): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      if (COMPRESSED_TRANSCRIPT_RE.test(file)) {
        failures.push(`compressed transcript ${file}`);
        return;
      }
      let existed = false;
      try {
        let info = await stat(file);
        existed = true;
        if (!info.isFile()) return;
        const cached = fresh ? undefined : this.#cache.get(file);
        if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs) {
          for (const id of cached.ids) ids.add(id);
          return;
        }
        for (let attempt = 0; ; attempt += 1) {
          const found = await scanFileForIds(file);
          const after = await stat(file);
          if (after.size === info.size && after.mtimeMs === info.mtimeMs) {
            this.#cache.set(file, { size: info.size, mtimeMs: info.mtimeMs, ids: found });
            for (const id of found) ids.add(id);
            return;
          }
          // Keep what this read saw: a reference it found is real even though the file moved on.
          for (const id of found) ids.add(id);
          this.#cache.delete(file);
          if (attempt === 1) {
            failures.push(`changed while reading ${file}`);
            return;
          }
          info = after;
        }
      } catch (error) {
        this.#cache.delete(file);
        // A file that disappears mid-scan may have been moved where this scan already looked. Only a
        // marker target that was already missing (a deleted session OMP has not pruned yet) is no gap.
        if (listed || existed || (error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`read ${file}: ${(error as Error).message}`);
      }
    };

    const walk = async (directory: string): Promise<void> => {
      let canonical: string;
      let entries;
      try {
        canonical = await realpath(directory);
        if (visitedDirectories.has(canonical)) return;
        visitedDirectories.add(canonical);
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        // A missing session root is not "no references": it means we do not know where they are.
        // A listed folder that vanished may have been moved somewhere this scan already passed.
        failures.push(`list ${directory}: ${(error as Error).message}`);
        return;
      }
      for (const entry of entries) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          await scanFile(full, true);
        } else if (entry.isSymbolicLink()) {
          try {
            const target = await stat(full);
            if (target.isDirectory()) await walk(full);
            else if (target.isFile()) await scanFile(full, true);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`follow ${full}: ${(error as Error).message}`);
          }
        }
      }
    };

    await walk(sessionsDir);

    // Each marker holds the absolute path of one session file kept outside the session folder.
    let markers: string[] = [];
    try {
      markers = await readdir(customSessionFilesDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`list ${customSessionFilesDir}: ${(error as Error).message}`);
    }
    for (const marker of markers) {
      const markerPath = path.join(customSessionFilesDir, marker);
      try {
        const target = (await readFile(markerPath, "utf8")).trim();
        if (!path.isAbsolute(target)) {
          failures.push(`unreadable session marker ${markerPath}`);
          continue;
        }
        // OMP leaves markers behind after their session file is deleted until `omp gc` prunes them,
        // so a missing target is a gone session, not a gap.
        await scanFile(target, false);
      } catch (error) {
        // A listed marker that vanished may have moved; only a target missing from the start is no gap.
        failures.push(`read ${markerPath}: ${(error as Error).message}`);
      }
    }

    for (const file of this.#cache.keys()) {
      if (!seen.has(file)) this.#cache.delete(file);
    }
    return { complete: failures.length === 0, ids, files: seen.size, failures };
  }
}

export interface CleanupReport {
  /** `disabled`: settings turned cleanup off. `locked`: another CUELO process is running a pass. */
  skipped: "disabled" | "locked" | null;
  /** Whether the first scan saw every reference source. */
  complete: boolean;
  records: number;
  /** Records whose orphan countdown started in this pass. */
  marked: string[];
  /** Records found referenced again, so their countdown was cleared. */
  reset: string[];
  deleted: string[];
  /** Sent attachments whose conversation reference was found, so their handoff protection ended. */
  handedOver: string[];
  staleUploadsRemoved: number;
  failures: string[];
}

/**
 * One cleanup pass, run by at most one process sharing the agent folder. A managed attachment that
 * no session file, draft, or hold (in any process) refers to gets `orphanSince` on the first
 * complete scan that shows it; any later reference clears it. Once it has stayed unreferenced for
 * the grace period, a fresh scan and the store's own checks must agree before the file is deleted.
 */
export async function runAttachmentCleanupPass(
  store: AttachmentStore,
  { settings, scanner }: { settings: AttachmentSettings; scanner: AttachmentReferenceScanner },
): Promise<CleanupReport> {
  const report: CleanupReport = { skipped: null, complete: false, records: 0, marked: [], reset: [], deleted: [], handedOver: [], staleUploadsRemoved: 0, failures: [] };
  if (!settings.autoCleanupEnabled) {
    report.skipped = "disabled";
    return report;
  }
  const releaseLock = await store.acquireCleanupLock();
  if (!releaseLock) {
    report.skipped = "locked";
    return report;
  }
  try {
    await runLockedPass(store, scanner, report);
    report.staleUploadsRemoved = await store.removeStaleUploads(STALE_UPLOAD_MS).catch((error: unknown) => {
      report.failures.push(`stale uploads: ${(error as Error).message}`);
      return 0;
    });
  } finally {
    await releaseLock();
  }
  return report;
}

async function runLockedPass(store: AttachmentStore, scanner: AttachmentReferenceScanner, report: CleanupReport): Promise<void> {
  const sources = { sessionsDir: store.sessionsDir, customSessionFilesDir: store.customSessionFilesDir };

  const records = await store.listRecords();
  report.records = records.length;
  // Nothing managed, nothing to decide: skip reading the session folder entirely.
  if (records.length === 0) {
    report.complete = true;
    return;
  }
  const handoffs = await store.readHandoffs();
  // Ending a handoff needs the conversation file as it is now, never a cached earlier read.
  const sessions = await scanner.scan(sources, { fresh: handoffs.ids.size > 0 });
  const drafts = await store.readDraftReferences();
  const leases = await store.liveLeaseIds();
  report.complete = sessions.complete && drafts.complete && leases.complete && handoffs.complete;
  report.failures.push(...sessions.failures);
  if (!drafts.complete) report.failures.push("a draft record could not be read");
  if (!leases.complete) report.failures.push("the lease folder could not be listed");
  if (!handoffs.complete) report.failures.push("a sent-attachment handoff could not be read");

  // A sent attachment stays protected until a complete scan shows the conversation recorded it.
  if (sessions.complete) {
    for (const id of handoffs.ids) {
      if (!sessions.ids.has(id)) continue;
      try {
        await store.removeHandoff(id);
        report.handedOver.push(id);
      } catch (error) {
        report.failures.push(`handoff ${id}: ${(error as Error).message}`);
      }
    }
  }

  const now = store.now();
  const candidates: string[] = [];
  for (const record of records) {
    const referenced = sessions.ids.has(record.id) || drafts.ids.has(record.id) || leases.ids.has(record.id) || handoffs.ids.has(record.id);
    if (referenced) {
      // A reference found by a partial scan is still a real reference.
      if (record.orphanSince !== null) {
        store.writeRecord({ ...record, orphanSince: null });
        report.reset.push(record.id);
      }
      continue;
    }
    if (!report.complete) continue;
    if (record.orphanSince === null) {
      store.writeRecord({ ...record, orphanSince: new Date(now).toISOString() });
      report.marked.push(record.id);
    } else if (now - Date.parse(record.orphanSince) >= ATTACHMENT_ORPHAN_GRACE_MS) {
      candidates.push(record.id);
    }
  }

  if (candidates.length > 0) {
    // Re-list and re-read every reference source, bypassing the cache, right before deleting anything.
    const recheck = await scanner.scan(sources, { fresh: true });
    if (!recheck.complete) {
      report.failures.push(...recheck.failures);
    } else {
      for (const id of candidates) {
        if (recheck.ids.has(id)) {
          const record = await store.readRecord(id);
          if (record?.orphanSince) {
            store.writeRecord({ ...record, orphanSince: null });
            report.reset.push(id);
          }
          continue;
        }
        try {
          if (await store.deleteOrphan(id, ATTACHMENT_ORPHAN_GRACE_MS)) report.deleted.push(id);
        } catch (error) {
          report.failures.push(`delete ${id}: ${(error as Error).message}`);
        }
      }
    }
  }
}

const FIRST_PASS_DELAY_MS = 60_000;

interface CleanupSchedulerState {
  running: boolean;
  scanner: AttachmentReferenceScanner;
}

declare global {
  var __cueloAttachmentCleanupScheduler: CleanupSchedulerState | undefined;
}

/**
 * Starts the cleanup schedule once per server process: a minute after startup, then every 24 hours.
 * Called from `instrumentation.ts`; the `globalThis` state keeps reloads from adding timers.
 */
export function ensureAttachmentCleanupScheduler(): void {
  if (globalThis.__cueloAttachmentCleanupScheduler) return;
  const state: CleanupSchedulerState = { running: false, scanner: new AttachmentReferenceScanner() };
  globalThis.__cueloAttachmentCleanupScheduler = state;
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const settings = await readAttachmentSettings(getAgentDir());
      const report = await runAttachmentCleanupPass(getAttachmentStore(), { settings, scanner: state.scanner });
      if (report.marked.length || report.reset.length || report.deleted.length || report.staleUploadsRemoved || report.failures.length) {
        console.info(
          `[attachments] cleanup: ${report.records} managed, ${report.marked.length} newly unreferenced, `
          + `${report.reset.length} referenced again, ${report.deleted.length} deleted, ${report.staleUploadsRemoved} stale uploads removed`
          + (report.failures.length ? `; nothing was deleted on an incomplete view: ${report.failures.slice(0, 3).join("; ")}` : ""),
        );
      }
    } catch (error) {
      console.error("[attachments] cleanup failed:", error);
    } finally {
      state.running = false;
    }
  };
  setTimeout(() => void tick(), FIRST_PASS_DELAY_MS).unref?.();
  setInterval(() => void tick(), DAY_MS).unref?.();
  console.info("[attachments] cleanup scheduled: first pass in 60s, then every 24h");
}
