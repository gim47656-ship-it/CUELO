"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { UsageSnapshotController } from "@/hooks/useUsageSnapshot";
import {
  accountIdentities,
  limitExhausted,
  type ResourceLoadState,
  type UsageLimit,
  type UsageReport,
  type UsageSnapshot,
} from "@/lib/hanse-resource-client";
import type { OAuthReloginOutcome, OAuthReloginTarget } from "./ModelsConfig";
import { AccountAvatar } from "./workspace/AccountAvatar";
import { shortWindowAlert, usageWindowKind } from "./lounge/member-usage";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useNow } from "@/hooks/useNow";

/**
 * The account usage the resource panel shows, kept permanently in view above the settings action and
 * outside the session list's scroll. It renders only what was actually reported - no placeholder
 * bars, no invented numbers: the limits the broker answered for, and the B.AI total the `omp stats`
 * aggregate recorded for that provider, with the span that total covers. It reads the app's single
 * usage subscription, so it adds no polling of its own. The 「사용량」 button (and a click anywhere
 * on the strip) opens the full usage view, where errors are explained.
 *
 * Each account is drawn as one group — its face and alias, then its limit rows — so an account's
 * limits always move together. The reader can reorder those groups in place; that order is display
 * only, kept in this browser, and never touches which credential the core picks or which face an
 * account gets (faces come from the whole report list before any sorting). An account whose sign-in
 * failed stays in the list with its reason, and only one that needs a new sign-in offers that action.
 * An account that reports a weekly (or longer) window keeps its short windows (5h) folded unless that
 * window itself is used up, flagged by the broker, or at 90% or more — folding is display only.
 */

/** The limit rows the strip draws before the reader opens the rest. */
const MAX_ROWS = 2;
/** 자동 차단 해제 시각을 판정할 시계의 갱신 간격. 사용량 폴링(60초)보다 촘촘하다. */
const NOW_TICK_MS = 10_000;

/**
 * 좁은 화면에서 이 스트립이 접혀 있는지. 드로어 안에서는 세션 목록과 같은 세로 공간을
 * 나눠 쓰므로 기본은 접힘이고, 펼친 선택만 이 키에 남는다(`"0"` = 펼침).
 * 사이드바 폭과 같은 방식의 localStorage 키 하나이며 별도 저장 계층을 만들지 않는다.
 */
const USAGE_COLLAPSED_KEY = "omp-sidebar-usage-collapsed";

/**
 * 사용자가 고른 계정 표시 순서. 계정 순서 키(`orderKey`)의 JSON 배열이다. 지금 보고서에 없는
 * 계정의 키도 지우지 않아, 잠시 빠졌다 돌아온 계정은 원래 자리로 돌아온다.
 */
const USAGE_ORDER_KEY = "omp-sidebar-usage-order";

/** One limit row the strip can draw: which limit, how much is used. */
interface UsageStripRow {
  key: string;
  label: string;
  percent: number;
  /** Why this row is not one the account can still serve with; `usable` needs no label. */
  state: "usable" | "spent" | "account-spent" | "blocked";
}

type AuthError = NonNullable<UsageReport["authError"]>;

/** One account the strip draws: whose it is, its limit rows, and why it cannot serve, if it cannot. */
export interface UsageStripAccount {
  /** 표시 순서를 저장하는 키. provider 안의 안정 identity(`accountKey`)에서 나온다. */
  orderKey: string;
  provider: string;
  alias: string;
  seed: number;
  masked: string;
  accountKey?: string;
  rows: UsageStripRow[];
  /** 계정 단위 상태. 행 단위 소진(`spent`)은 행에 붙는다. */
  state: "ok" | "blocked" | "account-spent" | "auth";
  authError?: AuthError;
  /** 지금 다음 요청을 받을 수 있는 계정인지. 저장된 순서가 없을 때 이 계정들이 앞에 선다. */
  usable: boolean;
}

/** The share of a limit that is used, or null when the report did not measure it. */
function usedFraction(limit: UsageLimit): number | null {
  const fraction = limit.amount?.usedFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return fraction;
}

