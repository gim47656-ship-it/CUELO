import { describe, expect, test } from "bun:test";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import characterVoice, { CHARACTER_TARGETS } from "../Tools/OMP_Global_Config/agent/extensions/character-voice";
import { anthropicOverDaySlot, readSidecarQuota, type QuotaSnapshot, type QuotaAccount } from "../Tools/OMP_Global_Config/agent/extensions/lib/anthropic-quota";
import { selectNewSessionModel, DAY_SLOT_START_NOTICE } from "./new-session-model";
import type { ModelScopeResult } from "./model-scope";

function account(id: number, used: number | null = 15): QuotaAccount {
  return { credentialId: id, disabled: false, autoBlockedUntilMs: null, limitReached: false, fetchedAt: 1,
    limits: [{ id: "anthropic:7d", usedFraction: 0.2, resetsAt: 100, windowId: "7d", shared: true,
      daySlot: { usedPct: used, quotaPct: 14.29, slotsLeft: 7, quality: "exact" } }] };
}
function snapshot(accounts = [account(9), account(11)]): QuotaSnapshot {
  return { state: "observed", observedAt: 1, providers: { anthropic: accounts } };
}
const storage = { credentials: { list: () => [9, 11].map((id) => ({ id, disabledCause: null })) } };
const yuki = CHARACTER_TARGETS["YUKI(유키)"].model;
const separator = yuki.indexOf("/");
const sol = { provider: yuki.slice(0, separator), id: yuki.slice(separator + 1) } as ModelScopeResult["visible"][number];
const opus = { provider: "anthropic", id: "claude-opus-5-5" } as ModelScopeResult["visible"][number];
const scope = { visible: [opus, sol], scopedModels: [], thinkingLevelPins: {}, warnings: [] } as ModelScopeResult;
const fresh = { freshTopLevel: true, sessionFile: "", hasExistingMessages: false,
  defaultModel: { provider: opus.provider, modelId: opus.id } };

