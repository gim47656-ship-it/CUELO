import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { discoverSessionExtensionPaths, Settings } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";

const {
  discoverCodeWithoutProjectSettingsExtensions,
  getProjectTrustStatus,
  hasTrustRequiringProjectResources,
  isInsideProject,
  setProjectTrust,
  trustProject,
  untrustedProjectSessionOptions,
} = await createJiti(import.meta.url).import("./project-trust.ts");

/** Settings without a project layer, for cases that depend on project directories alone. */
const noProjectSettings = Settings.isolated();

async function createProjectFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cuelo-project-trust-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cwd, agentDir };
}

/**
 * A fixture whose user scope (agent dir and home) is private to the test, so
 * omp's settings and discovery read only the files the test writes.
 */
async function createIsolatedOmpFixture(t) {
  const fixture = await createProjectFixture(t);
  const home = join(fixture.root, "home");
  await mkdir(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousAgentDir = getAgentDir();
  process.env.HOME = home;
  setAgentDir(fixture.agentDir);
  t.after(() => {
    process.env.HOME = previousHome;
    setAgentDir(previousAgentDir);
  });
  return fixture;
}

async function writeExtension(dir, file = "index.ts") {
  await mkdir(dir, { recursive: true });
  const path = join(dir, file);
  await writeFile(path, "export default () => {};\n");
  return path;
}

function loadSettings(cwd, agentDir) {
  return Settings.loadReadOnly({ cwd, agentDir });
}

/** Trusted and clean projects take omp's own load path without the gated discovery. */
async function discoveryNotExpected() {
  throw new Error("gated discovery ran for a project that is not gated");
}

test("clean projects stay on the normal trusted load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);

  assert.equal(hasTrustRequiringProjectResources(cwd, noProjectSettings), false);
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), {
    requiresTrust: false,
    trusted: true,
  });
  assert.equal(await untrustedProjectSessionOptions(cwd, agentDir, noProjectSettings, discoveryNotExpected), undefined);
});

test("code-bearing project directories require an explicit trust decision", async (t) => {
  for (const dir of [".omp/extensions", ".omp/hooks", ".omp/tools", ".claude/tools", ".agents/hooks"]) {
    const { cwd, agentDir } = await createProjectFixture(t);
    await mkdir(join(cwd, dir), { recursive: true });

    assert.equal(hasTrustRequiringProjectResources(cwd, noProjectSettings), true, dir);
    assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), { requiresTrust: true, trusted: false }, dir);
  }
});

test("an MCP manifest requires trust because omp would spawn its servers", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await writeFile(join(cwd, ".mcp.json"), "{}");

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), { requiresTrust: true, trusted: false });
});

test("skills and rules alone never require trust", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "skills", "demo"), { recursive: true });
  await writeFile(join(cwd, ".omp", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\n");

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), { requiresTrust: false, trusted: true });
});

test("a project settings file that configures extension roots requires trust", async (t) => {
  for (const [file, content] of [
    [".omp/settings.json", JSON.stringify({ extensions: ["./build-ext"] })],
    [".claude/settings.json", JSON.stringify({ extensions: ["./build-ext"] })],
    [".omp/config.yml", "extensions:\n  - ./build-ext\n"],
  ]) {
    const { cwd, agentDir } = await createIsolatedOmpFixture(t);
    await writeExtension(join(cwd, "build-ext"));
    await mkdir(join(cwd, file, ".."), { recursive: true });
    await writeFile(join(cwd, file), content);

    const settings = await loadSettings(cwd, agentDir);
    assert.deepEqual(getProjectTrustStatus(cwd, agentDir, settings), { requiresTrust: true, trusted: false }, file);
  }
});

test("a project settings file with no existing extension roots does not require trust", async (t) => {
  const { cwd, agentDir } = await createIsolatedOmpFixture(t);
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: ["./missing"] }));

  const settings = await loadSettings(cwd, agentDir);
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, settings), { requiresTrust: false, trusted: true });
});

