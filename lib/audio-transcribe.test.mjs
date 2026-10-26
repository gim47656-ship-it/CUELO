import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { TranscriptStoppedError, readTranscript, resolveTranscribeModel } = await jiti.import("./audio-transcribe.ts");

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

const fakeRegistry = (known) => ({ find: (provider, id) => known[`${provider}/${id}`] });
const fakeSettings = (draft) => ({ getModelRole: (role) => (role === "draft" ? draft : "wrong-role") });
const VERTEX = { name: "vertex" };
const PROXY = { name: "proxy" };

test("transcription follows the draft role model and drops its :level suffix", () => {
  const registry = fakeRegistry({ "google-vertex/gemini-4-argon": VERTEX, "localproxy/gemini-4-argon": PROXY });
  assert.equal(resolveTranscribeModel(fakeSettings("localproxy/gemini-4-argon"), registry), PROXY);
  assert.equal(resolveTranscribeModel(fakeSettings("localproxy/gemini-4-argon:low"), registry), PROXY);
});

test("an unset, malformed or unknown draft role falls back to the built-in Vertex model", () => {
  const registry = fakeRegistry({ "google-vertex/gemini-4-argon": VERTEX, "localproxy/gemini-4-argon": PROXY });
  assert.equal(resolveTranscribeModel(fakeSettings(undefined), registry), VERTEX);
  assert.equal(resolveTranscribeModel(fakeSettings(""), registry), VERTEX);
  assert.equal(resolveTranscribeModel(fakeSettings("no-provider-part"), registry), VERTEX);
  assert.equal(resolveTranscribeModel(fakeSettings("localproxy/missing-model:high"), registry), VERTEX);
  assert.equal(resolveTranscribeModel(fakeSettings("localproxy/gemini-4-argon"), fakeRegistry({})), undefined);
});
