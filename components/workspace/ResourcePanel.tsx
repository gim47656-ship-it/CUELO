"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { ActionButton, Tabs } from "@seed-design/react";
import type { UsageSnapshotController } from "@/hooks/useUsageSnapshot";
import type { ApiKeyProviderListing, OAuthProviderListing } from "@/lib/provider-listing";
import {
  accountIdentities,
  acquireCredentialAction,
  createSessionAccountPoller,
  CHARACTER_ROSTER,
  loadModelStats,
  providerDisplayName,
  redeemCredentialReset,
  ResourceClientError,
  setCredentialEnabled,
  type AccountIdentity,
  type AgentAggregate,
  type CredentialResetResult,
  type DailyModelCost,
  type ModelAggregate,
  type ModelStatsSnapshot,
  type ResetRecommendation,
  type ResourceLoadState,
  type SessionAccountPoller,
  type SessionAccountState,
  type UsageDaySlot,
  type UsageLimit,
  type UsageReport,
  type UsageSnapshot,
} from "../../lib/hanse-resource-client";
import { AccountAvatar } from "./AccountAvatar";

export type ResourceTab = "characters" | "usage" | "models";

export interface ResourcePanelProps {
  open: boolean;
  sessionId: string | null;
  activeTab: ResourceTab;
  onTabChange: (tab: ResourceTab) => void;
  /** The app's single usage subscription; this panel reads it instead of starting its own. */
  usage: UsageSnapshotController;
  className?: string;
}

type PanelState<T> =
  | { status: "idle"; data: null; error: null }
  | ResourceLoadState<T>;

interface Pace {
  burnOnly: boolean;
  unit: "하루" | "시간";
  partial: boolean;
  burn: number;
  pacePct?: number;
  deltaPct?: number;
  nominal?: number;
}

const DAY_MS = 86_400_000;

