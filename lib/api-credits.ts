/**
 * API 크레딧 응답의 모양과 화면용 계산.
 * 금액 계산은 사이드카(`Tools/CUELO_Setup/files/usage-server.js` /credits)가 하고, 여기서는 받은 값을 화면 값으로만 바꾼다.
 * 잔액(`balances`)은 공급자 결제 화면에서 보고 적어 둔 값과 그 확인 시각이다. 자동 조회가 아니다.
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

/** 이 PC가 선불 크레딧으로 쓰는 API. 사이드카가 이 중 지금 설정된 경로와 유료 사용 기록이 있는 것만 순서대로 보낸다. */
export type BalanceWallet = "hive" | "exa" | "typesafe" | "anthropic";

/** 결제 화면에서 확인해 적어 둔 잔액. observedAt은 결제 화면을 본 시각(ms)이고 저장한 시각이 아니다. */
export interface RecordedBalance {
  amountUsd: number;
  observedAt: number;
}

export interface WalletBalance {
  wallet: BalanceWallet;
  source: "dashboard-record";
  /** recent-paid-use: 사용 기간 안에 유료 사용 기록이 있다. unverified: 경로는 있지만 기록을 다 읽지 못해 확인하지 못했다. */
  evidence: "recent-paid-use" | "unverified";
  /** 이 PC 기록에서 본 마지막 유료 사용 시각(ms). 없으면 null. */
  lastPaidUseAt: number | null;
  /** 아직 적지 않았으면 null(잔액 미상). 0은 확인한 잔액 0이다. */
  recorded: RecordedBalance | null;
}

export interface ApiCreditsSnapshot {
  generatedAt: number;
  settings: { hive: HiveCreditSetting | null };
  settingsError: string | null;
  priceCheckedAt: string;
  hive: HiveCreditWallet;
  /** 이 칸이 없는 옛 사이드카도 받는다. */
  anthropic?: AnthropicPaidWallet;
  /** 이 칸이 없는 옛 사이드카도 받는다(그때는 Hive·Anthropic 카드만 보인다). */
  balances?: WalletBalance[];
  /** 설정 경로를 읽지 못하면 routes_unreadable이고 balances는 비어 있다. */
  balancesError?: string | null;
}

export type CreditSettingInput = { totalUsd: number; startDate: string };
export type BalanceInput = { amountUsd: number; observedAt: number };

export function isApiCreditsSnapshot(value: unknown): value is ApiCreditsSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ApiCreditsSnapshot>;
  return Boolean(record.settings && typeof record.settings === "object"
    && record.hive && Array.isArray(record.hive.rows)
    && (record.anthropic === undefined || Array.isArray(record.anthropic?.rows))
    && (record.balances === undefined || (Array.isArray(record.balances)
      && record.balances.every((item) => Boolean(item) && typeof item.wallet === "string"
        && (item.recorded === null || (typeof item.recorded === "object"
          && Number.isFinite(item.recorded?.amountUsd) && Number.isFinite(item.recorded?.observedAt)))))));
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

/**
 * 잔액 입력 칸을 저장 요청 값으로 바꾼다. 금액은 `$`·쉼표를 허용하고 0도 받는다. 시각은 `datetime-local` 값(이 PC의 현지 시각)이다.
 * 범위·미래 시각은 사이드카가 최종 판정한다.
 */
export function balanceFromForm(form: { amountUsd: string; observedAt: string }): { value: BalanceInput } | { error: "amount" | "observedAt" } {
  const amount = Number(form.amountUsd.replace(/[$,\s]/g, ""));
  if (!form.amountUsd.trim() || !Number.isFinite(amount)) return { error: "amount" };
  const observedAt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(form.observedAt.trim()) ? new Date(form.observedAt.trim()).getTime() : Number.NaN;
  if (!Number.isFinite(observedAt)) return { error: "observedAt" };
  return { value: { amountUsd: amount, observedAt } };
}

/** `datetime-local` 칸에 넣을 현지 시각 문자열(분 단위). */
export function localDateTimeInput(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