/**
 * 순서 키. provider 안에서 계정을 가리키는 안정 identity가 기준이고, 그 값이 없는 보고서만
 * 로컬 credential id나 목록 자리로 떨어진다(이 둘은 이 브라우저 안에서만 쓰인다).
 */
function orderKeyOf(report: UsageReport, index: number): string {
  if (typeof report.accountKey === "string" && report.accountKey.length > 0) {
    return `${report.provider}:${report.accountKey}`;
  }
  return report.credentialId !== undefined
    ? `${report.provider}:#${report.credentialId}`
    : `${report.provider}:@${index}`;
}

/**
 * 보고서 목록을 계정 묶음으로. 얼굴과 별칭은 여기서 한 번, 정렬 전 전체 목록으로 정한다 —
 * 표시 순서를 바꿔도 RIN·MIO가 다른 계정으로 옮겨 가지 않는다.
 *
 * 저장된 순서가 없을 때는 쓸 수 있는 계정이 앞에 선다. 브로커 순서대로면 막힌 계정이 쓸 수 있는
 * 계정을 「더 보기」 뒤로 밀어낼 수 있기 때문이다. 각 부류 안에서는 보고서 순서를 지킨다.
 *
 * 꺼둔 계정(사유 없음)은 그리지 않는다. 인증이 깨진 계정은 한도 막대 없이 사유와 함께 남는다.
 */
function usageStripAccounts(reports: readonly UsageReport[], now: number): UsageStripAccount[] {
  const identities = accountIdentities(reports);
  const leading: UsageStripAccount[] = [];
  const trailing: UsageStripAccount[] = [];
  reports.forEach((report, index) => {
    const authError = report.authError;
    if (report.disabled === true && !authError) return;
    const identity = identities[index];
    const autoBlocked = typeof report.autoBlockedUntilMs === "number" && report.autoBlockedUntilMs > now;
    const limits = report.disabled === true ? [] : report.limits ?? [];
    // 계정 전체가 함께 쓰는 창(`scope.shared`)이 소진되면 그 계정은 통째로 막힌다. 남아 있는
    // 다른 창(예: 주간이 100%인 계정의 5시간 0%)을 가용으로 세면 안 된다. 티어·모델 전용 창은
    // 그 창만 막으므로 여기 들어오지 않는다 — 코어도 같은 기준으로 둘을 구분한다.
    const spentAccount = limits.some((limit) => limit.scope?.shared === true && limitExhausted(limit));
    // 주간(또는 더 긴) 창을 보고한 계정은 5시간 같은 짧은 창을 평소 접는다. 그 창 자체가
    // 소진·경고·90% 이상일 때만 올린다. 짧은 창만 보고하는 provider는 그 창을 그대로 보여 준다.
    const hasLongWindow = limits.some((limit) => usedFraction(limit) !== null && usageWindowKind(limit) !== "short");
    const rows: UsageStripRow[] = [];
    for (const limit of limits) {
      const fraction = usedFraction(limit);
      if (fraction === null) continue;
      if (hasLongWindow && usageWindowKind(limit) === "short" && !shortWindowAlert(limit)) continue;
      rows.push({
        key: limit.id,
        label: limit.label || limit.id,
        percent: Math.round(fraction * 100),
        state: autoBlocked ? "blocked" : spentAccount ? "account-spent" : limitExhausted(limit) ? "spent" : "usable",
      });
    }
    if (rows.length === 0 && !authError) return;
    const state: UsageStripAccount["state"] = authError
      ? "auth"
      : autoBlocked ? "blocked" : spentAccount ? "account-spent" : "ok";
    const account: UsageStripAccount = {
      orderKey: orderKeyOf(report, index),
      provider: report.provider,
      alias: identity.alias,
      seed: identity.seed,
      masked: identity.masked,
      ...(typeof report.accountKey === "string" ? { accountKey: report.accountKey } : {}),
      rows,
      state,
      ...(authError ? { authError } : {}),
      usable: state === "ok" && rows.some((row) => row.state === "usable"),
    };
    (account.usable ? leading : trailing).push(account);
  });
  return [...leading, ...trailing];
}

