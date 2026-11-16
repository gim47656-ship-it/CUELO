import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_PHRASES,
  PHRASE_CACHE_MAX,
  PHRASE_GROUPS,
  builtInText,
  phraseCacheKey,
  readPhrasebook,
  createLimiter,
  withCached,
  withReading,
} from "./phrase-store";

describe("phrase cache keys", () => {
  test("differ by source text, my language and partner language; ignore outer spaces", () => {
    const key = phraseCacheKey("화장실이 어디에 있나요?", "ko", "vi");
    expect(phraseCacheKey(" 화장실이 어디에 있나요? ", "ko", "vi")).toBe(key);
    expect(phraseCacheKey("화장실이 어디에 있나요?", "ko", "ja")).not.toBe(key);
    expect(phraseCacheKey("화장실이 어디에 있나요?", "en", "vi")).not.toBe(key);
    expect(phraseCacheKey("계산해 주세요.", "ko", "vi")).not.toBe(key);
  });

  test("a cached translation and its reading survive a storage round trip and the newest entry wins", () => {
    const key = phraseCacheKey("계산해 주세요.", "ko", "vi");
    let data = withCached(readPhrasebook(null), key, { translation: "Tính tiền giúp tôi." });
    data = withCached(data, key, { translation: "Cho tôi thanh toán.", reading: "쩌 또이 타잉 또안" });
    expect(readPhrasebook(JSON.stringify(data)).cache[key]).toEqual({ translation: "Cho tôi thanh toán.", reading: "쩌 또이 타잉 또안" });
  });

  test("entries saved before readings (plain strings) still load, and a later reading attaches in place", () => {
    const key = phraseCacheKey("감사합니다", "ko", "vi");
    const old = readPhrasebook(JSON.stringify({ custom: [], cache: { other: "Xin chào", [key]: "Cảm ơn" } }));
    expect(old.cache[key]).toEqual({ translation: "Cảm ơn" });
    const updated = withReading(old, key, "깜 언");
    expect(updated.cache[key]).toEqual({ translation: "Cảm ơn", reading: "깜 언" });
    expect(Object.keys(updated.cache)).toEqual(["other", key]);
    expect(withReading(old, "missing", "깜 언")).toBe(old);
  });

  test("the cache keeps the newest PHRASE_CACHE_MAX entries", () => {
    let data = readPhrasebook(null);
    for (let index = 0; index < PHRASE_CACHE_MAX + 5; index += 1) data = withCached(data, `k${index}`, { translation: `v${index}` });
    const keys = Object.keys(data.cache);
    expect(keys).toHaveLength(PHRASE_CACHE_MAX);
    expect(keys[0]).toBe("k5");
    expect(data.cache[`k${PHRASE_CACHE_MAX + 4}`]).toEqual({ translation: `v${PHRASE_CACHE_MAX + 4}` });
  });

  test("broken storage reads as empty, invalid custom phrases and cache entries are dropped", () => {
    expect(readPhrasebook("{oops")).toEqual({ custom: [], cache: {} });
    const data = readPhrasebook(JSON.stringify({ custom: [{ id: "a", text: "물 주세요", lang: "ko" }, { id: 3, text: "x", lang: "ko" }, { id: "b", text: "  ", lang: "ko" }], cache: { k: 5, e: { reading: "깜" }, r: { translation: "Ok", reading: 3 } } }));
    expect(data.custom).toEqual([{ id: "a", text: "물 주세요", lang: "ko" }]);
    expect(data.cache).toEqual({ r: { translation: "Ok" } });
  });
});

describe("built-in phrases", () => {
  test("cover the agreed situations in Korean and English", () => {
    expect(PHRASE_GROUPS).toEqual(["food", "restroom", "payment", "directions", "emergency"]);
    for (const group of PHRASE_GROUPS) {
      expect(BUILT_IN_PHRASES[group].length).toBeGreaterThan(0);
      for (const phrase of BUILT_IN_PHRASES[group]) {
        expect(builtInText(phrase, "ko")).toBe(phrase.ko);
        expect(builtInText(phrase, "en")).toBe(phrase.en);
        expect(builtInText(phrase, "vi")).toBeNull();
      }
    }
  });
});

describe("createLimiter", () => {
  test("callers from different places never exceed the limit together, and a failure frees its slot", async () => {
    const run = createLimiter(2);
    let running = 0;
    let peak = 0;
    const gates = new Map<number, () => void>();
    const task = (item: number) => run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      const { promise, resolve } = Promise.withResolvers<void>();
      gates.set(item, resolve);
      await promise;
      running -= 1;
      if (item === 1) throw new Error("offline");
      return item;
    });
    // A bulk batch of three, then a single tap while two are in flight.
    const bulk = [1, 2, 3].map((item) => task(item).catch(() => null));
    const tap = task(4);
    await null;
    expect([...gates.keys()]).toEqual([1, 2]);
    gates.get(1)?.();
    for (let tick = 0; tick < 5; tick += 1) await null;
    expect([...gates.keys()]).toEqual([1, 2, 3]);
    gates.get(2)?.();
    for (let tick = 0; tick < 5; tick += 1) await null;
    gates.get(3)?.();
    gates.get(4)?.();
    expect(await Promise.all(bulk)).toEqual([null, 2, 3]);
    expect(await tap).toBe(4);
    expect(peak).toBe(2);
  });
});
