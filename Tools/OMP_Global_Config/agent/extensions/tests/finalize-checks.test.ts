import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Process } from "@oh-my-pi/pi-natives";
import { FINALIZE_CHECKS_CONFIG, finalizeChecksNote, runFinalizeChecks } from "../lib/finalize-checks";

const roots: string[] = [];
const appTrust = Symbol.for("cuelo.finalizeChecksProjectTrust");
const bun = (script: string, ...args: string[]) => [process.execPath, "-e", script, ...args];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const scratch = await mkdtemp(join(homedir(), "omp-finalize-check-"));
  roots.push(scratch);
  const root = join(scratch, "work");
  const artifacts = join(scratch, "artifacts");
  const ledgerDir = join(scratch, "ledger");
  const configPath = join(root, FINALIZE_CHECKS_CONFIG);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.txt"), "base\n");
  await writeFile(join(root, "peer.txt"), "base peer\n");
  for (const args of [
    ["init", "-q"], ["add", "src/main.txt", "peer.txt"],
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"],
  ]) {
    const git = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(git.exitCode, git.stderr.toString()).toBe(0);
  }
  const sessionManager = { getArtifactManager: () => ({ dir: artifacts }) };
  return {
    scratch, root, configPath, sessionManager,
    config: (checks: unknown[]) => writeFile(configPath, JSON.stringify({ version: 1, checks })),
    run: (options: { files?: string[]; waiver?: string; showDirtyTracked?: boolean } = {}) =>
      runFinalizeChecks({ root, ledgerDir, files: ["src/main.txt"], ...options, sessionManager: sessionManager as never }),
  };
}

test("matches only exact files and directory prefixes, keeps order, and passes literal argv/env in the root", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "runs.txt");
  const append = `const fs = require('node:fs'); fs.appendFileSync(process.argv[1], JSON.stringify([process.cwd(), process.argv[2], !!process.env.PATH]) + '\\n');`;
  await f.config([
    { name: "not-this-directory", paths: ["sr/"], command: bun("process.exit(9)") },
    { name: "not-an-exact-file", paths: ["src"], command: bun("process.exit(9)") },
    { name: "exact", paths: ["src/main.txt"], command: bun(append, marker, "a | b && c; <d>") },
    { name: "directory", paths: ["src/"], command: bun(append, marker, "second") },
  ]);
  const result = await f.run();
  expect(result?.checks).toEqual([
    { name: "exact", reused: false, seconds: expect.any(Number) },
    { name: "directory", reused: false, seconds: expect.any(Number) },
  ]);
  expect((await readFile(marker, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line))).toEqual([
    [f.root, "a | b && c; <d>", true], [f.root, "second", true],
  ]);
  expect(finalizeChecksNote(result)).toMatch(/exact ran \(.+s\); directory ran \(.+s\)/);
});

test("reuses an identical pass and reruns for covered untracked or tracked content changes", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "runs.txt");
  await f.config([{ name: "cached", paths: ["src/"], command: bun(`require('node:fs').appendFileSync(process.argv[1], 'run\\n');`, marker) }]);
  expect((await f.run())?.checks[0].reused).toBe(false);
  expect(finalizeChecksNote(await f.run())).toBe("Finalize checks: cached reused.");
  expect(await readFile(marker, "utf8")).toBe("run\n");
  await writeFile(join(f.root, "src", "input.txt"), "new untracked input\n");
  expect((await f.run())?.checks[0].reused).toBe(false);
  await writeFile(join(f.root, "src", "input.txt"), "different contents\n");
  expect((await f.run())?.checks[0].reused).toBe(false);
  await writeFile(join(f.root, "src", "main.txt"), "changed tracked contents\n");
  expect((await f.run())?.checks[0].reused).toBe(false);
  await writeFile(join(f.root, "peer.txt"), "tracked changes outside the matching paths also matter\n");
  expect((await f.run())?.checks[0].reused).toBe(false);
  expect(await readFile(marker, "utf8")).toBe("run\n".repeat(5));
});

test("source-loaded runner writes the default ledger and logs only to the configured agent directory", async () => {
  const f = await fixture();
  const agentDir = join(f.scratch, "agent-profile");
  await f.config([{ name: "profile directory", paths: ["src/"], command: bun("") }]);
  const app = `
    import { runFinalizeChecks } from ${JSON.stringify(import.meta.resolve("../lib/finalize-checks"))};
    const opts = { root: process.argv[1], files: ["src/main.txt"] };
    console.log((await runFinalizeChecks(opts)).checks[0].reused, (await runFinalizeChecks(opts)).checks[0].reused);
  `;
  const result = Bun.spawnSync([
    process.execPath, "-e", app, f.root,
  ], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_FINALIZE_CHECKS_LEDGER: "" },
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString().trim()).toBe("false true");
  expect(await readdir(join(agentDir, "finalize-checks-ledger"))).toHaveLength(1);
  expect(await readdir(join(agentDir, "artifacts", "finalize-checks"))).toHaveLength(1);
  expect(existsSync(new URL("../../finalize-checks-ledger/", import.meta.url))).toBe(false);
});

