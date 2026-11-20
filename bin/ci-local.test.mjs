import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { coreCacheKey, makeCoreRunDir, obsoleteCorePins, parseSuites, reusableCore } from "./ci-local.mjs";

const runner = fileURLToPath(new URL("./ci-local.mjs", import.meta.url));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-ci-local-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("suite selection preserves order and runs each suite at most once", () => {
  assert.deepEqual(parseSuites(["app", "harness-core", "app", "harness-extensions"]),
    ["app", "harness-core", "harness-extensions"]);
});

test("CLI rejects missing or invalid suites before it prepares anything", () => {
  const node = process.versions.bun ? "node" : process.execPath;
  const help = spawnSync(node, [runner, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage:.*harness-extensions.*harness-core.*app/);
  for (const args of [[], ["app", "typo"], ["app", "--help"]]) {
    const result = spawnSync(node, [runner, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage:/);
    if (args.length) assert.match(result.stderr, /Unknown suite:/);
    assert.equal(result.stdout, "");
  }
});

test("pristine cache key follows the exact core pin and platform", () => {
  const initial = coreCacheKey("19.0.1", "linux", "x64");
  assert.notEqual(initial, coreCacheKey("19.0.2", "linux", "x64"));
  assert.notEqual(initial, coreCacheKey("19.0.1", "linux", "arm64"));
  assert.throws(() => coreCacheKey("^19.0.1", "linux", "x64"), /exact/);
});

test("reuses a complete pristine installation of the exact pinned core", (t) => {
  const dir = fixture(t);
  const scope = join(dir, "node_modules/@oh-my-pi");
  const target = join(scope, "pi-coding-agent");
  assert.equal(reusableCore(dir, "19.0.1"), false);
  mkdirSync(join(target, "src/registry"), { recursive: true });
  writeFileSync(join(target, "package.json"), '{"version":"19.0.1"}');
  assert.equal(reusableCore(dir, "19.0.1"), false);
  writeFileSync(join(target, "src/registry/agent-registry.ts"), "");
  assert.equal(reusableCore(dir, "19.0.1"), false);
  mkdirSync(join(scope, "pi-natives-linux-x64"));
  assert.equal(reusableCore(dir, "19.0.1"), true);
  assert.equal(reusableCore(dir, "19.0.2"), false);
});

test("keeps the just-installed pin and latest previous pin even after a clock change", () => {
  const old = coreCacheKey("18.22.0");
  const active = coreCacheKey("19.0.1");
  const recentBackport = coreCacheKey("18.23.0");
  assert.deepEqual(obsoleteCorePins([
    { name: old, installedAt: 1 },
    { name: recentBackport, installedAt: 3 },
    { name: active, installedAt: 0 },
    { name: "elsewhere-x64-19.0.1", installedAt: 4 },
    { name: ".lock", installedAt: 5 },
  ], active), [old]);
});

test("sweeps only scratch runs owned by a dead PID", (t) => {
  const dir = fixture(t);
  const reaped = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(reaped.status, 0);
  const dead = join(dir, `run-${reaped.pid}-abcdef`);
  const live = join(dir, `run-${process.pid}-abcdef`);
  const unrelated = join(dir, "unrelated");
  for (const path of [dead, live, unrelated]) mkdirSync(path);
  const scratch = makeCoreRunDir(dir);
  assert.equal(existsSync(dead), false);
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(unrelated), true);
  assert.equal(existsSync(scratch), true);
});

test("finalize config selects only affected suites, or all suites for shared CI inputs", () => {
  const { version, checks } = JSON.parse(readFileSync(new URL("../.finalize-checks.json", import.meta.url), "utf8"));
  assert.equal(version, 1);
  const selected = (...paths) => checks.filter((check) => paths.some((file) => check.paths.some((pattern) =>
    pattern.endsWith("/") ? file.startsWith(pattern) : file === pattern))).map((check) => check.name);
  const all = ["harness-extensions", "harness-core", "app"];
  assert.deepEqual(checks.map((check) => check.command), all.map((suite) => ["node", "bin/ci-local.mjs", suite]));
  assert.deepEqual(selected("doc/history/x.md", "HANDOFF.md", "README.md", "CHANGELOG.md", "docs/harness.md"), []);
  assert.deepEqual(selected("Tools/OMP_Global_Config/agent/extensions/x.ts"), ["harness-extensions"]);
  assert.deepEqual(selected("Tools/OMP_Global_Config/patches/core-example-test.ts"), ["harness-extensions", "harness-core"]);
  assert.deepEqual(selected("Tools/OMP_Global_Config/patches/apply-core-patch.mjs"), all);
  assert.deepEqual(selected("lib/x.ts"), ["app"]);
  assert.deepEqual(selected("tsconfig.typecheck.json"), ["app"]);
  for (const path of [".finalize-checks.json", "bin/ci-local.mjs", ".github/workflows/ci.yml", "package.json", "bun.lock"]) {
    assert.deepEqual(selected(path), all, path);
  }
});
