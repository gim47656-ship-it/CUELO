import { expect, test } from "bun:test";
import { createAssistantMessageEventStream, registerCustomApi, unregisterCustomApis, type AssistantMessage } from "@oh-my-pi/pi-ai";
import { POST } from "../app/api/live/interpret/text/route";
import { POST as POST_READING } from "../app/api/live/interpret/reading/route";
import { readInterpreterTextEvents } from "../components/translator/read-text-stream";
import { READING_MARKER, cleanReading, createReadingSplitter, splitReading } from "./interpreter-travel";
import type { InterpreterTextEvent } from "./translator-context";

const message = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as AssistantMessage;

/** Runs the typed route against a fake provider that streams `deltas` and then finishes with `reason`. */
async function run(target: string, deltas: string[], reason: "stop" | "length" = "stop", captured?: { prompt?: string; parts?: string[] }): Promise<InterpreterTextEvent[]> {
  const saved = globalThis.__ompRuntimePromise;
  const api = "interpreter-reading-unit";
  registerCustomApi(api, (_model, context) => {
    if (captured) captured.prompt = [context.systemPrompt].flat().join("\n"); if (captured) captured.parts = [context.systemPrompt].flat() as string[];
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      let text = "";
      for (const delta of deltas) {
        text += delta;
        stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message(text) });
      }
      stream.push({ type: "done", reason, message: message(text) } as never);
    });
    return stream;
  }, api);
  globalThis.__ompRuntimePromise = Promise.resolve({ modelRegistry: {
    find: () => ({ api, provider: "openai-codex", id: "gpt-6.1-sol", maxTokens: 8192, contextWindow: 400000, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "unit-test" }),
  } } as never);
  try {
    const response = await POST(new Request("http://127.0.0.1:30141/api/live/interpret/text", {
      method: "POST",
      headers: { host: "127.0.0.1:30141", "content-type": "application/json" },
      body: JSON.stringify({ mine: "ko", theirs: target, source: "ko", text: "화장실이 어디에 있나요?" }),
    }));
    const events: InterpreterTextEvent[] = [];
    for await (const event of readInterpreterTextEvents(response.body!)) events.push(event);
    return events;
  } finally {
    globalThis.__ompRuntimePromise = saved;
    unregisterCustomApis(api);
  }
}

/** Non-repeating Hangul, so the provider layer's loop detector does not stop the fake stream. */
const noise = (length: number) => Array.from({ length }, (_, index) => String.fromCharCode(0xac00 + ((index * 7919) % 11172))).join("");

const visible = (events: InterpreterTextEvent[]) => events.flatMap((event) => (event.type === "delta" ? [event.text] : []));

test("a marker split across deltas never reaches delta text, and the reading lands in done", async () => {
  const events = await run("ja", ["お手洗いは", "どこですか？\n[[HAN", "GUL]]\n오테아라", "이와 도코데스카"]);
  for (const text of visible(events)) {
    expect(text).not.toContain("[");
    expect(text).not.toMatch(/[\uac00-\ud7a3]/u);
  }
  expect(visible(events).join("")).toBe("お手洗いはどこですか？");
  expect(events.at(-1)).toEqual({ type: "done", text: "お手洗いはどこですか？", source: "ko", target: "ja", reading: "오테아라이와 도코데스카" });
});

test("a missing marker keeps today's translation without a reading", async () => {
  const events = await run("vi", ["Cảm ơn"]);
  expect(events.at(-1)).toEqual({ type: "done", text: "Cảm ơn", source: "ko", target: "vi" });
});

test("a reading cut off by the length limit is dropped and the translation still succeeds", async () => {
  const events = await run("th", ["อันนี้ราคาเท่าไหร่", "\n[[HANGUL]]\n안니 라카"], "length");
  expect(visible(events).join("")).toBe("อันนี้ราคาเท่าไหร่");
  expect(events.at(-1)).toEqual({ type: "done", text: "อันนี้ราคาเท่าไหร่", source: "ko", target: "th" });
});

