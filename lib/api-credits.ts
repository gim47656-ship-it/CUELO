/**
 * API 크레딧(Hive) 추정 응답의 모양과 화면용 계산.
 * 금액 계산은 사이드카(`Tools/CUELO_Setup/files/usage-server.js` /credits)가 하고, 여기서는 받은 값을 화면 값으로만 바꾼다.
 */

export type CreditPricing = "exact" | "upper-bound" | "unknown";

export interface HiveCreditSetting {
  totalUsd: number;
  startDate: string;
}

interface WalletTotals {
  spentUsd: number;
  /** false면 단가를 모르는 행이나 관측 안 된 날이 있다. 상한 단가 행이 없을 때만 사용액이 하한이다(`spentIsMinimum`). */
  spentComplete: boolean;
  totalUsd: number | null;
  remainingUsd: number | null;
  /** 잔액이 상한일 때만 true다. 상한 단가 행이 섞이면 하한·상한 어느 쪽도 성립하지 않아 false다. */
  remainingUpperBound: boolean;
  /** 상한 단가로 매긴 행이 있다(실제 사용액은 이보다 작을 수 있다). */
  upperBoundRows: boolean;
}

/** 표시된 사용액이 실제 사용액의 하한인가. 미상이 있어도 상한 단가 행이 섞이면 알려진 합계가 실제보다 클 수 있다. */
export function spentIsMinimum(wallet: Pick<WalletTotals, "spentComplete" | "upperBoundRows">): boolean {
  return !wallet.spentComplete && !wallet.upperBoundRows;
}

interface WalletBase extends WalletTotals {
  since: string;
  sinceSource: "start-date" | "default";
  status: "ok" | "error";
  error: string | null;
  observedAt: number;
  priceSources: string[];
}

export interface HiveUsageCounts {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
}

export interface HiveCreditRow extends HiveUsageCounts {
  model: string;
  pricing: CreditPricing;
  purposes: Array<HiveUsageCounts & { purpose: string }>;
}

export interface HiveCreditWallet extends WalletBase {
  wallet: "hive";
  scope: "this-pc";
  source: "session-logs";
  rows: HiveCreditRow[];
}

export type AnthropicCostCategory = "input" | "output" | "cacheRead" | "cacheWrite";

export interface AnthropicUsageCounts {
  /** 토큰이 기록된 응답 수. 토큰이 없는 거절·오류 응답은 빠진다. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 비용이 기록된 요청의 합. 하나도 없으면 null. */
  costUsd: number | null;
  /** 비용이 기록되지 않은(미상) 요청 수. 0보다 크면 costUsd는 하한이다. */
  unpricedRequests: number;
}

export interface AnthropicPaidRow extends AnthropicUsageCounts {
  model: string;
  /** 범주별 금액. 그 범주 값이 빠진 요청이 하나라도 있으면 null. */
  costs: Record<AnthropicCostCategory, number | null>;
  purposes: Array<AnthropicUsageCounts & { purpose: string }>;
}

/** core가 api-key로 나갔다고 기록한 Anthropic 요청만 모은 이 PC 기록. 잔액·청구서가 아니다. */
export interface AnthropicPaidWallet {
  wallet: "anthropic";
  scope: "this-pc";
  source: "session-logs";
  since: string;
  sinceSource: "default";
  status: "ok" | "error";
  error: string | null;
  observedAt: number;
  /** 기간 안에서 자격 종류가 처음 기록된 시각(ms). 그 뒤 빠짐없이 기록됐다는 보증은 아니다. 없으면 null. */
  coverageSince: number | null;
  oauthRequests: number;
  unattributedRequests: number;
  rows: AnthropicPaidRow[];
  /** 아는 금액의 합. 유료 요청이 있는데 아는 금액이 하나도 없으면 null(미상). */
  spentUsd: number | null;
  spentComplete: boolean;
}

export interface ApiCreditsSnapshot {
  generatedAt: number;
  settings: { hive: HiveCreditSetting | null };
  settingsError: string | null;
  priceCheckedAt: string;
  hive: HiveCreditWallet;
  /** 이 칸이 없는 옛 사이드카도 받는다. */
  anthropic?: AnthropicPaidWallet;
}

export type CreditSettingInput = { totalUsd: number; startDate: string };

export function isApiCreditsSnapshot(value: unknown): value is ApiCreditsSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ApiCreditsSnapshot>;
  return Boolean(record.settings && typeof record.settings === "object"
    && record.hive && Array.isArray(record.hive.rows)
    && (record.anthropic === undefined || Array.isArray(record.anthropic?.rows)));
}

export interface CreditMeter {
  /** 막대 길이(0~1). 총액을 모르면 null. */
  spentFraction: number | null;
  tone: "normal" | "warning" | "danger";
}

/** 남은 추정이 10% 아래면 경고, 다 썼으면 위험이다. */
export function creditMeter(wallet: Pick<WalletTotals, "spentUsd" | "totalUsd">): CreditMeter {
  if (wallet.totalUsd === null || wallet.totalUsd <= 0) return { spentFraction: null, tone: "normal" };
  const fraction = wallet.spentUsd / wallet.totalUsd;
  const tone = fraction >= 1 ? "danger" : fraction >= 0.9 ? "warning" : "normal";
  return { spentFraction: Math.max(0, Math.min(1, fraction)), tone };
}

/**
 * 입력 칸 문자열을 저장 요청 값으로 바꾼다. 형식 오류는 사이드카가 최종 판정하고, 여기서는 숫자로 못 읽는 총액만 막는다.
 * 쉼표와 `$`는 허용한다(`$1,000` → 1000).
 */
export function creditSettingFromForm(form: { totalUsd: string; startDate: string }): CreditSettingInput | null {
  const total = Number(form.totalUsd.replace(/[$,\s]/g, ""));
  if (!form.totalUsd.trim() || !Number.isFinite(total)) return null;
  return { totalUsd: total, startDate: form.startDate.trim() };
}
