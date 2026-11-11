import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import register from "../auto-effort";
import { decideAutoEffort, parseAutoEffortConfig, type AutoEffortConfig, type AutoEffortInput } from "../lib/auto-effort-policy";

const input = (overrides: Partial<AutoEffortInput> = {}): AutoEffortInput => ({
  provider: "synthetic", modelId: "base", supportedEfforts: ["low", "medium", "high", "xhigh"],
  request: "A substantive request with enough evidence for classification", raiseOnly: false, ...overrides,
});
const defaults = parseAutoEffortConfig(undefined);
const tiers: AutoEffortConfig = { ...defaults, tiers: [
  { floor: "medium", models: ["synthetic/base", "other/*"] },
  { floor: "high", models: ["*/*", "synthetic/base"] },
] };

const key = Symbol.for("cuelo.autoThinkingPolicy");
const originalPolicy = Reflect.get(globalThis, key);
const originalDir = process.env.PI_CODING_AGENT_DIR;
const scratch: string[] = [];
afterEach(() => {
  if (originalPolicy === undefined) Reflect.deleteProperty(globalThis, key);
  else Reflect.set(globalThis, key, originalPolicy);
  if (originalDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalDir;
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("model base floors", () => {
  test.each([
    ["synthetic", "base", "medium"], ["SYNTHETIC", "BASE", "medium"],
    ["other", "anything/else", "medium"], ["synthetic", "base-extra", "high"],
  ])("%s/%s selects %s in tier order", (provider, modelId, floor) => {
    expect(decideAutoEffort(input({ provider, modelId }), tiers)).toEqual({ floor });
  });
  test("whole selector and literal regex characters, with no-match fallback", () => {
    const config = { ...defaults, tiers: [{ floor: "high" as const, models: ["synthetic/model.+", "prefix/*end"] }] };
    expect(decideAutoEffort(input({ modelId: "model.+" }), config)).toEqual({ floor: "high" });
    expect(decideAutoEffort(input({ modelId: "modelZZ" }), config)).toEqual({});
    expect(decideAutoEffort(input({ provider: "prefix", modelId: "end" }), config)).toEqual({ floor: "high" });
    expect(decideAutoEffort(input({ provider: "prefix", modelId: "ending" }), config)).toEqual({});
  });
});

describe("evidence holds", () => {
  test.each([
    ["[자동 재개] continue with a long notice body", true],
    ["  [하네스 통지] long operational notice with whitespace", true],
    ["a".repeat(20), true], ["a".repeat(21), false],
    ["한".repeat(20), true], ["한".repeat(21), false],
    ["😀".repeat(20), true], ["😀".repeat(21), false],
    [" ", true], ["prefix [하네스 통지] substantive request", false],
  ])("request %s hold=%s", (request, hold) => {
    expect(decideAutoEffort(input({ request }), defaults).hold === true).toBe(hold);
  });
  test("new text outranks accumulated request and solution space", () => {
    expect(decideAutoEffort(input({ added: "yes", solutionSpace: "Open-ended substantive assignment" }), defaults)).toEqual({ hold: true });
    expect(decideAutoEffort(input({ added: "", solutionSpace: "Open-ended substantive assignment" }), defaults)).toEqual({ hold: true });
    expect(decideAutoEffort(input({ request: "yes", added: "A substantive newly added requirement with evidence" }), defaults)).toEqual({});
  });
  test("short solution space classifies, but notice solution space holds", () => {
    expect(decideAutoEffort(input({ request: "yes", solutionSpace: "bounded" }), defaults)).toEqual({});
    expect(decideAutoEffort(input({ solutionSpace: "  " }), defaults)).toEqual({});
    expect(decideAutoEffort(input({ solutionSpace: "[하네스 통지] long body" }), defaults)).toEqual({ hold: true });
  });
  test.each([
    ["low", "high", "max"],
    ["minimal", "low", "medium", "high"],
  ])("one eligible effort in %j skips classification", (...supportedEfforts) => {
    const value = input({ modelId: "sparse", supportedEfforts, solutionSpace: "bounded" });
    expect(decideAutoEffort(value, tiers)).toEqual({ floor: "high", hold: true });
    expect(decideAutoEffort(value, defaults)).toEqual({});
  });
});

describe("flat private config", () => {
  test.each([undefined, null, {}, 42, "", "autoEffort: []\n", "unrelated:\n  holdMaxChars: 100\n"])("missing/malformed %j uses defaults", raw => {
    expect(parseAutoEffortConfig(raw)).toEqual({ holdMaxChars: 20, noticePrefixes: ["[자동 재개]", "[하네스 통지]"], tiers: [] });
  });
  test("two lists have fixed medium-first order and respect block boundaries", () => {
    const config = parseAutoEffortConfig('\uFEFFautoEffort: # private\r\n  floorHigh: "synthetic/*, other/b"\r\n  holdMaxChars: 0\r\n  floorMedium: \'synthetic/a, */base\' # lower wins\r\n  noticePrefixes: "ignored"\r\nnext:\r\n  holdMaxChars: 99\r\n');
    expect(config).toEqual({ holdMaxChars: 0, noticePrefixes: defaults.noticePrefixes, tiers: [
      { floor: "medium", models: ["synthetic/a", "*/base"] }, { floor: "high", models: ["synthetic/*", "other/b"] },
    ] });
    expect(decideAutoEffort(input({ modelId: "a" }), config)).toEqual({ floor: "medium" });
    expect(decideAutoEffort(input({ modelId: "other", request: "x" }), config)).toEqual({ floor: "high" });
  });
  test.each(["-1", "1.5", "NaN", "9007199254740992", "[]", "true", "\"oops\""])("bad length %s is skipped independently", value => {
    expect(parseAutoEffortConfig(`autoEffort:\n  holdMaxChars: ${value}\n  floorHigh: "synthetic/*"\n`)).toEqual({
      ...defaults, tiers: [{ floor: "high", models: ["synthetic/*"] }],
    });
  });
  test("malformed list and nested settings do not poison valid fields", () => {
    expect(parseAutoEffortConfig('autoEffort:\n  floorMedium: [broken]\n  floorHigh: "synthetic/*"\n    holdMaxChars: 100\n')).toEqual({
      ...defaults, tiers: [{ floor: "high", models: ["synthetic/*"] }],
    });
  });
  test("digit-leading selector patterns are strings, not malformed numbers", () => {
    const config = parseAutoEffortConfig('autoEffort:\n  floorHigh: "302synthetic/*, -2synthetic/*, synthetic/*"\n');
    expect(config.tiers).toEqual([{ floor: "high", models: ["302synthetic/*", "-2synthetic/*", "synthetic/*"] }]);
    expect(decideAutoEffort(input({ provider: "302synthetic" }), config)).toEqual({ floor: "high" });
  });
});

test("promotion patterns match independently and change sparse rule C", () => {
  const config = parseAutoEffortConfig('autoEffort:\n  floorHigh: "synthetic/*"\n  xhighAsMax: "*promoted"\n');
  const sparse = input({ modelId: "promoted", supportedEfforts: ["low", "high", "max"] });
  expect(decideAutoEffort(sparse, config)).toEqual({ floor: "high", xhighAsMax: true });
  expect(decideAutoEffort({ ...sparse, modelId: "ordinary" }, config)).toEqual({ floor: "high", hold: true });
  expect(decideAutoEffort({ ...sparse, provider: "OTHER", modelId: "PROMOTED" }, config)).toEqual({ xhighAsMax: true });
  expect(decideAutoEffort({ ...sparse, request: "ok" }, config)).toEqual({ floor: "high", hold: true, xhighAsMax: true });
  expect(decideAutoEffort({ ...sparse, supportedEfforts: ["low", "high", "xhigh", "max"] }, config)).toEqual({ floor: "high", xhighAsMax: true });
  expect(decideAutoEffort({ ...sparse, supportedEfforts: ["low", "high"] }, config)).toEqual({ floor: "high", hold: true, xhighAsMax: true });
});

test("promotion list survives the core YAML rewrite and ignores malformed fields", () => {
  const raw = 'autoEffort:\n  holdMaxChars: 20\n  floorMedium: "synthetic/medium, other/*"\n  floorHigh: "synthetic/*"\n  xhighAsMax: "*promoted, 302synthetic/*"\n';
  expect(parseAutoEffortConfig(Bun.YAML.stringify(Bun.YAML.parse(raw), null, 2))).toEqual(parseAutoEffortConfig(raw));
  expect(parseAutoEffortConfig(raw).xhighAsMax).toEqual(["*promoted", "302synthetic/*"]);
  expect(parseAutoEffortConfig("autoEffort:\n  xhighAsMax: [broken]\n")).toEqual(defaults);
});

describe("per-model Auto ceiling", () => {
  test("capHigh parses flat wildcard lists with the existing guards and YAML rewrite", () => {
    const raw = 'autoEffort:\n  capHigh: "*claude-opus-*, 302synthetic/*"\nnext:\n  capHigh: "ignored/*"\n';
    expect(parseAutoEffortConfig(raw).capHigh).toEqual(["*claude-opus-*", "302synthetic/*"]);
    expect(parseAutoEffortConfig(Bun.YAML.stringify(Bun.YAML.parse(raw), null, 2))).toEqual(parseAutoEffortConfig(raw));
    for (const value of ["[broken]", "true", "42", "null"]) {
      expect(parseAutoEffortConfig(`autoEffort:\n  capHigh: ${value}\n`)).toEqual(defaults);
    }
  });
  test("ceiling matches independently while an unmatched model keeps its floor and range", () => {
    const config = parseAutoEffortConfig('autoEffort:\n  floorMedium: "*claude-*"\n  capHigh: "*claude-opus-*"\n');
    expect(decideAutoEffort(input({ modelId: "CLAUDE-OPUS-FIXTURE" }), config)).toEqual({ floor: "medium", ceiling: "high" });
    expect(decideAutoEffort(input({ modelId: "claude-other" }), config)).toEqual({ floor: "medium" });
    expect(decideAutoEffort(input(), config)).toEqual({});
  });
  test("single eligible level counts only the inclusive floor to ceiling range", () => {
    const config = parseAutoEffortConfig('autoEffort:\n  floorHigh: "synthetic/*"\n  capHigh: "synthetic/*"\n  xhighAsMax: "synthetic/*"\n');
    expect(decideAutoEffort(input(), config)).toEqual({ floor: "high", ceiling: "high", hold: true, xhighAsMax: true });
    expect(decideAutoEffort(input({ supportedEfforts: ["low", "high", "max"] }), config)).toEqual({ floor: "high", ceiling: "high", hold: true, xhighAsMax: true });
    expect(decideAutoEffort(input(), { ...config, tiers: [{ floor: "xhigh", models: ["*"] }] })).toEqual({ floor: "xhigh", ceiling: "high", hold: true, xhighAsMax: true });
  });
});

test("registered policy matches pure policy across reload, mtime change and missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "auto-effort-"));
  scratch.push(dir);
  process.env.PI_CODING_AGENT_DIR = dir;
  const path = join(dir, "config.yml");
  const raw = 'autoEffort:\n  holdMaxChars: 2\n  floorHigh: "synthetic/*"\n  capHigh: "synthetic/*"\n';
  writeFileSync(path, raw);
  register({} as never);
  register({} as never);
  const policy = Reflect.get(globalThis, key) as (value: AutoEffortInput) => unknown;
  expect(policy(input())).toEqual({ floor: "high", ceiling: "high", hold: true });
  for (const value of [input(), input({ request: "hi" }), input({ added: "new evidence longer than two" })]) {
    expect(policy(value)).toEqual(decideAutoEffort(value, parseAutoEffortConfig(raw)));
  }
  writeFileSync(path, raw.replace("floorHigh", "floorMedium"));
  const future = new Date(Date.now() + 2000);
  utimesSync(path, future, future);
  expect(policy(input())).toEqual({ floor: "medium", ceiling: "high" });
  process.env.PI_CODING_AGENT_DIR = join(dir, "missing");
  expect(policy(input({ request: "hi" }))).toEqual({ hold: true });
});
