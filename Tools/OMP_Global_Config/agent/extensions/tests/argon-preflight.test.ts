import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import { createExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/model-api";
import { findScopedSettings, Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import argonPreflight from "../../cuelo-plugins/argon-preflight/index";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";

// The plugin's real handlers make the real completion call; a local OpenAI-compatible server stands in for the
// opposite-family review role, records the user prompt and reports which model id was actually served.
const prompts: string[] = [];
const served: string[] = [];
/** Provider tag of each request, read from the base URL path each fake provider registers under. */
const via: string[] = [];
type Behavior = "ok" | "quota" | "outage" | "empty" | "secret" | "secretCut" | "hang" | { delayMs: number };
/** What the stand-in server does for a model id; an id with no entry answers normally. */
const behavior = new Map<string, Behavior>();
/** Runs when a request for that model id reaches the server, before it answers. */
const onRequest = new Map<string, () => void>();
let server: ReturnType<typeof Bun.serve>;
let root: string;
let registry: ModelRegistry;

beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }> };
    served.push(body.model);
    via.push(new URL(request.url).pathname.split("/")[1] ?? "");
    const user = body.messages.find((m) => m.role === "user")?.content;
    prompts.push(typeof user === "string" ? user : (user as Array<{ text?: string }>).map((p) => p.text ?? "").join(""));
    onRequest.get(body.model)?.();
    const mode = behavior.get(`${via.at(-1)}/${body.model}`) ?? behavior.get(body.model) ?? "ok";
    // `x-should-retry: false` makes the transport surface this daily-quota 429 at once; a bare 429 would be replayed six times over ~15 s inside completeSimple.
    if (mode === "quota") return new Response(JSON.stringify({ error: { message: "You exceeded your current quota. RESOURCE_EXHAUSTED", code: 429 } }), { status: 429, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    if (mode === "outage") return new Response(JSON.stringify({ error: { message: "socket failed" } }), { status: 400, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    if (mode === "hang") {
      const aborted = Promise.withResolvers<void>();
      request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      return new Response("", { status: 499 });
    }
    // The latency is the thing under test (a counterpart slower than the budget left over); a fake clock cannot slow a real socket.
    if (typeof mode === "object") await Bun.sleep(mode.delayMs);
    const text = mode === "empty" ? "" : mode === "secret" || mode === "secretCut" ? "key " + ["sk", "a".repeat(30)].join("-") : "1. CSV 조건 확인";
    // "secretCut" ends on the output limit instead of a normal stop: an unusable response that still carries the secret.
    const finish = mode === "secretCut" ? "length" : "stop";
    const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ];
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  root = mkdtempSync(join(tmpdir(), "argon-preflight-test-"));
  registry = new ModelRegistry(await AuthStorage.create(join(root, "agent.db")), join(root, "models.yml"));
  const catalog = (id: string) => ({ id, name: id, reasoning: false, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 });
  const provider = (name: string, ids: string[]) => registry.registerProvider(name, {
    baseUrl: `http://127.0.0.1:${server.port}/${name}/v1`, apiKey: "local", api: "openai-completions", models: ids.map(catalog),
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
beforeEach(() => { prompts.length = 0; served.length = 0; via.length = 0; behavior.clear(); onRequest.clear(); });

type Handler = (event: unknown, ctx: unknown) => unknown;

type ToolDef = { execute: (callId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
type Dispatched = { block?: boolean; reason?: string } | undefined;

/** One Main session on `mainModel` with `restored` user turns already on its saved branch. */
async function mainSession(restored: string[] = [], mainModel = "openai-codex/gpt-main", kind: "main" | "sub" = "main") {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();
  /** Asides the plugin sent (mid-work direction checks). */
  const messages: string[] = [];
  const pi = {
    zod: z, on: (name: string, fn: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerTool: (tool: ToolDef & { name: string }) => tools.set(tool.name, tool),
    sendMessage: (message: { content: string }) => messages.push(message.content),
  };
  argonPreflight(pi as never);
  // A model id can itself contain a slash (hive/deepseek-ai/deepseek-v4.1-flash-1017), so only the provider is split off.
  const cut = mainModel.indexOf("/");
  const model = registry.find(mainModel.slice(0, cut), mainModel.slice(cut + 1));
  /** Every selector the plugin asked the runtime to resolve, in order. */
  const resolved: string[] = [];
  /** The plugin's panel lines (its own history, newest last). */
  let notes: string[] = [];
  const query = createExtensionModelQuery(registry, findScopedSettings(root), () => model);
  const ctx = {
    cwd: root, agent: { kind }, ui: { setWidget: (_key: string, lines: string[]) => { notes = lines; } }, model,
    models: { ...query, resolve: (spec: string) => { resolved.push(spec); return query.resolve(spec); } }, modelRegistry: registry,
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
    dispatch: (brief = "Generate the requested export.") => fire("tool_call", { toolName: "task", input: { tasks: [{ name: "Export", task: brief }] } }) as Promise<Dispatched>,
    call: (toolName: string, input: unknown) => fire("tool_call", { toolName, input }) as Promise<Dispatched>,
    steer: (text: string) => fire("message_start", { message: { role: "user", content: text } }),
    switchSession: () => fire("session_switch", {}),
    preflight: (params: { plan: string; question?: string }, signal?: AbortSignal) => tools.get("lab_preflight")!.execute("call", params, signal, undefined, ctx),
    messages, resolved, get notes() { return notes; },
  };
}

/** Main identities plus the two existing review roles; the anthropic Main reads the OpenAI role and the reverse. */
const reviewRoles = { crossReviewOpenAI: "openai-codex/gpt-reviewer", crossReviewAnthropic: "anthropic/claude-reviewer" };
const withRoles = <T>(modelRoles: Record<string, string>, fn: () => Promise<T>): Promise<T> =>
  withActiveSettings(Settings.isolated({ modelRoles: { ...reviewRoles, ...modelRoles } }), fn);
/** No `implGemini` role: the Gemini primary cannot resolve, so every dispatch reaches the opposite-family counterpart. */
const withPreflightRole = <T>(fn: () => Promise<T>): Promise<T> => withRoles({}, fn);
const GEMINI = "aistudio/gemini-4-argon";
const withGemini = <T>(fn: () => Promise<T>, role = `${GEMINI}:auto`): Promise<T> => withRoles({ implGemini: role }, fn);
const LATEST = "New requirement: LATEST_CONDITION_EXPORT_ONLY_CSV. Do not produce a PDF.";
const older = (size: number) => Array.from({ length: 5 }, (_, i) => `OLDER_TURN_${i + 1}: ${"x".repeat(size)}`);
/** The prompt's recent-user section, between its heading and the plan. */
const recentSection = (prompt: string) => prompt.slice(prompt.indexOf("# 사용자의 최근 말\n"), prompt.indexOf("\n\n# 발주"));

describe("argon-preflight counterpart fallback when no Gemini role resolves", () => {
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

const MAINS: Array<[main: string, counterpart: string]> = [["openai-codex/gpt-main", "claude-reviewer"], ["anthropic/claude-main", "gpt-reviewer"]];
const GEMINI_ID = "gemini-4-argon";
type Session = Awaited<ReturnType<typeof mainSession>>;

/**
 * The background direction check exposes no promise, so tests poll the aside or panel note it ends with: a real
 * in-flight request is awaited, not a guessed delay.
 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

describe("argon-preflight Gemini first", () => {
  test("a Gemini answer is the only call and no counterpart role is resolved, for either Main family", async () => {
    for (const [main, counterpart] of MAINS) {
      served.length = 0;
      let out: Dispatched;
      let s!: Session;
      await withGemini(async () => {
        s = await mainSession([], main);
        await s.say(LATEST);
        out = await s.dispatch();
      });
      expect(out?.block, main).toBe(true);
      expect(served, main).toEqual([GEMINI_ID]);
      expect(s.resolved.filter((spec) => spec.includes("crossReview")), main).toEqual([]);
      expect(out?.reason, main).toContain(GEMINI);
      expect(out?.reason, main).not.toContain(counterpart);
      expect(out?.reason, main).not.toContain("대체");
    }
  });

  test("the Gemini assignment this PC configured is the provider that is called", async () => {
    for (const provider of ["google-vertex", "aistudio"]) {
      via.length = 0;
      await withGemini(async () => {
        const s = await mainSession();
        await s.say(LATEST);
        expect((await s.dispatch())?.block).toBe(true);
      }, `${provider}/gemini-4-argon:auto`);
      expect(via, provider).toEqual([provider]);
    }
  });

  test("Gemini still answers for a Main with no known identity and no review roles on this PC", async () => {
    let out: Dispatched;
    await withRoles({ implGemini: GEMINI, crossReviewOpenAI: "", crossReviewAnthropic: "" }, async () => {
      const s = await mainSession([], "fakepre/missing-model");
      await s.say(LATEST);
      out = await s.dispatch();
    });
    expect(out?.block).toBe(true);
    expect(served).toEqual([GEMINI_ID]);
  });
});

describe("argon-preflight falls back to the opposite-family role only when Gemini cannot run", () => {
  for (const [main, counterpart] of MAINS) {
    test(`a Gemini usage-limit error sends ${main} to its counterpart once and the report names both models`, async () => {
      behavior.set(GEMINI_ID, "quota");
      let out: Dispatched;
      await withGemini(async () => {
        const s = await mainSession([], main);
        await s.say(LATEST);
        out = await s.dispatch();
      });
      expect(served).toEqual([GEMINI_ID, counterpart]);
      expect(out?.block).toBe(true);
      const lines = out!.reason!.split("\n");
      expect(lines[0]).toStartWith("[사전 점검] 오류가 아니다.");
      expect(lines[0]).toContain(counterpart);
      const note = lines.find((line) => line.includes("대체"))!;
      expect(note).toContain(GEMINI);
      expect(note).toContain("한도");
      expect(note).toContain(counterpart);
    });
  }

  test("an empty Gemini answer is an unusable response and falls back", async () => {
    behavior.set(GEMINI_ID, "empty");
    let out: Dispatched;
    await withGemini(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      await s.say(LATEST);
      out = await s.dispatch();
    });
    // The core's own transport replays an empty completion before it gives up; the counterpart is still asked exactly once, last.
    expect(served[0]).toBe(GEMINI_ID);
    expect(served.filter((id) => id !== GEMINI_ID)).toEqual(["gpt-reviewer"]);
    expect(served.at(-1)).toBe("gpt-reviewer");
    expect(out?.block).toBe(true);
    expect(out?.reason).toContain("응답 이상");
  });

  test("a Gemini role that does not resolve falls back without any Gemini request", async () => {
    let out: Dispatched;
    await withGemini(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      await s.say(LATEST);
      out = await s.dispatch();
    }, "google-antigravity/gemini-3.8-flash");
    expect(served).toEqual(["gpt-reviewer"]);
    expect(out?.block).toBe(true);
    expect(out?.reason).toContain("해석");
  });

  test("the counterpart is tried once: when it fails too the call passes and no third request is made", async () => {
    behavior.set(GEMINI_ID, "quota");
    behavior.set("claude-reviewer", "quota");
    let out: Dispatched;
    await withGemini(async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      out = await s.dispatch();
    });
    expect(served).toEqual([GEMINI_ID, "claude-reviewer"]);
    expect(out?.block).toBeUndefined();
  });
});

describe("argon-preflight makes no second request when the first outcome is not an operating failure", () => {
  test("a secret-looking brief sends nothing to any model", async () => {
    let out: Dispatched;
    await withGemini(async () => {
      const s = await mainSession();
      await s.say(LATEST);
      out = await s.dispatch("Use password: hunter2hunter2 to log in.");
    });
    expect(served).toEqual([]);
    expect(out?.block).toBeUndefined();
  });

  for (const mode of ["secret", "secretCut"] as const) {
    test(`a Gemini answer that carries a secret (${mode === "secret" ? "normal stop" : "cut off at the output limit"}) is dropped and the counterpart is neither looked up nor asked`, async () => {
      behavior.set(GEMINI_ID, mode);
      let out: Dispatched;
      let looked: string[] = [];
      await withGemini(async () => {
        const s = await mainSession();
        await s.say(LATEST);
        out = await s.dispatch();
        looked = s.resolved.filter((spec) => spec.includes("crossReview"));
      });
      expect(served).toEqual([GEMINI_ID]);
      expect(looked).toEqual([]);
      expect(out?.block).toBeUndefined();
    });
  }

  test("cancelling the direct tool call aborts Gemini and never reaches the counterpart", async () => {
    behavior.set(GEMINI_ID, "hang");
    const cancel = new AbortController();
    onRequest.set(GEMINI_ID, () => queueMicrotask(() => cancel.abort()));
    let looked: string[] = [];
    await withGemini(async () => {
      const s = await mainSession();
      await expect(s.preflight({ plan: "Export CSV only." }, cancel.signal)).rejects.toThrow("사전 점검 실패");
      looked = s.resolved.filter((spec) => spec.includes("crossReview"));
    });
    expect(served).toEqual([GEMINI_ID]);
    expect(looked).toEqual([]);
  });

  test("a tool call cancelled before it starts looks up no counterpart even though the Gemini role cannot resolve", async () => {
    const cancel = new AbortController();
    cancel.abort();
    let looked: string[] = [];
    await withPreflightRole(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      await expect(s.preflight({ plan: "Export CSV only." }, cancel.signal)).rejects.toThrow("사전 점검 실패");
      looked = s.resolved.filter((spec) => spec.includes("crossReview"));
    });
    expect(served).toEqual([]);
    expect(looked).toEqual([]);
  });

  test("a new user message while the direct tool call's Gemini request is failing leaves the counterpart unlooked and unasked", async () => {
    behavior.set(GEMINI_ID, "quota");
    let looked: string[] = [];
    await withGemini(async () => {
      const s = await mainSession();
      onRequest.set(GEMINI_ID, () => void s.say("stop"));
      await expect(s.preflight({ plan: "Export CSV only." })).rejects.toThrow("사전 점검 실패");
      looked = s.resolved.filter((spec) => spec.includes("crossReview"));
    });
    expect(served).toEqual([GEMINI_ID]);
    expect(looked).toEqual([]);
  });

  test("a new user message while Gemini is failing makes the check stale and the counterpart is not asked", async () => {
    behavior.set(GEMINI_ID, "quota");
    let out: Dispatched;
    await withGemini(async () => {
      const s = await mainSession();
      await s.say(LATEST);
      onRequest.set(GEMINI_ID, () => void s.say("stop"));
      out = await s.dispatch();
    });
    expect(served).toEqual([GEMINI_ID]);
    expect(out?.block).toBeUndefined();
  });

  test("a session switch while Gemini is failing leaves no counterpart request", async () => {
    behavior.set(GEMINI_ID, "quota");
    let out: Dispatched;
    await withGemini(async () => {
      const s = await mainSession();
      await s.say(LATEST);
      onRequest.set(GEMINI_ID, () => void s.switchSession());
      out = await s.dispatch();
    });
    expect(served).toEqual([GEMINI_ID]);
    expect(out?.block).toBeUndefined();
  });
});

describe("argon-preflight shared deadline", () => {
  /** Moves the plugin's clock forward when Gemini's request arrives, as if that call had run for `ms`. */
  async function dispatchWithGeminiTaking(ms: number): Promise<Dispatched> {
    const realNow = Date.now;
    let skew = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + skew);
    try {
      behavior.set(GEMINI_ID, "quota");
      onRequest.set(GEMINI_ID, () => { skew += ms; });
      let out: Dispatched;
      await withGemini(async () => {
        const s = await mainSession([], "openai-codex/gpt-main");
        await s.say(LATEST);
        out = await s.dispatch();
      });
      return out;
    } finally {
      clock.mockRestore();
    }
  }

  test("a Gemini failure that used the whole foreground budget leaves no time for the counterpart", async () => {
    const out = await dispatchWithGeminiTaking(26_000);
    expect(served).toEqual([GEMINI_ID]);
    expect(out?.block).toBeUndefined();
  });

  test("the counterpart gets only what is left of the budget, not a fresh one", async () => {
    behavior.set("claude-reviewer", { delayMs: 600 });
    // Control: with the whole budget available, the same slow counterpart answers.
    behavior.set(GEMINI_ID, "quota");
    let control: Dispatched;
    await withGemini(async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      control = await s.dispatch();
    });
    expect(control?.block).toBe(true);
    served.length = 0;
    const out = await dispatchWithGeminiTaking(24_900);
    expect(served[0]).toBe(GEMINI_ID);
    expect(out?.block).toBeUndefined();
  });
});

describe("argon-preflight entrypoints share the Gemini-first rule", () => {
  test("lab_preflight asks Gemini first and reports the model that answered", async () => {
    await withGemini(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      const result = await s.preflight({ plan: "Export CSV only." });
      expect(result.content[0]!.text).toContain(GEMINI);
      expect(s.resolved.filter((spec) => spec.includes("crossReview"))).toEqual([]);
    });
    expect(served).toEqual([GEMINI_ID]);
  });

  test("lab_preflight falls back on a Gemini usage-limit error and says which model answered instead", async () => {
    behavior.set(GEMINI_ID, "quota");
    await withGemini(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      const result = await s.preflight({ plan: "Export CSV only." });
      expect(result.content[0]!.text).toContain("openai-codex/gpt-reviewer");
      expect(result.content[0]!.text).toContain("대체");
      expect(result.content[0]!.text).toContain("한도");
    });
    expect(served).toEqual([GEMINI_ID, "gpt-reviewer"]);
  });

  test("lab_preflight fails when neither model can answer, after one counterpart try", async () => {
    behavior.set(GEMINI_ID, "quota");
    behavior.set("gpt-reviewer", "quota");
    await withGemini(async () => {
      const s = await mainSession([], "anthropic/claude-main");
      await expect(s.preflight({ plan: "Export CSV only." })).rejects.toThrow("사전 점검 실패");
    });
    expect(served).toEqual([GEMINI_ID, "gpt-reviewer"]);
  });

  test("new user input waits for the current plan instead of checking the previous one", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export", what: "CSV", path: "out.csv", check: "Read CSV" }] };
      expect((await s.call("lab_goal", frame))?.block).toBe(true);
      await s.call("lab_goal", frame);
      await s.say("Change the export to Excel only.");
      expect((await s.call("lab_goal", { ...frame, goal: "Export Excel only" }))?.block).toBe(true);
      expect(served).toEqual([GEMINI_ID, GEMINI_ID]);
      expect(s.messages).toEqual([]);
      expect(prompts[1]).toContain("Export Excel only");
      await s.steer("Only include the active worksheet.");
      expect((await s.call("lab_goal", frame))?.block).toBe(true);
      expect(served).toHaveLength(3);
    });
  });

  test("one correction survives elapsed time, is remembered, then a changed plan is checked", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", assumptions: ["CSV"], deliverables: [{ id: "export", path: "out.csv" }] };
      expect((await s.call("lab_goal", frame))?.block).toBe(true);
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 21 * 60_000);
      try {
        const corrected = { ...frame, assumptions: ["CSV with header"] };
        expect((await s.call("lab_goal", corrected))?.block).toBeUndefined();
        expect((await s.call("lab_goal", corrected))?.block).toBeUndefined();
        expect(served).toHaveLength(1);
        expect((await s.call("lab_goal", { ...corrected, assumptions: ["CSV without header"] }))?.block).toBe(true);
        expect(served).toHaveLength(2);
      } finally { clock.mockRestore(); }
    });
  });

  test("unrelated goals and tools cannot spend another plan's correction", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      await s.call("lab_goal", frame);
      expect((await s.dispatch())?.block).toBe(true);
      expect((await s.call("lab_goal", { ...frame, goal: "Delete export", deliverables: [{ id: "delete" }] }))?.block).toBe(true);
      expect(served).toHaveLength(3);
    });
  });

  test("an unchanged retry consumes the correction and a path change is checked", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export", path: "out.csv" }] };
      await s.call("lab_goal", frame);
      await s.call("lab_goal", frame);
      expect((await s.call("lab_goal", { ...frame, deliverables: [{ id: "export", path: "other.csv" }] }))?.block).toBe(true);
      expect(served).toHaveLength(2);
      await s.call("lab_goal", { ...frame, size: "small" });
      expect((await s.call("lab_goal", { ...frame, assumptions: ["Changed after small task"] }))?.block).toBe(true);
      expect(served).toHaveLength(3);
    });
  });

  test("a newer plan wins over a delayed earlier check", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      behavior.set(GEMINI_ID, { delayMs: 100 });
      const first = s.call("lab_goal", { op: "frame", goal: "Export", assumptions: ["Old"], deliverables: [{ id: "export" }] });
      await until(() => served.length === 1);
      behavior.delete(GEMINI_ID);
      const current = { op: "frame", goal: "Export", assumptions: ["Current"], deliverables: [{ id: "export" }] };
      expect((await s.call("lab_goal", current))?.block).toBe(true);
      expect((await first)?.block).toBe(true);
      expect((await s.call("lab_goal", current))?.block).toBeUndefined();
      expect(served).toHaveLength(2);
    });
  });

  test("prepared dispatch reuses its corrected full brief but a new ownership contract is checked", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const body = "TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: CSV export\nOWNED_PATHS: src/export.ts\n# Change\nWrite CSV.";
      const input = { context: "Export only", tasks: [{ name: "Export", task: body }] };
      expect((await s.call("maker_route", input))?.block).toBe(true);
      const corrected = { ...input, tasks: [{ name: "Export", task: `${body}\nKeep headers.` }] };
      expect((await s.call("maker_route", corrected))?.block).toBeUndefined();
      expect((await s.call("task", corrected))?.block).toBeUndefined();
      expect((await s.call("task", { context: "PREPARED_CONTEXT", tasks: [{ task: "PREPARED_TASK: b1.1" }] }))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
      const changed = { ...input, tasks: [{ name: "Export", task: body.replace("src/export.ts", "src/other.ts") }] };
      expect((await s.call("maker_route", changed))?.block).toBe(true);
      expect(served).toHaveLength(2);
    });
  });

  test("interleaved goals and dispatches each retain one correction", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      const task = { tasks: [{ name: "Export", task: "TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: Export\nOWNED_PATHS: src/export.ts\n# Change\nWrite CSV." }] };
      expect((await s.call("lab_goal", frame))?.block).toBe(true);
      expect((await s.call("maker_route", task))?.block).toBe(true);
      const corrected = { ...frame, assumptions: ["Keep headers"] };
      expect((await s.call("lab_goal", corrected))?.block).toBeUndefined();
      expect((await s.call("maker_route", task))?.block).toBeUndefined();
      expect((await s.call("lab_goal", corrected))?.block).toBeUndefined();
      expect(served).toHaveLength(2);
    });
  });

  test("new user steering holds an in-flight successful check without granting a retry", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      behavior.set(GEMINI_ID, { delayMs: 100 });
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      const pending = s.call("lab_goal", frame);
      await until(() => served.length === 1);
      await s.steer("Only export Excel, not CSV.");
      expect((await pending)?.block).toBe(true);
      behavior.delete(GEMINI_ID);
      expect((await s.call("lab_goal", frame))?.block).toBe(true);
      expect(served).toHaveLength(2);
      expect(s.messages).toEqual([]);
    });
  });

  test("simultaneous identical checks share one provider request", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      behavior.set(GEMINI_ID, { delayMs: 100 });
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      const results = await Promise.all([s.call("lab_goal", frame), s.call("lab_goal", frame)]);
      expect(results.map((result) => result?.block)).toEqual([true, true]);
      expect(served).toHaveLength(1);
      expect((await s.call("lab_goal", frame))?.block).toBeUndefined();
    });
  });

  test("exact unkeyed dispatch content is reused across preparation and dispatch", async () => {
    await withGemini(async () => {
      const s = await mainSession();
      const input = { context: "Export", tasks: [{ name: "Export", task: "Write CSV." }] };
      expect((await s.call("maker_route", input))?.block).toBe(true);
      expect((await s.call("task", input))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
      expect((await s.call("task", { ...input, context: "Write Excel instead" }))?.block).toBe(true);
      expect(served).toHaveLength(2);
    });
  });
});