describe("Anthropic daily-share policy", () => {
  test("requires complete observed coverage and finite live shared weekly slots", () => {
    expect(anthropicOverDaySlot(snapshot(), [9, 11])).toBe(true);
    expect(anthropicOverDaySlot(snapshot([account(9, 14.29), account(11)]))).toBe(true);
    const cases: QuotaSnapshot[] = [
      snapshot([account(9, 10), account(11)]), snapshot([account(9, null), account(11)]),
      snapshot([account(9)]), snapshot([]), { state: "unavailable", observedAt: 1, reason: "offline" },
    ];
    for (const quota of cases) expect(anthropicOverDaySlot(quota, [9, 11])).toBe(false);
    expect(anthropicOverDaySlot(snapshot(), [9, 11, 13])).toBe(false);
    expect(anthropicOverDaySlot(snapshot([account(9), account(9)]))).toBe(false);
    for (const mutate of [
      (a: QuotaAccount) => { a.limits[0]!.daySlot!.quotaPct = null; },
      (a: QuotaAccount) => { a.limits[0]!.daySlot!.usedPct = Infinity; },
      (a: QuotaAccount) => { a.limits[0]!.daySlot!.quality = "unknown"; },
      (a: QuotaAccount) => { a.limits[0]!.daySlot = null; },
      (a: QuotaAccount) => { a.limits[0]!.shared = false; },
      (a: QuotaAccount) => { a.limits[0]!.windowId = "5h"; },
      (a: QuotaAccount) => { a.limits[0]!.resetsAt = 1; },
    ]) {
      const a = account(9); mutate(a);
      expect(anthropicOverDaySlot(snapshot([a, account(11)]), [9, 11])).toBe(false);
    }
    const spent = account(9, null); spent.limitReached = true;
    expect(anthropicOverDaySlot(snapshot([spent, account(11)]), [9, 11])).toBe(true);
  });

  test("fresh implicit-model startup selects the canonical YUKI selector and actual YUKI voice", async () => {
    const selected = await selectNewSessionModel(scope, fresh, storage, async () => snapshot());
    expect(selected.initial.model).toBe(sol);
    expect(selected.notice).toBe(DAY_SLOT_START_NOTICE);
    type StartHandler = (event: { prompt: string; systemPrompt: string[] }, ctx: unknown) => Promise<{ systemPrompt: string[] }>;
    const handlers = new Map<string, StartHandler>();
    characterVoice({ on: (name: string, fn: StartHandler) => handlers.set(name, fn) } as never);
    const ctx = { model: selected.initial.model, sessionManager: { getSessionId: () => "new-yuki" } };
    const started = await handlers.get("before_agent_start")!({ prompt: "hello", systemPrompt: ["base"] }, ctx);
    expect(started.systemPrompt.join("\n")).toContain('alias="YUKI(유키)"');
    expect(started.systemPrompt.join("\n")).not.toContain('alias="RIN(린)"');
  });

  test("YUKI does not inherit another default role's thinking pin but honors an explicit level", async () => {
    const xhigh = parseConfiguredThinkingLevel("xhigh")!;
    const high = parseConfiguredThinkingLevel("high")!;
    const options = { ...fresh, defaultThinkingLevel: xhigh };
    const under = await selectNewSessionModel(scope, options, storage, async () => snapshot([account(9, 1), account(11)]));
    expect(under.initial.thinkingLevel).toBe(xhigh);
    const over = await selectNewSessionModel(scope, options, storage, async () => snapshot());
    expect(over.initial.thinkingLevel).toBeUndefined();
    const explicit = await selectNewSessionModel(scope, { ...options, thinkingLevel: high }, storage, async () => snapshot());
    expect(explicit.initial.thinkingLevel).toBe(high);
  });

  test("under share or unavailable quota starts normally; explicit/resume/fork/child paths do not read quota", async () => {
    for (const quota of [snapshot([account(9, 1), account(11)]), snapshot([account(9)]),
      { state: "unavailable", observedAt: 1, reason: "offline" } as QuotaSnapshot]) {
      const result = await selectNewSessionModel(scope, fresh, storage, async () => quota);
      expect(result.initial.model).toBe(opus); expect(result.notice).toBeNull();
    }
    for (const options of [
      { ...fresh, requestedModel: { provider: opus.provider, modelId: opus.id } },
      { ...fresh, freshTopLevel: false, sessionFile: "resume.jsonl", hasExistingMessages: true },
      { ...fresh, freshTopLevel: false, sessionFile: "fork.jsonl", hasExistingMessages: true },
      { ...fresh, freshTopLevel: false }, // child creation never opts in
    ]) {
      let called = false;
      const result = await selectNewSessionModel(scope, options, storage, async () => { called = true; return snapshot(); });
      expect(called).toBe(false); expect(result.notice).toBeNull();
      expect(result.initial.model).toBe(options.hasExistingMessages ? undefined : opus);
    }
  });

  test("slow quota fails open within the startup budget", async () => {
    const { promise } = Promise.withResolvers<QuotaSnapshot>();
    const result = await selectNewSessionModel(scope, fresh, storage, async () => promise);
    expect(result.initial.model).toBe(opus); expect(result.notice).toBeNull();
  });

  test("sidecar adapter feeds the same predicate", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ reports: [9, 11].map((credentialId) => ({
      provider: "anthropic", credentialId, limits: [{ id: "anthropic:7d", scope: { windowId: "7d", shared: true },
        daySlot: { usedPct: 15, quotaPct: 14.29, quality: "exact" } }],
    })) }) });
    const previous = process.env.OMP_USAGE_PORT;
    process.env.OMP_USAGE_PORT = String(server.port);
    try { expect(anthropicOverDaySlot(await readSidecarQuota(["anthropic"]), [9, 11])).toBe(true); }
    finally { if (previous === undefined) delete process.env.OMP_USAGE_PORT; else process.env.OMP_USAGE_PORT = previous; server.stop(true); }
  });
});
