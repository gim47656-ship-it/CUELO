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
import { clearPreparedTaskSession, storePreparedTaskBatch } from "../lib/prepared-task";
import { bindTaskGuardSession, createTaskGuardState, reserveTaskCall, unbindTaskGuardSession } from "../command-guard/task-guard";
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
const fixtureSessions: string[] = [];

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
  for (const id of fixtureSessions) clearPreparedTaskSession(id);
  server.stop(true);
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  refreshDirsFromEnv();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => { prompts.length = 0; served.length = 0; via.length = 0; efforts.length = 0; behavior.clear(); onRequest.clear(); });

type Handler = (event: unknown, ctx: unknown) => unknown;

type ToolDef = { execute: (callId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: Array<{ text: string }> }> };
type Dispatched = { block?: boolean; reason?: string } | undefined;
type Returned = { content?: Array<{ type: string; text: string }> } | undefined;

/** One Main session on `mainModel` with `restored` user turns already on its saved branch. */
async function mainSession(restored: string[] = [], mainModel = "openai-codex/gpt-main", kind: "main" | "sub" = "main", routing = true) {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDef>();
  /** Asides the plugin sent (mid-work direction checks). */
  const messages: string[] = [];
  const paths = [fileURLToPath(new URL("../../cuelo-plugins/argon-preflight/index.ts", import.meta.url))];
  if (routing) paths.push(fileURLToPath(new URL("../../cuelo-plugins/preflight-routing/index.ts", import.meta.url)));
  const loaded = await loadExtensions(paths, root);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  let deliveryError: Error | undefined;
  loaded.runtime.sendMessage = (message) => {
    if (deliveryError) throw deliveryError;
    messages.push(String(message.content));
  };
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
  const sessionId = `preflight-fixture-${fixtureSessions.length + 1}`;
  fixtureSessions.push(sessionId);
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
    sessionId,
    say: async (text: string) => {
      await fire("input", { source: "interactive", text });
      await fire("message_start", { message: { role: "user", content: [{ type: "text", text }] } });
    },
    dispatch: (brief = "Generate the requested export.") => fire("tool_call", { toolName: "task", input: { tasks: [{ name: "Export", task: brief }] } }) as Promise<Dispatched>,
    call: (toolName: string, input: unknown, toolCallId = "call-1") => fire("tool_call", { toolName, toolCallId, input }) as Promise<Dispatched>,
    /** The host's tool_result event for a maker_route call that ran; returns what the plugin replaced its content with. */
    routed: (toolCallId: string) => fire("tool_result", { toolName: "maker_route", toolCallId, input: {}, content: [{ type: "text", text: "routes" }], isError: false }) as Promise<Returned>,
    dispatched: (toolCallId: string) => fire("tool_result", { toolName: "task", toolCallId, content: [{ type: "text", text: "spawned" }] }) as Promise<Returned>,
    steer: (text: string) => fire("message_start", { message: { role: "user", content: text } }),
    switchSession: () => fire("session_switch", {}),
    endTurn: () => fire("agent_end", {}),
    preflight: (params: { plan: string; question?: string }, signal?: AbortSignal) => tools.get("lab_preflight")!.execute("call", params, signal, undefined, ctx),
    /** Makes every later aside delivery throw, as a broken host channel would. */
    failDelivery: (error: Error) => { deliveryError = error; },
    messages, resolved, get notes() { return notes; },
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
/** A dispatch whose TASK_GUARD names one work identity; `extra` changes only the brief body. */
const guarded = (extra = "") => ({ tasks: [{ name: "Export", task: `TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: Export\nOWNED_PATHS: src/export.ts\n# Change\nWrite CSV.${extra}` }] });
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
const recentSection = (prompt: string) => prompt.slice(prompt.indexOf("# 사용자의 최근 말\n"), prompt.indexOf("\n\n# 발주"));

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
    test(`${main} uses ${slot} in both entrypoints`, async () => {
      await withPreflightRole(async () => {
        const s = await mainSession([], main);
        const id = model.split("/")[1]!;
        expect((await s.preflight({ plan: "Export CSV." })).content[0]!.text).toContain(model);
        expect(served).toEqual([id]);
        expect(s.resolved).toEqual([slot]);
        expect((await s.dispatch())?.reason).toContain(model);
        expect(served).toEqual([id, id]);
        expect(s.resolved).toEqual([slot, slot]);
        if (model === FABLE) expect(efforts).toEqual(["medium", "medium"]);
      });
    });
  }

  test.each(["", ASTRA])("missing or wrong-family slot (%s) sends nothing", async (preflightAnthropic) => {
    await withRoles({ preflightAnthropic }, async () => {
      const s = await mainSession();
      expect(await s.dispatch()).toBeUndefined();
      await expect(s.preflight({ plan: "Export CSV." })).rejects.toThrow("사전 점검 실패");
      expect(served).toEqual([]);
    });
  });

  test("a child cannot call either preflight entrypoint", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main", "sub");
      expect(await s.dispatch()).toBeUndefined();
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

  test("the end of a 2,607-character latest request reaches the model whole, with no partial marker", async () => {
    const constraint = "FINAL_CONSTRAINT: do not deploy and do not delete anything.";
    const request = `${"background detail. ".repeat(200).slice(0, 2607 - constraint.length)}${constraint}`;
    expect(request.length).toBe(2607);
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.say(request);
      expect((await s.dispatch())?.block).toBe(true);
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


/**
 * The background direction check exposes no promise, so tests poll the aside or panel note it ends with: a real
 * in-flight request is awaited, not a guessed delay.
 */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await Bun.sleep(5);
  expect(done()).toBe(true);
}

describe("automatic preflight routing", () => {
  test("new user input waits for the current plan instead of checking the previous one", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      expect((await s.call("task", guarded()))?.block).toBe(true);
      await s.call("task", guarded());
      await s.say("Change the export to Excel only.");
      expect((await s.call("task", guarded("\nExport Excel only")))?.block).toBe(true);
      expect(served).toEqual([FABLE_ID, FABLE_ID]);
      expect(s.messages).toEqual([]);
      expect(prompts[1]).toContain("Export Excel only");
      await s.steer("Only include the active worksheet.");
      expect((await s.call("task", guarded()))?.block).toBe(true);
      expect(served).toHaveLength(3);
    });
  });

  test("one correction survives elapsed time, is remembered, then a changed plan is checked", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      expect((await s.call("task", guarded()))?.block).toBe(true);
      const clock = spyOn(Date, "now").mockReturnValue(Date.now() + 21 * 60_000);
      try {
        const corrected = guarded("\nCSV with header");
        expect((await s.call("task", corrected))?.block).toBeUndefined();
        expect((await s.call("task", corrected))?.block).toBeUndefined();
        expect(served).toHaveLength(1);
        expect((await s.call("task", guarded("\nCSV without header")))?.block).toBe(true);
        expect(served).toHaveLength(2);
      } finally { clock.mockRestore(); }
    });
  });

  test("solo work starts no preflight; a later risky frame still gets background advice", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.say("Fix the CSV header in this repository and run the tests.");
      await s.call("bash", { command: "bun test" });
      await s.call("lab_goal", { op: "frame", size: "small", goal: "Fix CSV header" });
      expect(s.resolved).toEqual([]);
      expect(served).toEqual([]);
      expect(s.messages).toEqual([]);

      await s.say("Deploy the new exporter and delete the old bucket.");
      expect(await s.call("lab_goal", {
        op: "frame", size: "normal", goal: "Deploy the new exporter and delete the old bucket",
        deliverables: [{ id: "rollout", what: "Replacement exporter live", check: "Verify new exporter before deleting the approved bucket" }],
      })).toBeUndefined();
      await until(() => s.messages.length === 1);
      expect(served).toEqual([FABLE_ID]);
      expect(prompts[0]).toContain("Deploy the new exporter and delete the old bucket");
      expect(s.messages[0]).toContain("[사전 점검]");
    });
  });

  test("a goal frame is never held: its advice arrives as an aside and a goal-sentence rewrite passes once", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export", path: "out.csv" }] };
      expect(await s.call("lab_goal", frame)).toBeUndefined();
      await until(() => s.messages.length === 1);
      expect(s.messages[0]).toContain("작업 목표는 이미 등록됐고 도구는 막지 않았다");
      expect(s.messages[0]).toContain(FABLE);
      expect(await s.call("lab_goal", { ...frame, goal: "Export the active sheet as CSV" })).toBeUndefined();
      expect(served).toHaveLength(1);
      expect(s.messages).toHaveLength(1);
    });
  });

  test("unrelated goals and tools cannot spend another plan's correction", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      expect(await s.call("lab_goal", frame)).toBeUndefined();
      await until(() => s.messages.length === 1);
      expect((await s.dispatch())?.block).toBe(true);
      expect(await s.call("lab_goal", { ...frame, goal: "Delete export", deliverables: [{ id: "delete" }] })).toBeUndefined();
      await until(() => s.messages.length === 2);
      expect(served).toHaveLength(3);
    });
  });

  test("an unchanged goal retry consumes the correction and a path change is checked", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export", path: "out.csv" }] };
      await s.call("lab_goal", frame);
      await until(() => s.messages.length === 1);
      await s.call("lab_goal", frame);
      expect(await s.call("lab_goal", { ...frame, deliverables: [{ id: "export", path: "other.csv" }] })).toBeUndefined();
      await until(() => s.messages.length === 2);
      expect(served).toHaveLength(2);
      await s.call("lab_goal", { ...frame, size: "small" });
      expect(await s.call("lab_goal", { ...frame, assumptions: ["Changed after small task"] })).toBeUndefined();
      await until(() => s.messages.length === 3);
      expect(served).toHaveLength(3);
    });
  });

  test("a newer plan wins over a delayed earlier check", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const release = gate();
      const first = s.call("task", guarded("\nOld"));
      await until(() => served.length === 1);
      behavior.delete(FABLE_ID);
      const current = guarded("\nCurrent");
      expect((await s.call("task", current))?.block).toBe(true);
      release();
      expect((await first)?.block).toBe(true);
      expect((await s.call("task", current))?.block).toBeUndefined();
      expect(served).toHaveLength(2);
    });
  });

  test("maker_route runs unheld with the advice on its own result; one corrected dispatch passes and a new contract is checked", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const body = "TASK_GUARD:\nWORK_CLASS: maintenance\nPRIMARY_DELIVERABLE: CSV export\nOWNED_PATHS: src/export.ts\n# Change\nWrite CSV.";
      const input = { context: "Export only", tasks: [{ name: "Export", task: body }] };
      const [preparedId] = storePreparedTaskBatch(input.context, input.tasks, s.sessionId);
      expect(await s.call("maker_route", input, "route-1")).toBeUndefined();
      const advice = (await s.routed("route-1"))?.content ?? [];
      expect(advice[0]?.text).toBe("routes");
      expect(advice.at(-1)?.text).toContain("maker_route는 막지 않았다");
      expect(advice.at(-1)?.text).toContain(FABLE);
      // The advice is attached once: a later result for the same id is left alone.
      expect(await s.routed("route-1")).toBeUndefined();
      const corrected = { ...input, tasks: [{ name: "Export", task: `${body}\nKeep headers.` }] };
      expect((await s.call("task", corrected))?.block).toBeUndefined();
      expect((await s.call("task", { context: "PREPARED_CONTEXT", tasks: [{ task: `PREPARED_TASK: ${preparedId}\nKeep headers.` }] }))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
      expect((await s.call("task", { ...input, tasks: [{ name: "Export", task: `${body}\nDrop headers.` }] }))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
      const changed = { ...input, tasks: [{ name: "Export", task: body.replace("src/export.ts", "src/other.ts") }] };
      expect(await s.call("maker_route", changed, "route-2")).toBeUndefined();
      expect(served).toHaveLength(2);
      expect((await s.routed("route-2"))?.content?.at(-1)?.text).toContain("[사전 점검]");
    });
  });

  test("a completed maker_route check whose result was never delivered cannot license a task", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const input = guarded();
      const [id] = storePreparedTaskBatch("", input.tasks, s.sessionId);
      expect(await s.call("maker_route", input, "undelivered")).toBeUndefined();
      expect((await s.call("task", input))?.block).toBe(true);
      expect((await s.call("task", { context: "PREPARED_CONTEXT", tasks: [{ task: `PREPARED_TASK: ${id}` }] }))?.block).toBe(true);
      expect(served).toHaveLength(1);
      expect((await s.routed("undelivered"))?.content?.at(-1)?.text).toContain("사전 점검");
      expect((await s.call("task", input))?.block).toBeUndefined();
      expect(s.notes.join("\n")).toContain("이미 전달한");
      expect((await s.dispatched("call-1"))?.content?.at(-1)?.text).toContain("이미 전달해");
    });
  });

  test("R1-ANT-1 R1-ANT-2: a retried maker_route redelivers pending advice before identical or revised dispatch", async () => {
    await withPreflightRole(async () => {
      for (const extra of ["", "\nRevised prose"]) {
        const s = await mainSession();
        const original = guarded();
        const revised = guarded(extra);
        await s.call("maker_route", original, "lost");
        await s.call("maker_route", revised, "retry");
        expect((await s.call("task", revised))?.block).toBe(true);
        expect((await s.routed("retry"))?.content?.at(-1)?.text).toContain("사전 점검");
        expect((await s.call("task", revised))?.block).toBeUndefined();
      }
      expect(served).toHaveLength(2);
    });
  });

  test("R1-ANT-4: a delivered clean result licenses a changed-prose batch subset without rechecking", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      behavior.set(FABLE_ID, "clean");
      const first = guarded().tasks[0]!;
      const second = { ...first, name: "Other", task: first.task.replace("src/export.ts", "src/other.ts") };
      await s.call("maker_route", { tasks: [first, second] }, "clean");
      await s.routed("clean");
      behavior.delete(FABLE_ID);
      expect((await s.call("task", { tasks: [{ ...second, task: `${second.task}\nKeep header` }] }))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
    });
  });

  test("R1-ANT-3: phone-operator remains exempt while ordinary flat maker dispatch needs advice", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      expect(await s.call("task", { agent: "phone-operator", task: "계산기에서 1+2를 눌러 결과를 알려 줘." })).toBeUndefined();
      expect(served).toHaveLength(0);
      expect((await s.call("task", guarded().tasks[0]!))?.block).toBe(true);
      expect(served).toHaveLength(1);
    });
  });

  test("R2-ANT-1: steering drops an undelivered check and maker_route asks again before redelivery", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      await s.call("maker_route", guarded(), "old");
      await s.steer("New requirement before the result arrived");
      await s.call("maker_route", guarded("\nRevised"), "new");
      expect(served).toHaveLength(2);
      expect(await s.routed("old")).toBeUndefined();
      expect((await s.routed("new"))?.content?.at(-1)?.text).toContain("사전 점검");
      expect((await s.call("task", guarded("\nRevised")))?.block).toBeUndefined();
    });
  });

  test("R2-ANT-2: an undelivered clean result refuses task with a maker_route recovery instruction", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      behavior.set(FABLE_ID, "clean");
      await s.call("maker_route", guarded(), "clean-lost");
      const held = await s.call("task", guarded());
      expect(held?.block).toBe(true);
      expect(held?.reason).toContain("maker_route를 다시 호출");
    });
  });

  test("delivered advice follows individual prepared contracts, not batch shape or prose, and expires on steering", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const first = guarded().tasks[0]!;
      const second = { name: "Other", task: first.task.replace("src/export.ts", "src/other.ts") };
      const batch = { context: "Preparation prose", tasks: [first, second] };
      await s.call("maker_route", batch, "batch");
      await s.routed("batch");
      expect((await s.call("task", { context: "Dispatch prose", tasks: [second] }))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
      for (const replacement of [
        { ...first, name: "Renamed" },
        { ...first, task: first.task.replace("src/export.ts", "src/new.ts") },
        { ...first, task: first.task.replace("OWNED_PATHS:", "FINDING_ID: finding-new\nOWNED_PATHS:") },
        { ...first, task: first.task.replace("PRIMARY_DELIVERABLE: Export", "PRIMARY_DELIVERABLE: New deliverable") },
      ]) {
        expect((await s.call("task", { tasks: [replacement] }))?.block).toBe(true);
      }
      await s.steer("New requirement");
      expect((await s.call("task", { tasks: [first] }))?.block).toBe(true);
    });
  });

  test("canonical enum prefixes, path sets and inherited batch contracts reuse delivered advice after guard normalization", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const state = createTaskGuardState();
      bindTaskGuardSession(s.sessionId, state);
      try {
        const first = guarded().tasks[0]!;
        const second = { name: "Other", task: "TASK_GUARD:\nOWNED_PATHS: ./src/b.ts, src/a.ts, src/b.ts\nBody" };
        await s.call("maker_route", { tasks: [first, second] }, "inherited");
        await s.routed("inherited");
        const normalized = reserveTaskCall(state, "normalize", { tasks: [first, second] });
        expect(normalized.ok).toBe(true);
        if (!normalized.ok) throw new Error(normalized.reason);
        const canonical = normalized.input as { tasks: Array<{ name: string; task: string }> };
        const item = canonical.tasks[1]!;
        expect((await s.call("task", { ...item, task: item.task.replace("WORK_CLASS: maintenance", "WORK_CLASS: maint").replace("./src/b.ts, src/a.ts, src/b.ts", "src/a.ts, src/b.ts") }))?.block).toBeUndefined();
        expect(served).toHaveLength(1);
        await s.switchSession();
        expect((await s.call("task", { tasks: [first] }))?.block).toBe(true);
      } finally {
        unbindTaskGuardSession(s.sessionId, state);
      }
    });
  });

  test("interleaved goals and dispatches each retain one correction", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      expect(await s.call("lab_goal", frame)).toBeUndefined();
      await until(() => s.messages.length === 1);
      expect((await s.call("task", guarded()))?.block).toBe(true);
      const corrected = { ...frame, assumptions: ["Keep headers"] };
      expect(await s.call("lab_goal", corrected)).toBeUndefined();
      expect((await s.call("task", guarded()))?.block).toBeUndefined();
      expect(await s.call("lab_goal", corrected)).toBeUndefined();
      expect(served).toHaveLength(2);
      expect(s.messages).toHaveLength(1);
    });
  });

  test("new user steering still refuses an in-flight successful maker_route check without granting a retry", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const release = gate();
      const pending = s.call("maker_route", guarded());
      await until(() => served.length === 1);
      await s.steer("Only export Excel, not CSV.");
      release();
      expect((await pending)?.block).toBe(true);
      behavior.delete(FABLE_ID);
      expect((await s.call("task", guarded()))?.block).toBe(true);
      expect(served).toHaveLength(2);
      expect(s.messages).toEqual([]);
    });
  });

  test("one frame resent right after steering gets a fresh check, and the superseded advice is dropped", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const release = gate();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      expect(await s.call("lab_goal", frame)).toBeUndefined();
      await until(() => served.length === 1);
      await s.steer("Only export Excel, not CSV.");
      behavior.delete(FABLE_ID);
      // A single resend while the old check is still held: no retry loop is needed for current advice.
      expect(await s.call("lab_goal", frame)).toBeUndefined();
      await until(() => s.messages.length === 1);
      expect(served).toHaveLength(2);
      release();
      await until(() => s.notes.join("\n").includes("조언 버림"));
      expect(s.messages).toHaveLength(1);
    });
  });

  test("a newer goal with another deliverable path retires the earlier goal's late advice", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const releaseA = gate();
      expect(await s.call("lab_goal", { op: "frame", goal: "Export", deliverables: [{ id: "export", path: "out.csv" }] })).toBeUndefined();
      await until(() => served.length === 1);
      const releaseB = gate();
      expect(await s.call("lab_goal", { op: "frame", goal: "Export", deliverables: [{ id: "export", path: "other.csv" }] })).toBeUndefined();
      await until(() => served.length === 2);
      releaseB();
      await until(() => s.messages.length === 1);
      releaseA();
      await until(() => s.notes.join("\n").includes("조언 버림"));
      expect(s.messages).toHaveLength(1);
    });
  });

  test("a failed advice delivery is noted in the panel and never escapes as an unhandled rejection", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      s.failDelivery(new Error("delivery failed"));
      try {
        expect(await s.call("lab_goal", { op: "frame", goal: "Export", deliverables: [{ id: "export" }] })).toBeUndefined();
        await until(() => s.notes.join("\n").includes("조언 전달 실패: delivery failed"));
        // Give the host's unhandled-rejection tracking one macrotask to report anything that escaped.
        const tick = Promise.withResolvers<void>();
        setImmediate(tick.resolve);
        await tick.promise;
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });

  test("simultaneous identical checks share one provider request", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const release = gate();
      const both = Promise.all([s.call("task", guarded()), s.call("task", guarded())]);
      await until(() => served.length === 1);
      release();
      expect((await both).map((result) => result?.block)).toEqual([true, true]);
      expect(served).toHaveLength(1);
      expect((await s.call("task", guarded()))?.block).toBeUndefined();
      const frame = { op: "frame", goal: "Export", deliverables: [{ id: "export" }] };
      const releaseGoal = gate();
      expect(await Promise.all([s.call("lab_goal", frame), s.call("lab_goal", frame)])).toEqual([undefined, undefined]);
      await until(() => served.length === 2);
      releaseGoal();
      await until(() => s.messages.length === 1);
      expect(served).toHaveLength(2);
    });
  });

  test("identical concurrent maker_route calls share one check and both results carry its advice", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const release = gate();
      const both = Promise.all([s.call("maker_route", guarded(), "route-a"), s.call("maker_route", guarded(), "route-b")]);
      await until(() => served.length === 1);
      release();
      expect(await both).toEqual([undefined, undefined]);
      expect(served).toHaveLength(1);
      for (const id of ["route-a", "route-b"]) expect((await s.routed(id))?.content?.at(-1)?.text).toContain("maker_route는 막지 않았다");
    });
  });

  test("exact unkeyed dispatch content is reused across preparation and dispatch", async () => {
    await withPreflightRole(async () => {
      const s = await mainSession();
      const input = { context: "Export", tasks: [{ name: "Export", task: "Write CSV." }] };
      expect(await s.call("maker_route", input, "route-1")).toBeUndefined();
      expect((await s.routed("route-1"))?.content?.at(-1)?.text).toContain("작업 식별 정보가 부족해 수정 발주 허용을 묶을 수 없다");
      expect((await s.call("task", input))?.block).toBeUndefined();
      expect(served).toHaveLength(1);
      expect((await s.call("task", { ...input, context: "Write Excel instead" }))?.block).toBe(true);
      expect(served).toHaveLength(2);
    });
  });
});

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
      // The automatic path is the one the finding named; it must stay fail-open and silent as well.
      const out = await s.dispatch(plan);
      expect(out?.block).toBeUndefined();
    });
    expect(served).toEqual([]);
  });

  test("ending the automatic check's turn aborts the reviewer", async () => {
    behavior.set(FABLE_ID, "hang");
    let out!: Dispatched;
    let elapsed = 0;
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      const pending = s.dispatch();
      await until(() => served.length === 1);
      const t0 = Date.now();
      // The core publishes no handler signal, so the cancelled turn reaches the plugin as this settle.
      await s.endTurn();
      out = await pending;
      elapsed = Date.now() - t0;
    });
    expect(served).toEqual([FABLE_ID]);
    expect(elapsed).toBeLessThan(5_000);
    expect(out?.block).toBeUndefined();
  });

  test("changing sessions aborts the in-flight reviewer", async () => {
    behavior.set(FABLE_ID, "hang");
    let out!: Dispatched;
    let elapsed = 0;
    await withPreflightRole(async () => {
      const s = await mainSession([], "openai-codex/gpt-main");
      await s.say(LATEST);
      const pending = s.dispatch();
      await until(() => served.length === 1);
      const t0 = Date.now();
      await s.switchSession();
      out = await pending;
      elapsed = Date.now() - t0;
    });
    expect(served).toEqual([FABLE_ID]);
    expect(elapsed).toBeLessThan(5_000);
    expect(out?.block).toBeUndefined();
  });
});

