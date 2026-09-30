import assert from "node:assert/strict";
import test from "node:test";

const { recordModelPick, rankFrequentModels, modelPickKey } = await import("./model-picks.ts");

const options = [
  { provider: "a", modelId: "one" },
  { provider: "a", modelId: "two" },
  { provider: "b", modelId: "three" },
];

test("a new browser keeps the default order: nothing is listed first", () => {
  assert.deepEqual(rankFrequentModels({}, options), []);
  assert.deepEqual(rankFrequentModels(recordModelPick({}, modelPickKey("a", "two")), options), []);
});

test("lists models picked at least twice, most picked first, ties in picker order", () => {
  let counts = {};
  for (const key of ["b/three", "a/two", "b/three", "a/two", "b/three", "a/one", "a/one", "gone/model", "gone/model", "gone/model"]) {
    counts = recordModelPick(counts, key);
  }
  assert.deepEqual(rankFrequentModels(counts, options).map(({ option, count }) => [option.modelId, count]), [
    ["three", 3],
    ["one", 2],
    ["two", 2],
  ]);
});

test("the table stays bounded and keeps the model just picked", () => {
  let counts = {};
  for (let n = 0; n < 30; n++) counts = recordModelPick(recordModelPick(counts, `p/m${n}`), `p/m${n}`);
  counts = recordModelPick(counts, "p/new");
  assert.equal(Object.keys(counts).length, 30);
  assert.equal(counts["p/new"], 1);
});
