// Shared quota observation and daily-share policy for routing and fresh CUELO sessions.
/** Main 재량용 계정 잔량 참고 정보. 후보 revision·Jev state에는 넣지 않는다. */
export interface QuotaLimit {
  id: string | null;
  usedFraction: number | null;
  resetsAt: number | null;
  /** 사이드카가 리셋 시각에서 24시간씩 거꾸로 센 오늘 구간. `usedPct`는 그 구간에서 쓴 양, `quotaPct`는 하루 몫(7d면 100/7%), `slotEnd`는 구간 끝 시각이다.
   * 구간 시작값이 없으면 `quality: "estimate"`이고 `usedPct`는 구간 첫 관측부터 센 최소량, `paceOver`는 창 누적 사용률이 오늘까지의 누적 몫 이상인지다. */
  daySlot: { usedPct: number | null; quotaPct: number | null; slotsLeft: number | null; quality: string | null; slotEnd?: number | null; paceOver?: boolean | null } | null;
  /** 사이드카 `scope.windowId`(없으면 `window.id`). 예: `5h`, `7d`. */
  windowId: string | null;
  /** 계정의 모든 모델이 함께 쓰는 공유 구간(`scope.shared`). 계열 전용 tier 구간은 false다. */
  shared: boolean;
}
export interface QuotaAccount {
  credentialId: number | null;
  disabled: boolean;
  autoBlockedUntilMs: number | null;
  limitReached: boolean | null;
  fetchedAt: number | null;
  limits: QuotaLimit[];
}
export type QuotaSnapshot =
  | { state: "observed"; observedAt: number; providers: Record<string, QuotaAccount[]> }
  | { state: "unavailable"; observedAt: number; reason: string };
