#!/usr/bin/env node
// CUELO self-update worker. `POST /api/updates/apply` spawns it detached; it must outlive the server
// it is replacing, so it is plain Node ESM with no imports beyond node builtins, no dependency on
// Bun's resolution, and no state outside the plan file it is given.
//
//   node bin/self-update.js <plan.json>
//
// The plan is written by lib/self-update.ts (the only writer) and carries the mode, the target
// version, the app root and the recorded supervisor. Nothing here reads a request or a client value.
//
// Order is the same in every mode: stop the recorded supervisor (verifying it is that process), do
// the work while nothing is serving, then start the supervisor again. A server left running across a
// rebuild would serve chunks from the half-written dist dir.
//
// Exit 0 when the worker finished (job.json holds the outcome), non-zero only when it could not run
// at all.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const TERMINAL = new Set(["done", "handed-off", "restart-required", "failed"]);
/** `handed-off` keeps the lock: update.sh is still running and must stay the only update. */
const KEEPS_LOCK = new Set(["done", "restart-required", "failed"]);
const planPath = process.argv[2];
if (!planPath) {
  console.error("usage: node bin/self-update.js <plan.json>");
  process.exit(2);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const dir = plan.selfUpdateDir;
const jobPath = path.join(dir, "job.json");
const lockPath = path.join(dir, "update.lock");
const logPath = plan.logPath || path.join(dir, "update.log");
const nodeBin = plan.nodeBin || "node";
const isWindows = process.platform === "win32";
const dryRun = process.env.CUELO_SELF_UPDATE_DRY_RUN === "1";

let logFd = null;
function log(message) {
  const line = `${new Date().toISOString()} [${plan.mode}] ${message}\n`;
  if (logFd === null) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      logFd = fs.openSync(logPath, "a");
    } catch {
      logFd = null;
    }
  }
  // The server already points this process's stdout at the same file, so stdout is only the
  // fallback when the log cannot be opened; writing both would record every line twice.
  if (logFd !== null) fs.writeSync(logFd, line);
  else process.stdout.write(line);
}

function readJob() {
  try {
    return JSON.parse(fs.readFileSync(jobPath, "utf8"));
  } catch {
    return null;
  }
}

/** Write the status file atomically: the panel polls it while the server is down. */
function updateJob(patch) {
  const current = readJob() ?? {
    schemaVersion: 1,
    mode: plan.mode,
    currentVersion: plan.currentVersion,
    targetVersion: plan.targetVersion,
    targetRef: null,
    supervisorPid: plan.supervisor ? plan.supervisor.pid : null,
    relaunchedPid: null,
    startedAt: new Date().toISOString(),
    error: null,
    logPath,
  };
  const next = { ...current, ...patch, pid: process.pid, logPath, updatedAt: new Date().toISOString() };
  const temp = `${jobPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(temp, jobPath);
  if (TERMINAL.has(next.phase) && KEEPS_LOCK.has(next.phase)) fs.rmSync(lockPath, { force: true });
  return next;
}

function phase(name) {
  updateJob({ phase: name });
  log(`phase ${name}`);
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  updateJob({ phase: "failed", error: message });
  log(`FAILED ${message}`);
  return 1;
}

/**
 * Take the lock over from the server that started us. The server records its own pid when it
 * spawns this process; from here on this worker is the owner, so a worker that dies while the
 * server stays alive still looks stale to the next attempt.
 */
function claimLock() {
  if (dryRun) return;
  try {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } catch (error) {
    log(`could not rewrite ${lockPath}: ${error.message}`);
  }
}

/**
 * The environment a child gets: this worker's, with the old build's identity removed. The server
 * that spawned this worker exported its own NEXT_PUBLIC_APP_VERSION and Next's internal variables,
 * and a build or a relaunch that keeps them produces a server reporting the old version.
 */
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CUELO_SUPERVISOR_PID;
  for (const key of Object.keys(env)) {
    if (key.startsWith("__NEXT") || key === "NEXT_RUNTIME"
      || key === "NEXT_PUBLIC_APP_VERSION" || key === "NEXT_PUBLIC_OMP_VERSION") delete env[key];
  }
  return env;
}

/** Run one command to completion, teeing its output into the log. Rejects on a non-zero exit. */
function run(command, args, options = {}) {
  log(`run ${command} ${args.join(" ")}${options.cwd ? ` (cwd ${options.cwd})` : ""}`);
  if (dryRun) return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: childEnv(options.env),
    stdio: ["ignore", "pipe", "pipe"],
    // cmd.exe gets its command line verbatim; Node's escaping of the quoted program path would
    // otherwise reach cmd as a literal `\"npm.cmd\"`.
    windowsVerbatimArguments: options.verbatim === true,
  });
  let stdout = "";
  let stderr = "";
  for (const [stream, isOut] of [[child.stdout, true], [child.stderr, false]]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (isOut) stdout += chunk;
      else stderr += chunk;
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) log(`  │ ${line}`);
    });
  }
  // A hand-written promise, not Promise.withResolvers: this file runs on whatever `node` the user
  // has, which may be older than 22.
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} exited ${signal ?? `code ${code}`}`));
    });
  });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The running process's argv, when the OS lets us read it. `null` means "cannot tell". */
function processArgs(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * The recorded supervisor is only stopped after its own command line matches what `install.mjs
 * start` recorded. A recycled pid, or a second CUELO instance that overwrote the record, then
 * cannot make this worker kill an unrelated process.
 */
function supervisorMatches(supervisor) {
  if (!isAlive(supervisor.pid)) return false;
  const args = processArgs(supervisor.pid);
  if (args === null) {
    // Only Linux exposes a command line cheaply. Elsewhere the identity check is the server-side one
    // that ran before this worker started: the recorded pid had to equal CUELO_SUPERVISOR_PID.
    if (process.platform !== "linux") {
      log(`cannot read the command line on ${process.platform}; trusting the recorded supervisor id`);
      return true;
    }
    log(`cannot read the command line of ${supervisor.pid}; refusing to stop it`);
    return false;
  }
  const wanted = path.basename(supervisor.args[0] ?? "");
  return args.includes(supervisor.args[0]) || (wanted !== "" && args.some((arg) => path.basename(arg) === wanted));
}

async function stopSupervisor(supervisor) {
  if (!supervisor) return;
  if (!isAlive(supervisor.pid)) {
    log(`supervisor ${supervisor.pid} is already gone`);
    return;
  }
  if (!supervisorMatches(supervisor)) {
    // Something else runs at that pid, or the record belongs to another instance. Starting a second
    // server over the old one would fail on its ports, so the update stops here and says so.
    throw new Error(`the recorded supervisor process ${supervisor.pid} is not this CUELO's installer; refusing to stop it`);
  }
  log(`stopping supervisor ${supervisor.pid}`);
  try {
    process.kill(supervisor.pid, "SIGTERM");
  } catch (error) {
    log(`SIGTERM to ${supervisor.pid} failed: ${error.message}`);
  }
  for (let waited = 0; waited < 60_000 && isAlive(supervisor.pid); waited += 500) await sleep(500);
  if (isAlive(supervisor.pid)) throw new Error(`supervisor ${supervisor.pid} did not stop`);
}

