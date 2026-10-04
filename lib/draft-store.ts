import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import {
  normalizeAttachedDocuments,
  updateAttachmentDraft,
  type AttachedDocument,
} from "./document-attachments";
import type { RestoredQueuedMessage } from "./omp-types";

export interface ChatDraftImage {
  data: string;
  mimeType: string;
}
export type ChatDraftDocument = AttachedDocument;


export interface ChatDraft {
  value: string;
  images: ChatDraftImage[];
  documents: ChatDraftDocument[];
}

/**
 * How a submission ended, as far as the sender knows. `accepted`: the server took the prompt.
 * `returned`: it never went out and its attachments are back in a draft. `unknown`: neither is
 * certain, so the attachments it carried stay protected.
 */
export type SubmissionOutcome = "accepted" | "returned" | "unknown";

type DraftReferenceSender = (draftId: string, attachmentIds: string[], sentAttachmentIds: string[]) => Promise<unknown>;

const drafts = new Map<string, ChatDraft>();
const RELOAD_DRAFTS_KEY = "ompweb-drafts-for-reload-v1";
let reloadDraftsRestored = false;

// ── Attachment references ────────────────────────────────────────────────
// The server keeps a saved attachment while some draft lists it. Each draft key owns one
// draftId; the set sent for a draftId is every managed attachment in its drafts, plus the ones a
// submission still carries and the ones an upload just saved but no draft holds yet.
const draftIds = new Map<string, string>();
/** Last set the server confirmed for a draftId. A draftId stays here until `[]` is confirmed. */
const syncedReferences = new Map<string, string>();
const STALE_REFERENCES = "\u0000stale";
const submissionHolds = new Map<number, { draftId: string; ids: string[] }>();
let nextSubmissionHold = 0;
const pendingUploads = new Map<string, number>();
const awaitingAdoption = new Map<string, Set<string>>();
/**
 * Attachments of a submission the server accepted. Accepting is not saving: a new session is
 * written to disk only after its first reply. These ids go out as `sentAttachmentIds` when the
 * draft drops them, so the server keeps them until it finds them in a session file.
 */
const handoffs = new Map<string, Set<string>>();
const keyReferenceSignatures = new Map<string, string>();
const inflightPuts = new Map<string, Promise<void>>();
let referenceSender: DraftReferenceSender | null = typeof window === "undefined"
  ? null
  : (draftId, attachmentIds, sentAttachmentIds) => updateAttachmentDraft(
      draftId,
      attachmentIds,
      sentAttachmentIds.length ? { sentAttachmentIds } : {},
    );
let flushPromise: Promise<void> | null = null;
let flushAgain = false;

function restoreDraftsAfterReload(): void {
  if (reloadDraftsRestored || typeof sessionStorage === "undefined") return;
  reloadDraftsRestored = true;
  const raw = sessionStorage.getItem(RELOAD_DRAFTS_KEY);
  if (!raw) return;
  sessionStorage.removeItem(RELOAD_DRAFTS_KEY);
  try {
    const entries = JSON.parse(raw) as [string, ChatDraft & { draftId?: unknown }][];
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") continue;
      const draft = entry[1];
      if (
        !draft
        || typeof draft.value !== "string"
        || !Array.isArray(draft.images)
        || !Array.isArray(draft.documents)
      ) continue;
      drafts.set(entry[0], cloneDraft(draft));
      if (typeof draft.draftId === "string" && draft.draftId) {
        draftIds.set(entry[0], draft.draftId);
        // The server may hold an older set for this draft; send the restored one.
        syncedReferences.set(draft.draftId, STALE_REFERENCES);
      }
      noteReferenceChange(entry[0]);
    }
  } catch {
    // 손상된 임시 snapshot은 현재 메모리 draft를 덮지 않는다.
  }
}

