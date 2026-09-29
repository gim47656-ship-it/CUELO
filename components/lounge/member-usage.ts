import {
  accountIdentities,
  limitExhausted,
  type UsageLimit,
  type UsageReport,
} from "@/lib/hanse-resource-client";

/**
 * 단톡방 멤버 한 명이 쓰는 계정의 사용량을 기존 사용량 스냅샷에서 골라낸다. 새 조회를 만들지
 * 않는다. 짝은 단톡방에 고정된 계정(credentialId)으로 찾고, 계정 개념이 없는 멤버만 사용량
 * 패널과 같은 `accountIdentities` 별칭 배정으로 찾는다.
 *
 * 보고서가 준 값만 그린다: 주간(또는 더 긴) 창이 있으면 그 창을, 짧은 창만 보고하는 provider는
 * 그 창을 이름 그대로 보여 준다. 5시간처럼 짧은 창은 평소 접고, 그 창이 소진·브로커 경고·90%
 * 이상일 때만 경고 줄로 올린다. 차단 판단 자체는 코어가 하므로 여기서는 표시만 한다.
 */

const DAY_MS = 86_400_000;
const WEEKLY_MIN_MS = 6 * DAY_MS;
const SHORT_MAX_MS = 12 * 3_600_000;
/** 짧은 창을 경고로 올리는 사용률. 사이드바 사용량 줄이 빨간색으로 바꾸는 기준과 같다. */
export const USAGE_WARN_PERCENT = 90;

export type UsageWindowKind = "weekly" | "short" | "other";

export interface MemberUsageRow {
  key: string;
  label: string;
  kind: UsageWindowKind;
  /** 티어·모델 전용 창이면 그 이름. 계정 전체 창이면 null. */
  tier: string | null;
  percent: number;
  resetsAt: number | null;
  state: "usable" | "warning" | "spent" | "blocked";
}

export interface MemberUsage {
  /** 단톡방 계정이 아직 정해지지 않아 어느 보고서도 붙이지 않았다. */
  selectionRequired: boolean;
  /** 늘 보이는 막대: 주간, 또는 주간이 없을 때 실제 보고된 창. */
  primary: MemberUsageRow[];
  /** 평소 접어 두는 짧은 창 중 경고할 것만. */
  warnings: MemberUsageRow[];
}

function windowText(limit: UsageLimit): string {
  const scope = limit.scope?.windowId;
  return `${typeof scope === "string" ? scope : ""} ${limit.id} ${limit.label ?? ""}`.toLowerCase();
}

/** 창의 길이. 보고서의 `durationMs`를 먼저 믿고, 없을 때만 창 id·라벨의 표기로 가른다. */
export function usageWindowKind(limit: UsageLimit): UsageWindowKind {
  const duration = limit.window?.durationMs;
  if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
    if (duration >= WEEKLY_MIN_MS) return "weekly";
    if (duration <= SHORT_MAX_MS) return "short";
    return "other";
  }
  const text = windowText(limit);
  if (/(^|[^0-9])7d\b|week|7 day|주간/.test(text)) return "weekly";
  if (/(^|[^0-9])(5h|1h)\b|hour|시간/.test(text)) return "short";
  return "other";
}

function usedPercent(limit: UsageLimit): number | null {
  const fraction = limit.amount?.usedFraction;
  if (typeof fraction !== "number" || !Number.isFinite(fraction)) return null;
  return Math.round(fraction * 100);
}

/**
 * 평소 접어 두는 짧은 창을 그래도 보여야 하는지: 그 창 자체가 소진됐거나, 브로커가 경고를
 * 매겼거나, 90% 이상일 때. 계정 단위 차단은 늘 보이는 주간 막대가 이미 말하므로 여기 넣지 않는다.
 */
export function shortWindowAlert(limit: UsageLimit): boolean {
  const percent = usedPercent(limit);
  return limitExhausted(limit) || limit.status === "warning" || (percent !== null && percent >= USAGE_WARN_PERCENT);
}

/**
 * 멤버에게 단톡방 계정(`account`)이 있으면 그 credentialId의 보고서만 붙인다 — 같은 provider의
 * 다른 계정 막대를 대신 붙이지 않고, 계정이 정해지지 않았으면 아무것도 붙이지 않는다. 계정
 * 개념이 없는 멤버(API 키 방식)만 얼굴·별칭 배정으로 짝을 찾는다.
 */
export function memberUsage(
  reports: readonly UsageReport[],
  member: { provider: string; alias: string; account?: { credentialId?: number; selectionRequired: boolean } },
  now: number,
): MemberUsage {
  const account = member.account;
  const primary: MemberUsageRow[] = [];
  const warnings: MemberUsageRow[] = [];
  if (account && (account.selectionRequired || account.credentialId === undefined)) {
    return { selectionRequired: true, primary, warnings };
  }
  const identities = accountIdentities(reports);
  reports.forEach((report, index) => {
    if (report.provider !== member.provider) return;
    if (account ? report.credentialId !== account.credentialId : identities[index].alias !== member.alias) return;
    if (report.disabled === true) return;
    const blocked = typeof report.autoBlockedUntilMs === "number" && report.autoBlockedUntilMs > now;
    const rows = (report.limits ?? []).flatMap((limit) => {
      const percent = usedPercent(limit);
      if (percent === null) return [];
      const state: MemberUsageRow["state"] = blocked
        ? "blocked"
        : limitExhausted(limit)
          ? "spent"
          : limit.status === "warning" || percent >= USAGE_WARN_PERCENT ? "warning" : "usable";
      const resetsAt = limit.window?.resetsAt;
      const tier = limit.scope?.tier ?? limit.scope?.modelId;
      const row: MemberUsageRow = {
        key: `${report.provider}:${report.credentialId ?? index}:${limit.id}`,
        label: limit.label || limit.id,
        kind: usageWindowKind(limit),
        tier: typeof tier === "string" && tier ? tier : null,
        percent,
        resetsAt: typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : null,
        state,
      };
      return [{ row, alert: shortWindowAlert(limit) }];
    });
    const long = rows.filter(({ row }) => row.kind !== "short");
    if (long.length > 0) {
      primary.push(...long.map(({ row }) => row));
      warnings.push(...rows.filter(({ row, alert }) => row.kind === "short" && alert).map(({ row }) => row));
    } else {
      // 짧은 창만 보고하는 provider다. 있는 창을 그 이름 그대로 늘 보여 준다.
      primary.push(...rows.map(({ row }) => row));
    }
  });
  return { selectionRequired: false, primary, warnings };
}
