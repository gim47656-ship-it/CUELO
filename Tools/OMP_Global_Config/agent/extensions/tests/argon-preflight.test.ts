import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createExtensionModelQuery } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/model-api";
import { findScopedSettings, Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils";
import { translateReply } from "../korean-reply-guard";
import { createPreflightCheck } from "../lib/preflight-check";

// Real plugin handlers call a local transport fixture to exercise slot selection and requests.
const prompts: string[] = [];
const served: string[] = [];
/** Provider tag of each request, read from the base URL path each fake provider registers under. */
const via: string[] = [];
type Behavior = "ok" | "quota" | "outage" | "verify" | "empty" | "secret" | "secretCut" | "hang" | "clean" | { delayMs: number } | { gate: Promise<void>; after?: "quota" };
/** The thinking effort each request asked for, aligned with `served`. */
const efforts: Array<string | null | undefined> = [];
/** What the stand-in server does for a model id; an id with no entry answers normally. */
const behavior = new Map<string, Behavior>();
/** Runs when a request for that model id reaches the server, before it answers. */
const onRequest = new Map<string, () => void>();
let server: ReturnType<typeof Bun.serve>;
let root: string;
let registry: ModelRegistry;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let fixtureSessionCount = 0;

beforeAll(async () => {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as { model: string; messages: Array<{ role: string; content: unknown }>; reasoning?: string; reasoning_effort?: string };
    served.push(body.model);
    via.push(new URL(request.url).pathname.split("/")[1] ?? "");
    efforts.push(body.reasoning_effort ?? body.reasoning);
    return answer(body, request.signal);
  } });
  async function answer(body: { model: string; messages: Array<{ role: string; content: unknown }> }, signal: AbortSignal | undefined): Promise<Response> {
    const user = body.messages.find((m) => m.role === "user")?.content;
    prompts.push(typeof user === "string" ? user : (user as Array<{ text?: string }>).map((p) => p.text ?? "").join(""));
    onRequest.get(body.model)?.();
    let mode = behavior.get(`${via.at(-1)}/${body.model}`) ?? behavior.get(body.model) ?? "ok";
    if (typeof mode === "object" && "gate" in mode) {
      await mode.gate;
      mode = mode.after ?? "ok";
    }
    // `x-should-retry: false` makes the transport surface this daily-quota 429 at once; a bare 429 would be replayed six times over ~15 s inside completeSimple.
    if (mode === "quota") return new Response(JSON.stringify({ error: { message: "You exceeded your current quota. RESOURCE_EXHAUSTED", code: 429 } }), { status: 429, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    if (mode === "verify") return new Response(JSON.stringify({ error: { message: "Your account must be verified (429 retry hint)" } }), { status: 403, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    if (mode === "outage") return new Response(JSON.stringify({ error: { message: "socket failed" } }), { status: 400, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    if (mode === "hang") {
      const aborted = Promise.withResolvers<void>();
      signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      return new Response("", { status: 499 });
    }
    // Tests that hold a real socket against the preflight deadline need the server clock.
    if (typeof mode === "object") await Bun.sleep(mode.delayMs);
    const text = mode === "empty" ? "" : mode === "secret" || mode === "secretCut" ? "key " + ["sk", "a".repeat(30)].join("-") : mode === "clean" ? EMPTY : "1. CSV 조건 확인";
    // "secretCut" ends on the output limit instead of a normal stop: an unusable response that still carries the secret.
    const finish = mode === "secretCut" ? "length" : "stop";
    const base = { id: "fake", object: "chat.completion.chunk", created: 0, model: body.model };
    const chunks = [
      { ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ];
    return new Response(`${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }
  root = mkdtempSync(join(tmpdir(), "argon-preflight-test-"));
  process.env.PI_CODING_AGENT_DIR = root;
  refreshDirsFromEnv();
  registry = new ModelRegistry(await AuthStorage.create(join(root, "agent.db")), join(root, "models.yml"));
  const catalog = (id: string) => ({ id, name: id, reasoning: false, input: ["text"] as ("text" | "image")[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 });
  // Fable 5.2's real ladder starts at medium; the fixture carries it so the request options are exercised end to end.
  const fable = { ...catalog("claude-fable-5-2"), reasoning: true, thinking: { mode: "effort" as const, efforts: ["medium", "high", "xhigh"] as const } };
  const astra = { ...catalog("gpt-6.2-astra"), reasoning: true, compat: { supportsReasoningEffort: true }, thinking: { mode: "effort" as const, efforts: ["low", "medium", "high"] as const } };
  const provider = (name: string, models: Array<string | typeof fable | typeof astra>) => registry.registerProvider(name, {
    baseUrl: `http://127.0.0.1:${server.port}/${name}/v1`, apiKey: "local", api: "openai-completions", models: models.map((m) => typeof m === "string" ? catalog(m) : m) as never,
  });
  provider("anthropic", ["claude-main", "claude-reviewer", fable]);
  provider("openai-codex", ["gpt-main", "gpt-reviewer", astra]);
  provider("fakepre", [fable]);
  provider("openai", [fable]);
  provider("hive", ["deepseek-ai/deepseek-v4.1-flash-1017"]);
});
afterAll(() => {
  server.stop(true);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  refreshDirsFromEnv();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { prompts.length = 0; served.length = 0; via.length = 0; efforts.length = 0; behavior.clear(); onRequest.clear(); });

type Handler = (event: unknown, ctx: unknown) => unknown;

type ToolDef = { execute: (callId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };

/** One Main session on `mainModel` with `restored` user turns already on its saved branch. */
async function mainSession(restored: string[] = [], mainModel = "openai-codex/gpt-main", kind: "main" | "sub" = "main") {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();
  const paths = [fileURLToPath(new URL("../../cuelo-plugins/argon-preflight/index.ts", import.meta.url))];
  const loaded = await loadExtensions(paths, root);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  for (const extension of loaded.extensions) {
    for (const [name, callbacks] of extension.handlers) handlers.set(name, [...(handlers.get(name) ?? []), ...callbacks]);
    // The fixture only calls lab_preflight, whose returned content is text.
    for (const [name, tool] of extension.tools) tools.set(name, tool.definition as unknown as ToolDef);
  }
  // A model id can itself contain a slash (hive/deepseek-ai/deepseek-v4.1-flash-1017), so only the provider is split off.
  const cut = mainModel.indexOf("/");
  const model = registry.find(mainModel.slice(0, cut), mainModel.slice(cut + 1));
  /** Every selector the plugin asked the runtime to resolve, in order. */
  const resolved: string[] = [];
  /** The plugin's panel lines (its own history, newest last). */
  let notes: string[] = [];
  const query = createExtensionModelQuery(registry, findScopedSettings(root), () => model);
  const sessionId = `preflight-fixture-${++fixtureSessionCount}`;
  const ctx = {
    cwd: root, agent: { kind }, isIdle: () => true, ui: { setWidget: (_key: string, lines: string[]) => { notes = lines; } }, model,
    models: { ...query, resolve: (spec: string) => { resolved.push(spec); return query.resolve(spec); } }, modelRegistry: registry,
    sessionManager: { getSessionId: () => sessionId, getBranch: () => restored.map((text) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } })) },
  };
  const fire = async (name: string, event: unknown) => {
    let out: unknown;
    for (const fn of handlers.get(name) ?? []) out = (await fn(event, ctx)) ?? out;
    return out;
  };
  await fire("session_start", {});
  return {
    context: ctx as unknown as ExtensionContext,
    say: async (text: string) => {
      await fire("input", { source: "interactive", text });
      await fire("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
    },
    call: (toolName: string, input: unknown) => fire("tool_call", { toolName, toolCallId: "call-1", input }),
    steer: (text: string) => fire("message_start", { message: { role: "user", content: text } }),
    switchSession: () => fire("session_switch", {}),
    preflight: (params: { plan: string; question?: string }, signal?: AbortSignal) => tools.get("lab_preflight")!.execute("call", params, signal, undefined, ctx),
    resolved, get notes() { return notes; },
  };
}

const FABLE = "anthropic/claude-fable-5-2";
const FABLE_ID = "claude-fable-5-2";
const ASTRA = "openai-codex/gpt-6.2-astra";
const preflightRoles = { preflightOpenAI: ASTRA, preflightAnthropic: FABLE };
const withRoles = <T>(modelRoles: Record<string, string>, fn: () => Promise<T>): Promise<T> =>
  withActiveSettings(Settings.isolated({ modelRoles: { ...preflightRoles, ...modelRoles } }), fn);
const withPreflightRole = <T>(fn: () => Promise<T>): Promise<T> => withRoles({}, fn);
const LATEST = "New requirement: LATEST_CONDITION_EXPORT_ONLY_CSV. Do not produce a PDF.";
/** Hold the selected model's next answers until release; requests already answering are unaffected. */
const gate = (): (() => void) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  behavior.set(FABLE_ID, { gate: promise });
  return () => resolve();
};
/** What a model answers when it finds nothing to change. */
const EMPTY = "빠진 것 없음";
const older = (size: number) => Array.from({ length: 5 }, (_, i) => `OLDER_TURN_${i + 1}: ${"x".repeat(size)}`);
/** The prompt's recent-user section, between its heading and the plan. */
const recentSection = (prompt: string) => prompt.slice(prompt.indexOf("# 사용자의 최근 말\n"), prompt.indexOf("\n\n# 계획"));

test("interpreter tries its configured fallback on a usage limit only", async () => {
  await withRoles({
    interpreter: "openai-codex/gpt-main",
    interpreterFallback: "anthropic/claude-reviewer",
  }, async () => {
    const { context } = await mainSession();
    const signal = new AbortController().signal;
    behavior.set("gpt-main", "quota");
    expect(await translateReply("The value is 10.", context, signal)).toContain("CSV");
    expect(served).toEqual(["gpt-main", "claude-reviewer"]);

    served.length = 0;
    behavior.set("gpt-main", "outage");
    await expect(translateReply("The value is 10.", context, signal)).rejects.toThrow();
    expect(served).toEqual(["gpt-main"]);
  });
});

describe("argon-preflight selects one dedicated slot", () => {
  for (const [main, slot, model] of [
    ["openai-codex/gpt-main", "@preflightAnthropic", FABLE],
    ["anthropic/claude-main", "@preflightOpenAI", ASTRA],
    ["hive/deepseek-ai/deepseek-v4.1-flash-1017", "@preflightAnthropic", FABLE],
    ["fakepre/missing-model", "@preflightAnthropic", FABLE],
  ] as const) {
    test(`${main} uses the explicit ${slot} slot`, async () => {
      await withPreflightRole(async () => {
        const s = await mainSession([], main);
        const id = model.split("/")[1]!;
        expect((await s.preflight({ plan: "Export CSV." })).content[0]!.text).toContain(model);
        expect(served).toEqual([id]);
        expect(s.resolved).toEqual([slot]);
        if (model === FABLE) expect(efforts).toEqual(["medium"]);
      });
    });
  }

  test.each(["", ASTRA])("missing or wrong-family slot (%s) sends nothing", async (preflightAnthropic) => {
    await withRoles({ preflightAnthropic }, async () => {
      const s = await mainSession();
      await expect(s.preflight({ plan: "Export CSV." })).rejects.toThrow("사전 점검 실패");
      expect(served).toEqual([]);
    });
  });

  test("a child cannot call lab_preflight", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main", "sub");
      await expect(s.preflight({ plan: "Export CSV." })).rejects.toThrow("Main");
      expect(served).toEqual([]);
    });
  });
});

describe("argon-preflight recent user turns", () => {
  test("a short history reaches the model whole, oldest first, with nothing marked as left out", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      for (const turn of older(20)) await s.say(turn);
      await s.say(LATEST);
      await s.preflight({ plan: "Export CSV." });
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
      await s.preflight({ plan: "Export CSV." });
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
      await s.preflight({ plan: "Export CSV." });
    });
    expect(prompts).toHaveLength(1);
    expect(recentSection(prompts[0])).toContain(`(6) ${LATEST}`);
  });

  test("the end of a 2,607-character latest request reaches the model whole, with no partial marker", async () => {
    const constraint = "FINAL_CONSTRAINT: do not deploy and do not delete anything.";
    const request = `${"background detail. ".repeat(200).slice(0, 2607 - constraint.length)}${constraint}`;
    expect(request.length).toBe(2607);
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.say(request);
      await s.preflight({ plan: "Export CSV." });
    });
    expect(recentSection(prompts[0])).toContain(constraint);
    expect(prompts[0]).not.toContain("부분 입력");
  });

  test("an oversized latest request keeps its head and its end and the prompt and the opinion say the check is partial", async () => {
    const head = "HEAD_REQUEST: export only CSV.";
    const constraint = "FINAL_CONSTRAINT: do not deploy and do not delete anything.";
    const request = `${head} ${"middle filler. ".repeat(800)}${constraint}`;
    let text = "";
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.say(request);
      text = (await s.preflight({ plan: "Write the CSV export." })).content.map((part) => part.text).join("");
    });
    expect(prompts).toHaveLength(1);
    const section = recentSection(prompts[0]);
    expect(section).toContain(head);
    expect(section).toContain(constraint);
    expect(section).toMatch(/…\(\d+자 생략\)…/);
    expect(prompts[0]).toContain("부분 입력");
    expect(text).toContain("부분 점검");
  });

  test("a secret that clipping would cut away from its header still stops the request before the provider", async () => {
    // Assembled at runtime so the public mirror's .publicdeny key pattern never matches this fixture.
    const keyLabel = ["PRIVATE", "KEY"].join(" ");
    const request = `${"x".repeat(3000)}\n-----BEGIN ${keyLabel}-----\n${"A".repeat(5000)}\n-----END ${keyLabel}-----\nclosing note`;
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.say(request);
      await expect(s.preflight({ plan: "Write the CSV export." })).rejects.toThrow("비밀값");
    });
    expect(prompts).toHaveLength(0);
  });

  test("an earlier turn clipped by a few characters still marks the check partial", async () => {
    let text = "";
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.say("x".repeat(2009));
      await s.say("next");
      text = (await s.preflight({ plan: "Write the CSV export." })).content.map((part) => part.text).join("");
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("부분 입력");
    expect(text).toContain("부분 점검");
  });
});