/** 저장된 순서를 적용한다. 저장된 계정은 그 순서로 앞에, 처음 보는 계정은 기본 순서로 뒤에 붙는다. */
export function orderStripAccounts<T extends { orderKey: string }>(accounts: readonly T[], saved: readonly string[]): T[] {
  const rank = new Map(saved.map((key, index) => [key, index]));
  const known = accounts.filter((account) => rank.has(account.orderKey))
    .sort((a, b) => rank.get(a.orderKey)! - rank.get(b.orderKey)!);
  return [...known, ...accounts.filter((account) => !rank.has(account.orderKey))];
}

/**
 * 화면의 새 순서를 저장된 순서에 겹친다. 지금 그려진 계정이 차지하던 칸만 새 순서로 채우고,
 * 지금 없는 계정의 칸은 그대로 둔다 — 잠시 사라진 계정이 돌아오면 원래 자리다.
 */
export function mergeStripOrder(saved: readonly string[], visible: readonly string[]): string[] {
  const present = new Set(visible);
  const full = [...saved, ...visible.filter((key) => !saved.includes(key))];
  let next = 0;
  return full.map((key) => (present.has(key) ? visible[next++] : key));
}

/**
 * 재로그인 뒤 다시 읽은 사용량에서 대상 계정이 돌아왔는지. 같은 안정 identity의 보고서가 실제로
 * 켜져 있고 인증 오류가 없을 때만 복구다. 보고서가 사라진 것은 복구가 아니라 확인 불가다.
 */
export function reloginOutcome(
  reports: readonly UsageReport[],
  target: Pick<OAuthReloginTarget, "provider" | "accountKey">,
): "recovered" | "still-failing" | "unknown" {
  if (!target.accountKey) return "unknown";
  const same = reports.filter((report) => report.provider === target.provider && report.accountKey === target.accountKey);
  if (same.some((report) => report.disabled !== true && !report.authError)) return "recovered";
  return same.length > 0 ? "still-failing" : "unknown";
}

/**
 * 재로그인 확인 결과의 소유권. 대화상자를 열거나 닫을 때(`reset`)와 새로 확인할 때(`check`)마다
 * 번호를 올리고, 끝난 확인은 자기 번호가 아직 마지막일 때만 상태를 쓴다 — 늦게 끝난 이전 대상의
 * 확인이 지금 열린 다른 대상에 복구·실패를 찍지 않는다.
 */
export function createReloginCheck(onStatus: (status: OAuthReloginOutcome | null) => void) {
  let latest = 0;
  return {
    reset() {
      latest += 1;
      onStatus(null);
    },
    check(
      refresh: () => Promise<ResourceLoadState<UsageSnapshot>>,
      target: Pick<OAuthReloginTarget, "provider" | "accountKey">,
    ) {
      const id = ++latest;
      onStatus("checking");
      refresh().then(
        (result) => {
          if (id !== latest) return;
          onStatus(result.status === "fresh" ? reloginOutcome(result.data.reports, target) : "unknown");
        },
        () => {
          if (id === latest) onStatus("unknown");
        },
      );
    },
  };
}

/** 저장된 표시 순서. 읽지 못하거나 모양이 다르면 순서가 없는 것으로 본다. */
function readSavedOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(USAGE_ORDER_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === "string") : [];
  } catch {
    return [];
  }
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

/** 순서 버튼의 화살표. 글자보다 좁은 자리에서도 방향이 읽힌다. */
function MoveArrow({ direction }: { direction: "up" | "down" }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === "up" ? "2.5 7.5 6 4 9.5 7.5" : "2.5 4.5 6 8 9.5 4.5"} />
    </svg>
  );
}

