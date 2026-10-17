import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./path-security.ts");
}

test("rejects an existing path that escapes an allowed root through a symlink", async (t) => {
  const { isExistingPathWithinRoots, isPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-file-access-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "secret.txt");
  const roots = new Set([allowed]);

  assert.equal(isPathWithinRoots(target, roots), true);
  assert.equal(isExistingPathWithinRoots(target, roots), false);
});

test("resolves alias roots freshly after retargeting or removing them", async (t) => {
  const { isExistingPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-root-alias-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  fs.mkdirSync(first);
  fs.mkdirSync(second);
  const firstFile = path.join(first, "file.txt");
  const secondFile = path.join(second, "file.txt");
  fs.writeFileSync(firstFile, "first");
  fs.writeFileSync(secondFile, "second");
  const alias = path.join(base, "alias");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(first, alias, linkType);
  const roots = new Set([path.join(base, "missing"), alias]);
  assert.equal(isExistingPathWithinRoots(firstFile, roots), true);
  assert.equal(isExistingPathWithinRoots(secondFile, roots), false);
  fs.unlinkSync(alias);
  fs.symlinkSync(second, alias, linkType);
  assert.equal(isExistingPathWithinRoots(firstFile, roots), false);
  assert.equal(isExistingPathWithinRoots(secondFile, roots), true);
  fs.unlinkSync(alias);
  assert.equal(isExistingPathWithinRoots(secondFile, roots), false);
});

test("checks other allowed roots when a lexical ancestor resolves elsewhere", async (t) => {
  const { isExistingPathWithinRoots } = await loadSubject();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-root-fallback-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const allowed = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "file.txt"), "outside");
  const link = path.join(allowed, "link");
  fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
  const target = path.join(link, "file.txt");
  assert.equal(isExistingPathWithinRoots(target, new Set([allowed])), false);
  assert.equal(isExistingPathWithinRoots(target, new Set([allowed, outside])), true);
  fs.mkdirSync(path.join(base, "outside-suffix"));
  assert.equal(isExistingPathWithinRoots(path.join(base, "outside-suffix"), new Set([outside])), false);
});

// file-access.ts pulls in the omp SDK through session-reader; importing it inside a test spends the
// per-test timeout on the first (cold) load, so it is loaded once here like session-reader.test.mjs.
const { mapLegacyWindowsPath, readLegacyPathMap } = await import("./file-access.ts");

const LEGACY_PREFIXES = [
  { windows: "F:\\CUELO", local: "/home/user/src/CUELO-private" },
  { windows: "F:\\CUELO\\.omp", local: "/mnt/f/CUELO/.omp" },
  { windows: "C:\\Users\\user\\.omp\\agent", local: "/home/user/.omp/agent" },
];

test("maps a legacy Windows path through the longest explicit prefix only", async () => {
  const map = (value) => mapLegacyWindowsPath(value, LEGACY_PREFIXES);

  assert.equal(map("F:/CUELO/HANDOFF.md"), "/home/user/src/CUELO-private/HANDOFF.md");
  assert.equal(map("f:\\cuelo\\lib\\a.ts"), "/home/user/src/CUELO-private/lib/a.ts");
  assert.equal(map("F:/CUELO/.omp/cloud/a.png"), "/mnt/f/CUELO/.omp/cloud/a.png");
  assert.equal(map("C:/Users/user/.omp/agent/rules/x.md"), "/home/user/.omp/agent/rules/x.md");
  // Whole segments only.
  assert.equal(map("F:/CUELO/.ompx/a"), "/home/user/src/CUELO-private/.ompx/a");
  assert.equal(map("F:/CUELOX/a"), "F:/CUELOX/a");
  // `..` is collapsed before matching, so nothing climbs out of a prefix into its local parent.
  assert.equal(map("F:/CUELO/../Windows/win.ini"), "F:/CUELO/../Windows/win.ini");
  assert.equal(map("F:/CUELO/.omp/../../x"), "F:/CUELO/.omp/../../x");
  assert.equal(map("F:/CUELO/.omp/../README.md"), "/home/user/src/CUELO-private/README.md");
  // No drive-wide fallback, UNC and native paths untouched, no map means no change.
  assert.equal(map("E:/project/a.ts"), "E:/project/a.ts");
  assert.equal(map("//server/share/a"), "//server/share/a");
  assert.equal(map("/home/user/src/CUELO-private/a"), "/home/user/src/CUELO-private/a");
  assert.equal(mapLegacyWindowsPath("F:/CUELO/HANDOFF.md", []), "F:/CUELO/HANDOFF.md");
});

test("reads only valid legacy prefixes and treats a missing or corrupt file as no map", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-legacy-paths-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dir = (name, content) => {
    const agentDir = path.join(base, name);
    fs.mkdirSync(agentDir);
    if (content !== undefined) fs.writeFileSync(path.join(agentDir, "cuelo-legacy-paths.json"), content);
    return agentDir;
  };

  assert.deepEqual(readLegacyPathMap(dir("missing")), []);
  assert.deepEqual(readLegacyPathMap(dir("corrupt", "{")), []);
  const valid = { windows: "F:\\CUELO", local: "/home/user/src/CUELO-private" };
  const mixed = JSON.stringify({
    version: 1,
    prefixes: [valid, { windows: "\\\\server\\share", local: "/x" }, { windows: "F:\\Y", local: "relative" }, null],
  });
  assert.deepEqual(readLegacyPathMap(dir("mixed", mixed)), [valid]);
});
