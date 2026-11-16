import { describe, expect, test } from "bun:test";
import { STALL_MAX_EVENTS, STALL_MAX_POSTS, STALL_POST_INTERVAL_MS, formatStallLine, nextPostDelay, parseStallReport } from "./stall-report";

const stall = { kind: "stall", durationMs: 812, phase: "listening", face: true, segmentCount: 42 };
const faceOff = { kind: "face-off", trigger: "back", phase: "idle", face: false, segmentCount: 3 };

describe("stall report validation", () => {
  test("accepts stall and face events and formats one log line each", () => {
    const report = parseStallReport({ events: [stall, faceOff] });
    expect(report?.events).toHaveLength(2);
    expect(formatStallLine(report!.events[0])).toBe("[translator] stall 812ms phase=listening face=true segments=42");
    expect(formatStallLine(report!.events[1])).toBe("[translator] face-off trigger=back phase=idle face=false segments=3");
  });

  test("rejects any text field, even next to valid values", () => {
    expect(parseStallReport({ events: [{ ...stall, text: "안녕하세요" }] })).toBeNull();
    expect(parseStallReport({ events: [stall], note: "x" })).toBeNull();
    expect(parseStallReport({ events: [{ ...faceOff, durationMs: 900 }] })).toBeNull();
  });

  test("rejects wrong types, unknown enums and out-of-range numbers", () => {
    expect(parseStallReport({ events: [{ ...stall, durationMs: "812" }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...stall, durationMs: 120 }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...stall, durationMs: 812.5 }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...stall, phase: "busy" }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...stall, face: "true" }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...stall, segmentCount: -1 }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...faceOff, trigger: "swipe" }] })).toBeNull();
    expect(parseStallReport({ events: [{ ...stall, kind: "tap" }] })).toBeNull();
  });

  test("rejects empty and oversized batches", () => {
    expect(parseStallReport({ events: [] })).toBeNull();
    expect(parseStallReport({ events: Array.from({ length: STALL_MAX_EVENTS + 1 }, () => stall) })).toBeNull();
    expect(parseStallReport([stall])).toBeNull();
    expect(parseStallReport(null)).toBeNull();
  });
});

describe("client throttle", () => {
  test("first post goes now, the next waits for the interval, the cap stops posting", () => {
    expect(nextPostDelay(null, 0, 1_000)).toBe(0);
    expect(nextPostDelay(1_000, 1, 4_000)).toBe(STALL_POST_INTERVAL_MS - 3_000);
    expect(nextPostDelay(1_000, 1, 1_000 + STALL_POST_INTERVAL_MS)).toBe(0);
    expect(nextPostDelay(1_000, STALL_MAX_POSTS, 1_000_000)).toBeNull();
  });
});
