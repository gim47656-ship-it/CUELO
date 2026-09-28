import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { TranscriptStoppedError, readTranscript } = await jiti.import("./audio-transcribe.ts");

const reply = (stopReason, text, errorMessage) => ({
  stopReason,
  errorMessage,
  content: [{ type: "text", text }],
});

test("returns the trimmed transcript of a finished reply", () => {
  assert.equal(readTranscript(reply("stop", "\n안녕하세요. 첨부 기능 테스트입니다.\n")), "안녕하세요. 첨부 기능 테스트입니다.");
});

test("keeps a transcript cut at the output limit and marks it", () => {
  assert.equal(readTranscript(reply("length", "first half")), "first half\n[transcript truncated at the output limit]");
});

test("reports a stopped reply with the provider's own notice so the user sees why", () => {
  assert.throws(
    () => readTranscript(reply("error", "This request was blocked by Gemini's filters.", "stream ended without a finish reason")),
    (error) => error instanceof TranscriptStoppedError
      && /stream ended without a finish reason; This request was blocked by Gemini's filters\./.test(error.message),
  );
});

test("rejects a finished reply without text", () => {
  assert.throws(() => readTranscript(reply("stop", "  ")), /no text/);
});
