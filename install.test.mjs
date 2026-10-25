import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import YAML from "yaml";
import {
  createProfileConfig,
  checkHealth,
  dropInTreeBunCache,
  portEnv,
  servicePorts,
  copyHarness,
  harnessEntries,
  HARNESS_ROLES,
  parseArgs,
  resolveProfile,
  HARNESS_MANIFEST,
  readHarnessManifest,
  recordHarnessInstall,
  diffHarness,
  updateHarness,
} from "./install.mjs";
import { HARNESS_ROLES as PANEL_HARNESS_ROLES } from "./lib/harness-roles.ts";

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cuelo-install-${name}-`));
}

function write(root, relative, text) {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
  fs.writeFileSync(path.join(root, relative), text);
}

test("the in-tree bun cache is removed, but a cache reached through a link is left alone", () => {
  const tree = tempDir("tree");
  const outside = tempDir("outside");
  try {
    write(tree, "own/.bun/install/cache/pkg/index.js", "stale\n");
    write(tree, "own/.bun/keep.txt", "keep\n");
    dropInTreeBunCache(path.join(tree, "own"));
    assert.equal(fs.existsSync(path.join(tree, "own/.bun/install/cache")), false);
    assert.equal(fs.readFileSync(path.join(tree, "own/.bun/keep.txt"), "utf8"), "keep\n");

    // A user who moved `.bun` (or `install`) out with a link points it at a shared cache.
    write(outside, "install/cache/pkg/index.js", "shared\n");
    for (const [link, target] of [[".bun", outside], [".bun/install", path.join(outside, "install")]]) {
      const home = path.join(tree, `linked-${link.replace(/\W/g, "")}`);
      fs.mkdirSync(path.dirname(path.join(home, link)), { recursive: true });
      fs.symlinkSync(target, path.join(home, link), "junction");
      dropInTreeBunCache(home);
      assert.equal(fs.readFileSync(path.join(outside, "install/cache/pkg/index.js"), "utf8"), "shared\n", link);
    }
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the installer and the Model roles panel name the same harness slots", () => {
  // install.mjs runs before dependencies exist and cannot import the app's TypeScript list.
  assert.deepEqual(HARNESS_ROLES, [...PANEL_HARNESS_ROLES]);
});

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

function harnessFixture() {
  const source = tempDir("source");
  const agentDir = tempDir("profile");
  write(source, "AGENTS.md", "agents v1\n");
  write(source, "rules/a.md", "rule a v1\n");
  write(source, "rules/b.md", "rule b v1\n");
  write(source, "extensions/x.ts", "x v1\n");
  write(source, "extensions/tests/x.test.ts", "test\n");
  const entries = ["AGENTS.md", "rules", "extensions"];
  const status = () => Object.fromEntries(diffHarness(source, agentDir, entries).files.map((file) => [file.path, file.status]));
  const cleanup = () => {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(agentDir, { recursive: true, force: true });
  };
  return { source, agentDir, entries, status, cleanup };
}

test("setup records the hash of what it copied and nothing for files that already existed", () => {
  const { source, agentDir, entries, cleanup } = harnessFixture();
  try {
    write(agentDir, "rules/b.md", "the user's own b\n");
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    const manifest = JSON.parse(fs.readFileSync(path.join(agentDir, HARNESS_MANIFEST), "utf8"));
    const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
    assert.equal(manifest.cuelo, "1.0.0");
    assert.deepEqual(manifest.files, {
      "AGENTS.md": sha("agents v1\n"),
      "extensions/x.ts": sha("x v1\n"),
      "rules/a.md": sha("rule a v1\n"),
      "rules/b.md": null,
    });

    // A second setup keeps the record of a file it still did not write.
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.1");
    assert.equal(readHarnessManifest(agentDir).files["rules/a.md"], sha("rule a v1\n"));
    assert.equal(readHarnessManifest(agentDir).files["rules/b.md"], null);
  } finally {
    cleanup();
  }
});

test("harness-diff tells an older unmodified file from a user edit, a missing file and an unrecorded one", () => {
  const { source, agentDir, entries, status, cleanup } = harnessFixture();
  try {
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    assert.deepEqual(Object.values(status()), ["identical", "identical", "identical", "identical"]);

    write(source, "AGENTS.md", "agents v2\n");          // distribution changed, profile untouched
    write(source, "rules/a.md", "rule a v2\n");         // distribution changed and the user edited it
    write(agentDir, "rules/a.md", "my rule a\n");
    write(agentDir, "rules/b.md", "my rule b\n");       // user edited, distribution unchanged
    fs.rmSync(path.join(agentDir, "extensions", "x.ts")); // deleted
    assert.deepEqual(status(), {
      "AGENTS.md": "update-available",
      "extensions/x.ts": "missing",
      "rules/a.md": "user-modified",
      "rules/b.md": "user-modified",
    });

    fs.rmSync(path.join(agentDir, HARNESS_MANIFEST));    // a profile from before the record existed
    assert.deepEqual(status(), {
      "AGENTS.md": "untracked",
      "extensions/x.ts": "missing",
      "rules/a.md": "untracked",
      "rules/b.md": "untracked",
    });
  } finally {
    cleanup();
  }
});

test("harness-update backs up and replaces only unmodified older files, adds missing ones, and never touches the rest or config.yml", () => {
  const { source, agentDir, entries, status, cleanup } = harnessFixture();
  try {
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    write(agentDir, "config.yml", "my config\n");
    write(source, "AGENTS.md", "agents v2\n");
    write(source, "rules/a.md", "rule a v2\n");
    write(agentDir, "rules/a.md", "my rule a\n");
    write(source, "extensions/x.ts", "x v2\n");
    fs.rmSync(path.join(agentDir, "rules", "b.md"));

    const dry = updateHarness(source, agentDir, entries, "2.0.0", { dryRun: true });
    assert.deepEqual([dry.updated, dry.added, dry.skipped["user-modified"], dry.backupDir], [["AGENTS.md", "extensions/x.ts"], ["rules/b.md"], ["rules/a.md"], null]);
    assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), "agents v1\n");
    assert.equal(fs.existsSync(path.join(agentDir, "rules", "b.md")), false);
    assert.equal(fs.existsSync(path.join(agentDir, ".cuelo-harness-backup")), false);
    assert.equal(readHarnessManifest(agentDir).cuelo, "1.0.0");

    const report = updateHarness(source, agentDir, entries, "2.0.0");
    assert.deepEqual([report.updated, report.added], [["AGENTS.md", "extensions/x.ts"], ["rules/b.md"]]);
    const read = (rel) => fs.readFileSync(path.join(agentDir, rel), "utf8");
    assert.equal(read("AGENTS.md"), "agents v2\n");
    assert.equal(read("extensions/x.ts"), "x v2\n");
    assert.equal(read("rules/b.md"), "rule b v1\n");
    assert.equal(read("rules/a.md"), "my rule a\n");
    assert.equal(read("config.yml"), "my config\n");
    assert.equal(fs.readFileSync(path.join(report.backupDir, "AGENTS.md"), "utf8"), "agents v1\n");
    assert.equal(fs.readFileSync(path.join(report.backupDir, "extensions", "x.ts"), "utf8"), "x v1\n");
    assert.equal(fs.existsSync(path.join(report.backupDir, "rules")), false);
    assert.equal(readHarnessManifest(agentDir).cuelo, "2.0.0");

    // Afterwards the written files are identical and a later distribution change is offered again; the user's file stays theirs.
    assert.deepEqual(status(), { "AGENTS.md": "identical", "extensions/x.ts": "identical", "rules/a.md": "user-modified", "rules/b.md": "identical" });
    write(source, "rules/b.md", "rule b v2\n");
    assert.equal(status()["rules/b.md"], "update-available");
  } finally {
    cleanup();
  }
});

test("harness-update leaves a linked profile file and an unreadable record alone", () => {
  const { source, agentDir, entries, status, cleanup } = harnessFixture();
  const outside = tempDir("outside");
  try {
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    write(source, "AGENTS.md", "agents v2\n");
    write(outside, "agents.md", "linked elsewhere\n");
    fs.rmSync(path.join(agentDir, "AGENTS.md"));
    fs.symlinkSync(path.join(outside, "agents.md"), path.join(agentDir, "AGENTS.md"));
    assert.equal(status()["AGENTS.md"], "untracked");
    updateHarness(source, agentDir, entries, "2.0.0");
    assert.equal(fs.readFileSync(path.join(outside, "agents.md"), "utf8"), "linked elsewhere\n");

    fs.writeFileSync(path.join(agentDir, HARNESS_MANIFEST), "{broken");
    assert.throws(() => updateHarness(source, agentDir, entries, "2.0.0"), /not readable/);
    assert.equal(fs.readFileSync(path.join(agentDir, HARNESS_MANIFEST), "utf8"), "{broken");
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a linked folder inside the profile is never written through, even for a tracked or missing file under it", () => {
  const { source, agentDir, entries, status, cleanup } = harnessFixture();
  const outside = tempDir("devrepo");
  try {
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    // The user points extensions/ at a checkout of their own.
    fs.cpSync(path.join(agentDir, "extensions"), path.join(outside, "extensions"), { recursive: true });
    fs.rmSync(path.join(agentDir, "extensions"), { recursive: true });
    fs.symlinkSync(path.join(outside, "extensions"), path.join(agentDir, "extensions"));
    write(source, "extensions/x.ts", "x v2\n");   // tracked, unmodified, newer distribution
    write(source, "extensions/y.ts", "y v1\n");   // missing
    assert.deepEqual([status()["extensions/x.ts"], status()["extensions/y.ts"]], ["untracked", "untracked"]);

    const report = updateHarness(source, agentDir, entries, "2.0.0");
    assert.deepEqual(report.skipped.untracked, ["extensions/x.ts", "extensions/y.ts"]);
    assert.equal(fs.readFileSync(path.join(outside, "extensions", "x.ts"), "utf8"), "x v1\n");
    assert.equal(fs.existsSync(path.join(outside, "extensions", "y.ts")), false);
    assert.equal(fs.existsSync(path.join(agentDir, ".cuelo-harness-backup")), false);
    // The record of the skipped tracked file survives, so it is offered again once the link is gone.
    assert.notEqual(readHarnessManifest(agentDir).files["extensions/x.ts"], null);
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("a linked backup folder stops the overwrite: nothing is written outside and the file keeps its bytes", () => {
  const { source, agentDir, entries, cleanup } = harnessFixture();
  const outside = tempDir("backups");
  const now = new Date("2026-10-25T00:00:00.000Z");
  const stamp = "2026-10-25T00-00-00-000Z";
  try {
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    write(source, "AGENTS.md", "agents v2\n");
    for (const link of [".cuelo-harness-backup", `.cuelo-harness-backup/${stamp}`]) {
      fs.rmSync(path.join(agentDir, ".cuelo-harness-backup"), { recursive: true, force: true });
      if (link.includes("/")) fs.mkdirSync(path.join(agentDir, ".cuelo-harness-backup"));
      fs.symlinkSync(outside, path.join(agentDir, link));
      const report = updateHarness(source, agentDir, entries, "2.0.0", { now });
      assert.deepEqual([report.updated, report.skipped["backup-unsafe"], report.backupDir], [[], ["AGENTS.md"], null], link);
      assert.equal(fs.readFileSync(path.join(agentDir, "AGENTS.md"), "utf8"), "agents v1\n", link);
      assert.deepEqual(fs.readdirSync(outside), [], link);
    }
  } finally {
    cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("setup leaves an unreadable install record byte for byte as it was", () => {
  const { source, agentDir, entries, cleanup } = harnessFixture();
  try {
    write(agentDir, HARNESS_MANIFEST, "{broken");
    const result = recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "2.0.0");
    assert.match(result.skipped, /not readable/);
    assert.equal(fs.readFileSync(path.join(agentDir, HARNESS_MANIFEST), "utf8"), "{broken");
    assert.deepEqual(fs.readdirSync(agentDir).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    cleanup();
  }
});

test("harness-update re-checks a file right before it writes: an edit or a new file made after the plan survives", () => {
  const { source, agentDir, entries, cleanup } = harnessFixture();
  const realRead = fs.readFileSync;
  const realCopy = fs.copyFileSync;
  try {
    recordHarnessInstall(agentDir, copyHarness(source, agentDir, entries), "1.0.0");
    write(source, "AGENTS.md", "agents v2\n");
    write(source, "rules/b.md", "rule b v2\n");
    fs.rmSync(path.join(agentDir, "rules", "b.md"));
    const agents = path.join(agentDir, "AGENTS.md");
    const b = path.join(agentDir, "rules", "b.md");

    // The user saves AGENTS.md right after the plan read it, and creates rules/b.md right before the add.
    let planReads = 0;
    fs.readFileSync = (file, ...rest) => {
      const bytes = realRead(file, ...rest);
      if (file === agents && ++planReads === 1) fs.writeFileSync(agents, "my agents\n");
      return bytes;
    };
    fs.copyFileSync = (from, to, ...rest) => {
      if (to === b) fs.writeFileSync(b, "my b\n");
      return realCopy(from, to, ...rest);
    };
    const report = updateHarness(source, agentDir, entries, "2.0.0");
    fs.readFileSync = realRead;
    fs.copyFileSync = realCopy;

    assert.deepEqual([report.updated, report.added], [[], []]);
    assert.deepEqual([report.skipped["user-modified"], report.skipped.untracked], [["AGENTS.md"], ["rules/b.md"]]);
    assert.equal(realRead(agents, "utf8"), "my agents\n");
    assert.equal(realRead(b, "utf8"), "my b\n");
    assert.equal(fs.existsSync(path.join(agentDir, ".cuelo-harness-backup")), false);
  } finally {
    fs.readFileSync = realRead;
    fs.copyFileSync = realCopy;
    cleanup();
  }
});

test("harness-diff and harness-update take --home, --json and (update only) --dry-run", () => {
  assert.deepEqual(
    [parseArgs(["harness-diff", "--json", "--home", "/h"]).json, parseArgs(["harness-update", "--dry-run"]).dryRun, parseArgs(["harness-update"]).dryRun],
    [true, true, false],
  );
  assert.throws(() => parseArgs(["harness-diff", "--dry-run"]), /needs a value|unknown option/);
  assert.throws(() => parseArgs(["setup", "--json"]), /unknown option|needs a value/);
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
    assert.equal(config.task.enableLsp, true, "new Maker profiles must allow their declared LSP tool");
    assert.equal(config.task.structured, true, "Maker yield contract needs structured task results (core default is false)");

    // Without models the profile still gets the defaults, and no guessed modelRoles.
    const plain = createProfileConfig(bare, {});
    assert.equal(plain.written, true);
    const plainConfig = YAML.parse(fs.readFileSync(plain.configPath, "utf8"));
    assert.equal(plainConfig.task.enableLsp, true);
    assert.equal("modelRoles" in plainConfig, false);
    assert.deepEqual(plain.missing, ["default", ...HARNESS_ROLES]);

    config.task.enableLsp = false;
    fs.writeFileSync(result.configPath, YAML.stringify(config));
    const before = fs.readFileSync(result.configPath);
    const again = createProfileConfig(agentDir, { implSonnet: "openai-codex/gpt-6-sol:high" });
    assert.equal(again.written, false);
    assert.deepEqual(again.ignored, ["implSonnet"]);
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

test("only start accepts an explicit listener address", () => {
  assert.equal(parseArgs(["start", "--hostname", "0.0.0.0"]).hostname, "0.0.0.0");
  assert.throws(() => parseArgs(["setup", "--hostname", "0.0.0.0"]), /unknown option for setup/);
  assert.throws(() => parseArgs(["health", "--hostname", "0.0.0.0"]), /unknown option for health/);
  assert.throws(() => parseArgs(["start", "--hostname"]), /needs a value/);
});

test("health authenticates only the web service and never leaks the password to sidecars", async () => {
  const previous = process.env.CUELO_PASSWORD;
  process.env.CUELO_PASSWORD = "health-test-password";
  const expected = `Basic ${Buffer.from("omp:health-test-password").toString("base64")}`;
  const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(null, { status: req.headers.get("authorization") === expected ? 200 : 401 }) });
  const sidecar = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => new Response(null, { status: req.headers.has("authorization") ? 400 : 204 }) });
  try {
    const result = await checkHealth([
      { name: "web", port: web.port, method: "GET", path: "/", expect: 200 },
      { name: "usage", port: sidecar.port, method: "OPTIONS", path: "/", expect: 204 },
    ]);
    assert.deepEqual(result.map(({ ok, status }) => ({ ok, status })), [{ ok: true, status: 200 }, { ok: true, status: 204 }]);
  } finally {
    if (previous === undefined) delete process.env.CUELO_PASSWORD; else process.env.CUELO_PASSWORD = previous;
    web.stop(true); sidecar.stop(true);
  }
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
