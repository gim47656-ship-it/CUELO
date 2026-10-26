import assert from "node:assert/strict";
import { test } from "bun:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { creditMeter, creditSettingFromForm, isApiCreditsSnapshot } = await jiti.import("./api-credits.ts");

test("meter length is spent/total, clamps at full, and warns near the end", () => {
  assert.deepEqual(creditMeter({ spentUsd: 30, totalUsd: 300 }), { spentFraction: 0.1, tone: "normal" });
  assert.deepEqual(creditMeter({ spentUsd: 280, totalUsd: 300 }).tone, "warning");
  assert.deepEqual(creditMeter({ spentUsd: 330, totalUsd: 300 }), { spentFraction: 1, tone: "danger" });
  assert.deepEqual(creditMeter({ spentUsd: 5, totalUsd: null }), { spentFraction: null, tone: "normal" });
});

test("form strings become a save request; an unreadable total is refused", () => {
  assert.deepEqual(creditSettingFromForm({ totalUsd: "$1,000", startDate: " 2026-10-01 " }), { totalUsd: 1000, startDate: "2026-10-01" });
  assert.deepEqual(creditSettingFromForm({ totalUsd: "25.5", startDate: "2026-10-18" }), { totalUsd: 25.5, startDate: "2026-10-18" });
  assert.equal(creditSettingFromForm({ totalUsd: "", startDate: "2026-10-18" }), null);
  assert.equal(creditSettingFromForm({ totalUsd: "abc", startDate: "2026-10-18" }), null);
});

test("snapshot guard accepts the sidecar shape and rejects an error body", () => {
  assert.equal(isApiCreditsSnapshot({ settings: {}, hive: { rows: [] } }), true);
  assert.equal(isApiCreditsSnapshot({ error: "credits_unavailable" }), false);
});
