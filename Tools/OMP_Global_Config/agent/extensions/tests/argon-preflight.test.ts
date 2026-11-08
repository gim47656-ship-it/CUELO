import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { createExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/model-api";
import { findScopedSettings, Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import argonPreflight from "../../cuelo-plugins/argon-preflight/index";

// The plugin's real handlers make the real completion call; a local OpenAI-compatible server stands in for the
// opposite-family review role, records the user prompt and reports which model id was actually served.
const prompts: string[] = [];
const served: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let root: string;
let registry: ModelRegistry;

beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }> };
    served.push(body.model);
    const user = body.messages.find((m) => m.role === "user")?.content;
    prompts.push(typeof user === "string" ? user : (user as Array<{ text?: string }>).map((p) => p.text ?? "").join(""));
    const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "1. CSV 조건 확인" }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ];
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  root = mkdtempSync(join(tmpdir(), "argon-preflight-test-"));
  registry = new ModelRegistry(await AuthStorage.create(join(root, "agent.db")), join(root, "models.yml"));
  const catalog = (id: string) => ({ id, name: id, reasoning: false, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 });
  const provider = (name: string, ids: string[]) => registry.registerProvider(name, {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "local", api: "openai-completions", models: ids.map(catalog),
  });
  // Main identities and both review roles keep their real provider families: `authorFamily` reads the family from the
  // provider, so a review role under a family-less provider would be rejected as a wrong-family target.
  provider("anthropic", ["claude-main", "claude-reviewer"]);
  provider("openai-codex", ["gpt-main", "gpt-reviewer"]);
  provider("google-vertex", ["gemini-4-argon"]);
  provider("aistudio", ["gemini-4-argon"]);
  provider("fakepre", ["reviewer"]);
  provider("hive", ["deepseek-ai/deepseek-v4.1-flash-1017"]);
});
afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { prompts.length = 0; served.length = 0; });

type Handler = (event: unknown, ctx: unknown) => unknown;

/** One Main session on `mainModel` with `restored` user turns already on its saved branch. */
async function mainSession(restored: string[] = [], mainModel = "openai-codex/gpt-main", kind: "main" | "sub" = "main") {
  const handlers = new Map<string, Handler[]>();
  const pi = { zod: z, on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerTool: () => {}, sendMessage: () => {} };
  argonPreflight(pi as never);
  // A model id can itself contain a slash (hive/deepseek-ai/deepseek-v4.1-flash-1017), so only the provider is split off.
  const cut = mainModel.indexOf("/");
  const model = registry.find(mainModel.slice(0, cut), mainModel.slice(cut + 1));
  const ctx = {
    cwd: root, agent: { kind }, ui: { setWidget: () => {} }, model,
    models: createExtensionModelQuery(registry, findScopedSettings(root), () => model), modelRegistry: registry,
    sessionManager: { getBranch: () => restored.map((text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })) },
  };
  const fire = async (name: string, event: unknown) => {
    let out: unknown;
    for (const fn of handlers.get(name) ?? []) out = (await fn(event, ctx)) ?? out;
    return out;
  };
  await fire("session_start", {});
  return {
    say: async (text: string) => {
      await fire("input", { source: "interactive", text });
      await fire("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
    },
    dispatch: () => fire("tool_call", { toolName: "task", input: { tasks: [{ name: "Export", task: "Generate the requested export." }] } }) as Promise<{ block?: boolean } | undefined>,
    tool: () => (handlers.get("lab_preflight") as unknown as Handler[] | undefined) ?? [],
  };
}

/** Main identities plus the two existing review roles; the anthropic Main reads the OpenAI role and the reverse. */
const reviewRoles = { crossReviewOpenAI: "openai-codex/gpt-reviewer", crossReviewAnthropic: "anthropic/claude-reviewer" };
const withRoles = <T>(modelRoles: Record<string, string>, fn: () => Promise<T>): Promise<T> =>
  withActiveSettings(Settings.isolated({ modelRoles: { ...reviewRoles, ...modelRoles } }), fn);
const withPreflightRole = <T>(fn: () => Promise<T>): Promise<T> => withRoles({}, fn);
const LATEST = "New requirement: LATEST_CONDITION_EXPORT_ONLY_CSV. Do not produce a PDF.";
const older = (size: number) => Array.from({ length: 5 }, (_, i) => `OLDER_TURN_${i + 1}: ${"x".repeat(size)}`);
/** The prompt's recent-user section, between its heading and the plan. */
const recentSection = (prompt: string) => prompt.slice(prompt.indexOf("# 사용자의 최근 말\n"), prompt.indexOf("\n\n# 발주"));

