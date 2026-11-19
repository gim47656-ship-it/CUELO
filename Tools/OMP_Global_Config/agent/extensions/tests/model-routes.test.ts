import { expect, spyOn, test } from "bun:test";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { FIXED_FALLBACK_MODEL, GEMINI, HelperCallError, withFallback } from "../skim";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { directFallbackModel, operationalFailure, sameModelRoutes } from "../lib/model-routes";

const primary = "aistudio/gemini-4-argon";
const vertex = "google-vertex/gemini-4-argon";
const other = "other/gemini-4-argon";
const ctx = { cwd: "/tmp/model-routes-contract", models: { resolve: () => ({ provider: "aistudio", id: "gemini-4-argon" }) } } as unknown as ExtensionContext;

async function attempted(chains: Record<string, string[]>) {
  const calls: string[] = [];
  await withActiveSettings(Settings.isolated({ retry: { fallbackChains: chains } }), () => withFallback(async (marker) => {
    const name = typeof marker === "object" ? marker.route : marker === GEMINI ? primary : FIXED_FALLBACK_MODEL;
    calls.push(name);
    throw new HelperCallError("429 RESOURCE_EXHAUSTED usage limit", name, { providerFailure: true });
  }, new AbortController().signal, undefined, { ctx, role: "skim" }));
  return calls;
}

test("exact base chain keeps same-id other-provider routes in order and strips effort without duplicates", async () => {
  expect(await attempted({ [primary]: [primary, `${primary}:high`, `${vertex}:auto`, vertex, "aistudio/gemini-3.8-flash", "@draft", "other/*", `${other}:low`] }))
    .toEqual([primary, vertex, other, FIXED_FALLBACK_MODEL]);
});

test("wildcard, role, default and effort-suffixed keys do not grant helper routes", async () => {
  expect(await attempted({ "aistudio/*": [vertex], skim: [vertex], default: [vertex], [`${primary}:auto`]: [vertex] }))
    .toEqual([primary, FIXED_FALLBACK_MODEL]);
});

test("an exact empty or different-model chain leaves the legacy fallback order alone", async () => {
  for (const chain of [[], ["aistudio/gemini-3.8-flash"]]) {
    expect(await attempted({ [primary]: chain })).toEqual([primary, FIXED_FALLBACK_MODEL]);
  }
});

test("R1-ANT-1 route settings failure cannot suppress the existing helper fallback", async () => {
  const getter = spyOn(cfgRetryFallbackChains, "get").mockImplementation(() => { throw new Error("route setting unavailable"); });
  try { expect(await attempted({})).toEqual([primary, FIXED_FALLBACK_MODEL]); }
  finally { getter.mockRestore(); }
});

test("R1-ANT-3 literal colon model tags retain the exact model-key chain", async () => {
  await withActiveSettings(Settings.isolated({ retry: { fallbackChains: {
    "ollama/llama3": ["lmstudio/llama3"],
    "ollama/llama3:8b": ["lmstudio/llama3:8b", "other/llama3:8b:high"],
  } } }), async () => {
    expect(await sameModelRoutes(ctx.cwd, "ollama/llama3:8b")).toEqual(["lmstudio/llama3:8b", "other/llama3:8b"]);
  });
});

test("legacy model aliases cannot replace an exact fallback selector", async () => {
  await withActiveSettings(Settings.isolated({ modelRoles: { preflightGeminiFallback: "openai-codex/gpt-special" } }), async () => {
    expect(await directFallbackModel(ctx, "preflightGeminiFallback")).toBeUndefined();
  });
});

test("missing Vertex ADC, normalized wire failures and a local deadline are operational; challenges are not", async () => {
  expect(await operationalFailure(new Error("Vertex AI requires Application Default Credentials. Set GOOGLE_APPLICATION_CREDENTIALS."))).toBe(true);
  expect(await operationalFailure({ stopReason: "error", errorStatus: 503, errorMessage: "Unavailable" })).toBe(true);
  expect(await operationalFailure(new DOMException("Timed out", "TimeoutError"))).toBe(true);
  expect(await operationalFailure({ stopReason: "error", errorStatus: 429, stopDetails: { type: "content_filter" } })).toBe(false);
  expect(await operationalFailure(new Error("No API key for provider: test (session is restricted to its OAuth account pool)"))).toBe(false);
});
