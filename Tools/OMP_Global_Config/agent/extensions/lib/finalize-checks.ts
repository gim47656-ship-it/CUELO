import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, readFile, readlink, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import { Process } from "@oh-my-pi/pi-natives";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { spawnExec, type Exec } from "./cross-review";

export const FINALIZE_CHECKS_CONFIG = ".finalize-checks.json";
const DEFAULT_TIMEOUT_SECONDS = 1_200;
const MAX_TIMER_MS = 2_147_483_647;
const TERMINATION_GRACE_MS = 10_000;
const TAIL_BYTES = 12_000;

type Check = { name: string; paths: string[]; command: [string, ...string[]]; timeoutSeconds: number };
type CheckResult = { name: string; seconds: number; reused: boolean };
export type FinalizeChecksResult = { checks: CheckResult[]; waiver?: string };

type Options = {
  root: string;
  files: readonly string[] | (() => Promise<string[]>);
  sessionManager?: CustomToolContext["sessionManager"];
  ledgerDir?: string;
  waiver?: string;
  authorize?: () => Promise<void>;
  signal?: AbortSignal;
  git?: string;
  exec?: Exec;
  showDirtyTracked?: boolean;
};

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && !/[\\\0\r\n]/.test(value) && !/^[A-Za-z]:/.test(value)
    && value.replace(/\/$/, "").split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function loadConfig(path: string): Promise<{ source: string; checks: Check[] } | undefined> {
  try {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new Error("expected a regular file");
    const source = await readFile(path, "utf8");
    const config: unknown = JSON.parse(source);
    if (!objectWithKeys(config, ["version", "checks"]) || config.version !== 1 || !Array.isArray(config.checks)) {
      throw new Error("expected version 1 and a checks array");
    }
    const names = new Set<string>();
    const checks = config.checks.map((entry: unknown, index: number): Check => {
      if (!objectWithKeys(entry, ["name", "paths", "command", "timeoutSeconds"])) throw new Error(`checks[${index}] has unknown fields or is not an object`);
      const { name, paths, command, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = entry;
      if (typeof name !== "string" || name.trim() !== name || !name || /[\x00-\x1f\x7f]/.test(name) || names.has(name)) {
        throw new Error(`checks[${index}].name must be a unique, non-empty name`);
      }
      if (!Array.isArray(paths) || paths.length === 0 || !paths.every(validPath)) throw new Error(`check ${name}: paths must contain repository-relative file paths or directory prefixes ending in /`);
      if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === "string" && !arg.includes("\0")) || !command[0].trim()) {
        throw new Error(`check ${name}: command must be a non-empty argv array with an executable`);
      }
      if (typeof timeoutSeconds !== "number" || !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1) {
        throw new Error(`check ${name}: timeoutSeconds must be a positive integer`);
      }
      names.add(name);
      return { name, paths, command: command as Check["command"], timeoutSeconds };
    });
    return { source, checks };
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function matches(paths: readonly string[], file: string): boolean {
  if (process.platform === "win32") file = file.toLowerCase();
  return paths.some((path) => {
    if (process.platform === "win32") path = path.toLowerCase();
    return path.endsWith("/") ? file.startsWith(path) : file === path;
  });
}

async function fileFingerprint(root: string, path: string, checkPaths: readonly string[]): Promise<{ value: string; opaque?: true }> {
  const absolute = join(root, path);
  const info = await lstat(absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  if (!info) return { value: "missing" };
  const link = info.isSymbolicLink() ? (await readlink(absolute, { encoding: "buffer" })).toString("base64") : "";
  if (!link && !info.isFile()) return { value: `non-file:${info.mode}`, opaque: true };
  const real = await realpath(absolute).catch((error: NodeJS.ErrnoException) => {
    if (link && error.code === "ENOENT") return undefined;
    throw error;
  });
  const within = real && relative(root, real);
  if (within === undefined || isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
    // The link itself is known even when its target cannot be treated as a repository input.
    return { value: `${real === undefined ? "dangling" : "external"}:${link}`, ...(link && !matches(checkPaths, path) ? {} : { opaque: true }) };
  }
  if (!real) throw new Error("no resolved path");
  const realInfo = await lstat(real, { bigint: true });
  if (!realInfo.isFile()) return { value: `${link}:non-file:${realInfo.mode}`, opaque: true };
  const handle = await open(real, "r");
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("file type changed while opening it");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    const after = await lstat(real, { bigint: true });
    if (before.ino !== after.ino || before.dev !== after.dev || before.mode !== after.mode || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size) {
      throw new Error("file changed while being read");
    }
    return { value: `${link}:${after.mode}:${hash.digest("hex")}` };
  } finally {
    await handle.close();
  }
}

type ReadGit = (args: string[]) => ReturnType<Exec>;
type Snapshot = { hash: string; complete: boolean };

/** Hash raw working bytes rather than `git diff`, which can hide changes behind clean filters and index flags. */
async function fingerprint(root: string, files: readonly string[], paths: readonly string[], git: ReadGit, signal?: AbortSignal): Promise<Snapshot | undefined> {
  try {
    const [head, tracked, committed, untracked] = await Promise.all([
      git(["rev-parse", "--verify", "HEAD"]),
      git(["ls-files", "--stage", "-z"]),
      git(["ls-tree", "--full-tree", "--name-only", "-r", "-z", "HEAD"]),
      git(["-c", "core.untrackedCache=false", "ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    if ([head, tracked, committed, untracked].some((result) => result.code !== 0)) return undefined;
    // Include HEAD paths even when a deletion is already staged and the path is absent from the index.
    const inputs = new Set([FINALIZE_CHECKS_CONFIG, ...files]);
    let complete = true;
    for (const path of committed.stdout.split("\0")) if (path) inputs.add(path);
    for (const entry of tracked.stdout.split("\0")) {
      if (!entry) continue;
      const tab = entry.indexOf("\t");
      if (tab < 0) return undefined;
      if (!entry.slice(0, tab).endsWith(" 0") || entry.startsWith("160000 ")) complete = false;
      inputs.add(entry.slice(tab + 1));
    }
    for (const path of untracked.stdout.split("\0")) if (path && matches(paths, path)) inputs.add(path);
    const hash = createHash("sha256").update(JSON.stringify([head.stdout.trim(), tracked.stdout, files]));
    const ordered: string[] = [];
    for (const path of [...inputs].sort()) {
      // The text Git adapter cannot distinguish invalid UTF-8 from U+FFFD. Keep
      // that part opaque instead of dropping the evidence from all other paths.
      if (path.includes("\uFFFD")) {
        complete = false;
        hash.update(JSON.stringify([path, null]));
      } else ordered.push(path);
    }
    for (let index = 0; index < ordered.length; index += 32) {
      signal?.throwIfAborted();
      const batch = ordered.slice(index, index + 32);
      const entries = await Promise.allSettled(batch.map((path) => fileFingerprint(root, path, paths)));
      for (let offset = 0; offset < batch.length; offset++) {
        const entry = entries[offset];
        if (entry.status === "rejected") {
          complete = false;
          hash.update(JSON.stringify([batch[offset], null]));
        } else {
          if (entry.value.opaque) complete = false;
          hash.update(JSON.stringify([batch[offset], entry.value.value]));
        }
      }
    }
    return { hash: hash.digest("hex"), complete };
  } catch {
    // Cache evidence is optional. Unknown, inaccessible or unsupported inputs require a fresh run.
    return undefined;
  }
}

async function runCommand(check: Check, cwd: string, env: NodeJS.ProcessEnv, fd: number, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return "was cancelled";
  const win = process.platform === "win32";
  const child = spawn(check.command[0], check.command.slice(1), { cwd, env, stdio: ["ignore", fd, fd], detached: !win, windowsHide: true });
  const pid = child.pid;
  let native: Process | null = null;
  if (!win && pid) {
    try { native = Process.fromPid(pid); } catch { /* The live child/group remains available for direct signalling. */ }
  }
  const { promise: closed, resolve: done } = Promise.withResolvers<string | undefined>();
  child.once("error", (error) => done(`could not start: ${error.message}`));
  child.once("close", (code, by) => done(code === 0 ? undefined : code === null ? `was terminated by ${by ?? "an unknown signal"}` : `exited ${code}`));
  let stopped: string | undefined;
  let terminating: Promise<unknown> | undefined;
  let hardKill: ReturnType<typeof setTimeout> | undefined;
  const stop = (reason: string) => {
    if (stopped) return;
    stopped = reason;
    if (!pid || child.exitCode !== null || child.signalCode !== null) return;
    if (win) {
      const { promise, resolve: killed } = Promise.withResolvers<void>();
      terminating = promise;
      execFile("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 }, (error) => {
        if (error) child.kill("SIGKILL");
        killed();
      });
    } else {
      const graceEnd = performance.now() + TERMINATION_GRACE_MS;
      const signalGroup = (name: NodeJS.Signals) => {
        // Only use a numeric PGID while its leader is still our live child.
        if (child.exitCode !== null || child.signalCode !== null) return;
        try { process.kill(-pid, name); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(name);
        }
      };
      const fallback = () => {
        signalGroup("SIGTERM");
        hardKill = setTimeout(() => signalGroup("SIGKILL"), Math.max(0, graceEnd - performance.now()));
      };
      // A stable native reference retains group/tree identity across the grace.
      if (native) terminating = native.terminate({ group: true, gracefulMs: TERMINATION_GRACE_MS }).catch(fallback);
      else fallback();
    }
  };
  const deadline = performance.now() + check.timeoutSeconds * 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    const left = deadline - performance.now();
    if (left <= 0) stop(`timed out after ${check.timeoutSeconds}s`);
    else timer = setTimeout(schedule, Math.min(left, MAX_TIMER_MS));
  };
  const abort = () => stop("was cancelled");
  schedule();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const status = await closed;
    await terminating;
    return stopped ?? status;
  } finally {
    clearTimeout(timer);
    clearTimeout(hardKill);
    signal?.removeEventListener("abort", abort);
  }
}

async function failureContext(root: string, files: readonly string[], git: ReadGit): Promise<string> {
  const result = await git(["--no-optional-locks", "status", "--porcelain=v1", "--no-renames", "--untracked-files=no", "-z"]);
  const label = "Dirty tracked paths outside this publication";
  const paths = result.stdout.split("\0").filter(Boolean).map((line) => line.slice(3))
    .filter((path) => !matches(files, path));
  const names = result.code !== 0 ? "could not be determined" : paths.length === 0 ? "none"
    : paths.slice(0, 8).map((path) => JSON.stringify(path)).join(", ") + (paths.length > 8 ? ` (+${paths.length - 8} more)` : "");
  return `The check ran on the working tree at ${root}. ${label}: ${names}.`;
}

export async function runFinalizeChecks(options: Options): Promise<FinalizeChecksResult | undefined> {
  const configPath = join(options.root, FINALIZE_CHECKS_CONFIG);
  const config = await loadConfig(configPath);
  if (!config?.checks.length) return undefined;
  const files = typeof options.files === "function" ? await options.files() : options.files;
  const selected = config.checks.filter((check) => files.some((file) => matches(check.paths, file)));
  if (!selected.length) return undefined;
  const waiver = options.waiver?.trim();
  if (waiver) return { checks: [], waiver };
  const trust = options.sessionManager && Reflect.get(options.sessionManager, Symbol.for("cuelo.finalizeChecksProjectTrust"));
  const inCuelo = Reflect.get(globalThis, Symbol.for("cuelo.finalizeChecksBrowser")) === true;
  if ((inCuelo || trust !== undefined) && (typeof trust !== "function" || trust(options.root) !== true)) {
    throw new Error(`The project is untrusted, so ${configPath} was not executed. Trust the project in CUELO, or use finalizeChecksWaiver only if the user explicitly requests a waiver.`);
  }
  await options.authorize?.();

  const exec = options.exec ?? spawnExec(options.signal);
  const git: ReadGit = (args) => exec(options.git ?? "git", args, { cwd: options.root });
  const root = await realpath(options.root);
  const agentDir = getAgentDir();
  const ledgerDir = resolve(options.ledgerDir ?? (process.env.OMP_FINALIZE_CHECKS_LEDGER || join(agentDir, "finalize-checks-ledger")));
  const env = { ...process.env };
  const envKey = createHash("sha256").update(JSON.stringify(Object.entries(env).sort())).digest("hex");
  const results: CheckResult[] = [];
  const verified: { check: Check; fingerprint: string }[] = [];
  let ranAfterVerification = false;
  let logDir: string | undefined;
  for (const check of selected) {
    options.signal?.throwIfAborted();
    const prior = await fingerprint(root, files, check.paths, git, options.signal);
    options.signal?.throwIfAborted();
    const slot = createHash("sha256").update(JSON.stringify([root, check.name])).digest("hex");
    const ledgerFile = join(ledgerDir, slot);
    const key = prior?.complete ? createHash("sha256").update(JSON.stringify([2, envKey, check, prior.hash])).digest("hex") : undefined;
    if (key && await readFile(ledgerFile, "utf8").catch(() => undefined) === key) {
      results.push({ name: check.name, seconds: 0, reused: true });
      verified.push({ check, fingerprint: prior!.hash });
      continue;
    }

    if (!logDir) {
      const parent = resolve(options.sessionManager?.getArtifactManager().dir ?? join(agentDir, "artifacts"), "finalize-checks");
      await mkdir(parent, { recursive: true, mode: 0o700 });
      logDir = await mkdtemp(join(parent, "run-"));
    }
    const log = join(logDir, `${results.length + 1}.log`);
    const handle = await open(log, "wx+", 0o600);
    const started = performance.now();
    let failure: string | undefined;
    let tail = "";
    try {
      failure = await runCommand(check, root, env, handle.fd, options.signal).catch((error: Error) => `could not start: ${error.message}`);
      if (failure) {
        const size = (await handle.stat()).size;
        const buf = Buffer.allocUnsafe(Math.min(size, TAIL_BYTES));
        const { bytesRead } = await handle.read(buf, 0, buf.length, size - buf.length);
        tail = buf.subarray(0, bytesRead).toString("utf8").trimEnd().split(/\r?\n/).slice(-60).join("\n");
      }
    } finally {
      await handle.close();
    }
    const seconds = Math.round(performance.now() - started) / 1_000;
    if (failure) {
      const context = options.showDirtyTracked ? await failureContext(root, files, git) : undefined;
      throw new Error([`${check.name} ${failure} (${seconds}s).`, context, tail && `Last output:\n${tail}`, `Full log: ${log}`, "Fix the failing check, then call the publication tool again."].filter(Boolean).join("\n"));
    }
    results.push({ name: check.name, seconds, reused: false });
    ranAfterVerification = verified.length > 0;
    const after = await fingerprint(root, files, check.paths, git, options.signal);
    if (after) verified.push({ check, fingerprint: after.hash });
    if (key && after?.complete && after.hash === prior?.hash) {
      try {
        await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
        await writeFile(ledgerFile, key, { mode: 0o600 });
      } catch { /* An unwritable cache must not turn a successful check into a failed one. */ }
    }
  }
  // Subsequent checks can touch inputs of earlier checks. Do not publish based on a stale pass.
  if (ranAfterVerification) {
    for (const entry of verified) {
      if ((await fingerprint(root, files, entry.check.paths, git, options.signal))?.hash !== entry.fingerprint) {
        throw new Error(`${entry.check.name}'s working-tree inputs changed after it passed. Call the publication tool again when the inputs are stable.`);
      }
    }
  }
  options.signal?.throwIfAborted();
  if (await readFile(configPath, "utf8").catch(() => undefined) !== config.source) {
    throw new Error(`${configPath} changed during the checks; call the publication tool again.`);
  }
  return { checks: results };
}

export function finalizeChecksNote(result?: FinalizeChecksResult): string {
  if (!result) return "";
  if (result.waiver) return `Finalize checks waived by explicit user instruction: ${result.waiver}.`;
  return `Finalize checks: ${result.checks.map(({ name, seconds, reused }) => reused ? `${name} reused` : `${name} ran (${seconds}s)`).join("; ")}.`;
}
