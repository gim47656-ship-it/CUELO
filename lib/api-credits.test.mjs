import assert from "node:assert/strict";
import { test } from "bun:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { balanceFromForm, creditMeter, creditSettingFromForm, isApiCreditsSnapshot, localDateTimeInput } = await jiti.import("./api-credits.ts");

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
  assert.equal(isApiCreditsSnapshot({ settings: {}, hive: { rows: [] }, anthropic: { rows: [] } }), true);
  assert.equal(isApiCreditsSnapshot({ settings: {}, hive: { rows: [] }, anthropic: { error: "x" } }), false, "a broken Anthropic section is not shown as empty usage");
});

test("balance form keeps a zero balance, reads the local check time, and names the field it cannot read", () => {
  const observedAt = new Date(2026, 9, 20, 9, 15).getTime();
  assert.deepEqual(balanceFromForm({ amountUsd: "$0", observedAt: localDateTimeInput(observedAt) }), { value: { amountUsd: 0, observedAt } });
  assert.deepEqual(balanceFromForm({ amountUsd: "1,204.50", observedAt: "2026-10-20T09:15" }), { value: { amountUsd: 1204.5, observedAt } });
  assert.deepEqual(balanceFromForm({ amountUsd: "", observedAt: "2026-10-20T09:15" }), { error: "amount" });
  assert.deepEqual(balanceFromForm({ amountUsd: "12", observedAt: "" }), { error: "observedAt" });
  assert.deepEqual(balanceFromForm({ amountUsd: "12", observedAt: "10/20/2026" }), { error: "observedAt" });
});

test("snapshot guard refuses a balance list whose recorded value is not a number", () => {
  const base = { settings: {}, hive: { rows: [] } };
  const balance = (recorded) => ({ wallet: "exa", source: "dashboard-record", evidence: "recent-paid-use", lastPaidUseAt: 1, recorded });
  assert.equal(isApiCreditsSnapshot({ ...base, balances: [balance(null), balance({ amountUsd: 0, observedAt: 1 })] }), true);
  assert.equal(isApiCreditsSnapshot({ ...base, balances: [balance({ amountUsd: "12.50", observedAt: 1 })] }), false);
});