async function portAnswers(port) {
  if (!port) return false;
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD", signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * The next server cannot bind a port something still serves, and a later health check on a busy port
 * would be answered by the old process. So an occupied port stops the update here instead.
 */
async function requirePortFree() {
  const port = plan.webPort;
  if (!port) return;
  for (let waited = 0; waited < 60_000; waited += 500) {
    if (!(await portAnswers(port))) return;
    await sleep(500);
  }
  throw new Error(`something still answers on port ${port}; the old CUELO did not stop`);
}

/**
 * Start the supervisor again with the recorded argv, from the recorded directory, and in an
 * environment without the old build's version or Next's internal variables: the new server must
 * report its own version, or the panel would never see the update land.
 */
function relaunchSupervisor(supervisor) {
  if (!supervisor) return null;
  log(`relaunch ${supervisor.command} ${supervisor.args.join(" ")}`);
  if (dryRun) return null;
  const out = fs.openSync(path.join(dir, "supervisor.log"), "a");
  try {
    const child = spawn(supervisor.command, supervisor.args, {
      cwd: supervisor.cwd,
      detached: true,
      stdio: ["ignore", out, out],
      env: childEnv(),
    });
    child.unref();
    if (!child.pid) throw new Error("the supervisor did not start");
    return child.pid;
  } finally {
    fs.closeSync(out);
  }
}

/**
 * Relaunch the recorded supervisor and wait until it answers. Throws instead of writing the job
 * itself: a caller that still has a fallback (a rebuilt previous release) must get the chance to use
 * it, and a job must never read `done` before the new server is really serving.
 */
async function startSupervisor(webPort) {
  const supervisor = plan.supervisor;
  if (!supervisor) throw new Error("this CUELO was not started by `install.mjs start`, so the worker cannot restart it");
  phase("restarting");
  const pid = relaunchSupervisor(supervisor);
  launched = pid;
  if (dryRun) return pid;
  for (let waited = 0; waited < 180_000; waited += 1000) {
    if (await portAnswers(webPort)) {
      log(`restarted (pid ${pid}) and answering on ${webPort}`);
      return pid;
    }
    if (pid !== null && !isAlive(pid)) throw new Error("the restarted CUELO exited before it answered; see supervisor.log");
    await sleep(1000);
  }
  throw new Error(`the restarted CUELO did not answer on port ${webPort}`);
}

/**
 * The supervisor this worker started, if any. A fallback must clear it away before trying again:
 * two supervisors on one port would leave the second refusing to start ("Already in use"), and a
 * rebuild underneath a live server would have it serve a dist dir that is being rewritten.
 */
let launched = null;

async function stopLaunched() {
  const pid = launched;
  launched = null;
  if (pid === null || !isAlive(pid)) return !(await portAnswers(plan.webPort));
  log(`stopping the supervisor this update started (${pid}) before trying again`);
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    log(`SIGTERM to ${pid} failed: ${error.message}`);
  }
  for (let waited = 0; waited < 30_000 && isAlive(pid); waited += 500) await sleep(500);
  for (let waited = 0; waited < 30_000; waited += 500) {
    if (!(await portAnswers(plan.webPort))) return true;
    await sleep(500);
  }
  log(`port ${plan.webPort} is still busy after stopping ${pid}`);
  return false;
}