test("a legacy .omp/settings.json extension list requires trust even when another project file empties `extensions`", async (t) => {
  const { root, cwd, agentDir } = await createIsolatedOmpFixture(t);
  const outside = join(root, "outside-ext");
  const outsideExtension = await writeExtension(outside);
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: [outside] }));
  await writeFile(join(cwd, ".omp", "config.yml"), "extensions: []\n");
  const settings = await loadSettings(cwd, agentDir);
  // omp's native provider still loads the legacy list though the merged setting is empty.
  assert.ok((await discoverSessionExtensionPaths({}, cwd, settings)).includes(outsideExtension));

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, settings), { requiresTrust: true, trusted: false });
  const gated = await untrustedProjectSessionOptions(cwd, agentDir, settings, () =>
    discoverCodeWithoutProjectSettingsExtensions(settings, cwd),
  );
  assert.ok(gated && !gated.preloadedExtensionPaths.includes(outsideExtension));
});

test("an untrusted project's settings-configured root outside the project stays unloaded until trusted", async (t) => {
  const { root, cwd, agentDir } = await createIsolatedOmpFixture(t);
  const outside = join(root, "outside-ext");
  const outsideExtension = await writeExtension(outside);
  const outsideHook = await writeExtension(join(outside, "hooks", "pre"), "hook.ts");
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(join(cwd, ".omp", "settings.json"), JSON.stringify({ extensions: [outside] }));
  const settings = await loadSettings(cwd, agentDir);

  const gated = await untrustedProjectSessionOptions(cwd, agentDir, settings, () =>
    discoverCodeWithoutProjectSettingsExtensions(settings, cwd),
  );
  assert.ok(gated, "the untrusted project is gated");
  assert.ok(!gated.preloadedExtensionPaths.includes(outsideExtension));
  assert.ok(!gated.preloadedExtensionPaths.includes(outsideHook));
  assert.equal(gated.enableMCP, false);

  setProjectTrust(cwd, agentDir, true);
  assert.equal(await untrustedProjectSessionOptions(cwd, agentDir, settings, discoveryNotExpected), undefined);
  assert.ok((await discoverSessionExtensionPaths({}, cwd, settings)).includes(outsideExtension));
});

test("an untrusted project cannot unload user-level extensions by naming their roots", async (t) => {
  const { root, cwd, agentDir } = await createIsolatedOmpFixture(t);
  const userConfiguredRoot = join(root, "user-ext");
  const userConfiguredExtension = await writeExtension(userConfiguredRoot);
  const guard = await writeExtension(join(agentDir, "extensions"), "guard.ts");
  await writeFile(join(agentDir, "config.yml"), `extensions:\n  - ${userConfiguredRoot}\n`);
  const projectOnly = join(root, "project-only-ext");
  const projectOnlyExtension = await writeExtension(projectOnly);
  await mkdir(join(cwd, ".omp"), { recursive: true });
  await writeFile(
    join(cwd, ".omp", "settings.json"),
    JSON.stringify({ extensions: [join(agentDir, "extensions"), root, projectOnly] }),
  );
  const settings = await loadSettings(cwd, agentDir);
  assert.ok((await discoverSessionExtensionPaths({}, cwd, settings)).includes(projectOnlyExtension));

  const gated = await untrustedProjectSessionOptions(cwd, agentDir, settings, () =>
    discoverCodeWithoutProjectSettingsExtensions(settings, cwd),
  );
  assert.ok(gated, "the untrusted project is gated");
  assert.ok(gated.preloadedExtensionPaths.includes(guard), "user extension dir still loads");
  assert.ok(gated.preloadedExtensionPaths.includes(userConfiguredExtension), "user-level configured root still loads");
  assert.ok(!gated.preloadedExtensionPaths.includes(projectOnlyExtension), "project-only root stays unloaded");
});

test("an untrusted project drops only its own extensions, tools, and MCP servers", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });

  const projectExtension = join(cwd, ".omp", "extensions", "probe.ts");
  const userExtension = join(agentDir, "extensions", "user.ts");
  const projectTool = { path: join(cwd, ".omp", "tools", "probe.ts"), source: { level: "project" } };
  const userTool = { path: join(agentDir, "tools", "user.ts"), source: { level: "user" } };

  const gated = await untrustedProjectSessionOptions(cwd, agentDir, noProjectSettings, async () => ({
    extensionPaths: [projectExtension, userExtension],
    customToolPaths: [projectTool, userTool],
  }));

  assert.deepEqual(gated.preloadedExtensionPaths, [userExtension]);
  assert.deepEqual(gated.preloadedCustomToolPaths, [userTool]);
  assert.equal(gated.enableMCP, false);
});

