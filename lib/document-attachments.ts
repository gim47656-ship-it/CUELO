
export const MAX_ATTACHED_DOCUMENTS = 3;
export const MAX_ATTACHED_DOCUMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHED_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_ATTACHED_DOCUMENT_TEXT_CHARS = 120_000;
export const MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS = 240_000;
export const MAX_ATTACHED_PDF_PAGES = 250;

export type SupportedDocumentKind = "markdown" | "text" | "pdf";

export interface AttachedDocument {
  name: string;
  mimeType: "text/markdown" | "text/plain" | "application/pdf";
  size: number;
  text: string;
}

type FileIdentity = Pick<File, "name" | "type" | "size"> & Partial<Pick<File, "lastModified">>;

type ClipboardFileItem = {
  kind: string;
  getAsFile: () => File | null;
};

export type ClipboardFileSource = {
  files?: ArrayLike<File> | null;
  items?: ArrayLike<ClipboardFileItem> | null;
};

export type DocumentAttachmentErrorCode =
  | "unsupported"
  | "file_too_large"
  | "text_too_large"
  | "too_many_pages"
  | "no_extractable_text"
  | "password_protected"
  | "invalid_pdf"
  | "read_failed";

function isDocumentAttachmentErrorCode(value: string): value is DocumentAttachmentErrorCode {
  return value === "unsupported"
    || value === "file_too_large"
    || value === "text_too_large"
    || value === "too_many_pages"
    || value === "no_extractable_text"
    || value === "password_protected"
    || value === "invalid_pdf"
    || value === "read_failed";
}

export class DocumentAttachmentError extends Error {
  constructor(
    public readonly code: DocumentAttachmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DocumentAttachmentError";
  }
}

export const DOCUMENT_MIME_BY_KIND: Record<SupportedDocumentKind, AttachedDocument["mimeType"]> = {
  markdown: "text/markdown",
  text: "text/plain",
  pdf: "application/pdf",
};

const TEXT_DOCUMENT_EXTENSIONS: Record<string, true> = { ".txt": true, ".csv": true, ".tsv": true, ".json": true, ".log": true };
const TEXT_DOCUMENT_MIME_TYPES: Record<string, true> = {
  "text/plain": true,
  "text/csv": true,
  "text/tab-separated-values": true,
  "application/json": true,
  "text/json": true,
};

export function getSupportedDocumentKind(file: Pick<FileIdentity, "name" | "type">): SupportedDocumentKind | null {
  const lowerName = file.name.toLocaleLowerCase();
  if (lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) return "markdown";
  if (lowerName.endsWith(".pdf")) return "pdf";
  // Explorer가 복사한 파일은 MIME이 비어 있는 경우가 많아 확장자를 먼저 본다.
  const dot = lowerName.lastIndexOf(".");
  if (dot > 0 && TEXT_DOCUMENT_EXTENSIONS[lowerName.slice(dot)]) return "text";

  const mimeType = file.type.toLocaleLowerCase().split(";", 1)[0]?.trim();
  if (mimeType === "text/markdown") return "markdown";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType && TEXT_DOCUMENT_MIME_TYPES[mimeType]) return "text";
  return null;
}

export function isSupportedDocumentFile(file: Pick<FileIdentity, "name" | "type">): boolean {
  return getSupportedDocumentKind(file) !== null;
}

export function isSupportedAttachmentFile(file: Pick<FileIdentity, "name" | "type">): boolean {
  return file.type.startsWith("image/") || isSupportedDocumentFile(file);
}

/** Classify each candidate exactly once; image files win over the document extensions. */
export function classifyAttachmentFiles<T extends Pick<FileIdentity, "name" | "type">>(
  files: readonly T[],
): { images: T[]; documents: T[]; unsupported: T[] } {
  const images: T[] = [];
  const documents: T[] = [];
  const unsupported: T[] = [];
  for (const file of files) {
    if (file.type.startsWith("image/")) images.push(file);
    else if (isSupportedDocumentFile(file)) documents.push(file);
    else unsupported.push(file);
  }
  return { images, documents, unsupported };
}

/**
 * A paste can expose the same payload through both files and items, and browsers may
 * wrap those views in File objects with different metadata. Treat files as the
 * authoritative snapshot; only fall back to items when that snapshot is empty.
 */
export function getClipboardFiles(source: ClipboardFileSource): File[] {
  const files = Array.from(source.files ?? []);
  if (files.length > 0) return files;

  const candidates: File[] = [];
  for (const item of Array.from(source.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) candidates.push(file);
  }
  return candidates;
}

