import { describe, expect, test } from "bun:test";
import { globToRegExp, parsePushPathsFilter, pushStartsWorkflow } from "./paths-filter";

describe("globToRegExp", () => {
  test("* stays inside one folder, ** crosses folders, and a pattern matches the whole path", () => {
    expect(globToRegExp("Tools/*/*.md").test("Tools/OMP_Global_Config/README.md")).toBe(true);
    expect(globToRegExp("Tools/*/*.md").test("Tools/OMP_Global_Config/agent/README.md")).toBe(false);
    expect(globToRegExp("doc/**").test("doc/history/2026/a.md")).toBe(true);
    expect(globToRegExp("doc/**").test("docs/a.md")).toBe(false);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("a/b/README.md")).toBe(true);
    expect(globToRegExp("HANDOFF.md").test("Tools/X/HANDOFF.md")).toBe(false);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });

  test("a pattern with GitHub operators this module does not model is refused", () => {
    for (const pattern of ["a?.md", "a+.md", "[ab].md", "a\\b", "doc**/a.md", "***/a.md", "a/b**"]) expect(() => globToRegExp(pattern)).toThrow();
  });
});

describe("parsePushPathsFilter", () => {
  test("reads paths-ignore and paths from the push trigger only", () => {
    const text = `on:\n  pull_request:\n    paths-ignore: [pr/**]\n  push:\n    branches: [main]\n    paths-ignore:\n      - "doc/**"\n`;
    expect(parsePushPathsFilter(text)).toEqual({ pathsIgnore: ["doc/**"] });
    expect(parsePushPathsFilter(`on:\n  push:\n    paths: ["**", "!doc/**"]\n`)).toEqual({ paths: ["**", "!doc/**"] });
  });

  test("tells no push trigger, an unfiltered push trigger and an unreadable file apart", () => {
    expect(parsePushPathsFilter(`on:\n  workflow_dispatch:\n`)).toBeNull();
    expect(parsePushPathsFilter(`on: push\n`)).toEqual({});
    expect(parsePushPathsFilter(`on: [push, pull_request]\n`)).toEqual({});
    expect(parsePushPathsFilter(`on:\n  push:\n    branches: [main]\n`)).toEqual({});
    expect(parsePushPathsFilter(`on:\n  push:\n    paths: [a]\n    paths-ignore: [b]\n`)).toBeUndefined();
    expect(parsePushPathsFilter(`on:\n  push:\n    paths-ignore: [1]\n`)).toBeUndefined();
    // GitHub needs one positive pattern in `paths`; a list of only `!` patterns, or an empty list, is not a filter to trust.
    expect(parsePushPathsFilter(`on:\n  push:\n    paths: ["!doc/**"]\n`)).toBeUndefined();
    expect(parsePushPathsFilter(`on:\n  push:\n    paths: []\n`)).toBeUndefined();
    expect(parsePushPathsFilter(`on:\n  push:\n    paths-ignore: []\n`)).toBeUndefined();
    expect(parsePushPathsFilter("a: [unclosed")).toBeUndefined();
    expect(parsePushPathsFilter("- just\n- a list\n")).toBeUndefined();
  });
});

describe("pushStartsWorkflow", () => {
  test("paths-ignore skips a push only when every changed file matches", () => {
    const filter = { pathsIgnore: ["doc/**", "HANDOFF.md"] };
    expect(pushStartsWorkflow(filter, ["doc/a.md", "HANDOFF.md"])).toBe(false);
    expect(pushStartsWorkflow(filter, ["doc/a.md", "lib/b.ts"])).toBe(true);
  });

  test("paths applies patterns in order, so a later ! removes and a later plain pattern restores", () => {
    const filter = { paths: ["**", "!Tools/**", "Tools/keep/**", "!Tools/keep/skip.md"] };
    expect(pushStartsWorkflow(filter, ["lib/a.ts"])).toBe(true);
    expect(pushStartsWorkflow(filter, ["Tools/other/a.ts"])).toBe(false);
    expect(pushStartsWorkflow(filter, ["Tools/keep/a.ts"])).toBe(true);
    expect(pushStartsWorkflow(filter, ["Tools/keep/skip.md"])).toBe(false);
    expect(pushStartsWorkflow(filter, ["Tools/other/a.ts", "Tools/keep/skip.md"])).toBe(false);
  });

  test("no filter, or no changed files, means the workflow starts; an unmodelled paths-ignore pattern throws", () => {
    expect(pushStartsWorkflow({}, ["a.md"])).toBe(true);
    expect(pushStartsWorkflow({ pathsIgnore: ["doc/**"] }, [])).toBe(true);
    expect(() => pushStartsWorkflow({ pathsIgnore: ["!doc/**"] }, ["doc/a.md"])).toThrow();
  });
});
