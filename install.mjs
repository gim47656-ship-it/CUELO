#!/usr/bin/env node
// CUELO public installer. Run it explicitly; no npm lifecycle script calls it.
//
//   node install.mjs [setup] [--home <dir>] [--model <provider/model>] [--role <name>=<provider/model[:effort]>]...
//   node install.mjs start [--home <dir>] [--port-base <n>]
//   node install.mjs health [--port-base <n>]
//   node install.mjs harness-diff [--home <dir>] [--json]
//   node install.mjs harness-update [--home <dir>] [--dry-run] [--json]
//
// setup: in a source checkout installs dependencies, builds, applies and checks
// the SDK patches (same steps as ci.yml and bin/prepare-runtime.js); in an
// installed npm package it only checks the prepared runtime. Then it copies the
// public harness into the omp profile without replacing anything already there.
// start: runs the app and the three local sidecars in the foreground.
// health: asks the four local services whether they answer, without calling a provider.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(ROOT, "package.json"));

/**
 * Model slots used by the public harness; `--model` sets omp's core `default` separately.
 * Keep these available through both the installer and `lib/harness-roles.ts`.
 * The installer cannot import that TypeScript module before dependencies exist.
 */
export const HARNESS_ROLES = [
  "implSonnet",
  "implOpus",
  "implDeepSeek",
  "makerHardUiOpus",
  "makerHardCodeOpus",
  "makerHardCodeSonnet",
  "crossReviewOpenAI",
  "crossReviewAnthropic",
  "crossReviewAdvisory",
  "skim",
  "draft",
  "ocr",
  "judge",
];
const SELECTOR = /^[^/\s:]+\/[^\s:]+(?::[a-z]+)?$/;

// The public harness is exactly what package.json `files` ships under this folder, so a
// source checkout and an installed package copy the same set. Personal config, models and
// skills are not listed there.
const HARNESS_PREFIX = "Tools/OMP_Global_Config/agent/";

export const SERVICES = [
  // The app answers its own maintenance status without a session or a provider.
  { name: "web", env: "PORT", port: 30141, method: "GET", path: "/api/update-maintenance", expect: 200 },
  // usage-server has no health route; its CORS preflight answers without reading credentials.
  { name: "usage", env: "OMP_USAGE_PORT", port: 30142, method: "OPTIONS", path: "/usage", expect: 204 },
  { name: "btw", env: "OMP_BTW_PORT", port: 30143, method: "GET", path: "/health", expect: 200 },
  { name: "subagent", env: "OMP_SUBAGENT_PORT", port: 30144, method: "GET", path: "/health", expect: 200 },
];

const MAX_PORT_BASE = 65535 - (SERVICES.length - 1);

function parsePort(value, max) {
  if (typeof value !== "string" || !/^\d{1,5}$/.test(value.trim())) return null;
  const port = Number(value.trim());
  return port >= 1 && port <= max ? port : null;
}

/**
 * The ports of one CUELO set. `--port-base n` puts the four services on n..n+3; without it each
 * service keeps its own variable (the ones the app and sidecars read) or its default. Nothing is
 * probed or guessed.
 */
export function servicePorts(portBase = null, env = process.env) {
  return SERVICES.map((service, index) => ({
    ...service,
    port: portBase !== null ? portBase + index : parsePort(env[service.env], 65535) ?? service.port,
  }));
}

/** The variables that point the app, its sidecar proxy and every sidecar at the same port set. */
export function portEnv(services) {
  return Object.fromEntries(services.map((service) => [service.env, String(service.port)]));
}

class UsageError extends Error {}

