import { describe, expect, test } from "bun:test";
import { SCAN_AVOID_KEY, formatTotal, readAvoid, sumPrices, writeAvoid } from "./menu-scan-store";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    map,
  };
}

describe("sumPrices", () => {
  test("sums only ticked rows and counts priced rows apart from unpriced ones", () => {
    const rows = [{ price: 1200 }, { price: 980 }, {}, { price: 350 }];
    expect(sumPrices(rows, new Set([0, 2, 3]))).toEqual({ total: 1550, count: 2, missing: 1 });
  });
  test("is zero for nothing ticked and ignores out-of-range indexes", () => {
    expect(sumPrices([{ price: 5 }], new Set())).toEqual({ total: 0, count: 0, missing: 0 });
    expect(sumPrices([{ price: 5 }], new Set([4]))).toEqual({ total: 0, count: 0, missing: 0 });
  });
  test("avoids floating point drift", () => {
    expect(sumPrices([{ price: 0.1 }, { price: 0.2 }], new Set([0, 1])).total).toBe(0.3);
  });
});

describe("formatTotal", () => {
  test("uses a currency code when known and appends unknown symbols", () => {
    expect(formatTotal(1550, "JPY", "ko-KR")).toContain("1,550");
    expect(formatTotal(1550, "¥", "ko-KR")).toBe("1,550 ¥");
    expect(formatTotal(1550, undefined, "ko-KR")).toBe("1,550");
    expect(formatTotal(10, "ZZZ", "en-US")).toContain("10");
  });
});

describe("avoid text storage", () => {
  test("round-trips, clears on blank and tolerates a throwing storage", () => {
    const storage = memoryStorage();
    writeAvoid("새우, 땅콩", storage);
    expect(readAvoid(storage)).toBe("새우, 땅콩");
    writeAvoid("   ", storage);
    expect(storage.map.has(SCAN_AVOID_KEY)).toBe(false);
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readAvoid(broken)).toBe("");
    expect(() => writeAvoid("x", broken)).not.toThrow();
  });
});
