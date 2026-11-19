// Exercise the patched classifier, ModelControls, and real AgentSession delivery seam.
// OMP_CORE_PATCH_TARGET=<isolated-core> bun run patches/core-auto-effort-routing-test.ts
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settingsLike } from "./core-test-settings";
import { decideAutoEffort, parseAutoEffortConfig, type MakerEffortRange } from "../agent/extensions/lib/auto-effort-policy";

const core = process.env.OMP_CORE_PATCH_TARGET;
assert.ok(core, "an isolated OMP_CORE_PATCH_TARGET is required");
const src = `${resolve(core)}/src`;
const { ModelControls } = await import(`${src}/session/model-controls.ts`);
const { ChainJudge } = await import(`${src}/judgment/index.ts`);
const { createAgentSession } = await import(`${src}/sdk.ts`);
let choice = "xhigh";
let probabilities: Record<string, number> | undefined = { low: 0.06, medium: 0.17, high: 0.38, xhigh: 0.39 };
const requests: Array<{ state: Record<string, unknown>; questions: { level: { instructions: string } } }> = [];
const originalCandidate = ChainJudge.prototype.withCandidate;
ChainJudge.prototype.withCandidate = async function (run: (candidate: unknown, kind: string) => unknown) {
  return run({ judge: async (request: typeof requests[number]) => {
    requests.push(request);
    return { answers: { level: { choice, probabilities } } };
  } }, "native");
};
const policyKey = Symbol.for("cuelo.autoThinkingPolicy");
const originalPolicy = Reflect.get(globalThis, policyKey);
const config = parseAutoEffortConfig('autoEffort:\n  holdMaxChars: 0\n  escalateMainTools: 2\n  escalateMainErrors: 2\n  escalateChildTools: 0\n  escalateChildErrors: 3\n');
Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, config));
const model = (efforts = ["low", "medium", "high", "xhigh", "max"]) => ({
  provider: "fixture", id: "routing", reasoning: true,
  thinking: { mode: "effort", efforts, defaultLevel: "medium" },
});
const fixture = (options: { branch?: unknown[]; ceiling?: string; efforts?: string[]; max?: string; child?: boolean; id?: string; makerEffort?: MakerEffortRange } = {}) => {
  const entries: Array<Record<string, unknown>> = [];
  const settings = settingsLike({ get: (key: string) => key === "providers.autoThinkingMinEffort" ? "low" : key === "providers.autoThinkingMaxEffort" ? options.max : undefined });
  if (options.makerEffort) Reflect.set(settings, Symbol.for("cuelo.makerEffort"), options.makerEffort);
  const control = new ModelControls({
    agent: { setThinkingLevel() {}, setDisableReasoning() {}, metadataForProvider: () => undefined },
    settings,
    modelRegistry: {}, providerSessionState: new Map(),
    sessionManager: { getSessionId: () => "routing", getLeafId: () => null, getBranch: () => options.branch ?? [],
      appendModelUsage() {}, appendThinkingLevelChange() {}, appendCustomEntry: (_: string, data: Record<string, unknown>) => entries.push(data) },
    model: () => ({ ...model(options.efforts), id: options.id ?? "routing" }), sessionId: () => "routing", promptGeneration: () => 1,
    magicKeywordEnabled: () => true, clearInheritedProviderPromptCacheKey() {}, emit() {},
  }, { thinkingLevel: "auto", thinkingLevelCeiling: options.ceiling });
  return { control, entries, turn: (text = "substantive request", extra = {}) => control.applyAutoThinkingLevel(text, 1, undefined, { child: options.child, ...extra }) };
};
const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { const message = `${name}: ${error instanceof Error ? error.message : error}`; failures.push(message); console.error(`RED ${message}`); }
}
const tool = (control: typeof ModelControls.prototype, error = false) => {
  control.recordAutoThinkingToolEvent?.({ type: "tool_execution_start" }, 1);
  control.recordAutoThinkingToolEvent?.({ type: "tool_execution_end", isError: error }, 1);
};
try {
  await check("1 probability upper-tail selection and decision fields", async () => {
    const f = fixture(); await f.turn();
    assert.equal(f.control.thinkingLevel, "high", "upper-tail 0.77 must select high instead of argmax xhigh");
    assert.deepEqual(Object.fromEntries(["probabilities", "argmax", "raiseAt", "chosen", "contextUsed"].map(key => [key, f.entries.at(-1)?.[key]])),
      { probabilities, argmax: "xhigh", raiseAt: 0.5, chosen: "high", contextUsed: false });
    Reflect.set(globalThis, policyKey, () => ({ raiseAt: 0.8 }));
    await f.turn(); assert.equal(f.control.thinkingLevel, "medium", "configured threshold changes the upper-tail boundary");
    probabilities = undefined; await f.turn(); assert.equal(f.control.thinkingLevel, "xhigh", "missing probabilities preserve argmax");
    probabilities = { low: 0.06, medium: 0.17, high: 0.38, xhigh: 0.39 };
  });
  await check("2 load escalates once with Main reset, child lifetime, ceiling and ultrathink guards", async () => {
    Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, config));
    choice = "medium"; probabilities = undefined;
    const f = fixture(); await f.turn();
    tool(f.control); assert.equal(f.control.thinkingLevel, "medium");
    await f.turn("human steering", { raiseOnly: true });
    await f.turn("agent delivery", { agentOrigin: true });
    tool(f.control); assert.equal(f.control.thinkingLevel, "high", "Main reaches two tools across steering and held agent messages");
    assert.equal(f.entries.at(-1)?.path, "escalate");
    assert.deepEqual(f.entries.at(-1)?.counters, { tools: 2, errors: 0 });
    tool(f.control); tool(f.control); assert.equal(f.control.thinkingLevel, "high", "one escalation per human turn");
    await f.turn(); tool(f.control, true); tool(f.control, true); assert.equal(f.control.thinkingLevel, "high", "new human turn resets the latch");
    const capped = fixture({ ceiling: "medium" }); await capped.turn(); tool(capped.control); tool(capped.control);
    assert.equal(capped.control.thinkingLevel, "medium", "session ceiling wins");
    const keyword = fixture(); await keyword.turn("ultrathink"); tool(keyword.control); tool(keyword.control);
    assert.equal(keyword.entries.filter(e => e.path === "escalate").length, 0, "ultrathink never escalates");
    const child = fixture({ child: true }); await child.turn();
    for (let i = 0; i < 5; i++) tool(child.control);
    assert.equal(child.control.thinkingLevel, "medium", "child tools disabled independently");
    tool(child.control, true); await child.turn("parent delivery", { agentOrigin: true }); tool(child.control, true); tool(child.control, true);
    assert.equal(child.control.thinkingLevel, "high", "child errors span parent messages");
    await child.turn(); tool(child.control, true); tool(child.control, true); tool(child.control, true);
    assert.equal(child.entries.filter(e => e.path === "escalate").length, 1, "child first-turn boundary never resets the latch");
    Reflect.set(globalThis, policyKey, () => ({ floor: "high", xhighAsMax: true, escalateTools: 1, escalateErrors: 0 }));
    choice = "high";
    const promoted = fixture({ efforts: ["low", "high", "max"] }); await promoted.turn(); tool(promoted.control);
    assert.equal(promoted.control.thinkingLevel, "max", "promoted high steps directly to max");
    Reflect.set(globalThis, policyKey, () => ({ ceiling: "high", escalateTools: 1 }));
    const cap = fixture(); await cap.turn(); tool(cap.control); assert.equal(cap.control.thinkingLevel, "high", "policy high cap blocks xhigh");
  });
  await check("routed Maker starts at its floor, reaches successive milestones, and stays in range", async () => {
    const mirror = parseAutoEffortConfig(readFileSync(new URL("../agent/config.yml", import.meta.url), "utf8"));
    Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, mirror));
    probabilities = undefined; choice = "xhigh";
    const hard = fixture({ id: "gpt-6.2-sol", makerEffort: { start: "medium", max: "xhigh" } });
    const bounded = fixture({ id: "gpt-6.2-sol", makerEffort: { start: "high", max: "xhigh" } });
    const astra = fixture({ id: "gpt-6.2-astra", makerEffort: { start: "high", max: "xhigh" } });
    const starting = requests.length;
    await Promise.all([hard.turn("initial ultrathink request"), bounded.turn(), astra.turn()]);
    assert.equal(requests.length, starting, "the first routed request starts at the row floor without classification");
    assert.deepEqual([hard.control.thinkingLevel, bounded.control.thinkingLevel, astra.control.thinkingLevel], ["medium", "high", "high"]);
    for (let n = 1; n <= 300; n++) {
      tool(hard.control);
      if (n === 99 || n === 100 || n === 199 || n === 200 || n === 300) {
        assert.equal(hard.control.thinkingLevel, n < 100 ? "medium" : n < 200 ? "high" : "xhigh", `Maker tools=${n}`);
        console.log(`  Sol HARD tools=${n}: ${hard.control.thinkingLevel}`);
      }
      if (n === 100) await hard.turn("parent delivery", { agentOrigin: true });
    }
    assert.equal(bounded.control.thinkingLevel, "high", "another Sol Maker has independent counters and range");
    choice = "low";
    await hard.turn("a substantive new request from the human");
    await bounded.turn("a substantive new request from the human");
    assert.deepEqual([hard.control.thinkingLevel, bounded.control.thinkingLevel], ["medium", "high"]);
    assert.deepEqual(hard.entries.filter(e => e.path === "escalate").map(e => e.counters), [{ tools: 100, errors: 0 }, { tools: 200, errors: 0 }]);
    for (let n = 1; n <= 30; n++) {
      tool(hard.control, true);
      if (n === 14 || n === 15 || n === 29 || n === 30) {
        assert.equal(hard.control.thinkingLevel, n < 15 ? "medium" : n < 30 ? "high" : "xhigh", `Maker errors=${n}`);
      }
    }
    for (let n = 0; n < 100; n++) tool(astra.control);
    assert.equal(astra.control.thinkingLevel, "xhigh", "Astra Maker ignores Main's high cap");
    const main = fixture({ id: "gpt-6.2-astra" });
    choice = "medium"; await main.turn();
    for (let n = 1; n <= 160; n++) {
      tool(main.control);
      if (n === 79 || n === 80 || n === 160) {
        assert.equal(main.control.thinkingLevel, n < 80 ? "medium" : "high", `Main tools=${n}`);
        console.log(`  Astra Main tools=${n}: ${main.control.thinkingLevel}`);
      }
    }
    await main.turn(); for (let n = 0; n < 4; n++) tool(main.control, true);
    assert.equal(main.control.thinkingLevel, "high");
  });
  await check("cold Maker continuation restores effort and tool milestones; new human prompts still classify", async () => {
    const mirror = parseAutoEffortConfig(readFileSync(new URL("../agent/config.yml", import.meta.url), "utf8"));
    Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, mirror));
    const branch = [
      { type: "message", message: { role: "user", content: "original routed task" } },
      { type: "message", message: { role: "assistant", content: "working" } },
      ...Array.from({ length: 199 }, () => ({ type: "custom", customType: "tool_execution_start" })),
      { type: "thinking_level_change", thinkingLevel: "high", configured: "auto" },
    ];
    const makerEffort = { start: "medium", max: "xhigh" } as const;
    const resumed = fixture({ branch, makerEffort });
    const before = requests.length;
    await resumed.turn("parent delivery", { agentOrigin: true });
    assert.equal(resumed.control.thinkingLevel, "high");
    assert.equal(requests.length, before);
    tool(resumed.control);
    assert.equal(resumed.control.thinkingLevel, "xhigh");
    assert.deepEqual(resumed.entries.at(-1)?.counters, { tools: 200, errors: 0 });
    const human = fixture({ branch, makerEffort });
    choice = "low";
    await human.turn("human changed the requirements");
    assert.equal(requests.length, before + 1);
    assert.equal(human.control.thinkingLevel, "medium");
  });
  await check("only configured xhigh-equivalent models with no xhigh may reach max", async () => {
    const mirror = parseAutoEffortConfig(readFileSync(new URL("../agent/config.yml", import.meta.url), "utf8"));
    Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, mirror));
    const makerEffort = { start: "high", max: "xhigh" } as const;
    const efforts = ["low", "high", "max"];
    const deepseek = fixture({ id: "deepseek-ai/deepseek-v4.1-flash-1017", efforts, makerEffort });
    const unlisted = fixture({ id: "unlisted-model", efforts, makerEffort });
    await Promise.all([deepseek.turn(), unlisted.turn()]);
    for (let n = 0; n < 100; n++) { tool(deepseek.control); tool(unlisted.control); }
    assert.equal(deepseek.control.thinkingLevel, "max");
    assert.equal(unlisted.control.thinkingLevel, "high");
    console.log("  Declared sparse ladder after 100 tools: DeepSeek max (xhigh equivalent); unlisted high");
  });
  await check("3 recent visible exchange is bounded and excluded from solutionSpace and steering", async () => {
    Reflect.deleteProperty(globalThis, policyKey); choice = "medium"; probabilities = undefined;
    const branch = [
      { type: "message", message: { role: "user", content: "previous user request " + "a".repeat(600) } },
      { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, { type: "toolCall", name: "read" }, { type: "text", text: "visible answer " + "b".repeat(600) }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "tool-only secret" }] } },
      { type: "message", message: { role: "user", attribution: "agent", content: "peer coordination" } },
    ];
    const f = fixture({ branch }); await f.turn("change that result");
    const context = requests.at(-1)?.state.context as { user?: string; assistant?: string } | undefined;
    assert.ok(context, "previous visible exchange appears in context");
    assert.ok(context.user, "previous human request appears in context");
    assert.ok(context.assistant, "last visible assistant answer appears in context");
    assert.ok(context.user.startsWith("previous user request"));
    assert.ok(context.assistant.startsWith("visible answer"));
    assert.ok(context.user.length <= 400 && context.assistant.length <= 400);
    assert.equal(JSON.stringify(context).includes("hidden"), false); assert.equal(JSON.stringify(context).includes("tool-only"), false);
    assert.equal(f.entries.at(-1)?.contextUsed, true);
    await f.turn("steering message", { raiseOnly: true }); assert.equal(requests.at(-1)?.state.context, undefined);
    await f.control.applyAutoThinkingLevel("task", 1, "open design choices"); assert.equal(requests.at(-1)?.state.context, undefined);
    await fixture().turn(); assert.equal(requests.at(-1)?.state.context, undefined);
  });
  await check("4 real agent deliveries hold while human and routine/session-start prompts are judged", async () => {
    const root = mkdtempSync(join(tmpdir(), "effort-routing-")); const agentDir = join(root, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "config.yml"), "modelRoles:\n  default: fixture/routing\n");
    writeFileSync(join(agentDir, "models.yml"), 'providers:\n  fixture:\n    baseUrl: http://127.0.0.1:9\n    api: openai-completions\n    apiKey: example\n    models:\n      - id: routing\n        reasoning: true\n        thinking:\n          mode: effort\n          efforts: [low, medium, high, xhigh, max]\n          defaultLevel: medium\n');
    Reflect.deleteProperty(globalThis, policyKey);
    const { session } = await createAgentSession({ cwd: root, agentDir, disableExtensionDiscovery: true });
    try {
      session.setThinkingLevel("auto");
      session.agent.addBeforeModelCallHook(() => { throw new Error("stop before provider"); });
      let secondContextUser: string | undefined;
      for (const text of ["human typed substantive task request", "second human typed substantive request", "[CUELO 루틴: test] inspect the ordinary routine", "cloud change report session start request"]) {
        const before = requests.length; try { await session.prompt(text); } catch {}
        assert.equal(requests.length, before + 1, `${text} stays judged`);
        if (text === "second human typed substantive request") {
          const context = requests.at(-1)?.state.context as { user?: string } | undefined;
          secondContextUser = context?.user;
        }
      }
      const before = requests.length;
      try { await session.prompt("agent delivery with ultrathink", { attribution: "agent" }); } catch {}
      assert.equal(requests.length, before, "agent-attributed prompt must not call judge");
      for (const message of [
        { role: "custom", customType: "irc:incoming", attribution: "agent", content: "peer IRC" },
        { role: "custom", customType: "async-result", attribution: "agent", content: "child report" },
        { role: "user", attribution: "agent", content: "queued agent steer", steering: true },
        { role: "developer", attribution: "agent", content: "synthetic follow-up", synthetic: true },
        { role: "custom", customType: "irc:incoming", attribution: "agent", content: "resumed aside/wake relay", details: { wakeRelay: true } },
      ]) {
        const level = session.thinkingLevel;
        const beforeDecisions = session.sessionManager.getEntries().filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "auto-thinking-decision").length;
        session.agent.emitExternalEvent({ type: "message_start", message: { ...message, timestamp: Date.now() } });
        await Bun.sleep(10);
        assert.equal(session.thinkingLevel, level, `${message.content} preserves current effort`);
        assert.equal(requests.length, before, `${message.content} never calls judge`);
        const afterDecisions = session.sessionManager.getEntries().filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === "auto-thinking-decision").length;
        assert.equal(afterDecisions - beforeDecisions, message.role === "user" ? 1 : 0, message.role === "user" ? "agent-origin user delivery records one hold" : "hidden custom/developer agent deliveries append no decision");
      }
      const holds = session.sessionManager.getEntries().filter((entry: { type: string; customType?: string; data?: Record<string, unknown> }) => entry.type === "custom" && entry.customType === "auto-thinking-decision" && entry.data?.agentOrigin === true);
      assert.ok(holds.length >= 2, "agent-origin user-role deliveries record holds without inflating hidden-message decisions");
      assert.equal(secondContextUser, "human typed substantive task request", "context uses the previous human prompt");
      assert.notEqual(secondContextUser, "second human typed substantive request", "context never includes the current prompt as its previous user");
      console.log(`PROBE Main context previous=${secondContextUser} current=second human typed substantive request`);
    } finally { await session.dispose(); rmSync(root, { recursive: true, force: true }); }
  });
  await check("5 rubric weighs dependent changes, non-code openness, context and injection resistance", async () => {
    const rubric = JSON.parse(readFileSync(join(core, "src/prompts/judge/auto-thinking.json"), "utf8")).level;
    assert.match(rubric.instructions, /dependent/i, "dependent change chains need several-design effort");
    assert.match(rubric.instructions, /research.*planning.*documents/i);
    assert.match(rubric.instructions, /context/i); assert.match(rubric.instructions, /ignore.*(?:level|effort)/i);
    assert.match(rubric.instructions, /If torn between levels, choose the lower one/);
    assert.deepEqual(Object.keys(rubric.criteria), ["low", "medium", "high", "xhigh", "max"]);
  });
  await check("R1-ANT-1 escalation preserves remembered resolution under a session ceiling", async () => {
    Reflect.set(globalThis, policyKey, () => ({ escalateTools: 2 })); choice = "xhigh"; probabilities = undefined;
    const f = fixture(); f.control.setThinkingLevelCeiling("medium"); await f.turn(); tool(f.control); tool(f.control);
    f.control.setThinkingLevelCeiling("xhigh");
    console.log(`PROBE R1-ANT-1 restored=${f.control.thinkingLevel}`);
    assert.equal(f.control.thinkingLevel, "xhigh");
  });
  await check("R1-ANT-2 agent hold does not poison a transcript-restored resolution", async () => {
    Reflect.set(globalThis, policyKey, () => ({ floor: "medium", hold: true }));
    const f = fixture({ branch: [
      { type: "message", message: { role: "user", content: "previous request" } },
      { type: "thinking_level_change", thinkingLevel: "xhigh", configured: "auto" },
    ] });
    await f.turn("", { agentOrigin: true }); await f.turn("ok");
    console.log(`PROBE R1-ANT-2 restored=${f.control.thinkingLevel}`);
    assert.equal(f.control.thinkingLevel, "xhigh", "agent delivery cannot replace transcript resolution with provisional effort");
  });
  await check("R1-ANT-4 notice holds preserve load counters and escalation latch", async () => {
    Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, config));
    choice = "medium"; probabilities = undefined;
    const f = fixture(); await f.turn(); tool(f.control); tool(f.control);
    await f.turn("[하네스 통지] update installed, restart pending"); tool(f.control); tool(f.control);
    console.log(`PROBE R1-ANT-4 escalations=${f.entries.filter(e => e.path === "escalate").length} level=${f.control.thinkingLevel}`);
    assert.equal(f.entries.filter(e => e.path === "escalate").length, 1, "notice is not a new human turn");
  });
  await check("R1-ANT-5 local bucket decision logs its actual context use", async () => {
    Reflect.deleteProperty(globalThis, policyKey);
    let seen: Record<string, unknown> | undefined;
    ChainJudge.prototype.withCandidate = async function (run: (candidate: unknown, kind: string) => unknown) {
      return run({ judge: async (request: { state: Record<string, unknown> }) => {
        seen = request.state; return { answers: { bucket: { choice: "moderate" } } };
      } }, "local");
    };
    try {
      const f = fixture({ branch: [{ type: "message", message: { role: "user", content: "previous user exchange" } }] });
      await f.turn("change that result");
      console.log(`PROBE R1-ANT-5 stateContext=${seen?.context !== undefined} logged=${f.entries.at(-1)?.contextUsed}`);
      assert.ok(seen?.context); assert.equal(f.entries.at(-1)?.contextUsed, true);
    } finally {
      ChainJudge.prototype.withCandidate = async function (run: (candidate: unknown, kind: string) => unknown) {
        return run({ judge: async (request: typeof requests[number]) => {
          requests.push(request); return { answers: { level: { choice, probabilities } } };
        } }, "native");
      };
    }
  });
  await check("R1-ADV-1 a ladder declaring xhigh does not promote it to max", async () => {
    Reflect.set(globalThis, policyKey, () => ({ xhighAsMax: true, escalateTools: 1 })); choice = "xhigh";
    const f = fixture(); await f.turn(); tool(f.control);
    console.log(`PROBE R1-ADV-1 declared-xhigh=${f.control.thinkingLevel}`);
    assert.equal(f.control.thinkingLevel, "xhigh");
  });
  await check("R2-ANT-1 a fresh resume notice starts load accounting without a judge call", async () => {
    Reflect.set(globalThis, policyKey, (input: Parameters<typeof decideAutoEffort>[0]) => decideAutoEffort(input, config));
    const f = fixture(); const before = requests.length;
    await f.turn("[자동 재개] continue the interrupted task"); tool(f.control); tool(f.control);
    assert.equal(requests.length, before, "resume notice and escalation do not call the judge");
    assert.equal(f.entries.filter(e => e.path === "escalate").length, 1, "fresh resumed work must still reach the tool threshold");
  });
} finally {
  ChainJudge.prototype.withCandidate = originalCandidate;
  if (originalPolicy === undefined) Reflect.deleteProperty(globalThis, policyKey); else Reflect.set(globalThis, policyKey, originalPolicy);
}
assert.deepEqual(failures, [], "all five routing behaviors must pass");
console.log("5 routing behaviors verified");
process.exit(0);
