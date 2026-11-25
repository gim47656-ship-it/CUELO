import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import { Process } from "@oh-my-pi/pi-natives";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { spawnExec, type Exec } from "./cross-review";
import { windowsPathToPosix } from "../../tools/git-finalizer/wsl-git";

export const FINALIZE_CHECKS_CONFIG = ".finalize-checks.json";
const DEFAULT_TIMEOUT_SECONDS = 1_200;
const MAX_TIMER_MS = 2_147_483_647;
const TERMINATION_GRACE_MS = 10_000;
const TAIL_BYTES = 12_000;

type Check = { name: string; paths: string[]; command: [string, ...string[]]; timeoutSeconds: number };
type CheckResult = { name: string; seconds: number; reused: boolean };
export type FinalizeChecksResult = {
  checks: CheckResult[];
  waiver?: string;
  publicationHead?: string;
  candidateTree?: string;
  candidateContext?: string;
};

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
  publicationCandidate?: boolean;
};

function objectWithKeys(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && !/[\\\0\r\n]/.test(value) && !/^[A-Za-z]:/.test(value)
    && value.replace(/\/$/, "").split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

async function readConfigSource(path: string): Promise<string | undefined> {
  try {
    const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    if (!stat) return undefined;
    if (!stat.isFile()) throw new Error("expected a regular file");
    return await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseConfig(path: string, source: string): Check[] {
  try {
    const config: unknown = JSON.parse(source);
    if (!objectWithKeys(config, ["version", "checks"]) || config.version !== 1 || !Array.isArray(config.checks)) {
      throw new Error("expected version 1 and a checks array");
    }
    const names = new Set<string>();
    return config.checks.map((entry: unknown, index: number): Check => {
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

async function fileFingerprint(root: string, path: string, checkPaths: readonly string[], untrackedInput: boolean): Promise<{ value: string; opaque?: true }> {
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
    return { value: `${real === undefined ? "dangling" : "external"}:${link}`, ...(link && !untrackedInput && !matches(checkPaths, path) ? {} : { opaque: true }) };
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

function runtimeFingerprints(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const pathKey = process.platform === "win32" ? Object.keys(env).sort().find((key) => key.toUpperCase() === "PATH") : "PATH";
  const path = pathKey === undefined ? undefined : env[pathKey];
  const host = realpath(process.execPath).catch(() => undefined);
  const probes = new Map<string, Promise<string | undefined>>();
  const probe = async (command: string) => {
    try {
      if (path === undefined) return undefined;
      const executable = Bun.which(command, { PATH: path, cwd });
      if (!executable) return undefined;
      const resolved = await realpath(executable);
      const identity = JSON.stringify([executable, resolved, statIdentity(await stat(resolved, { bigint: true }))]);
      let version = probes.get(identity);
      if (!version) {
        const { promise, resolve } = Promise.withResolvers<string | undefined>();
        execFile(executable, ["--version"], { cwd, env, signal, timeout: 2_000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 4_096 },
          (error, stdout) => {
            const text = stdout.trim();
            resolve(!error && /^v?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(text) ? text : undefined);
          });
        version = promise;
        probes.set(identity, version);
      }
      const text = await version;
      return text === undefined ? undefined : [identity, text];
    } catch {
      // A failing or unresolvable probe must never turn into evidence for reuse.
      return undefined;
    }
  };
  return async (command: string) => {
    const local = /^(bun|node)(\.exe)?$/i.test(basename(command)) && !/^(bun|node)$/.test(command);
    const [executable, node, bun, direct] = await Promise.all([host, probe("node"), probe("bun"), local ? probe(command) : null]);
    return executable && node && bun && direct !== undefined
      ? [executable, process.versions.node, process.versions.bun, node, bun, direct] : undefined;
  };
}

function statIdentity(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.ctimeNs, info.mtimeNs].join(":");
}

const installEntries = { ".bin": true, ".bun": true, ".modules.yaml": true, ".package-lock.json": true,
  ".pnpm": true, ".yarn-integrity": true, ".yarn-state.yml": true };

async function installedDependencies(root: string, inputs: Iterable<string>, signal?: AbortSignal) {
  const dirs = new Set<string>();
  for (let dir = root;; dir = dirname(dir)) {
    dirs.add(join(dir, "node_modules"));
    if (dir === dirname(dir)) break;
  }
  for (const path of inputs) {
    if (path.endsWith("/package.json") && !path.includes("\uFFFD")) dirs.add(join(root, dirname(path), "node_modules"));
  }
  const optional = (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  };
  const identity = async (path: string, info: BigIntStats) => {
    const target = info.isSymbolicLink() ? await stat(path, { bigint: true }) : info;
    return statIdentity(target);
  };
  try {
    const hash = createHash("sha256");
    for (const dir of [...dirs].sort()) {
      signal?.throwIfAborted();
      const info = await lstat(dir, { bigint: true }).catch(optional);
      if (!info) continue;
      // Include install metadata and hoisted package manifests, not package payloads
      // or tool caches. Scope folders are the only extra level we enumerate.
      const packages: string[] = [];
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name.includes("\uFFFD")) return undefined;
        if (Object.hasOwn(installEntries, entry.name)) packages.push(entry.name);
        else if (entry.name.startsWith("@")) {
          for (const name of await readdir(join(dir, entry.name))) {
            if (name.includes("\uFFFD")) return undefined;
            packages.push(`${entry.name}/${name}/package.json`);
          }
        } else if (!entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink())) {
          packages.push(`${entry.name}/package.json`);
        }
      }
      hash.update(JSON.stringify([dir, await identity(dir, info)]));
      packages.sort();
      for (let index = 0; index < packages.length; index += 64) {
        signal?.throwIfAborted();
        const entries = packages.slice(index, index + 64);
        const ids = await Promise.all(entries.map(async (name) => {
          const path = join(dir, name);
          const info = await lstat(path, { bigint: true }).catch(optional);
          return info && identity(path, info);
        }));
        hash.update(JSON.stringify([entries, ids]));
      }
    }
    return hash.digest("hex");
  } catch {
    // Inaccessible or unsupported installed state cannot certify a cached pass.
    return undefined;
  }
}

type ReadGit = (args: string[]) => ReturnType<Exec>;
type Snapshot = { hash: string; sourceHash: string; receiptHash?: string };

/** Hash raw working bytes rather than `git diff`, which can hide changes behind clean filters and index flags. */
async function fingerprint(
  root: string, files: readonly string[], paths: readonly string[], git: ReadGit,
  signal?: AbortSignal, publication = false, collectReceipt = false,
): Promise<Snapshot | undefined> {
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
    const outputs = new Set<string>();
    const extraInputs = new Set<string>();
    for (const path of untracked.stdout.split("\0")) {
      if (!path || inputs.has(path)) continue;
      if (matches(paths, path)) {
        inputs.add(path);
        if (publication) outputs.add(path);
      } else if (collectReceipt) extraInputs.add(path);
    }
    const dependencyState = collectReceipt ? installedDependencies(root, [...inputs, ...extraInputs], signal) : undefined;
    const extraHash = collectReceipt ? createHash("sha256") : undefined;
    const hash = createHash("sha256").update(JSON.stringify([head.stdout.trim(), tracked.stdout, files]));
    const sourceHash = outputs.size ? hash.copy() : undefined;
    const update = (path: string, value: string | null) => {
      const data = JSON.stringify([path, value]);
      // Check selection paths are not a read boundary. This widens the receipt,
      // not the publication source/output classification or transaction checks.
      if (extraInputs.has(path)) extraHash?.update(data);
      else {
        hash.update(data);
        if (!outputs.has(path)) sourceHash?.update(data);
      }
    };
    const ordered: string[] = [];
    for (const path of [...inputs, ...extraInputs].sort()) {
      // The text Git adapter cannot distinguish invalid UTF-8 from U+FFFD. Keep
      // that part opaque instead of dropping the evidence from all other paths.
      if (path.includes("\uFFFD")) {
        complete = false;
        update(path, null);
      } else ordered.push(path);
    }
    for (let index = 0; index < ordered.length; index += 32) {
      signal?.throwIfAborted();
      const batch = ordered.slice(index, index + 32);
      const entries = await Promise.allSettled(batch.map((path) => fileFingerprint(root, path, paths, extraInputs.has(path))));
      for (let offset = 0; offset < batch.length; offset++) {
        const entry = entries[offset];
        if (entry.status === "rejected") {
          complete = false;
          update(batch[offset], null);
        } else {
          if (entry.value.opaque) complete = false;
          update(batch[offset], entry.value.value);
        }
      }
    }
    const digest = hash.digest("hex");
    const dependencies = await dependencyState;
    const receiptHash = complete && dependencies !== undefined ? extraHash?.update(digest).update(dependencies).digest("hex") : undefined;
    return { hash: digest, sourceHash: sourceHash?.digest("hex") ?? digest, receiptHash };
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

async function gitOutput(git: ReadGit, args: string[]): Promise<string> {
  const result = await git(args);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${(result.stderr || result.stdout).trim() || `exit ${result.code}`}`);
  return result.stdout;
}

async function verifyPublicationConfig(git: ReadGit, head: string, source: string | undefined) {
  const entry = (await gitOutput(git, ["ls-tree", head, "--", FINALIZE_CHECKS_CONFIG])).trim();
  const blob = /^100(?:644|755) blob ([0-9a-f]+)\t/.exec(entry)?.[1];
  const committed = blob === undefined ? undefined : await gitOutput(git, ["cat-file", "blob", blob]);
  // Git can store LF for a CRLF checkout. The actual checkout bytes still bind the receipt.
  if ((entry && !blob) || committed?.replaceAll("\r\n", "\n") !== source?.replaceAll("\r\n", "\n")) {
    throw new Error(`${FINALIZE_CHECKS_CONFIG} differs from the publication candidate. Include it in the publication or restore its committed version.`);
  }
}

async function excludedPaths(git: ReadGit, files: readonly string[], checkIndexFlags = false): Promise<string[]> {
  const [status, flags] = await Promise.all([
    gitOutput(git, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "status", "--porcelain=v1", "--no-renames", `--untracked-files=${checkIndexFlags ? "all" : "no"}`, "--ignore-submodules=none", "-z"]),
    checkIndexFlags ? gitOutput(git, ["ls-files", "-v", "-z"]) : "",
  ]);
  const paths = new Set(status.split("\0").filter(Boolean).map((line) => line.slice(3)));
  // Skip-worktree and assume-unchanged paths can hide divergence from status.
  for (const entry of flags.split("\0")) if (/^[Sa-z] /.test(entry)) paths.add(entry.slice(2));
  return [...paths].filter((path) => !matches(files, path));
}

async function withCandidate<T>(
  options: Options, root: string, head: string, files: readonly string[], git: ReadGit,
  run: (cwd: string, git: ReadGit, tree: string, cache: string) => Promise<T>,
): Promise<T> {
  const parent = await realpath(tmpdir());
  const fromRepo = relative(root, parent);
  if (!isAbsolute(fromRepo) && fromRepo !== ".." && !fromRepo.startsWith(`..${sep}`)) {
    throw new Error("The temporary directory for publication candidates must be outside the repository.");
  }
  // Repository-local overrides would redirect writes away from the private index.
  for (const name of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY"]) {
    if (process.env[name] !== undefined) throw new Error(`Unset ${name} before constructing the publication candidate.`);
  }
  // Windows Git locates the source; native WSL Git creates a POSIX gitdir for native checks.
  const wslWindowsGit = options.git === "git.exe" && process.platform === "linux";
  const gitDir = (await gitOutput(git, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const commonDir = wslWindowsGit ? windowsPathToPosix(gitDir) : gitDir;
  const temp = await mkdtemp(join(parent, "omp-publication-"));
  const cwd = join(temp, "candidate");
  const exec = options.exec ?? spawnExec(options.signal);
  const command = wslWindowsGit ? "git" : options.git ?? "git";
  const flags = ["-c", `core.hooksPath=${join(temp, "no-hooks")}`, "-c", "core.fsmonitor=false",
    "-c", "core.sparseCheckout=false", "-c", "core.untrackedCache=false"];
  const repoArgs = [`--git-dir=${commonDir}`, ...flags];
  const candidateGit: ReadGit = (args) => exec(command, [...flags, ...args], { cwd });
  const uncancelled = spawnExec();
  const worktreeGit: ReadGit = (args) => uncancelled(command, [...repoArgs, ...args], { cwd: root });
  let registered = false;
  let failure: unknown;
  try {
    // No checkout/hook sees the wrong tree. Git stages from the source under
    // the same repository config, but only in the candidate's private index.
    await gitOutput(worktreeGit, ["worktree", "add", "--detach", "--no-checkout", cwd, head]);
    registered = true;
    options.signal?.throwIfAborted();
    await gitOutput(candidateGit, ["read-tree", head]);
    if (wslWindowsGit) {
      // Stage with the same Git that will publish (including Windows filter/EOL config).
      // Pass its private gitdir directly: the temporary checkout's .git file uses POSIX paths.
      const privateDir = (await gitOutput(candidateGit, ["rev-parse", "--absolute-git-dir"])).trim();
      const paths = await Promise.all([privateDir, root].map(async (path) => {
        const converted = await exec("wslpath", ["-w", path], { cwd: root });
        if (converted.code !== 0 || !converted.stdout.trim()) throw new Error(`Could not convert ${path}: ${converted.stderr || converted.stdout}`);
        return converted.stdout.trim();
      }));
      await gitOutput(git, [`--git-dir=${paths[0]}`, `--work-tree=${paths[1]}`, "-c", "core.fsmonitor=false",
        "-c", "core.sparseCheckout=false", "--literal-pathspecs", "add", "-A", "--", ...files]);
    } else {
      await gitOutput(candidateGit, [`--work-tree=${root}`, "--literal-pathspecs", "add", "-A", "--", ...files]);
    }
    const tree = (await gitOutput(candidateGit, ["write-tree"])).trim();
    await gitOutput(candidateGit, ["checkout-index", "--all", "--index"]);
    return await run(cwd, candidateGit, tree, join(temp, "bun-cache"));
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    // Cleanup is uncancelled. Preserve the check's log/error even if teardown fails.
    let unregisterError: unknown;
    const remove = ["worktree", "remove", "--force", cwd];
    if (registered || await lstat(join(cwd, ".git")).catch(() => undefined)) {
      await gitOutput(worktreeGit, remove).catch((error) => { unregisterError = error; });
    }
    let directoryError: unknown;
    await rm(temp, { recursive: true, force: true, maxRetries: 2 }).catch((error) => { directoryError = error; });
    if (unregisterError && !directoryError) {
      // The filesystem changed: retry only the owned registry entry after removing its tree.
      unregisterError = undefined;
      await gitOutput(worktreeGit, remove).catch((error) => { unregisterError = error; });
    }
    if (unregisterError || directoryError) {
      const details = [unregisterError, directoryError].filter(Boolean).map(String).join("; ");
      throw new Error(`${failure ? `${failure instanceof Error ? failure.message : String(failure)}\n` : ""}Publication candidate cleanup failed (${temp}): ${details}`, { cause: failure });
    }
  }
}

export async function runFinalizeChecks(options: Options): Promise<FinalizeChecksResult | undefined> {
  const configPath = join(options.root, FINALIZE_CHECKS_CONFIG);
  const exec = options.exec ?? spawnExec(options.signal);
  const git: ReadGit = (args) => exec(options.git ?? "git", args, { cwd: options.root });
  const publicationHead = options.publicationCandidate ? (await gitOutput(git, ["rev-parse", "--verify", "HEAD"])).trim() : undefined;
  const source = await readConfigSource(configPath);
  const files = options.files;
  const publicationFiles = publicationHead ? (typeof files === "function" ? await files() : files) : undefined;
  if (publicationHead && publicationFiles && !matches(publicationFiles, FINALIZE_CHECKS_CONFIG)) {
    await verifyPublicationConfig(git, publicationHead, source);
  }
  const noChecks = publicationHead ? { checks: [], publicationHead } : undefined;
  if (source === undefined) return noChecks;
  const checks = parseConfig(configPath, source);
  if (!checks.length) return noChecks;
  const paths = publicationFiles ?? (typeof files === "function" ? await files() : files);
  const selected = checks.filter((check) => paths.some((file) => matches(check.paths, file)));
  if (!selected.length) return noChecks;
  const waiver = options.waiver?.trim();
  if (waiver) return { checks: [], waiver, publicationHead };
  const trust = options.sessionManager && Reflect.get(options.sessionManager, Symbol.for("cuelo.finalizeChecksProjectTrust"));
  const inCuelo = Reflect.get(globalThis, Symbol.for("cuelo.finalizeChecksBrowser")) === true;
  if ((inCuelo || trust !== undefined) && (typeof trust !== "function" || trust(options.root) !== true)) {
    throw new Error(`The project is untrusted, so ${configPath} was not executed. Trust the project in CUELO, or use finalizeChecksWaiver only if the user explicitly requests a waiver.`);
  }
  await options.authorize?.();

  options.signal?.throwIfAborted();
  const root = await realpath(options.root);
  if (!publicationHead) return runSelectedChecks(options, root, paths, source, selected, root, git);
  const excluded = await excludedPaths(git, paths, true);
  const context = excluded.length
    ? `The checks ran on an isolated publication candidate. Excluded dirty or index-hidden paths: ${excluded.slice(0, 8).map((path) => JSON.stringify(path)).join(", ")}${excluded.length > 8 ? ` (+${excluded.length - 8} more)` : ""}.`
    : "The checks ran on the publication candidate in place; no dirty paths were excluded.";
  if (!excluded.length) {
    const result = await runSelectedChecks(options, root, paths, source, selected, root, git, context);
    if ((await excludedPaths(git, paths)).length) throw new Error("Paths outside the publication changed during the checks; call the publication tool again.");
    return { ...result, publicationHead };
  }
  return withCandidate(options, root, publicationHead, paths, git, async (cwd, candidateGit, candidateTree, bunCache) => {
    const candidateSource = await readConfigSource(join(cwd, FINALIZE_CHECKS_CONFIG));
    if (candidateSource === undefined || candidateSource.replaceAll("\r\n", "\n") !== source.replaceAll("\r\n", "\n")) {
      throw new Error(`${configPath} differs from the materialized publication candidate. Include it in the publication or restore its committed version.`);
    }
    const result = await runSelectedChecks(options, root, paths, candidateSource, selected, cwd, candidateGit, context, candidateTree, bunCache);
    if (await readFile(configPath, "utf8").catch(() => undefined) !== source) {
      throw new Error(`${configPath} changed during the checks; call the publication tool again.`);
    }
    return { ...result, publicationHead, candidateTree };
  });
}

async function runSelectedChecks(
  options: Options, root: string, files: readonly string[], source: string, selected: readonly Check[],
  cwd: string, git: ReadGit, candidateContext?: string, candidateTree?: string, bunCache?: string,
): Promise<FinalizeChecksResult> {
  const agentDir = getAgentDir();
  const ledgerDir = resolve(options.ledgerDir ?? (process.env.OMP_FINALIZE_CHECKS_LEDGER || join(agentDir, "finalize-checks-ledger")));
  const env = { ...process.env };
  const envKey = createHash("sha256").update(JSON.stringify(Object.entries(env).sort())).digest("hex");
  // No ignored paths are transferred. CUELO installs and prepares SDK/native
  // dependencies in cwd; a private Bun cache cannot hardlink back into the source.
  // A check that installs by copying may opt into OMP_FINALIZE_BUN_CACHE, which outlives the
  // candidate (a fresh cache re-downloaded 1,107 packages in 450s on 11-26). Checks that ignore it,
  // including older revisions that patch hardlinked files, keep the disposable cache.
  if (bunCache) {
    env.BUN_INSTALL_CACHE_DIR = bunCache;
    env.PWD = cwd;
    env.OMP_FINALIZE_BUN_CACHE = join(agentDir, "finalize-checks-bun-cache");
  }
  const runtimeFingerprint = runtimeFingerprints(cwd, env, options.signal);
  const results: CheckResult[] = [];
  const verified: { check: Check; fingerprint: string }[] = [];
  let ranAfterVerification = false;
  let logDir: string | undefined;
  for (const check of selected) {
    options.signal?.throwIfAborted();
    const [prior, runtime] = await Promise.all([
      fingerprint(cwd, files, check.paths, git, options.signal, options.publicationCandidate, true),
      runtimeFingerprint(check.command[0]),
    ]);
    options.signal?.throwIfAborted();
    const slot = createHash("sha256").update(JSON.stringify([root, check.name])).digest("hex");
    const ledgerFile = join(ledgerDir, slot);
    const key = prior?.receiptHash && runtime && !env.NODE_PATH ? createHash("sha256")
      .update(JSON.stringify([4, envKey, runtime, check, !!options.publicationCandidate, candidateTree ?? null, prior.receiptHash])).digest("hex") : undefined;
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
      failure = await runCommand(check, cwd, env, handle.fd, options.signal).catch((error: Error) => `could not start: ${error.message}`);
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
      throw new Error([`${check.name} ${failure} (${seconds}s).`, candidateContext, tail && `Last output:\n${tail}`, `Full log: ${log}`, "Fix the failing check, then call the publication tool again."].filter(Boolean).join("\n"));
    }
    results.push({ name: check.name, seconds, reused: false });
    ranAfterVerification = verified.length > 0;
    const after = await fingerprint(cwd, files, check.paths, git, options.signal, options.publicationCandidate, Boolean(key));
    if (options.publicationCandidate && prior?.sourceHash !== after?.sourceHash) {
      throw new Error(`${check.name}'s publication candidate inputs changed during the check. Call the publication tool again when the inputs are stable.`);
    }
    if (after) verified.push({ check, fingerprint: after.hash });
    if (key && after?.receiptHash === prior?.receiptHash) {
      try {
        await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
        await writeFile(ledgerFile, key, { mode: 0o600 });
      } catch { /* An unwritable cache must not turn a successful check into a failed one. */ }
    }
  }
  // Subsequent checks can touch inputs of earlier checks. Do not publish based on a stale pass.
  if (ranAfterVerification) {
    for (const entry of verified) {
      if ((await fingerprint(cwd, files, entry.check.paths, git, options.signal))?.hash !== entry.fingerprint) {
        throw new Error(`${entry.check.name}'s working-tree inputs changed after it passed. Call the publication tool again when the inputs are stable.`);
      }
    }
  }
  options.signal?.throwIfAborted();
  const configPath = join(cwd, FINALIZE_CHECKS_CONFIG);
  if (await readFile(configPath, "utf8").catch(() => undefined) !== source) {
    throw new Error(`${configPath} changed during the checks; call the publication tool again.`);
  }
  return { checks: results, candidateContext };
}

export function finalizeChecksNote(result?: FinalizeChecksResult): string {
  if (!result) return "";
  if (result.waiver) return `Finalize checks waived by explicit user instruction: ${result.waiver}.`;
  if (!result.checks.length) return "";
  return `Finalize checks: ${result.checks.map(({ name, seconds, reused }) => reused ? `${name} reused` : `${name} ran (${seconds}s)`).join("; ")}.`
    + (result.candidateContext ? ` ${result.candidateContext}` : "");
}
