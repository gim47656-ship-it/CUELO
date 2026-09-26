import { resolveUsedFraction, type UsageReport } from "@oh-my-pi/pi-ai";
import {
  planCodexResetRedemptions,
  REPORT_FRESHNESS_MS,
  WINDOW_EXHAUSTED_MIN_FRACTION,
} from "@oh-my-pi/pi-coding-agent/session/codex-auto-reset";
import { cfgCodexResets } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { AgentSessionLike } from "./omp-types";
import { RESOURCE_ORIGIN } from "./sidecar-proxy";

const ANTHROPIC_RESET_SCOPE_LABELS: Record<string, string> = {
  "anthropic:5h": "5시간",
  "anthropic:7d": "주간",
  "anthropic:7d:opus": "주간",
  "anthropic:7d:sonnet": "주간",
};

export interface ResetRecommendation {
  credentialId: number;
  reason: "blocked-account" | "expiring-credit";
  naturalResetAt?: number;
  expiresAt?: string;
  usedFraction?: number;
  window?: "5h" | "weekly";
  scope?: string;
}

export interface SessionAccountState {
  sessionId: string;
  observedAt: number;
  state: "resolved" | "unresolved" | "not-running" | "unsupported";
  provider?: string;
  modelId?: string;
  credentialId?: number;
  source?: "session-pin";
  resetRecommendations: ResetRecommendation[];
}

type AccountSession = Pick<AgentSessionLike,
  "model" | "modelRegistry" | "settings" | "listCurrentProviderOAuthAccounts">;
type AccountReport = UsageReport & {
  credentialId?: number;
  disabled?: boolean;
  savedReset?: {
    state: "available" | "empty" | "unavailable";
    availableCount: number | null;
    redeemableCount?: number;
    nextCreditId?: string;
    eligible?: boolean;
    credits: Array<{
      id: string;
      expiresAt: string | null;
      usable?: boolean;
      remainingCount?: number;
      clears?: string[];
      blocking?: string[];
      usedFractions?: Record<string, number>;
    }>;
  };
};
type UsageSnapshot = { brokerOk?: boolean; reports: AccountReport[] };

