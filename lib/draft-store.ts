import {
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "./image-attachments";
import {
  normalizeAttachedDocuments,
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

const drafts = new Map<string, ChatDraft>();
const RELOAD_DRAFTS_KEY = "ompweb-drafts-for-reload-v1";
let reloadDraftsRestored = false;

function restoreDraftsAfterReload(): void {
  if (reloadDraftsRestored || typeof sessionStorage === "undefined") return;
  reloadDraftsRestored = true;
  const raw = sessionStorage.getItem(RELOAD_DRAFTS_KEY);
  if (!raw) return;
  sessionStorage.removeItem(RELOAD_DRAFTS_KEY);
  try {
    const entries = JSON.parse(raw) as [string, ChatDraft][];
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
      JSON.stringify([...drafts.entries()].map(([key, draft]) => [key, cloneDraft(draft)])),
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
    return;
  }
  drafts.set(key, cloneDraft(draft));
}

export function clearDraft(key: string): void {
  drafts.delete(key);
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
