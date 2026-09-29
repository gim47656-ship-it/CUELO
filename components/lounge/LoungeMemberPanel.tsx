"use client";

import { useState } from "react";
import { Switch } from "@seed-design/react";
import type { LoungeController } from "@/hooks/useLounge";
import type { UsageSnapshotController } from "@/hooks/useUsageSnapshot";
import { useNow } from "@/hooks/useNow";
import { formatRelativeTime } from "@/lib/i18n/format";
import { providerDisplayName } from "@/lib/hanse-resource-client";
import {
  LOUNGE_SLEEP_MINUTES_MAX,
  LOUNGE_SLEEP_MINUTES_MIN,
  type LoungeMember,
  type LoungePace,
} from "@/lib/lounge/types";
import { AccountAvatar } from "../workspace/AccountAvatar";
import { loungeMemberName, useLoungeText, type LoungeTranslate } from "./i18n";
import type { Locale } from "@/lib/i18n/types";
import { memberUsage, type MemberUsageRow } from "./member-usage";

/**
 * 사이드바 「단톡방」 보기. 세션 목록이 쓰던 세로 공간을 위에서부터 멤버 목록이 차지한다 —
 * 맨 위 방 ON/OFF, 멤버마다 얼굴·이름·provider·실제 상태·참여 스위치·주간 사용량, 아래 방 설정.
 *
 * 상태와 설정 값은 모두 서버 snapshot에서 온다. 스위치를 눌러도 화면을 먼저 바꾸지 않고 서버가
 * 돌려준 값으로만 바뀐다. 사용량은 앱의 단일 사용량 구독을 그대로 읽어 새 폴링을 만들지 않는다.
 */

const PACES: readonly LoungePace[] = ["slow", "normal", "active"];
const SLEEP_OPTIONS = [5, 10, 20, 30, 60, 120].filter(
  (minutes) => minutes >= LOUNGE_SLEEP_MINUTES_MIN && minutes <= LOUNGE_SLEEP_MINUTES_MAX,
);
/** 자동 차단 해제·잠들기 예정 시각을 판정할 시계. 사용량 폴링(60초)보다 촘촘하다. */
const NOW_TICK_MS = 10_000;

export interface LoungeMemberPanelProps {
  lounge: LoungeController;
  usage: UsageSnapshotController;
  /** 가운데 대화 화면을 연다. 없으면 여는 버튼을 그리지 않는다. */
  onOpenLounge?: () => void;
  /** 대화 화면이 이미 열려 있는지. 여는 버튼을 눌린 상태로 그린다. */
  loungeOpen?: boolean;
}

function formatWindow(ms: number, lt: LoungeTranslate, locale: string): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 1) {
    return new Intl.NumberFormat(locale, { style: "unit", unit: "hour", unitDisplay: "long" }).format(hours);
  }
  return lt("lounge.sleepMinutes", { minutes: Math.max(1, Math.round(ms / 60_000)) });
}

/**
 * 사용량 한 줄. 계정 전체 창(주간 등)은 막대로, 티어 전용 창과 접힌 짧은 창의 경고는 막대 없는
 * 한 줄로 그린다 — 멤버마다 막대가 두세 개씩 쌓이면 목록이 길어지고 무엇이 중요한지 흐려진다.
 */
function UsageBar({ row, lt, locale, now, compact }: {
  row: MemberUsageRow;
  lt: LoungeTranslate;
  locale: Locale;
  now: number;
  compact?: boolean;
}) {
  // 계정 전체 주간 창은 「주간」, 티어·모델 전용 주간 창은 그 티어 이름을 붙여 둘을 가른다.
  const label = row.kind !== "weekly"
    ? row.label
    : row.tier ? lt("lounge.usage.weeklyTier", { tier: row.tier }) : lt("lounge.usage.weekly");
  const stateLabel = row.state === "blocked"
    ? lt("lounge.usage.blocked")
    : row.state === "spent" ? lt("lounge.usage.spent") : null;
  const reset = !compact && row.resetsAt !== null && row.resetsAt > now
    ? lt("lounge.usage.resets", { when: formatRelativeTime(new Date(row.resetsAt), locale, new Date(now)) })
    : null;
  const danger = row.state !== "usable";
  return (
    <span className="lounge-usage" data-compact={compact ? "true" : undefined} data-state={row.state}>
      <span className="lounge-usage-head">
        <span className="lounge-usage-label">{label}</span>
        {reset ? <span className="lounge-usage-reset">{reset}</span> : null}
        {stateLabel ? <span className="lounge-usage-state">{stateLabel}</span> : null}
        <span className="lounge-usage-value">{row.percent}%</span>
      </span>
      {compact ? null : (
        <span aria-hidden="true" className="lounge-usage-track">
          <span
            className="lounge-usage-fill"
            style={{
              width: `${Math.max(0, Math.min(100, row.percent))}%`,
              background: danger ? "var(--danger)" : "var(--metric)",
            }}
          />
        </span>
      )}
    </span>
  );
}

