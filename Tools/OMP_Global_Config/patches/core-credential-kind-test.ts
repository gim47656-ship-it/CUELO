// Local HTTP provider fixture: actual auth branch, retry reset and durable usage readback.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const core = process.env.OMP_CORE_PATCH_TARGET;
if (!core) throw new Error("OMP_CORE_PATCH_TARGET is required");
const ai = `${core}/../pi-ai/src`;
const { streamAnthropic } = await import(`${ai}/providers/anthropic.ts`);
const { AnthropicMessagesClient } = await import(`${ai}/providers/anthropic-client.ts`);
const { getBundledModel } = await import(`${core}/../pi-catalog/src/models.ts`);
const { SessionManager } = await import(`${core}/src/session/session-manager.ts`);
const { setAgentDir } = await import(`${core}/../pi-utils/src/dirs.ts`);
const temp = mkdtempSync(join(tmpdir(), "credential-kind-"));
setAgentDir(join(temp, "agent"));
let failuresRemaining = 0;
let requests = 0;
const bearerKinds: string[] = [];
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
 requests++;
 bearerKinds.push(request.headers.get("authorization")?.startsWith("Bearer sk-ant-oat") ? "oauth" : "api-key");
 if (failuresRemaining-- > 0) return Response.json({ type: "error", error: { type: "overloaded_error", message: "fixture retry" } }, { status: 529 });
 const events = [
  { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
 ];
 return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}});
const baseURL = `http://127.0.0.1:${server.port}`;
const model = { ...getBundledModel("anthropic", "claude-opus-5-5"), baseUrl: baseURL };
const manager = SessionManager.create(temp, join(temp, "sessions"));
try {
 const expected: (string | undefined)[] = [];
 for (const mode of ["oauth", "api-key", "api-retry", "oauth", "custom"] as const) {
  failuresRemaining = mode === "api-retry" ? 1 : 0;
  const before = requests;
  const apiKey = mode === "oauth" ? "sk-ant-oat01-f" : "fixture-api";
  const result = await streamAnthropic(model, { systemPrompt: "fixture", messages: [{ role: "user", content: "local probe", timestamp: Date.now() }] }, {
   apiKey, maxTokens: 32, maxRetries: 1, retryBaseDelayMs: 1,
   ...(mode === "custom" ? { client: new AnthropicMessagesClient({ apiKey, baseURL }) } : {}),
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  const kind = mode === "custom" ? undefined : mode === "oauth" ? "oauth" : "api-key";
  assert.equal(result.usage.credentialKind, kind);
  assert.equal(bearerKinds.at(-1), mode === "oauth" ? "oauth" : "api-key");
  if (mode === "api-retry") assert.equal(requests - before, 2, "real retry issued");
  manager.appendMessage(result);
  manager.appendModelUsage({ purpose: "fixture", role: "assistant", api: result.api, provider: result.provider, model: result.model, usage: result.usage, stopReason: result.stopReason }, { sessionId: manager.getSessionId(), parentId: manager.getLeafId() });
  expected.push(kind);
  console.log(JSON.stringify({ mode, credentialKind: kind ?? "unknown", requests: requests - before }));
 }
 await manager.flush();
 const file = manager.getSessionFile()!;
 await manager.close();
 const reopened = await SessionManager.open(file);
 try {
  for (const type of ["message", "model_usage"]) {
   const kinds = reopened.getEntries().filter((e: any) => e.type === type).map((e: any) => (type === "message" ? e.message : e).usage.credentialKind);
   assert.deepEqual(kinds, expected, `${type}: persisted kinds and unknown preserved`);
  }
 } finally { await reopened.close(); }
 console.log("PASS provider auth kind, API retry, OAuth recovery, custom unknown and durable message/model_usage readback");
} finally {
 await manager.close();
 server.stop(true);
 rmSync(temp, { recursive: true, force: true });
}
