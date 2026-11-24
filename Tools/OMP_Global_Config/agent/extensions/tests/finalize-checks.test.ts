import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Process } from "@oh-my-pi/pi-natives";
import { FINALIZE_CHECKS_CONFIG, finalizeChecksNote, runFinalizeChecks } from "../lib/finalize-checks";
import { spawnExec } from "../lib/cross-review";

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
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("add", "src/main.txt", "peer.txt");
  git("commit", "-qm", "base");
  const sessionManager = { getArtifactManager: () => ({ dir: artifacts }) };
  return {
    scratch, root, configPath, sessionManager, git,
    config: (checks: unknown[]) => writeFile(configPath, JSON.stringify({ version: 1, checks })),
    run: (options: Partial<Pick<Parameters<typeof runFinalizeChecks>[0], "files" | "waiver" | "publicationCandidate" | "signal" | "git" | "exec">> = {}) =>
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

test("uses the checkout in place with only requested changes", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "cwd.txt");
  await f.config([{ name: "pwd", paths: ["src/"], command: bun(`require('node:fs').writeFileSync(process.argv[1], process.cwd())`, marker) }]);
  await writeFile(join(f.root, "src", "main.txt"), "changed\n");
  const result = await f.run({ publicationCandidate: true, files: [FINALIZE_CHECKS_CONFIG, "src/main.txt"] });
  expect(result?.checks[0]?.reused).toBe(false);
  expect(await readFile(marker, "utf8")).toBe(f.root);
  expect(result?.candidateTree).toBeUndefined();
});

test("the receipt follows candidate content across excluded edits, not the dirty checkout", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "cwd.txt");
  await f.config([{ name: "candidate", paths: ["src/"], command: bun(`
    const fs = require('node:fs');
    if (fs.existsSync('peer.txt') || fs.existsSync('src/unrequested.txt') || fs.existsSync('ignored-input.txt')) process.exit(7);
    fs.writeFileSync(process.argv[1], process.cwd());
  `, marker) }]);
  await writeFile(join(f.root, ".gitignore"), "/ignored-input.txt\n");
  f.git("add", FINALIZE_CHECKS_CONFIG, ".gitignore");
  f.git("commit", "-qm", "configure candidate");
  const worktrees = f.git("worktree", "list", "--porcelain");
  await rm(join(f.root, "peer.txt"));
  const unrequested = join(f.root, "src", "unrequested.txt");
  await writeFile(unrequested, "first excluded edit\n");
  await writeFile(join(f.root, "ignored-input.txt"), "not transferred\n");
  const options = { publicationCandidate: true, files: ["src/main.txt", "peer.txt"] };
  const first = await f.run(options);
  const candidate = await readFile(marker, "utf8");
  expect(first?.checks[0]?.reused).toBe(false);
  expect(candidate).not.toBe(f.root);
  expect(existsSync(candidate)).toBe(false);
  expect(f.git("worktree", "list", "--porcelain")).toBe(worktrees);
  await writeFile(unrequested, "second excluded edit\n");
  expect((await f.run(options))?.checks[0]?.reused).toBe(true);
  await writeFile(join(f.root, "src", "main.txt"), "new candidate content\n");
  expect((await f.run(options))?.checks[0]?.reused).toBe(false);
  expect(f.git("diff", "--cached", "--name-only")).toBe("");
});

test.skipIf(process.platform !== "linux")("WSL candidate stages with the source Git's CRLF policy", async () => {
  const f = await fixture();
  f.git("config", "core.autocrlf", "false");
  await f.config([{ name: "line endings", paths: ["src/"], command: bun(`
    if (require('node:fs').readFileSync('src/main.txt', 'utf8') !== 'changed\\n') process.exit(7)
  `) }]);
  await writeFile(join(f.root, "src", "main.txt"), "changed\r\n");
  await writeFile(join(f.root, "peer.txt"), "local only\n");
  const exec = spawnExec();
  const result = await f.run({
    publicationCandidate: true, files: [FINALIZE_CHECKS_CONFIG, "src/main.txt"], git: "git.exe",
    exec: (command, args, opts) => {
      if (command === "wslpath") return Promise.resolve({ code: 0, stdout: args[1] });
      return command === "git.exe" ? exec("git", ["-c", "core.autocrlf=true", ...args], opts) : exec(command, args, opts);
    },
  });
  expect(result?.checks).toHaveLength(1);
  expect(await readFile(join(f.root, "src", "main.txt"), "utf8")).toBe("changed\r\n");
  expect(f.git("diff", "--cached", "--name-only")).toBe("");
});

test.each(["src/report.txt", "report.txt"])("allows generated untracked report %s but does not cache a changed input view", async (report) => {
  const f = await fixture();
  await f.config([{ name: "report", paths: ["src/"], command: bun(`require('node:fs').appendFileSync(process.argv[1], 'x')`, report) }]);
  const options = { publicationCandidate: true, files: [FINALIZE_CHECKS_CONFIG, "src/main.txt"] };
  const first = await f.run(options);
  expect(first?.checks[0].reused).toBe(false);
  expect(first?.candidateTree).toBeUndefined();
  const second = await f.run(options);
  expect(second?.checks[0].reused).toBe(false);
  expect(second?.candidateTree).toBeDefined();
  expect(await readFile(join(f.root, report), "utf8")).toBe("x");
  await rm(join(f.root, report));
  expect((await f.run(options))?.checks[0].reused).toBe(false);
});

