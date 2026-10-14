import { limitExhausted, type UsageLimit } from "@/lib/hanse-resource-client";

/**
 * 사용량 창의 길이 분류와 짧은 창 경고 기준. 사이드바 사용량 줄이 5시간처럼 짧은 창을 평소 접고,
 * 그 창이 소진·브로커 경고·90% 이상일 때만 올리는 데 쓴다. 차단 판단은 코어가 하므로 표시만 한다.
 */

const DAY_MS = 86_400_000;
const WEEKLY_MIN_MS = 6 * DAY_MS;
const SHORT_MAX_MS = 12 * 3_600_000;
/** 짧은 창을 경고로 올리는 사용률. 사이드바 사용량 줄이 빨간색으로 바꾸는 기준과 같다. */
const USAGE_WARN_PERCENT = 90;

export type UsageWindowKind = "weekly" | "short" | "other";

/** 창의 길이. 보고서의 `durationMs`를 먼저 믿고, 없을 때만 창 id·라벨의 표기로 가른다. */
export function usageWindowKind(limit: UsageLimit): UsageWindowKind {
  const duration = limit.window?.durationMs;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    if (duration >= WEEKLY_MIN_MS) return "weekly";
    if (duration <= SHORT_MAX_MS) return "short";
    return "other";
  }
  const scope = limit.scope?.windowId;
  const text = `${typeof scope === "string" ? scope : ""} ${limit.id} ${limit.label ?? ""}`.toLowerCase();
  if (/(^|[^0-9])7d\b|week|7 day|주간/.test(text)) return "weekly";
  if (/(^|[^0-9])(5h|1h)\b|hour|시간/.test(text)) return "short";
  return "other";
}

/**
 * 평소 접어 두는 짧은 창을 그래도 보여야 하는지: 그 창 자체가 소진됐거나, 브로커가 경고를
 * 매겼거나, 90% 이상일 때. 계정 단위 차단은 늘 보이는 주간 막대가 이미 말하므로 여기 넣지 않는다.
 */
export function shortWindowAlert(limit: UsageLimit): boolean {
  const fraction = limit.amount?.usedFraction;
  const percent = typeof fraction === "number" && Number.isFinite(fraction) ? Math.round(fraction * 100) : null;
  return limitExhausted(limit) || limit.status === "warning" || (percent !== null && percent >= USAGE_WARN_PERCENT);
}