export function parseArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith("--") ? args.shift() : "setup";
  if (!["setup", "start", "health", "harness-diff", "harness-update"].includes(command)) throw new UsageError(`unknown command: ${command}`);
  const options = { command, home: null, roles: {}, portBase: null, hostname: "127.0.0.1", json: false, dryRun: false };
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--json" && command.startsWith("harness-")) {
      options.json = true;
      continue;
    }
    if (flag === "--dry-run" && command === "harness-update") {
      options.dryRun = true;
      continue;
    }
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--home" && command !== "health") {
      options.home = path.resolve(value);
    } else if (flag === "--hostname" && command === "start") {
      options.hostname = value;
    } else if (flag === "--port-base" && (command === "start" || command === "health")) {
      options.portBase = parsePort(value, MAX_PORT_BASE);
      if (options.portBase === null) throw new UsageError(`--port-base takes a number from 1 to ${MAX_PORT_BASE}`);
    } else if (flag === "--model" && command === "setup") {
      options.roles.default = value;
    } else if (flag === "--role" && command === "setup") {
      const at = value.indexOf("=");
      const name = value.slice(0, at);
      if (at <= 0 || !HARNESS_ROLES.includes(name)) {
        throw new UsageError(`--role takes <name>=<provider/model>, name one of ${HARNESS_ROLES.join(", ")}`);
      }
      options.roles[name] = value.slice(at + 1);
    } else {
      throw new UsageError(`unknown option for ${command}: ${flag}`);
    }
  }
  for (const [name, selector] of Object.entries(options.roles)) {
    if (!SELECTOR.test(selector)) throw new UsageError(`${name}: "${selector}" is not <provider>/<model>[:effort]`);
  }
  return options;
}

/**
 * The omp profile a command targets. `--home` points the whole process tree at
 * another home, so the SDK, the sidecars and this installer read the same profile.
 */
export function resolveProfile(home, env = process.env) {
  if (home) {
    const agentDir = path.join(home, ".omp", "agent");
    return { agentDir, env: { ...env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir } };
  }
  return { agentDir: env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".omp", "agent"), env: { ...env } };
}

/** The harness entries (files or folders, relative to the agent folder) named by package.json `files`. */
export function harnessEntries(packageFiles) {
  return packageFiles.filter((entry) => typeof entry === "string" && entry.startsWith(HARNESS_PREFIX))
    .map((entry) => entry.slice(HARNESS_PREFIX.length));
}

/** Every distributed harness file as a forward-slash path relative to the agent folder, in walk order. */
export function listHarnessFiles(sourceDir, entries) {
  const files = [];
  const walk = (rel) => {
    const name = path.basename(rel);
    // Same exclusions as the `!…/**/tests` and `!…/**/*.test.*` entries of `files`; npm
    // never packs a nested node_modules either.
    if (name === "tests" || name === "node_modules" || /\.test\./.test(name)) return;
    const source = path.join(sourceDir, rel);
    if (fs.statSync(source).isDirectory()) {
      for (const child of fs.readdirSync(source)) walk(path.join(rel, child));
      return;
    }
    files.push(rel.split(path.sep).join("/"));
  };
  for (const entry of entries) walk(entry);
  return files;
}

/** Copies the public harness file by file; an existing profile file is always kept as it is. */
export function copyHarness(sourceDir, agentDir, entries) {
  const report = { created: [], kept: [] };
  for (const rel of listHarnessFiles(sourceDir, entries)) {
    const target = path.join(agentDir, ...rel.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.copyFileSync(path.join(sourceDir, ...rel.split("/")), target, fs.constants.COPYFILE_EXCL);
      report.created.push(rel);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      report.kept.push(rel);
    }
  }
  return report;
}

export const HARNESS_MANIFEST = ".cuelo-harness-installed.json";
const HARNESS_BACKUP_DIR = ".cuelo-harness-backup";
const SHA256 = /^[0-9a-f]{64}$/;

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function fileHash(file) {
  return hashBytes(fs.readFileSync(file));
}

/**
 * What setup / harness-update installed: relative path -> sha256 of the bytes it copied, or null for a
 * file that already existed and so is not ours to update. Absent file = nothing recorded; an unreadable
 * one throws, because treating it as empty and rewriting it would destroy what it said.
 */
