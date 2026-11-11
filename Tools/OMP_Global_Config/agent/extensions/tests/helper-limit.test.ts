import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as retryUtils from "@oh-my-pi/pi-utils";
import { completeRole, DEEPSEEK, GEMINI, DRAFT_FALLBACK, HelperCallError, skimQuestion, withFallback, type HelperModel } from "../skim";
import { Settings, withActiveSettings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { draftDocument } from "../draft";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const quota = "Google API error (429): RESOURCE_EXHAUSTED You've reached your usage limit retry-after-ms=60000";
const primary = "aistudio/gemini-4-argon";
const target = { marker: DRAFT_FALLBACK, name: "aistudio/gemini-3.8-flash", label: "modelRoles.draftFallback" } as const;
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "helper-limit-"));
  dirs.push(cwd);
  writeFileSync(join(cwd, "input.md"), "Visible fact\n");
  const model = { provider: "aistudio", id: "gemini-4-argon" };
  const registry = {};
  const ctx = { cwd, modelRegistry: registry, sessionManager: { getSessionId: () => "session-a" }, models: { resolve: () => model } } as unknown as ExtensionContext;
  return { ctx, model };
}

test("skim keeps successful fallback and skips an explicitly cooling primary on the next tool call", async () => {
  const { ctx } = fixture();
  const calls: string[] = [];
  const complete = async (_prompt: string, _ctx: ExtensionContext, _signal: AbortSignal, model: HelperModel) => {
    calls.push(model);
    if (model === GEMINI) throw new HelperCallError(quota, primary, { providerFailure: true });
    return { model: DEEPSEEK, text: "Visible fact (input.md:L1)" };
  };
  const input = { paths: ["input.md"], question: "What is the fact?" };
  const first = await skimQuestion(input, ctx, new AbortController().signal, complete);
  const second = await skimQuestion(input, ctx, new AbortController().signal, complete);
  expect(first.isError).toBe(false);
  expect(first.text).toContain(quota);
  expect(second.isError).toBe(false);
  expect(second.text).toContain(`model: ${DEEPSEEK}`);
  expect(second.text).toContain("Visible fact (input.md:L1)");
  expect(second.text).not.toContain("RESOURCE_EXHAUSTED");
  expect(calls).toEqual([GEMINI, DEEPSEEK, DEEPSEEK]);
});

test("configured fallback stays exact, expiry restores primary, and unknown delays do not suppress calls", async () => {
  const { ctx } = fixture();
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const calls: string[] = [];
  let message = quota;
  const attempt = async (requested: HelperModel) => {
    calls.push(requested);
    if (requested === GEMINI) throw new HelperCallError(message, primary, { providerFailure: true });
    return { model: target.name, value: "document" };
  };
  const run = () => withFallback(attempt, new AbortController().signal, target, { ctx, role: "draft" });
  try {
    expect(await run()).toMatchObject({ status: "done", model: target.name, value: "document" });
    expect(await run()).toMatchObject({ status: "done", model: target.name });
    expect(calls).toEqual([GEMINI, DRAFT_FALLBACK, DRAFT_FALLBACK]);
    calls.length = 0;
    now += 60_001;
    message = "429 RESOURCE_EXHAUSTED usage limit";
    await run(); await run();
    expect(calls).toEqual([GEMINI, DRAFT_FALLBACK, GEMINI, DRAFT_FALLBACK]);
  } finally { clock.mockRestore(); }
});

test("cooldown does not leak across registry, session, cwd, or a changed primary model", async () => {
  const { ctx, model } = fixture();
  const calls: string[] = [];
  const attempt = async (requested: HelperModel) => {
    calls.push(requested);
    if (requested === GEMINI) throw new HelperCallError(quota, `${model.provider}/${model.id}`, { providerFailure: true });
    return { model: target.name, value: "document" };
  };
  const run = (scope: ExtensionContext) => withFallback(attempt, new AbortController().signal, target, { ctx: scope, role: "draft" });
  await run(ctx); calls.length = 0;
  await run({ ...ctx, modelRegistry: {} } as ExtensionContext);
  await run({ ...ctx, sessionManager: { getSessionId: () => "session-b" } } as unknown as ExtensionContext);
  await run({ ...ctx, cwd: `${ctx.cwd}/other` });
  model.id = "different-model";
  await run(ctx);
  expect(calls).toEqual([GEMINI, DRAFT_FALLBACK, GEMINI, DRAFT_FALLBACK, GEMINI, DRAFT_FALLBACK, GEMINI, DRAFT_FALLBACK]);
});

