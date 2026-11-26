#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { setMaxListeners } from "node:events";
import { constants, closeSync, cpSync, globSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, constants as osConstants, homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const harness = join(root, "Tools/OMP_Global_Config");
const corePackage = "@oh-my-pi/pi-coding-agent";
const patchCommand = [process.execPath, "patches/apply-core-patch.mjs"];
const coreVersionPattern = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?";
const coreVersion = new RegExp(`^${coreVersionPattern}$`);
const suites = ["harness-extensions", "harness-core", "app"];
const usage = `Usage: node bin/ci-local.mjs <${suites.join(" | ")}> [...]`;
// bun test --parallel cut extensions from 137s to 46s and app tests from 45s to 14s on a 12-core PC, but on the
// 4-core GitHub runner heavy tests passed their 5s limit (2026-11-27). Fewer cores keep the serial run.
const parallelTests = availableParallelism() >= 8 ? ["--parallel"] : [];

export function parseSuites(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return [];
  if (args.length === 0) throw new Error(usage);
  const unknown = args.find((arg) => !suites.includes(arg));
  if (unknown !== undefined) throw new Error(`Unknown suite: ${unknown}\n${usage}`);
  return [...new Set(args)];
}

export function coreCacheKey(version, platform = process.platform, arch = process.arch) {
  if (!coreVersion.test(version)) {
    throw new Error(`Expected an exact ${corePackage} version, got ${version}`);
  }
  return `${platform}-${arch}-${version}`;
}

function runChild(program, args, options, signal) {
  signal.throwIfAborted();
  return new Promise((done) => {
    const group = process.platform !== "win32";
    const child = spawn(program, args, { ...options, detached: group });
    let startError;
    const stop = () => {
      if (!child.pid) return;
      try {
        if (group) process.kill(-child.pid, signal.reason.signal);
        else child.kill(signal.reason.signal);
      } catch (error) {
        if (error.code !== "ESRCH") console.error(error.message);
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    child.on("error", (error) => { startError = error.message; });
    child.on("close", (code, bySignal) => {
      signal.removeEventListener("abort", stop);
      done(startError ?? (code === 0 ? undefined : bySignal ?? `exit ${code}`));
    });
  });
}

async function run([program, ...args], cwd, env, signal) {
  console.log(`$ ${[program, ...args].join(" ")}`);
  const failure = await runChild(program, args, { cwd, env, stdio: ["ignore", "inherit", "inherit"] }, signal);
  signal.throwIfAborted();
  if (failure) throw new Error(`${[program, ...args].join(" ")}: ${failure}`);
}

function coreTarget(directory) {
  return join(directory, "node_modules", corePackage);
}

// 코어는 이 기계용 네이티브 패키지만 받는다. x64로 고정하면 arm64(Oracle)에서는 받은 코어를 매번 없다고 읽었다(11-21 야간).
const nativePackage = `pi-natives-${process.platform}-${process.arch}`;

export function reusableCore(directory, version) {
  const target = coreTarget(directory);
  const manifest = join(target, "package.json");
  if (!statSync(manifest, { throwIfNoEntry: false })?.isFile()) return false;
  try {
    return JSON.parse(readFileSync(manifest, "utf8"))?.version === version &&
      statSync(join(target, "src/registry/agent-registry.ts"), { throwIfNoEntry: false })?.isFile() === true &&
      statSync(join(target, "..", nativePackage), { throwIfNoEntry: false })?.isDirectory() === true;
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export function makeCoreRunDir(parent) {
  mkdirSync(parent, { recursive: true });
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    const owner = /^run-([1-9]\d*)-[A-Za-z0-9]{6}$/.exec(entry.name);
    if (!owner || !entry.isDirectory()) continue;
    try {
      process.kill(Number(owner[1]), 0);
    } catch (error) {
      if (error.code === "ESRCH") rmSync(join(parent, entry.name), { recursive: true, force: true });
      else if (error.code !== "EPERM" && error.code !== "ERR_OUT_OF_RANGE") throw error;
    }
  }
  return mkdtempSync(join(parent, `run-${process.pid}-`));
}

async function installCore(directory, version, env, signal) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "ci-core", private: true }), { flag: "wx" });
  console.log(`Installing pristine core ${version}: ${directory}`);
  // The shared Bun cache may already contain in-place SDK patches from older tools.
  const downloadEnv = { ...env, BUN_INSTALL_CACHE_DIR: join(directory, "..", "bun-download") };
  await run(["bun", "add", "--backend=copyfile", `${corePackage}@${version}`], directory, downloadEnv, signal);
  if (!reusableCore(directory, version)) throw new Error(`Core ${version} or ${nativePackage} is missing: ${directory}`);
}