export function readHarnessManifest(agentDir) {
  const file = path.join(agentDir, HARNESS_MANIFEST);
  if (!fs.existsSync(file)) return { cuelo: null, files: {} };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not readable (${error.message}). Delete it to treat every harness file as untracked.`);
  }
  const files = {};
  for (const [rel, hash] of Object.entries(parsed?.files ?? {})) files[rel] = typeof hash === "string" && SHA256.test(hash) ? hash : null;
  return { cuelo: typeof parsed?.cuelo === "string" ? parsed.cuelo : null, files };
}

export function writeHarnessManifest(agentDir, files, version) {
  fs.mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, HARNESS_MANIFEST);
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ version: 1, cuelo: version, files: sorted }, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/**
 * Records a setup run: files copied now get their hash, files that were already there stay as they were
 * recorded (or null). An existing record that cannot be read is left exactly as it is and nothing is
 * recorded (the returned `skipped` says why); setup prints that as a warning and carries on.
 */
export function recordHarnessInstall(agentDir, report, version) {
  let previous;
  try {
    previous = readHarnessManifest(agentDir).files;
  } catch (error) {
    return { skipped: error.message };
  }
  const files = {};
  for (const rel of report.kept) files[rel] = previous[rel] ?? null;
  for (const rel of report.created) files[rel] = fileHash(path.join(agentDir, ...rel.split("/")));
  writeHarnessManifest(agentDir, files, version);
  return { skipped: null };
}

/** False when a folder between the profile and the file is a link or not a folder; a path that does not exist yet is fine. */
function isProfilePathSafe(agentDir, rel) {
  let dir;
  try {
    dir = fs.realpathSync(agentDir);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  for (const part of rel.split("/").slice(0, -1)) {
    dir = path.join(dir, part);
    const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!stat) return true;
    if (!stat.isDirectory()) return false;
  }
  return true;
}

const HARNESS_STATES = ["identical", "missing", "update-available", "user-modified", "untracked"];

/**
 * Compares the profile with the distributed harness and the install record.
 *   missing           not in the profile: would be added
 *   identical         same bytes as the distribution
 *   update-available  still the bytes we installed, the distribution has changed
 *   user-modified     differs from the bytes we installed
 *   untracked         exists with no install record (or is not a plain file): never updated
 */
export function diffHarness(sourceDir, agentDir, entries) {
  const manifest = readHarnessManifest(agentDir);
  const files = listHarnessFiles(sourceDir, entries).sort().map((rel) => {
    const target = path.join(agentDir, ...rel.split("/"));
    const distHash = fileHash(path.join(sourceDir, ...rel.split("/")));
    const recorded = manifest.files[rel] ?? null;
    // The user's own arrangement (a linked folder or file, a folder in place of a file) is never written through:
    // a write could land outside the profile.
    if (!isProfilePathSafe(agentDir, rel)) return { path: rel, status: "untracked", distHash, profileHash: null, recorded };
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stat) return { path: rel, status: "missing", distHash, profileHash: null, recorded };
    if (!stat.isFile()) return { path: rel, status: "untracked", distHash, profileHash: null, recorded };
    const profileHash = fileHash(target);
    const status = profileHash === distHash ? "identical"
      : recorded === null ? "untracked"
      : profileHash === recorded ? "update-available" : "user-modified";
    return { path: rel, status, distHash, profileHash, recorded };
  });
  const counts = Object.fromEntries(HARNESS_STATES.map((state) => [state, files.filter((file) => file.status === state).length]));
  return { installedVersion: manifest.cuelo, manifest, files, counts };
}

/**
 * Brings the profile up to the distribution for the two safe states only: `update-available` files are
 * backed up and overwritten, `missing` files are added. Everything else, config.yml included, is not touched.
 * The plan comes from `diffHarness`, but a profile file can change between that read and the write, so each
 * write re-checks first: an overwrite happens only if the bytes read right now still hash to the recorded
 * installed hash (the backup is made from those same bytes), and an addition never replaces a file that
 * appeared meanwhile. A file that fails its re-check is reported as user-modified / untracked instead.
 */
export function updateHarness(sourceDir, agentDir, entries, version, { dryRun = false, now = new Date() } = {}) {
  const diff = diffHarness(sourceDir, agentDir, entries);
  const planned = (status) => diff.files.filter((file) => file.status === status);
  const skipped = {
    "user-modified": planned("user-modified").map((file) => file.path),
    untracked: planned("untracked").map((file) => file.path),
    "backup-unsafe": [],
  };
  const backupStamp = now.toISOString().replace(/[:.]/g, "-");
  let backupDir = null;
  const updated = [];
  const added = [];
  if (dryRun) {
    updated.push(...planned("update-available").map((file) => file.path));
    added.push(...planned("missing").map((file) => file.path));
  } else {
    for (const file of planned("update-available")) {
      const target = path.join(agentDir, ...file.path.split("/"));
      let current = null;
      if (isProfilePathSafe(agentDir, file.path) && fs.lstatSync(target, { throwIfNoEntry: false })?.isFile()) current = fs.readFileSync(target);
      if (current === null) skipped.untracked.push(file.path);
      else if (hashBytes(current) !== file.recorded) skipped["user-modified"].push(file.path);
      else if (!isProfilePathSafe(agentDir, `${HARNESS_BACKUP_DIR}/${backupStamp}/${file.path}`)) skipped["backup-unsafe"].push(file.path);
      else {
        backupDir ??= path.join(agentDir, HARNESS_BACKUP_DIR, backupStamp);
        const backup = path.join(backupDir, ...file.path.split("/"));
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.writeFileSync(backup, current, { flag: "wx" });
        fs.copyFileSync(path.join(sourceDir, ...file.path.split("/")), target);
        updated.push(file.path);
      }
    }
    for (const file of planned("missing")) {
      const target = path.join(agentDir, ...file.path.split("/"));
      if (!isProfilePathSafe(agentDir, file.path)) {
        skipped.untracked.push(file.path);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.copyFileSync(path.join(sourceDir, ...file.path.split("/")), target, fs.constants.COPYFILE_EXCL);
        added.push(file.path);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        skipped.untracked.push(file.path);
      }
    }
    // Records follow what is on disk now: written files and identical tracked files carry the distributed
    // hash, every other file keeps the record it had.
    const written = new Set([...updated, ...added]);
    const files = {};
    for (const file of diff.files) {
      const tracked = file.status === "identical" && file.recorded !== null;
      files[file.path] = written.has(file.path) || tracked ? file.distHash : file.recorded;
    }
    writeHarnessManifest(agentDir, files, version);
  }
  return { dryRun, updated, added, skipped, backupDir, identical: diff.counts.identical };
}

function packageInfo() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function harnessSource() {
  return {
    sourceDir: path.join(ROOT, "Tools", "OMP_Global_Config", "agent"),
    entries: harnessEntries(packageInfo().files ?? []),
  };
}

function printList(label, files) {
  if (files.length === 0) return;
  console.log(`${label} (${files.length}):`);
  for (const file of files) console.log(`  ${file}`);
}

function harnessDiff(options) {
  const { agentDir } = resolveProfile(options.home);
  const { sourceDir, entries } = harnessSource();
  const diff = diffHarness(sourceDir, agentDir, entries);
  if (options.json) {
    const files = diff.files.map(({ path: file, status }) => ({ path: file, status }));
    console.log(JSON.stringify({ agentDir, cuelo: packageInfo().version, installedVersion: diff.installedVersion, counts: diff.counts, files }, null, 2));
    return;
  }
  const by = (state) => diff.files.filter((file) => file.status === state).map((file) => file.path);
  console.log(`Harness in ${agentDir} against CUELO ${packageInfo().version} (installed by CUELO ${diff.installedVersion ?? "unknown"}):`);
  printList("update-available: unmodified, a newer version is distributed; `harness-update` replaces it", by("update-available"));
  printList("missing: not in the profile; `harness-update` adds it", by("missing"));
  printList("user-modified: differs from what was installed; never changed automatically", by("user-modified"));
  printList("untracked: exists with no install record; never changed automatically", by("untracked"));
  console.log(`${diff.counts.identical} files identical to the distribution.`);
}

function harnessUpdate(options) {
  const { agentDir } = resolveProfile(options.home);
  const { sourceDir, entries } = harnessSource();
  const result = updateHarness(sourceDir, agentDir, entries, packageInfo().version, { dryRun: options.dryRun });
  if (options.json) {
    console.log(JSON.stringify({ agentDir, ...result }, null, 2));
    return;
  }
  const prefix = result.dryRun ? "Would be " : "";
  printList(`${prefix}updated`, result.updated);
  printList(`${prefix}added`, result.added);
  printList("Left as it is, user-modified", result.skipped["user-modified"]);
  printList("Left as it is, untracked", result.skipped.untracked);
  printList("Left as it is, the backup folder inside the profile is a link or not a folder", result.skipped["backup-unsafe"]);
  if (result.updated.length + result.added.length === 0) console.log("Nothing to update.");
  if (result.backupDir) console.log(`Previous versions of the updated files were saved under ${result.backupDir}.`);
  if (result.dryRun) console.log("Dry run: no file was changed.");
}

/**
 * What a new profile's `config.yml` starts with, so the public harness runs the way it is used:
 * local learning and project-scoped memory, the harness's Maker routing (isolated task runs,
 * its roles instead of the bundled agents) and request budget, long `eval` cells that yield
 * to steering (`eval.autoBackground`, off in omp), and nothing that spends provider requests
 * on its own (`autoContinue`, `autoRetain` stay off). Values equal to the omp defaults are
 * left out.
 */
export const PROFILE_DEFAULTS = {
  defaultThinkingLevel: "auto",
  autolearn: { enabled: true, autoContinue: false },
  memory: { backend: "mnemopi" },
  mnemopi: { scoping: "per-project-tagged", embeddingVariant: "multilingual", autoRetain: false },
  task: {
    enableLsp: true,
    softRequestBudget: 400,
    maxConcurrency: 8,
    eager: "preferred",
    maxEffort: "xhigh",
    isolation: { enabled: true },
    structured: true,
    disabledAgents: ["scout", "sonic", "task", "reviewer", "security-reviewer"],
  },
  eval: { autoBackground: { enabled: true } },
};

/**
 * Creates `config.yml` for a profile that has none: the defaults above plus exactly the model
 * roles the user named. An existing file is never edited; the report lists the roles it lacks.
 */
export function createProfileConfig(agentDir, roles) {
  const YAML = require("yaml");
  const configPath = path.join(agentDir, "config.yml");
  if (fs.existsSync(configPath)) {
    const assigned = YAML.parse(fs.readFileSync(configPath, "utf8"))?.modelRoles ?? {};
    return {
      configPath,
      written: false,
      ignored: Object.keys(roles),
      missing: ["default", ...HARNESS_ROLES].filter((name) => typeof assigned[name] !== "string"),
    };
  }
  fs.mkdirSync(agentDir, { recursive: true });
  const config = Object.keys(roles).length > 0 ? { ...PROFILE_DEFAULTS, modelRoles: roles } : PROFILE_DEFAULTS;
  const body = [
    "# Written by CUELO install.mjs for a new profile. Edit freely; setup never rewrites this file.",
    YAML.stringify(config),
  ].join("\n");
  fs.writeFileSync(configPath, body, { flag: "wx" });
  return {
    configPath,
    written: true,
    ignored: [],
    missing: ["default", ...HARNESS_ROLES].filter((name) => roles[name] === undefined),
  };
}

function run(command, args, options) {
  console.log(`> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} ${args[0] ?? ""} failed: ${result.error?.message ?? `exit ${result.status}`}`);
  }
}

function bunPath() {
  const { resolveBunPath, getMissingBunMessage } = require("./bin/runtime.js");
  const bun = resolveBunPath();
  if (!bun) throw new Error(getMissingBunMessage());
  return bun;
}

/**
 * Removes the bun install cache older setups left inside the isolated build HOME. Only when every
 * folder on the way is a real directory: a `.bun` the user replaced with a link (or junction)
 * points at a shared cache that is not ours to delete.
 */
export function dropInTreeBunCache(buildHome) {
  const cache = path.join(buildHome, ".bun", "install", "cache");
  const steps = [buildHome, path.join(buildHome, ".bun"), path.dirname(cache), cache];
  if (steps.every((step) => fs.lstatSync(step, { throwIfNoEntry: false })?.isDirectory())) {
    fs.rmSync(cache, { recursive: true, force: true });
  }
}

/** A source checkout has the lockfile and the app sources; an installed npm package ships only the build. */
function isSourceCheckout() {
  return fs.existsSync(path.join(ROOT, "bun.lock")) && fs.existsSync(path.join(ROOT, "app", "layout.tsx"));
}

/** How the user runs this installer: `cuelo` from an npm install (no install.mjs in their folder), `node install.mjs` from a checkout. */
function cliCommand() {
  return isSourceCheckout() ? "node install.mjs" : "cuelo";
}

function prepareRuntime() {
  const node = process.versions.bun ? "node" : process.execPath;
  const sourceCheckout = isSourceCheckout();
  if (!sourceCheckout) {
    // An installed package ships its production build and patched SDK; only confirm them.
    run(node, [path.join(ROOT, "bin", "prepare-runtime.js"), "--check"], { cwd: ROOT });
    return;
  }
  // Same isolated home as ci.yml and the setup runner: the build otherwise walks the real
  // profile (protected folders fail with EPERM) and could read the user's omp settings.
  // `--home` names where the harness goes, never what the build sees.
  const buildHome = path.join(ROOT, ".runtime-patch-home");
  fs.mkdirSync(buildHome, { recursive: true });
  // Bun keeps its install cache under HOME, so with HOME inside ROOT it grew with every new
  // dependency version inside the tree (6.8GB on the office PC, 2026-10-20) and the build walked
  // it: compile 8.9 min, 101 s with it hidden. The cache is not omp state, so it stays the
  // user's own; the copy older setups left in the tree is dropped (bun refills from there).
  const bunCache = process.env.BUN_INSTALL_CACHE_DIR || path.join(os.homedir(), ".bun", "install", "cache");
  dropInTreeBunCache(buildHome);
  const buildRoot = path.parse(buildHome).root;
  const { PI_CODING_AGENT_DIR: _profile, ...inherited } = process.env;
  const buildEnv = {
    ...inherited,
    HOME: buildHome,
    USERPROFILE: buildHome,
    HOMEDRIVE: buildRoot.replace(/[\\/]+$/, ""),
    HOMEPATH: buildHome.slice(buildRoot.length - 1),
    BUN_INSTALL_CACHE_DIR: bunCache,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const bun = bunPath();
  run(bun, ["install", "--frozen-lockfile", "--backend=copyfile"], { cwd: ROOT, env: buildEnv });
  // The unpatched SDK cannot be imported by the build; apply its core patches first.
  run(node, [path.join(ROOT, "bin", "prepare-runtime.js"), "--source"], { cwd: ROOT, env: buildEnv });
  // The native runtime patch edits the production server chunks, so it runs after the build.
  run(bun, ["run", "build"], { cwd: ROOT, env: buildEnv });
  const env = {
    ...buildEnv,
    OMP_CORE_PATCH_TARGET: path.join(ROOT, "node_modules", "@oh-my-pi", "pi-coding-agent"),
  };
  const patches = [
    [path.join(ROOT, "Tools", "CUELO_Setup", "files", "native-runtime-patch.js"), ["--target", ROOT]],
    [path.join(ROOT, "Tools", "OMP_Global_Config", "patches", "apply-core-patch.mjs"), []],
    [path.join(ROOT, "Tools", "OMP_Global_Config", "patches", "apply-notices.mjs"), []],
  ];
  for (const [script, args] of patches) run(node, [script, ...args], { cwd: ROOT, env });
  for (const [script, args] of patches) run(node, [script, ...args, "--check"], { cwd: ROOT, env });
}

function setup(options) {
  prepareRuntime();
  const { agentDir } = resolveProfile(options.home);
  const pkg = packageInfo();
  const harness = copyHarness(path.join(ROOT, "Tools", "OMP_Global_Config", "agent"), agentDir, harnessEntries(pkg.files ?? []));
  const recorded = recordHarnessInstall(agentDir, harness, pkg.version);
  if (recorded.skipped) console.log(`Warning: the harness install record was left unchanged because it cannot be read (${recorded.skipped}). harness-diff and harness-update refuse to run until you fix or delete it.`);
  console.log(`Harness: ${harness.created.length} files added to ${agentDir}, ${harness.kept.length} existing files kept unchanged. Later: \`${cliCommand()} harness-diff\` shows how the profile differs from this version.`);
  const roles = createProfileConfig(agentDir, options.roles);
  if (roles.written) console.log(`Profile config: wrote ${roles.configPath}.`);
  if (roles.ignored.length > 0) console.log(`Profile config: ${roles.configPath} already exists and was not changed; ignored ${roles.ignored.join(", ")}.`);
  if (roles.missing.length > 0) {
    console.log(`Model roles not set: ${roles.missing.join(", ")}. Choose only the roles you use in CUELO Settings > Models > Model roles; built-in roles may use core defaults.`);
  }
  console.log(`Next: run \`${cliCommand()} start\`, open the address it prints, and sign in to your providers under Settings > Models.`);
}

