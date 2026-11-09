import { expect, test } from "bun:test";
import { readInterpreterTextEvents } from "./read-text-stream";

const frame = (event: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);

test("translation characters arrive before the complete result, across split UTF-8 and SSE frames", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const events = readInterpreterTextEvents(body);
  const first = events.next();
  for (const byte of frame({ type: "delta", text: "땅콩은\n넣지 마세요. 🥜" })) controller.enqueue(Uint8Array.of(byte));
  expect(await first).toEqual({ done: false, value: { type: "delta", text: "땅콩은\n넣지 마세요. 🥜" } });
  controller.enqueue(frame({ type: "done", text: "땅콩은\n넣지 마세요. 🥜", source: "vi", target: "ko" }));
  controller.close();
  expect((await events.next()).value).toEqual({ type: "done", text: "땅콩은\n넣지 마세요. 🥜", source: "vi", target: "ko" });
  expect((await events.next()).done).toBe(true);
});

test("a truncated translation never masquerades as complete", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame({ type: "delta", text: "Do not add" })); controller.close(); } });
  const events = readInterpreterTextEvents(body);
  expect((await events.next()).value).toEqual({ type: "delta", text: "Do not add" });
  await expect(events.next()).rejects.toThrow("ended before completion");
});

test("an explicit provider error is distinct from complete translation", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame({ type: "error", error: "live-upstream" })); controller.close(); } });
  const values = [];
  for await (const event of readInterpreterTextEvents(body)) values.push(event);
  expect(values).toEqual([{ type: "error", error: "live-upstream" }]);
});

test("leaving a stream after partial output cancels its pending body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(frame({ type: "delta", text: "No peanuts" })); }, cancel() { cancelled = true; } });
  for await (const event of readInterpreterTextEvents(body)) { expect(event.type).toBe("delta"); break; }
  expect(cancelled).toBe(true);
});
