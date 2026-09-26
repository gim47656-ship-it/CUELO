#!/usr/bin/env node
// CUELO public installer. Run it explicitly; no npm lifecycle script calls it.
//
//   node install.mjs [setup] [--home <dir>] [--model <provider/model>] [--role <name>=<provider/model[:effort]>]...
//   node install.mjs start [--home <dir>] [--port-base <n>]
//   node install.mjs health [--port-base <n>]
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

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(ROOT, "package.json"));

/** The model slots the public harness routes Makers to; `--model` sets omp's core `default` separately. */
export const HARNESS_ROLES = [
  "implSol",
  "implOpus",
  "implDeepSeek",
  "makerHardUiOpus",
  "makerHardCodeOpus",
  "makerHardCodeAstra",
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
  if (!["setup", "start", "health"].includes(command)) throw new UsageError(`unknown command: ${command}`);
  const options = { command, home: null, roles: {}, portBase: null };
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (flag === "--home" && command !== "health") {
      options.home = path.resolve(value);
    } else if (flag === "--port-base" && command !== "setup") {
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

/** Copies the public harness file by file; an existing profile file is always kept as it is. */
export function copyHarness(sourceDir, agentDir, entries) {
  const report = { created: [], kept: [] };
  const copy = (rel) => {
    const name = path.basename(rel);
    // Same exclusions as the `!…/**/tests` and `!…/**/*.test.*` entries of `files`; npm
    // never packs a nested node_modules either.
    if (name === "tests" || name === "node_modules" || /\.test\./.test(name)) return;
    const source = path.join(sourceDir, rel);
    if (fs.statSync(source).isDirectory()) {
      for (const child of fs.readdirSync(source)) copy(path.join(rel, child));
      return;
    }
    const target = path.join(agentDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      report.created.push(rel);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      report.kept.push(rel);
    }
  };
  for (const entry of entries) copy(entry);
  return report;
}

/**
 * What a new profile's `config.yml` starts with, so the public harness runs the way it is used:
 * local learning and project-scoped memory, the harness's Maker routing (isolated task runs,
 * its roles instead of the bundled agents) and request budget, and nothing that spends
 * provider requests on its own (`autoContinue`, `autoRetain` stay off). Values equal to the
 * omp defaults are left out.
 */
export const PROFILE_DEFAULTS = {
  defaultThinkingLevel: "auto",
  autolearn: { enabled: true, autoContinue: false },
  memory: { backend: "mnemopi" },
  mnemopi: { scoping: "per-project-tagged", embeddingVariant: "multilingual", autoRetain: false },
  task: {
    softRequestBudget: 400,
    maxConcurrency: 8,
    eager: "preferred",
    maxEffort: "xhigh",
    isolation: { enabled: true },
    disabledAgents: ["scout", "sonic", "task", "reviewer", "security-reviewer"],
  },
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

function prepareRuntime() {
  const node = process.versions.bun ? "node" : process.execPath;
  const sourceCheckout = fs.existsSync(path.join(ROOT, "bun.lock")) && fs.existsSync(path.join(ROOT, "app", "layout.tsx"));
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
  const buildRoot = path.parse(buildHome).root;
  const { PI_CODING_AGENT_DIR: _profile, ...inherited } = process.env;
  const buildEnv = {
    ...inherited,
    HOME: buildHome,
    USERPROFILE: buildHome,
    HOMEDRIVE: buildRoot.replace(/[\\/]+$/, ""),
    HOMEPATH: buildHome.slice(buildRoot.length - 1),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const bun = bunPath();
  run(bun, ["install", "--frozen-lockfile"], { cwd: ROOT, env: buildEnv });
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
  const packageFiles = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).files ?? [];
  const harness = copyHarness(path.join(ROOT, "Tools", "OMP_Global_Config", "agent"), agentDir, harnessEntries(packageFiles));
  console.log(`Harness: ${harness.created.length} files added to ${agentDir}, ${harness.kept.length} existing files kept unchanged.`);
  const roles = createProfileConfig(agentDir, options.roles);
  if (roles.written) console.log(`Profile config: wrote ${roles.configPath}.`);
  if (roles.ignored.length > 0) console.log(`Profile config: ${roles.configPath} already exists and was not changed; ignored ${roles.ignored.join(", ")}.`);
  if (roles.missing.length > 0) {
    console.log(`Model roles not set: ${roles.missing.join(", ")}. Choose your own models in CUELO Settings > Model roles.`);
  }
  console.log("Next: run `node install.mjs start`, open the address it prints, and sign in to your providers under Settings > Models.");
}

async function portAnswers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD", signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

async function start(options) {
  if (!fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) throw new Error("No production build found. Run `node install.mjs setup` first.");
  const { env } = resolveProfile(options.home);
  const services = servicePorts(options.portBase, env);
  const busy = [];
  for (const service of services) if (await portAnswers(service.port)) busy.push(`${service.name}:${service.port}`);
  if (busy.length > 0) throw new Error(`Already in use: ${busy.join(", ")}. Stop the running CUELO first or pick another --port-base.`);

  const bun = bunPath();
  const node = process.versions.bun ? "node" : process.execPath;
  const files = path.join(ROOT, "Tools", "CUELO_Setup", "files");
  const childEnv = { ...env, ...portEnv(services), CUELO_DIR: ROOT };
  const commands = [
    // The app-only launcher; `--no-open` leaves the browser to the user, and the explicit loopback
    // host wins over an inherited CUELO_HOSTNAME so this never listens beyond the machine.
    ["web", bun, [path.join(ROOT, "bin", "cuelo.js"), "--no-open", "--hostname", "127.0.0.1"]],
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
  console.log(`CUELO is starting at http://127.0.0.1:${web.port} . Press Ctrl+C to stop all four services.`);

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

/** One request per service; nothing here authenticates or reaches a model provider. */
export async function checkHealth(services = servicePorts(), timeoutMs = 3000) {
  return Promise.all(services.map(async (service) => {
    try {
      const response = await fetch(`http://127.0.0.1:${service.port}${service.path}`, {
        method: service.method,
        signal: AbortSignal.timeout(timeoutMs),
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
    console.error("Usage: node install.mjs [setup|start|health] [--home <dir>] [--model <provider/model>] [--role <name>=<provider/model[:effort]>] [--port-base <n>]");
    return 2;
  }
  try {
    if (options.command === "setup") {
      setup(options);
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
