import { describe, expect, test } from "bun:test";
import { Catalog, MessageProcessor } from "@a2ui/web_core";
import {
  buildActionEnvelope,
  extractFencedBlocks,
  formatActionMessage,
  isInlineImageUrl,
  parseA2uiBlock,
  parseActionMessage,
  safeExternalUrl,
} from "./blocks";
import { A2uiSessionStore, type A2uiSendOutcome } from "./session-store";

const CATALOG_ID = "test-catalog";
const create = (id: string, extra: Record<string, unknown> = {}) => ({ version: "1.0", createSurface: { surfaceId: id, catalogId: CATALOG_ID, ...extra } });
const setData = (id: string, path: string, value: unknown) => ({ version: "1.0", updateDataModel: { surfaceId: id, path, value } });
const fence = (lang: string, body: unknown) => `\`\`\`${lang}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;
const assistant = (...texts: string[]) => ({ role: "assistant", content: texts.map((text) => ({ type: "text", text })) });
const user = (text: string) => ({ role: "user", content: text });

function makeStore(sent: string[] = [], outcome: A2uiSendOutcome = "prompt", send?: (text: string) => Promise<A2uiSendOutcome>) {
  const processors: MessageProcessor<never>[] = [];
  let fire: ((action: Parameters<ConstructorParameters<typeof MessageProcessor>[1] & object>[0]) => void) | null = null;
  const store = new A2uiSessionStore((onAction) => {
    fire = onAction;
    const processor = new MessageProcessor<never>([new Catalog(CATALOG_ID, "1.0", [], [])]);
    processors.push(processor);
    return processor;
  }, send ?? (async (text) => {
    sent.push(text);
    return outcome;
  }));
  return { store, processors, click: (surfaceId: string, name = "pick") => fire!({ name, surfaceId, sourceComponentId: "btn", timestamp: "2026-11-24T00:00:00Z", context: { choice: "B" } }) };
}

/** Drains the microtasks a click's send chain queues. */
async function drainMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("extractFencedBlocks", () => {
  test("finds a2ui fences only, in order, with CommonMark closing rules", () => {
    const text = [
      "intro",
      "```a2ui",
      '{"a":1}',
      "```",
      "````json",
      "```a2ui",
      "not a card",
      "````",
      "~~~ a2ui extra",
      "  {\"b\":2}",
      "~~~",
    ].join("\n");
    expect(extractFencedBlocks(text, "a2ui")).toEqual(['{"a":1}', '  {"b":2}']);
  });

  test("an unclosed fence runs to the end so a truncated block still reaches the parser", () => {
    const blocks = extractFencedBlocks('text\n```a2ui\n[{"version":"1.0","createSurface":', "a2ui");
    expect(blocks).toHaveLength(1);
    expect(parseA2uiBlock(blocks[0])).toEqual({ ok: false, reason: "json" });
  });

  test("CRLF line endings close fences like LF does", () => {
    expect(extractFencedBlocks(["```a2ui", "{}", "```", "after", "```a2ui", "[]", "```"].join("\r\n"), "a2ui")).toEqual(["{}", "[]"]);
  });
});

describe("parseA2uiBlock", () => {
  test("accepts a JSON array, a single object, a messages wrapper and JSONL", () => {
    const a = create("s");
    const b = setData("s", "/x", 1);
    for (const body of [JSON.stringify([a, b]), JSON.stringify({ messages: [a, b] }), `${JSON.stringify(a)}\n${JSON.stringify(b)}`]) {
      expect(parseA2uiBlock(body)).toEqual({ ok: true, messages: [a, b] });
    }
    expect(parseA2uiBlock(JSON.stringify(a))).toEqual({ ok: true, messages: [a] });
    expect(parseA2uiBlock("[1,2]")).toEqual({ ok: false, reason: "shape" });
    expect(parseA2uiBlock("  ")).toEqual({ ok: false, reason: "empty" });
  });
});

