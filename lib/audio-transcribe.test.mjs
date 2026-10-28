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

// Provider content blocks must stay with the primary; every other failure may go to the fallback.
const { TranscriptBlockedError, assertInlineAudioModel } = await jiti.import("./audio-transcribe.ts");
const { Flag } = await jiti.import("@oh-my-pi/pi-ai/error");

test("a content block reported by the SDK flag or a Google block finish reason is a TranscriptBlockedError", () => {
  assert.throws(
    () => readTranscript({ ...reply("error", ""), errorId: Flag.ContentBlocked, errorMessage: "Request blocked by Google (OTHER)" }),
    TranscriptBlockedError,
  );
  for (const reason of ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION", "RECITATION"]) {
    assert.throws(
      () => readTranscript(reply("error", "", `Generation failed with finish reason: ${reason}`)),
      TranscriptBlockedError,
      reason,
    );
  }
});

test("quota, network, empty-stream and other finish-reason stops are ordinary stopped errors", () => {
  for (const message of [
    "Generation failed with finish reason: OTHER",
    "Generation failed with finish reason: LANGUAGE",
    "Google API stream ended without a finish reason (connection dropped or response truncated)",
    "429 RESOURCE_EXHAUSTED: quota exceeded",
    "fetch failed",
  ]) {
    assert.throws(
      () => readTranscript(reply("error", "", message)),
      (error) => error instanceof TranscriptStoppedError && !(error instanceof TranscriptBlockedError),
      message,
    );
  }
});

test("only Google inline-media APIs may carry audio; other image-capable APIs are refused before any request", () => {
  const model = (api, input = ["text", "image"]) => ({ provider: "p", id: "m", api, input });
  assert.doesNotThrow(() => assertInlineAudioModel(model("google-generative-ai")));
  assert.doesNotThrow(() => assertInlineAudioModel(model("google-vertex")));
  for (const api of ["openai-codex-responses", "openai-completions", "anthropic-messages", "openrouter", "google-gemini-cli"]) {
    assert.throws(() => assertInlineAudioModel(model(api)), /cannot carry audio/, api);
  }
  assert.throws(() => assertInlineAudioModel(model("google-vertex", ["text"])), /does not accept inline media/);
});
