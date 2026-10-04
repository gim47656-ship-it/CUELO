import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir, getCustomSessionFilesDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { normalizeAttachmentSettings, type AttachmentSettings, type AttachmentSettingsPatch } from "./attachment-settings";
import { isAttachmentDraftId, isManagedAttachmentId } from "./document-attachments";

/**
 * Lifecycle store for chat attachments under `<agentDir>/cuelo-attachments`.
 *
 * A managed upload lives at `<root>/<sessionId | new>/<id>/<name>` with a record at
 * `<root>/.cuelo-managed/attachments/<id>.json`. Files without a record — everything saved before
 * managed uploads existed, and anything whose record is unreadable — are never deleted here.
 * Composer drafts register the ids they hold in `<root>/.cuelo-managed/drafts/<draftId>.json`.
 * In-process holds (uploads in flight, transcription leases, draft updates) keep cleanup away.
 */

export const ATTACHMENTS_DIR_NAME = "cuelo-attachments";
export const ATTACHMENT_SETTINGS_FILE_NAME = "cuelo-attachment-settings.json";
const MANAGED_DIR_NAME = ".cuelo-managed";
const UNSENT_SESSION_FOLDER = "new";
const SESSION_FOLDER_RE = /^(?:new|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_FILE_NAME_CHARS = 150;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;
export const MAX_DRAFT_ATTACHMENTS = 256;
const STAGING_SUFFIX = ".part";
const LEASE_SUFFIX = ".lease";
const DELETE_MARKER_SUFFIX = ".deleting";
const CLEANUP_LOCK_SUFFIX = ".cleanup-lock";
/** How long a hold waits for another process's deletion of the same id before giving up. */
const DELETION_WAIT_LIMIT_MS = 30_000;
const DELETION_WAIT_POLL_MS = 50;

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

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

/**
 * The saved settings. A missing file means the defaults; a file that exists but does not parse
 * keeps the upload default yet turns automatic cleanup off, so a damaged file never deletes.
 */
export async function readAttachmentSettings(agentDir: string): Promise<AttachmentSettings> {
  let text: string;
  try {
    text = await readFile(path.join(agentDir, ATTACHMENT_SETTINGS_FILE_NAME), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return normalizeAttachmentSettings({});
    throw error;
  }
  try {
    return normalizeAttachmentSettings(JSON.parse(text));
  } catch {
    return { ...normalizeAttachmentSettings({}), autoCleanupEnabled: false };
  }
}

export async function writeAttachmentSettings(agentDir: string, patch: AttachmentSettingsPatch): Promise<AttachmentSettings> {
  const next = { ...await readAttachmentSettings(agentDir), ...patch };
  await mkdir(agentDir, { recursive: true });
  writePrivateFileAtomicSync(
    path.join(agentDir, ATTACHMENT_SETTINGS_FILE_NAME),
    `${JSON.stringify({ uploadLimitMb: next.uploadLimitMb, autoCleanupEnabled: next.autoCleanupEnabled }, null, 2)}\n`,
  );
  return next;
}

// ---------------------------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------------------------

/** What `withManagedAttachment` hands its callback. */
export interface ManagedAttachmentRef {
  id: string;
  path: string;
  size: number;
  mimeType: string;
}

export interface ManagedAttachmentRecord extends ManagedAttachmentRef {
  version: 1;
  /** The stored basename (after `toSafeAttachmentFileName`). */
  name: string;
  sessionId: string | null;
  createdAt: string;
  /** When a complete scan first found nothing referring to the file; null while referenced. */
  orphanSince: string | null;
}

function parseRecord(value: unknown, id: string): ManagedAttachmentRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ManagedAttachmentRecord>;
  if (
    record.version !== 1
    || record.id !== id
    || typeof record.path !== "string"
    || typeof record.name !== "string"
    || typeof record.mimeType !== "string"
    || typeof record.size !== "number"
    || !Number.isSafeInteger(record.size)
    || record.size < 0
    || typeof record.createdAt !== "string"
    || !(record.sessionId === null || typeof record.sessionId === "string")
    || !(record.orphanSince === null || (typeof record.orphanSince === "string" && Number.isFinite(Date.parse(record.orphanSince))))
  ) {
    return null;
  }
  return {
    version: 1,
    id,
    path: record.path,
    name: record.name,
    size: record.size,
    mimeType: record.mimeType,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    orphanSince: record.orphanSince,
  };
}

/** `busy`: another CUELO process is deleting the file right now; retrying later is safe. */
export type ManagedAttachmentErrorCode = "invalid_id" | "not_found" | "busy";

/** `withManagedAttachment` could not lend the file: a malformed id, or no managed file behind it. */
export class ManagedAttachmentError extends Error {
  override readonly name = "ManagedAttachmentError";
  constructor(readonly code: ManagedAttachmentErrorCode, message: string) {
    super(message);
  }
}

/** A draft update named ids that are not managed attachments; the previous set stays. */
export class UnknownAttachmentError extends Error {
  override readonly name = "UnknownAttachmentError";
  constructor(readonly missing: string[]) {
    super(`Unknown attachment ids: ${missing.join(", ")}`);
  }
}

export interface AttachmentStoreOptions {
  /** `<agentDir>/cuelo-attachments`. */
  root: string;
  /** OMP's session directory: every session, branch, fork, and subagent transcript lives below it. */
  sessionsDir: string;
  /** OMP's registry of session files kept outside `sessionsDir` (`--session <path>`). */
  customSessionFilesDir: string;
  /** How long a hold waits for another process's deletion of the same id; defaults to 30 s. */
  deletionWaitLimitMs?: number;
  now?: () => number;
  /** In-process holds to share; the default store passes the process-wide state. */
  state?: AttachmentStoreState;
}

export interface StartedUpload {
  id: string;
  stagingPath: string;
  /** Drops the in-flight hold and its lease file; call once, after the upload committed or failed. */
  release: () => Promise<void>;
}

export interface CommitUploadInput {
  id: string;
  stagingPath: string;
  sessionId: string | null;
  draftId: string;
  fileName: string;
  size: number;
  mimeType: string;
}

export interface DraftReferences {
  /** False when any draft record could not be read: its ids are unknown, so nothing may be deleted. */
  complete: boolean;
  ids: Set<string>;
}

/** Whether a lease or marker owner is still running. Only a definite "no such process" counts as dead. */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function parsePid(text: string): number | null {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) && Number(text) > 0 ? Number(text) : null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** In-process holds and queues. Shared through `globalThis` so a reloaded module keeps them. */
export interface AttachmentStoreState {
  /** Upload, lease, and draft-update holds per id; mirrored by lease files on disk. */
  holds: Map<string, number>;
  /** Deletions in progress; holders wait for them, then find the record gone. */
  deleting: Map<string, Promise<void>>;
  draftQueues: Map<string, Promise<unknown>>;
}

export class AttachmentStore {
  readonly root: string;
  readonly sessionsDir: string;
  readonly customSessionFilesDir: string;
  readonly now: () => number;
  readonly #deletionWaitLimitMs: number;
  readonly #holds: Map<string, number>;
  readonly #deleting: Map<string, Promise<void>>;
  readonly #draftQueues: Map<string, Promise<unknown>>;

  constructor({ root, sessionsDir, customSessionFilesDir, now = Date.now, state, deletionWaitLimitMs = DELETION_WAIT_LIMIT_MS }: AttachmentStoreOptions) {
    this.root = root;
    this.sessionsDir = sessionsDir;
    this.customSessionFilesDir = customSessionFilesDir;
    this.now = now;
    this.#deletionWaitLimitMs = deletionWaitLimitMs;
    this.#holds = state?.holds ?? new Map();
    this.#deleting = state?.deleting ?? new Map();
    this.#draftQueues = state?.draftQueues ?? new Map();
  }

  get #managedDir(): string {
    return path.join(this.root, MANAGED_DIR_NAME);
  }

  get #recordsDir(): string {
    return path.join(this.#managedDir, "attachments");
  }

  get #draftsDir(): string {
    return path.join(this.#managedDir, "drafts");
  }

  get #uploadsDir(): string {
    return path.join(this.#managedDir, "uploads");
  }

  /** `<id>.json` per sent attachment whose conversation reference has not been seen yet. */
  get #handoffsDir(): string {
    return path.join(this.#managedDir, "handoffs");
  }

  #handoffPath(id: string): string {
    return path.join(this.#handoffsDir, `${id}.json`);
  }

  /**
   * Cross-process protection. Every hold is a `<id>~<pid>~<nonce>.lease` file here; a deletion first
   * creates `<id>.deleting` (holding its pid), then looks for leases. A holder creates its lease,
   * then looks for the marker. Both create before they check, so at least one sees the other.
   */
  get #leasesDir(): string {
    return path.join(this.#managedDir, "leases");
  }

  #recordPath(id: string): string {
    return path.join(this.#recordsDir, `${id}.json`);
  }

  #draftPath(draftId: string): string {
    return path.join(this.#draftsDir, `${draftId}.json`);
  }

  /** The canonical root, refusing a managed folder that a junction or symlink redirects. */
  async #ensureManagedDirs(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const realRoot = await realpath(this.root);
    for (const dir of ["attachments", "drafts", "uploads", "leases", "handoffs"]) {
      await mkdir(path.join(realRoot, MANAGED_DIR_NAME, dir), { recursive: true });
    }
    const managed = path.join(realRoot, MANAGED_DIR_NAME);
    if (await realpath(managed) !== managed) throw new Error("Attachment metadata folder resolves outside the attachment root");
    return realRoot;
  }

  /** Whether this process holds or is deleting `id`. Other processes are seen through `liveLeaseIds`. */
  isHeld(id: string): boolean {
    return (this.#holds.get(id) ?? 0) > 0 || this.#deleting.has(id);
  }

  /**
   * Lease-folder entries named `<key>~<pid>[~<nonce>]<suffix>`. An entry whose owner has certainly
   * exited (ESRCH) is removed; every other entry, including one whose pid cannot be read, counts as
   * live. `complete` is false when the folder could not be listed.
   */
  async #liveEntries(suffix: string): Promise<{ complete: boolean; entries: { name: string; key: string }[] }> {
    let names: string[];
    try {
      names = await readdir(this.#leasesDir);
    } catch (error) {
      return { complete: errorCode(error) === "ENOENT", entries: [] };
    }
    const entries: { name: string; key: string }[] = [];
    for (const name of names) {
      if (!name.endsWith(suffix)) continue;
      const [key = "", pidText = ""] = name.slice(0, -suffix.length).split("~");
      const pid = parsePid(pidText);
      if (pid !== null && !isProcessAlive(pid)) {
        await unlink(path.join(this.#leasesDir, name)).catch(() => {});
        continue;
      }
      entries.push({ name, key });
    }
    return { complete: true, entries };
  }

  /**
   * The ids some running process — this one or another sharing the agent folder — holds.
   * When `complete` is false no id may be treated as free.
   */
  async liveLeaseIds(): Promise<{ complete: boolean; ids: Set<string> }> {
    const { complete, entries } = await this.#liveEntries(LEASE_SUFFIX);
    const ids = new Set<string>(this.#holds.keys());
    for (const { key } of entries) ids.add(key);
    return { complete, ids };
  }

  /**
   * Holds every id against cleanup, in this process and on disk, once no deletion of it is running.
   * Waits at most `DELETION_WAIT_LIMIT_MS` for another process's deletion, then fails. The release
   * removes the lease files.
   */
  async #hold(ids: readonly string[]): Promise<() => Promise<void>> {
    await this.#ensureManagedDirs();
    const started = Date.now();
    while (true) {
      const running = ids.flatMap((id) => this.#deleting.get(id) ?? []);
      if (running.length > 0) {
        await Promise.all(running);
        continue;
      }
      // Pin in this process first, in the same tick as the check above.
      for (const id of ids) this.#holds.set(id, (this.#holds.get(id) ?? 0) + 1);
      const leases: string[] = [];
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        for (const lease of leases.splice(0)) await unlink(lease).catch(() => {});
        for (const id of ids) {
          const count = (this.#holds.get(id) ?? 0) - 1;
          if (count > 0) this.#holds.set(id, count);
          else this.#holds.delete(id);
        }
      };
      try {
        for (const id of ids) {
          const lease = path.join(this.#leasesDir, `${id}~${process.pid}~${randomBytes(6).toString("hex")}${LEASE_SUFFIX}`);
          await writeFile(lease, "", { flag: "wx", mode: 0o600 });
          leases.push(lease);
        }
        // Created first, checked second: a deleter that missed our lease has its marker visible here.
        const markers = await this.#liveEntries(DELETE_MARKER_SUFFIX);
        if (markers.complete && !markers.entries.some(({ key }) => ids.includes(key))) return release;
      } catch (error) {
        await release();
        throw error;
      }
      // Another process is deleting one of the ids: step back, let it finish, then look again.
      await release();
      if (Date.now() - started > this.#deletionWaitLimitMs) {
        throw new ManagedAttachmentError("busy", "Attachment is being cleaned up by another CUELO process; try again");
      }
      await sleep(DELETION_WAIT_POLL_MS);
    }
  }

  /**
   * The cross-process cleanup lock: a `cleanup~<pid>~<nonce>.cleanup-lock` entry that only counts
   * when no other live one exists. Two racing processes may both step back; neither deletes then.
   * Returns the release, or null when another process runs a pass.
   */
  async acquireCleanupLock(): Promise<(() => Promise<void>) | null> {
    await this.#ensureManagedDirs();
    const name = `cleanup~${process.pid}~${randomBytes(6).toString("hex")}${CLEANUP_LOCK_SUFFIX}`;
    const lock = path.join(this.#leasesDir, name);
    await writeFile(lock, "", { flag: "wx", mode: 0o600 });
    const release = async () => {
      await unlink(lock).catch(() => {});
    };
    const others = await this.#liveEntries(CLEANUP_LOCK_SUFFIX).catch(() => null);
    if (!others?.complete || others.entries.some((entry) => entry.name !== name)) {
      await release();
      return null;
    }
    return release;
  }

  async #inDraftQueue<T>(draftId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#draftQueues.get(draftId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.#draftQueues.set(draftId, next);
    try {
      return await next;
    } finally {
      if (this.#draftQueues.get(draftId) === next) this.#draftQueues.delete(draftId);
    }
  }

  async readRecord(id: string): Promise<ManagedAttachmentRecord | null> {
    let text: string;
    try {
      text = await readFile(this.#recordPath(id), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return null;
      throw error;
    }
    try {
      return parseRecord(JSON.parse(text), id);
    } catch {
      return null;
    }
  }

  writeRecord(record: ManagedAttachmentRecord): void {
    writePrivateFileAtomicSync(this.#recordPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Every record that parses. A record that does not is skipped, which keeps its file forever. */
  async listRecords(): Promise<ManagedAttachmentRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.#recordsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const records: ManagedAttachmentRecord[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!isManagedAttachmentId(id)) continue;
      const record = await this.readRecord(id).catch(() => null);
      if (record) records.push(record);
    }
    return records;
  }

  /** Starts an upload: a fresh id, its staging path, and a hold that keeps cleanup away. */
  async beginUpload(): Promise<StartedUpload> {
    const realRoot = await this.#ensureManagedDirs();
    const id = `att_${randomBytes(16).toString("hex")}`;
    const release = await this.#hold([id]);
    return { id, stagingPath: path.join(realRoot, MANAGED_DIR_NAME, "uploads", `${id}${STAGING_SUFFIX}`), release };
  }

  /** Removes the staging file of an upload that will not be committed; a missing file is fine. */
  async discardStagedUpload(stagingPath: string): Promise<void> {
    if (path.dirname(stagingPath) !== path.join(await realpath(this.root), MANAGED_DIR_NAME, "uploads")) return;
    await unlink(stagingPath).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }

  /**
   * Moves a staged upload to `<root>/<session | new>/<id>/<safe name>`, writes its record, and adds
   * it to the draft. Until the record exists the file is unmanaged, so a crash in between keeps it.
   */
  async commitUpload(input: CommitUploadInput): Promise<ManagedAttachmentRecord> {
    const realRoot = await this.#ensureManagedDirs();
    // Session ids match case-insensitively; one lowercase folder keeps the realpath check exact on Windows.
    const folder = (input.sessionId ?? UNSENT_SESSION_FOLDER).toLowerCase();
    if (!SESSION_FOLDER_RE.test(folder)) throw new Error("Invalid attachment folder");
    const directory = path.join(realRoot, folder);
    await mkdir(directory, { recursive: true });
    // A junction or symlink planted at the session folder must not redirect the write.
    if (path.relative(realRoot, await realpath(directory)) !== folder) {
      throw new Error("Attachment folder resolves outside the attachment root");
    }
    const idDirectory = path.join(directory, input.id);
    await mkdir(idDirectory);
    const name = toSafeAttachmentFileName(input.fileName);
    const target = path.join(idDirectory, name);
    await rename(input.stagingPath, target);

    const record: ManagedAttachmentRecord = {
      version: 1,
      id: input.id,
      path: target,
      name,
      size: input.size,
      mimeType: input.mimeType,
      sessionId: input.sessionId?.toLowerCase() ?? null,
      createdAt: new Date(this.now()).toISOString(),
      orphanSince: null,
    };
    try {
      this.writeRecord(record);
    } catch (error) {
      // Nobody has seen this file yet; without its record it would never be cleaned up.
      await unlink(target).catch(() => {});
      await rmdir(idDirectory).catch(() => {});
      throw error;
    }
    await this.#inDraftQueue(input.draftId, async () => {
      const current = await this.#readDraft(input.draftId);
      this.#writeDraft(input.draftId, [...new Set([...current, input.id])]);
    });
    return record;
  }

  async #readDraft(draftId: string): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.#draftPath(draftId), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    const parsed = JSON.parse(text) as { attachmentIds?: unknown };
    if (!Array.isArray(parsed.attachmentIds)) throw new Error(`Draft record ${draftId} is malformed`);
    return parsed.attachmentIds.filter(isManagedAttachmentId);
  }

  #writeDraft(draftId: string, attachmentIds: string[]): void {
    writePrivateFileAtomicSync(
      this.#draftPath(draftId),
      `${JSON.stringify({ version: 1, draftId, attachmentIds, updatedAt: new Date(this.now()).toISOString() }, null, 2)}\n`,
    );
  }

  /**
   * Replaces the ids `draftId` protects. Every id must be a managed attachment that still exists;
   * otherwise nothing changes. An empty list removes the draft record.
   *
   * `sentAttachmentIds` names ids that leave the draft because they were sent. Each one that still
   * exists gets a handoff record on disk before the draft changes, so it stays protected until a
   * complete scan finds the conversation's reference to it. If the handoff cannot be written the
   * update fails and the previous draft set stays. Ids that are (back) in the new set lose their
   * handoff once the new draft is saved.
   */
  async setDraftAttachments(draftId: string, attachmentIds: readonly string[], sentAttachmentIds: readonly string[] = []): Promise<string[]> {
    if (!isAttachmentDraftId(draftId)) throw new Error("Invalid draft id");
    const normalizedDraftId = draftId.toLowerCase();
    const ids = [...new Set(attachmentIds)];
    if (ids.length > MAX_DRAFT_ATTACHMENTS || !ids.every(isManagedAttachmentId)) throw new Error("Invalid attachment ids");
    const sent = [...new Set(sentAttachmentIds)].filter((id) => !ids.includes(id));
    if (sent.length > MAX_DRAFT_ATTACHMENTS || !sent.every(isManagedAttachmentId)) throw new Error("Invalid attachment ids");
    await this.#ensureManagedDirs();
    const release = await this.#hold([...ids, ...sent]);
    try {
      const missing: string[] = [];
      for (const id of ids) {
        if (!await this.readRecord(id)) missing.push(id);
      }
      if (missing.length > 0) throw new UnknownAttachmentError(missing);
      // A sent id whose record is already gone has nothing left to protect.
      const handedOff: string[] = [];
      for (const id of sent) {
        if (await this.readRecord(id)) handedOff.push(id);
      }
      await this.#inDraftQueue(normalizedDraftId, async () => {
        for (const id of handedOff) {
          writePrivateFileAtomicSync(
            this.#handoffPath(id),
            `${JSON.stringify({ version: 1, id, draftId: normalizedDraftId, handedOffAt: new Date(this.now()).toISOString() }, null, 2)}\n`,
          );
        }
        if (ids.length > 0) {
          this.#writeDraft(normalizedDraftId, ids);
        } else {
          await unlink(this.#draftPath(normalizedDraftId)).catch((error: unknown) => {
            if (errorCode(error) !== "ENOENT") throw error;
          });
        }
        // The new draft now protects these ids itself.
        for (const id of ids) await this.removeHandoff(id);
      });
      return ids;
    } finally {
      await release();
    }
  }

  async readDraftReferences(): Promise<DraftReferences> {
    const ids = new Set<string>();
    let names: string[];
    try {
      names = await readdir(this.#draftsDir);
    } catch (error) {
      return { complete: errorCode(error) === "ENOENT", ids };
    }
    let complete = true;
    for (const name of names) {
      // Leftover atomic-write temp files start with a dot; they are not drafts.
      if (name.startsWith(".") || !name.endsWith(".json")) continue;
      try {
        for (const id of await this.#readDraft(name.slice(0, -".json".length))) ids.add(id);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") complete = false;
      }
    }
    return { complete, ids };
  }

  /**
   * Ids of sent attachments still waiting for their conversation reference. The file name alone
   * protects an id; a record that does not parse also makes the view incomplete.
   */
  async readHandoffs(): Promise<DraftReferences> {
    const ids = new Set<string>();
    let names: string[];
    try {
      names = await readdir(this.#handoffsDir);
    } catch (error) {
      return { complete: errorCode(error) === "ENOENT", ids };
    }
    let complete = true;
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
      if (!isManagedAttachmentId(id)) {
        complete = false;
        continue;
      }
      ids.add(id);
      try {
        const parsed = JSON.parse(await readFile(path.join(this.#handoffsDir, name), "utf8")) as { id?: unknown };
        if (parsed.id !== id) complete = false;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") complete = false;
      }
    }
    return { complete, ids };
  }

  /** Ends the handoff protection of `id`; a missing record is fine. */
  async removeHandoff(id: string): Promise<void> {
    if (!isManagedAttachmentId(id)) return;
    await unlink(this.#handoffPath(id)).catch((error: unknown) => {
      if (errorCode(error) !== "ENOENT") throw error;
    });
  }

  /**
   * Where the record's file sits, or null unless it is exactly `<root>/<folder>/<id>/<name>`
   * with no junction in between. `fileMissing` marks a record whose file is already gone.
   */
  async #verifiedLocation(record: ManagedAttachmentRecord): Promise<{ idDirectory: string; fileMissing: boolean } | null> {
    let realRoot: string;
    try {
      realRoot = await realpath(this.root);
    } catch {
      return null;
    }
    const parts = path.relative(realRoot, record.path).split(path.sep);
    if (
      parts.length !== 3
      || !SESSION_FOLDER_RE.test(parts[0]!)
      || parts[1] !== record.id
      || parts[2] !== record.name
      || parts[2] === "."
      || parts[2] === ".."
      || path.join(realRoot, ...parts) !== record.path
    ) {
      return null;
    }
    const idDirectory = path.join(realRoot, parts[0]!, parts[1]!);
    try {
      if (await realpath(idDirectory) !== idDirectory) return null;
    } catch {
      return null;
    }
    try {
      return (await lstat(record.path)).isFile() ? { idDirectory, fileMissing: false } : null;
    } catch (error) {
      return errorCode(error) === "ENOENT" ? { idDirectory, fileMissing: true } : null;
    }
  }

  /** Runs `consume` while the file cannot be cleaned up. Audio transcription reads uploads only here. */
  async withManagedAttachment<T>(id: string, consume: (attachment: ManagedAttachmentRef) => Promise<T>): Promise<T> {
    if (!isManagedAttachmentId(id)) throw new ManagedAttachmentError("invalid_id", "Invalid attachment id");
    const release = await this.#hold([id]);
    try {
      const record = await this.readRecord(id);
      const location = record ? await this.#verifiedLocation(record) : null;
      if (!record || !location || location.fileMissing) throw new ManagedAttachmentError("not_found", "Attachment not found");
      return await consume({ id, path: record.path, size: record.size, mimeType: record.mimeType });
    } finally {
      await release();
    }
  }

  /**
   * Deletes one managed attachment whose record still says it has been unreferenced for at least
   * `graceMs` and that no draft or hold — in this process or another — refers to. The caller holds
   * the cleanup lock and has already rescanned every session. Returns whether the file is gone.
   */
  async deleteOrphan(id: string, graceMs: number): Promise<boolean> {
    if (this.isHeld(id)) return false;
    let finish!: () => void;
    this.#deleting.set(id, new Promise<void>((resolve) => { finish = resolve; }));
    let marker: string | null = null;
    try {
      await this.#ensureManagedDirs();
      const candidate = path.join(this.#leasesDir, `${id}~${process.pid}~${randomBytes(6).toString("hex")}${DELETE_MARKER_SUFFIX}`);
      await writeFile(candidate, "", { flag: "wx", mode: 0o600 });
      marker = candidate;
      // Marker first, leases second: a holder that missed the marker has its lease visible here.
      const leases = await this.liveLeaseIds();
      if (!leases.complete || leases.ids.has(id)) return false;
      const handoffs = await this.readHandoffs();
      if (!handoffs.complete || handoffs.ids.has(id)) return false;
      const record = await this.readRecord(id);
      if (!record?.orphanSince || this.now() - Date.parse(record.orphanSince) < graceMs) return false;
      const drafts = await this.readDraftReferences();
      if (!drafts.complete || drafts.ids.has(id)) return false;
      const location = await this.#verifiedLocation(record);
      if (!location) return false;
      if (!location.fileMissing) await unlink(record.path);
      await rmdir(location.idDirectory).catch(() => {});
      await unlink(this.#recordPath(id)).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
      return true;
    } finally {
      if (marker) await unlink(marker).catch(() => {});
      this.#deleting.delete(id);
      finish();
    }
  }

  /** Removes staging files that no running upload in any process owns and that are older than `maxAgeMs`. */
  async removeStaleUploads(maxAgeMs: number): Promise<number> {
    let names: string[];
    try {
      names = await readdir(this.#uploadsDir);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return 0;
      throw error;
    }
    const leases = await this.liveLeaseIds();
    if (!leases.complete) return 0;
    let removed = 0;
    for (const name of names) {
      const id = name.endsWith(STAGING_SUFFIX) ? name.slice(0, -STAGING_SUFFIX.length) : "";
      if (!isManagedAttachmentId(id) || leases.ids.has(id)) continue;
      const file = path.join(this.#uploadsDir, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || this.now() - info.mtimeMs < maxAgeMs) continue;
        await unlink(file);
        removed += 1;
      } catch {
        // Gone already, or locked by a writer; the next pass looks again.
      }
    }
    return removed;
  }
}

declare global {
  var __cueloAttachmentStoreStates: Map<string, AttachmentStoreState> | undefined;
}

/**
 * The store for the current agent directory. Holds and queues live on `globalThis`, so they stay
 * shared across route bundles and survive dev reloads, while each module version builds its own
 * store object and therefore throws its own error classes.
 */
export function getAttachmentStore(): AttachmentStore {
  const agentDir = getAgentDir();
  const root = path.join(agentDir, ATTACHMENTS_DIR_NAME);
  if (defaultStore?.root === root) return defaultStore;
  const states = globalThis.__cueloAttachmentStoreStates ??= new Map();
  let state = states.get(root);
  if (!state) {
    state = { holds: new Map(), deleting: new Map(), draftQueues: new Map() };
    states.set(root, state);
  }
  defaultStore = new AttachmentStore({
    root,
    sessionsDir: getSessionsDir(agentDir),
    customSessionFilesDir: getCustomSessionFilesDir(agentDir),
    state,
  });
  return defaultStore;
}

let defaultStore: AttachmentStore | undefined;

/** Lends the managed upload `id` to `consume` and keeps cleanup from deleting it until `consume` settles. */
export function withManagedAttachment<T>(id: string, consume: (attachment: ManagedAttachmentRef) => Promise<T>): Promise<T> {
  return getAttachmentStore().withManagedAttachment(id, consume);
}
