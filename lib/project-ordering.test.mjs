import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  ambiguousProjectNames,
  mergeProjectOrder,
  normalizeProjectKey,
  projectParentPath,
  recentProjectPaths,
} = await jiti.import("./project-ordering.ts");

function session(cwd, modified, projectRoot) {
  return projectRoot === undefined ? { cwd, modified } : { cwd, modified, projectRoot };
}

test("names the parent folder that tells two same-named projects apart", () => {
  assert.equal(projectParentPath("V:\\Projects\\Tools"), "V:\\Projects");
  assert.equal(projectParentPath("C:/Users/hanse/Downloads/Tools/"), "C:/Users/hanse/Downloads");
  assert.equal(projectParentPath("C:\\"), "");
  assert.equal(projectParentPath("Tools"), "");
});

test("marks only the names more than one project claims", () => {
  assert.deepEqual([...ambiguousProjectNames(["Tools", "gameedit", "tools"])], ["tools"]);
  assert.deepEqual([...ambiguousProjectNames(["Tools", "gameedit"])], []);
});

test("draws one row for a folder whose sessions spell the path two ways", () => {
  assert.deepEqual(
    recentProjectPaths([
      session("V:/Projects/Tools", "2026-09-09T07:10:17.678Z"),
      session("V:\\Projects\\Tools", "2026-09-21T01:00:00.000Z"),
    ]),
    ["V:\\Projects\\Tools"],
  );
});

test("keeps the spelling of the most recent session for the merged row", () => {
  assert.deepEqual(
    recentProjectPaths([
      session("V:\\Projects\\Tools", "2026-09-09T07:10:17.678Z"),
      session("V:/Projects/Tools", "2026-09-21T01:00:00.000Z"),
    ]),
    ["V:/Projects/Tools"],
  );
});

test("collapses a project's worktrees and subdirectories into its resolved root", () => {
  assert.deepEqual(
    recentProjectPaths([
      session("E:\\Proj\\worktree", "2026-09-01T00:00:00.000Z", "E:\\Proj"),
      session("E:\\Proj", "2026-09-02T00:00:00.000Z", "E:\\Proj"),
    ]),
    ["E:\\Proj"],
  );
});

test("orders the merged projects by most recent activity", () => {
  assert.deepEqual(
    recentProjectPaths([
      session("/work/alpha", "2026-09-01T00:00:00.000Z"),
      session("/work/beta", "2026-09-03T00:00:00.000Z"),
      session("V:/Projects/Tools", "2026-09-02T00:00:00.000Z"),
      session("V:\\Projects\\Tools", "2026-09-04T00:00:00.000Z"),
    ]),
    ["V:\\Projects\\Tools", "/work/beta", "/work/alpha"],
  );
});

test("treats a drive letter in another case as the same folder", () => {
  assert.deepEqual(
    recentProjectPaths([
      session("e:/Proj", "2026-09-01T00:00:00.000Z"),
      session("E:\\Proj", "2026-09-02T00:00:00.000Z"),
    ]),
    ["E:\\Proj"],
  );
});

test("normalizes slash style, duplicates and trailing separators", () => {
  assert.equal(normalizeProjectKey("E:\\Projects\\Tools\\"), "e:/projects/tools");
  assert.equal(normalizeProjectKey("E:/Projects//Tools"), "e:/projects/tools");
  assert.equal(normalizeProjectKey("  E:/Projects/Tools  "), "e:/projects/tools");
});

test("keeps drive and UNC roots while preserving POSIX case", () => {
  assert.equal(normalizeProjectKey("C:\\"), "c:/");
  assert.equal(normalizeProjectKey("/"), "/");
  assert.equal(normalizeProjectKey("\\\\Server\\Share\\Proj\\"), "//server/share/proj");
  assert.equal(normalizeProjectKey("/home/User/Work/"), "/home/User/Work");
});

test("leaves discovery order untouched when no manual order exists", () => {
  const projects = ["/a", "/b", "/c"];
  assert.deepEqual(mergeProjectOrder(projects, [{ key: "/b", hidden: false }]), projects);
});

test("places manually ordered projects first in ascending order", () => {
  assert.deepEqual(
    mergeProjectOrder(["/a", "/b", "/c"], [{ key: "/c", order: 0 }, { key: "/a", order: 1 }]),
    ["/c", "/a", "/b"],
  );
});

test("keeps the existing order when manual order values tie", () => {
  assert.deepEqual(
    mergeProjectOrder(
      ["/a", "/b", "/c"],
      [{ key: "/b", order: 0 }, { key: "/a", order: 0 }],
    ),
    ["/a", "/b", "/c"],
  );
});

test("matches manual order across slash styles and drive case", () => {
  assert.deepEqual(
    mergeProjectOrder(["E:\\Proj\\One", "E:\\Proj\\Two"], [{ key: "e:/proj/two", order: 0 }]),
    ["E:\\Proj\\Two", "E:\\Proj\\One"],
  );
});

test("uses path then key for registry-only projects", () => {
  const merged = mergeProjectOrder(["/a"], [
    { key: "e:/gone", path: "E:\\Gone", hidden: true },
    { key: "/fallback", hidden: true },
  ]);
  assert.deepEqual(merged, ["/a", "E:\\Gone", "/fallback"]);
});

test("does not duplicate a registry entry that is already discovered", () => {
  assert.deepEqual(mergeProjectOrder(["E:\\Proj"], [{ key: "e:/proj", hidden: false }]), ["E:\\Proj"]);
});

test("ignores non-finite manual order values", () => {
  assert.deepEqual(
    mergeProjectOrder(["/a", "/b"], [{ key: "/b", order: Number.NaN }]),
    ["/a", "/b"],
  );
});