describe("action messages", () => {
  test("round-trip through the a2ui-action fence with the data model attached", () => {
    const envelope = buildActionEnvelope({ name: "pick", surfaceId: "plan", sourceComponentId: "b1", timestamp: "t", context: { option: "A" } }, { note: "hi" });
    const text = formatActionMessage(envelope);
    expect(text.split("\n")[0]).toBe("카드 동작: pick (plan)");
    const parsed = parseActionMessage(text);
    expect(parsed?.envelope).toEqual(envelope);
    expect(parsed?.envelope.metadata?.a2uiClientDataModel.surfaces.plan).toEqual({ note: "hi" });
  });

  test("a user message with more prose than the action line is not an action message", () => {
    const text = formatActionMessage(buildActionEnvelope({ name: "pick", surfaceId: "p", sourceComponentId: "b", timestamp: "t", context: {} }));
    expect(parseActionMessage(`please also do X\n${text}`)).toBeNull();
    expect(parseActionMessage(fence("a2ui-action", { action: { name: 1 } }))).toBeNull();
    expect(parseActionMessage(`${text}\n\nPlease cancel that choice.`)).toBeNull();
  });
});

describe("URL safety", () => {
  test("only inline images and absolute http(s) links pass", () => {
    expect(isInlineImageUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isInlineImageUrl("https://example.com/a.png")).toBe(false);
    expect(isInlineImageUrl("data:text/html;base64,AAAA")).toBe(false);
    expect(safeExternalUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("/api/files/x")).toBeNull();
  });
});

