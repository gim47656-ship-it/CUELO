"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { UsageSnapshotController } from "@/hooks/useUsageSnapshot";
import { accountIdentities, type UsageLimit, type UsageReport } from "@/lib/hanse-resource-client";
import { AccountAvatar } from "./workspace/AccountAvatar";
import { useIsMobile } from "@/hooks/useIsMobile";

/**
 * The account usage the resource panel shows, kept permanently in view above the settings action and
 * outside the session list's scroll. It renders only what was actually reported - no placeholder
 * bars, no invented numbers: the limits the broker answered for, and the B.AI total the `omp stats`
 * aggregate recorded for that provider, with the span that total covers. It reads the app's single
 * usage subscription, so it adds no polling of its own. The whole strip opens the full usage view,
 * where errors are explained. The rows it has room for lead with the limits an account can still
 * serve with; the rest open in place, counted rather than dropped.
 */

/** The limit rows the strip draws before the reader opens the rest. */
const MAX_ROWS = 2;

/**
 * 좁은 화면에서 이 스트립이 접혀 있는지. 드로어 안에서는 세션 목록과 같은 세로 공간을
 * 나눠 쓰므로 기본은 접힘이고, 펼친 선택만 이 키에 남는다(`"0"` = 펼침).
 * 사이드바 폭과 같은 방식의 localStorage 키 하나이며 별도 저장 계층을 만들지 않는다.
 */
const USAGE_COLLAPSED_KEY = "omp-sidebar-usage-collapsed";

/** One limit row the strip can draw: whose account, which limit, how much is used. */
interface UsageStripRow {
  key: string;
  account: string;
  seed: number;
  provider: string;
  label: string;
  percent: number;
  /** Why this row is not one the account can still serve with; `usable` needs no label. */
  state: "usable" | "spent" | "account-spent" | "blocked";
}

/** The share of a limit that is used, or null when the report did not measure it. */
function usedFraction(limit: UsageLimit): number | null {
  const fraction = limit.amount?.usedFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return fraction;
}

/**
 * 한도가 소진됐는지. 코어와 같은 순서로 본다 — 브로커가 매긴 `status` 를 먼저 믿고, 그 값이
 * 없거나 `unknown` 일 때만 실측값으로 판단한다(`@oh-my-pi/pi-ai` 의 isUsageLimitExhausted 와
 * 같은 규칙). 표시용 백분율로 판단하지 않는 이유는 반올림이 99.6%를 100%로 만들기 때문이다.
 */
