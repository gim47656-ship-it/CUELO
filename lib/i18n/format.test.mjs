import assert from "node:assert/strict";
import test from "node:test";

import { formatRelativeTime, interpolateMessage, translateMessage } from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("ko", "common.ok", { en: { "common.ok": "OK" }, ko: {} }), "OK");
  assert.equal(translateMessage("ko", "missing.key", { en: {}, ko: {} }), "missing.key");
});

test("formats relative time using the selected locale", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "ko", now), "5분 후");
});
