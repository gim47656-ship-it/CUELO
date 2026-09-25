import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { resolveSessionSystemPrompts } = await jiti.import("./session-system-prompt.ts");
const { buildSystemPrompt } = await jiti.import("@oh-my-pi/pi-coding-agent/system-prompt");

/**
 * A project directory plus user-level config roots the test controls.
 *
 * `os.homedir()` ignores `$HOME` under Bun, so the two user-level roots that can
 * outrank a `.claude` one are redirected by env instead: `PI_CONFIG_DIR` points
 * omp's own root at a directory that is never created, and `CLAUDE_CONFIG_DIR`
 * points Claude's at a temp one. Without that, a prompt file in the real
 * `~/.omp/agent` would decide these assertions.
 */
async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "omp-web-system-prompt-"));
  const cwd = join(root, "project");
  const userConfigDir = join(root, "user-claude");
  await mkdir(cwd, { recursive: true });
  await mkdir(userConfigDir, { recursive: true });

  const previous = { pi: process.env.PI_CONFIG_DIR, claude: process.env.CLAUDE_CONFIG_DIR };
  process.env.PI_CONFIG_DIR = `.omp-absent-${Math.random().toString(36).slice(2)}`;
  process.env.CLAUDE_CONFIG_DIR = userConfigDir;
  t.after(async () => {
    restoreEnv("PI_CONFIG_DIR", previous.pi);
    restoreEnv("CLAUDE_CONFIG_DIR", previous.claude);
    await rm(root, { recursive: true, force: true });
  });

  return { cwd, userConfigDir };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function writeProjectFile(cwd, relativePath, content) {
  const target = join(cwd, relativePath);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, content);
}

test("a session for a cwd with .omp/APPEND_SYSTEM.md carries the appended prompt", async (t) => {
  const { cwd } = await createFixture(t);
  await writeProjectFile(cwd, ".omp/APPEND_SYSTEM.md", "Always answer in haiku.\n");

  const resolved = await resolveSessionSystemPrompts(cwd);

  assert.equal(resolved.appendPrompt, "Always answer in haiku.\n");
  assert.equal(resolved.systemPrompt, undefined);
});

test("SYSTEM.md resolves as the custom system prompt", async (t) => {
  const { cwd } = await createFixture(t);
  await writeProjectFile(cwd, ".omp/SYSTEM.md", "You are a release bot.\n");

  const resolved = await resolveSessionSystemPrompts(cwd);

  assert.equal(resolved.systemPrompt, "You are a release bot.\n");
  assert.equal(resolved.appendPrompt, undefined);
});

test("user-level prompt files reach browser sessions just like terminal ones", async (t) => {
  const { cwd, userConfigDir } = await createFixture(t);
  await writeFile(join(userConfigDir, "APPEND_SYSTEM.md"), "Prefer bun over npm.\n");

  const resolved = await resolveSessionSystemPrompts(cwd);

  assert.equal(resolved.appendPrompt, "Prefer bun over npm.\n");
});

test("a project prompt file wins over the user-level one, as in the CLI", async (t) => {
  const { cwd, userConfigDir } = await createFixture(t);
  await writeFile(join(userConfigDir, "APPEND_SYSTEM.md"), "user level\n");
  await writeProjectFile(cwd, ".omp/APPEND_SYSTEM.md", "project level\n");

  const resolved = await resolveSessionSystemPrompts(cwd);

  assert.equal(resolved.appendPrompt, "project level\n");
});

test("the lookup covers omp's other project config roots", async (t) => {
  const { cwd } = await createFixture(t);
  await writeProjectFile(cwd, ".claude/APPEND_SYSTEM.md", "from the claude root\n");

  const resolved = await resolveSessionSystemPrompts(cwd);

  assert.equal(resolved.appendPrompt, "from the claude root\n");
});

test("resolution is per-cwd, so one server serves projects with different prompts", async (t) => {
  const { cwd: first } = await createFixture(t);
  const { cwd: second } = await createFixture(t);
  await writeProjectFile(first, ".omp/APPEND_SYSTEM.md", "first project\n");
  await writeProjectFile(second, ".omp/APPEND_SYSTEM.md", "second project\n");

  assert.equal((await resolveSessionSystemPrompts(first)).appendPrompt, "first project\n");
  assert.equal((await resolveSessionSystemPrompts(second)).appendPrompt, "second project\n");
});

test("a project with no prompt files leaves the session on omp's default prompt", async (t) => {
  const { cwd } = await createFixture(t);

  assert.deepEqual(await resolveSessionSystemPrompts(cwd), {
    systemPrompt: undefined,
    appendPrompt: undefined,
  });
});

test("an untrusted project's prompt files still load — they are data, not code", async (t) => {
  const { cwd } = await createFixture(t);
  // `.omp/extensions` is what makes a project require trust; a prompt file is
  // deliberately outside that gate (see docs/project-trust.md).
  await mkdir(join(cwd, ".omp", "extensions"), { recursive: true });
  await writeProjectFile(cwd, ".omp/APPEND_SYSTEM.md", "untrusted but loaded\n");

  const resolved = await resolveSessionSystemPrompts(cwd);

  assert.equal(resolved.appendPrompt, "untrusted but loaded\n");
});

test("the resolved append prompt is folded into the rendered system prompt", async (t) => {
  const { cwd } = await createFixture(t);
  await writeProjectFile(cwd, ".omp/APPEND_SYSTEM.md", "Ship notes go in CHANGELOG.md.\n");

  const resolved = await resolveSessionSystemPrompts(cwd);
  // What `createAgentSession` does with `appendSystemPrompt`, minus the session:
  // the prompt a session for this cwd ends up carrying.
  const { systemPrompt } = await buildSystemPrompt({
    cwd,
    resolvedAppendSystemPrompt: resolved.appendPrompt,
  });

  assert.ok(systemPrompt.join("\n").includes("Ship notes go in CHANGELOG.md."));
});

test("the resolved SYSTEM.md replaces the default prompt body", async (t) => {
  const { cwd } = await createFixture(t);
  await writeProjectFile(cwd, ".omp/SYSTEM.md", "You only write commit messages.\n");

  const resolved = await resolveSessionSystemPrompts(cwd);
  const { systemPrompt } = await buildSystemPrompt({
    cwd,
    resolvedCustomPrompt: resolved.systemPrompt,
  });

  assert.ok(systemPrompt.join("\n").includes("You only write commit messages."));
});