test("an untrusted project retains user code on another Windows drive", { skip: process.platform !== "win32" }, async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "tools"), { recursive: true });
  const userDrive = cwd[0].toUpperCase() === "C" ? "D" : "C";
  const userRoot = `${userDrive}:\\Users\\test\\.omp\\agent`;
  const projectExtension = join(cwd, ".omp", "extensions", "probe.ts");
  const userExtension = join(userRoot, "extensions", "user.ts");
  const projectTool = { path: join(cwd, ".omp", "tools", "probe.ts"), source: { level: "project" } };
  const userTool = { path: join(userRoot, "tools", "user.ts"), source: { level: "user" } };

  const gated = await untrustedProjectSessionOptions(cwd, agentDir, noProjectSettings, async () => ({
    extensionPaths: [projectExtension, userExtension],
    customToolPaths: [projectTool, userTool],
  }));

  assert.deepEqual(gated.preloadedExtensionPaths, [userExtension]);
  assert.deepEqual(gated.preloadedCustomToolPaths, [userTool]);
  assert.equal(gated.enableMCP, false);
});

test("trusting a project persists the decision and restores the normal load path", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });

  assert.deepEqual(trustProject(cwd, agentDir, noProjectSettings), { requiresTrust: true, trusted: true });
  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), { requiresTrust: true, trusted: true });
  assert.equal(await untrustedProjectSessionOptions(cwd, agentDir, noProjectSettings, discoveryNotExpected), undefined);

  const stored = JSON.parse(await readFile(join(agentDir, "cuelo-trusted-projects.json"), "utf8"));
  assert.equal(Object.values(stored)[0], true);
});

test("revoking a trusted project keeps it listed and gates its code again", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });
  const projectExtension = join(cwd, ".omp", "extensions", "probe.ts");
  trustProject(cwd, agentDir, noProjectSettings);

  setProjectTrust(cwd, agentDir, false);

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), { requiresTrust: true, trusted: false });
  assert.deepEqual(
    await untrustedProjectSessionOptions(cwd, agentDir, noProjectSettings, async () => ({
      extensionPaths: [projectExtension],
      customToolPaths: [],
    })),
    { preloadedExtensionPaths: [], preloadedCustomToolPaths: [], enableMCP: false },
  );
  const stored = JSON.parse(await readFile(join(agentDir, "cuelo-trusted-projects.json"), "utf8"));
  assert.deepEqual(Object.values(stored), [false]);
});

test("isInsideProject does not treat sibling directories as project-local", () => {
  assert.equal(isInsideProject("/repo/.omp/extensions/a.ts", "/repo"), true);
  assert.equal(isInsideProject("/repo", "/repo"), true);
  assert.equal(isInsideProject("/repo-worktrees/other/a.ts", "/repo"), false);
  assert.equal(isInsideProject("/home/user/.omp/agent/extensions/a.ts", "/repo"), false);
});

test("adopts a pre-rename omp-web-trusted-projects.json", async (t) => {
  const { cwd, agentDir } = await createProjectFixture(t);
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });
  await writeFile(join(cwd, ".omp", "extensions", "a.ts"), "export default () => {};\n");
  trustProject(cwd, agentDir, noProjectSettings);
  const legacy = join(agentDir, "omp-web-trusted-projects.json");
  await writeFile(legacy, await readFile(join(agentDir, "cuelo-trusted-projects.json"), "utf8"));
  await rm(join(agentDir, "cuelo-trusted-projects.json"));

  assert.deepEqual(getProjectTrustStatus(cwd, agentDir, noProjectSettings), { requiresTrust: true, trusted: true });
  await assert.rejects(readFile(legacy, "utf8"), { code: "ENOENT" });
});