export function obsoleteCorePins(entries, installedPin) {
  const prefix = `${process.platform}-${process.arch}-`;
  return entries.filter(({ name }) => name !== installedPin && name.startsWith(prefix) && coreVersion.test(name.slice(prefix.length)))
    .sort((a, b) => b.installedAt - a.installedAt || a.name.localeCompare(b.name))
    .slice(1)
    .map(({ name }) => name);
}

async function copyPristineCore(cache, scratch, checkout, version, env, signal) {
  const parent = join(cache, "pristine");
  mkdirSync(parent, { recursive: true });
  const lock = openSync(join(parent, ".lock"), "a");
  try {
    // flock locks the inherited open file description; Node still owns it after flock exits.
    // Keep it through copy and eviction, then tests use only their private copies.
    const lockFailure = await runChild("flock", ["-x", "3"], { env, stdio: ["ignore", "inherit", "inherit", lock] }, signal);
    signal.throwIfAborted();
    if (lockFailure) throw new Error(`Cannot lock pristine core cache: ${lockFailure}`);
    const installedPin = coreCacheKey(version);
    const pristine = join(parent, installedPin);
    if (reusableCore(pristine, version)) {
      console.log(`Reusing pristine core ${version}: ${pristine}`);
    } else {
      const staging = join(scratch, "install");
      await installCore(staging, version, env, signal);
      if (statSync(pristine, { throwIfNoEntry: false })) renameSync(pristine, join(scratch, "invalid-install"));
      renameSync(staging, pristine);
      const entries = readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      for (const name of obsoleteCorePins(entries.map(({ name }) => ({
        name, installedAt: statSync(join(parent, name)).mtimeMs,
      })), installedPin)) {
        rmSync(join(parent, name), { recursive: true, force: true });
      }
    }
    const start = performance.now();
    cpSync(pristine, checkout, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    console.log(`Copied pristine core (${((performance.now() - start) / 1000).toFixed(1)}s)`);
  } finally {
    closeSync(lock);
  }
}

async function prepareHarness(env, signal) {
  await run(["bash", "-ec", "command -v bash; command -v pwsh"], harness, env, signal);
  const { dependencies } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const version = dependencies[corePackage];
  const explicitDir = env.CUELO_CI_CORE_DIR && resolve(root, env.CUELO_CI_CORE_DIR);
  const cache = join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "cuelo-ci-local");
  const scratch = makeCoreRunDir(explicitDir || join(cache, "runs"));
  let prepared = false;
  try {
    const checkout = join(scratch, "core");
    if (explicitDir) await installCore(checkout, version, env, signal);
    else await copyPristineCore(cache, scratch, checkout, version, env, signal);
    const target = coreTarget(checkout);
    const testEnv = { ...env, OMP_CORE_PATCH_TARGET: target };
    const patchEnv = { ...testEnv, HOME: scratch, USERPROFILE: scratch };
    const start = performance.now();
    await run(patchCommand, harness, patchEnv, signal);
    await run([...patchCommand, "--check"], harness, patchEnv, signal);
    console.log(`Patched and verified scratch core (${((performance.now() - start) / 1000).toFixed(1)}s)`);
    prepared = true;
    return { env: testEnv, scratch };
  } finally {
    if (!prepared) rmSync(scratch, { recursive: true, force: true });
  }
}

async function runExtensions(env, signal) {
  await run([process.execPath, "patches/check-extension-duplicates.mjs"], harness, env, signal);
  await run(["bun", "test", ...parallelTests, "./agent/extensions/tests", "./agent/extensions/command-guard",
    "./agent/tools/git-finalizer", "./agent/tools/windows-control", "./agent/tools/artifact-search",
    "./agent/tools/vm-build", "./agent/tools/ego-browser", "./agent/tools/deploy-verify",
    "./agent/tools/windows-build", "./agent/cuelo-plugins/scratch-dependency-hint", "./skill-cost"], harness, env, signal);
  await run([process.execPath, "--test", "agent/skills/kill-ai-slop/scripts/scan.test.mjs"], harness, env, signal);
}

async function coreTest(file, log, env, signal) {
  const fd = openSync(log, "w");
  try {
    return await runChild("bun", ["run", file], { cwd: harness, env, stdio: ["ignore", fd, fd] }, signal);
  } finally {
    closeSync(fd);
  }
}