async function portAnswers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where the self-update worker keeps its plan, status and log. `--home` moves it with the profile,
 * because the server under that HOME resolves `os.homedir()` to it. The app reads the same path
 * from `CUELO_SELF_UPDATE_DIR`, which the supervisor hands down (lib/self-update.ts).
 */
function selfUpdateDir(home = null) {
  // Absolute: the value is handed to children whose cwd is this tree, so a relative `--home` must not
  // resolve to a different directory on the other side.
  return path.resolve(home ?? os.homedir(), ".cuelo", "self-update");
}

/**
 * Records how this supervisor was started so a self-update can stop it and start it again with the
 * same options. Plain JSON, read by bin/self-update.js; a write failure must not stop the server.
 */
function recordSupervisor(options) {
  const dir = selfUpdateDir(options.home);
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    command: process.execPath,
    args: [path.join(ROOT, "install.mjs"), ...process.argv.slice(2)],
    // The directory `start` was launched from, which is where `--home` and relative paths resolved.
    cwd: process.cwd(),
    recordedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "supervisor.json"), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    console.error(`Warning: could not record this start for self-update (${error.message}); an in-app update will only report that CUELO must be restarted by hand.`);
  }
  return dir;
}

async function start(options) {
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    throw new Error(isSourceCheckout() ? "No production build found. Run `node install.mjs setup` first." : "This package has no production build (.next/BUILD_ID). Reinstall it with `npm install -g cuelo`.");
  }
  const { env } = resolveProfile(options.home);
  const services = servicePorts(options.portBase, env);
  const busy = [];
  for (const service of services) if (await portAnswers(service.port)) busy.push(`${service.name}:${service.port}`);
  if (busy.length > 0) throw new Error(`Already in use: ${busy.join(", ")}. Stop the running CUELO first or pick another --port-base.`);
  const updateDir = recordSupervisor(options);

  const bun = bunPath();
  const node = process.versions.bun ? "node" : process.execPath;
  const files = path.join(ROOT, "Tools", "CUELO_Setup", "files");
  // The web server starts the self-update worker and reads its status from this directory; it must
  // be the same one this supervisor recorded, `--home` included.
  const childEnv = {
    ...env,
    ...portEnv(services),
    CUELO_DIR: ROOT,
    CUELO_SELF_UPDATE_DIR: updateDir,
    CUELO_SUPERVISOR_PID: String(process.pid),
    // Carried so the worker's `install.mjs setup` writes to the same profile this start resolved.
    ...(options.home ? { CUELO_PROFILE_HOME: options.home } : {}),
  };
  const commands = [
    // Only an explicit start flag widens the listener; inherited host settings do not.
    ["web", bun, [path.join(ROOT, "bin", "cuelo.js"), "--no-open", "--hostname", options.hostname]],
    ["usage", bun, [path.join(files, "usage-server.js")]],
    ["btw", bun, [path.join(files, "btw-server.js")]],
    ["subagent", node, [path.join(files, "subagent-server.js")]],
  ];
  const children = commands.map(([name, command, args]) => {
    const child = spawn(command, args, { cwd: ROOT, env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const lines = (pending + chunk).split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) console.log(`[${name}] ${line}`);
      });
    }
    return { name, child };
  });
  const web = services.find((service) => service.name === "web");
  console.log(`CUELO is starting at http://${options.hostname}:${web.port} . Press Ctrl+C to stop all four services.`);

  let stopping = false;
  const stopAll = () => {
    stopping = true;
    for (const { child } of children) if (child.exitCode === null) child.kill();
  };
  process.on("SIGINT", stopAll);
  process.on("SIGTERM", stopAll);
  const exits = await Promise.all(children.map(({ name, child }) => new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      if (!stopping) {
        console.error(`[${name}] exited (${signal ?? `code ${code}`}); stopping the other services.`);
        stopAll();
        resolve(1);
        return;
      }
      resolve(0);
    });
    child.on("error", (error) => {
      console.error(`[${name}] could not start: ${error.message}`);
      stopAll();
      resolve(1);
    });
  })));
  return exits.some((code) => code !== 0) ? 1 : 0;
}

