import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createNoiseSuppressor, RNNOISE_ASSETS } from "./interpreter-noise-suppressor";

const packageDist = "node_modules/@sapphi-red/web-noise-suppressor/dist/";
const publicFile = (url: string) => readFileSync(`public${url}`);

describe("RNNoise assets", () => {
  // The worklet and the wasm come from one package version; a bump that misses a copy would load a mismatched pair.
  test.each([
    ["worklet", RNNOISE_ASSETS.worklet, "rnnoise/workletProcessor.js"],
    ["wasm", RNNOISE_ASSETS.wasm, "rnnoise.wasm"],
    ["simd wasm", RNNOISE_ASSETS.simdWasm, "rnnoise_simd.wasm"],
  ])("the served %s is the installed package's file", (_name, url, packagePath) => {
    expect(publicFile(url).equals(readFileSync(packageDist + packagePath))).toBe(true);
  });
});

describe("createNoiseSuppressor", () => {
  test("rejects without AudioWorklet so the caller keeps the raw microphone", async () => {
    expect(typeof AudioWorkletNode).toBe("undefined");
    await expect(createNoiseSuppressor({} as MediaStream, () => {})).rejects.toThrow("not available");
  });
});
