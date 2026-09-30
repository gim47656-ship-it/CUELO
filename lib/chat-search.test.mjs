import assert from "node:assert/strict";
import test from "node:test";

const { buildChatSearchIndex, listChatSearchHits, resolveActiveHit } = await import("./chat-search.ts");

const messages = [
  { role: "user", content: "Find the Alpha log" },
  { role: "assistant", content: [{ type: "thinking", thinking: "alpha in thinking" }, { type: "text", text: "alpha one, ALPHA two" }] },
  { role: "custom", customType: "command", content: [{ type: "text", text: "no match" }], display: true },
];
const items = [
  { kind: "message", idx: 0 },
  { kind: "answer", anchorIdx: 0, idx: 1, runIndex: 0, blocks: [{ type: "text", text: "alpha one, ALPHA two" }], precedingBlocks: [] },
  { kind: "message", idx: 2, anchorIdx: 0 },
];

test("indexes what the conversation shows, not the folded thinking", () => {
  assert.deepEqual(buildChatSearchIndex(items, messages), ["find the alpha log", "alpha one, alpha two", "no match"]);
});

test("counts rendered items from the DOM and the rest from the data, in order", () => {
  const index = buildChatSearchIndex(items, messages);
  // Item 1 is rendered and its markdown shows only one occurrence.
  const hits = listChatSearchHits(index, "alpha", new Map([[1, 1]]), 1, 3);
  assert.deepEqual(hits, [{ item: 0, k: 0 }, { item: 1, k: 0 }]);
  assert.deepEqual(listChatSearchHits(index, "alpha", new Map(), 3, 3), [
    { item: 0, k: 0 }, { item: 1, k: 0 }, { item: 1, k: 1 },
  ]);
});

test("keeps the active place, clamps inside its item, and falls back to the first hit", () => {
  const hits = [{ item: 0, k: 0 }, { item: 4, k: 0 }, { item: 4, k: 1 }, { item: 9, k: 0 }];
  assert.equal(resolveActiveHit(hits, { item: 4, k: 1 }), 2);
  assert.equal(resolveActiveHit(hits, { item: 4, k: 5 }), 2);
  assert.equal(resolveActiveHit(hits, { item: 7, k: 0 }), 0);
  assert.equal(resolveActiveHit(hits, null), 0);
  assert.equal(resolveActiveHit([], { item: 1, k: 0 }), -1);
});
