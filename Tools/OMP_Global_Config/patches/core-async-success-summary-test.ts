// OMP_CORE_PATCH_TARGET=<isolated patched core> bun run patches/core-async-success-summary-test.ts
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AsyncJob, AsyncJobDetails, AsyncJobType } from "../../../node_modules/@oh-my-pi/pi-coding-agent/src/async/job-manager";

const target = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(target, "An explicit isolated core target is required");
const core = resolve(target, "src");
const root = process.argv[2] === "--worker" ? process.argv[3]! : mkdtempSync(join(tmpdir(), "async-success-"));
// SDK process-global stores must close before removing their profile.
if (process.argv[2] !== "--worker") {
 try {
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--worker", root], { env: process.env, stdout: "inherit", stderr: "inherit" });
  process.exitCode = child.exitCode ?? 1;
 } finally { rmSync(root, { recursive: true, force: true }); }
} else {
 process.env.PI_CODING_AGENT_DIR = root;
 // Prompt preflight still validates credentials before the replaced transport runs.
 process.env.OPENAI_API_KEY = "fixture";
 const fixture = root;
 const { setAgentDir } = await import(`${core}/../../pi-utils/src/dirs.ts`);
 setAgentDir(fixture);
 const { createAgentSession } = await import(`${core}/sdk.ts`);
 const { Settings } = await import(`${core}/config/settings.ts`);
 const { getBundledModel } = await import(`${core}/../../pi-catalog/src/models.ts`);
 const { createAssistantMessageEventStream } = await import(`${core}/../../pi-ai/src/utils/event-stream.ts`);
 const { closeModelCache } = await import(`${core}/../../pi-catalog/src/model-cache.ts`);
 const { initializeExtensions } = await import(`${core}/modes/runtime-init.ts`);
 // The explicit core target is runtime-selected; static imports could test another installation.
 const { formatAsyncSuccessPreview, buildAsyncResultBatchMessage } = await import(`${core}/session/async-job-delivery.ts`);
 const model = getBundledModel("openai", "gpt-4o-mini");
 const { session } = await createAgentSession({
  cwd: fixture, agentDir: fixture, agentId: "AsyncSuccess", model, getApiKey: () => "fixture",
  settings: Settings.isolated({ "async.enabled": true, "launch.enabled": false }),
  bindProcessState: false, enableMCP: false, enableLsp: false, skipPythonPreflight: true,
  disableExtensionDiscovery: true, skills: [], rules: [], contextFiles: [], toolNames: ["read", "bash"],
 });
 let pendingCall: { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } | undefined;
 const transportContexts: string[] = [];
 session.agent.streamFn = ((_model: unknown, context: { messages: unknown[] }) => {
  transportContexts.push(JSON.stringify(context.messages));
  const stream = createAssistantMessageEventStream();
  const call = pendingCall;
  pendingCall = undefined;
  const message = {
   role: "assistant", content: call ? [call] : [{ type: "text", text: "Fixture complete." }],
   api: model.api, provider: model.provider, model: model.id,
   usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
   stopReason: call ? "toolUse" : "stop", timestamp: Date.now(),
  };
  queueMicrotask(() => {
   stream.push({ type: "start", partial: message });
   if (call) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
   stream.push({ type: "done", reason: message.stopReason, message });
   stream.end(message);
  });
  return stream;
 }) as never;
 const errors: unknown[] = [];
 await initializeExtensions(session, { reportSendError: (_action: string, error: unknown) => errors.push(error), reportRuntimeError: (error: unknown) => errors.push(error) });
 const manager = session.asyncJobManager!;
 const notices = "\nWall time: 2.50 seconds\nCommand exited with code 0";
 const output = "HEAD-" + "h".repeat(995) + "MIDDLE-OMITTED" + "m".repeat(2986) + "t".repeat(1000 - notices.length - 5) + "-TAIL" + notices;
 assert.equal(output.length, 5000);
 let cases = 0;
 async function delivered(name: string, type: AsyncJobType, text: string, details: AsyncJobDetails = {}, state: "completed" | "failed" | "cancelled" = "completed") {
  const gate = Promise.withResolvers<void>();
  const id = manager.register(type, name, async ({ reportProgress }: { reportProgress: (text: string, details: AsyncJobDetails) => Promise<void> }) => {
   await gate.promise;
   await reportProgress(text, details);
   if (state === "failed") throw new Error(text);
   return text;
  }, { ownerId: session.getAgentId(), process: type === "bash" ? { command: "printf async-success-command-tail", cwd: fixture, pids: () => [] } : undefined });
  if (state === "cancelled") manager.cancel(id);
  gate.resolve();
  await session.settleAsyncWork();
  const messages = session.messages.filter((message: { customType?: string; content?: unknown }) => message.customType === "async-result" && JSON.stringify(message.content).includes(id));
  let content: unknown;
  if (state === "cancelled") {
   // Upstream does not auto-deliver cancelled jobs. Preserve that behavior and
   // exercise the formatter/template with the actual retained cancelled row.
   assert.equal(messages.length, 0, "cancelled job remains undelivered");
   const job = manager.getJob(id)!;
   let saveCalls = 0;
   const untouched = await formatAsyncSuccessPreview(text, job, async () => { saveCalls++; return "forbidden"; });
   assert.equal(untouched, undefined, "cancelled formatter must defer to original formatting");
   assert.equal(saveCalls, 0, "cancelled formatter must not attempt a spill");
   const formatted = untouched ?? text;
   content = buildAsyncResultBatchMessage([{ jobId: id, job, result: formatted, durationMs: 0, epoch: 0 }])!.content;
  } else {
   assert.equal(messages.length, 1, `${name}: exactly one completion message`);
   content = messages[0].content;
  }
  assert.ok(typeof content === "string");
  assert.equal(manager.getJob(id)!.status, state);
  assert.ok(content.includes(`Background job ${id}`), `${name}: header retained`);
  if (type === "bash") assert.ok(content.includes("printf async-success-command-tail"), `${name}: command identity retained`);
  return content as string;
 }
 async function preview(name: string, type: "bash" | "eval", text: string, details: AsyncJobDetails = {}) {
  const message = await delivered(name, type, text, details);
  assert.ok(message.includes(text.slice(0, 1000)) && message.includes(text.slice(-1000)), `${name}: exact head and tail retained`);
  assert.ok(!message.includes("MIDDLE-OMITTED"), `${name}: middle omitted`);
  const body = message.slice(message.indexOf("HEAD-"), message.lastIndexOf("</system-notice>")).trimEnd();
  assert.ok(body.length <= 2100, `${name}: compact body (${body.length})`);
  assert.ok(body.includes(`Result length: ${text.length} chars; full output at artifact://`));
  const artifactId = body.match(/full output at artifact:\/\/(\d+)/)![1]!;
  const path = await session.sessionManager.getArtifactPath(artifactId);
  assert.ok(path, `${name}: link resolves through session artifact manager`);
  assert.equal(readFileSync(path, "utf8"), text, `${name}: artifact recovers full original`);
  assert.ok(transportContexts.some(context => context.includes(`full output at artifact://${artifactId}`)), `${name}: preview reaches the model transport`);
  cases++;
  console.log(`${name}: ${text.length} chars -> ${body.length} body chars; artifact://${artifactId} reads back ${text.length}; header/identity/tail retained`);
  return artifactId;
 }
 try {
  await preview("completed exit-0 bash", "bash", output, { exitCode: 0 });
  await preview("completed eval", "eval", output);
  for (const [name, type, details, state, text] of [
   ["nonzero bash", "bash", { exitCode: 7 }, "completed", output],
   ["cancelled bash", "bash", {}, "cancelled", output],
   ["timed-out bash", "bash", { timedOut: true }, "completed", output],
   ["cancelled metadata bash", "bash", { cancelled: true }, "completed", output],
   ["failed bash", "bash", {}, "failed", output],
   ["failed eval", "eval", {}, "failed", output],
   ["completed task", "task", {}, "completed", output],
   ["small bash", "bash", { exitCode: 0 }, "completed", output.slice(0, 1900)],
   ["threshold bash", "bash", {}, "completed", output.slice(0, 2000)],
  ] as const) {
   const message = await delivered(name, type, text, details, state);
   assert.ok(message.includes(text), `${name}: full original unchanged`);
   assert.ok(!message.includes("Result length:"));
   cases++;
   console.log(`${name}: full ${text.length} chars unchanged`);
  }
  const artifactId = await session.sessionManager.saveArtifact(output, "bash");
  const job = { type: "bash", status: "completed", latestDetails: { meta: { truncation: { artifactId } } } } as AsyncJob;
  const reused = await formatAsyncSuccessPreview(output, job, () => { throw new Error("must reuse existing artifact"); });
  assert.ok(reused!.includes(`full output at artifact://${artifactId}`));
  const existingPath = await session.sessionManager.getArtifactPath(artifactId!);
  assert.equal(readFileSync(existingPath!, "utf8"), output);
  for (const save of [async () => undefined, async () => { throw new Error("disk unavailable"); }]) {
   assert.equal(await formatAsyncSuccessPreview(output, { type: "bash", status: "completed" } as AsyncJob, save), output, "storage failure keeps full output");
  }
  assert.equal(await formatAsyncSuccessPreview(output, { ...job, latestDetails: { meta: { artifactError: "write" } } } as AsyncJob, async () => "unused"), output, "capture failure keeps full output");
  cases += 4;
  for (const unicode of [
   "a".repeat(999) + "😀" + "b".repeat(3000),
   "a".repeat(3000) + "😀" + "b".repeat(999),
  ]) {
   const message = await formatAsyncSuccessPreview(unicode, { type: "eval", status: "completed" } as AsyncJob, async () => "unicode");
   assert.equal(message!.isWellFormed(), true, "head/tail cuts do not split surrogate pairs");
   assert.ok(message!.length <= 2100);
   cases++;
  }
  for (const [name, command, timeout] of [
   ["success", "seq 1 1200", 10],
   ["nonzero", "seq 1 3000; exit 7", 10],
   ["timeout", "seq 1 3000; sleep 3", 1],
  ] as const) {
   const before = new Set(manager.getAllJobs().map((job: AsyncJob) => job.id));
   pendingCall = { type: "toolCall", id: `real-${name}`, name: "bash", arguments: { command, timeout, async: true } };
   await session.prompt(`Run local ${name} bash fixture.`);
   await session.settleAsyncWork();
   const job = manager.getAllJobs().find((job: AsyncJob) => !before.has(job.id) && job.type === "bash");
   assert.ok(job, `${name}: actual BashTool registered a job`);
   assert.equal(job.status, name === "success" ? "completed" : "failed");
   if (name === "nonzero") assert.equal(job.latestDetails?.exitCode, 7);
   if (name === "timeout") assert.equal(job.latestDetails?.timedOut, true);
   const message = session.messages.find((message: { customType?: string; content?: unknown }) => message.customType === "async-result" && JSON.stringify(message.content).includes(job.id));
   assert.ok(message && typeof message.content === "string", `${name}: actual bash result auto-delivered`);
   if (name === "success") {
    const full = job.resultText!;
    assert.ok(full.length > 2000);
    assert.ok(message.content.includes(`Result length: ${full.length} chars;`));
    assert.ok(message.content.length < 2300 && message.content.length < full.length, "real delivery is bounded with header included");
    assert.ok(!message.content.includes("\n600\n601\n"), "real delivery omits the middle");
    assert.ok(message.content.includes(full.slice(0, 1000)));
    // The existing prompt renderer collapses blank lines; check tail content/notices, not that whitespace.
    assert.ok(message.content.includes("1199\n1200") && message.content.includes("Command exited with code 0"));
    const id = message.content.match(/full output at artifact:\/\/(\d+)/)![1]!;
    const path = await session.sessionManager.getArtifactPath(id);
    assert.ok(path);
    assert.equal(readFileSync(path, "utf8"), full);
   } else assert.ok(!message.content.includes("Result length:"), `${name}: real bash failure keeps original spill policy`);
   cases++;
   console.log(`real BashTool ${name}: status=${job.status} exit=${job.latestDetails?.exitCode} timedOut=${job.latestDetails?.timedOut}; success-summary=${message.content.includes("Result length:")}`);
  }
  assert.deepEqual(errors, []);
  console.log(`async-success summary: ${cases} behavioral cases passed; real SDK owner sink, artifact storage, batch template and model transport exercised; no network provider used`);
 } finally {
  await session.dispose();
  session.modelRegistry.authStorage.close();
  closeModelCache();
 }
}