test.skipIf(process.platform === "win32")("opaque symlinks disable reuse only within the matched check's paths", async () => {
  const f = await fixture();
  const target = join(f.scratch, "opaque.txt");
  await writeFile(target, "pass");
  await symlink(target, join(f.root, "src", "link.txt"));
  expect(Bun.spawnSync(["git", "add", "--", "src/link.txt"], { cwd: f.root }).exitCode).toBe(0);
  await f.config([
    { name: "link", paths: ["src/"], command: bun(`if (require('node:fs').readFileSync('src/link.txt', 'utf8') !== 'pass') process.exit(7);`) },
    { name: "other", paths: ["peer.txt"], command: bun("") },
  ]);
  const options = { files: ["src/main.txt", "peer.txt"] };
  expect((await f.run(options))?.checks.map((check) => check.reused)).toEqual([false, false]);
  expect((await f.run(options))?.checks.map((check) => check.reused)).toEqual([false, true]);
  await writeFile(target, "fail");
  await expect(f.run(options)).rejects.toThrow("link exited 7");
});

test.each(["regular", "ambiguous UTF-8", ...(process.platform === "win32" ? [] : ["external symlink"])])("blocks later check invalidation with %s inputs", async (kind) => {
  const f = await fixture();
  await writeFile(join(f.root, "src", "input.txt"), "pass");
  if (kind === "ambiguous UTF-8") await writeFile(join(f.root, "src", "\uFFFD"), "opaque");
  if (kind === "external symlink") {
    const target = join(f.scratch, "opaque.txt");
    await writeFile(target, "outside");
    await symlink(target, join(f.root, "src", "link.txt"));
    expect(Bun.spawnSync(["git", "add", "--", "src/link.txt"], { cwd: f.root }).exitCode).toBe(0);
  }
  await f.config([
    { name: "first", paths: ["src/"], command: bun(`if (require('node:fs').readFileSync('src/input.txt', 'utf8') !== 'pass') process.exit(7);`) },
    { name: "later", paths: ["peer.txt"], command: bun(`require('node:fs').writeFileSync('src/input.txt', 'fail');`) },
  ]);
  await expect(f.run({ files: ["src/main.txt", "peer.txt"] })).rejects.toThrow("first's working-tree inputs changed after it passed");
});

test("successful checks can create their own output but cannot reuse a pass on changed inputs", async () => {
  const f = await fixture();
  await f.config([{ name: "report", paths: ["src/"], command: bun(`require('node:fs').appendFileSync('src/report.txt', 'x');`) }]);
  expect((await f.run())?.checks[0].reused).toBe(false);
  expect((await f.run())?.checks[0].reused).toBe(false);
  expect(await readFile(join(f.root, "src", "report.txt"), "utf8")).toBe("xx");
});

test("failure reports the last 60 combined lines, full log, and other dirty paths without their contents", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "peer.txt"), "private peer content\n");
  await f.config([{
    name: "failure", paths: ["src/"],
    command: bun(`for (let i = 0; i < 70; i++) require('node:fs').writeSync(i % 2 ? 1 : 2, 'line-' + i + '\\n'); process.exit(7);`),
  }]);
  const message = await f.run({ showDirtyTracked: true }).then(() => "", (error: Error) => error.message);
  expect(message).toContain("failure exited 7");
  expect(message).toContain("working tree");
  expect(message).toContain('Dirty tracked paths outside this publication: "peer.txt".');
  expect(message).not.toContain("private peer content");
  expect(message).toContain("Last output:\nline-10\nline-11\n");
  expect(message).not.toContain("line-9\n");
  expect(message).toContain("line-69\nFull log:");
  const log = message.match(/^Full log: (.+)$/m)?.[1];
  expect(log).toBeDefined();
  expect((await readFile(log!, "utf8")).split("\n").slice(0, 2)).toEqual(["line-0", "line-1"]);
  expect(message).toContain("then call the publication tool again");
});