function limitExhausted(limit: UsageLimit): boolean {
  if (typeof limit.status === "string" && limit.status !== "unknown") {
    return limit.status === "exhausted";
  }
  const amount = limit.amount ?? {};
  const measured = (key: string): number | null => {
    const value = amount[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };
  const used = measured("usedFraction");
  if (used !== null && used >= 1) return true;
  const remainingFraction = measured("remainingFraction");
  if (remainingFraction !== null && remainingFraction <= 0) return true;
  const amountUsed = measured("used");
  const amountLimit = measured("limit");
  if (amountUsed !== null && amountLimit !== null && amountUsed >= amountLimit) return true;
  const remaining = measured("remaining");
  if (remaining !== null && remaining <= 0) return true;
  return amount.unit === "percent" && amountUsed !== null && amountUsed >= 100;
}

/**
 * The rows the strip draws, usable accounts first.
 *
 * The broker answers in its own account order, so an account the core has
 * auto-blocked or used up can stand in front of one that can still serve the
 * next request — and the strip has room for `MAX_ROWS` rows before the rest are
 * opened, so the usable account would be the one left behind. A row leads when
 * its account is usable (not off, not auto-blocked) and that limit still has
 * room; each class keeps the broker's order. Nothing is dropped or renumbered:
 * the aliases still come from the whole report list, and the count behind the
 * strip still covers every row the strip could not fit.
 */
function usageStripRows(reports: readonly UsageReport[], now: number): UsageStripRow[] {
  const identities = accountIdentities(reports);
  const leading: UsageStripRow[] = [];
  const trailing: UsageStripRow[] = [];
  reports.forEach((report, index) => {
    if (report.disabled === true) return;
    const identity = identities[index];
    const autoBlocked = typeof report.autoBlockedUntilMs === "number" && report.autoBlockedUntilMs > now;
    // 계정 전체가 함께 쓰는 창(`scope.shared`)이 소진되면 그 계정은 통째로 막힌다. 남아 있는
    // 다른 창(예: 주간이 100%인 계정의 5시간 0%)을 가용으로 세면 안 된다. 티어·모델 전용 창은
    // 그 창만 막으므로 여기 들어오지 않는다 — 코어도 같은 기준으로 둘을 구분한다.
    const spentAccount = (report.limits ?? []).some(
      (limit) => limit.scope?.shared === true && limitExhausted(limit),
    );
    for (const limit of report.limits ?? []) {
      const fraction = usedFraction(limit);
      if (fraction === null) continue;
      const state: UsageStripRow["state"] = autoBlocked
        ? "blocked"
        : spentAccount ? "account-spent" : limitExhausted(limit) ? "spent" : "usable";
      const row: UsageStripRow = {
        key: `${report.provider}:${report.credentialId ?? identity.seed}:${limit.id}`,
        account: identity.alias,
        seed: identity.seed,
        provider: report.provider,
        label: limit.label || limit.id,
        percent: Math.round(fraction * 100),
        state,
      };
      (state === "usable" ? leading : trailing).push(row);
    }
  });
  return [...leading, ...trailing];
}

/** Compact token units, the ones the resource panel's model rows print. */
function formatTokenCount(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

/** Month/day of an aggregation bound, the stamp the resource panel's range header prints. */
function dayStamp(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

export function SidebarUsage({ usage, onOpen }: { usage: UsageSnapshotController; onOpen: () => void }) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  // 서버 스냅샷과 첫 페인트는 접힘으로 두고, 펼친 선택이 저장돼 있을 때만 편다.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(USAGE_COLLAPSED_KEY) !== "0");
    } catch {
      // 저장소를 못 읽는 브라우저에서는 기본값(접힘)을 그대로 쓴다.
    }
  }, []);
  const bai = usage.bai;
  const reports = usage.state.data?.reports ?? [];
  // 별칭은 헬퍼가 패널과 같은 목록(꺼둔 계정 포함)에서 배정하므로 두 화면의 이름이 어긋나지 않는다.
  const all = usageStripRows(reports, Date.now());
  const rows = expanded ? all : all.slice(0, MAX_ROWS);
  const hidden = all.length - rows.length;

  // What the strip says about B.AI: the recorded total, or the reason it has no number. Printing
  // 0 for an aggregation that was never read would be inventing a measurement.
  const baiValue = bai.status === "measured"
    ? formatTokenCount(bai.tokens)
    : t(bai.status === "empty" ? "usage.baiEmpty" : "usage.baiUnmeasured");
  const baiRange = bai.status === "measured" && bai.from !== null && bai.to !== null
    ? t("usage.baiRange", { from: dayStamp(bai.from), to: dayStamp(bai.to) })
    : null;

  // 쓸 수 없는 계정 행에만 붙는 상태. 눈으로 보는 값이므로 접근성 이름에도 같이 들어간다.
  const rowStateLabel = (row: UsageStripRow): string | null => row.state === "usable"
    ? null
    : t(row.state === "blocked"
      ? "usage.accountBlocked"
      : row.state === "account-spent" ? "usage.accountSpent" : "usage.limitSpent");

  // The button's name carries what the strip draws: the account, the limit and the percent of every
  // limit row on screen, the B.AI readout, plus how many limit rows the strip could not fit. The
  // bars themselves are decoration, and the account never reaches the eye through a hover title.
  const name = t("usage.open", {
    rows: [
      ...rows.map((row) => {
        const state = rowStateLabel(row);
        return `${row.account} ${row.label} ${row.percent}%${state === null ? "" : ` (${state})`}`;
      }),
      `${t("usage.bai")} ${baiValue}${baiRange === null ? "" : ` · ${baiRange}`}`,
    ].join(", "),
  }) + (hidden > 0 ? t("usage.openMore", { count: hidden }) : "");

  // 접힘 줄에 남기는 최소 정보: 가장 앞 한도의 이름과 지금 몇 %인지. 한도 행이 하나도 없으면
  // B.AI 누적값을 대신 보여 준다 — 어느 쪽도 새로 만든 숫자가 아니다.
  const summary = all.length === 0
    ? { label: t("usage.bai"), value: baiValue, danger: false }
    : { label: all[0].label, value: `${all[0].percent}%`, danger: all[0].percent >= 90 };

  // 스트립은 버튼처럼 동작하지만 버튼이 아니다. 안쪽 아바타가 확대 보기용 버튼을 이미
  // 갖고 있어 바깥까지 <button>이면 버튼 안의 버튼이 되고, 그건 HTML이 금지하는 구조다.
  // 대신 role="button"으로 이름과 클릭을 그대로 두고, 버튼이 공짜로 주던 키보드 활성화만
  // 직접 받는다.
  const strip = (
    <div
      role="button"
      tabIndex={0}
      className="navigator-usage"
      onClick={onOpen}
      onKeyDown={(event) => {
        // 안쪽 아바타에서 올라온 키는 아바타의 몫이다. click은 아바타가 stopPropagation으로
        // 끊지만 keydown은 그대로 올라오므로, 스트립 자신이 포커스일 때만 연다.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        // Space의 기본 동작은 스크롤이다. 버튼이 공짜로 주던 차단을 여기서 직접 한다.
        if (event.key === " ") event.preventDefault();
        onOpen();
      }}
      aria-label={name}
    >
      {rows.length === 0 ? (
        <span className="navigator-usage-empty">{t("usage.none")}</span>
      ) : rows.map((row) => (
        <span key={row.key} className="navigator-usage-row">
          <span className="navigator-usage-head">
            <span className="navigator-usage-label">{row.label}</span>
            <span
              className="navigator-usage-value"
              style={row.percent >= 90 ? { color: "var(--danger)" } : undefined}
            >
              {row.percent}%
            </span>
          </span>
          {/* 어느 계정의 한도인지. 식별자 원문 대신 별칭과 얼굴만 내보낸다 — 호버 title은
              터치 화면에 닿지도 않고, 사이드바는 늘 열려 있어 어깨너머로 읽힌다. */}
          <span className="navigator-usage-account">
            <AccountAvatar seed={row.seed} size={24} provider={row.provider} />
            {row.account}
            {/* 왜 이 행이 뒤로 밀렸는지. 상태를 알려 주는 값은 보고서가 준 autoBlockedUntilMs 와
                실측 사용률뿐이고, 쓸 수 있는 계정에는 아무 표시도 붙이지 않는다. */}
            {rowStateLabel(row) === null ? null : (
              <span className="navigator-usage-state">{rowStateLabel(row)}</span>
            )}
          </span>
          <span aria-hidden="true" className="navigator-usage-track">
            <span
              className="navigator-usage-fill"
              style={{
                // Only the bar is bounded by its track; the readout above keeps the real number.
                width: `${Math.max(0, Math.min(100, row.percent))}%`,
                background: row.percent >= 90 ? "var(--danger)" : "var(--metric)",
              }}
            />
          </span>
        </span>
      ))}
      {/* The limits the strip did not fit. The strip itself opens the full usage view, so this
          says what the rest of the list is and opens it in place — every account's limits, with
          the alias each one belongs to, without leaving the sidebar. */}
      {(hidden > 0 || expanded) && (
        <button
          type="button"
          className="navigator-usage-more"
          aria-expanded={expanded}
          onClick={(event) => {
            // 스트립 전체의 클릭은 「사용량 자세히 보기」다. 이 버튼은 그 위에서 자기 일만 한다.
            event.stopPropagation();
            setExpanded((current) => !current);
          }}
        >
          {expanded ? t("usage.showLess") : t("usage.showMore", { count: hidden })}
        </button>
      )}
      {/* The provider that actually served the requests, from the aggregation the resource panel
          already reads and re-reads with the same usage refresh. The caption is the span that total
          covers, so it is never read as a live total, and a strip without a measurement says so
          instead of showing a zero. */}
      <span className="navigator-usage-row">
        <span className="navigator-usage-head">
          <span className="navigator-usage-label">{t("usage.bai")}</span>
          <span
            className="navigator-usage-value"
            style={bai.status === "measured" ? undefined : { color: "var(--text-dim)" }}
          >
            {baiValue}
          </span>
        </span>
        {baiRange === null ? null : <span className="navigator-usage-account">{baiRange}</span>}
      </span>
    </div>
  );

  // 데스크톱은 지금까지와 같다. 좁은 화면에서만 접기 줄을 앞에 두고 기본을 접힘으로 둔다 —
  // 드로어 안에서 이 스트립이 세션 목록의 세로 공간을 계속 눌러 왔다.
  if (!isMobile) return strip;

  return (
    <div className="navigator-usage-shell">
      <button
        type="button"
        className="navigator-usage-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? name : t("usage.showLess")}
        onClick={() => {
          const next = !collapsed;
          setCollapsed(next);
          try {
            window.localStorage.setItem(USAGE_COLLAPSED_KEY, next ? "1" : "0");
          } catch {
            // 저장하지 못해도 이번 화면의 접힘 상태는 그대로 쓴다.
          }
        }}
      >
        <span className="navigator-usage-label">{collapsed ? summary.label : t("usage.showLess")}</span>
        {collapsed && (
          <span
            className="navigator-usage-value"
            style={summary.danger ? { color: "var(--danger)" } : undefined}
          >
            {summary.value}
          </span>
        )}
        <svg
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0, transform: collapsed ? "rotate(0deg)" : "rotate(180deg)" }}
        >
          <polyline points="2.5 4 6 7.5 9.5 4" />
        </svg>
      </button>
      {collapsed ? null : strip}
    </div>
  );
}
