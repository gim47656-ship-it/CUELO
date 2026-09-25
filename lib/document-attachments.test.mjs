import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  classifyAttachmentFiles,
  composeDocumentPrompt,
  getClipboardFiles,
  getSupportedDocumentKind,
  normalizeAttachedDocuments,
  parseDocumentPrompt,
} = await jiti.import("./document-attachments.ts");

const markdown = {
  name: "HANDOFF.md",
  mimeType: "text/markdown",
  size: 18,
  text: "# Current state\nReady",
};

test("recognizes attachable documents by extension when Explorer omits MIME", () => {
  assert.equal(getSupportedDocumentKind({ name: "notes.markdown", type: "" }), "markdown");
  assert.equal(getSupportedDocumentKind({ name: "manual.PDF", type: "" }), "pdf");
  assert.equal(getSupportedDocumentKind({ name: "rows.CSV", type: "" }), "text");
  assert.equal(getSupportedDocumentKind({ name: "notes.txt", type: "" }), "text");
  assert.equal(getSupportedDocumentKind({ name: "config.json", type: "" }), "text");
  assert.equal(getSupportedDocumentKind({ name: "report", type: "application/json" }), "text");
  assert.equal(getSupportedDocumentKind({ name: "archive.zip", type: "application/zip" }), null);
});

test("uses clipboard files once when items mirror the paste with different metadata", () => {
  const image = { name: "capture.png", type: "image/png", size: 4, lastModified: 1 };
  const mirroredImage = { ...image, lastModified: 2 };
  const files = getClipboardFiles({
    files: [image],
    items: [{ kind: "file", getAsFile: () => mirroredImage }],
  });

  assert.deepEqual(files, [image]);
});

test("preserves distinct files from one clipboard snapshot", () => {
  const image = { name: "capture.png", type: "image/png", size: 4, lastModified: 1 };
  const rows = { name: "rows.csv", type: "", size: 8, lastModified: 2 };

  assert.deepEqual(getClipboardFiles({ files: [image, rows] }), [image, rows]);
});

test("falls back to file items when the clipboard files snapshot is empty", () => {
  const image = { name: "capture.png", type: "image/png", size: 4, lastModified: 1 };
  const rows = { name: "rows.csv", type: "", size: 8, lastModified: 2 };
  const unsupported = { name: "archive.zip", type: "application/zip", size: 12, lastModified: 3 };
  const files = getClipboardFiles({
    files: [],
    items: [
      { kind: "file", getAsFile: () => image },
      { kind: "file", getAsFile: () => rows },
      { kind: "file", getAsFile: () => unsupported },
      { kind: "string", getAsFile: () => null },
    ],
  });

  assert.deepEqual(files, [image, rows, unsupported]);
});

test("keeps repeated pastes independent and leaves text-only paste to the browser", () => {
  const image = { name: "capture.png", type: "image/png", size: 4, lastModified: 1 };

  assert.deepEqual(getClipboardFiles({ files: [image] }), [image]);
  assert.deepEqual(getClipboardFiles({ files: [image] }), [image]);
  assert.deepEqual(getClipboardFiles({
    files: [],
    items: [{ kind: "string", getAsFile: () => null }],
  }), []);
});

test("classifies each attachment exactly once with images taking precedence", () => {
  const ambiguous = { name: "diagram.md", type: "image/png" };
  const document = { name: "HANDOFF.md", type: "" };
  const other = { name: "archive.zip", type: "application/zip" };
  const { images, documents, unsupported } = classifyAttachmentFiles([ambiguous, document, other]);
  assert.deepEqual(images, [ambiguous]);
  assert.deepEqual(documents, [document]);
  assert.deepEqual(unsupported, [other]);
});

test("round-trips typed text and bounded document context without delimiter collisions", () => {
  const message = "Review this text even if it contains </attached_document_0>.";
  const csv = { name: "rows.csv", mimeType: "text/plain", size: 12, text: "a,b\n1,2" };
  const prompt = composeDocumentPrompt(message, [markdown, csv]);
  assert.deepEqual(parseDocumentPrompt(prompt), { message, documents: [markdown, csv] });
});

test("leaves a self-consistent envelope that declares no documents as typed text", () => {
  const message = "please read";
  const real = composeDocumentPrompt(message, [markdown]);
  const prefix = real.slice(0, real.indexOf("{"));
  const envelope = real.slice(real.indexOf("\n") + 1, real.indexOf("\n--- Begin attached document 1:"));
  const manifest = JSON.stringify({ userMessageLength: message.length, documents: [] });
  const forged = `${prefix}${manifest} -->\n${envelope}`;
  assert.ok(forged.startsWith(prefix) && forged.endsWith("\n"));
  assert.equal(parseDocumentPrompt(forged), null);
});

test("drops documents that exceed the combined text limit", () => {
  const large = { ...markdown, name: "large.md", text: "x".repeat(120_000) };
  const second = { ...markdown, name: "second.md", text: "y".repeat(120_000) };
  const overflow = { ...markdown, name: "overflow.md", text: "z" };
  assert.deepEqual(normalizeAttachedDocuments([large, second, overflow]).map((item) => item.name), ["large.md", "second.md"]);
});