export function SidebarUsage({ usage, onOpen, onRelogin }: {
  usage: UsageSnapshotController;
  onOpen: () => void;
  /** 재로그인이 필요한 계정을 그 대상으로 연다. 로그인 자체는 열린 화면에서 사용자가 시작한다. */
  onRelogin?: (target: OAuthReloginTarget) => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ orderKey: string; direction: "up" | "down" } | null>(null);
  const groupsRef = useRef<HTMLDivElement>(null);
  // 서버 스냅샷과 첫 페인트는 접힘으로 두고, 펼친 선택이 저장돼 있을 때만 편다.
  const [collapsed, setCollapsed] = useState(true);
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(USAGE_COLLAPSED_KEY) !== "0");
    } catch {
      // 저장소를 못 읽는 브라우저에서는 기본값(접힘)을 그대로 쓴다.
    }
    setSavedOrder(readSavedOrder());
  }, []);
  const bai = usage.bai;
  const reports = usage.state.data?.reports ?? [];
  const now = useNow(NOW_TICK_MS);
  const accounts = orderStripAccounts(usageStripAccounts(reports, now), savedOrder);

  // 순서를 바꾸면 그 계정 묶음이 DOM 안에서 자리를 옮기며 포커스를 잃을 수 있다. 누른 버튼으로
  // 포커스를 돌려 두고, 끝에 닿아 그 버튼이 꺼졌으면 반대쪽 버튼으로 둔다.
  useEffect(() => {
    if (focusRequest === null) return;
    const group = [...(groupsRef.current?.querySelectorAll<HTMLElement>("[data-order-key]") ?? [])]
      .find((element) => element.dataset.orderKey === focusRequest.orderKey);
    const pressed = group?.querySelector<HTMLButtonElement>(`[data-direction="${focusRequest.direction}"]`);
    const other = group?.querySelector<HTMLButtonElement>(`[data-direction="${focusRequest.direction === "up" ? "down" : "up"}"]`);
    (pressed && !pressed.disabled ? pressed : other)?.focus();
    setFocusRequest(null);
  }, [focusRequest]);

  const move = (index: number, direction: "up" | "down") => {
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= accounts.length) return;
    const visible = accounts.map((account) => account.orderKey);
    [visible[index], visible[target]] = [visible[target], visible[index]];
    const next = mergeStripOrder(savedOrder, visible);
    setSavedOrder(next);
    try {
      window.localStorage.setItem(USAGE_ORDER_KEY, JSON.stringify(next));
    } catch {
      // 저장하지 못해도 이번 화면의 순서는 그대로 쓴다.
    }
    setAnnouncement(t("usage.moved", { account: accounts[index].alias, position: target + 1 }));
    setFocusRequest({ orderKey: accounts[index].orderKey, direction });
  };

  // 접힌 스트립은 한도 행 MAX_ROWS개 분량까지만 그린다. 계정 묶음은 쪼개지 않으며, 인증 오류
  // 계정은 막대 대신 사유 한 줄이라 한 행으로 센다.
  const weight = (account: UsageStripAccount) => Math.max(1, account.rows.length);
  let shownWeight = 0;
  const visibleAccounts = expanded || editing
    ? accounts
    : accounts.filter((account) => {
      if (shownWeight >= MAX_ROWS) return false;
      shownWeight += weight(account);
      return true;
    });
  const hidden = accounts.slice(visibleAccounts.length).reduce((sum, account) => sum + weight(account), 0);
  const authIssues = accounts.filter((account) => account.state === "auth").length;

  // What the strip says about B.AI: the recorded total, or the reason it has no number. Printing
  // 0 for an aggregation that was never read would be inventing a measurement.
  const baiValue = bai.status === "measured"
    ? formatTokenCount(bai.tokens)
    : t(bai.status === "empty" ? "usage.baiEmpty" : "usage.baiUnmeasured");
  const baiRange = bai.status === "measured" && bai.from !== null && bai.to !== null
    ? t("usage.baiRange", { from: dayStamp(bai.from), to: dayStamp(bai.to) })
    : null;

  // 계정 단위 상태. 인증 오류는 재로그인이 필요한지에 따라 이름이 다르다.
  const accountStateLabel = (account: UsageStripAccount): string | null => {
    if (account.state === "auth") {
      return t(account.authError?.reloginRequired ? "usage.authExpired" : "usage.authUnavailable");
    }
    if (account.state === "blocked") return t("usage.accountBlocked");
    if (account.state === "account-spent") return t("usage.accountSpent");
    return null;
  };
  // 행 단위 소진은 그 행에만 붙는다. 계정 단위 상태는 계정 줄이 이미 말한다.
  const rowStateLabel = (row: UsageStripRow): string | null => (row.state === "spent" ? t("usage.limitSpent") : null);

  // The open button's name carries what the strip draws: every account and limit on screen with its
  // state, the B.AI readout, plus how many rows the strip could not fit. The bars are decoration, and
  // the account never reaches the eye through a hover title.
  const name = t("usage.open", {
    rows: [
      ...visibleAccounts.flatMap((account) => {
        const state = accountStateLabel(account);
        if (account.rows.length === 0) {
          return [`${account.alias} (${state ?? ""}${account.authError ? `: ${account.authError.message}` : ""})`];
        }
        return account.rows.map((row) => {
          const rowState = rowStateLabel(row) ?? state;
          return `${account.alias} ${row.label} ${row.percent}%${rowState === null ? "" : ` (${rowState})`}`;
        });
      }),
      `${t("usage.bai")} ${baiValue}${baiRange === null ? "" : ` · ${baiRange}`}`,
    ].join(", "),
  }) + (hidden > 0 ? t("usage.openMore", { count: hidden }) : "");

  // 접힘 줄에 남기는 최소 정보: 가장 앞 계정의 첫 한도와 지금 몇 %인지, 한도가 없는 오류 계정이면
  // 그 계정과 상태. 계정이 하나도 없으면 B.AI 누적값을 대신 보여 준다 — 어느 쪽도 새로 만든 숫자가 아니다.
  const first = accounts[0];
  const summary = first === undefined
    ? { label: t("usage.bai"), value: baiValue, danger: false }
    : first.rows.length === 0
      ? { label: first.alias, value: accountStateLabel(first) ?? "", danger: true }
      : { label: first.rows[0].label, value: `${first.rows[0].percent}%`, danger: first.rows[0].percent >= 90 };
  const issuesLabel = authIssues > 0 ? t("usage.authIssues", { count: authIssues }) : null;

  // 외곽은 버튼이 아니다. 안쪽에 아바타·순서·재로그인 버튼이 있어 외곽까지 버튼이면 버튼 안의
  // 버튼이 된다. 키보드와 화면 낭독기는 머리줄의 「사용량」 버튼으로 열고, 마우스는 지금처럼
  // 스트립의 빈 곳을 눌러도 연다.
  const strip = (
    <div
      className="navigator-usage"
      role="group"
      aria-label={t("usage.title")}
      data-editing={editing ? "" : undefined}
      onClick={(event) => {
        if (editing) return;
        if (event.target instanceof Element && event.target.closest("button, a")) return;
        onOpen();
      }}
    >
      <span className="navigator-usage-header">
        <button type="button" className="navigator-usage-open" aria-label={name} onClick={onOpen}>
          {t("usage.title")}
        </button>
        {issuesLabel === null ? null : <span className="navigator-usage-alert">{issuesLabel}</span>}
        {accounts.length > 1 && (
          <button
            type="button"
            className="navigator-usage-edit"
            data-active={editing ? "" : undefined}
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? t("usage.reorderDone") : t("usage.reorder")}
          </button>
        )}
      </span>
      <div
        ref={groupsRef}
        role={editing ? "list" : undefined}
        aria-label={editing ? t("usage.reorderGroup") : undefined}
        className="navigator-usage-groups"
      >
        {accounts.length === 0 ? (
          <span className="navigator-usage-empty">{t("usage.none")}</span>
        ) : visibleAccounts.map((account, index) => {
          const state = accountStateLabel(account);
          return (
            <div
              key={account.orderKey}
              className="navigator-usage-group"
              data-order-key={account.orderKey}
              role={editing ? "listitem" : undefined}
            >
              {/* 어느 계정인지. 식별자 원문 대신 별칭과 얼굴만 내보낸다 — 호버 title은 터치 화면에
                  닿지도 않고, 사이드바는 늘 열려 있어 어깨너머로 읽힌다. */}
              <span className="navigator-usage-account">
                <AccountAvatar seed={account.seed} size={24} provider={account.provider} />
                <span className="navigator-usage-alias">{account.alias}</span>
                {state === null ? null : (
                  <span className="navigator-usage-state" data-tone={account.state === "auth" ? "danger" : undefined}>
                    {state}
                  </span>
                )}
                {editing && (
                  <span className="navigator-usage-moves">
                    <button
                      type="button"
                      className="navigator-usage-move"
                      data-direction="up"
                      aria-label={t("usage.moveUp", { account: account.alias })}
                      disabled={index === 0}
                      onClick={() => move(index, "up")}
                    >
                      <MoveArrow direction="up" />
                    </button>
                    <button
                      type="button"
                      className="navigator-usage-move"
                      data-direction="down"
                      aria-label={t("usage.moveDown", { account: account.alias })}
                      disabled={index === accounts.length - 1}
                      onClick={() => move(index, "down")}
                    >
                      <MoveArrow direction="down" />
                    </button>
                  </span>
                )}
              </span>
              {/* 인증이 깨진 계정: 막대 대신 사유. 다시 로그인해야 풀리는 오류에만 재로그인을 둔다 —
                  꺼둔 계정·자동 차단·한도 소진·조회 실패는 로그인으로 풀리지 않는다. */}
              {account.authError && (
                <span className="navigator-usage-auth">
                  <span className="navigator-usage-reason">{account.authError.message}</span>
                  {account.authError.reloginRequired && onRelogin && !editing && (
                    <button
                      type="button"
                      className="navigator-usage-relogin"
                      aria-label={t("usage.reloginFor", { account: account.alias })}
                      onClick={() => onRelogin({
                        provider: account.provider,
                        alias: account.alias,
                        seed: account.seed,
                        masked: account.masked,
                        ...(account.accountKey ? { accountKey: account.accountKey } : {}),
                        reason: account.authError?.message ?? "",
                      })}
                    >
                      {t("usage.relogin")}
                    </button>
                  )}
                </span>
              )}
              {account.rows.map((row) => {
                const rowState = rowStateLabel(row);
                return (
                  <span key={row.key} className="navigator-usage-row">
                    <span className="navigator-usage-head">
                      <span className="navigator-usage-label">{row.label}</span>
                      {rowState === null ? null : <span className="navigator-usage-state">{rowState}</span>}
                      <span
                        className="navigator-usage-value"
                        style={row.percent >= 90 ? { color: "var(--danger)" } : undefined}
                      >
                        {row.percent}%
                      </span>
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
                );
              })}
            </div>
          );
        })}
      </div>
      {/* The accounts the strip did not fit. They open in place — every account, with the alias each
          one belongs to, without leaving the sidebar. Reordering already shows them all. */}
      {!editing && (hidden > 0 || expanded) && (
        <button
          type="button"
          className="navigator-usage-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? t("usage.showLess") : t("usage.showMore", { count: hidden })}
        </button>
      )}
      {/* The provider that actually served the requests, from the aggregation the resource panel
          already reads and re-reads with the same usage refresh. It is not an account, so it never
          takes part in the order. The caption is the span that total covers, so it is never read as
          a live total, and a strip without a measurement says so instead of showing a zero. */}
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
      <span className="navigator-usage-live" aria-live="polite">{announcement}</span>
    </div>
  );

  // 데스크톱은 스트립을 그대로 둔다. 좁은 화면에서만 접기 줄을 앞에 두고 기본을 접힘으로 둔다 —
  // 드로어 안에서 이 스트립이 세션 목록의 세로 공간을 계속 눌러 왔다. 접혀 있어도 오류 계정 수는 남긴다.
  if (!isMobile) return strip;

  return (
    <div className="navigator-usage-shell">
      <button
        type="button"
        className="navigator-usage-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? `${name}${issuesLabel === null ? "" : `, ${issuesLabel}`}` : t("usage.showLess")}
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
        {collapsed && issuesLabel !== null && <span className="navigator-usage-alert">{issuesLabel}</span>}
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
