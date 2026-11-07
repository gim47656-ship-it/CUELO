import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import argonPreflight from "../../cuelo-plugins/argon-preflight/index";

// The plugin's real handlers make the real completion call; a local OpenAI-compatible server stands in for the
// preflight model and records the user prompt it was sent.
const prompts: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let root: string;
let registry: ModelRegistry;

beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }> };
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
  registry.registerProvider("fakepre", {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "local", api: "openai-completions",
    models: [{ id: "argon", name: "argon", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }],
  });
});
afterAll(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { prompts.length = 0; });

type Handler = (event: unknown, ctx: unknown) => unknown;

/** One Main session with `restored` user turns already on its saved branch. */
async function mainSession(restored: string[] = []) {
  const handlers = new Map<string, Handler[]>();
  const pi = { zod: z, on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), registerTool: () => {}, sendMessage: () => {} };
  argonPreflight(pi as never);
  const model = registry.find("fakepre", "argon");
  const ctx = {
    cwd: root, agent: { kind: "main" }, ui: { setWidget: () => {} }, models: { resolve: () => model }, modelRegistry: registry,
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
  };
}

const withPreflightRole = <T>(fn: () => Promise<T>): Promise<T> =>
  withActiveSettings(Settings.isolated({ modelRoles: { preflight: "fakepre/argon" } }), fn);
const LATEST = "New requirement: LATEST_CONDITION_EXPORT_ONLY_CSV. Do not produce a PDF.";
const older = (size: number) => Array.from({ length: 5 }, (_, i) => `OLDER_TURN_${i + 1}: ${"x".repeat(size)}`);
/** The prompt's recent-user section, between its heading and the plan. */
const recentSection = (prompt: string) => prompt.slice(prompt.indexOf("# 사용자의 최근 말\n"), prompt.indexOf("\n\n# 발주"));

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
