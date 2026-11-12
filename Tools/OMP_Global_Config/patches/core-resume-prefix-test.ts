// Replays the real revive hook and captures the first Anthropic request before network.
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

if (!process.env.OMP_RESUME_TEST_ROOT) {
  const root = mkdtempSync(join(tmpdir(), "omp-resume-prefix-"));
  const home = join(root, "home");
  mkdirSync(home);
  try {
    const child = spawnSync(process.execPath, ["test", import.meta.path], {
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".omp/agent"), OMP_RESUME_TEST_ROOT: root },
      stdio: "inherit",
    });
    process.exitCode = child.status ?? 1;
  } finally { rmSync(root, { recursive: true, force: true }); }
} else {
  const root = process.env.OMP_RESUME_TEST_ROOT;
  const core = resolve(process.env.OMP_CORE_PATCH_TARGET ?? "node_modules/@oh-my-pi/pi-coding-agent");
  const fixture = join(root, "target");
  const script = resolve(import.meta.dirname, "apply-core-patch.mjs");
  const source = readFileSync(script, "utf8");
  for (const file of new Set([...source.matchAll(/^\s*file: "([^"]+)",\s*$/gm)].map(m => m[1]!))) {
    const backup = process.env.OMP_CORE_PATCH_BACKUP && join(process.env.OMP_CORE_PATCH_BACKUP, file);
    const original = backup && existsSync(backup) ? backup : join(core, file);
    if (!existsSync(original)) continue;
    mkdirSync(dirname(join(fixture, file)), { recursive: true });
    copyFileSync(original, join(fixture, file));
  }
  const baseline = process.env.RESUME_PREFIX_BASELINE === "1";
  if (!baseline) for (const args of [[], [], ["--check"]]) {
    const result = spawnSync("node", [script, ...args], {
      env: { ...process.env, OMP_CORE_PATCH_TARGET: fixture }, encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(`isolated patch ${args} exit ${result.status}\n${result.stdout}\n${result.stderr}`);
    console.log(`isolated ${args[0] ?? "apply"}: exit 0`);
  }
  if (process.env.RESUME_PREFIX_PATCH_ONLY === "1") process.exit(0);
  Bun.plugin({ name: "resume-prefix-fixture", setup(build) {
    build.onLoad({ filter: /[/\\]@oh-my-pi[/\\][\w-]+[/\\].+\.ts$/ }, args => {
      const [pkg, ...rest] = args.path.replace(/\\/g, "/").split("/@oh-my-pi/").at(-1)!.split("/");
      const candidate = pkg === "pi-coding-agent" ? join(fixture, ...rest) : join(fixture, "..", pkg!, ...rest);
      const contents = readFileSync(existsSync(candidate) ? candidate : args.path, "utf8");
      return args.path.endsWith(".d.ts") ? { exports: { default: contents }, loader: "object" } : { contents, loader: "ts" };
    });
  } });
  // Core imports must follow plugin registration so the isolated source is loaded.
  const { fixture: createFixture, capture } = await import("../../../lib/resume-prefix.test.mjs");
  const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
  const { replayRevivedAgentStart } = await import("@oh-my-pi/pi-coding-agent/task/executor");
  const { namesOnlySkills } = await import("../agent/extensions/prompt-compact");
  const { createHash } = await import("node:crypto");
  test("revived Maker first request matches pre-revive effective blocks and preserves the raw base", async t => {
    const f = await createFixture(t);
    const base = ["stable head", "<skills>\n- debugging: full description\n- testing: full description\n</skills>", "<project-context>fixture</project-context>"];
    const expected = base.map(namesOnlySkills);
    const extension = (pi: { on: (event: string, handler: (event: { systemPrompt: string[] }) => unknown) => void }) => {
      pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt.map(namesOnlySkills), messages: [{ customType: "fixture-notice", content: "must not duplicate", display: false }] }));
    };
    const before = await f.create(SessionManager.inMemory(f.cwd), { systemPrompt: base, extensions: [extension], taskDepth: 1, agentName: "maker", requireYieldTool: false });
    // The original prompt preparation applies the hook result to the effective prompt.
    before.agent.setSystemPrompt(expected);
    const sent = await capture(before);
    const resumed = await f.create(SessionManager.inMemory(f.cwd), { systemPrompt: base, extensions: [extension], taskDepth: 1, agentName: "maker", requireYieldTool: false });
    await replayRevivedAgentStart(resumed);
    const next = await capture(resumed);
    const digests = (parts: string[]) => parts.map(text => ({ label: text.split("\n")[0], hash: createHash("sha256").update(text).digest("hex").slice(0, 16) }));
    console.log(JSON.stringify({ before: digests(sent.prompt), after: digests(next.prompt) }));
    assert.deepEqual(next.payload.system, sent.payload.system);
    assert.deepEqual(resumed.baseSystemPrompt, base);
    assert.equal(resumed.agent.state.messages.some(message => "customType" in message && message.customType === "fixture-notice"), false);
  });
}
