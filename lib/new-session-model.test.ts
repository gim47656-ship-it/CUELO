import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import characterVoice from "../Tools/OMP_Global_Config/agent/extensions/character-voice";
import { readSidecarQuota } from "../Tools/OMP_Global_Config/agent/extensions/lib/anthropic-quota";
import { selectNewSessionModel } from "./new-session-model";
import type { ModelScopeResult } from "./model-scope";

const opus = { provider: "anthropic", id: "claude-opus-5-5" } as ModelScopeResult["visible"][number];
const fable = { provider: "anthropic", id: "claude-fable-5-2" } as ModelScopeResult["visible"][number];
const sol = { provider: "openai-codex", id: "gpt-6-astra" } as ModelScopeResult["visible"][number];
const scope = { visible: [opus, fable, sol], scopedModels: [], thinkingLevelPins: {}, warnings: [] } as ModelScopeResult;
const fresh = { hasExistingMessages: false, defaultModel: { provider: opus.provider, modelId: opus.id } };

describe("New session model selection", () => {
  test("a fresh unpinned session starts on the configured default model", () => {
    const selected = selectNewSessionModel(scope, fresh);
    expect(selected.model).toBe(opus);
    expect(selected).not.toHaveProperty("notice");
  });

  test("no quota observation can change the start model", () => {
    // 2026-11-11: the selector no longer reads account usage at all, so nothing a sidecar
    // reports — over-share, exhausted, disabled or unavailable — moves a fresh session.
    const selected = selectNewSessionModel(scope, fresh);
    expect(selected.model).toBe(opus);
    expect(selected.scopedModels).toEqual([]);
  });

  test("the usage sidecar still parses the reference numbers the panel shows", async () => {
    // Quota display and Maker routing keep reading this adapter; only the model-switch rule is gone.
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ reports: [9, 11].map((credentialId) => ({
      provider: "anthropic", credentialId,
      limits: [{ id: "anthropic:7d", scope: { windowId: "7d", shared: true },
        daySlot: { usedPct: 15, quotaPct: 14.29, slotsLeft: 7, quality: "exact", paceOver: true } }],
    })) }) });
    const previous = process.env.OMP_USAGE_PORT;
    process.env.OMP_USAGE_PORT = String(server.port);
    try {
      const quota = await readSidecarQuota(["anthropic"]);
      expect(quota.state).toBe("observed");
      const limits = quota.state === "observed" ? quota.providers.anthropic!.map((account) => account.limits[0]!) : [];
      expect(limits.map((limit) => [limit.windowId, limit.shared, limit.daySlot?.usedPct, limit.daySlot?.quotaPct,
        limit.daySlot?.slotsLeft, limit.daySlot?.quality, limit.daySlot?.paceOver]))
        .toEqual([["7d", true, 15, 14.29, 7, "exact", true], ["7d", true, 15, 14.29, 7, "exact", true]]);
    } finally {
      if (previous === undefined) delete process.env.OMP_USAGE_PORT;
      else process.env.OMP_USAGE_PORT = previous;
      server.stop(true);
    }
  });

  test("an explicit request, a resumed transcript and a child keep their own choice", () => {
    const requested = selectNewSessionModel(scope, {
      ...fresh,
      requestedModel: { provider: fable.provider, modelId: fable.id },
    });
    expect(requested.model).toBe(fable);

    // A conversation that already has messages carries the transcript's model and level.
    const resumed = selectNewSessionModel(scope, { ...fresh, hasExistingMessages: true });
    expect(resumed.model).toBeUndefined();
    expect(resumed.thinkingLevel).toBeUndefined();

    // A child passes its own model the same way an explicit request does.
    const child = selectNewSessionModel(scope, {
      hasExistingMessages: false,
      requestedModel: { provider: sol.provider, modelId: sol.id },
    });
    expect(child.model).toBe(sol);
  });

  test("an unavailable explicit request still fails loudly instead of silently falling back", () => {
    expect(() => selectNewSessionModel(scope, {
      ...fresh,
      requestedModel: { provider: "anthropic", modelId: "claude-nonexistent" },
    })).toThrow("Model is not available in the enabled scope");
  });

  test("the default role's thinking pin applies unless the caller names a level", () => {
    const xhigh = parseConfiguredThinkingLevel("xhigh")!;
    const high = parseConfiguredThinkingLevel("high")!;
    const scoped = (model: ModelScopeResult["visible"][number], level: typeof xhigh) =>
      ({ model, thinkingLevel: level }) as ModelScopeResult["scopedModels"][number];
    const pinned = { ...scope, scopedModels: [scoped(opus, xhigh)] } as ModelScopeResult;
    expect(selectNewSessionModel(pinned, fresh).thinkingLevel).toBe(xhigh);
    expect(selectNewSessionModel(pinned, { ...fresh, defaultThinkingLevel: high }).thinkingLevel).toBe(high);
    expect(selectNewSessionModel(pinned, { ...fresh, thinkingLevel: high }).thinkingLevel).toBe(high);
  });

  test("the selected Opus session still runs as the default-role voice, not YUKI", async () => {
    const selected = selectNewSessionModel(scope, fresh);
    type StartHandler = (event: { prompt: string; systemPrompt: string[] }, ctx: unknown) => Promise<{ systemPrompt: string[] }>;
    const handlers = new Map<string, StartHandler>();
    // The voice extension reads the office character roster from the agent dir. An empty one keeps this
    // check on the default characters on a PC whose real profile has a roster.
    const agentDir = mkdtempSync(join(tmpdir(), "new-session-voice-"));
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      characterVoice({ on: (name: string, fn: StartHandler) => handlers.set(name, fn) } as never);
      const ctx = { model: selected.model, sessionManager: { getSessionId: () => "new-default" } };
      const started = await handlers.get("before_agent_start")!({ prompt: "hello", systemPrompt: ["base"] }, ctx);
      // The day-share override used to hand this session YUKI. Any other alias is fine here:
      // which Anthropic character a seat maps to is profile state, not this selector's decision.
      expect(started.systemPrompt.join("\n")).toContain("<character-voice alias=");
      expect(started.systemPrompt.join("\n")).not.toContain('alias="YUKI(유키)"');
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