function MemberRow({ member, lounge, usage, now, disabled }: {
  member: LoungeMember;
  lounge: LoungeController;
  usage: UsageSnapshotController;
  now: number;
  disabled: boolean;
}) {
  const { lt, locale } = useLoungeText();
  const name = loungeMemberName(member.alias, locale);
  const reports = usage.state.data?.reports ?? [];
  // 백엔드가 주간 값을 확실히 알 때만 싣는다. 없으면 사용량 스냅샷에서 같은 계정을 찾는다.
  const matched = memberUsage(reports, member, now);
  const primary: MemberUsageRow[] = member.weeklyUsage
    ? [{
      key: `${member.id}:weekly`,
      label: lt("lounge.usage.weekly"),
      kind: "weekly",
      tier: null,
      percent: Math.round(member.weeklyUsage.usedFraction * 100),
      resetsAt: member.weeklyUsage.resetsAt ?? null,
      state: member.weeklyUsage.usedFraction >= 1 ? "spent" : "usable",
    }]
    : matched.primary;
  const usageLoading = usage.state.data === null && usage.loading;
  const stateLabel = lt(`lounge.state.${member.state}`);
  const statusId = `lounge-member-${member.id}-status`;
  const participants = lounge.snapshot?.room.participants ?? [];
  // 단톡방 전용 계정. 자동으로 첫 계정을 고르지 않는다. 아직 안 정해졌거나 고정된 계정이 목록에서
  // 사라졌으면 고르는 칸을 바로 보여 주고, 정상 연결이면 「계정 설정」을 눌렀을 때만 편다.
  const account = member.account;
  const boundId = account?.credentialId;
  const boundMissing = boundId !== undefined && !account?.choices.some((choice) => choice.credentialId === boundId);
  const needsPick = account !== undefined && (account.selectionRequired || boundId === undefined || boundMissing);
  const canChange = account !== undefined && account.choices.length > 1;
  const [pickerOpen, setPickerOpen] = useState(false);
  const showPicker = account !== undefined && (needsPick || (canChange && pickerOpen));
  const pickerId = `lounge-member-${member.id}-account`;
  // 막대: 계정 전체 창. 한 줄: 티어 전용 창과 평소 접힌 짧은 창의 경고.
  const bars = primary.filter((row) => row.tier === null);
  const lines = [...primary.filter((row) => row.tier !== null), ...matched.warnings];

  return (
    <li className="lounge-member" data-state={member.state} data-enabled={member.enabled ? "true" : "false"}>
      <span className="lounge-member-face">
        <AccountAvatar seed={member.seed} size={40} provider={member.provider} />
        <span className="lounge-member-dot" aria-hidden="true" />
      </span>
      <span className="lounge-member-body">
        <span className="lounge-member-head">
          <span className="lounge-member-title">
            <span className="lounge-member-name">{name}</span>
            <span id={statusId} className="lounge-member-state">{stateLabel}</span>
          </span>
          <Switch.Root
            size="16"
            tone="neutral"
            className="lounge-switch"
            checked={member.enabled}
            disabled={disabled}
            onCheckedChange={(checked) => {
              const next = checked
                ? [...participants.filter((id) => id !== member.id), member.id]
                : participants.filter((id) => id !== member.id);
              void lounge.updateSettings({ participants: next });
            }}
          >
            <Switch.HiddenInput aria-label={lt("lounge.participate", { name })} aria-describedby={statusId} />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Root>
        </span>
        {member.reason ? <span className="lounge-member-reason">{member.reason}</span> : null}
        {bars.length + lines.length > 0 ? (
          <span className="lounge-member-usage">
            {bars.map((row) => (
              <UsageBar key={row.key} row={row} lt={lt} locale={locale} now={now} />
            ))}
            {lines.map((row) => (
              <UsageBar key={row.key} row={row} lt={lt} locale={locale} now={now} compact />
            ))}
          </span>
        ) : (
          <span className="lounge-member-usage-empty">
            {usageLoading
              ? lt("lounge.usage.loading")
              : matched.selectionRequired ? lt("lounge.account.required") : lt("lounge.usage.none")}
          </span>
        )}
        <span className="lounge-member-meta">
          <span className="lounge-member-model">{providerDisplayName(member.provider)} · {member.model}</span>
          {canChange && !needsPick ? (
            <button
              type="button"
              className="lounge-member-account-toggle"
              aria-expanded={pickerOpen}
              aria-controls={pickerId}
              onClick={() => setPickerOpen((open) => !open)}
            >
              {lt("lounge.account.change")}
            </button>
          ) : null}
        </span>
        {showPicker && account ? (
          <span className="lounge-member-account">
            <label className="sr-only" htmlFor={pickerId}>{lt("lounge.account.for", { name })}</label>
            <select
              id={pickerId}
              className="lounge-select"
              value={boundId === undefined ? "" : String(boundId)}
              disabled={disabled || account.choices.length === 0}
              aria-describedby="lounge-account-hint"
              onChange={(event) => {
                const credentialId = Number(event.target.value);
                if (Number.isInteger(credentialId)) {
                  void lounge.updateSettings({ accountBindings: { [member.id]: credentialId } });
                  setPickerOpen(false);
                }
              }}
            >
              {boundId === undefined ? <option value="" disabled>{lt("lounge.account.choose")}</option> : null}
              {boundMissing ? (
                <option value={String(boundId)} disabled>{lt("lounge.account.missing", { id: boundId })}</option>
              ) : null}
              {account.choices.map((choice) => (
                <option key={choice.credentialId} value={String(choice.credentialId)}>{choice.label}</option>
              ))}
            </select>
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function LoungeMemberPanel({ lounge, usage, onOpenLounge, loungeOpen = false }: LoungeMemberPanelProps) {
  const { lt, locale } = useLoungeText();
  const now = useNow(NOW_TICK_MS);
  const snapshot = lounge.snapshot;
  const room = snapshot?.room ?? null;
  const members = snapshot?.members ?? [];
  const storeError = snapshot?.loadError ?? null;
  const busy = lounge.pending.has("settings");
  const locked = snapshot === null || storeError !== null;
  const activeCount = members.filter((member) => member.enabled).length;
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const sleepOptions = room && !SLEEP_OPTIONS.includes(room.sleepAfterMinutes)
    ? [...SLEEP_OPTIONS, room.sleepAfterMinutes].sort((a, b) => a - b)
    : SLEEP_OPTIONS;
  const run = snapshot?.run ?? null;

  return (
    <div id="navigator-lounge-panel" className="lounge-panel">
      <div className="lounge-panel-room">
        <div className="lounge-panel-room-head">
          <span className="lounge-panel-title">{lt("lounge.title")}</span>
          <Switch.Root
            size="24"
            tone="neutral"
            className="lounge-switch lounge-room-switch"
            checked={room?.enabled ?? false}
            disabled={locked || busy}
            onCheckedChange={(checked) => { void lounge.updateSettings({ enabled: checked }); }}
          >
            <Switch.Label className="lounge-room-switch-label">
              {room?.enabled ? lt("lounge.roomOn") : lt("lounge.roomOff")}
            </Switch.Label>
            <Switch.HiddenInput aria-label={lt("lounge.roomSwitch")} />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Root>
        </div>
        {snapshot === null ? (
          <p className="lounge-panel-note" role={lounge.loadError ? "alert" : "status"}>
            {lounge.loadError ? lt("lounge.loadFailed", { error: lounge.loadError }) : lt("lounge.connecting")}
          </p>
        ) : storeError ? (
          <p className="lounge-panel-note" data-tone="danger" role="alert">
            {lt("lounge.loadFailed", { error: storeError })}
          </p>
        ) : room && !room.enabled ? (
          <p className="lounge-panel-note">{lt("lounge.roomOffHint")}</p>
        ) : room?.asleep ? (
          <p className="lounge-panel-note">{lt("lounge.asleep")}</p>
        ) : null}
        {lounge.connection === "reconnecting" && snapshot !== null ? (
          <p className="lounge-panel-note" role="status">{lt("lounge.reconnecting")}</p>
        ) : null}
        {lounge.actionError ? (
          <p className="lounge-panel-note" data-tone="danger" role="alert">
            {lt("lounge.actionFailed", { error: lounge.actionError })}
          </p>
        ) : null}
        {onOpenLounge ? (
          <button
            type="button"
            className="lounge-panel-open"
            aria-pressed={loungeOpen}
            onClick={onOpenLounge}
          >
            {lt("lounge.open")}
          </button>
        ) : null}
      </div>

      <div className="lounge-panel-members">
        <div className="lounge-panel-section-head">
          <span>{lt("lounge.members")}</span>
          {members.length > 0 ? (
            <span className="lounge-panel-count">
              {lt("lounge.membersCount", { active: activeCount, total: members.length })}
            </span>
          ) : null}
        </div>
        <ul className="lounge-member-list" aria-label={lt("lounge.members")}>
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              lounge={lounge}
              usage={usage}
              now={now}
              disabled={locked || busy}
            />
          ))}
        </ul>
        {/* 단톡방 계정이 무엇인지는 멤버마다 되풀이하지 않고 여기서 한 번만 말한다. */}
        {members.some((member) => member.account) ? (
          <p id="lounge-account-hint" className="lounge-panel-hint">{lt("lounge.account.hint")}</p>
        ) : null}
      </div>

      {room ? (
        <div className="lounge-panel-settings" role="group" aria-label={lt("lounge.settings")}>
          <div className="lounge-panel-section-head">
            <span>{lt("lounge.settings")}</span>
          </div>
          <div className="lounge-setting">
            <span className="lounge-setting-label" id="lounge-pace-label">{lt("lounge.pace")}</span>
            <div className="lounge-segmented" role="radiogroup" aria-labelledby="lounge-pace-label">
              {PACES.map((pace) => (
                <button
                  key={pace}
                  type="button"
                  role="radio"
                  aria-checked={room.pace === pace}
                  disabled={locked || busy}
                  onClick={() => {
                    if (room.pace !== pace) void lounge.updateSettings({ pace });
                  }}
                >
                  {lt(`lounge.pace.${pace}`)}
                </button>
              ))}
            </div>
          </div>
          <label className="lounge-setting lounge-setting-inline">
            <span className="lounge-setting-label">{lt("lounge.sleep")}</span>
            <select
              className="lounge-select"
              value={room.sleepAfterMinutes}
              disabled={locked || busy}
              onChange={(event) => {
                void lounge.updateSettings({ sleepAfterMinutes: Number(event.target.value) });
              }}
            >
              {sleepOptions.map((minutes) => (
                <option key={minutes} value={minutes}>{lt("lounge.sleepMinutes", { minutes })}</option>
              ))}
            </select>
          </label>
          <div className="lounge-setting">
            <Switch.Root
              size="16"
              tone="neutral"
              className="lounge-switch lounge-setting-switch"
              checked={room.autoTalk}
              disabled={locked || busy}
              onCheckedChange={(checked) => { void lounge.updateSettings({ autoTalk: checked }); }}
            >
              <Switch.Label className="lounge-setting-label">{lt("lounge.autoTalk")}</Switch.Label>
              <Switch.HiddenInput aria-describedby="lounge-autotalk-hint" />
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch.Root>
            <span id="lounge-autotalk-hint" className="lounge-setting-hint">{lt("lounge.autoTalkHint")}</span>
            {room.autoTalk && room.autoTalkPausedReason ? (
              <span className="lounge-setting-hint" data-tone="warning" role="status">{room.autoTalkPausedReason}</span>
            ) : null}
          </div>
          <div className="lounge-panel-limits">
            {run ? (
              <span>
                {lt("lounge.calls", {
                  window: formatWindow(run.calls.windowMs, lt, locale),
                  used: run.calls.used,
                  limit: run.calls.limit,
                })}
              </span>
            ) : null}
            {run ? <span>{lt("lounge.perTurn", { limit: run.perTurnLimit })}</span> : null}
            {room.enabled && !room.asleep && room.sleepAt !== null && room.sleepAt > now ? (
              <span>{lt("lounge.sleepAt", { time: timeFormat.format(new Date(room.sleepAt)) })}</span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