export function persistDraftsForReload(): { ok: true } | { ok: false; error: string } {
  if (typeof sessionStorage === "undefined") return { ok: false, error: "sessionStorage unavailable" };
  try {
    sessionStorage.setItem(
      RELOAD_DRAFTS_KEY,
      JSON.stringify([...drafts.entries()].map(([key, draft]) => {
        const draftId = draftIds.get(key);
        return [key, draftId ? { ...cloneDraft(draft), draftId } : cloneDraft(draft)];
      })),
    );
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}


function cloneDraft(draft: ChatDraft): ChatDraft {
  return {
    value: draft.value,
    images: draft.images.map((image) => ({ ...image })),
    documents: draft.documents.map((document) => ({ ...document })),
  };
}

function isEmptyDraft(draft: ChatDraft): boolean {
  return !draft.value && draft.images.length === 0 && draft.documents.length === 0;
}

export function getDraft(key: string): ChatDraft | null {
  restoreDraftsAfterReload();
  const draft = drafts.get(key);
  return draft ? cloneDraft(draft) : null;
}

export function setDraft(key: string, draft: ChatDraft): void {
  restoreDraftsAfterReload();
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
  } else {
    drafts.set(key, cloneDraft(draft));
  }
  noteReferenceChange(key);
}

export function clearDraft(key: string): void {
  drafts.delete(key);
  noteReferenceChange(key);
}

export function mergeRestoredSubmissionText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}

export function mergeRestoredQueuedMessages(messages: RestoredQueuedMessage[]): {
  text: string;
  images: ChatDraftImage[];
} {
  return {
    text: messages
      .map(({ text, images }) => images?.length && text === "[Image]" ? "" : text)
      .filter((text) => text.trim())
      .join("\n\n"),
    images: messages.flatMap(({ images }) => images ?? []).map(({ data, mimeType }) => ({ data, mimeType })),
  };
}

export function mergeRestoredSubmissionDraft(
  submittedText: string,
  submittedImages: ChatDraftImage[] | undefined,
  currentText: string,
  currentImages: ChatDraftImage[],
  submittedDocuments: ChatDraftDocument[] | undefined = undefined,
  currentDocuments: ChatDraftDocument[] = [],
): ChatDraft {
  const images = [...(submittedImages ?? []), ...currentImages]
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(({ data, mimeType }) => ({ data, mimeType }));
  const documents = normalizeAttachedDocuments([
    ...(submittedDocuments ?? []),
    ...currentDocuments,
  ]);

  return {
    value: mergeRestoredSubmissionText(submittedText, currentText),
    images,
    documents,
  };
}

export function restoreDraftSubmission(
  key: string,
  text: string,
  images?: ChatDraftImage[],
  documents?: ChatDraftDocument[],
): ChatDraft {
  const current = getDraft(key) ?? { value: "", images: [], documents: [] };
  const restored = mergeRestoredSubmissionDraft(
    text,
    images,
    current.value,
    current.images,
    documents,
    current.documents,
  );
  setDraft(key, restored);
  return restored;
}

export function rekeyDraft(
  previousKey: string,
  nextKey: string,
  currentDraft?: ChatDraft,
): ChatDraft | null {
  if (previousKey === nextKey) return currentDraft ? cloneDraft(currentDraft) : getDraft(nextKey);

  const storedPrevious = getDraft(previousKey);
  const previous = currentDraft && !isEmptyDraft(currentDraft)
    ? cloneDraft(currentDraft)
    : (storedPrevious ?? (currentDraft ? cloneDraft(currentDraft) : null));
  const next = getDraft(nextKey);
  // The surviving draft keeps the destination's draftId; the source's id is released with `[]`
  // only after the destination's set is confirmed (see flushDraftReferences).
  const previousDraftId = draftIds.get(previousKey);
  draftIds.delete(previousKey);
  if (previousDraftId && !draftIds.has(nextKey)) draftIds.set(nextKey, previousDraftId);
  clearDraft(previousKey);
  if (!previous) return next;

  const merged = next
    ? mergeRestoredSubmissionDraft(
        next.value,
        next.images,
        previous.value,
        previous.images,
        next.documents,
        previous.documents,
      )
    : previous;
  setDraft(nextKey, merged);
  return cloneDraft(merged);
}

function managedAttachmentIds(documents: readonly ChatDraftDocument[] | undefined): string[] {
  const ids: string[] = [];
  for (const document of documents ?? []) {
    if (document.attachmentId && !ids.includes(document.attachmentId)) ids.push(document.attachmentId);
  }
  return ids;
}

