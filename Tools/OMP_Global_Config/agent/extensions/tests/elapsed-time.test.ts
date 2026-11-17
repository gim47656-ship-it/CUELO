import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type ImageContent, type Message, type ToolResultMessage, type UserMessage } from "@oh-my-pi/pi-ai";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, Settings, type AgentSession, type ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import elapsedTime from "../elapsed-time";

const sentence = "Time matters here: do not spend time that can be avoided, and the earlier a correct result is obtained, the better.";
const user = (timestamp = 1000, content: UserMessage["content"] = "Task"): UserMessage => ({ role: "user", timestamp, content });
const assistant: AssistantMessage = {
  role: "assistant", timestamp: 2000, content: [{ type: "text", text: "working" }],
  api: "openai-completions", provider: "elapsed-test", model: "fake", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const result = (id: string, timestamp: number, content: ToolResultMessage["content"] = [{ type: "text", text: "result" }]): ToolResultMessage =>
  ({ role: "toolResult", toolCallId: id, toolName: "read", timestamp, content, isError: false });
const image: ImageContent = { type: "image", data: "unchanged", mimeType: "image/png" };

function harness(kind = "sub", name = "maker", manager?: Pick<SessionManager, "getBranch">) {
  let handler: (event: { messages: AgentMessage[] }, ctx: unknown) => { messages: AgentMessage[] } | undefined;
  elapsedTime({ on: (event: string, callback: typeof handler) => {
    expect(event).toBe("context");
    handler = callback;
  } } as unknown as ExtensionAPI);
  return (messages: AgentMessage[]) => handler!({ messages: structuredClone(messages) }, {
    agent: { kind, name },
    sessionManager: manager ?? { getBranch: () => messages.map((message) => ({ type: "message", message })) },
  })?.messages;
}
function contentOf(message: AgentMessage | undefined) {
  return message && "content" in message ? message.content : undefined;
}
function texts(message: AgentMessage | undefined) {
  const content = contentOf(message);
  return typeof content === "string" ? content : content?.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n") ?? "";
}

describe("Maker elapsed time", () => {
  test("appends the sentence once and a separate first-request clock without mutating the task", () => {
    const input = [user()];
    const output = harness()(input)!;
    expect(contentOf(output[0])).toEqual([{ type: "text", text: `Task\n\n${sentence}` }, { type: "text", text: "[elapsed 0s]" }]);
    expect(input).toEqual([user()]);
  });

  test("keeps earlier sent bytes across three deep-copied requests, selecting only the last parallel result", () => {
    const run = harness();
    const original = [user()];
    const first = run(original)!;
    const secondInput = [...original, assistant, result("a", 5000), result("b", 8500)];
    const second = run(secondInput)!;
    expect(JSON.stringify(second[0])).toBe(JSON.stringify(first[0]));
    expect(second[1]).toEqual(assistant);
    expect(second[2]).toEqual(secondInput[2]);
    expect(texts(second[3])).toBe("result\n\n[elapsed 7s]");
    const third = run([...secondInput, { ...assistant, timestamp: 9000 }, result("c", 13100)])!;
    expect(JSON.stringify(third.slice(0, 4))).toBe(JSON.stringify(second));
    expect(texts(third[5])).toBe("result\n\n[elapsed 12s]");
    expect(JSON.stringify(third).split(sentence)).toHaveLength(2);
    expect(secondInput[3]).toEqual(result("b", 8500));
  });

  test("reload and no-new-input retries reproduce arrival-based clocks, not current wall time", () => {
    const input = [user(), assistant, result("a", 253999)];
    const first = harness()(input)!;
    const afterReload = harness()(input)!;
    expect(JSON.stringify(afterReload)).toBe(JSON.stringify(first));
    expect(texts(first[2])).toBe("result\n\n[elapsed 252s]");
    const retry = harness()([...input, { ...assistant, timestamp: 999999 }])!;
    expect(JSON.stringify(retry.slice(0, 3))).toBe(JSON.stringify(first));
  });

  test("preserves images and metadata and appends in the last tool-result text block", () => {
    const input = [user(1000, [{ type: "text", text: "Task" }, image]), assistant,
      { ...result("a", 4000, [{ type: "text", text: "one" }, { type: "text", text: "two" }, image]), details: { extra: true }, isError: true }];
    const output = harness()(input)!;
    expect(contentOf(output[0])).toEqual([{ type: "text", text: `Task\n\n${sentence}` }, image, { type: "text", text: "[elapsed 0s]" }]);
    expect(output[2]).toEqual({ ...input[2], content: [{ type: "text", text: "one" }, { type: "text", text: "two\n\n[elapsed 3s]" }, image] });
    const imageOnly = harness()([user(), assistant, result("a", 5000, [image])])!;
    expect(contentOf(imageOnly[2])).toEqual([image, { type: "text", text: "[elapsed 4s]" }]);
  });

  test("stamps a new parent IRC steer, leaves developer content untouched, and clamps negative time", () => {
    const developer = { role: "developer" as const, content: "stable", timestamp: 6000 };
    const steer = { role: "custom" as const, customType: "irc:incoming", content: "Continue", timestamp: 5000, display: true };
    const output = harness()([user(), assistant, steer, developer])!;
    expect(texts(output[2])).toBe("Continue\n[elapsed 4s]");
    expect(output[3]).toEqual(developer);
    expect(texts(harness()([user(), assistant, result("a", 0)])![2])).toEndWith("[elapsed 0s]");
  });

  test("R1-ANT-1: compaction retains the original task origin even when the task user is gone", async () => {
    const manager = SessionManager.inMemory(process.cwd());
    try {
      manager.appendMessage(user());
      manager.appendMessage(assistant);
      const kept = manager.appendMessage(result("a", 253999));
      manager.appendCompaction("Task summary", undefined, kept, 50000);
      const compacted = manager.buildSessionContext().messages;
      expect(compacted.some((message) => message.role === "user")).toBe(false);
      const first = harness("sub", "maker", manager)(compacted)!;
      expect(texts(first?.at(-1))).toBe("result\n\n[elapsed 252s]");
      manager.appendMessage({ ...assistant, timestamp: 254999 });
      manager.appendMessage(user(301999, "Continue"));
      const next = harness("sub", "maker", manager)(manager.buildSessionContext().messages)!;
      expect(texts(next.at(-1))).toBe("Continue\n[elapsed 300s]");
      expect(JSON.stringify(next.slice(0, first.length))).toBe(JSON.stringify(first));
    } finally {
      await manager.close();
    }
  });

  test.each([["main", "main"], ["main", "maker"], ["sub", "advisor"], ["sub", "reviewer"], ["sub", "sub"]])("does not alter %s/%s", (kind, name) => {
    expect(harness(kind, name)([user(), assistant, result("a", 4000)])).toBeUndefined();
  });

  test("does not invent a task for empty or tool-only context", () => {
    expect(harness()([])).toBeUndefined();
    expect(harness()([result("a", 5000)])).toBeUndefined();
  });

  test("R2-ANT-1: pre-task content is not retroactively stamped when the first task arrives", () => {
    const prior = result("before-task", 5000);
    const run = harness();
    expect(run([prior])).toBeUndefined();
    const output = run([prior, assistant, user(9000)])!;
    expect(output[0]).toEqual(prior);
    expect(texts(output[2])).toBe(`Task\n\n${sentence}\n[elapsed 0s]`);
  });
});

// Actual SDK loading, raw-history cloning, conversion and agent tool loop, without provider traffic.
test.each([false, true])("loaded SDK read-tool round trip preserves the prefix (live IRC aside=%s)", async (injectSteer) => {
  const root = mkdtempSync(join(tmpdir(), "elapsed-time-sdk-"));
  const auth = await AuthStorage.create(join(root, "agent.db"));
  const registry = new ModelRegistry(auth, join(root, "models.yml"));
  registry.registerProvider("elapsed-test", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1/v1", apiKey: "local",
    models: [{ id: "fake", name: "fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  const model = registry.find("elapsed-test", "fake")!;
  const manager = SessionManager.create(root, join(root, "sessions"));
  let session: AgentSession | undefined;
  try {
    ({ session } = await createAgentSession({
      cwd: root, agentDir: root, model, modelRegistry: registry, sessionManager: manager,
      settings: Settings.isolated({ tools: { approvalMode: "yolo" }, compaction: { enabled: false } } as never),
      preloadedExtensionPaths: [resolve(import.meta.dir, "../elapsed-time.ts")], disableExtensionDiscovery: true,
      bindProcessState: false, taskDepth: 1, agentName: "maker", agentId: "elapsed-maker", parentAgentId: "elapsed-main",
      enableMCP: false, enableLsp: false, skipPythonPreflight: true, skills: [], rules: [], contextFiles: [], toolNames: ["read"],
    }));
    const requests: Array<{ system: string | undefined; messages: Message[] }> = [];
    session.agent.streamFn = ((_model: unknown, context: { systemPrompt?: string; messages: Message[] }) => {
      requests.push({ system: context.systemPrompt, messages: structuredClone(context.messages) });
      const first = requests.length === 1;
      const stream = createAssistantMessageEventStream();
      const message = {
        role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        content: first ? [{ type: "toolCall" as const, id: "elapsed-read", name: "read", arguments: { path: import.meta.path, i: "Reading clock fixture" } }] : [{ type: "text" as const, text: "done" }],
        stopReason: first ? "toolUse" as const : "stop" as const,
      };
      queueMicrotask(async () => {
        stream.push({ type: "start", partial: message });
        if (first && injectSteer) await session!.sendCustomMessage({
          customType: "irc:incoming", content: "Continue the same task.", display: false, attribution: "agent",
        }, { deliverAs: "aside" });
        if (first) stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: message.content[0] as never, partial: message });
        stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
        stream.end();
      });
      return stream;
    }) as never;
    await session.prompt("Read the fixture once and finish.");
    expect(requests).toHaveLength(2);
    expect(requests[1].system).toBe(requests[0].system);
    const initial = requests[0].messages.find((message) => message.role === "user")!;
    expect(texts(initial)).toContain(sentence);
    expect(texts(initial)).toContain("[elapsed 0s]");
    expect(JSON.stringify(requests[1].messages.find((message) => message.role === "user"))).toBe(JSON.stringify(initial));
    const tool = requests[1].messages.find((message) => message.role === "toolResult")!;
    if (!injectSteer) expect(texts(tool)).toMatch(/\n\n\[elapsed \d+s\]$/);
    else expect(requests[1].messages.some((message) => texts(message).includes("Continue the same task.") && /\[elapsed \d+s\]$/.test(texts(message)))).toBe(true);
    expect(tool.role === "toolResult" && tool.isError).toBe(false);
    expect(texts(session.agent.state.messages.find((message) => message.role === "user"))).not.toContain(sentence);
    expect(texts(session.agent.state.messages.find((message) => message.role === "toolResult"))).not.toMatch(/\[elapsed \d+s\]$/);
    expect(manager.getEntries().some((entry) => entry.type === "custom" && entry.customType.includes("elapsed"))).toBe(false);
  } finally {
    await session?.dispose();
    await manager.close();
    auth.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