async function loadUsage(): Promise<UsageSnapshot> {
  const response = await fetch(`${RESOURCE_ORIGIN}/usage`, {
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("usage_unavailable");
  return response.json();
}

// 판정은 코어 pure planner에 맡긴다. blocked trigger의 sibling 경계만 caller가 증명한다.
export async function getSessionAccountState(
  sessionId: string,
  session: AccountSession | undefined,
  readUsage: () => Promise<UsageSnapshot> = loadUsage,
  nowMs = Date.now(),
): Promise<SessionAccountState> {
  const result: SessionAccountState = {
    sessionId, observedAt: nowMs, state: "not-running", resetRecommendations: [],
  };
  if (!session) return result;
  const model = session.model;
  result.provider = model?.provider;
  result.modelId = model?.id;
  result.state = "unsupported";
  if (!model || !session.listCurrentProviderOAuthAccounts) return result;

  let listing;
  try { listing = await session.listCurrentProviderOAuthAccounts(); } catch {
    result.state = "unresolved";
    return result;
  }
  if (!listing || listing.provider !== model.provider || listing.accounts.length === 0) return result;
  const active = listing.accounts.filter(account => account.active === true);
  result.state = "unresolved";
  if (active.length === 1 && Number.isSafeInteger(active[0].credentialId) && active[0].credentialId > 0) {
    result.state = "resolved";
    result.credentialId = active[0].credentialId;
    result.source = "session-pin";
  }

  try {
    const usage = await readUsage();
    const reports = (usage.brokerOk ? usage.reports : []).filter(report => report.provider === "openai-codex"
      && Number.isSafeInteger(report.credentialId) && report.disabled === false
      && Number.isFinite(report.fetchedAt) && nowMs - report.fetchedAt <= REPORT_FRESHNESS_MS
      && report.savedReset?.state === "available" && report.savedReset.availableCount !== null);
    const current = reports.find(report => report.credentialId === result.credentialId);
    const anthropicReports = (usage.brokerOk ? usage.reports : []).filter(report => report.provider === "anthropic"
      && Number.isSafeInteger(report.credentialId) && report.disabled === false
      && Number.isFinite(report.fetchedAt) && nowMs - report.fetchedAt <= REPORT_FRESHNESS_MS
      && report.savedReset?.state === "available" && report.savedReset.availableCount !== null);
    const anthropicCurrent = anthropicReports.find(report => report.credentialId === result.credentialId);
    let blocked = false;
    if (result.state === "resolved" && model.provider === "openai-codex" && !model.id.includes("-spark")
      && current?.metadata?.limitReached === true
      && current.limits.some(limit => (limit.id === "openai-codex:primary" || limit.id === "openai-codex:secondary")
        && (limit.amount.usedFraction ?? 0) >= WINDOW_EXHAUSTED_MIN_FRACTION)) {
      const health = await session.modelRegistry.authStorage?.health.model(model.provider, {
        modelId: model.id, sessionId, reserveFraction: 0,
        baseUrl: session.modelRegistry.getProviderBaseUrl?.(model.provider),
        signal: AbortSignal.timeout(10_000),
      });
      blocked = health?.state === "depleted" && health.accounts.length > 0
        && health.accounts.every(account => account.state === "depleted")
        && listing.accounts.every(account => health.accounts.some(value => value.credentialId === account.credentialId));
    }
    const cfg = cfgCodexResets.get(session.settings);
    const plan = planCodexResetRedemptions({
      nowMs, trigger: blocked ? "blocked" : "sweep", provider: model.provider, modelId: model.id,
      settings: {
        enabled: true, minBlockedMinutes: Math.max(0, cfg.minBlockedMinutes),
        keepCredits: Math.max(0, Math.trunc(cfg.keepCredits)),
        salvageHorizonMs: Math.max(0, cfg.salvageHorizonHours) * 3_600_000,
      },
      identity: active.length === 1 ? active[0] : undefined,
      // core planner는 metadata.resetCreditCredentialId로 계정을 식별한다. usage-server는 이 필드를
      // 내보내지 않으므로 이미 저장 계정과 매칭된 credentialId를 그대로 넘긴다.
      reports: reports.map(report => ({ ...report,
        metadata: { ...report.metadata, resetCreditCredentialId: report.credentialId },
        resetCredits: {
        availableCount: report.savedReset!.availableCount!,
        credits: report.savedReset!.credits.map(credit => ({
          status: "available", ...(credit.expiresAt ? { expiresAt: credit.expiresAt } : {}),
        })),
      } })),
      attemptedKeys: new Set(), deferredUntilByKey: new Map(), lastAttemptAtByAccount: new Map(),
    });
    for (const action of plan.actions) {
      // planner의 email/accountId target은 실행용으로 쓰지 않는다. 모호하면 권장도 숨긴다.
      const matches = reports.filter(report => {
        let compared = false;
        for (const key of ["accountId", "email"] as const) {
          if (!action.target[key] || !report.metadata?.[key]) continue;
          if (action.target[key] !== report.metadata[key]) return false;
          compared = true;
        }
        return compared;
      });
      if (matches.length !== 1) continue;
      result.resetRecommendations.push({
        credentialId: matches[0].credentialId!, reason: action.reason,
        ...(action.remainingMs !== undefined ? { naturalResetAt: nowMs + action.remainingMs } : {}),
        ...(action.expiresInMs !== undefined ? { expiresAt: new Date(nowMs + action.expiresInMs).toISOString() } : {}),
        ...(action.salvageUsedFraction !== undefined ? { usedFraction: action.salvageUsedFraction } : {}),
        ...(action.salvageWindow ? { window: action.salvageWindow } : {}),
      });
    }
    const saved = anthropicCurrent?.savedReset;
    const credit = saved?.credits.find(value => value.id === saved.nextCreditId && value.usable === true);
    if (result.state === "resolved" && model.provider === "anthropic" && anthropicCurrent && saved?.eligible === true
      && (saved.redeemableCount ?? 0) > 0 && credit && (credit.remainingCount ?? 0) > 0) {
      const exhausted = anthropicCurrent.limits.filter(limit => limit.status === "exhausted"
        || (resolveUsedFraction(limit) ?? 0) >= WINDOW_EXHAUSTED_MIN_FRACTION);
      const blockers = [...new Set([...exhausted.map(limit => limit.id), ...(credit.blocking ?? [])])];
      const clears = new Set(credit.clears ?? []);
      const blockedLimits = blockers.map(id => anthropicCurrent.limits.find(limit => limit.id === id));
      const scopes = [...new Set(blockers.map(id => ANTHROPIC_RESET_SCOPE_LABELS[id]))];
      const resetTimes = blockedLimits.map(limit => limit?.window?.resetsAt);
      const labels = scopes.filter((scope): scope is string => scope !== undefined);
      if (blockers.length > 0 && blockers.every(id => clears.has(id))
        && blockedLimits.every(limit => limit !== undefined)
        && labels.length === scopes.length
        && resetTimes.every((at): at is number => typeof at === "number" && Number.isFinite(at) && at > nowMs)) {
        const resetAt = resetTimes.reduce((latest, at) => Math.max(latest, at), nowMs);
        result.resetRecommendations.push({
          credentialId: anthropicCurrent.credentialId!,
          reason: "blocked-account",
          naturalResetAt: resetAt,
          ...(credit.expiresAt ? { expiresAt: credit.expiresAt } : {}),
          scope: `${labels.join("·")} 한도`,
          ...(labels.length === 1 ? { window: labels[0] === "5시간" ? "5h" as const : "weekly" as const } : {}),
        });
      }
    }
  } catch { /* 권장 조회 실패는 실제 pin 증거를 지우거나 추론을 중단하지 않는다 */ }

  // 느린 quota 조회 중 모델/pin이 바뀌었으면 과거 계정으로 badge를 만들지 않는다.
  try {
    const latest = await session.listCurrentProviderOAuthAccounts();
    const pins = latest?.accounts.filter(account => account.active === true) ?? [];
    if (session.model?.provider !== model.provider || session.model?.id !== model.id
      || latest?.provider !== model.provider || pins.length !== active.length
      || pins.some((pin, index) => pin.credentialId !== active[index]?.credentialId)) {
      return { sessionId, observedAt: Date.now(), state: "unresolved", resetRecommendations: [] };
    }
  } catch {
    return { sessionId, observedAt: Date.now(), state: "unresolved", resetRecommendations: [] };
  }
  result.observedAt = Date.now();
  return result;
}