function createDraftId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  // randomUUID needs a secure context; a LAN address over http still has getRandomValues.
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The draftId uploads and reference updates for this draft key use; created on first use. */
export function getDraftAttachmentId(key: string): string {
  restoreDraftsAfterReload();
  let draftId = draftIds.get(key);
  if (!draftId) {
    draftId = createDraftId();
    draftIds.set(key, draftId);
  }
  return draftId;
}

/**
 * Only a change in a key's attachment set reaches the network; typing into a draft that carries
 * attachments recomputes this short signature and stops there.
 */
function noteReferenceChange(key: string): void {
  const ids = managedAttachmentIds(drafts.get(key)?.documents);
  const draftId = ids.length ? getDraftAttachmentId(key) : draftIds.get(key);
  // An upload can land in a different draft than it started in (rekey, session switch).
  for (const [awaitingDraftId, awaiting] of awaitingAdoption) {
    for (const id of ids) awaiting.delete(id);
    if (awaiting.size === 0) awaitingAdoption.delete(awaitingDraftId);
  }
  const signature = `${draftId ?? ""}|${ids.join(",")}`;
  if (keyReferenceSignatures.get(key) === signature) return;
  if (ids.length === 0 && !draftId) keyReferenceSignatures.delete(key);
  else keyReferenceSignatures.set(key, signature);
  scheduleDraftReferenceSync();
}

/**
 * Keeps a submission's attachments listed under the draft's id until its outcome is known.
 * `accepted` and `returned` release them; `unknown` keeps them for the rest of this page.
 */
export function holdSubmittedAttachments(
  key: string,
  documents: readonly ChatDraftDocument[] | undefined,
): (outcome: SubmissionOutcome | void) => void {
  const ids = managedAttachmentIds(documents);
  if (ids.length === 0) return () => {};
  const token = ++nextSubmissionHold;
  submissionHolds.set(token, { draftId: getDraftAttachmentId(key), ids });
  return (outcome) => {
    if (outcome !== "accepted" && outcome !== "returned") return;
    const hold = submissionHolds.get(token);
    if (!hold) return;
    submissionHolds.delete(token);
    if (outcome === "accepted") {
      const pending = handoffs.get(hold.draftId) ?? new Set<string>();
      for (const id of hold.ids) pending.add(id);
      handoffs.set(hold.draftId, pending);
    }
    scheduleDraftReferenceSync();
  };
}

/**
 * Brackets one upload into the key's draft. While any upload is open no reference update for
 * that draftId is sent, so a `[]` cannot overtake the server's own registration of the new file.
 * `end(id)` keeps the saved id listed until a draft holds it; `end(null)` lets it go.
 */
export async function beginDraftUpload(key: string): Promise<{
  draftId: string;
  end: (adoptedAttachmentId: string | null) => void;
}> {
  const draftId = getDraftAttachmentId(key);
  pendingUploads.set(draftId, (pendingUploads.get(draftId) ?? 0) + 1);
  await inflightPuts.get(draftId);
  let ended = false;
  return {
    draftId,
    end(adoptedAttachmentId) {
      if (ended) return;
      ended = true;
      const remaining = (pendingUploads.get(draftId) ?? 1) - 1;
      if (remaining > 0) pendingUploads.set(draftId, remaining);
      else pendingUploads.delete(draftId);
      if (adoptedAttachmentId) {
        const awaiting = awaitingAdoption.get(draftId) ?? new Set<string>();
        awaiting.add(adoptedAttachmentId);
        awaitingAdoption.set(draftId, awaiting);
      }
      // The server registered the upload on its own; what it holds now is unknown.
      syncedReferences.set(draftId, STALE_REFERENCES);
      scheduleDraftReferenceSync();
    },
  };
}

/** The composer dropped an uploaded attachment before any draft recorded it. */
export function releaseUploadedAttachment(attachmentId: string): void {
  for (const [draftId, awaiting] of awaitingAdoption) {
    if (!awaiting.delete(attachmentId)) continue;
    if (awaiting.size === 0) awaitingAdoption.delete(draftId);
    scheduleDraftReferenceSync();
  }
}