test("a route-setting error leaves automatic dispatch fail-open", async () => {
  behavior.set(FABLE, "quota");
  const getter = spyOn(cfgRetryFallbackChains, "get").mockImplementation(() => { throw new Error("route setting unavailable"); });
  try {
    await withRoutes(async () => {
      const s = await mainSession();
      expect(await s.dispatch()).toBeUndefined();
      expect(s.notes.join("\n")).toContain("점검 건너뜀");
    });
    expect(via).toEqual(["anthropic"]);
  } finally { getter.mockRestore(); }
});

test("routing disabled leaves lab_preflight usable without automatic holds", async () => {
  await withPreflightRole(async () => {
    const s = await mainSession([], "openai-codex/gpt-main", "main", false);
    expect(await s.dispatch()).toBeUndefined();
    expect(await s.call("maker_route", { tasks: [{ name: "Export", task: "Write CSV" }] })).toBeUndefined();
    expect(await s.call("lab_goal", { op: "frame", goal: "Export" })).toBeUndefined();
    expect(served).toEqual([]);
    const result = await s.preflight({ plan: "Export CSV only." });
    expect(s.resolved).toEqual(["@preflightAnthropic"]);
    expect(result.content[0]!.text).toContain(FABLE);
    expect(served).toEqual([FABLE_ID]);
  });
});

test("manual and automatic checks retain their combined panel history", async () => {
  await withPreflightRole(async () => {
    const s = await mainSession();
    await s.preflight({ plan: "Export CSV only." });
    await s.dispatch();
    expect(s.notes.join("\n")).toContain("직접 점검");
    expect(s.notes.join("\n")).toContain("발주 조언");
    await s.switchSession();
    await s.dispatch();
    expect(s.notes.join("\n")).not.toContain("직접 점검");
  });
});

test("R1-ANT-1 steering immediately after dispatch still holds the superseded plan", async () => {
  await withPreflightRole(async () => {
    const s = await mainSession();
    const pending = s.call("maker_route", guarded());
    await s.steer("Only export Excel, never CSV.");
    expect((await pending)?.block).toBe(true);
  });
});
