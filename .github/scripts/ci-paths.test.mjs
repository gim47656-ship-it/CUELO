// The push path filters of ci.yml and publish-public.yml decide which pushes start CI and the
// mirror publish. A filter that ignores a file the mirror receives or the private job reads
// would silently skip the check that guards it, so this test replays both filters over every
// tracked file. It needs .publicignore, which the public mirror does not carry, and skips there.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parsePushPathsFilter, pushStartsWorkflow } from "../../Tools/OMP_Global_Config/agent/tools/ci-chain/paths-filter.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const suite = existsSync(join(root, ".publicignore")) ? describe : describe.skip;

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (output) => output.split("\0").filter(Boolean);
const filterOf = (name) => parsePushPathsFilter(readFileSync(join(root, ".github", "workflows", name), "utf8"));

suite("push path filters", () => {
  const tracked = lines(git("ls-files", "-z"));
  // The same selection publish-public.yml uses to remove private files from the mirror tree.
  const privateOnly = new Set(lines(git("ls-files", "-z", "-ci", "--exclude-from=.publicignore")));
  const mirrored = tracked.filter((path) => !privateOnly.has(path));
  const manifest = Object.keys(JSON.parse(readFileSync(join(root, "Tools/CUELO_Setup/files/source-integrity.json"), "utf8")).files);
  const privateJobInputs = tracked.filter((path) =>
    [
      ".github/",
      "Tools/CUELO_Setup/files/",
      "Tools/CUELO_Setup/wsl/",
      "Tools/OMP_Global_Config/evals/",
      "Tools/OMP_Global_Config/agent/",
      "Tools/OMP_Global_Config/patches/",
    ].some((prefix) => path.startsWith(prefix)),
  );
  const ci = filterOf("ci.yml");
  const publish = filterOf("publish-public.yml");
  const skippedBy = (filter, paths) => paths.filter((path) => !pushStartsWorkflow(filter, [path]));

  test("both workflows keep a push path filter this repository can read", () => {
    expect(ci?.pathsIgnore?.length).toBeGreaterThan(0);
    expect(publish?.paths?.length).toBeGreaterThan(0);
  });

  test("CI is never skipped for a file the mirror receives, the source manifest lists, or the private job reads", () => {
    expect(mirrored.length).toBeGreaterThan(1000);
    expect(manifest.length).toBeGreaterThan(1000);
    expect(skippedBy(ci, mirrored)).toEqual([]);
    expect(skippedBy(ci, manifest)).toEqual([]);
    expect(skippedBy(ci, privateJobInputs)).toEqual([]);
  });

  test("the mirror publish is never skipped for a file the mirror receives or for the files that decide what it receives", () => {
    const deciders = [".publicignore", ".publicdeny", ".github/workflows/publish-public.yml", ".github/scripts/public-content-scan.py", ".github/scripts/public-notes-scan.py"];
    expect(skippedBy(publish, mirrored)).toEqual([]);
    expect(skippedBy(publish, deciders)).toEqual([]);
  });

  test("each workflow starts for a push that changes its own file", () => {
    expect(pushStartsWorkflow(ci, [".github/workflows/ci.yml"])).toBe(true);
    expect(pushStartsWorkflow(publish, [".github/workflows/publish-public.yml"])).toBe(true);
  });

  test("a push of private records only starts neither workflow, and one more file starts it", () => {
    const records = ["doc/history/2026/10/28-x/main.md", "HANDOFF.md", "Tools/OMP_Global_Config/HANDOFF.md", "Tools/OMP_Global_Config/doc/history/a.md", "Tools/OMP_Global_Config/memory-sync/memories.jsonl"];
    expect(pushStartsWorkflow(ci, records)).toBe(false);
    expect(pushStartsWorkflow(publish, records)).toBe(false);
    for (const extra of ["Tools/OMP_Global_Config/agent/rules/subagent.md", "lib/rpc-manager.ts", "AGENTS.md"]) {
      expect(pushStartsWorkflow(ci, [...records, extra])).toBe(true);
    }
    for (const extra of ["Tools/OMP_Global_Config/agent/rules/subagent.md", "lib/rpc-manager.ts", "CHANGELOG.md"]) {
      expect(pushStartsWorkflow(publish, [...records, extra])).toBe(true);
    }
  });

  test("private harness files the private job reads still start CI, while the mirror publish skips what it never receives", () => {
    const privateHarness = ["Tools/OMP_Global_Config/agent/config.yml", "Tools/OMP_Global_Config/agent/models.yml", "Tools/OMP_Global_Config/evals/analyze-evals.mjs"];
    for (const path of privateHarness) {
      expect(pushStartsWorkflow(ci, [path])).toBe(true);
      expect(pushStartsWorkflow(publish, [path])).toBe(false);
    }
  });
});
