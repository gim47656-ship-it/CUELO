import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getContextIndicator } = await jiti.import("./context-usage.ts");

test("reports occupancy as a number first and a level second", () => {
  const indicator = getContextIndicator({ tokens: 100_000, contextWindow: 128_000, percent: 78 });

  assert.equal(indicator.readout, "78% · 100k/128k");
  assert.equal(indicator.level, "warning");
  assert.equal(indicator.fillPercent, 78);
});

test("derives the percentage when omp reports only token counts", () => {
  const indicator = getContextIndicator({ tokens: 64_000, contextWindow: 128_000, percent: null });

  assert.equal(indicator.percentLabel, "50%");
  assert.equal(indicator.level, "normal");
  assert.equal(indicator.readout, "50% · 64k/128k");
});

test("crosses to warning and critical only above their thresholds", () => {
  const level = (percent) => getContextIndicator({ tokens: 1, contextWindow: 100, percent }).level;

  assert.equal(level(70), "normal");
  assert.equal(level(70.5), "warning");
  assert.equal(level(90), "warning");
  assert.equal(level(90.5), "critical");
});

test("clamps the meter without hiding an over-budget number", () => {
  const indicator = getContextIndicator({ tokens: 2_400_000, contextWindow: 2_000_000, percent: 120 });

  assert.equal(indicator.fillPercent, 100);
  assert.equal(indicator.readout, "120% · 2.4M/2.0M");
});

test("has nothing to show without a context window", () => {
  for (const usage of [null, undefined, { tokens: 500, contextWindow: null, percent: null }]) {
    const indicator = getContextIndicator(usage);
    assert.equal(indicator.readout, null);
    assert.equal(indicator.level, "normal");
    assert.equal(indicator.fillPercent, 0);
  }
});

test("keeps unknown token counts explicit next to a known limit", () => {
  const indicator = getContextIndicator({ tokens: null, contextWindow: 128_000, percent: null });

  assert.equal(indicator.readout, "? · ?/128k");
});
