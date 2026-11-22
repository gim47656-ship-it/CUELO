import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import { registerCustomApi, unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { type ExtensionAPI, type ExtensionContext, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { completeReviewer } from "../cross-review";
import { consultModel } from "../consult";
import { interpret } from "../lib/interpreter";
import { createPreflightCheck } from "../lib/preflight-check";
import { callModel, ROLE_PRIMARY } from "../skim";

// Fake transport: a custom API whose first completion is a core-retried thinking-loop stall (100 input tokens) and whose
// second is the real answer (200 input tokens). Core calls onAttempt once per completed result, so a helper that records
// each attempt once leaves two ledger entries totalling 300.
const SOURCE = "helper-usage-test";
const API = "helper-usage-fake-api";
const directories: string[] = [];
let plan: Array<"stall" | "answer"> = [];
let routedModel: string | undefined;

const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

registerCustomApi(API, ((model: { provider: string; id: string }) => {
  const stream = createAssistantMessageEventStream();
  const step = plan.shift() ?? "answer";
  const message: AssistantMessage = step === "stall"
    ? { role: "assistant", api: API, provider: model.provider, model: model.id, timestamp: Date.now(), usage: usage(100), content: [],
      stopReason: "error", errorMessage: "thinking loop", errorId: AIError.create(AIError.Flag.ThinkingLoop) }
    : { role: "assistant", api: API, provider: model.provider, model: routedModel ?? model.id, timestamp: Date.now(), usage: usage(200),
      content: [{ type: "text", text: "final answer" }], stopReason: "stop" };
  queueMicrotask(() => {
    if (step === "stall") stream.push({ type: "error", reason: "error", error: message });
    else stream.push({ type: "done", reason: "stop", message });
    stream.end();
  });
  return stream;
}) as never, SOURCE);

afterAll(() => {
  unregisterCustomApis(SOURCE);
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(provider: string) {
  const cwd = mkdtempSync(join(tmpdir(), "helper-usage-"));
  directories.push(cwd);
  const model = { id: "fake-m", name: "fake", api: API, provider, baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 512 };
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "request" }], timestamp: Date.now() });
  const ctx = {
    cwd, sessionManager, model,
    models: { current: () => ({ provider: "anthropic", id: "main" }), resolve: (selector: string) => selector.startsWith("@") || selector === `${provider}/fake-m` ? model : undefined },
    modelRegistry: { getApiKey: async () => "key", resolver: () => "key" },
    ui: { setWidget: () => {} },
  } as unknown as ExtensionContext;
  const ledger = () => sessionManager.getEntries().filter((entry) => entry.type === "model_usage");
  return { ctx, ledger, leaf: sessionManager.getLeafId() };
}

const signal = new AbortController().signal;
const roles = (modelRoles: Record<string, string>) => <T>(fn: () => Promise<T>) => withActiveSettings(Settings.isolated({ modelRoles }), fn);

interface LedgerEntry { purpose?: string; role?: string; model: string; stopReason?: string; parentId: string | null; usage: { input: number } }

/** Two attempts → two entries (100, 200), none duplicated, each linked to the parent leaf of the request. */
function expectTwoAttempts(entries: LedgerEntry[], purpose: string, leaf: string | null) {
  expect(entries.map((entry) => entry.usage.input)).toEqual([100, 200]);
  expect(entries.reduce((sum, entry) => sum + entry.usage.input, 0)).toBe(300);
  expect(entries.map((entry) => entry.purpose)).toEqual([purpose, purpose]);
  expect(entries.map((entry) => entry.stopReason)).toEqual(["error", "stop"]);
  expect(entries.every((entry) => entry.parentId === leaf)).toBe(true);
}

describe("helper per-attempt usage ledger", () => {
  test("consult records both attempts once", async () => {
    plan = ["stall", "answer"];
    const { ctx, ledger, leaf } = fixture("fakeprov");
    const out = await consultModel({ model: "fakeprov/fake-m", question: "q" }, ctx, signal);
    expect(out.isError).toBe(false);
    expectTwoAttempts(ledger(), "consult", leaf);
  });

  test("skim records both attempts once", async () => {
    plan = ["stall", "answer"];
    const { ctx, ledger, leaf } = fixture("fakeprov");
    const answer = await roles({ skim: "fakeprov/fake-m" })(() => callModel("prompt", ctx, signal, ROLE_PRIMARY));
    expect(answer.text).toBe("final answer");
    const entries = ledger();
    expectTwoAttempts(entries, "skim", leaf);
    expect(entries.map((entry) => entry.role)).toEqual(["skim", "skim"]);
  });

  test("cross_review reviewer records both attempts once", async () => {
    plan = ["stall", "answer"];
    const { ctx, ledger, leaf } = fixture("anthropic");
    const reviewed = await roles({ crossReviewAnthropic: "anthropic/fake-m" })(() => completeReviewer("anthropic", "diff", ctx, signal));
    expect(reviewed.text).toBe("final answer");
    expectTwoAttempts(ledger(), "cross-review", leaf);
  });

  test("interpreter records both attempts once", async () => {
    plan = ["stall", "answer"];
    const { ctx, ledger, leaf } = fixture("fakeprov");
    const result = await roles({ interpreter: "fakeprov/fake-m" })(() => interpret("translate", "korean-reply-translation", ctx, signal));
    expect(result.text).toBe("final answer");
    expectTwoAttempts(ledger(), "korean-reply-translation", leaf);
  });

  test("preflight now records both attempts once", async () => {
    plan = ["stall", "answer"];
    const { ctx, ledger, leaf } = fixture("openai");
    const check = createPreflightCheck({ on: () => {} } as unknown as ExtensionAPI);
    const advice = await roles({ preflightOpenAI: "openai/fake-m" })(() => check.ask(ctx, "plan", "", 30_000));
    expect(advice.ok).toBe(true);
    expectTwoAttempts(ledger(), "preflight", leaf);
  });

  test("the entry names the provider and model that actually answered that attempt", async () => {
    plan = ["stall", "answer"];
    routedModel = "fake-m-routed";
    try {
      const { ctx, ledger } = fixture("fakeprov");
      await consultModel({ model: "fakeprov/fake-m", question: "q" }, ctx, signal);
      expect(ledger().map((entry) => entry.model)).toEqual(["fake-m", "fake-m-routed"]);
    } finally {
      routedModel = undefined;
    }
  });

  test("a failed ledger write does not stop later attempts from being recorded, and the failure is still reported", async () => {
    plan = ["stall", "answer"];
    const { ctx, ledger } = fixture("fakeprov");
    const manager = ctx.sessionManager as unknown as { appendModelUsage: (...args: unknown[]) => unknown };
    const append = manager.appendModelUsage.bind(ctx.sessionManager);
    let writes = 0;
    manager.appendModelUsage = (...args: unknown[]) => {
      if (writes++ === 0) throw new Error("ledger write failed");
      return append(...args);
    };
    const out = await consultModel({ model: "fakeprov/fake-m", question: "q" }, ctx, signal);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("ledger write failed");
    expect(writes).toBe(2);
    expect(ledger().map((entry) => entry.usage.input)).toEqual([200]);
  });
});