test("cancel never invokes fallback or records a cooldown; a failed fallback stays failed", async () => {
  const { ctx } = fixture();
  const controller = new AbortController();
  const calls: string[] = [];
  const cancelled = await withFallback(async (requested) => {
    calls.push(requested); controller.abort(); throw new HelperCallError(quota, primary, { providerFailure: true });
  }, controller.signal, target, { ctx, role: "draft" });
  expect(cancelled.status).toBe("cancelled");
  expect(calls).toEqual([GEMINI]);
  calls.length = 0;
  const fail = async (requested: HelperModel) => {
    calls.push(requested);
    throw new HelperCallError(requested === GEMINI ? quota : "fallback unavailable", requested === GEMINI ? primary : target.name, { providerFailure: true });
  };
  expect((await withFallback(fail, new AbortController().signal, target, { ctx, role: "draft" })).status).toBe("failed");
  expect(calls).toEqual([GEMINI, DRAFT_FALLBACK]);
  calls.length = 0;
  expect((await withFallback(fail, controller.signal, target, { ctx, role: "draft" })).status).toBe("cancelled");
  expect(calls).toEqual([]);
  expect((await withFallback(fail, new AbortController().signal, target, { ctx, role: "draft" })).status).toBe("failed");
  expect(calls).toEqual([DRAFT_FALLBACK]);
  calls.length = 0;
  const same = { ...target, name: primary };
  expect((await withFallback(fail, new AbortController().signal, same, { ctx, role: "draft" })).status).toBe("failed");
  expect(calls).toEqual([]);
});

test("many concurrent sessions do not evict another session's unexpired cooldown", async () => {
  const { ctx } = fixture();
  const calls: string[] = [];
  const attempt = async (requested: HelperModel) => {
    calls.push(requested);
    if (requested === GEMINI) throw new HelperCallError(quota, primary, { providerFailure: true });
    return { model: target.name, value: "document" };
  };
  const sessions = Array.from({ length: 33 }, (_, i) => ({
    ...ctx, sessionManager: { getSessionId: () => `session-${i}` },
  } as unknown as ExtensionContext));
  for (const session of sessions) await withFallback(attempt, new AbortController().signal, target, { ctx: session, role: "draft" });
  calls.length = 0;
  await withFallback(attempt, new AbortController().signal, target, { ctx: sessions[0]!, role: "draft" });
  expect(calls).toEqual([DRAFT_FALLBACK]);
});

test("local format errors that quote quota text do not suppress the primary", async () => {
  const { ctx } = fixture();
  const calls: string[] = [];
  const attempt = async (requested: HelperModel) => {
    calls.push(requested);
    if (requested === GEMINI) throw new HelperCallError(`CSV bad cell: ${quota}`, primary);
    return { model: target.name, value: "document" };
  };
  await withFallback(attempt, new AbortController().signal, target, { ctx, role: "draft" });
  await withFallback(attempt, new AbortController().signal, target, { ctx, role: "draft" });
  expect(calls).toEqual([GEMINI, DRAFT_FALLBACK, GEMINI, DRAFT_FALLBACK]);
});

test("retry hint parser failure does not prevent the authorized fallback", async () => {
  const { ctx } = fixture();
  const parser = spyOn(retryUtils, "extractRetryHint").mockImplementation(() => { throw new Error("parser unavailable"); });
  const calls: string[] = [];
  try {
    const out = await withFallback(async (requested) => {
      calls.push(requested);
      if (requested === GEMINI) throw new HelperCallError(quota, primary, { providerFailure: true });
      return { model: target.name, value: "document" };
    }, new AbortController().signal, target, { ctx, role: "draft" });
    expect(out).toMatchObject({ status: "done", model: target.name, value: "document" });
    expect(calls).toEqual([GEMINI, DRAFT_FALLBACK]);
    expect(parser).toHaveBeenCalledTimes(1);
  } finally { parser.mockRestore(); }
});

const vertex = "google-vertex/gemini-4-argon";
const routeSettings = () => Settings.isolated({
  modelRoles: { draft: primary, draftFallback: target.name },
  retry: { fallbackChains: { [primary]: [vertex, target.name] } },
});

