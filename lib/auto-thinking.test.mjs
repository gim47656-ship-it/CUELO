import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionContext } from "./session-reader.ts";

const timestamp = "2026-01-01T00:00:00.000Z";

function thinkingEntry(id, parentId, thinkingLevel, configured) {
  return { type: "thinking_level_change", id, parentId, timestamp, thinkingLevel, configured };
}

test("restoring a branch retains Auto separately from its resolved effort", () => {
  const entries = [
    thinkingEntry("auto", null, "high", "auto"),
    thinkingEntry("resolved", "auto", "low", "auto"),
    thinkingEntry("manual", "auto", "medium", "medium"),
  ];
  const automatic = buildSessionContext(entries, "resolved");
  assert.equal(automatic.configuredThinkingLevel, "auto");
  assert.equal(automatic.thinkingLevel, "low");
  const manual = buildSessionContext(entries, "manual");
  assert.equal(manual.configuredThinkingLevel, "medium");
  assert.equal(manual.thinkingLevel, "medium");
});