/** Wait until the local transport has received the in-flight request. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}


const alternate = `fakepre/${FABLE_ID}`;
const withRoutes = <T>(fn: () => Promise<T>) => withActiveSettings(Settings.isolated({
  modelRoles: preflightRoles,
  retry: { fallbackChains: { [FABLE]: ["openai-codex/gpt-reviewer", alternate, `openai/${FABLE_ID}`] } },
}), fn);

describe("same-model routes and request boundaries", () => {
  test("a provider limit retries the same model on the configured alternate route", async () => {
    behavior.set(FABLE, "quota");
    await withRoutes(async () => {
      const s = await mainSession();
      const { content } = await s.preflight({ plan: "Export CSV." });
      expect(content[0]!.text).toContain(alternate);
      expect(content[0]!.text).toContain("같은 모델의 다른 경로");
      expect(s.resolved).toEqual(["@preflightAnthropic", alternate]);
    });
    expect(via).toEqual(["anthropic", "fakepre"]);
    expect(served).toEqual([FABLE_ID, FABLE_ID]);
  });

  test.each(["outage", "verify", "empty", "secret", "secretCut"] as const)("%s fails without another route", async (mode) => {
    behavior.set(FABLE, mode);
    await withRoutes(async () => {
      const s = await mainSession();
      await expect(s.preflight({ plan: "Export CSV." })).rejects.toThrow(mode.startsWith("secret") ? "비밀값" : mode === "verify" ? "Your account must be verified" : "사전 점검 실패");
      expect(s.resolved).toEqual(["@preflightAnthropic"]);
    });
    expect(via[0]).toBe("anthropic");
    expect(via.every((provider) => provider === "anthropic")).toBe(true);
  });

  test.each(["secret", "verify", "outage"] as const)("a non-limit alternate failure (%s) prevents further requests", async (mode) => {
    behavior.set(FABLE, "quota");
    behavior.set(alternate, mode);
    await withRoutes(async () => {
      const s = await mainSession();
      await expect(s.preflight({ plan: "Export CSV." })).rejects.toThrow("사전 점검 실패");
    });
    expect(via).toEqual(["anthropic", "fakepre"]);
  });

  test("another usage limit permits the next exact route for the same model", async () => {
    behavior.set(FABLE, "quota");
    behavior.set(alternate, "quota");
    await withRoutes(async () => {
      const s = await mainSession();
      const { content } = await s.preflight({ plan: "Export CSV." });
      expect(content[0]!.text).toContain(`openai/${FABLE_ID}`);
    });
    expect(via).toEqual(["anthropic", "fakepre", "openai"]);
  });

  test.each(["cancel", "stale", "deadline"] as const)("%s prevents a retry after the primary limit", async (stop) => {
    const realNow = Date.now;
    let skew = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    const cancel = new AbortController();
    try {
      await withRoutes(async () => {
        const s = await mainSession();
        behavior.set(FABLE, "quota");
        onRequest.set(FABLE_ID, () => {
          if (stop === "cancel") cancel.abort();
          if (stop === "stale") void s.say("Stop the old plan.");
          if (stop === "deadline") skew += 121_000;
        });
        await expect(s.preflight({ plan: "Export CSV." }, cancel.signal)).rejects.toThrow("사전 점검 실패");
      });
      expect(via).toEqual(["anthropic"]);
    } finally { clock.mockRestore(); }
  });

  test("an alternate receives only the unused portion of the first deadline", async () => {
    const realNow = Date.now;
    let skew = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + skew);
    try {
      await withRoutes(async () => {
        const { context } = await mainSession();
        behavior.set(FABLE, "quota");
        behavior.set(alternate, { delayMs: 2_000 });
        onRequest.set(FABLE_ID, () => { if (via.length === 1) skew = 1_200; });
        const check = createPreflightCheck({ on: () => {} } as unknown as ExtensionAPI);
        expect(await check.ask(context, "Export CSV.", "", 2_000)).toMatchObject({ ok: false, why: expect.stringContaining(alternate) });
      });
      expect(via).toEqual(["anthropic", "fakepre"]);
    } finally { clock.mockRestore(); }
  });

  test("an already cancelled call sends no request", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      await expect(s.preflight({ plan: "Export CSV." }, AbortSignal.abort())).rejects.toThrow("취소");
      expect(served).toEqual([]);
    });
  });

  test.each(["steering", "session switch"] as const)("%s never returns the stale explicit opinion", async (event) => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const release = gate();
      const pending = s.preflight({ plan: "Export CSV." }).then(() => "answered", (error: Error) => error.message);
      try {
        await until(() => served.length === 1);
        if (event === "session switch") {
          await s.switchSession();
          // Cancellation settles the tool without waiting for the provider to answer.
          const tick = Promise.withResolvers<"still waiting">();
          setImmediate(() => tick.resolve("still waiting"));
          expect(await Promise.race([pending, tick.promise])).toContain("세션이 바뀌어 이전 답을 버렸다");
        } else {
          await s.steer("Use Excel, not CSV.");
          release();
          expect(await pending).toContain("사용자 지시나 세션이 바뀌어 이전 답을 버렸다");
        }
        expect(s.notes.some((note) => note.includes("CSV 조건 확인"))).toBe(false);
      } finally {
        release();
      }
    });
  });

  test("a secret straddling the plan clip boundary never reaches the reviewer", async () => {
    // The token starts inside the budget and continues past it: clipping alone would leave a visible prefix.
    const plan = `${"x".repeat(23_985)}sk-${"A".repeat(40)}`;
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await expect(s.preflight({ plan })).rejects.toThrow("비밀값");
    });
    expect(served).toEqual([]);
  });

});

test("dispatch and goal frames do not trigger a plan check; lab_preflight remains explicit", async () => {
  await withPreflightRole(async () => {
    const s = await mainSession();
    expect(await s.call("task", { tasks: [{ name: "Export", task: "Write CSV" }] })).toBeUndefined();
    expect(await s.call("lab_goal", { op: "frame", goal: "Export" })).toBeUndefined();
    expect(served).toEqual([]);
    const result = await s.preflight({ plan: "Export CSV only." });
    expect(s.resolved).toEqual(["@preflightAnthropic"]);
    expect(result.content[0]!.text).toContain(FABLE);
    expect(served).toEqual([FABLE_ID]);
  });
});


