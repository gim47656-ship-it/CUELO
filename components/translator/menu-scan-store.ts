/** 메뉴판 해설에서 내가 피하려는 것(알레르기·못 먹는 것). 이 기기 브라우저에만 저장한다. */
export const SCAN_AVOID_KEY = "cuelo-translator-scan-avoid";
export const SCAN_AVOID_MAX_CHARS = 200;

export function readAvoid(storage?: Pick<Storage, "getItem">): string {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const value = target?.getItem(SCAN_AVOID_KEY);
    return typeof value === "string" ? value.slice(0, SCAN_AVOID_MAX_CHARS) : "";
  } catch {
    return "";
  }
}

export function writeAvoid(value: string, storage?: Pick<Storage, "setItem" | "removeItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const clean = value.slice(0, SCAN_AVOID_MAX_CHARS);
    if (clean.trim()) target?.setItem(SCAN_AVOID_KEY, clean);
    else target?.removeItem(SCAN_AVOID_KEY);
  } catch {
    // Storage blocked or full: the field still works for this visit.
  }
}

export interface PricedRow {
  price?: number;
}

/**
 * 고른 줄의 값 합계. 가격이 없는 줄은 건너뛰고(`missing`으로 센다), 부동소수 오차는 소수 둘째 자리로 맞춘다.
 * 통화는 메뉴판 한 장이 하나라 호출하는 쪽이 붙인다.
 */
export function sumPrices(rows: readonly PricedRow[], picked: ReadonlySet<number>): { total: number; count: number; missing: number } {
  let cents = 0;
  let count = 0;
  let missing = 0;
  rows.forEach((row, index) => {
    if (!picked.has(index)) return;
    if (typeof row.price === "number" && Number.isFinite(row.price)) {
      cents += Math.round(row.price * 100);
      count += 1;
    } else {
      missing += 1;
    }
  });
  return { total: cents / 100, count, missing };
}

/** 합계를 보이는 글로. 통화 코드가 있으면 `Intl`로, 모르는 코드나 기호면 뒤에 붙인다. */
export function formatTotal(total: number, currency: string | undefined, locale: string): string {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(total);
  if (!currency) return number;
  if (/^[A-Za-z]{3}$/.test(currency)) {
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 2 }).format(total);
    } catch {
      // Unknown code: fall through to the plain form.
    }
  }
  return `${number} ${currency}`;
}