test("a runaway reading in the same delta as the translation keeps the whole translation", async () => {
  const events = await run("ja", ["これは", "例です\n[[HANGUL]]\n" + noise(1300)]);
  expect(visible(events).join("")).toBe("これは例です");
  expect(events.at(-1)).toEqual({ type: "done", text: "これは例です", source: "ko", target: "ja" });
  const lone = await run("ja", ["[[HANGUL]]\n" + noise(1300)]);
  expect(lone.at(-1)).toEqual({ type: "error", error: "live-upstream" });
});

test("length before the marker is still an incomplete translation", async () => {
  const events = await run("th", ["อันนี้ราคา"], "length");
  expect(events.at(-1)).toEqual({ type: "error", error: "live-upstream" });
});

test("non-reading targets keep the old prompt and pass deltas through untouched", async () => {
  const captured: { prompt?: string; parts?: string[] } = {};
  const events = await run("en", ["Where is ", "the restroom?\n"], "stop", captured);
  expect(captured.prompt).not.toContain(READING_MARKER);
  expect(visible(events)).toEqual(["Where is ", "the restroom?\n"]);
  expect(events.at(-1)).toEqual({ type: "done", text: "Where is the restroom?\n", source: "ko", target: "en" });
  const ja: { prompt?: string; parts?: string[] } = {};
  await run("ja", ["はい"], "stop", ja);
  expect(ja.prompt).toContain(READING_MARKER);
  // The translation instructions stay word for word; only the reading instruction is appended.
  expect(ja.parts).toHaveLength((captured.parts?.length ?? 0) + 1);
  expect(ja.parts?.[1]).toBe(captured.parts?.[1]?.replaceAll("English", "Japanese"));
});

test("splitter holds only a possible marker prefix and its leading spaces", () => {
  const splitter = createReadingSplitter();
  expect(splitter.push("Cảm ơn [[")).toBe("Cảm ơn");
  expect(splitter.push("x")).toBe(" [[x");
  expect(splitter.marked).toBe(false);
  expect(splitter.push(" [[HANGUL]] 깜 언")).toBe("");
  expect(splitter.marked).toBe(true);
  expect(splitter.push(" 더")).toBe("");
  expect(splitReading("Cảm ơn\n[[HANGUL]]\n깜 언")).toEqual({ translation: "Cảm ơn", reading: "\n깜 언", marked: true });
});

test("cleanReading keeps one Hangul line and rejects other scripts, empty or oversized text", () => {
  expect(cleanReading("\n 깜  언 \n")).toBe("깜 언");
  expect(cleanReading("Kam on")).toBeUndefined();
  expect(cleanReading("깜 언 (Cảm ơn)")).toBeUndefined();
  expect(cleanReading("오테아라이 お手洗い")).toBeUndefined();
  expect(cleanReading("가".repeat(601))).toBeUndefined();
  expect(cleanReading("   ")).toBeUndefined();
  expect(cleanReading("가 Привет")).toBeUndefined();
  expect(cleanReading("가\uFFFD")).toBeUndefined();
  expect(cleanReading("토이레와 도코니 아리마스카?")).toBe("토이레와 도코니 아리마스카?");
});

test("reading route refuses bad input before any provider call", async () => {
  const call = (body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => POST_READING(new Request("http://127.0.0.1:30141/api/live/interpret/reading", {
    method: "POST",
    headers: { host: "127.0.0.1:30141", ...headers },
    body: JSON.stringify(body),
  }));
  expect((await call({ text: "Hello", language: "en" })).status).toBe(400);
  expect((await call({ text: "", language: "ja" })).status).toBe(400);
  expect((await call({ text: "x".repeat(9000), language: "vi" })).status).toBe(400);
  expect((await call({ language: "th" })).status).toBe(400);
  expect((await call({ text: "はい", language: "ja" }, { "content-type": "text/plain" })).status).toBe(415);
  expect((await call({ text: "はい", language: "ja" }, { "content-type": "application/json", origin: "https://evil.example" })).status).toBe(403);
});