export function isAttachedDocumentWithinLimits(value: unknown): value is AttachedDocument {
  if (!value || typeof value !== "object") return false;
  const document = value as Partial<AttachedDocument>;
  return typeof document.name === "string"
    && document.name.length > 0
    && (document.mimeType === "text/markdown" || document.mimeType === "text/plain" || document.mimeType === "application/pdf")
    && typeof document.size === "number"
    && Number.isSafeInteger(document.size)
    && document.size >= 0
    && document.size <= MAX_ATTACHED_DOCUMENT_BYTES
    && typeof document.text === "string"
    && document.text.length <= MAX_ATTACHED_DOCUMENT_TEXT_CHARS;
}

export function normalizeAttachedDocuments(value: unknown): AttachedDocument[] {
  if (!Array.isArray(value)) return [];

  const accepted: AttachedDocument[] = [];
  let totalBytes = 0;
  let totalTextChars = 0;
  for (const candidate of value) {
    if (!isAttachedDocumentWithinLimits(candidate)) continue;
    if (accepted.length >= MAX_ATTACHED_DOCUMENTS) break;
    if (totalBytes + candidate.size > MAX_TOTAL_ATTACHED_DOCUMENT_BYTES) continue;
    if (totalTextChars + candidate.text.length > MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS) continue;
    accepted.push({
      name: candidate.name,
      mimeType: candidate.mimeType,
      size: candidate.size,
      text: candidate.text,
    });
    totalBytes += candidate.size;
    totalTextChars += candidate.text.length;
  }
  return accepted;
}

export async function extractAttachedDocument(file: File): Promise<AttachedDocument> {
  const kind = getSupportedDocumentKind(file);
  if (!kind) {
    throw new DocumentAttachmentError("unsupported", `Unsupported document type: ${file.name}`);
  }
  if (file.size > MAX_ATTACHED_DOCUMENT_BYTES) {
    throw new DocumentAttachmentError("file_too_large", `${file.name} exceeds the document size limit`);
  }

  let text: string;
  if (kind === "pdf") {
    text = await extractPdfText(file);
  } else {
    try {
      text = await file.text();
    } catch (error) {
      throw new DocumentAttachmentError("read_failed", error instanceof Error ? error.message : String(error));
    }
    assertTextWithinLimit(text);
  }

  return {
    name: file.name,
    mimeType: DOCUMENT_MIME_BY_KIND[kind],
    size: file.size,
    text,
  };
}

export function composeDocumentPrompt(message: string, documents: readonly AttachedDocument[]): string {
  const accepted = normalizeAttachedDocuments(documents);
  if (accepted.length === 0) return message;

  const manifest: DocumentPromptManifest = {
    userMessageLength: message.length,
    documents: accepted.map(({ name, mimeType, size, text }) => ({
      name,
      mimeType,
      size,
      textLength: text.length,
    })),
  };

  let prompt = `${DOCUMENT_PROMPT_PREFIX}${JSON.stringify(manifest)}${DOCUMENT_PROMPT_SUFFIX}\n${USER_MESSAGE_HEADER}${message}${DOCUMENT_CONTEXT_HEADER}`;
  accepted.forEach((document, index) => {
    prompt += getDocumentHeader(index, document);
    prompt += document.text;
    prompt += getDocumentFooter(index);
  });
  return prompt;
}

export function parseDocumentPrompt(prompt: string): { message: string; documents: AttachedDocument[] } | null {
  if (!prompt.startsWith(DOCUMENT_PROMPT_PREFIX)) return null;
  const firstLineEnd = prompt.indexOf("\n");
  if (firstLineEnd < 0) return null;
  const firstLine = prompt.slice(0, firstLineEnd);
  if (!firstLine.endsWith(DOCUMENT_PROMPT_SUFFIX)) return null;

  let manifest: DocumentPromptManifest;
  try {
    manifest = JSON.parse(firstLine.slice(DOCUMENT_PROMPT_PREFIX.length, -DOCUMENT_PROMPT_SUFFIX.length)) as DocumentPromptManifest;
  } catch {
    return null;
  }
  if (!isDocumentPromptManifest(manifest)) return null;

  let offset = firstLineEnd + 1;
  if (!prompt.startsWith(USER_MESSAGE_HEADER, offset)) return null;
  offset += USER_MESSAGE_HEADER.length;
  const messageEnd = offset + manifest.userMessageLength;
  if (messageEnd > prompt.length) return null;
  const message = prompt.slice(offset, messageEnd);
  offset = messageEnd;
  if (!prompt.startsWith(DOCUMENT_CONTEXT_HEADER, offset)) return null;
  offset += DOCUMENT_CONTEXT_HEADER.length;

  const documents: AttachedDocument[] = [];
  for (let index = 0; index < manifest.documents.length; index += 1) {
    const descriptor = manifest.documents[index];
    const header = getDocumentHeader(index, descriptor);
    if (!prompt.startsWith(header, offset)) return null;
    offset += header.length;
    const textEnd = offset + descriptor.textLength;
    if (textEnd > prompt.length) return null;
    const text = prompt.slice(offset, textEnd);
    offset = textEnd;
    const footer = getDocumentFooter(index);
    if (!prompt.startsWith(footer, offset)) return null;
    offset += footer.length;
    documents.push({
      name: descriptor.name,
      mimeType: descriptor.mimeType,
      size: descriptor.size,
      text,
    });
  }

  return offset === prompt.length ? { message, documents } : null;
}
export function getDocumentPromptUserMessage(prompt: string): string {
  return parseDocumentPrompt(prompt)?.message ?? prompt;
}