describe("argon-preflight counterpart selection", () => {
  test("a GPT Main asks the existing OpenAI-task Anthropic review role, and that model is the one that answers", async () => {
    let blocked: boolean | undefined;
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      blocked = (await s.dispatch())?.block;
    });
    expect(blocked).toBe(true);
    expect(served).toEqual(["claude-reviewer"]);
    expect(prompts).toHaveLength(1);
  });

  test("an Anthropic Main asks the existing Anthropic-task OpenAI review role instead", async () => {
    let blocked: boolean | undefined;
    await withPreflightRole(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      await s.say(LATEST);
      blocked = (await s.dispatch())?.block;
    });
    expect(blocked).toBe(true);
    expect(served).toEqual(["gpt-reviewer"]);
  });

  test("a Google Main is a recognized family and asks the Anthropic review role", async () => {
    for (const main of ["google-vertex/gemini-4-argon", "aistudio/gemini-4-argon"]) {
      served.length = 0;
      let blocked: boolean | undefined;
      await withPreflightRole(async () => {
        const s = await mainSession([], main);
        await s.say(LATEST);
        blocked = (await s.dispatch())?.block;
      });
      expect(blocked, main).toBe(true);
      expect(served, main).toEqual(["claude-reviewer"]);
    }
  });

  test("a Main whose family has no review counterpart on this PC stays silent instead of guessing a model", async () => {
    let result: { block?: boolean } | undefined;
    await withRoles({ crossReviewOpenAI: "", crossReviewAnthropic: "" }, async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      result = await s.dispatch();
    });
    expect(result?.block).toBeUndefined();
    expect(prompts).toHaveLength(0);
  });

  test("a registered non-Anthropic Main such as Hive DeepSeek still asks the Anthropic review role", async () => {
    let blocked: boolean | undefined;
    await withPreflightRole(async () => {
      const s = await mainSession([], "hive/deepseek-ai/deepseek-v4.1-flash-1017");
      await s.say(LATEST);
      blocked = (await s.dispatch())?.block;
    });
    expect(blocked).toBe(true);
    expect(served).toEqual(["claude-reviewer"]);
  });

  test("a Main whose model identity is missing sends nothing", async () => {
    let result: { block?: boolean } | undefined;
    await withPreflightRole(async () => {
      const s = await mainSession([], "fakepre/missing-model");
      await s.say(LATEST);
      result = await s.dispatch();
    });
    expect(result?.block).toBeUndefined();
    expect(prompts).toHaveLength(0);
    expect(served).toHaveLength(0);
  });

  test("a counterpart slot pointing at a same-family model sends no request", async () => {
    let result: { block?: boolean } | undefined;
    // A GPT Main's Anthropic-lane slot misconfigured to an OpenAI model: resolve() succeeds, the family does not.
    await withRoles({ crossReviewAnthropic: "openai-codex/gpt-reviewer" }, async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      result = await s.dispatch();
    });
    expect(result?.block).toBeUndefined();
    expect(served).toHaveLength(0);
  });

  test("a child session sends no preflight request even when the counterpart role resolves", async () => {
    let result: { block?: boolean } | undefined;
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main", "sub");
      await s.say(LATEST);
      result = await s.dispatch();
    });
    expect(result?.block).toBeUndefined();
    expect(prompts).toHaveLength(0);
    expect(served).toHaveLength(0);
  });
});

describe("argon-preflight recent user turns", () => {
  test("a short history reaches the model whole, oldest first, with nothing marked as left out", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      for (const turn of older(20)) await s.say(turn);
      await s.say(LATEST);
      expect((await s.dispatch())?.block).toBe(true);
    });
    expect(prompts).toHaveLength(1);
    const section = recentSection(prompts[0]);
    const order = [...older(20), LATEST].map((turn) => section.indexOf(turn));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
    expect(section).not.toContain("생략");
  });

  test("long earlier turns no longer push the latest instruction out of a live session", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      for (const turn of older(1960)) await s.say(turn);
      await s.say(LATEST);
      expect((await s.dispatch())?.block).toBe(true);
    });
    expect(prompts).toHaveLength(1);
    const section = recentSection(prompts[0]);
    expect(section).toContain(`(6) ${LATEST}`);
    expect(section).toContain("앞선 발언 3개 생략");
    expect(section).not.toContain("OLDER_TURN_2:");
    expect(section.indexOf("OLDER_TURN_4:")).toBeLessThan(section.indexOf("OLDER_TURN_5:"));
    expect(section.indexOf("OLDER_TURN_5:")).toBeLessThan(section.indexOf(LATEST));
    expect(section.length).toBeLessThan(6_100);
  });

  test("the latest instruction after a restored long history reaches the model", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession(older(1960));
      await s.say(LATEST);
      expect((await s.dispatch())?.block).toBe(true);
    });
    expect(prompts).toHaveLength(1);
    expect(recentSection(prompts[0])).toContain(`(6) ${LATEST}`);
  });
});
