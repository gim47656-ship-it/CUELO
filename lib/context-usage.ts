import type { ContextUsage } from "./omp-types";

/** Occupancy thresholds for the single workspace context indicator. */
export const CONTEXT_WARNING_PERCENT = 70;
export const CONTEXT_CRITICAL_PERCENT = 90;

export type ContextLevel = "normal" | "warning" | "critical";

export interface ContextIndicator {
  level: ContextLevel;
  /** Occupancy in percent; derived from the token counts when omp omits it. */
  percent: number | null;
  /** Meter width in percent, clamped to the track. */
  fillPercent: number;
  /** "78% · 100k/128k" - null when there is no context window to report. */
  readout: string | null;
  usedLabel: string;
  limitLabel: string;
  percentLabel: string;
}

/** Compact token count for the header indicator: 12k / 1.2M. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(0)}k`;
  return String(value);
}

/**
 * Everything the header indicator shows, in one place: the numeric readout is
 * the primary signal and the level only reinforces it, so colour is never the
 * sole carrier of meaning.
 */
export function getContextIndicator(usage: ContextUsage | null | undefined): ContextIndicator {
  const contextWindow = usage && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
    ? usage.contextWindow
    : null;
  const tokens = usage && typeof usage.tokens === "number" && Number.isFinite(usage.tokens)
    ? Math.max(0, usage.tokens)
    : null;
  const percent = usage && typeof usage.percent === "number" && Number.isFinite(usage.percent)
    ? usage.percent
    : tokens !== null && contextWindow !== null
      ? (tokens / contextWindow) * 100
      : null;
  const level: ContextLevel = percent === null
    ? "normal"
    : percent > CONTEXT_CRITICAL_PERCENT
      ? "critical"
      : percent > CONTEXT_WARNING_PERCENT
        ? "warning"
        : "normal";
  const usedLabel = tokens === null ? "?" : formatTokenCount(tokens);
  const limitLabel = contextWindow === null ? "?" : formatTokenCount(contextWindow);
  const percentLabel = percent === null ? "?" : `${percent.toFixed(0)}%`;

  return {
    level,
    percent,
    fillPercent: percent === null ? 0 : Math.min(100, Math.max(0, percent)),
    readout: contextWindow === null ? null : `${percentLabel} · ${usedLabel}/${limitLabel}`,
    usedLabel,
    limitLabel,
    percentLabel,
  };
}