test("cleans up the candidate after abort and retains the check's log", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "started");
  await f.config([{ name: "abortable", paths: ["src/"], command: bun(`
    console.log('ready to cancel');
    const fs = require('node:fs');
    fs.watch('.');
    fs.writeFileSync(process.argv[1] + '.tmp', process.cwd());
    fs.renameSync(process.argv[1] + '.tmp', process.argv[1]);
  `, marker) }]);
  await writeFile(join(f.root, "peer.txt"), "dirty\n");
  const before = f.git("worktree", "list", "--porcelain");
  const controller = new AbortController();
  const watcher = watch(f.scratch, (_, file) => { if (file === "started") controller.abort(); });
  try {
    await expect(f.run({ publicationCandidate: true, files: [FINALIZE_CHECKS_CONFIG, "src/main.txt"], signal: controller.signal }))
      .rejects.toThrow(/abortable was cancelled[\s\S]*ready to cancel[\s\S]*Full log:/);
    const cwd = await readFile(marker, "utf8");
    expect(cwd).not.toBe(f.root);
    expect(existsSync(cwd)).toBe(false);
    expect(f.git("worktree", "list", "--porcelain")).toBe(before);
  } finally {
    watcher.close();
  }
});

test("rejects an unrequested config change, including deletion or an empty check list", async () => {
  const f = await fixture();
  const options = { publicationCandidate: true };
  const expected = "differs from the publication candidate. Include it in the publication or restore its committed version.";
  await f.config([{ name: "required", paths: ["src/"], command: bun("process.exit(7)") }]);
  await expect(f.run(options)).rejects.toThrow(expected);
  f.git("add", FINALIZE_CHECKS_CONFIG);
  f.git("commit", "-qm", "configure required check");
  await f.config([]);
  await expect(f.run(options)).rejects.toThrow(expected);
  await writeFile(f.configPath, "{");
  await expect(f.run(options)).rejects.toThrow(expected);
  await rm(f.configPath);
  await expect(f.run(options)).rejects.toThrow(expected);
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

test.each(process.platform === "win32" ? [] : ["node", "bun"])("reruns when the PATH's %s reports a new version", async (runtime) => {
  const f = await fixture();
  const executable = join(f.scratch, runtime);
  const version = `${executable}.version`;
  const marker = join(f.scratch, "runs.txt");
  await writeFile(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then cat "$0.version"; else printf 'run\\n' >> "$1"; fi
`, { mode: 0o755 });
  await writeFile(version, "1.0.0\n");
  await f.config([{ name: "runtime", paths: ["src/"], command: [runtime, marker] }]);
  const path = process.env.PATH;
  process.env.PATH = `${f.scratch}${delimiter}${path ?? ""}`;
  try {
    expect((await f.run())?.checks[0].reused).toBe(false);
    expect((await f.run())?.checks[0].reused).toBe(true);
    await writeFile(version, "2.0.0\n");
    expect((await f.run())?.checks[0].reused).toBe(false);
    expect((await f.run())?.checks[0].reused).toBe(true);
    expect(await readFile(marker, "utf8")).toBe("run\n".repeat(2));
    await writeFile(version, "unknown\n");
    expect((await f.run())?.checks[0].reused).toBe(false);
    expect((await f.run())?.checks[0].reused).toBe(false);
    expect(await readFile(marker, "utf8")).toBe("run\n".repeat(4));
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});

test("publication reruns when an ignored installed package changes without a lockfile change", async () => {
  const f = await fixture();
  const installed = join(f.root, "node_modules", "fixture-dependency");
  const manifest = join(installed, "package.json");
  const marker = join(f.scratch, "version.txt");
  await mkdir(installed, { recursive: true });
  await writeFile(join(f.root, ".gitignore"), "/node_modules/\n");
  await writeFile(manifest, '{"name":"fixture-dependency","version":"1.0.0"}');
  await f.config([{ name: "dependency", paths: ["src/"], command: bun(`
    const fs = require('node:fs');
    fs.writeFileSync(process.argv[1], require('fixture-dependency/package.json').version);
  `, marker) }]);
  f.git("add", ".gitignore", FINALIZE_CHECKS_CONFIG);
  f.git("commit", "-qm", "configure dependency check");
  const options = { publicationCandidate: true };
  expect((await f.run(options))?.checks[0].reused).toBe(false);
  expect((await f.run(options))?.checks[0].reused).toBe(true);
  await writeFile(manifest, '{"name":"fixture-dependency","version":"2.0.0"}');
  expect((await f.run(options))?.checks[0].reused).toBe(false);
  expect(await readFile(marker, "utf8")).toBe("2.0.0");
});

test("reruns when a check reads changed untracked input outside its paths", async () => {
  const f = await fixture();
  const input = join(f.root, "local-input.txt");
  const marker = join(f.scratch, "input.txt");
  await writeFile(input, "before");
  await f.config([{ name: "input", paths: ["src/"], command: bun(`
    require('node:fs').copyFileSync('local-input.txt', process.argv[1]);
  `, marker) }]);
  expect((await f.run())?.checks[0].reused).toBe(false);
  expect((await f.run())?.checks[0].reused).toBe(true);
  await writeFile(input, "after");
  expect((await f.run())?.checks[0].reused).toBe(false);
  expect(await readFile(marker, "utf8")).toBe("after");
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
  const message = await f.run({ publicationCandidate: true, files: [FINALIZE_CHECKS_CONFIG, "src/main.txt"] }).then(() => "", (error: Error) => error.message);
  expect(message).toContain("failure exited 7");
  expect(message).toContain("isolated publication candidate");
  expect(message).toContain('Excluded dirty or index-hidden paths: "peer.txt".');
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