// 잔량은 참고 정보다. 실측: 사이드카 `/usage` 웜 응답 1-3ms, 콜드 경로가 실행하는
// `omp usage --json` 0.25-1.3s(4회 실측 1249·246·750·295ms), 사이드카 자체 캐시 60s.
// 이 예산을 넘기면 배치를 더 붙잡지 않고 이번 호출만 unavailable로 두며,
// 다음 호출은 사이드카 캐시가 채워져 웜으로 답한다.
const QUOTA_ADVISORY_BUDGET_MS = 2_000;
const finiteOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** CUELO usage 사이드카의 `/usage`를 후보 provider만 남겨 요약한다. 실패는 unavailable로 두고 발주를 막지 않는다. */
export async function readSidecarQuota(providers: string[], signal?: AbortSignal): Promise<QuotaSnapshot> {
  const observedAt = Date.now();
  const port = Number(process.env.OMP_USAGE_PORT || 30142);
  const budget = AbortSignal.timeout(QUOTA_ADVISORY_BUDGET_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/usage`, {
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, budget]) : budget,
    });
    if (!response.ok) return { state: "unavailable", observedAt, reason: `usage sidecar HTTP ${response.status}` };
    const body = await response.json() as { brokerOk?: boolean; reports?: Record<string, unknown>[] };
    if (body.brokerOk === false) return { state: "unavailable", observedAt, reason: "usage sidecar brokerOk=false" };
    const wanted = new Set(providers);
    const byProvider: Record<string, QuotaAccount[]> = Object.fromEntries(providers.map((provider) => [provider, []]));
    for (const report of body.reports ?? []) {
      const provider = typeof report.provider === "string" ? report.provider : "";
      if (!wanted.has(provider)) continue;
      const metadata = (report.metadata ?? {}) as Record<string, unknown>;
      const limits = Array.isArray(report.limits) ? report.limits as Record<string, unknown>[] : [];
      byProvider[provider]!.push({
        credentialId: finiteOrNull(report.credentialId),
        disabled: report.disabled === true,
        autoBlockedUntilMs: finiteOrNull(report.autoBlockedUntilMs),
        limitReached: typeof metadata.limitReached === "boolean" ? metadata.limitReached : null,
        fetchedAt: finiteOrNull(report.fetchedAt),
        limits: limits.map((limit) => {
          const amount = (limit.amount ?? {}) as Record<string, unknown>;
          const window = (limit.window ?? {}) as Record<string, unknown>;
          const scope = (limit.scope ?? {}) as Record<string, unknown>;
          const daySlot = limit.daySlot as Record<string, unknown> | undefined;
          return {
            id: typeof limit.id === "string" ? limit.id : null,
            usedFraction: finiteOrNull(amount.usedFraction),
            resetsAt: finiteOrNull(window.resetsAt),
            daySlot: daySlot
              ? {
                usedPct: finiteOrNull(daySlot.usedPct),
                quotaPct: finiteOrNull(daySlot.quotaPct),
                slotsLeft: finiteOrNull(daySlot.slotsLeft),
                quality: typeof daySlot.quality === "string" ? daySlot.quality : null,
                slotEnd: finiteOrNull(daySlot.slotEnd),
                paceOver: typeof daySlot.paceOver === "boolean" ? daySlot.paceOver : null,
              }
              : null,
            windowId: typeof scope.windowId === "string" ? scope.windowId : typeof window.id === "string" ? window.id : null,
            shared: scope.shared === true,
          };
        }),
      });
    }
    return { state: "observed", observedAt, providers: byProvider };
  } catch (error) {
    return {
      state: "unavailable",
      observedAt,
      reason: budget.aborted
        ? `usage sidecar advisory budget 초과 (${QUOTA_ADVISORY_BUDGET_MS}ms)`
        : error instanceof Error ? error.message : String(error),
    };
  }
}
/** 계정의 1주 공유 구간(`7d`, shared) 가운데 관측 시각에 아직 리셋되지 않은 것. 계열 전용 구간과 이미 리셋된 구간은 뺀다. */
function liveWeeklyShared(account: QuotaAccount, observedAt: number) {
  return account.limits.filter((limit) => limit.windowId === "7d" && limit.shared
    && !(limit.resetsAt !== null && limit.resetsAt <= observedAt));
}

/** 계정의 1주 공유 구간이 관측상 찼다. */
function weeklySharedExhausted(account: QuotaAccount, observedAt: number) {
  return liveWeeklyShared(account, observedAt).some((limit) => limit.usedFraction !== null && limit.usedFraction >= 1);
}

/** 계정 사용 가능성은 core 신호(disabled·limitReached·autoBlockedUntil)와 관측된 1주 공유 구간 소진으로만 본다. */
export function accountUnusable(account: QuotaAccount, observedAt: number) {
  return account.disabled || account.limitReached === true
    || (account.autoBlockedUntilMs != null && account.autoBlockedUntilMs > observedAt)
    || weeklySharedExhausted(account, observedAt);
}

/** 하루 몫을 볼 1주 구간: 모든 모델이 함께 쓰는 공유 구간이나 Fable 전용 구간(`anthropic:7d:fable`). 공유 구간 소진은
 * 창과 관계없이 `accountUnusable`로 본다: core도 Fable 요청의 계정 차단에 공유 구간을 항상 넣는다
 * (`pi-ai` `usage/claude.ts` `scopeClaudeLimitsForModelHardBlock`). */
export type AnthropicWeeklyWindow = "shared" | "fable";

function liveWeekly(account: QuotaAccount, observedAt: number, window: AnthropicWeeklyWindow) {
  if (window === "shared") return liveWeeklyShared(account, observedAt);
  return account.limits.filter((limit) => limit.id === "anthropic:7d:fable"
    && !(limit.resetsAt !== null && limit.resetsAt <= observedAt));
}

/** Unknown/missing accounts never count as exhaustion. Match every enabled runtime credential when known. */
export function anthropicOverDaySlot(
  quota: QuotaSnapshot,
  enabledCredentialIds?: readonly number[],
  window: AnthropicWeeklyWindow = "shared",
): boolean {
  if (quota.state !== "observed") return false;
  const accounts = quota.providers.anthropic ?? [];
  const observedIds = new Set(accounts.map((account) => account.credentialId).filter((id): id is number => id !== null));
  if (enabledCredentialIds !== undefined) {
    if (enabledCredentialIds.length === 0 || !enabledCredentialIds.every((id) => observedIds.has(id))) return false;
  } else if (observedIds.size < 2) return false;
  return accounts.length > 0 && accounts.every((account) => accountUnusable(account, quota.observedAt)
    || liveWeekly(account, quota.observedAt, window).some((limit) => {
      const slot = limit.daySlot;
      if (slot === null || slot.quality === null || slot.quality === "unknown") return false;
      // 시작값이 없는 구간(estimate)은 최소량(A)이 하루 몫 이상이거나 주간 진도(B)가 넘었으면 초과다.
      if (slot.quality === "estimate" && slot.paceOver === true) return true;
      return typeof slot.usedPct === "number" && Number.isFinite(slot.usedPct)
        && typeof slot.quotaPct === "number" && Number.isFinite(slot.quotaPct)
        && slot.usedPct >= slot.quotaPct;
    }));
}

/** Only read credential row identities, never expose token material. */
export function enabledAnthropicCredentialIds(storage: {
  credentials?: { list(provider: string): { id: number; disabledCause: string | null }[] };
} | undefined): number[] | undefined {
  try {
    return storage?.credentials?.list("anthropic").filter((row) => !row.disabledCause).map((row) => row.id);
  } catch {
    return undefined;
  }
}
