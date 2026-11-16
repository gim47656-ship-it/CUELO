import { describe, expect, test } from "bun:test";
import { InterpreterTextError } from "./interpreter-travel";
import { SCAN_IMAGE_MAX_BYTES, SCAN_ITEMS_MAX, normalizeScanResult, parseScanRequest } from "./interpreter-scan";

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==";
const base = { image: `data:image/png;base64,${PIXEL}`, mine: "ko", theirs: "ja" };

function badRequest(value: unknown) {
  try {
    parseScanRequest(value);
  } catch (error) {
    return error instanceof InterpreterTextError ? error.kind : "other";
  }
  return "accepted";
}

describe("parseScanRequest", () => {
  test("accepts a small png and trims the avoid text", () => {
    const request = parseScanRequest({ ...base, avoid: "  새우   땅콩 " });
    expect(request.mimeType).toBe("image/png");
    expect(request.data).toBe(PIXEL);
    expect(request.avoid).toBe("새우 땅콩");
    expect(request.theirs.code).toBe("ja");
  });
  test("rejects wrong types, languages and non-image data URLs", () => {
    expect(badRequest(null)).toBe("bad-request");
    expect(badRequest({ ...base, mine: "xx" })).toBe("bad-request");
    expect(badRequest({ ...base, image: 5 })).toBe("bad-request");
    expect(badRequest({ ...base, image: "data:image/gif;base64,R0lGODlh" })).toBe("bad-request");
    expect(badRequest({ ...base, image: "data:text/html;base64,PGI+" })).toBe("bad-request");
    expect(badRequest({ ...base, image: "https://example.com/a.png" })).toBe("bad-request");
    expect(badRequest({ ...base, image: "data:image/png;base64,abc" })).toBe("bad-request");
    expect(badRequest({ ...base, avoid: 5 })).toBe("bad-request");
    expect(badRequest({ ...base, avoid: "a".repeat(201) })).toBe("bad-request");
  });
  test("rejects an image over the decoded size limit", () => {
    const big = "A".repeat(Math.ceil(((SCAN_IMAGE_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    expect(badRequest({ ...base, image: `data:image/jpeg;base64,${big}` })).toBe("bad-request");
    const ok = "A".repeat(Math.floor((SCAN_IMAGE_MAX_BYTES * 4) / 3 / 4) * 4);
    expect(badRequest({ ...base, image: `data:image/jpeg;base64,${ok}` })).toBe("accepted");
  });
});

describe("normalizeScanResult", () => {
  test("reads fenced JSON and keeps valid fields", () => {
    const raw = "```json\n" + JSON.stringify({
      kind: "menu", summary: "요약", currency: "JPY",
      items: [{ original: "唐揚げ", translation: "가라아게", price: 980, priceText: "¥980", allergens: ["밀", "밀", " 대두 "], warning: "주의" }],
    }) + "\n```";
    expect(normalizeScanResult(raw)).toEqual({
      kind: "menu", summary: "요약", currency: "JPY",
      items: [{ original: "唐揚げ", translation: "가라아게", price: 980, priceText: "¥980", allergens: ["밀", "대두"], warning: "주의" }],
    });
  });
  test("drops invalid fields and items without failing the result", () => {
    const result = normalizeScanResult(JSON.stringify({
      kind: "weird", summary: "s",
      items: [
        { original: "a", translation: "b", price: "12", allergens: "milk", warning: 3 },
        { original: "only original" },
        "junk",
        { original: "c", translation: "d", price: -5 },
        { original: "e", translation: "f", price: Number.MAX_VALUE },
      ],
    }));
    expect(result?.kind).toBe("other");
    expect(result?.items.map((item) => item.original)).toEqual(["a", "c", "e"]);
    expect(result?.items.every((item) => item.price === undefined && item.allergens === undefined && item.warning === undefined)).toBe(true);
  });
  test("caps the item count and string lengths", () => {
    const items = Array.from({ length: SCAN_ITEMS_MAX + 10 }, (_, i) => ({ original: `o${i}`, translation: "t".repeat(1000) }));
    const result = normalizeScanResult(JSON.stringify({ kind: "menu", summary: "s", items }));
    expect(result?.items).toHaveLength(SCAN_ITEMS_MAX);
    expect(result?.items[0].translation).toHaveLength(300);
  });
  test("sign with summary only and a no-text answer are valid; unparsable output is not", () => {
    expect(normalizeScanResult('{"kind":"sign","summary":"출입 금지","items":[]}')).toEqual({ kind: "sign", summary: "출입 금지", items: [] });
    expect(normalizeScanResult('{"kind":"other","summary":"","items":[]}')).toEqual({ kind: "other", summary: "", items: [] });
    expect(normalizeScanResult("not json")).toBeUndefined();
    expect(normalizeScanResult("[1,2]")).toBeUndefined();
  });
});
