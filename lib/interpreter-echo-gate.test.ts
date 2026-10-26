import { describe, expect, test } from "bun:test";
import { EchoGate, rms } from "./interpreter-echo-gate";

describe("EchoGate", () => {
  test("blocks while the interpretation plays and for the hold after it", () => {
    const gate = new EchoGate(500);
    expect(gate.update(false, 0)).toBe(false);
    expect(gate.update(true, 100)).toBe(true);
    expect(gate.update(false, 599)).toBe(true);
    expect(gate.update(false, 600)).toBe(false);
  });

  test("a pause inside one interpretation keeps the microphone blocked", () => {
    const gate = new EchoGate(500);
    gate.update(true, 0);
    expect(gate.update(false, 300)).toBe(true);
    gate.update(true, 400);
    expect(gate.update(false, 850)).toBe(true);
    expect(gate.update(false, 900)).toBe(false);
  });

  test("reset opens the microphone at once", () => {
    const gate = new EchoGate(500);
    gate.update(true, 0);
    gate.reset();
    expect(gate.update(false, 10)).toBe(false);
  });
});

describe("rms", () => {
  test("measures the level of a block", () => {
    expect(rms(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5);
    expect(rms(new Float32Array(128))).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
  });
});