const buttonClass = "min-h-9 border border-border bg-bg px-3 text-xs font-medium text-text transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-50";

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function formatReset(timestamp: number, now: number): string {
  const remainingMinutes = Math.floor((timestamp - now) / 60_000);
  if (remainingMinutes <= 0) return "리셋됨";
  const days = Math.floor(remainingMinutes / 1_440);
  const hours = Math.floor((remainingMinutes % 1_440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `${days}d ${hours}h 후 리셋`;
  if (hours > 0) return `${hours}h ${minutes}m 후 리셋`;
  return `${minutes}m 후 리셋`;
}

function formatExpiry(expiresAt: string | null, now: number): string | null {
  if (!expiresAt) return null;
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) return null;
  const remainingMinutes = Math.floor((timestamp - now) / 60_000);
  if (remainingMinutes <= 0) return "만료됨";
  const days = Math.floor(remainingMinutes / 1_440);
  const hours = Math.floor((remainingMinutes % 1_440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `${days}d ${hours}h 후 만료`;
  if (hours > 0) return `${hours}h ${minutes}m 후 만료`;
  return `${minutes}m 후 만료`;
}

function currentCredentialId(accountState: SessionAccountState | null): number | null {
  return accountState?.state === "resolved"
    && accountState.source === "session-pin"
    && Number.isSafeInteger(accountState.credentialId)
    && (accountState.credentialId as number) > 0
    ? accountState.credentialId as number
    : null;
}

type CredentialActionKind = "toggle" | "reset";

interface CredentialFeedback {
  tone: "status" | "error";
  message: string;
}

function paceOf(limit: UsageLimit, now: number): Pace | null {
  const window = limit.window;
  const usedFraction = limit.amount?.usedFraction;
  if (!window?.resetsAt || typeof usedFraction !== "number") return null;

  const remainingMs = Math.max(0, window.resetsAt - now);
  const usedPct = usedFraction * 100;
  const leftPct = Math.max(0, 100 - usedPct);
  if (!window.durationMs) {
    const remainingDays = remainingMs / DAY_MS;
    return {
      burnOnly: true,
      unit: "하루",
      partial: remainingDays < 1,
      burn: remainingDays >= 1 ? leftPct / remainingDays : leftPct,
    };
  }

  const elapsedMs = Math.min(window.durationMs, Math.max(0, window.durationMs - remainingMs));
  const perDay = window.durationMs > 12 * 3_600_000;
  const unitMs = perDay ? DAY_MS : 3_600_000;
  const slots = window.durationMs / unitMs;
  const remainingSlots = remainingMs / unitMs;
  const pacePct = (elapsedMs / window.durationMs) * 100;
  return {
    burnOnly: false,
    unit: perDay ? "하루" : "시간",
    partial: remainingSlots < 1,
    burn: remainingSlots >= 1 ? leftPct / remainingSlots : leftPct,
    pacePct,
    deltaPct: usedPct - pacePct,
    nominal: 100 / slots,
  };
}

function formatMoney(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value === 0) return "$0";
  if (value >= 100) return `$${value.toFixed(0)}`;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value >= 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(4)}`;
}

function formatNumber(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

function formatTokens(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(Math.round(value));
}

function formatPercent(value: number | null | undefined, digits = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function formatSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return `${(value / 1_000).toFixed(1)}s`;
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0">
      <dt className="text-xs text-text-muted">{label}</dt>
      <dd className="m-0 font-mono text-xs tabular-nums text-text">{value}</dd>
    </div>
  );
}

function StateNotice({
  state,
  loading,
  subject,
}: {
  state: PanelState<unknown>;
  loading: boolean;
  subject: string;
}) {
  if (loading && state.status === "idle") {
    return <div className="p-4 text-sm text-text-muted" role="status">{subject} 불러오는 중…</div>;
  }
  if (state.status === "error") {
    return (
      <div className="p-4 text-sm text-text" role="alert">
        <div className="font-medium">{subject}을 불러오지 못했습니다.</div>
        <div className="mt-1 text-xs text-text-muted">{state.error.message}</div>
        <div className="mt-2 text-xs text-text-dim">사이드카(127.0.0.1:30142)가 실행 중인지 확인하세요.</div>
      </div>
    );
  }
  if (state.status === "stale") {
    return (
      <div className="border-b border-border bg-bg px-4 py-2 text-xs text-text-muted" role="status">
        마지막 데이터를 표시합니다. 새로고침 실패: {state.error.message}
      </div>
    );
  }
  return null;
}

/** 구간 경계 시각. 날짜와 분까지 보여야 "어디서 끊긴 구간인지"를 읽을 수 있다. */
function slotStamp(timestamp: number): string {
  const date = new Date(timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${date.getMonth() + 1}/${date.getDate()} ${hours}:${minutes}`;
}

function formatGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

/**
 * 구간 실측 한 줄. 품질은 색이 아니라 기호와 낱말이 나른다 — 추정값에 `≈`와 「추정」이
 * 붙고, 표본이 없으면 숫자를 지어내지 않고 「기록 부족」이라고 적는다.
 */
function slotReadout(daySlot: UsageDaySlot | undefined): string | null {
  if (!daySlot) return null;
  if (daySlot.quality === "unknown" || daySlot.usedPct == null) return "구간 사용 — 기록 부족";
  if (daySlot.quality === "approx") return `구간 사용 ≈${daySlot.usedPct.toFixed(0)}% · 추정`;
  return `구간 사용 ${daySlot.usedPct.toFixed(1)}%`;
}

function slotQuality(daySlot: UsageDaySlot): string {
  if (daySlot.quality === "unknown") return "기록 부족 · 구간 시작 전 표본이 없습니다";
  const gap = daySlot.gapMs == null || daySlot.gapMs === 0 ? null : formatGap(daySlot.gapMs);
  if (daySlot.quality === "exact") return gap ? `실측 · 경계 ${gap} 전 표본` : "실측 · 구간 시작이 창의 시작";
  return `추정 · 경계 ${gap ?? "?"} 전 표본`;
}

function UsageMeter({ limit, now, detailed }: { limit: UsageLimit; now: number; detailed: boolean }) {
  const fraction = typeof limit.amount?.usedFraction === "number" ? limit.amount.usedFraction : 0;
  const barPct = Math.max(0, Math.min(100, fraction * 100));
  const roundedPct = Math.round(fraction * 100);
  const pace = paceOf(limit, now);
  const daySlot = limit.daySlot;
  // 막대 위의 「이번 구간」 띠. 실측이 있을 때만 그린다.
  const bandStart = daySlot?.usedPct == null || daySlot.baselinePct == null
    ? null
    : Math.max(0, Math.min(daySlot.baselinePct, 100));
  const bandEnd = bandStart == null ? null : Math.max(bandStart, Math.min(fraction * 100, 100));
  const pacePosition = pace?.pacePct == null ? null : Math.min(pace.pacePct, 99.6);
  const reached = fraction >= 1;
  const critical = roundedPct >= 90;
  // 꼬리표는 예외에만 단다. 페이스보다 느린 것은 정상이고 그 사실은 막대의 페이스 눈금이
  // 이미 말한다 — 모든 행에 「여유」를 붙이면 그것이 다시 숫자의 벽이 된다.
  const overPacePct = pace?.deltaPct != null && pace.deltaPct >= 0.5 ? pace.deltaPct : null;
  const slot = slotReadout(daySlot);

  return (
    <div className="usage-limit py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-muted">{limit.label || limit.id}</span>
        {reached ? <span className="usage-chip" data-tone="danger">{fraction > 1 ? "한도 초과" : "한도 도달"}</span> : null}
        {overPacePct != null ? (
          <span className="usage-chip" data-tone="warning">{`과속 +${overPacePct.toFixed(1)}%`}</span>
        ) : null}
        <span className={classNames(
          "shrink-0 font-mono text-sm font-semibold tabular-nums",
          critical ? "text-danger" : "text-text",
        )}>
          {roundedPct}%
        </span>
      </div>
      <div
        className="relative mt-1 h-3.5 overflow-hidden border border-border-strong bg-metric-track"
        role="progressbar"
        aria-label={`${limit.label || limit.id} 사용량`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={roundedPct}
      >
        <div
          className={classNames("absolute inset-y-0 left-0", critical ? "bg-danger" : "bg-metric")}
          style={{ width: `${barPct}%` }}
        />
        {bandStart != null && bandEnd != null && bandEnd > bandStart ? (
          <div
            className="absolute inset-y-0 bg-metric-recent"
            style={{
              left: `${bandStart}%`,
              width: `${bandEnd - bandStart}%`,
              boxShadow: "inset 1px 0 var(--bg-panel)",
            }}
          />
        ) : null}
        {pacePosition != null ? (
          <div
            className="absolute inset-y-0 w-0.5 bg-text"
            style={{
              left: `${pacePosition}%`,
              boxShadow: "0 0 0 1px color-mix(in srgb, var(--bg-panel) 80%, transparent)",
            }}
            aria-hidden="true"
          />
        ) : null}
        {fraction > 1 ? <div className="absolute inset-y-0 right-0 w-1 bg-danger" aria-hidden="true" /> : null}
      </div>
      {slot || limit.window?.resetsAt ? (
        <div className="mt-1 flex items-baseline justify-between gap-3 font-mono text-[11px] tabular-nums text-text-muted">
          <span className="min-w-0 truncate">{slot ?? ""}</span>
          {limit.window?.resetsAt ? <span className="shrink-0">{formatReset(limit.window.resetsAt, now)}</span> : null}
        </div>
      ) : null}
      {detailed ? (
        <dl className="m-0 mt-1.5 border-s-2 border-border ps-2.5">
          {pace?.pacePct != null ? <Metric label="페이스" value={`${pace.pacePct.toFixed(1)}%`} /> : null}
          {pace ? (
            <Metric
              label={pace.partial ? "남은 한도" : `앞으로 ${pace.unit}`}
              value={`${pace.burn.toFixed(1)}%`}
            />
          ) : null}
          {pace?.nominal != null ? (
            <Metric
              label="균등 배분 기준"
              value={`${pace.nominal.toFixed(1)}%/${pace.unit === "하루" ? "일" : "시간"} · 계산값`}
            />
          ) : null}
          {daySlot ? (
            <Metric
              label="구간"
              value={`${slotStamp(daySlot.slotStart)} ~ ${slotStamp(daySlot.slotEnd)} · ${daySlot.slotIndex + 1}/${daySlot.slotCount}`}
            />
          ) : null}
          {daySlot ? <Metric label="기록 품질" value={slotQuality(daySlot)} /> : null}
        </dl>
      ) : null}
    </div>
  );
}

function resetRecommendationCopy(recommendation: ResetRecommendation | undefined, now: number): string | null {
  if (!recommendation) return null;
  if (recommendation.reason === "blocked-account") {
    if (recommendation.scope) {
      return `권고 — ${recommendation.scope}가 소진됐습니다. 저장된 리셋권 사용을 검토하세요.`;
    }
    const wait = typeof recommendation.naturalResetAt === "number"
      ? formatReset(recommendation.naturalResetAt, now).replace(/ 후 리셋$/, "")
      : null;
    return wait
      ? `권고 — 지금 쓸 수 있는 다른 계정이 없고 자연 리셋까지 ${wait} 남았습니다.`
      : "권고 — 지금 쓸 수 있는 다른 계정이 없어 저장된 리셋 사용을 검토하세요.";
  }
  const expiry = formatExpiry(recommendation.expiresAt ?? null, now);
  const expiryPhrase = expiry && expiry !== "만료됨" ? expiry : "곧 만료";
  const usage = typeof recommendation.usedFraction === "number"
    ? ` 현재 ${Math.round(recommendation.usedFraction * 100)}% 소모한 ${recommendation.window === "weekly" ? "주간" : "5시간"} 한도를 초기화할 수 있습니다.`
    : "";
  return `권고 — 리셋 1개가 ${expiryPhrase}됩니다.${usage}`;
}

function resetFeedback(result: CredentialResetResult): CredentialFeedback {
  switch (result.code) {
    case "reset":
      return { tone: "status", message: "리셋 사용함" };
    case "no_credit":
      return { tone: "status", message: "사용할 수 있는 리셋이 없습니다." };
    case "already_redeemed":
      return { tone: "status", message: "이미 사용된 리셋입니다." };
    case "nothing_to_reset":
      return { tone: "status", message: "지금은 초기화할 한도가 없습니다." };
    case "ineligible":
      return { tone: "status", message: "지금은 이 리셋을 쓸 수 없습니다(한도 미도달 또는 자격 없음)." };
    case "cooldown":
      return { tone: "status", message: "리셋 재사용 대기 중입니다. 잠시 뒤 다시 시도하세요." };
    case "offer_changed":
      return { tone: "status", message: "리셋 목록이 바뀌었습니다. 새로고침 후 다시 시도하세요." };
    case "rate_limited":
      return { tone: "error", message: "리셋 사용 실패: 요청이 많아 잠시 막혔습니다." };
    case "reset_unconfirmed":
      return { tone: "error", message: "이전 리셋 요청 결과를 아직 확인하지 못했습니다. 잠시 뒤 확인하세요." };
    case "no_account":
      return { tone: "error", message: "리셋 사용 실패: 계정을 찾을 수 없습니다." };
    case "account_unavailable":
      return { tone: "error", message: "리셋 사용 실패: 계정에 연결할 수 없습니다." };
    case "credit_list_failed":
      return { tone: "error", message: "리셋 사용 실패: 저장된 리셋 목록을 확인하지 못했습니다." };
    default:
      return result.code.startsWith("http_")
        ? { tone: "error", message: `리셋 사용 실패: 서비스 응답 오류 (${result.code})` }
        : { tone: "error", message: `리셋 사용 실패: ${result.code}` };
  }
}

function resetErrorFeedback(error: unknown): CredentialFeedback {
  if (error instanceof ResourceClientError) {
    if (error.outcomeUnknown || error.kind === "timeout") {
      return {
        tone: "error",
        message: "적용 여부 확인 필요 — 자동으로 다시 시도하지 않았습니다. 새로고침으로 남은 개수를 확인하세요.",
      };
    }
    switch (error.code) {
      case "account_disabled":
        return { tone: "error", message: "리셋 사용 실패: 꺼둔 계정에서는 사용할 수 없습니다." };
      case "no_account":
        return { tone: "error", message: "리셋 사용 실패: 계정을 찾을 수 없습니다." };
      case "account_unavailable":
        return { tone: "error", message: "리셋 사용 실패: 계정에 연결할 수 없습니다." };
      case "credit_list_failed":
        return { tone: "error", message: "리셋 사용 실패: 저장된 리셋 목록을 확인하지 못했습니다." };
      default:
        return { tone: "error", message: `리셋 사용 실패: ${error.message}` };
    }
  }
  return { tone: "error", message: `리셋 사용 실패: ${error instanceof Error ? error.message : String(error)}` };
}

function earliestResetCredit(report: UsageReport): { id: string; expiresAt: string | null } | null {
  const credits = report.savedReset?.credits ?? [];
  let selected: { id: string; expiresAt: string | null; timestamp: number | null } | null = null;
  for (const credit of credits) {
    if (!credit.id) continue;
    const parsed = credit.expiresAt ? Date.parse(credit.expiresAt) : Number.NaN;
    const timestamp = Number.isFinite(parsed) ? parsed : null;
    if (!selected
      || (timestamp != null && (selected.timestamp == null || timestamp < selected.timestamp))) {
      selected = { id: credit.id, expiresAt: credit.expiresAt, timestamp };
    }
  }
  return selected ? { id: selected.id, expiresAt: selected.expiresAt } : null;
}

const ANTHROPIC_RESET_SCOPE_LABELS: Record<string, string> = {
  "anthropic:5h": "5시간",
  "anthropic:7d": "주간",
  "anthropic:7d:opus": "주간",
  "anthropic:7d:sonnet": "주간",
};

function anthropicResetScope(report: UsageReport): string | null {
  if (report.provider !== "anthropic") return null;
  const saved = report.savedReset;
  const selected = saved?.credits.find(credit => credit.id === saved.nextCreditId) ?? saved?.credits[0];
  const labels = [...new Set((selected?.clears ?? [])
    .map(id => ANTHROPIC_RESET_SCOPE_LABELS[id])
    .filter((label): label is string => label !== undefined))];
  return labels.length ? `${labels.join("·")} 한도만` : null;
}

export function focusResetTrigger(trigger: Pick<HTMLButtonElement, "focus"> | null): void {
  trigger?.focus();
}

export function ResetConfirmation({
  confirmId,
  pending,
  primaryRef,
  summary,
  onConfirm,
  onCancel,
}: {
  confirmId: string;
  pending: boolean;
  primaryRef: RefObject<HTMLButtonElement | null>;
  summary: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  };
  return (
    <div
      className="resource-reset resource-reset-confirm-group"
      data-reset-state={pending ? "pending" : "confirming"}
      data-dismissible-layer
      role="group"
      aria-label="리셋 사용 확인"
      onKeyDown={onKeyDown}
    >
      <p className="m-0 text-xs leading-5 text-text-muted">저장된 리셋 {summary}</p>
      <p id={confirmId} className="m-0 text-xs leading-5 text-text">
        리셋 1개를 지금 사용합니다. 되돌릴 수 없습니다.
      </p>
      <p className="m-0 mt-1 text-xs leading-5 text-text-muted">이 계정의 차단 기록도 함께 지워집니다.</p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <button
          ref={primaryRef}
          type="button"
          className={classNames(buttonClass, "resource-reset-confirm")}
          aria-describedby={confirmId}
          disabled={pending}
          onClick={onConfirm}
        >
          {pending ? "사용 중…" : "리셋 사용"}
        </button>
        <button type="button" className={buttonClass} disabled={pending} onClick={onCancel}>취소</button>
      </div>
    </div>
  );
}

/** 이 안에 리셋이 들어오면 계정 카드에 보조 배지를 단다. 차단 표시를 대체하지 않는다. */
const SOON_RESET_MS = 2 * 3_600_000;

export function UsageAccount({
  report,
  brokerOk,
  now,
  active,
  identity,
  recommendation,
  pendingAction,
  feedback,
  onToggle,
  onReset,
}: {
  report: UsageReport;
  brokerOk: boolean;
  now: number;
  active: boolean;
  /** 목록 전체에서 배정된 별칭·얼굴. 단독 렌더에서는 이 계정 하나로 배정한다. */
  identity?: AccountIdentity;
  recommendation?: ResetRecommendation;
  pendingAction: CredentialActionKind | null;
  feedback?: CredentialFeedback;
  onToggle: (report: UsageReport) => void;
  onReset: (report: UsageReport, creditId: string) => Promise<void>;
}) {
  const metadata = report.metadata ?? {};
  // 목록 단위 배정이 원칙이다. 단독 렌더(단일 계정)에서도 같은 규칙을 그대로 쓴다.
  const who = identity ?? accountIdentities([report])[0];
  const credentialId = report.credentialId;
  const canToggle = Number.isSafeInteger(credentialId) && (credentialId as number) > 0;
  const accountRole = report.accountRole;
  const accountKind = accountRole === "usage-only"
    ? "사용량"
    : accountRole === "control-only"
      ? "계정 제어"
      : metadata.planType;
  const autoBlocked = report.disabled !== true
    && typeof report.autoBlockedUntilMs === "number"
    && report.autoBlockedUntilMs > now;
  const accountState = active ? "active" : report.disabled ? "off" : autoBlocked ? "auto-blocked" : "idle";
  const status = pendingAction === "toggle"
    ? "전환 중…"
    : pendingAction === "reset"
      ? "리셋 사용 중…"
      : !canToggle
        ? accountRole === "usage-only"
          ? "할당량 정보 · 계정 연결 없음"
          : "제어 불가 · credential id 없음"
        : active
          ? "현재 사용 · 이 세션"
          : report.disabled
            ? "꺼둠"
            : autoBlocked
              ? `자동 차단 · ${formatReset(report.autoBlockedUntilMs as number, now)}`
              : accountRole === "control-only"
                ? "로그인 계정 · ON/OFF 제어"
                : "대기";
  const confirmId = useId();
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState<{ creditId: string; summary: string } | null>(null);
  const resetTriggerRef = useRef<HTMLButtonElement>(null);
  const confirmPrimaryRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerRef = useRef(false);
  const resetSubmitRef = useRef(false);
  const savedReset = report.provider === "openai-codex" || report.provider === "anthropic" ? report.savedReset : undefined;
  const selectedCredit = earliestResetCredit(report);
  const selectedCreditId = selectedCredit?.id ?? null;
  const expiryLabel = formatExpiry(selectedCredit?.expiresAt ?? null, now);
  const count = savedReset?.availableCount;
  const resetValue = !savedReset || savedReset.state === "unavailable"
    ? "확인 불가"
    : savedReset.state === "empty" || count === 0
      ? "없음"
      : `${count ?? savedReset.credits.length}개${expiryLabel ? ` · ${expiryLabel}` : ""}`;
  const resetScope = anthropicResetScope(report);
  const recommendationText = resetRecommendationCopy(recommendation, now);
  const showResetAction = (report.provider === "openai-codex" || report.provider === "anthropic")
    && brokerOk
    && report.disabled !== true
    && savedReset?.state === "available"
    && count !== 0
    && selectedCreditId != null;
  useLayoutEffect(() => {
    if (resetConfirmation) {
      confirmPrimaryRef.current?.focus();
      return;
    }
    if (restoreTriggerRef.current) {
      restoreTriggerRef.current = false;
      focusResetTrigger(resetTriggerRef.current);
    }
  }, [resetConfirmation]);

  useEffect(() => {
    if (pendingAction !== "reset"
      && (report.disabled || !brokerOk || savedReset?.state !== "available")) {
      restoreTriggerRef.current = false;
      setResetConfirmation(null);
    }
  }, [brokerOk, pendingAction, report.disabled, savedReset?.state]);
  const cancelReset = () => {
    restoreTriggerRef.current = true;
    setResetConfirmation(null);
  };
  const submitReset = async () => {
    if (!resetConfirmation || resetSubmitRef.current) return;
    resetSubmitRef.current = true;
    try {
      await onReset(report, resetConfirmation.creditId);
    } finally {
      resetSubmitRef.current = false;
      restoreTriggerRef.current = true;
      setResetConfirmation(null);
    }
  };
  const toggleDetails = () => {
    const next = !detailsOpen;
    setDetailsOpen(next);
    // 펼침을 닫으면 원문은 다시 가린다. 노출 상태는 어디에도 저장하지 않는다.
    if (!next) setRevealed(false);
  };
  const nextReset = (report.limits ?? []).reduce<number | null>((soonest, limit) => {
    const at = limit.window?.resetsAt;
    if (typeof at !== "number" || at <= now) return soonest;
    return soonest == null || at < soonest ? at : soonest;
  }, null);
  const stateTone = pendingAction
    ? "pending"
    : active ? "active" : report.disabled ? "off" : autoBlocked ? "blocked" : "idle";

  return (
    <section
      className="resource-account border-b border-border-strong px-4 py-3 last:border-b-0"
      data-account-state={accountState}
      aria-current={active ? "true" : undefined}
    >
      <div className="resource-account-head flex min-w-0 items-start gap-2.5">
        <AccountAvatar seed={who.seed} size={48} provider={report.provider} />
        <div className="min-w-0 flex-1">
          <h3 className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm font-semibold text-text">
            <span>{who.alias}</span>
            <span className="min-w-0 truncate text-xs font-normal text-text-muted">
              {`${providerDisplayName(report.provider)}${accountKind ? ` · ${accountKind}` : ""}`}
            </span>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {/* 현재 사용 가능 상태(런타임 사실). 오른쪽 스위치는 사용 설정(사용자 의사)이다 */}
            <span
              className="resource-account-state resource-account-badge"
              data-tone={stateTone}
              role={pendingAction ? "status" : undefined}
            >
              {status}
            </span>
            {nextReset != null && nextReset - now <= SOON_RESET_MS ? (
              <span className="usage-chip">
                {`곧 리셋 · ${formatReset(nextReset, now).replace(/ 후 리셋$/, "")}`}
              </span>
            ) : null}
          </div>
        </div>
        {canToggle ? (
          <span className="resource-account-toggle">
            <span className="resource-account-toggle-label">사용 설정</span>
            <button
              type="button"
              role="switch"
              className={classNames(buttonClass, "resource-account-switch min-w-[3.25rem]")}
              disabled={pendingAction != null || !brokerOk}
              aria-label={`${who.alias} 계정 사용 설정`}
              aria-checked={!report.disabled}
              aria-busy={pendingAction != null || undefined}
              title={!brokerOk ? "제어 서버에 연결할 수 없습니다." : undefined}
              onClick={() => {
                restoreTriggerRef.current = false;
                setResetConfirmation(null);
                onToggle(report);
              }}
            >
              {report.disabled ? "OFF" : "ON"}
            </button>
          </span>
        ) : null}
      </div>
      {report.disabled ? (
        <div className="mt-2 text-xs text-text-muted">다른 계정이 있으면 이 계정을 사용하지 않습니다.</div>
      ) : autoBlocked ? (
        <div className="mt-2 text-xs text-text-muted">한도를 다 써서 코어가 자동으로 차단했습니다.</div>
      ) : null}
      {feedback ? (
        <div className="mt-2 text-xs text-text" role={feedback.tone === "error" ? "alert" : "status"}>
          {feedback.message}
        </div>
      ) : null}
      <div id={detailsId} className="resource-account-limits divide-y divide-border">
        {detailsOpen ? (
          <div className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-xs text-text-muted">계정</span>
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="min-w-0 truncate font-mono text-xs text-text">
                {revealed ? who.raw : who.masked || "—"}
              </span>
              {who.raw ? (
                <button
                  type="button"
                  className="resource-account-reveal"
                  aria-pressed={revealed}
                  onClick={() => setRevealed(!revealed)}
                >
                  {revealed ? "가리기" : "이메일 보기"}
                </button>
              ) : null}
            </span>
          </div>
        ) : null}
        {(report.limits ?? []).map((limit) => (
          <UsageMeter key={limit.id} limit={limit} now={now} detailed={detailsOpen} />
        ))}
      </div>
      {(report.limits ?? []).length > 0 || who.raw ? (
        <button
          type="button"
          className="resource-account-more"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onClick={toggleDetails}
        >
          {detailsOpen ? "간단히" : "자세히"}
        </button>
      ) : null}
      {report.provider === "openai-codex" || report.provider === "anthropic" ? (
        resetConfirmation ? (
          <ResetConfirmation
            confirmId={confirmId}
            pending={pendingAction === "reset"}
            primaryRef={confirmPrimaryRef}
            summary={resetConfirmation.summary}
            onConfirm={() => { void submitReset(); }}
            onCancel={cancelReset}
          />
        ) : (
          <div
            className="resource-reset mt-3 border-t border-border pt-2.5"
            data-reset-state={!brokerOk
              ? "offline"
              : !savedReset || savedReset.state === "unavailable"
                ? "unavailable"
                : savedReset.state === "empty" || count === 0
                  ? "empty"
                  : pendingAction === "reset"
                    ? "pending"
                    : "ready"}
          >
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1.5">
              <div className="flex min-w-[10.5rem] flex-1 items-baseline justify-between gap-x-3">
                <span className="text-xs text-text-muted">저장된 리셋</span>
                <span className={classNames(
                  "font-mono text-xs tabular-nums text-text",
                  recommendation?.reason === "expiring-credit" && "text-warning",
                )}>
                  {resetValue}
                </span>
              </div>
              {resetScope ? <span className="text-xs text-text-muted">{resetScope}</span> : null}
              {showResetAction ? (
                <button
                  ref={resetTriggerRef}
                  type="button"
                  className={classNames(buttonClass, "ml-auto flex-none")}
                  disabled={pendingAction != null}
                  onClick={() => {
                    if (selectedCreditId) setResetConfirmation({ creditId: selectedCreditId, summary: resetValue });
                  }}
                >
                  리셋 사용
                </button>
              ) : brokerOk && report.disabled
                && savedReset?.state === "available" ? (
                <span className="ml-auto text-xs text-text-muted">켠 뒤 사용 가능</span>
              ) : null}
            </div>
            {recommendationText ? <p className="m-0 mt-1.5 text-xs leading-5 text-text-muted">{recommendationText}</p> : null}
          </div>
        )
      ) : null}
    </section>
  );
}

export function UsageView({
  state,
  loading,
  accountState,
  pendingActions,
  feedbackByCredential,
  onToggle,
  onReset,
}: {
  state: PanelState<UsageSnapshot>;
  loading: boolean;
  accountState: SessionAccountState | null;
  pendingActions: ReadonlyMap<number, CredentialActionKind>;
  feedbackByCredential: ReadonlyMap<number, CredentialFeedback>;
  onToggle: (report: UsageReport) => void;
  onReset: (report: UsageReport, creditId: string) => Promise<void>;
}) {
  const now = Date.now();
  const data = state.data;
  const activeCredentialId = currentCredentialId(accountState);
  // 별칭·얼굴은 화면에 뜬 계정 전체를 한 번에 보고 배정해야 서로 겹치지 않는다.
  const identities = accountIdentities(data?.reports ?? []);
  const activeReportIndex = activeCredentialId == null
    ? -1
    : data?.reports.findIndex((report) => report.credentialId === activeCredentialId) ?? -1;
  return (
    <>
      <StateNotice state={state} loading={loading} subject="사용량" />
      {data?.brokerOk === false ? (
        <div className="border-b border-border bg-bg px-4 py-2 text-xs text-text-muted" role="status">
          제어 서버에 연결할 수 없어 계정 전환과 리셋 사용을 잠시 쓸 수 없습니다. 사용량 표시는 계속 갱신됩니다.
        </div>
      ) : null}
      <div className="flex min-h-7 items-center gap-4 border-b border-border bg-bg-raised px-4 text-[11px] font-semibold tracking-[0.08em] text-text-muted uppercase" aria-label="사용량 그래프 범례">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 bg-metric" aria-hidden="true" />누적</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 bg-metric-recent" aria-hidden="true" />이번 구간</span>
        <span className="inline-flex items-center gap-1.5"><span className="h-3 w-0.5 bg-text" aria-hidden="true" />페이스</span>
      </div>
      {data && data.reports.length === 0 ? (
        <div className="p-4 text-sm text-text-muted">인증된 계정의 사용량 정보가 없습니다. `omp usage`로 확인하세요.</div>
      ) : null}
      {data?.reports.map((report, index) => {
        const credentialId = report.credentialId;
        return (
          <UsageAccount
            key={`${report.provider}:${credentialId ?? report.metadata?.accountId ?? report.metadata?.email ?? index}`}
            report={report}
            brokerOk={data.brokerOk === true}
            now={now}
            active={index === activeReportIndex}
            identity={identities[index]}
            recommendation={credentialId == null
              ? undefined
              : accountState?.resetRecommendations.find((item) => item.credentialId === credentialId)}
            pendingAction={credentialId == null ? null : pendingActions.get(credentialId) ?? null}
            feedback={credentialId == null ? undefined : feedbackByCredential.get(credentialId)}
            onToggle={onToggle}
            onReset={onReset}
          />
        );
      })}
    </>
  );
}

function ModelRow({ model }: { model: ModelAggregate }) {
  const width = Math.max(1, Math.min(100, model.costShare * 100));
  return (
    <section className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold text-text" title={model.model}>{model.model}</h3>
        <span className="text-xs text-text-muted">{model.provider}</span>
        <span className="font-mono text-xs tabular-nums text-text">{formatMoney(model.cost)} · {formatPercent(model.costShare)}</span>
      </div>
      <div className="my-2 h-1 overflow-hidden border border-border-strong bg-metric-track" aria-hidden="true">
        <div className="h-full bg-metric" style={{ width: `${width}%` }} />
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-4">
        <Metric label="요청" value={formatNumber(model.requests)} />
        <Metric label="요청당" value={formatMoney(model.costPerRequest)} />
        <Metric label="토큰/요청" value={formatTokens(model.tokensPerRequest)} />
        <Metric label="출력/요청" value={formatTokens(model.outputPerRequest)} />
        <Metric label="캐시율" value={formatPercent(model.cacheRate, 1)} />
        <Metric label="TTFT" value={formatSeconds(model.avgTtft)} />
      </dl>
    </section>
  );
}

function AgentRow({ agent }: { agent: AgentAggregate }) {
  const label = ({ main: "메인", subagent: "SubAgent", advisor: "advisor" } as Record<string, string>)[agent.agentType]
    ?? agent.agentType;
  const width = Math.max(1, Math.min(100, agent.costShare * 100));
  return (
    <section className="border-b border-border px-4 py-3 last:border-b-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 text-sm font-semibold text-text">{label}</h3>
        <span className="font-mono text-xs tabular-nums text-text">{formatMoney(agent.cost)} · {formatPercent(agent.costShare)}</span>
      </div>
      <div className="my-2 h-1 overflow-hidden border border-border-strong bg-metric-track" aria-hidden="true">
        <div className="h-full bg-metric" style={{ width: `${width}%` }} />
      </div>
      <dl className="m-0 grid grid-cols-2 gap-x-4">
        <Metric label="요청" value={formatNumber(agent.requests)} />
        <Metric label="요청당" value={formatMoney(agent.costPerRequest)} />
        <Metric label="토큰/요청" value={formatTokens(agent.tokensPerRequest)} />
      </dl>
    </section>
  );
}

function DailyRow({ day }: { day: DailyModelCost }) {
  const names = day.models.slice(0, 3).map((model) => model.model).join(", ");
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-3 border-b border-border px-4 py-2 last:border-b-0">
      <span className="font-mono text-xs tabular-nums text-text-muted">{dayLabel(day.timestamp)}</span>
      <span className="truncate text-xs text-text-muted" title={names}>{names}</span>
      <span className="font-mono text-xs tabular-nums text-text">{formatMoney(day.cost)}</span>
    </div>
  );
}
export function ModelsView({ state, loading }: { state: PanelState<ModelStatsSnapshot>; loading: boolean }) {
  const data = state.data;
  return (
    <>
      <StateNotice state={state} loading={loading} subject="모델 집계" />
      {data ? (
        <>
          <section aria-labelledby="resource-overall-heading">
            <h2 id="resource-overall-heading" className="m-0 border-b border-border bg-bg-raised px-4 py-2 text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">전체</h2>
            <dl className="m-0 grid grid-cols-2 gap-x-4 px-4 py-3">
              <Metric label="요청" value={formatNumber(data.overall.requests)} />
              <Metric label="비용" value={formatMoney(data.overall.cost)} />
              <Metric label="토큰" value={formatTokens(data.overall.tokens)} />
              <Metric label="캐시율" value={formatPercent(data.overall.cacheRate, 1)} />
              <Metric label="캐시 절감" value={formatPercent(data.overall.cacheSavings, 1)} />
              <Metric label="평균 TTFT" value={formatSeconds(data.overall.avgTtft)} />
            </dl>
          </section>
          <section aria-labelledby="resource-models-heading">
            <h2 id="resource-models-heading" className="m-0 border-y border-border bg-bg-raised px-4 py-2 text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">모델별</h2>
            {data.models.length ? data.models.map((model) => <ModelRow key={`${model.provider}:${model.model}`} model={model} />) : (
              <div className="p-4 text-sm text-text-muted">모델 기록이 없습니다.</div>
            )}
          </section>
          <section aria-labelledby="resource-agents-heading">
            <h2 id="resource-agents-heading" className="m-0 border-y border-border bg-bg-raised px-4 py-2 text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">에이전트 종류별</h2>
            {data.agents.length ? data.agents.map((agent) => <AgentRow key={agent.agentType} agent={agent} />) : (
              <div className="p-4 text-sm text-text-muted">기록이 없습니다.</div>
            )}
          </section>
          {data.daily.length ? (
            <section aria-labelledby="resource-daily-heading">
              <h2 id="resource-daily-heading" className="m-0 border-y border-border bg-bg-raised px-4 py-2 text-[10px] font-semibold tracking-[0.08em] text-text-muted uppercase">일별 비용</h2>
              {data.daily.map((day) => <DailyRow key={day.timestamp} day={day} />)}
            </section>
          ) : null}
          <p className="m-0 border-t border-border px-4 py-3 text-xs leading-5 text-text-dim">
            `omp stats` 기준 누적값입니다. 구독 한도 %는 계정 한도 탭에서 확인하세요.
          </p>
        </>
      ) : null}
    </>
  );
}

export function CharacterRosterView({ reports, providerConnections }: {
  reports?: readonly UsageReport[];
  providerConnections?: ReadonlyMap<string, boolean> | null;
}) {
  return (
    <>
      <section className="character-roster-intro" aria-labelledby="character-roster-heading">
        <h2 id="character-roster-heading">호출 가능한 캐릭터</h2>
        <p>
          <strong>호출·불러·소환</strong>은 캐릭터를 SubAgent로 이 대화에 부릅니다.
          <strong> 교체</strong>는 이 대화의 Main을 바꿉니다.
        </p>
      </section>
      <div className="character-roster" role="list" aria-label="호출 가능한 캐릭터 목록">
        {CHARACTER_ROSTER.map((character) => {
          const headingId = `character-roster-${character.seed}`;
          const statusId = `character-roster-${character.seed}-status`;
          const model = `${character.provider}/${character.model}`;
          let providerObserved = false;
          let providerEnabled = false;
          if (reports) {
            for (const report of reports) {
              if (report.provider !== character.provider) continue;
              providerObserved = true;
              if (report.disabled !== true) {
                providerEnabled = true;
                break;
              }
            }
          }
          // 사용량 report가 사라진 로그아웃도 인증 API의 명시적인 미연결 상태로 구분한다.
          // web6는 `auth: none`이라 credential 연결 여부를 적용하지 않는다.
          const unavailable = character.provider !== "web6"
            && (providerConnections?.get(character.provider) === false || (providerObserved && !providerEnabled));
          return (
            <article
              key={character.alias}
              className={classNames("character-roster-item", unavailable && "is-unavailable")}
              role="listitem"
              aria-labelledby={headingId}
              aria-describedby={unavailable ? statusId : undefined}
            >
              <div className="character-roster-identity">
                <AccountAvatar seed={character.seed} size={48} provider={character.provider} />
                <div>
                  <h3 id={headingId}>{character.alias}</h3>
                  {unavailable ? (
                    <span id={statusId} className="character-roster-availability">연결 안 됨</span>
                  ) : null}
                  <p>{character.voice}</p>
                </div>
              </div>
              <dl className="character-roster-model">
                <div>
                  <dt>모델</dt>
                  <dd title={model}>{model}</dd>
                </div>
                {character.oauthPosition !== undefined ? (
                  <div>
                    <dt>계정</dt>
                    <dd>OAuth {character.oauthPosition}</dd>
                  </div>
                ) : null}
              </dl>
              <dl className="character-roster-examples">
                <div>
                  <dt>호출</dt>
                  <dd>
                    <code>{character.summonExample}</code>
                    <span>{character.summonNote ?? "SubAgent로 이 대화에 부릅니다."}</span>
                  </dd>
                </div>
                <div>
                  <dt>Main 교체</dt>
                  <dd>
                    {character.switchExample ? <code>{character.switchExample}</code> : <strong>교체 불가</strong>}
                    <span>{character.switchNote ?? "이 대화의 Main을 바꿉니다."}</span>
                  </dd>
                </div>
              </dl>
            </article>
          );
        })}
      </div>
    </>
  );
}

export function ResourcePanel({
  open,
  sessionId,
  activeTab,
  onTabChange,
  usage,
  className,
}: ResourcePanelProps) {
  const headingId = useId();
  const usageState = usage.state;
  const usageLoading = usage.loading;
  const [modelsState, setModelsState] = useState<PanelState<ModelStatsSnapshot>>({ status: "idle", data: null, error: null });
  const [accountState, setAccountState] = useState<SessionAccountState | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [providerConnections, setProviderConnections] = useState<ReadonlyMap<string, boolean> | null>(null);
  const [pendingActions, setPendingActions] = useState<Map<number, CredentialActionKind>>(() => new Map());
  const [feedbackByCredential, setFeedbackByCredential] = useState<Map<number, CredentialFeedback>>(() => new Map());
  const modelsStateRef = useRef(modelsState);
  const accountPollerRef = useRef<SessionAccountPoller | null>(null);
  const modelsControllerRef = useRef<AbortController | null>(null);
  const credentialControllersRef = useRef<Set<AbortController>>(new Set());
  const pendingCredentialIdsRef = useRef<Set<number>>(new Set());

  modelsStateRef.current = modelsState;

  useEffect(() => {
    if (!open || activeTab !== "characters") return;
    const controller = new AbortController();
    setProviderConnections(null);
    void Promise.all([
      fetch("/api/auth/all-providers", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ providers: ApiKeyProviderListing[] }>;
      }),
      fetch("/api/auth/providers", { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ providers: OAuthProviderListing[] }>;
      }),
    ]).then(([apiKeys, oauth]) => {
      if (controller.signal.aborted) return;
      const connected = new Map(apiKeys.providers.map((provider) => [provider.id, provider.configured]));
      for (const provider of oauth.providers) {
        connected.set(provider.id, connected.get(provider.id) === true || provider.loggedIn);
      }
      setProviderConnections(connected);
    }).catch(() => {
      if (!controller.signal.aborted) setProviderConnections(null);
    });
    return () => controller.abort();
  }, [activeTab, open, usageState.data]);

  useEffect(() => {
    setAccountState(null);
    if (!open || activeTab !== "usage" || !sessionId) return;
    const poller = createSessionAccountPoller({
      onClear() {
        setAccountState(null);
      },
      onResult(result) {
        setAccountState(result.status === "fresh" ? result.data : null);
      },
    });
    accountPollerRef.current = poller;
    poller.setSessionId(sessionId);
    return () => {
      poller.stop();
      if (accountPollerRef.current === poller) accountPollerRef.current = null;
    };
  }, [activeTab, open, sessionId]);

  const requestModels = useCallback(async (refresh: boolean) => {
    modelsControllerRef.current?.abort();
    const controller = new AbortController();
    modelsControllerRef.current = controller;
    setModelsLoading(true);
    const result = await loadModelStats({
      refresh,
      previous: modelsStateRef.current.data,
      signal: controller.signal,
    });
    if (modelsControllerRef.current !== controller || controller.signal.aborted) return;
    setModelsState(result);
    setModelsLoading(false);
  }, []);

  useEffect(() => {
    if (open && activeTab === "models" && (modelsStateRef.current.status === "idle" || modelsStateRef.current.status === "error")) {
      void requestModels(false);
    }
  }, [activeTab, open, requestModels]);

  useEffect(() => () => {
    modelsControllerRef.current?.abort();
    for (const controller of credentialControllersRef.current) controller.abort();
  }, []);

  const refreshActiveTab = useCallback(() => {
    if (activeTab === "models") void requestModels(true);
    else void usage.refresh();
  }, [activeTab, requestModels, usage]);

  const reloadUsage = useCallback(() => usage.refresh(), [usage]);

  const toggleCredential = useCallback(async (report: UsageReport) => {
    if (!Number.isSafeInteger(report.credentialId) || (report.credentialId as number) <= 0) return;
    const credentialId = report.credentialId as number;
    const release = acquireCredentialAction(pendingCredentialIdsRef.current, credentialId);
    if (!release) return;
    const controller = new AbortController();
    credentialControllersRef.current.add(controller);
    usage.setPaused(true);
    setPendingActions((current) => new Map(current).set(credentialId, "toggle"));
    setFeedbackByCredential((current) => {
      const next = new Map(current);
      next.delete(credentialId);
      return next;
    });
    try {
      await setCredentialEnabled(credentialId, report.disabled === true, { signal: controller.signal });
      const refreshed = await reloadUsage();
      if (!controller.signal.aborted) {
        setFeedbackByCredential((current) => new Map(current).set(credentialId, {
          tone: "status",
          message: refreshed.status === "fresh"
            ? `계정을 ${report.disabled ? "켰습니다" : "껐습니다"}.`
            : "계정 설정 저장됨 · 표시 상태 새로고침 실패.",
        }));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const uncertain = error instanceof ResourceClientError
          && (error.kind === "timeout" || error.outcomeUnknown);
        setFeedbackByCredential((current) => new Map(current).set(credentialId, uncertain
          ? { tone: "error", message: "적용 여부 확인 필요 — 새로고침으로 계정 상태를 확인하세요." }
          : { tone: "error", message: `계정 전환 실패: ${error instanceof Error ? error.message : String(error)}` }));
      }
    } finally {
      credentialControllersRef.current.delete(controller);
      release();
      usage.setPaused(pendingCredentialIdsRef.current.size > 0);
      setPendingActions((current) => {
        const next = new Map(current);
        next.delete(credentialId);
        return next;
      });
    }
  }, [reloadUsage, usage]);

  const resetCredential = useCallback(async (report: UsageReport, creditId: string) => {
    if (!Number.isSafeInteger(report.credentialId) || (report.credentialId as number) <= 0) return;
    const credentialId = report.credentialId as number;
    const release = acquireCredentialAction(pendingCredentialIdsRef.current, credentialId);
    if (!release) return;
    const controller = new AbortController();
    credentialControllersRef.current.add(controller);
    usage.setPaused(true);
    setPendingActions((current) => new Map(current).set(credentialId, "reset"));
    setFeedbackByCredential((current) => {
      const next = new Map(current);
      next.delete(credentialId);
      return next;
    });
    try {
      const result = await redeemCredentialReset(credentialId, creditId, { signal: controller.signal });
      const feedback = resetFeedback(result);
      const refreshed = await reloadUsage();
      if (result.ok) {
        const updatedReport = refreshed.status === "fresh"
          ? refreshed.data.reports.find((item) => item.credentialId === credentialId)
          : undefined;
        const remaining = updatedReport?.savedReset?.availableCount;
        feedback.message = typeof remaining === "number"
          ? `리셋 사용함 · 남은 리셋 ${remaining}개`
          : "리셋 사용함 · 남은 개수를 확인하지 못했습니다.";
      }
      if (!controller.signal.aborted) {
        setFeedbackByCredential((current) => new Map(current).set(credentialId, feedback));
      }
    } catch (error) {
      const outcomeNeedsReadback = error instanceof ResourceClientError
        && (error.outcomeUnknown || error.kind === "timeout");
      if (outcomeNeedsReadback && !controller.signal.aborted) {
        await reloadUsage();
      }
      if (!controller.signal.aborted) {
        setFeedbackByCredential((current) => new Map(current).set(credentialId, resetErrorFeedback(error)));
      }
    } finally {
      credentialControllersRef.current.delete(controller);
      release();
      usage.setPaused(pendingCredentialIdsRef.current.size > 0);
      setPendingActions((current) => {
        const next = new Map(current);
        next.delete(credentialId);
        return next;
      });
    }
  }, [reloadUsage, usage]);

  if (!open) return null;

  const generatedAt = activeTab === "models" ? modelsState.data?.generatedAt : usageState.data?.generatedAt;
  const range = activeTab === "models" ? modelsState.data?.range : undefined;
  const timestampLabel = range?.from && range.to
    ? `${dayLabel(range.from)}~${dayLabel(range.to)}`
    : generatedAt ? new Date(generatedAt).toLocaleTimeString() : "";
  const busy = activeTab === "models" ? modelsLoading : activeTab === "usage" && usageLoading;
  const refreshLabel = busy ? (activeTab === "models" ? "집계 중…" : "불러오는 중…") : "새로고침";

  return (
    <section
      className={classNames(
        "resource-panel flex min-h-0 w-full flex-col overflow-hidden bg-bg-panel text-text",
        className,
      )}
      aria-labelledby={headingId}
      aria-busy={busy}
    >
      <h1 id={headingId} className="sr-only">캐릭터</h1>
      <Tabs.Root
        className="resource-view-tabs"
        size="small"
        contentLayout="fill"
        triggerLayout="fill"
        value={activeTab}
        onValueChange={(value) => onTabChange(value as ResourceTab)}
      >
        <Tabs.List aria-label="캐릭터와 사용량 보기">
          <Tabs.Trigger value="characters">캐릭터</Tabs.Trigger>
          <Tabs.Trigger value="usage">계정 한도</Tabs.Trigger>
          <Tabs.Trigger value="models">모델 통계</Tabs.Trigger>
          <Tabs.Indicator />
        </Tabs.List>
        <Tabs.Content value="characters" className="resource-view-content">
          <CharacterRosterView reports={usageState.data?.reports} providerConnections={providerConnections} />
        </Tabs.Content>
        <Tabs.Content value="usage" className="resource-view-content">
          <div className="resource-usage-toolbar">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-text-dim">{timestampLabel}</span>
            <ActionButton variant="neutralWeak" size="xsmall" onClick={refreshActiveTab} disabled={busy}>
              {refreshLabel}
            </ActionButton>
          </div>
          <h2 className="resource-group-heading">계정 한도</h2>
          <UsageView
            state={usageState}
            loading={usageLoading}
            accountState={accountState?.sessionId === sessionId ? accountState : null}
            pendingActions={pendingActions}
            feedbackByCredential={feedbackByCredential}
            onToggle={(report) => { void toggleCredential(report); }}
            onReset={resetCredential}
          />
        </Tabs.Content>
        <Tabs.Content value="models" className="resource-view-content">
          <div className="resource-usage-toolbar">
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] tabular-nums text-text-dim">{timestampLabel}</span>
            <ActionButton variant="neutralWeak" size="xsmall" onClick={refreshActiveTab} disabled={busy}>
              {refreshLabel}
            </ActionButton>
          </div>
          <ModelsView state={modelsState} loading={modelsLoading} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
