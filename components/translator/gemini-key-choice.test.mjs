import { describe, expect, test } from "bun:test";
import { parseGeminiCredentials, resolveGeminiCredential } from "./gemini-key-choice.ts";

const keys = [{ id: 27, label: "Google API 키 #27" }, { id: 31, label: "Google API 키 #31" }];

describe("Gemini credential choice", () => {
  test("a saved key that is no longer listed is never swapped for another key", () => {
    expect(resolveGeminiCredential(999, keys)).toEqual({ id: null, missing: true });
    expect(resolveGeminiCredential(999, [keys[0]])).toEqual({ id: null, missing: true });
    expect(resolveGeminiCredential(31, keys)).toEqual({ id: 31, missing: false });
  });

  test("without a saved choice only a single key is used; several need a choice", () => {
    expect(resolveGeminiCredential(null, [keys[0]])).toEqual({ id: 27, missing: false });
    expect(resolveGeminiCredential(null, keys)).toEqual({ id: null, missing: false });
    expect(resolveGeminiCredential(null, [])).toEqual({ id: null, missing: false });
  });

  test("the key list keeps only well-formed id/label items", () => {
    expect(parseGeminiCredentials({ credentials: [keys[0], { id: "31", label: "x" }, { id: 2.5, label: "y" }, { id: 4 }], model: "m" }))
      .toEqual([keys[0]]);
    expect(parseGeminiCredentials({ error: "nope" })).toEqual([]);
  });
});
