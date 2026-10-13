import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { resolveProjectDocs } = await import("./project-docs.ts");

function makeTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-project-docs-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const write = (relative, content = "x") => {
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  const dir = (relative) => {
    const target = path.join(base, relative);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  return { base, write, dir };
}

test("finds the HANDOFF, document map and newest records next to it", (t) => {
  const { base, write, dir } = makeTree(t);
  dir("repo/.git");
  const handoff = write("repo/HANDOFF.md");
  const map = write("repo/doc/README.md");
  write("repo/doc/history/2025/12/31-old/main.md");
  write("repo/doc/history/2026/09/30-sept/main.md");
  const makerOnly = write("repo/doc/history/2026/10/02-maker-only/maker-b.md");
  write("repo/doc/history/2026/10/02-maker-only/maker-a.md");
  const earlier = write("repo/doc/history/2026/10/13-earlier/main.md");
  const later = write("repo/doc/history/2026/10/13-later/main.md");
  dir("repo/doc/history/2026/10/12-empty");
  dir("repo/doc/history/2026/10/notes");
  fs.utimesSync(earlier, new Date("2026-10-13T01:00:00Z"), new Date("2026-10-13T01:00:00Z"));
  fs.utimesSync(later, new Date("2026-10-13T09:00:00Z"), new Date("2026-10-13T09:00:00Z"));

  const docs = resolveProjectDocs(path.join(base, "repo"), new Set([path.join(base, "repo")]), 4);

  assert.equal(docs.projectDir, path.join(base, "repo"));
  assert.deepEqual(docs.handoff, { state: "found", path: handoff });
  assert.deepEqual(docs.docMap, { state: "found", path: map });
  assert.equal(docs.history.state, "found");
  assert.deepEqual(docs.history.records.map((record) => [record.date, record.topic, record.fileName]), [
    ["2026-10-13", "later", "main.md"],
    ["2026-10-13", "earlier", "main.md"],
    ["2026-10-02", "maker-only", "maker-a.md"],
    ["2026-09-30", "sept", "main.md"],
  ]);
  assert.notEqual(docs.history.records[2].path, makerOnly);
});

test("reports each missing document separately", (t) => {
  const { base, write, dir } = makeTree(t);
  dir("repo/.git");
  const handoff = write("repo/HANDOFF.md");
  dir("repo/doc/history/2026/10");

  const docs = resolveProjectDocs(path.join(base, "repo"), new Set([path.join(base, "repo")]));

  assert.deepEqual(docs.handoff, { state: "found", path: handoff });
  assert.deepEqual(docs.docMap, { state: "missing", path: null });
  assert.deepEqual(docs.history, { state: "missing", records: [] });
});

test("nested project uses the nearest HANDOFF and its own doc folder", (t) => {
  const { base, write, dir } = makeTree(t);
  dir("repo/.git");
  write("repo/HANDOFF.md");
  write("repo/doc/README.md");
  const projectHandoff = write("repo/apps/a/HANDOFF.md");
  const sub = dir("repo/apps/a/src/deep");

  const docs = resolveProjectDocs(sub, new Set([path.join(base, "repo")]));

  assert.equal(docs.projectDir, path.join(base, "repo/apps/a"));
  assert.deepEqual(docs.handoff, { state: "found", path: projectHandoff });
  // The repository root map belongs to another project and is not borrowed.
  assert.deepEqual(docs.docMap, { state: "missing", path: null });
});

test("without a HANDOFF only the work folder is consulted, never the repository root", (t) => {
  const { base, write, dir } = makeTree(t);
  dir("repo/.git");
  write("repo/doc/README.md");
  const cwd = dir("repo/tool");

  const none = resolveProjectDocs(cwd, new Set([path.join(base, "repo")]));
  assert.equal(none.projectDir, cwd);
  assert.deepEqual(none.handoff, { state: "missing", path: null });
  assert.deepEqual(none.docMap, { state: "missing", path: null });
  assert.deepEqual(none.history, { state: "missing", records: [] });

  const localMap = write("repo/tool/doc/README.md");
  assert.deepEqual(resolveProjectDocs(cwd, new Set([path.join(base, "repo")])).docMap, { state: "found", path: localMap });
});

test("the walk stops at the repository root", (t) => {
  const { base, write, dir } = makeTree(t);
  write("HANDOFF.md");
  dir("repo/.git");
  const cwd = dir("repo/src");

  assert.deepEqual(resolveProjectDocs(cwd, new Set([base])).handoff, { state: "missing", path: null });
});

test("ancestors outside the allowed roots are neither walked nor reported", (t) => {
  const { write, dir } = makeTree(t);
  dir("repo/.git");
  write("repo/HANDOFF.md");
  write("repo/doc/README.md");
  write("repo/doc/history/2026/10/13-a/main.md");
  const cwd = dir("repo/app");

  const docs = resolveProjectDocs(cwd, new Set([cwd]));

  assert.equal(docs.projectDir, cwd);
  assert.deepEqual(docs.handoff, { state: "missing", path: null });
  assert.deepEqual(docs.docMap, { state: "missing", path: null });
  assert.deepEqual(docs.history, { state: "missing", records: [] });
});

test("the nearest HANDOFF inside the allowed roots is found when the repository root lies outside", (t) => {
  const { write, dir } = makeTree(t);
  dir("repo/.git");
  write("repo/HANDOFF.md");
  const project = dir("repo/apps/a");
  const projectHandoff = write("repo/apps/a/HANDOFF.md");
  const map = write("repo/apps/a/doc/README.md");
  const cwd = dir("repo/apps/a/src");

  const docs = resolveProjectDocs(cwd, new Set([project]));

  assert.equal(docs.projectDir, project);
  assert.deepEqual(docs.handoff, { state: "found", path: projectHandoff });
  assert.deepEqual(docs.docMap, { state: "found", path: map });

  // Without a HANDOFF inside the allowed roots the repository root's HANDOFF stays unreported.
  fs.rmSync(projectHandoff);
  assert.deepEqual(resolveProjectDocs(cwd, new Set([project])).handoff, { state: "missing", path: null });
});

test("symbolic links that escape the allowed roots are refused", (t) => {
  const { base, write, dir } = makeTree(t);
  const repo = dir("repo");
  dir("repo/.git");
  const secret = write("outside/secret.md");
  write("outside/history/main.md");
  fs.symlinkSync(secret, path.join(repo, "HANDOFF.md"));
  const kept = write("repo/doc/history/2026/10/12-kept/main.md");
  fs.mkdirSync(path.join(repo, "doc/history/2026/10"), { recursive: true });
  fs.symlinkSync(path.join(base, "outside/history"), path.join(repo, "doc/history/2026/10/13-escape"), "dir");

  const docs = resolveProjectDocs(repo, new Set([repo]));

  assert.deepEqual(docs.handoff, { state: "denied", path: path.join(repo, "HANDOFF.md") });
  assert.deepEqual(docs.history.records.map((record) => record.path), [kept]);
});

test("history folders that resolve outside the allowed roots are not descended into", (t) => {
  const { base, write, dir } = makeTree(t);
  const repo = dir("repo");
  dir("repo/.git");
  const kept = write("repo/doc/history/2026/10/12-kept/main.md");
  const inside = write("repo/notes/inside.md");
  // The outside year folder holds a record that links back inside: reachable only by descending into it.
  dir("outside/2027/01/01-outside-year");
  fs.symlinkSync(inside, path.join(base, "outside/2027/01/01-outside-year/main.md"));
  fs.symlinkSync(path.join(base, "outside/2027"), path.join(repo, "doc/history/2027"), "dir");
  // A symlinked year folder that stays inside the roots is still followed.
  write("repo/archive/2025/05/05-linked/main.md");
  fs.symlinkSync(path.join(repo, "archive/2025"), path.join(repo, "doc/history/2025"), "dir");

  const records = resolveProjectDocs(repo, new Set([repo])).history.records;

  assert.deepEqual(records.map((record) => [record.date, record.topic]), [
    ["2026-10-12", "kept"],
    ["2025-05-05", "linked"],
  ]);
  assert.equal(records[0].path, kept);
});

test("the level bound ends the walk with the folders already collected", (t) => {
  const { base, write, dir } = makeTree(t);
  const deep = Array.from({ length: 40 }, (_, index) => `d${index}`);
  const cwd = dir(path.join(...deep));
  // 31 levels above the cwd is the last folder inside the 32-level bound.
  const handoff = write(path.join(...deep.slice(0, 40 - 31), "HANDOFF.md"));
  write(path.join(...deep.slice(0, 40 - 32), "HANDOFF.md"));

  assert.deepEqual(resolveProjectDocs(cwd, new Set([base])).handoff, { state: "found", path: handoff });
  fs.rmSync(handoff);
  assert.deepEqual(resolveProjectDocs(cwd, new Set([base])).handoff, { state: "missing", path: null });
});
