"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import { getContextIndicator } from "@/lib/context-usage";
import { accountWindows, cacheHitPercent, sessionUsageReport, type CacheTokenCounts } from "@/lib/composer-usage";
import { providerDisplayName, type UsageReport } from "@/lib/hanse-resource-client";
import type { ContextUsage } from "@/lib/omp-types";
import styles from "./ComposerUsageBand.module.css";

interface Props {
  contextUsage: ContextUsage | null | undefined;
  sessionTokens: CacheTokenCounts | null | undefined;
  outputTokensPerSecond: number | null;
  /** The rate is a running estimate of the answer in progress (shown with `~`). */
  outputSpeedLive: boolean;
  /** Reports of the app's single usage poller; never fetched here. */
  usageReports: readonly UsageReport[] | undefined;
  provider: string | undefined;
  /** Credential stamped on the session's newest finished answer of `provider`. */
  credentialId: number | undefined;
}

interface Item {
  key: string;
  text: string;
  title: string;
  level?: "warning" | "critical";
}

/**
 * One line above the composer field with the session's numbers. Items appear in priority order
 * and the row is exactly one line tall: an item that does not fit wraps onto the clipped second
 * line and disappears whole, so the lowest-priority items drop first and no number is cut. The
 * band's own title keeps every item's full text, the dropped ones included.
 */
export function ComposerUsageBand({ contextUsage, sessionTokens, outputTokensPerSecond, outputSpeedLive, usageReports, provider, credentialId }: Props) {
  const { t } = useI18n();
  const windows = useMemo(
    () => accountWindows(sessionUsageReport(usageReports, provider, credentialId)),
    [usageReports, provider, credentialId],
  );

  const items: Item[] = [];
  const context = getContextIndicator(contextUsage);
  if (context.readout && context.percent !== null) {
    const status = context.level === "critical"
      ? t("chat.contextUsageCritical")
      : context.level === "warning" ? t("chat.contextUsageWarning") : null;
    const title = t("chat.contextUsageTitle", { used: context.usedLabel, limit: context.limitLabel, percent: context.percentLabel });
    items.push({
      key: "context",
      text: context.readout,
      title: status ? `${title}. ${status}` : title,
      level: context.level === "normal" ? undefined : context.level,
    });
  }
  const providerName = provider ? providerDisplayName(provider) : "";
  if (windows.fiveHour) {
    const percent = `${windows.fiveHour.percent}%`;
    items.push({ key: "five-hour", text: t("chat.usageBandFiveHour", { percent }), title: t("chat.usageBandFiveHourTitle", { provider: providerName, percent }) });
  }
  if (windows.weekly) {
    const percent = `${windows.weekly.percent}%`;
    items.push({ key: "weekly", text: t("chat.usageBandWeekly", { percent }), title: t("chat.usageBandWeeklyTitle", { provider: providerName, percent }) });
  }
  const cache = cacheHitPercent(sessionTokens);
  if (cache !== null) {
    const percent = `${cache.toFixed(1)}%`;
    items.push({ key: "cache", text: t("chat.usageBandCache", { percent }), title: t("chat.usageBandCacheTitle", { percent }) });
  }
  if (outputTokensPerSecond !== null && Number.isFinite(outputTokensPerSecond)) {
    const rate = outputTokensPerSecond >= 10 ? Math.round(outputTokensPerSecond) : outputTokensPerSecond.toFixed(1);
    items.push({
      key: "speed",
      text: t(outputSpeedLive ? "chat.outputSpeedLive" : "chat.outputSpeed", { rate }),
      title: t(outputSpeedLive ? "chat.outputSpeedLiveTitle" : "chat.outputSpeedTitle"),
    });
  }
  if (items.length === 0) return null;

  return (
    <div
      className={styles.band}
      role="group"
      aria-label={t("chat.usageBand")}
      title={items.map((item) => item.title).join("\n")}
    >
      {items.map((item) => (
        <span key={item.key} className={styles.item} data-level={item.level} title={item.title}>
          {item.text}
        </span>
      ))}
    </div>
  );
}