const VERTEX = "google-vertex/gemini-4-argon";
const withRoutes = <T>(fn: () => Promise<T>) => withActiveSettings(Settings.isolated({
  modelRoles: { ...reviewRoles, implGemini: `${GEMINI}:auto` },
  retry: { fallbackChains: { [GEMINI]: [VERTEX, "aistudio/gemini-3.8-flash"] } },
}), fn);

describe("argon-preflight same-model routes", () => {
  test("a provider limit tries Vertex and reports the same model through another route", async () => {
    behavior.set(GEMINI, "quota");
    await withRoutes(async () => {
      const s = await mainSession();
      const out = await s.preflight({ plan: "Export CSV." });
      expect(out.content[0]!.text).toStartWith(VERTEX);
      expect(out.content[0]!.text).toContain("같은 모델");
      expect(out.content[0]!.text).toContain("다른 경로");
      expect(s.resolved.filter((spec) => spec.includes("crossReview"))).toEqual([]);
    });
    expect(via).toEqual(["aistudio", "google-vertex"]);
  });

  test("a failed Vertex attempt reaches the counterpart and retains each failure name", async () => {
    behavior.set(GEMINI, "quota");
    behavior.set(VERTEX, "outage");
    await withRoutes(async () => {
      const s = await mainSession();
      const out = await s.preflight({ plan: "Export CSV." });
      expect(out.content[0]!.text).toStartWith("anthropic/claude-reviewer");
      expect(out.content[0]!.text).toContain(GEMINI);
      expect(out.content[0]!.text).toContain(`${VERTEX}) 실패`);
      expect(out.content[0]!.text).toContain("socket failed");
    });
    expect(via).toEqual(["aistudio", "google-vertex", "anthropic"]);
  });

  test("a non-limit error skips Vertex and goes straight to the counterpart", async () => {
    behavior.set(GEMINI, "outage");
    await withRoutes(async () => {
      const s = await mainSession();
      expect((await s.preflight({ plan: "Export CSV." })).content[0]!.text).toStartWith("anthropic/claude-reviewer");
    });
    expect(via).toEqual(["aistudio", "anthropic"]);
  });

  for (const stop of ["cancel", "stale", "deadline", "secret-input", "secret-output", "route-secret", "route-stale", "route-cancel", "route-deadline"] as const) {
    test(`${stop} prevents any further route or counterpart call`, async () => {
      const realNow = Date.now;
      let skew = 0;
      const clock = spyOn(Date, "now").mockImplementation(() => realNow.call(Date) + skew);
      const cancel = new AbortController();
      try {
        await withRoutes(async () => {
          const s = await mainSession();
          behavior.set(GEMINI, stop === "secret-output" ? "secret" : "quota");
          const route = stop.startsWith("route-");
          if (route) behavior.set(VERTEX, stop === "route-secret" ? "secret" : "outage");
          let requests = 0;
          onRequest.set(GEMINI_ID, () => {
            requests++;
            if (requests !== (route ? 2 : 1)) return;
            if (stop.endsWith("cancel")) cancel.abort();
            if (stop.endsWith("stale")) void s.say("Stop the old plan.");
            if (stop.endsWith("deadline")) skew += 121_000;
          });
          await expect(s.preflight({ plan: stop === "secret-input" ? "password: hunter2hunter2" : "Export CSV." }, cancel.signal)).rejects.toThrow("사전 점검 실패");
          expect(via).toEqual(stop === "secret-input" ? [] : route ? ["aistudio", "google-vertex"] : ["aistudio"]);
          expect(s.resolved.filter((spec) => spec.includes("crossReview"))).toEqual([]);
        });
      } finally { clock.mockRestore(); }
    });
  }
});

test("R1-ANT-2 a route-setting error does not reject dispatch or suppress the counterpart", async () => {
  behavior.set(GEMINI, "quota");
  const getter = spyOn(cfgRetryFallbackChains, "get").mockImplementation(() => { throw new Error("route setting unavailable"); });
  try {
    await withRoutes(async () => {
      const s = await mainSession();
      const out = await s.dispatch();
      expect(out?.block).toBe(true);
      expect(out?.reason).toContain("anthropic/claude-reviewer");
    });
    expect(via).toEqual(["aistudio", "anthropic"]);
  } finally { getter.mockRestore(); }
});