test.each(process.platform === "win32" ? [false] : [false, true])("timeout kills descendants and preserves output (direct fallback=%s)", async (fallback) => {
  const f = await fixture();
  const marker = join(f.scratch, "child-late.txt");
  const grandchild = `console.log('child started'); setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'leaked'), 1600);`;
  const command = `require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  await f.config([{ name: "slow", paths: ["src/"], command: bun(command, grandchild, marker), timeoutSeconds: 1 }]);
  const native = fallback ? spyOn(Process, "fromPid").mockReturnValue(null) : undefined;
  const message = await f.run().then(() => "", (error: Error) => error.message).finally(() => native?.mockRestore());
  expect(message).toContain("slow timed out after 1s");
  expect(message).toContain("child started");
  expect(message).toContain("Full log:");
  // An un-killed child would write after the timeout, not before it.
  await Bun.sleep(900);
  expect(await Bun.file(marker).exists()).toBe(false);
});

test.skipIf(process.platform === "win32")("SIGTERM gives a check's child time to clean up but the timeout still blocks", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "cleaned.txt");
  const grandchild = `process.on('SIGTERM', () => { require('node:fs').writeFileSync(process.argv[1], 'clean'); process.exit(0); }); console.log('child ready'); setInterval(() => {}, 1000);`;
  const command = `process.on('SIGTERM', () => {}); require('node:child_process').spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], { stdio: 'inherit' });`;
  await f.config([{ name: "cleanup", paths: ["src/"], command: bun(command, grandchild, marker), timeoutSeconds: 1 }]);
  await expect(f.run()).rejects.toThrow(/cleanup timed out after 1s[\s\S]*child ready/);
  expect(await readFile(marker, "utf8")).toBe("clean");
});

test.skipIf(process.platform === "win32")("a check ignoring SIGTERM is killed after the ten-second grace", async () => {
  const f = await fixture();
  const command = `process.on('SIGTERM', () => console.log('SIGTERM ignored')); setInterval(() => {}, 1000);`;
  await f.config([{ name: "stubborn", paths: ["src/"], command: bun(command), timeoutSeconds: 1 }]);
  // This exercises a real subprocess and the production grace, not a simulated timer.
  const started = performance.now();
  await expect(f.run()).rejects.toThrow(/stubborn timed out after 1s[\s\S]*SIGTERM ignored/);
  expect(performance.now() - started).toBeGreaterThanOrEqual(10_000);
}, 16_000);

test("blocks matching untrusted commands before spawn but allows non-matches, explicit waiver, and trusted execution", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "ran.txt");
  let trusted = false;
  const browser = Symbol.for("cuelo.finalizeChecksBrowser");
  Reflect.set(globalThis, browser, true);
  try {
    await f.config([{ name: "protected", paths: ["src/"], command: bun("require('node:fs').writeFileSync(process.argv[1], 'ran')", marker) }]);
    await expect(f.run()).rejects.toThrow(/project is untrusted.*was not executed/);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    Reflect.deleteProperty(globalThis, browser);
  }
  Object.defineProperty(f.sessionManager, appTrust, { value: (root: string) => root === f.root && trusted });
  await expect(f.run()).rejects.toThrow(/project is untrusted.*was not executed/);
  expect(await Bun.file(marker).exists()).toBe(false);
  expect(await f.run({ files: ["peer.txt"] })).toBeUndefined();
  const waived = await f.run({ waiver: "User requested skipping checks this time" });
  expect(finalizeChecksNote(waived)).toContain("waived by explicit user instruction: User requested skipping checks this time");
  expect(await Bun.file(marker).exists()).toBe(false);
  trusted = true;
  expect((await f.run())?.checks[0]).toMatchObject({ name: "protected", reused: false });
  expect(await readFile(marker, "utf8")).toBe("ran");
});

test("absent config does not ask for publication files or touch the session artifact store", async () => {
  const f = await fixture();
  const result = await runFinalizeChecks({
    root: f.root,
    files: async () => { throw new Error("the publication set should not be queried without a config"); },
  });
  expect(result).toBeUndefined();
});

test("invalid syntax, version, shape and arguments identify the config and cannot be waived", async () => {
  const f = await fixture();
  const check = { name: "check", paths: ["src/"], command: [process.execPath] };
  const bad = [
    "{", JSON.stringify({ version: 2, checks: [check] }), JSON.stringify({ version: 1, checks: {}, extra: true }),
    ...[{ name: "" }, { paths: ["../x"] }, { paths: ["C:/x"] }, { paths: ["/x"] }, { paths: ["src//"] }, { command: [""] }, { command: "true" }, { timeoutSeconds: 2.5 }, { timeoutSeconds: 0 }, { unknown: "field" }]
      .map((change) => JSON.stringify({ version: 1, checks: [{ ...check, ...change }] })),
    JSON.stringify({ version: 1, checks: [check, check] }),
  ];
  for (const source of bad) {
    await writeFile(f.configPath, source);
    await expect(f.run({ waiver: "even with waiver" })).rejects.toThrow(f.configPath);
  }
});