async function runCore(env, signal) {
  const files = globSync("patches/core-*-test.ts", { cwd: harness }).sort();
  files.push("patches/apply-core-patch-cli-test.ts");
  const parallel = Number(execFileSync("nproc", { encoding: "utf8" }));
  const logs = mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), "cuelo-core-tests-"));
  const runs = files.map((file) => ({ file, name: basename(file), log: join(logs, `${basename(file)}.log`) }));
  let next = 0;
  try {
    console.log(`Running ${runs.length} core test files (bun run, up to ${parallel} at once)`);
    await Promise.all(Array.from({ length: Math.min(parallel, runs.length) }, async () => {
      while (!signal.aborted && next < runs.length) {
        const test = runs[next++];
        const started = performance.now();
        test.failure = await coreTest(test.file, test.log, env, signal);
        test.seconds = ((performance.now() - started) / 1000).toFixed(1);
      }
    }));
    signal.throwIfAborted();
    const failed = [];
    let ptyPassed = false;
    for (const test of runs) {
      if (env.GITHUB_ACTIONS === "true") console.log(`::group::${test.name}`);
      else console.log(`--- ${test.name} (${test.seconds}s) ---`);
      const log = readFileSync(test.log, "utf8");
      process.stdout.write(log.endsWith("\n") ? log : `${log}\n`);
      if (env.GITHUB_ACTIONS === "true") console.log("::endgroup::");
      if (test.failure) failed.push(`${test.name} (${test.failure})`);
      if (test.name === "core-patch-test.ts") ptyPassed = log.includes("PASS  사용자 셸 PTY");
    }
    if (!ptyPassed) failed.push("core-patch-test.ts (user-shell PTY check did not run)");
    if (failed.length) throw new Error(`Failed: ${failed.join(", ")}`);
  } finally {
    rmSync(logs, { recursive: true, force: true });
  }
}

async function runApp(env, signal) {
  for (const script of ["typecheck", "lint"]) await run(["bun", "run", script], root, env, signal);
  await run(["bun", "run", "test", ...parallelTests], root, env, signal);
  await run(["bun", "test", "./Tools/CUELO_Setup/files/btw-server.test.mjs",
    "./Tools/CUELO_Setup/files/subagent-server.test.mjs", "./Tools/CUELO_Setup/files/usage-server.test.js"], root, env, signal);
}

async function main(args) {
  const selected = parseSuites(args);
  if (!selected.length) {
    console.log(usage);
    return;
  }
  const env = { NEXT_TELEMETRY_DISABLED: "1", ...process.env };
  const controller = new AbortController();
  const { signal } = controller;
  setMaxListeners(Infinity, signal);
  const stop = (name) => controller.abort(Object.assign(new Error(`Interrupted by ${name}`), { signal: name }));
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"];
  const handlers = signals.map((name) => [name, () => stop(name)]);
  for (const [name, handler] of handlers) process.on(name, handler);
  let sourcePrepared = false;
  let preparedHarness;
  let harnessPreparationError;
  try {
    for (const suite of selected) {
      const start = performance.now();
      console.log(`\n=== CI local: ${suite} ===`);
      try {
        if (!sourcePrepared) {
          // prepare:source patches SDK files in node_modules. Copying keeps those writes out of the Bun
          // cache, so this install may use the cache git_finalize keeps between candidates.
          const installEnv = env.OMP_FINALIZE_BUN_CACHE ? { ...env, BUN_INSTALL_CACHE_DIR: env.OMP_FINALIZE_BUN_CACHE } : env;
          await run(["bun", "install", "--frozen-lockfile", "--backend=copyfile"], root, installEnv, signal);
          await run(["bun", "run", "prepare:source"], root, env, signal);
          sourcePrepared = true;
        }
        if (suite === "app") await runApp(env, signal);
        else {
          if (harnessPreparationError) throw harnessPreparationError;
          if (!preparedHarness) {
            try {
              preparedHarness = await prepareHarness(env, signal);
            } catch (error) {
              harnessPreparationError = error;
              throw error;
            }
          }
          if (suite === "harness-extensions") await runExtensions(preparedHarness.env, signal);
          else await runCore(preparedHarness.env, signal);
        }
        console.log(`=== ${suite}: passed (${((performance.now() - start) / 1000).toFixed(1)}s) ===`);
      } catch (error) {
        process.exitCode = signal.aborted ? 128 + osConstants.signals[signal.reason.signal] : 1;
        console.error(`=== ${suite}: failed (${((performance.now() - start) / 1000).toFixed(1)}s): ${error.message} ===`);
        if (!sourcePrepared || signal.aborted) break;
      }
    }
  } finally {
    for (const [name, handler] of handlers) process.removeListener(name, handler);
    if (preparedHarness) rmSync(preparedHarness.scratch, { recursive: true, force: true });
    console.log("\nCI-only checks not run here: next build, web runtime compatibility, upkeep reader matrix, private-file job.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
