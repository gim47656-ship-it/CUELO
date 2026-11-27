import { describe, expect, test } from "bun:test";
import { accountWindows, cacheHitPercent, latestAnswerCredential, sessionUsageReport } from "./composer-usage";
import type { UsageLimit, UsageReport } from "./hanse-resource-client";

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

function limit(id: string, usedFraction: number, extra: Partial<UsageLimit> = {}): UsageLimit {
  return { id, amount: { usedFraction }, ...extra };
}

describe("cacheHitPercent", () => {
  test("reads over every input-class token", () => {
    expect(cacheHitPercent({ input: 100, cacheRead: 300, cacheWrite: 100 })).toBe(60);
  });

  test("hidden without cache traffic, never a fake 0%", () => {
    expect(cacheHitPercent({ input: 500, cacheRead: 0, cacheWrite: 0 })).toBeNull();
    expect(cacheHitPercent(null)).toBeNull();
  });

  test("writes alone are a real 0%", () => {
    expect(cacheHitPercent({ input: 10, cacheRead: 0, cacheWrite: 90 })).toBe(0);
  });

  test("negative counts are not data", () => {
    expect(cacheHitPercent({ input: -5, cacheRead: 10, cacheWrite: 0 })).toBeNull();
  });
});

describe("latestAnswerCredential", () => {
  const messages = [
    { role: "assistant", provider: "anthropic", credentialId: 9, stopReason: "stop" },
    { role: "assistant", provider: "openai-codex", credentialId: 8, stopReason: "stop" },
    { role: "assistant", provider: "anthropic", credentialId: 11, stopReason: "toolUse" },
    { role: "user" },
    { role: "assistant", provider: "anthropic", stopReason: "error" },
    { role: "assistant", provider: "anthropic", stopReason: "aborted" },
  ];

  test("newest finished answer of the provider; error and aborted answers are passed over", () => {
    expect(latestAnswerCredential(messages, "anthropic")).toBe(11);
    expect(latestAnswerCredential(messages, "openai-codex")).toBe(8);
  });

  test("an unstamped finished answer does not fall back to an older stamp", () => {
    expect(latestAnswerCredential([...messages, { role: "assistant", provider: "anthropic", stopReason: "stop" }], "anthropic")).toBeUndefined();
  });

  test("unknown provider gives nothing", () => {
    expect(latestAnswerCredential(messages, "zai")).toBeUndefined();
    expect(latestAnswerCredential(messages, undefined)).toBeUndefined();
  });
});

describe("sessionUsageReport", () => {
  const first: UsageReport = { provider: "anthropic", credentialId: 9 };
  const second: UsageReport = { provider: "anthropic", credentialId: 11 };
  const codex: UsageReport = { provider: "openai-codex", credentialId: 8 };

  test("matches the session credential among several accounts", () => {
    expect(sessionUsageReport([first, codex, second], "anthropic", 11)).toBe(second);
  });

  test("several accounts and no identified credential: hidden", () => {
    expect(sessionUsageReport([first, codex, second], "anthropic", undefined)).toBeNull();
    expect(sessionUsageReport([first, codex, second], "anthropic", 42)).toBeNull();
  });

  test("a single account report is the session's unless it names another credential", () => {
    expect(sessionUsageReport([first, codex], "anthropic", undefined)).toBe(first);
    expect(sessionUsageReport([first, codex], "anthropic", 11)).toBeNull();
    const usageOnly: UsageReport = { provider: "anthropic", accountRole: "usage-only" };
    expect(sessionUsageReport([usageOnly], "anthropic", 11)).toBe(usageOnly);
    expect(sessionUsageReport([{ provider: "anthropic", credentialId: 0 }], "anthropic", 11)).toBeNull();
  });

  test("never borrows another provider's report", () => {
    expect(sessionUsageReport([codex], "anthropic", 8)).toBeNull();
    expect(sessionUsageReport(undefined, "anthropic", 9)).toBeNull();
  });
});

describe("accountWindows", () => {
  test("picks the account-wide 5h and weekly windows by duration", () => {
    const report: UsageReport = {
      provider: "anthropic",
      limits: [
        limit("anthropic:7d:opus", 0.9, { window: { durationMs: WEEK }, scope: { windowId: "7d", tier: "opus" } }),
        limit("anthropic:5h", 0.374, { label: "Claude 5 Hour", window: { durationMs: 5 * HOUR }, scope: { windowId: "5h", shared: true } }),
        limit("anthropic:7d", 0.2, { window: { durationMs: WEEK }, scope: { windowId: "7d", shared: true } }),
      ],
    };
    expect(accountWindows(report)).toEqual({ fiveHour: { percent: 63 }, weekly: { percent: 80 } });
  });

  test("model-scoped meters never stand in for the account window", () => {
    const report: UsageReport = {
      provider: "openai-codex",
      limits: [limit("openai-codex:spark:primary", 0.5, { window: { durationMs: 5 * HOUR }, scope: { tier: "spark", modelId: "spark" } })],
    };
    expect(accountWindows(report)).toEqual({ fiveHour: null, weekly: null });
  });

  test("the label alone does not make a window; a missing window stays hidden", () => {
    const report: UsageReport = {
      provider: "x",
      limits: [
        limit("a", 0.1, { label: "5 Hour" }),
        limit("b", 0.3, { window: { durationMs: 30 * 24 * HOUR }, label: "Weekly" }),
        limit("c", 0.4, { scope: { windowId: "7d" } }),
      ],
    };
    expect(accountWindows(report)).toEqual({ fiveHour: null, weekly: { percent: 60 } });
  });

  test("a stated duration outranks the window id, even an invalid one", () => {
    const report: UsageReport = { provider: "x", limits: [limit("a", 0.1, { window: { durationMs: HOUR }, scope: { windowId: "5h" } })] };
    expect(accountWindows(report).fiveHour).toBeNull();
    const zero: UsageReport = { provider: "x", limits: [limit("a", 0.4, { window: { durationMs: 0 }, scope: { windowId: "5h" } })] };
    expect(accountWindows(zero).fiveHour).toBeNull();
  });

  test("two unscoped candidates without one shared: hidden instead of guessed", () => {
    const report: UsageReport = {
      provider: "x",
      limits: [limit("a", 0.1, { window: { durationMs: WEEK } }), limit("b", 0.5, { window: { durationMs: WEEK } })],
    };
    expect(accountWindows(report).weekly).toBeNull();
  });

  test("over-limit clamps to 0% left; no report means no windows", () => {
    const report: UsageReport = { provider: "x", limits: [limit("a", 1.2, { window: { durationMs: 5 * HOUR } })] };
    expect(accountWindows(report).fiveHour).toEqual({ percent: 0 });
    expect(accountWindows(null)).toEqual({ fiveHour: null, weekly: null });
  });
});