/** One request per local service; never reaches a model provider. */
export async function checkHealth(services = servicePorts(), timeoutMs = 3000) {
  return Promise.all(services.map(async (service) => {
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
        method: service.method,
        signal: AbortSignal.timeout(timeoutMs),
        headers: service.name === "web" && process.env.CUELO_PASSWORD
          ? { Authorization: `Basic ${Buffer.from(`omp:${process.env.CUELO_PASSWORD}`).toString("base64")}` }
          : undefined,
      });
      return { ...service, ok: response.status === service.expect, status: response.status };
    } catch (error) {
      return { ...service, ok: false, status: null, error: error.message };
    }
  }));
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(error.message);
    console.error(`Usage: ${cliCommand()} [setup|start|health|harness-diff|harness-update] [--home <dir>] [--model <provider/model>] [--role <name>=<provider/model[:effort]>] [--port-base <n>] [--hostname <address>] [--json] [--dry-run]`);
    return 2;
  }
  try {
    if (options.command === "setup") {
      setup(options);
      return 0;
    }
    if (options.command === "harness-diff") {
      harnessDiff(options);
      return 0;
    }
    if (options.command === "harness-update") {
      harnessUpdate(options);
      return 0;
    }
    if (options.command === "start") return await start(options);
    const results = await checkHealth(servicePorts(options.portBase));
    for (const result of results) {
      console.log(`${result.ok ? "OK  " : "FAIL"} ${result.name} 127.0.0.1:${result.port} ${result.method} ${result.path} -> ${result.status ?? result.error}`);
    }
    return results.every((result) => result.ok) ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
