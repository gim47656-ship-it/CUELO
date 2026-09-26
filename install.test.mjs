import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  createProfileConfig,
  PROFILE_DEFAULTS,
  checkHealth,
  portEnv,
  servicePorts,
  copyHarness,
  harnessEntries,
  HARNESS_ROLES,
  parseArgs,
  resolveProfile,
} from "./install.mjs";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cuelo-install-${name}-`));
}

function write(root, relative, text) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}

test("harness copy adds only the listed public files and keeps every existing profile file", () => {
  const source = tempDir("source");
  const agentDir = tempDir("profile");
  try {
    write(source, "AGENTS.md", "public agents\n");
    write(source, "rules/subagent.md", "public rule\n");
    write(source, "extensions/voice.ts", "export default () => {};\n");
    write(source, "extensions/tests/voice.test.ts", "test\n");
    write(source, "extensions/guard/index.test.ts", "test\n");
    write(source, "config.yml", "personal\n");
    write(source, "models.yml", "personal\n");
    write(source, "skills/private/SKILL.md", "personal\n");
    write(agentDir, "rules/subagent.md", "the user's own edit\n");
    write(agentDir, "config.yml", "the user's config\n");

    const entries = harnessEntries([
      "bin",
      "Tools/OMP_Global_Config/agent/AGENTS.md",
      "Tools/OMP_Global_Config/agent/rules",
      "Tools/OMP_Global_Config/agent/extensions",
      "!Tools/OMP_Global_Config/agent/**/tests",
    ]);
    const report = copyHarness(source, agentDir, entries);

    assert.deepEqual(report.created.map((file) => file.replaceAll("\\", "/")).sort(), ["AGENTS.md", "extensions/voice.ts"]);
    assert.deepEqual(report.kept.map((file) => file.replaceAll("\\", "/")), ["rules/subagent.md"]);
    assert.equal(fs.readFileSync(path.join(agentDir, "rules", "subagent.md"), "utf8"), "the user's own edit\n");
    assert.equal(fs.readFileSync(path.join(agentDir, "config.yml"), "utf8"), "the user's config\n");
    for (const absent of ["models.yml", "skills", path.join("extensions", "tests"), path.join("extensions", "guard")]) {
      assert.equal(fs.existsSync(path.join(agentDir, absent)), false, absent);
    }
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test("a new profile gets the safe defaults and exactly the named model roles; an existing config is never touched", () => {
  const agentDir = tempDir("roles");
  const bare = tempDir("bare");
  try {
    const roles = parseArgs(["setup", "--model", "anthropic/claude-opus-5-5", "--role", "implOpus=anthropic/claude-opus-5-5:high"]).roles;
    const result = createProfileConfig(agentDir, roles);
    assert.equal(result.written, true);
    const config = YAML.parse(fs.readFileSync(result.configPath, "utf8"));
    // --model is the core default only; family-specific Maker slots are never filled from it.
    assert.deepEqual(config.modelRoles, {
      default: "anthropic/claude-opus-5-5",
      implOpus: "anthropic/claude-opus-5-5:high",
    });
    assert.deepEqual(result.missing, HARNESS_ROLES.filter((name) => name !== "implOpus"));
    // Nothing that spends provider requests on its own is switched on.
    assert.equal(config.autolearn.autoContinue, false);
    assert.equal(config.mnemopi.autoRetain, false);
    assert.deepEqual({ ...config, modelRoles: undefined }, { ...PROFILE_DEFAULTS, modelRoles: undefined });

    // Without models the profile still gets the defaults, and no guessed modelRoles.
    const plain = createProfileConfig(bare, {});
    assert.equal(plain.written, true);
    assert.deepEqual(YAML.parse(fs.readFileSync(plain.configPath, "utf8")), PROFILE_DEFAULTS);
    assert.deepEqual(plain.missing, ["default", ...HARNESS_ROLES]);

    const before = fs.readFileSync(result.configPath);
    const again = createProfileConfig(agentDir, { implSol: "openai-codex/gpt-6-sol:high" });
    assert.equal(again.written, false);
    assert.deepEqual(again.ignored, ["implSol"]);
    assert.deepEqual(fs.readFileSync(result.configPath), before, "an existing config.yml is never rewritten");
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test("setup refuses role names and selectors the harness does not route to", () => {
  assert.throws(() => parseArgs(["setup", "--role", "review=openai-codex/gpt-6-sol"]), /--role takes/);
  assert.throws(() => parseArgs(["setup", "--model", "claude-opus-5-5"]), /provider/);
  assert.throws(() => parseArgs(["health", "--home", "x"]), /unknown option for health/);
  assert.throws(() => parseArgs(["deploy"]), /unknown command/);
});

test("--home moves every profile variable the SDK and sidecars read", () => {
  const home = path.resolve("fixture-home");
  const profile = resolveProfile(home, { PATH: "p", PI_CODING_AGENT_DIR: "elsewhere" });
  const agentDir = path.join(home, ".omp", "agent");
  assert.equal(profile.agentDir, agentDir);
  assert.deepEqual(profile.env, { PATH: "p", PI_CODING_AGENT_DIR: agentDir, HOME: home, USERPROFILE: home });
});

test("one port set reaches every service; defaults stay when nothing is named", () => {
  const ports = (services) => services.map((service) => service.port);
  assert.deepEqual(ports(servicePorts(null, {})), [30141, 30142, 30143, 30144]);
  assert.deepEqual(ports(servicePorts(null, { PORT: "31141", OMP_BTW_PORT: "http://evil:1", OMP_SUBAGENT_PORT: "70000" })), [31141, 30142, 30143, 30144]);
  const base = parseArgs(["start", "--port-base", "31141"]).portBase;
  assert.deepEqual(portEnv(servicePorts(base, { PORT: "1" })), {
    PORT: "31141", OMP_USAGE_PORT: "31142", OMP_BTW_PORT: "31143", OMP_SUBAGENT_PORT: "31144",
  });
  assert.equal(parseArgs(["health", "--port-base", "65532"]).portBase, 65532);
  for (const bad of ["65533", "0", "abc", "31141.5", "127.0.0.1:31141"]) {
    assert.throws(() => parseArgs(["start", "--port-base", bad]), /--port-base takes/);
  }
  assert.throws(() => parseArgs(["setup", "--port-base", "31141"]), /unknown option for setup/);
});

test("health reports each service by its own contract and a closed port as a failure", async () => {
  const listening = [
    Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(null, { status: req.method === "OPTIONS" ? 204 : 405 }) }),
    Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("wrong", { status: 500 }) }),
  ];
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const closedPort = closed.port;
  closed.stop(true);
  try {
    const results = await checkHealth([
      { name: "usage", port: listening[0].port, method: "OPTIONS", path: "/usage", expect: 204 },
      { name: "btw", port: listening[1].port, method: "GET", path: "/health", expect: 200 },
      { name: "subagent", port: closedPort, method: "GET", path: "/health", expect: 200 },
    ], 1000);
    assert.deepEqual(results.map((result) => [result.name, result.ok, result.status]), [
      ["usage", true, 204],
      ["btw", false, 500],
      ["subagent", false, null],
    ]);
  } finally {
    for (const server of listening) server.stop(true);
  }
});
