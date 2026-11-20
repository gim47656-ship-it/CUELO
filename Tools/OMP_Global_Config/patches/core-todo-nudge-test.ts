// Run against OMP_CORE_PATCH_TARGET with a synthetic provider and an isolated session.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import todoNudge from "../agent/extensions/todo-nudge";

const core = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(core, "OMP_CORE_PATCH_TARGET is required");
const root = await mkdtemp(join(tmpdir(), "cuelo-todo-nudge-"));
const agentDir = join(root, "agent");
try {
  // Resolve the explicitly selected SDK rather than the checkout's default import target.
  const coreUrl = (file: string) => pathToFileURL(resolve(core, "src", file)).href;
  const { setAgentDir } = await import(coreUrl("../../pi-utils/src/dirs.ts"));
  setAgentDir(agentDir);
  const { createAgentSession } = await import(coreUrl("sdk.ts"));
  const { Settings } = await import(coreUrl("config/settings.ts"));
  const { cfgTodoMidRunNudges } = await import(coreUrl("tools/settings.ts"));
  const { initializeExtensions } = await import(coreUrl("modes/runtime-init.ts"));
  const { createAssistantMessageEventStream } = await import(coreUrl("../../pi-ai/src/utils/event-stream.ts"));
  const { getBundledModel } = await import(coreUrl("../../pi-catalog/src/models.ts"));
  const bundled = getBundledModel("openai", "gpt-4o-mini");
  assert.ok(bundled, "bundled fixture model");
  const model = { ...bundled, baseUrl: "http://127.0.0.1:9" };
  const writes: boolean[] = [];
  let supersedeAfterWrite: number | undefined;
  let reloads = 0;
  const { session } = await createAgentSession({
    cwd: root, agentDir, model, getApiKey: () => "synthetic-fixture-only",
    extensions: [todoNudge, (pi: ExtensionAPI) => {
      pi.on("tool_result", async event => {
        if (event.toolName !== "write") return;
        writes.push(event.isError);
        if (writes.length === supersedeAfterWrite) {
          await session.extensionRunner.emitInput("Newer input before the aside poll", undefined, "rpc");
        }
      });
      pi.on("session_switch", () => { reloads++; });
    }],
    settings: Settings.isolated({
      "todo.midRunNudges": "capped", "todo.remindersMax": 0, "tools.approvalMode": "yolo", "compaction.enabled": false,
    }),
    toolNames: ["todo", "write"], disableExtensionDiscovery: true, enableMCP: false, enableLsp: false,
    skipPythonPreflight: true, bindProcessState: false, skills: [], rules: [], contextFiles: [],
  });
  // Prompt preflight validates registry credentials before the synthetic stream runs.
  session.modelRegistry.authStorage.keys.setConfig("openai", "synthetic-fixture-only");
  try {
    const errors: unknown[] = [];
    await initializeExtensions(session, {
      reportSendError: (_action: string, error: unknown) => errors.push(error),
      reportRuntimeError: (error: unknown) => errors.push(error),
    });
    const active = [{ name: "Plan", tasks: [{ content: "Keep tracking", status: "in_progress" }] }];
    const CORE = "mid-run-todo-nudge";
    const FIFTH = "todo-nudge";
    type Batch = { count: number; todos?: boolean };
    let batches: Batch[] = [];
    let call = 0;
    session.agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      const batch = batches.shift();
      const tools: ToolCall[] = Array.from({ length: batch?.count ?? 0 }, () => ({
        type: "toolCall", name: "write", id: `write-${++call}`,
        arguments: { path: `result-${call}.txt`, content: "fixture\n" },
      }));
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        content: tools.length ? tools : [{ type: "text", text: "Fixture done." }],
        stopReason: tools.length ? "toolUse" : "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      queueMicrotask(async () => {
        if (batch?.todos !== undefined) {
          const phases = batch.todos ? active : [];
          // Simulate a todo snapshot arriving without a model todo call in this request.
          session.setTodoPhases(phases);
          await session.extensionRunner.emitToolResult({
            type: "tool_result", toolName: "todo", toolCallId: "fixture-todo", input: {},
            content: [], details: { phases }, isError: false,
          });
        }
        stream.push({ type: "start", partial: message });
        tools.forEach((toolCall, contentIndex) => stream.push({ type: "toolcall_end", toolCall, contentIndex, partial: message }));
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end(message);
      });
      return stream;
    };
    const nudges = () => session.messages.flatMap((message: { role: string; customType?: string; content: unknown }) =>
      message.role === "custom" && (message.customType === CORE ||
        (message.customType === FIFTH && String(message.content).includes("todo 없이"))) ? [message.customType] : []);
    async function run(source: "rpc" | "interactive" | "extension", label: string, expected: string[], ...steps: Batch[]) {
      const nudgeStart = nudges().length;
      const writeStart = writes.length;
      const expectedWrites = steps.reduce((count, batch) => count + batch.count, 0);
      batches = steps;
      const runner = session.extensionRunner;
      if (runner.hasHandlers("input")) await runner.emitInput(label, undefined, source);
      await session.prompt(label, { synthetic: source === "extension" });
      await session.waitForRunEnd();
      assert.deepEqual(errors, [], `${label}: extension error`);
      assert.equal(batches.length, 0, `${label}: all scripted steps ran`);
      assert.equal(writes.length - writeStart, expectedWrites, `${label}: all writes ran`);
      assert.ok(writes.slice(writeStart).every(isError => !isError), `${label}: all writes succeeded`);
      assert.deepEqual(nudges().slice(nudgeStart), expected, label);
      console.log(`${label}: ${expected.join(", ") || "no reminders"}`);
    }

    await run("rpc", "Core first; todo progress and another threshold do not rearm it", [CORE],
      { count: 12, todos: true }, { count: 12, todos: true }, { count: 5, todos: false });
    await run("extension", "An extension input and new prompt cycle do not reset the request cap", [],
      { count: 12, todos: true }, { count: 0, todos: false });
    assert.ok(session.sessionFile, "fixture has a transcript to reload");
    const sessionId = session.sessionId;
    assert.equal(reloads, 0);
    await session.reload();
    assert.equal(session.sessionId, sessionId, "reloaded the same transcript");
    assert.equal(reloads, 1, "reload emitted session_switch");
    await run("extension", "Reloading the same transcript keeps the request cap", [],
      { count: 12, todos: true }, { count: 0, todos: false });
    await run("interactive", "Fifth call first; an eligible core reminder cannot follow", [FIFTH],
      { count: 5 }, { count: 12, todos: true }, { count: 0, todos: false });
    await run("rpc", "The next direct input gets a fresh core reminder", [CORE],
      { count: 12, todos: true }, { count: 0, todos: false });
    supersedeAfterWrite = writes.length + 5;
    await run("interactive", "A newer input drops a fifth-call reminder already ready for injection", [], { count: 5 });
    cfgTodoMidRunNudges.set(session.settings, "off");
    await run("interactive", "Turning off periodic core reminders does not turn off the fifth-call reminder", [FIFTH], { count: 5 });
    cfgTodoMidRunNudges.set(session.settings, "capped");
    for (const extension of session.extensionRunner.extensions) extension.handlers.delete("input");
    await run("rpc", "The host opens a new request even without any extension input handlers", [CORE],
      { count: 12, todos: true }, { count: 12, todos: true }, { count: 0, todos: false });
  } finally {
    await session.dispose();
    session.modelRegistry.authStorage.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
