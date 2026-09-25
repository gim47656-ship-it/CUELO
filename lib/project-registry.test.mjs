import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  parseProjectRegistry,
  parseProjectRegistryFile,
  updateProjectRegistry,
} = await jiti.import("./project-registry.ts");

const EMPTY = { version: 1, projects: [] };

test("parses a valid registry, preserves its path and normalizes its key", () => {
  const parsed = parseProjectRegistry(JSON.stringify({
    version: 1,
    projects: [{
      key: "E:\\Proj\\One\\",
      path: "E:\\Proj\\One\\",
      alias: " One ",
      hidden: true,
      order: 2,
    }],
  }));
  assert.deepEqual(parsed, {
    version: 1,
    projects: [{
      key: "e:/proj/one",
      path: "E:\\Proj\\One\\",
      hidden: true,
      alias: "One",
      order: 2,
    }],
  });
});

test("skips damaged entries and keeps the first normalized-key duplicate", () => {
  const result = parseProjectRegistryFile(JSON.stringify({
    version: 1,
    projects: [
      { key: "/a", path: "/a", alias: "First", hidden: true, order: 4 },
      { key: "/bad-hidden", hidden: "yes" },
      { key: "/bad-order", order: "1" },
      { key: "/bad-path", path: 42, hidden: true },
      null,
      { key: "/b", alias: "Second", hidden: false, order: 7 },
      { key: "/a/", alias: "Duplicate", hidden: false, order: 1 },
    ],
  }));

  assert.equal(result.status, "ok");
  assert.deepEqual(result.registry, {
    version: 1,
    projects: [
      { key: "/a", path: "/a", alias: "First", hidden: true, order: 4 },
      { key: "/b", alias: "Second", hidden: false, order: 7 },
    ],
  });
});

test("distinguishes incompatible file-level data from an empty valid registry", () => {
  for (const raw of [
    "{",
    "[]",
    JSON.stringify({ version: 2, projects: [] }),
    JSON.stringify({ version: 1, projects: {} }),
  ]) {
    const result = parseProjectRegistryFile(raw);
    assert.equal(result.status, "incompatible");
    assert.deepEqual(result.registry, EMPTY);
  }

  assert.deepEqual(
    parseProjectRegistryFile(JSON.stringify({ version: 1, projects: [] })),
    { status: "ok", registry: EMPTY },
  );
});

test("returns independent empty registries on incompatible input", () => {
  const first = parseProjectRegistry("{");
  first.projects.push({ key: "/mutated", hidden: true });
  assert.deepEqual(parseProjectRegistry("{"), EMPTY);
});

test("treats a missing hidden flag as visible", () => {
  const parsed = parseProjectRegistry(JSON.stringify({ version: 1, projects: [{ key: "/a" }] }));
  assert.deepEqual(parsed, { version: 1, projects: [{ key: "/a", hidden: false }] });
});

test("creates an entry for an unknown key and preserves the original path", () => {
  const next = updateProjectRegistry(EMPTY, [{
    key: "E:\\Proj",
    path: "E:\\Proj",
    hidden: true,
  }]);
  assert.deepEqual(next, {
    version: 1,
    projects: [{ key: "e:/proj", path: "E:\\Proj", hidden: true }],
  });
});

test("allows a later update to replace the preserved path", () => {
  const start = {
    version: 1,
    projects: [{ key: "e:/proj", path: "E:\\PROJ", hidden: true }],
  };
  const next = updateProjectRegistry(start, [{
    key: "E:\\Proj",
    path: "E:\\Proj\\",
    alias: "Project",
  }]);
  assert.deepEqual(next, {
    version: 1,
    projects: [{
      key: "e:/proj",
      path: "E:\\Proj\\",
      alias: "Project",
      hidden: true,
    }],
  });
});

test("clears alias and order with null and keeps other fields", () => {
  const start = {
    version: 1,
    projects: [{ key: "/a", path: "/a", alias: "A", hidden: true, order: 3 }],
  };
  const cleared = updateProjectRegistry(start, [{ key: "/a", alias: null, order: null }]);
  assert.deepEqual(cleared, {
    version: 1,
    projects: [{ key: "/a", path: "/a", hidden: true }],
  });
});

test("treats a blank alias as a clear and trims otherwise", () => {
  const start = {
    version: 1,
    projects: [{ key: "/a", path: "/a", alias: "A", hidden: false }],
  };
  assert.deepEqual(updateProjectRegistry(start, [{ key: "/a", alias: "   " }]), EMPTY);
  assert.deepEqual(
    updateProjectRegistry(start, [{ key: "/a", alias: "  Renamed  " }]),
    {
      version: 1,
      projects: [{
        key: "/a",
        path: "/a",
        alias: "Renamed",
        hidden: false,
      }],
    },
  );
});

test("removes default entries even when only a path remains", () => {
  assert.deepEqual(
    updateProjectRegistry(EMPTY, [{ key: "/a", path: "/a", hidden: false }]),
    EMPTY,
  );
  const start = {
    version: 1,
    projects: [{ key: "/a", path: "/a", alias: "A", hidden: false, order: 3 }],
  };
  assert.deepEqual(
    updateProjectRegistry(start, [{ key: "/a", alias: null, order: null }]),
    EMPTY,
  );
});

test("does not mutate the input registry", () => {
  const start = {
    version: 1,
    projects: [{ key: "/a", path: "/a", hidden: false, alias: "A" }],
  };
  updateProjectRegistry(start, [{ key: "/a", path: "/a/", hidden: true, alias: "B" }]);
  assert.deepEqual(start, {
    version: 1,
    projects: [{ key: "/a", path: "/a", hidden: false, alias: "A" }],
  });
});

test("applies a batch order update in one pass", () => {
  const next = updateProjectRegistry(EMPTY, [
    { key: "/a", path: "/a", order: 1 },
    { key: "/b", path: "/b", order: 0 },
  ]);
  assert.deepEqual(next.projects, [
    { key: "/a", path: "/a", hidden: false, order: 1 },
    { key: "/b", path: "/b", hidden: false, order: 0 },
  ]);
});

test("ignores an update whose key normalizes to nothing", () => {
  assert.deepEqual(updateProjectRegistry(EMPTY, [{ key: "   ", hidden: true }]), EMPTY);
});
