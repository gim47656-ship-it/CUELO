import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findFirstUserMessage, findFirstTitleSource, truncateTitle } = await jiti.import("./session-title.ts");
const { composeDocumentPrompt } = await jiti.import("./document-attachments.ts");

test("finds the first user message with usable text", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "image", data: "…", mimeType: "image/png" }] },
    { role: "user", content: [{ type: "text", text: "  Fix the SSE reconnect  " }] },
    { role: "user", content: "later" },
  ];
  assert.equal(findFirstUserMessage(messages), "Fix the SSE reconnect");
});

test("accepts plain string content", () => {
  assert.equal(findFirstUserMessage([{ role: "user", content: "Ship the release" }]), "Ship the release");
});

test("hides extracted document context from session titles and previews", () => {
  const prompt = composeDocumentPrompt("Review the attachment", [{
    name: "manual.pdf",
    mimeType: "application/pdf",
    size: 42,
    text: "private extracted body",
  }]);
  assert.equal(findFirstUserMessage([{ role: "user", content: prompt }]), "Review the attachment");
  assert.equal(findFirstUserMessage([{ role: "user", content: [{ type: "text", text: prompt }] }]), "Review the attachment");
});

test("returns undefined when no user turn carries text", () => {
  assert.equal(findFirstUserMessage([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
});

test("collapses whitespace and caps the title length", () => {
  assert.equal(truncateTitle("  Improve   worktree\ngrouping "), "Improve worktree grouping");
  assert.equal(Array.from(truncateTitle("x".repeat(200))).length, 80);
});

test("falls back to the compaction summary after compaction removed all user messages", () => {
  const messages = [
    { role: "compactionSummary", summary: "  The session migrated worktrees and rebuilt the sidebar.  " },
  ];
  assert.equal(findFirstTitleSource(messages), "  The session migrated worktrees and rebuilt the sidebar.  ");
});

test("prefers a real user turn over the compaction summary", () => {
  const messages = [
    { role: "compactionSummary", summary: "stale summary" },
    { role: "user", content: "Fix the SSE reconnect" },
  ];
  assert.equal(findFirstTitleSource(messages), "Fix the SSE reconnect");
});

test("returns undefined when nothing can name the session", () => {
  assert.equal(findFirstTitleSource([{ role: "assistant", content: [{ type: "text", text: "hi" }] }]), undefined);
  assert.equal(findFirstTitleSource([{ role: "compactionSummary", summary: "" }]), undefined);
});
