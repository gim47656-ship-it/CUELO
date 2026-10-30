import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, perTurns } from "./criteria.ts";

test("comparison boundaries: >50% worse is watch, 2x is problem, small samples are not judged", () => {
  assert.equal(compare(15, 10, 20, 20), "ok");
  assert.equal(compare(16, 10, 20, 20), "watch");
  assert.equal(compare(20, 10, 20, 20), "problem");
  assert.equal(compare(20, 10, 19, 20), "unknown");
  assert.equal(compare(null, 10, 20, 20), "unknown");
});

test("lower-is-worse metrics judge a drop", () => {
  assert.equal(compare(5, 10, 20, 20, "lower"), "problem");
  assert.equal(compare(12, 10, 20, 20, "lower"), "ok");
});

test("a rise from zero is a problem once samples suffice", () => {
  assert.equal(compare(3, 0, 20, 20), "problem");
});

test("per-100-request rate removes workload size", () => {
  assert.equal(perTurns(16, 800), 2);
  assert.equal(perTurns(16, 0), null);
});