/** The successful end of a run: the new server answers, or it needs a manual start. */
async function finishRestart() {
  if (!plan.supervisor) {
    updateJob({ phase: "restart-required" });
    log("no recorded supervisor: the new version starts on the next `cuelo start`");
    return 0;
  }
  const pid = await startSupervisor(plan.webPort);
  updateJob({ phase: "done", relaunchedPid: pid });
  return 0;
}

/** Best effort after a failure once the old server was stopped: get some server answering again. */
async function restartPrevious() {
  if (!plan.supervisor) {
    log("no recorded supervisor: CUELO stays stopped until `cuelo start` runs");
    return;
  }
  // A leftover listener would answer the health check while the new supervisor exits on the busy
  // port, and the job would name a process that is not serving.
  if (!(await stopLaunched())) {
    log("CUELO is still served by a process this worker did not start; not starting another one");
    return;
  }
  try {
    const pid = await startSupervisor(plan.webPort);
    updateJob({ relaunchedPid: pid, phase: currentPhase() });
  } catch (error) {
    log(`could not start CUELO again: ${error.message}`);
  }
}

function currentPhase() {
  return readJob()?.phase ?? "failed";
}

function git(args, cwd) {
  return run("git", args, { cwd });
}

/** An npm install replaces the package tree, so nothing of this build may be running while it runs. */
async function npmUpdate() {
  const spec = `cuelo@${plan.targetVersion}`;
  if (!plan.supervisor) {
    // Installing over a running tree would replace files this server has open, and nothing here
    // could start it again. Say so instead of half-applying the update.
    throw new Error("this CUELO was not started by `install.mjs start`, so it cannot be restarted after the install; use the manual command");
  }
  await stopSupervisor(plan.supervisor);
  try {
    await requirePortFree();
    phase("installing");
    // `npm.cmd` cannot be spawned without a shell on Windows (Node rejects .cmd/.bat since the
    // CVE-2024-27980 fix), so the shell form is the only one that works there.
    if (isWindows) {
      // `/s` strips the outer quotes and the InnerCommand keeps them, so a path with spaces works.
      await run(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${plan.npmBin}" install -g ${spec}"`], { verbatim: true });
    } else {
      await run(plan.npmBin || "npm", ["install", "-g", spec]);
    }
    updateJob({ targetRef: spec });
    log(`installed ${spec}`);
    return await finishRestart();
  } catch (error) {
    // CUELO is stopped here: the previous package is already gone, so this reports what happened and
    // puts the supervisor back, which is the only server left to offer.
    await restartPrevious();
    throw error;
  }
}

async function sourceUpdate() {
  const root = plan.appRoot;
  if (!plan.supervisor) {
    // `setup` rebuilds the dist dir this server serves; without a supervisor nothing here could stop
    // it first or start it again.
    throw new Error("this CUELO was not started by `install.mjs start`, so it cannot be restarted after the build; use the manual command");
  }
  phase("fetching");
  const status = await git(["status", "--porcelain"], root);
  if (status.stdout.trim()) throw new Error("the source checkout has local changes; commit or stash them first");
  const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], root)).stdout.trim();
  if (branch === "HEAD") throw new Error("the source checkout is not on a branch; check out the release branch first");
  await git(["fetch", "--tags", "--quiet", "origin"], root);

  // Only the release the server announced. Following the branch head instead could install commits
  // that were never released, while the job would still claim it installed `targetVersion`.
  const tag = plan.tagName || `v${plan.targetVersion}`;
  const hasTag = await git(["rev-parse", "--verify", `refs/tags/${tag}`], root).then(() => true, () => false);
  if (!hasTag) {
    throw new Error(`the release tag ${tag} is not in the remote; the manual update command covers this checkout`);
  }

  // `setup` builds into the dist dir this checkout serves, so the server must not be reading it
  // while it runs. The old commit is kept so a failed build can be undone instead of leaving a
  // checkout that matches neither release.
  const oldHead = (await git(["rev-parse", "HEAD"], root)).stdout.trim();
  await stopSupervisor(plan.supervisor);
  try {
    await requirePortFree();
    await git(["merge", "--ff-only", "--quiet", tag], root);
  } catch (error) {
    // Nothing was rebuilt yet: the checkout is either untouched or on the new tag, and the old tree
    // still starts. Bring it back rather than leaving the machine without a server.
    await restartPrevious();
    throw error;
  }
  updateJob({ targetRef: tag });
  log(`fast-forwarded ${branch} to ${tag}`);

  const setupArgs = [path.join(root, "install.mjs"), "setup"];
  // `--home` is carried over only when the supervisor was started with one, so a custom
  // PI_CODING_AGENT_DIR is never redirected to a plain profile.
  if (plan.home) setupArgs.push("--home", plan.home);
  const setupEnv = { CUELO_SELF_UPDATE_DIR: dir };
  if (plan.distDir) setupEnv.CUELO_DIST_DIR = plan.distDir;

  phase("building");
  try {
    await run(nodeBin, setupArgs, { cwd: root, env: setupEnv });
  } catch (error) {
    log(`setup failed at ${tag}; going back to ${oldHead.slice(0, 12)}`);
    let restored = false;
    try {
      await git(["reset", "--hard", "--quiet", oldHead], root);
      await run(nodeBin, setupArgs, { cwd: root, env: setupEnv });
      restored = true;
      log("the previous release is built again");
    } catch (rollbackError) {
      log(`could not rebuild the previous release: ${rollbackError.message}`);
    }
    // Never `done`: this run failed even when a server answers again, and the phase already says so.
    await restartPrevious();
    throw new Error(restored
      ? `${error.message} — the checkout went back to the previous release`
      : `${error.message} — the checkout was reset to the previous release but rebuilding it failed; run the manual update command`);
  }
  log("setup finished");
  try {
    return await finishRestart();
  } catch (error) {
    // The new release is built but did not come up; go back to the commit that was serving and
    // rebuild it so the machine is not left on a build that does not start.
    log(`the new release did not start: ${error.message}; rebuilding ${oldHead.slice(0, 12)}`);
    // The dist dir is rebuilt below, so the server this update launched must be gone first; it may
    // still be running when the health check timed out.
    await stopLaunched();
    try {
      await git(["reset", "--hard", "--quiet", oldHead], root);
      await run(nodeBin, setupArgs, { cwd: root, env: setupEnv });
    } catch {
      log("could not rebuild the previous release; the dist dir may be incomplete");
    }
    // Whatever is on disk now, a server is better than none; the job still reports the failure.
    await restartPrevious();
    throw error;
  }
}

/**
 * The WSL ops service owns its own staged build, drain and rollback. Hand off to it in a separate
 * transient unit: the server lives inside cuelo-<port>.service, so a child of this process would be
 * stopped by update.sh's own `systemctl stop`.
 */
async function wslUpdate() {
  phase("fetching");
  const unit = `cuelo-update-${Math.floor(Date.now() / 1000)}`;
  const args = ["--user", `--unit=${unit}`, "--collect"];
  if (plan.wsl && plan.wsl.distro) args.push(`--setenv=WSL_DISTRO_NAME=${plan.wsl.distro}`);
  args.push("bash", plan.wsl.script);
  if (dryRun) {
    log(`systemd-run ${args.join(" ")} (dry run)`);
    updateJob({ phase: "handed-off", targetRef: unit });
    return 0;
  }
  const child = spawn("systemd-run", args, { detached: true, stdio: "ignore" });
  // Keep the child referenced until systemd-run returns (it exits once the unit has started): an
  // unref'd child keeps nothing alive, so this process would exit before it records the hand-off.
  await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`systemd-run exited ${code}`))));
  });
  // The lock stays: update.sh is running, and a second press must not start another one.
  updateJob({ phase: "handed-off", targetRef: unit });
  log(`handed off to ${unit}; the update script keeps its own wait screen and rollback`);
  return 0;
}

async function main() {
  log(`start pid=${process.pid} target=${plan.targetVersion} mode=${plan.mode}`);
  claimLock();
  if (plan.mode === "npm") return npmUpdate();
  if (plan.mode === "source") return sourceUpdate();
  if (plan.mode === "wsl") return wslUpdate();
  throw new Error(`unknown mode: ${plan.mode}`);
}

main().then(
  (code) => process.exit(code),
  (error) => {
    fail(error);
    process.exit(0);
  },
);
