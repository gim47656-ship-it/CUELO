import { expect, spyOn, test } from "bun:test";
import { loadReading } from "./ShowCard";
import { findTranslatorLanguage } from "@/lib/translator-languages";

test("readings serialize model requests and reuse pending and completed results", async () => {
  const originalFetch = globalThis.fetch;
  const releases: (() => void)[] = [];
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let calls = 0, active = 0, maximum = 0;
  globalThis.fetch = Object.assign(async () => {
    calls++; active++; maximum = Math.max(maximum, active);
    const gate = Promise.withResolvers<void>();
    releases.push(gate.resolve);
    started[calls - 1].resolve();
    await gate.promise;
    active--;
    return Response.json({ reading: "씬 짜오" });
  }, { preconnect: originalFetch.preconnect });
  try {
    const vi = findTranslatorLanguage("vi")!;
    const first = loadReading("test-bounded-a", "Xin chào", vi);
    const duplicate = loadReading("test-bounded-a", "Xin chào", vi);
    const second = loadReading("test-bounded-b", "Cảm ơn", vi);
    expect(duplicate).toBe(first);
    await started[0].promise;
    expect(calls).toBe(1);
    releases.shift()!();
    expect(await first).toBe("씬 짜오");
    await started[1].promise;
    expect(calls).toBe(2);
    releases.shift()!();
    expect(await second).toBe("씬 짜오");
    expect(await loadReading("test-bounded-a", "Xin chào", vi)).toBe("씬 짜오");
    expect(calls).toBe(2);
    expect(maximum).toBe(1);
  } finally {
    for (const release of releases) release();
    globalThis.fetch = originalFetch;
  }
});

test("a stalled reading times out and an opened card moves ahead of queued history", async () => {
  const originalFetch = globalThis.fetch;
  const controllers: AbortController[] = [];
  const order: string[] = [];
  const timeout = spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    expect(milliseconds).toBe(30_000);
    const controller = new AbortController();
    controllers.push(controller);
    return controller.signal;
  });
  globalThis.fetch = Object.assign(async (_input: string | URL | Request, init?: RequestInit) => {
    const text = JSON.parse(init!.body as string).text as string;
    order.push(text);
    if (text === "stalled") {
      const gate = Promise.withResolvers<Response>();
      init!.signal!.addEventListener("abort", () => gate.reject(init!.signal!.reason), { once: true });
      return gate.promise;
    }
    return Response.json({ reading: text });
  }, { preconnect: originalFetch.preconnect });
  try {
    const vi = findTranslatorLanguage("vi")!;
    const stalled = loadReading("priority-a", "stalled", vi, "background");
    const history = loadReading("priority-b", "history", vi, "background");
    const queuedCard = loadReading("priority-c", "card", vi, "background");
    expect(loadReading("priority-c", "card", vi)).toBe(queuedCard);
    expect(order).toEqual(["stalled"]);
    controllers[0].abort(new DOMException("Timed out", "TimeoutError"));
    expect(await stalled).toBeNull();
    expect(await queuedCard).toBe("card");
    expect(await history).toBe("history");
    expect(order).toEqual(["stalled", "card", "history"]);
  } finally {
    controllers[0]?.abort();
    globalThis.fetch = originalFetch;
    timeout.mockRestore();
  }
});
