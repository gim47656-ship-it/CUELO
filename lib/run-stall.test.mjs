import assert from "node:assert/strict";
import test from "node:test";

const { isRunStalled, RUN_STALL_MS } = await import("./run-stall.ts");

test("a running turn is stalled from three minutes of silence, not before", () => {
  const start = 1_000_000;
  assert.equal(RUN_STALL_MS, 180_000);
  assert.equal(isRunStalled(true, start, start + RUN_STALL_MS - 1), false);
  assert.equal(isRunStalled(true, start, start + RUN_STALL_MS), true);
});

test("a finished run is never stalled, however long it has been quiet", () => {
  assert.equal(isRunStalled(false, 0, 10 * RUN_STALL_MS), false);
});