test("draft tries the same model route after a raw provider limit, then its exact configured fallback", async () => {
  for (const routeFails of [false, true]) {
    const { ctx } = fixture();
    ctx.models.resolve = ((selector: string) => selector === "@draftFallback"
      ? { provider: "aistudio", id: "gemini-3.8-flash" }
      : { provider: "aistudio", id: "gemini-4-argon" }) as never;
    const calls: string[] = [];
    const out = await withActiveSettings(routeSettings(), () => draftDocument(
      { instruction: "Write the fact.", output: "result.md" }, ctx, new AbortController().signal,
      async (_prompt, _ctx, _signal, marker) => {
        const model = typeof marker === "object" ? marker.route : marker === GEMINI ? primary : target.name;
        calls.push(model);
        if (model === primary || (routeFails && model === vertex)) throw new HelperCallError(quota, model, { providerFailure: true });
        return { model, text: "# Fact\n\nVisible fact." };
      },
    ));
    expect(calls).toEqual(routeFails ? [primary, vertex, target.name] : [primary, vertex]);
    expect(out.isError).toBe(false);
    expect(out.text).toStartWith(`model: ${routeFails ? target.name : vertex}`);
    expect(out.text).toContain(`${primary} 실패: ${quota}`);
    if (routeFails) expect(out.text).toContain(`${vertex} 실패: ${quota}`);
  }
});

test("a cooling primary retries the route each call without recording a route cooldown", async () => {
  const { ctx } = fixture();
  const calls: string[] = [];
  await withActiveSettings(routeSettings(), async () => {
    const run = () => withFallback(async (marker) => {
      const model = typeof marker === "object" ? marker.route : marker === GEMINI ? primary : target.name;
      calls.push(model);
      if (model !== target.name) throw new HelperCallError(quota, model, { providerFailure: true });
      return { model, value: "fact" };
    }, new AbortController().signal, target, { ctx, role: "draft" });
    await run(); await run();
  });
  expect(calls).toEqual([primary, vertex, target.name, vertex, target.name]);
});

test("a non-limit provider error records no cooldown and never tries the configured route", async () => {
  const { ctx } = fixture();
  const calls: string[] = [];
  await withActiveSettings(routeSettings(), async () => {
    const run = () => withFallback(async (marker) => {
      const model = typeof marker === "object" ? marker.route : marker === GEMINI ? primary : target.name;
      calls.push(model);
      if (model === primary) throw new HelperCallError("500 socket closed retry-after-ms=60000", model, { providerFailure: true });
      return { model, value: "fact" };
    }, new AbortController().signal, target, { ctx, role: "draft" });
    await run(); await run();
  });
  expect(calls).toEqual([primary, target.name, primary, target.name]);
});

test("a route equal to the configured fallback is called only in its existing fallback position", async () => {
  const { ctx } = fixture();
  const calls: unknown[] = [];
  const fallback = { ...target, name: vertex };
  await withActiveSettings(routeSettings(), () => withFallback(async (marker) => {
    calls.push(marker);
    if (marker === GEMINI) throw new HelperCallError(quota, primary, { providerFailure: true });
    throw new HelperCallError("route down", vertex, { providerFailure: true });
  }, new AbortController().signal, fallback, { ctx, role: "draft" }));
  expect(calls).toEqual([GEMINI, DRAFT_FALLBACK]);
});

test("R1-ANT-4 an unnamed no-chain failure keeps the original failure label and fallback", async () => {
  const { ctx } = fixture();
  const out = await withFallback(async (marker) => {
    if (marker === GEMINI) throw new Error("boom");
    return { model: target.name, value: "document" };
  }, new AbortController().signal, target, { ctx, role: "draft" });
  expect(out).toMatchObject({ status: "done", failures: ["Gemini 실패: boom"] });
});

test("R1-ADV-1 a rejected route resolution does not mark the uncalled fallback as tried", async () => {
  const { ctx } = fixture();
  ctx.models.resolve = ((selector: string) => selector === "@draft"
    ? { provider: "aistudio", id: "gemini-4-argon" }
    : { provider: "aistudio", id: "gemini-3.8-flash" }) as never;
  let fallbackCalls = 0;
  const out = await withActiveSettings(routeSettings(), () => withFallback(async (marker) => {
    if (marker === GEMINI) throw new HelperCallError(quota, primary, { providerFailure: true });
    if (typeof marker === "object") {
      const answer = await completeRole("fact", ctx, new AbortController().signal, marker, { role: "draft" });
      return { model: answer.model, value: answer.text };
    }
    fallbackCalls++;
    return { model: target.name, value: "document" };
  }, new AbortController().signal, target, { ctx, role: "draft" }));
  expect(out).toMatchObject({ status: "done", model: target.name });
  expect(out.failures[1]).toStartWith(`${vertex} 실패:`);
  expect(fallbackCalls).toBe(1);
});