export function getDocumentPromptDisplayText(prompt: string): string {
  const parsed = parseDocumentPrompt(prompt);
  if (!parsed) return prompt;
  const attachmentSummary = parsed.documents.map((document) => document.name).join(", ");
  return parsed.message.trim()
    ? `${parsed.message}\n\nAttached: ${attachmentSummary}`
    : `Attached: ${attachmentSummary}`;
}

export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function extractPdfText(file: File): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/document-text", {
      method: "POST",
      headers: { "Content-Type": "application/pdf" },
      body: file,
    });
  } catch (error) {
    throw new DocumentAttachmentError("read_failed", error instanceof Error ? error.message : String(error));
  }

  const payload = await response.json().catch(() => null) as { text?: unknown; code?: unknown; error?: unknown } | null;
  if (!response.ok) {
    const code = typeof payload?.code === "string" && isDocumentAttachmentErrorCode(payload.code)
      ? payload.code
      : "invalid_pdf";
    const message = typeof payload?.error === "string" ? payload.error : `Unable to read ${file.name}`;
    throw new DocumentAttachmentError(code, message);
  }
  if (typeof payload?.text !== "string") {
    throw new DocumentAttachmentError("invalid_pdf", `Unable to read ${file.name}`);
  }
  assertTextWithinLimit(payload.text);
  return payload.text;
}

function assertTextWithinLimit(text: string): void {
  if (text.length > MAX_ATTACHED_DOCUMENT_TEXT_CHARS) {
    throw new DocumentAttachmentError("text_too_large", "Document exceeds the extracted text limit");
  }
}

type DocumentPromptDescriptor = Pick<AttachedDocument, "name" | "mimeType" | "size"> & {
  textLength: number;
};

type DocumentPromptManifest = {
  userMessageLength: number;
  documents: DocumentPromptDescriptor[];
};

const DOCUMENT_PROMPT_PREFIX = "<!-- omp-web-document-context-v1:";
const DOCUMENT_PROMPT_SUFFIX = " -->";
const USER_MESSAGE_HEADER = "User message:\n";
const DOCUMENT_CONTEXT_HEADER = "\n\nAttached documents (locally extracted text supplied by the user):\n";

function getDocumentHeader(index: number, document: Pick<AttachedDocument, "name" | "mimeType" | "size">): string {
  return `\n--- Begin attached document ${index + 1}: ${JSON.stringify(document.name)} (${document.mimeType}, ${document.size} bytes) ---\n`;
}

function getDocumentFooter(index: number): string {
  return `\n--- End attached document ${index + 1} ---`;
}

function isDocumentPromptManifest(value: unknown): value is DocumentPromptManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as Partial<DocumentPromptManifest>;
  if (!Number.isSafeInteger(manifest.userMessageLength) || (manifest.userMessageLength ?? -1) < 0) return false;
  if (!Array.isArray(manifest.documents) || manifest.documents.length === 0 || manifest.documents.length > MAX_ATTACHED_DOCUMENTS) return false;

  let totalBytes = 0;
  let totalTextChars = 0;
  for (const descriptor of manifest.documents) {
    if (!descriptor || typeof descriptor !== "object") return false;
    const document = descriptor as Partial<DocumentPromptDescriptor>;
    if (typeof document.name !== "string" || document.name.length === 0) return false;
    if (document.mimeType !== "text/markdown" && document.mimeType !== "text/plain" && document.mimeType !== "application/pdf") return false;
    if (!Number.isSafeInteger(document.size) || (document.size ?? -1) < 0 || (document.size ?? 0) > MAX_ATTACHED_DOCUMENT_BYTES) return false;
    if (!Number.isSafeInteger(document.textLength) || (document.textLength ?? -1) < 0 || (document.textLength ?? 0) > MAX_ATTACHED_DOCUMENT_TEXT_CHARS) return false;
    totalBytes += document.size ?? 0;
    totalTextChars += document.textLength ?? 0;
  }
  return totalBytes <= MAX_TOTAL_ATTACHED_DOCUMENT_BYTES && totalTextChars <= MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS;
}
