import { expect, spyOn, test } from "bun:test";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DEEPSEEK, GEMINI, HelperCallError, withFallback } from "../skim";
import { cfgRetryFallbackChains } from "@oh-my-pi/pi-coding-agent/session/settings";
import { sameModelRoutes } from "../lib/model-routes";

const primary = "aistudio/gemini-4-argon";
const vertex = "google-vertex/gemini-4-argon";
const other = "other/gemini-4-argon";
const ctx = { cwd: "/tmp/model-routes-contract", models: { resolve: () => ({ provider: "aistudio", id: "gemini-4-argon" }) } } as unknown as ExtensionContext;

async function attempted(chains: Record<string, string[]>) {
  const calls: string[] = [];
  await withActiveSettings(Settings.isolated({ retry: { fallbackChains: chains } }), () => withFallback(async (marker) => {
    const name = typeof marker === "object" ? marker.route : marker === GEMINI ? primary : DEEPSEEK;
    calls.push(name);
    throw new HelperCallError("429 RESOURCE_EXHAUSTED usage limit", name, { providerFailure: true });
  }, new AbortController().signal, undefined, { ctx, role: "skim" }));
  return calls;
}

test("exact base chain keeps same-id other-provider routes in order and strips effort without duplicates", async () => {
  expect(await attempted({ [primary]: [primary, `${primary}:high`, `${vertex}:auto`, vertex, "aistudio/gemini-3.8-flash", "@draft", "other/*", `${other}:low`] }))
    .toEqual([primary, vertex, other, DEEPSEEK]);
});

test("wildcard, role, default and effort-suffixed keys do not grant helper routes", async () => {
  expect(await attempted({ "aistudio/*": [vertex], skim: [vertex], default: [vertex], [`${primary}:auto`]: [vertex] }))
    .toEqual([primary, DEEPSEEK]);
});

test("an exact empty or different-model chain leaves the legacy fallback order alone", async () => {
  for (const chain of [[], ["aistudio/gemini-3.8-flash"]]) {
    expect(await attempted({ [primary]: chain })).toEqual([primary, DEEPSEEK]);
  }
});

test("R1-ANT-1 route settings failure cannot suppress the existing helper fallback", async () => {
  const getter = spyOn(cfgRetryFallbackChains, "get").mockImplementation(() => { throw new Error("route setting unavailable"); });
  try { expect(await attempted({})).toEqual([primary, DEEPSEEK]); }
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