describe("A2uiSessionStore", () => {
  test("applies blocks in order; later updates change the same surface and report missing ones", () => {
    const { store, processors } = makeStore();
    const first = assistant(fence("a2ui", [create("tasks"), setData("tasks", "/done", 0)]));
    const second = assistant("updated", fence("a2ui", setData("tasks", "/done", 2)), fence("a2ui", setData("ghost", "/x", 1)));
    store.sync([user("q"), first, user("more"), second]);
    const created = store.lookup(first.content[0], 0, JSON.stringify([create("tasks"), setData("tasks", "/done", 0)]));
    expect(created?.surfaces.map((surface) => surface.id)).toEqual(["tasks"]);
    expect(processors[0].getSurface("tasks")?.dataModel.get<number>("/done")).toBe(2);
    expect(store.lookup(second.content[1], 0, JSON.stringify(setData("tasks", "/done", 2)))).toMatchObject({ updated: ["tasks"], missing: [], error: null });
    expect(store.lookup(second.content[2], 0, JSON.stringify(setData("ghost", "/x", 1)))).toMatchObject({ missing: ["ghost"], error: null });
  });

  test("an update that runs before its surface exists is a skip even if the same block creates it later", () => {
    const { store, processors } = makeStore();
    const message = assistant(fence("a2ui", [setData("s", "/x", 1), create("s")]));
    store.sync([message]);
    expect(store.lookup(message.content[0], 0, JSON.stringify([setData("s", "/x", 1), create("s")]))).toMatchObject({ missing: ["s"], updated: [], error: null });
    expect(processors[0].getSurface("s")?.dataModel.get("/x")).toBeUndefined();
  });

  test("new messages apply incrementally and keep the processor; recreated message objects still resolve", () => {
    const { store, processors } = makeStore();
    const card = fence("a2ui", [create("form"), setData("form", "/name", "")]);
    const messages = [user("q"), assistant(card)];
    store.sync(messages);
    const surface = processors[0].getSurface("form")!;
    surface.dataModel.set("/name", "typed by the user");

    store.sync([...messages, user("next"), assistant(fence("a2ui", setData("form", "/count", 3)))]);
    // A reload produces new objects with the same text: still the same processor and surface.
    const reloadedCard = assistant("intro", card);
    store.sync([user("q"), reloadedCard, user("next"), assistant(fence("a2ui", setData("form", "/count", 3)))]);
    expect(processors).toHaveLength(1);
    expect(processors[0].getSurface("form")?.dataModel.get<string>("/name")).toBe("typed by the user");
    // The chat renders answer runs through copies holding a subset of the parts; the part still resolves.
    const runCopy = { ...reloadedCard, content: [reloadedCard.content[1]] };
    const view = store.lookup(runCopy.content[0], 0, card.slice(8, -4));
    expect(view?.surfaces[0]).toBe(surface);
    expect(store.liveSurface(surface)).toBe(true);
  });

  test("changed history rebuilds from the transcript and replays sent action data models", () => {
    const { store, processors } = makeStore();
    const card = assistant(fence("a2ui", create("plan", { sendDataModel: true })));
    const action = formatActionMessage(buildActionEnvelope({ name: "pick", surfaceId: "plan", sourceComponentId: "b", timestamp: "t", context: {} }, { choice: "B" }));
    store.sync([user("q"), card, user(action)]);
    // A branch whose earlier card differs: the block sequence no longer starts with what was applied.
    store.sync([user("edited"), assistant(fence("a2ui", [create("plan", { sendDataModel: true }), setData("plan", "/title", "v2")])), user(action)]);
    expect(processors).toHaveLength(2);
    expect(processors[1].getSurface("plan")?.dataModel.get<string>("/choice")).toBe("B");
  });

  test("a sent action replays again after history shrinks and grows back", () => {
    const sent: string[] = [];
    const { store, processors, click } = makeStore(sent);
    const card = assistant(fence("a2ui", create("form", { sendDataModel: true })));
    store.sync([user("q"), card]);
    processors[0].getSurface("form")!.dataModel.set("/x", "B");
    click("form");
    store.sync([user("q"), card, user(sent[0])]);
    store.sync([user("q"), card]);
    store.sync([user("q"), card, user(sent[0])]);
    expect(processors.at(-1)!.getSurface("form")?.dataModel.get<string>("/x")).toBe("B");
  });

  test("an action quoted inside ordinary prose does not replay into the card", () => {
    const { store, processors } = makeStore();
    const card = assistant(fence("a2ui", create("form", { sendDataModel: true })));
    const action = formatActionMessage(buildActionEnvelope({ name: "pick", surfaceId: "form", sourceComponentId: "b", timestamp: "t", context: {} }, { x: "old" }));
    store.sync([user("q"), card]);
    processors[0].getSurface("form")!.dataModel.set("/x", "new");
    store.sync([user("q"), card, user(`Here is what I sent before:\n\n${action}\n\nWhy?`)]);
    expect(processors.at(-1)!.getSurface("form")?.dataModel.get<string>("/x")).toBe("new");
  });

  test("invalid and duplicate blocks report errors without stopping the others", () => {
    const { store } = makeStore();
    const message = assistant(fence("a2ui", "{oops"), fence("a2ui", create("a")), fence("a2ui", create("a")), fence("a2ui", create("b")));
    store.sync([message]);
    expect(store.lookup(message.content[0], 0, "{oops")?.error).toEqual({ reason: "json" });
    expect(store.lookup(message.content[1], 0, JSON.stringify(create("a")))?.surfaces).toHaveLength(1);
    expect(store.lookup(message.content[3], 0, JSON.stringify(create("b")))?.surfaces).toHaveLength(1);
    expect(store.lookup(message.content[2], 0, JSON.stringify(create("a")))?.surfaces).toHaveLength(0);
  });

  test("two identical fences in one part resolve to their own results", () => {
    const { store } = makeStore();
    const body = JSON.stringify(create("a"));
    const message = assistant(`${fence("a2ui", body)}\n\nagain\n\n${fence("a2ui", body)}`);
    store.sync([message]);
    expect(store.lookup(message.content[0], 0, body)?.surfaces).toHaveLength(1);
    const second = store.lookup(message.content[0], 1, body);
    expect(second?.surfaces).toHaveLength(0);
    expect(second?.error?.reason).toBe("processor");
  });

  test("a send that throws marks the card failed so it can be clicked again", async () => {
    const { store, click } = makeStore([], "prompt", async () => { throw new Error("offline"); });
    store.sync([user("q"), assistant(fence("a2ui", create("plan")))]);
    click("plan");
    await drainMicrotasks();
    expect(store.actionState("plan")).toBe("failed");
  });

  test("an action sends one message, waits while queued, and clears when its message arrives", async () => {
    const sent: string[] = [];
    const { store, click } = makeStore(sent, "followUp");
    const messages = [user("q"), assistant(fence("a2ui", create("plan", { sendDataModel: true })))];
    store.sync(messages);
    click("plan");
    click("plan");
    await drainMicrotasks();
    expect(sent).toHaveLength(1);
    expect(store.actionState("plan")).toBe("queued");
    const parsed = parseActionMessage(sent[0]);
    expect(parsed?.envelope.action).toMatchObject({ name: "pick", surfaceId: "plan", context: { choice: "B" } });
    expect(parsed?.envelope.metadata?.a2uiClientDataModel.surfaces.plan).toEqual({});
    store.sync([...messages, user(sent[0])]);
    expect(store.actionState("plan")).toBeUndefined();
  });
});
