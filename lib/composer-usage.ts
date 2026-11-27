import type { UsageLimit, UsageReport } from "@/lib/hanse-resource-client";

/**
 * Pure rules behind the composer usage band: which session numbers exist and which provider account
 * report belongs to the session. Every function answers `null` when the data does not say, so the
 * band hides an item instead of showing a guessed number.
 */

const HOUR_MS = 3_600_000;
const FIVE_HOUR_MS = 5 * HOUR_MS;
const WEEK_MS = 7 * 24 * HOUR_MS;

export interface CacheTokenCounts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Session cache hit rate in percent: cache reads / (input + cache writes + cache reads), the
 * denominator covering every input-class token. `null` while the session has no cache traffic,
 * because 0% there would claim a miss the provider never reported.
 */
export function cacheHitPercent(tokens: CacheTokenCounts | null | undefined): number | null {
  if (!tokens) return null;
  const { input, cacheRead, cacheWrite } = tokens;
  if (![input, cacheRead, cacheWrite].every((count) => Number.isFinite(count) && count >= 0)) return null;
  if (cacheRead + cacheWrite <= 0) return null;
  const denominator = cacheRead + cacheWrite + input;
  return denominator > 0 ? (cacheRead / denominator) * 100 : null;
}

function isCredentialId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

interface StampedMessage {
  role: string;
  provider?: string;
  credentialId?: number;
  stopReason?: string;
}

/**
 * The account that produced the session's newest finished answer on `provider`. Core stamps the
 * credential on completed assistant messages, so this is the last account the runtime really used.
 * Error and aborted answers are not finished answers and are passed over; an older stamp behind an
 * unstamped finished answer is not used, because the account may have rotated in between.
 */
export function latestAnswerCredential(messages: readonly StampedMessage[], provider: string | undefined): number | undefined {
  if (!provider) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || message.provider !== provider) continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    return isCredentialId(message.credentialId) ? message.credentialId : undefined;
  }
  return undefined;
}

/**
 * The usage report of the account this session runs on. A report whose credential matches the
 * session's credential wins. Without that match, a provider with exactly one report is that
 * account unless the report names another credential. Several reports and no match: `null`,
 * because picking one would show another account's limits.
 */
export function sessionUsageReport(
  reports: readonly UsageReport[] | null | undefined,
  provider: string | undefined,
  credentialId: number | undefined,
): UsageReport | null {
  if (!reports || !provider) return null;
  const sameProvider = reports.filter((report) => report.provider === provider);
  if (isCredentialId(credentialId)) {
    const exact = sameProvider.find((report) => report.credentialId === credentialId);
    if (exact) return exact;
  }
  if (sameProvider.length !== 1) return null;
  const only = sameProvider[0];
  // Any credential on the sole report other than the session's (malformed ones included) is no proof it is this account.
  if (isCredentialId(credentialId) && only.credentialId !== undefined && only.credentialId !== credentialId) return null;
  return only;
}

export interface WindowRemaining {
  /** Whole percent left, 0-100: 100 minus the rounded used percent the sidebar shows. */
  percent: number;
}

export interface AccountWindows {
  fiveHour: WindowRemaining | null;
  weekly: WindowRemaining | null;
}

/** The window length from the report's own data: `durationMs` when stated, the window id only without it. */
function windowMatches(limit: UsageLimit, durationMs: number, windowId: string): boolean {
  const duration = limit.window?.durationMs;
  if (duration !== undefined) return duration === durationMs;
  const id = limit.scope?.windowId;
  return typeof id === "string" && id.toLowerCase() === windowId;
}

function remainingOf(limits: readonly UsageLimit[], durationMs: number, windowId: string): WindowRemaining | null {
  const matches = limits.filter((limit) => {
    const used = limit.amount?.usedFraction;
    // Account-wide meters only: tier- or model-scoped ones (Opus weekly, Codex Spark) cap one family.
    return typeof used === "number" && Number.isFinite(used)
      && limit.scope?.tier === undefined && limit.scope?.modelId === undefined
      && windowMatches(limit, durationMs, windowId);
  });
  const shared = matches.filter((limit) => limit.scope?.shared === true);
  const pick = matches.length === 1 ? matches[0] : shared.length === 1 ? shared[0] : null;
  if (!pick) return null;
  const usedPercent = Math.round((pick.amount!.usedFraction as number) * 100);
  return { percent: Math.min(100, Math.max(0, 100 - usedPercent)) };
}

/** 5-hour and weekly remaining of one account report; a window the report lacks is `null`. */
export function accountWindows(report: UsageReport | null): AccountWindows {
  const limits = report?.limits ?? [];
  return {
    fiveHour: remainingOf(limits, FIVE_HOUR_MS, "5h"),
    weekly: remainingOf(limits, WEEK_MS, "7d"),
  };
}