function desiredReferences(): Map<string, string[]> {
  const desired = new Map<string, Set<string>>();
  const add = (draftId: string, ids: Iterable<string>) => {
    const set = desired.get(draftId) ?? new Set<string>();
    for (const id of ids) set.add(id);
    desired.set(draftId, set);
  };
  for (const [key, draftId] of draftIds) add(draftId, managedAttachmentIds(drafts.get(key)?.documents));
  for (const { draftId, ids } of submissionHolds.values()) add(draftId, ids);
  for (const [draftId, ids] of awaitingAdoption) add(draftId, ids);
  for (const draftId of syncedReferences.keys()) add(draftId, []);
  for (const draftId of handoffs.keys()) add(draftId, []);
  return new Map([...desired].map(([draftId, ids]) => [draftId, [...ids].sort()]));
}

/** Handed-off ids the next update for this draftId must report, i.e. the ones it no longer lists. */
function handoffsLeaving(draftId: string, ids: readonly string[]): string[] {
  const pending = handoffs.get(draftId);
  if (!pending) return [];
  // A handed-off id that is back in a draft is that draft's to protect again.
  for (const id of ids) pending.delete(id);
  if (pending.size === 0) handoffs.delete(draftId);
  return [...pending].sort();
}

async function sendDraftReferences(): Promise<void> {
  const sender = referenceSender;
  if (!sender) return;
  const changes = [...desiredReferences()]
    .filter(([draftId, ids]) => {
      if (pendingUploads.has(draftId)) return false;
      const synced = syncedReferences.get(draftId);
      if (handoffsLeaving(draftId, ids).length > 0) return true;
      return ids.length === 0 ? synced !== undefined : synced !== ids.join(",");
    });
  // Additions first; a release goes out only once every addition in the round is confirmed and
  // no upload is still open, so files moved between drafts are never left without a listing.
  let additionFailed = pendingUploads.size > 0;
  let anyFailed = false;
  for (const [draftId, ids] of [...changes.filter(([, ids]) => ids.length > 0), ...changes.filter(([, ids]) => ids.length === 0)]) {
    if (ids.length === 0 && additionFailed) continue;
    // Only this snapshot is cleared on success; a submission accepted meanwhile stays pending.
    const sent = handoffsLeaving(draftId, ids);
    const put = sender(draftId, ids, sent).then(
      () => {
        if (ids.length === 0) syncedReferences.delete(draftId);
        else syncedReferences.set(draftId, ids.join(","));
        const pending = handoffs.get(draftId);
        if (pending) {
          for (const id of sent) pending.delete(id);
          if (pending.size === 0) handoffs.delete(draftId);
        }
      },
      () => {
        // The server keeps its previous set and handoffs; a later round retries.
        anyFailed = true;
        if (ids.length > 0) additionFailed = true;
      },
    );
    inflightPuts.set(draftId, put);
    await put;
    if (inflightPuts.get(draftId) === put) inflightPuts.delete(draftId);
  }
  if (anyFailed) scheduleReferenceRetry();
  else retryDelayMs = REFERENCE_RETRY_MIN_MS;
}

const REFERENCE_RETRY_MIN_MS = 5_000;
const REFERENCE_RETRY_MAX_MS = 60_000;
let retryDelayMs = REFERENCE_RETRY_MIN_MS;
let retryPending = false;

/** A rejected or unreachable update (e.g. `503 busy`) is retried even if nothing else changes. */
function scheduleReferenceRetry(): void {
  if (retryPending) return;
  retryPending = true;
  const timer = setTimeout(() => {
    retryPending = false;
    scheduleDraftReferenceSync();
  }, retryDelayMs);
  // Node keeps a pending timer alive; a page does not care.
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  retryDelayMs = Math.min(retryDelayMs * 2, REFERENCE_RETRY_MAX_MS);
}

function scheduleDraftReferenceSync(): void {
  if (!referenceSender) return;
  if (flushPromise) {
    flushAgain = true;
    return;
  }
  flushPromise = Promise.resolve()
    .then(sendDraftReferences)
    .finally(() => {
      flushPromise = null;
      if (flushAgain) {
        flushAgain = false;
        scheduleDraftReferenceSync();
      }
    });
}

/** Resolves once every scheduled reference update has been sent (or failed). */
export async function flushDraftReferences(): Promise<void> {
  while (flushPromise) await flushPromise;
}

/** Replaces the transport for reference updates; tests pass a recorder, `null` turns syncing off. */
export function setDraftReferenceSender(sender: DraftReferenceSender | null): void {
  referenceSender = sender;
}
