import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { createRootDispatchFactory, registerRootReviver } = await jiti.import("./subagent-revive.ts");

const dir = path.resolve("sessions", "proj");
const rootA = path.join(dir, "2026-09-30_s1.jsonl");
const rootB = path.join(dir, "2026-09-30_s10.jsonl");
const childOf = (root, ...rest) => path.join(root.slice(0, -".jsonl".length), ...rest);

function recorder(label, calls) {
  return async (ref) => {
    calls.push([label, ref.id]);
    return async () => label;
  };
}

test("a parked child revives through the root session whose artifact directory holds its transcript", async () => {
  const calls = [];
  const roots = new Map([[rootA, recorder("A", calls)], [rootB, recorder("B", calls)]]);
  const dispatch = createRootDispatchFactory(roots);
  // s1 and s10 share a name prefix; only the directory boundary decides ownership.
  assert.ok(await dispatch({ id: "0-Fix", sessionFile: childOf(rootB, "0-Fix.jsonl") }));
  assert.ok(await dispatch({ id: "1-Nested", sessionFile: childOf(rootA, "0-Fix", "1-Nested.jsonl") }));
  assert.deepEqual(calls, [["B", "0-Fix"], ["A", "1-Nested"]]);
});

test("a child of a root that is not open, the root transcript itself, or a ref without a file stays transcript-only", async () => {
  const calls = [];
  const dispatch = createRootDispatchFactory(new Map([[rootA, recorder("A", calls)]]));
  assert.equal(await dispatch({ id: "0-Fix", sessionFile: childOf(rootB, "0-Fix.jsonl") }), undefined);
  assert.equal(await dispatch({ id: "self", sessionFile: rootA }), undefined);
  assert.equal(await dispatch({ id: "none", sessionFile: null }), undefined);
  assert.deepEqual(calls, []);
});

test("unregistering a torn-down session leaves a newer registration for the same root in place", async () => {
  const calls = [];
  const first = recorder("old", calls);
  const second = recorder("new", calls);
  const dropFirst = registerRootReviver(rootA, first, () => 0);
  registerRootReviver(rootA, second, () => 0);
  dropFirst();
  const dispatch = createRootDispatchFactory(globalThis.__cueloRootRevivers);
  await dispatch({ id: "0-Fix", sessionFile: childOf(rootA, "0-Fix.jsonl") });
  assert.deepEqual(calls, [["new", "0-Fix"]]);
});
