import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import { Settings } from "@oh-my-pi/pi-coding-agent";
import { getKnownRoleIds } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";

import { HARNESS_ROLES } from "./harness-roles.ts";
import { listModelRoles, writeModelRole } from "./model-roles.ts";

const MODEL = {
  id: "model-a",
  name: "Model A",
  api: "openai-completions",
  provider: "fixture",
  baseUrl: "http://127.0.0.1:9/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
// Model-kind roles draw from the registry; an empty one proves no provider is consulted.
const REGISTRY = { getAvailable: () => [] };
// Settings keeps each profile's agent.db open for the process; Windows cannot remove the
// folder until it is closed, so the fixtures are removed once every test here has run.
const roots = [];
after(() => {
  AgentStorage.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

/** A throwaway profile outside the repository: `agent/config.yml` plus a project folder. */
async function withProfile(configYml, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cuelo-model-roles-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const configPath = path.join(agentDir, "config.yml");
  fs.writeFileSync(configPath, configYml);
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("model roles must not call a provider");
  };
  try {
    const load = () => Settings.loadIsolated({ agentDir, cwd });
    await run({ load, configPath, cwd, fetches: () => fetches });
  } finally {
    globalThis.fetch = realFetch;
  }
}

const byRole = (rows) => Object.fromEntries(rows.map((row) => [row.role, row]));

test("a default-only profile lists every harness slot once as unset, without writing", async () => {
  await withProfile("modelRoles:\n  default: fixture/model-a\n", async ({ load, configPath, fetches }) => {
    const before = fs.readFileSync(configPath);
    const settings = await load();
    const rows = listModelRoles(settings, [MODEL], REGISTRY);

    const known = getKnownRoleIds(settings);
    for (const role of HARNESS_ROLES) assert.ok(!known.includes(role), `${role} is not known to the core yet`);
    // omp's own order comes first, untouched; the harness slots follow in their fixed order.
    assert.deepEqual(rows.map((row) => row.role), [...known, ...HARNESS_ROLES]);
    for (const role of HARNESS_ROLES) {
      const row = byRole(rows)[role];
      assert.equal(row.selector, undefined);
      assert.equal(row.resolved, undefined);
      assert.equal(row.warning, undefined);
      assert.equal(row.source, "default");
      assert.equal(row.builtin, false);
      assert.equal(row.hidden, false);
    }
    assert.equal(byRole(rows).default.selector, "fixture/model-a");

    await settings.flush();
    assert.deepEqual(fs.readFileSync(configPath), before, "listing roles never rewrites config.yml");
    assert.equal(fetches(), 0);
  });
});

test("assigned and tagged harness slots keep their place and metadata; only the rest are added", async () => {
  const config = [
    "modelRoles:",
    "  default: fixture/model-a",
    "  implOpus: fixture/model-a:high",
    "  implDeepSeek: fixture/gone-model",
    "modelTags:",
    "  implSonnet:",
    "    name: My Sonnet maker",
    "",
  ].join("\n");
  await withProfile(config, async ({ load, configPath }) => {
    const before = fs.readFileSync(configPath);
    const settings = await load();
    const rows = listModelRoles(settings, [MODEL], REGISTRY);
    const roles = byRole(rows);

    const known = getKnownRoleIds(settings);
    const added = HARNESS_ROLES.filter((role) => !known.includes(role));
    assert.deepEqual(added, ["makerHardUiOpus", "makerHardCodeOpus", "makerHardCodeSonnet"]);
    assert.deepEqual(rows.map((row) => row.role), [...known, ...added]);
    for (const role of HARNESS_ROLES) assert.equal(rows.filter((row) => row.role === role).length, 1);

    assert.equal(roles.implOpus.selector, "fixture/model-a:high");
    assert.equal(roles.implOpus.source, "global");
    assert.deepEqual(roles.implOpus.resolved, { provider: "fixture", modelId: "model-a", name: "Model A", thinkingLevel: "high" });
    // A saved selector the registry cannot resolve stays as written, with a warning.
    assert.equal(roles.implDeepSeek.selector, "fixture/gone-model");
    assert.equal(roles.implDeepSeek.resolved, undefined);
    assert.match(roles.implDeepSeek.warning, /gone-model/);
    assert.equal(roles.implSonnet.name, "My Sonnet maker");
    assert.equal(roles.implSonnet.selector, undefined);

    await settings.flush();
    assert.deepEqual(fs.readFileSync(configPath), before);
  });
});

test("an explicit save writes only the chosen slot to the chosen scope and reads back once", async () => {
  await withProfile("modelRoles:\n  default: fixture/model-a\n", async ({ load, configPath, cwd }) => {
    const settings = await load();
    writeModelRole(settings, "makerHardCodeOpus", "fixture/model-a:xhigh", "global");
    writeModelRole(settings, "implSonnet", "fixture/model-a", "project");
    await settings.flush();

    const reloaded = await load();
    const rows = listModelRoles(reloaded, [MODEL], REGISTRY);
    const roles = byRole(rows);
    for (const role of HARNESS_ROLES) assert.equal(rows.filter((row) => row.role === role).length, 1);
    assert.equal(roles.makerHardCodeOpus.selector, "fixture/model-a:xhigh");
    assert.equal(roles.makerHardCodeOpus.source, "global");
    assert.equal(roles.implSonnet.selector, "fixture/model-a");
    assert.equal(roles.implSonnet.source, "project");
    assert.equal(roles.default.selector, "fixture/model-a");
    for (const role of ["implOpus", "implDeepSeek", "makerHardUiOpus", "makerHardCodeSonnet"]) {
      assert.equal(roles[role].selector, undefined);
    }

    const global = fs.readFileSync(configPath, "utf8");
    assert.match(global, /makerHardCodeOpus: fixture\/model-a:xhigh/);
    assert.doesNotMatch(global, /implSonnet|implOpus|implDeepSeek|makerHardUiOpus|makerHardCodeSonnet/);
    const project = fs.readFileSync(path.join(cwd, ".omp", "config.yml"), "utf8");
    assert.match(project, /implSonnet: fixture\/model-a/);
    assert.doesNotMatch(project, /makerHardCodeOpus/);
  });
});
