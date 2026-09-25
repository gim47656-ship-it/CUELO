import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { autoNameBlockReason } = await jiti.import("./auto-name.ts");

function session(extra = {}) {
  return {
    id: "s1",
    cwd: "/tmp/project",
    created: "2026-01-01T00:00:00Z",
    modified: "2026-01-01T00:00:00Z",
    messageCount: 0,
    firstMessage: "",
    ...extra,
  };
}

test("blocks naming while the session has no JSONL on disk", () => {
  assert.equal(autoNameBlockReason(session({ transient: true, messageCount: 4 }), 4), "unsaved");
  assert.equal(autoNameBlockReason(null, 4), "unsaved");
});

test("blocks naming a saved session that has nothing to summarise", () => {
  assert.equal(autoNameBlockReason(session(), 0), "no-messages");
  assert.equal(autoNameBlockReason(session(), null), "no-messages");
});

test("allows naming from live stats or from the persisted message count", () => {
  assert.equal(autoNameBlockReason(session(), 1), null);
  assert.equal(autoNameBlockReason(session({ messageCount: 6 }), 0), null);
});
