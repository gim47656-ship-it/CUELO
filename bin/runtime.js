"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { existsSync } = require("fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { delimiter, join } = require("path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { homedir } = require("os");

const MIN_NODE_VERSION = "22.19.0";
const MIN_BUN_VERSION = "1.4.2";

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ""));
  if (!match) return null;
  return match.slice(1).map(Number);
}

function isAtLeast(version, minimum) {
  const current = parseVersion(version);
  const floor = parseVersion(minimum);
  if (!current || !floor) return false;

  for (let index = 0; index < floor.length; index += 1) {
    if (current[index] > floor[index]) return true;
    if (current[index] < floor[index]) return false;
  }
  return true;
}

function isNodeVersionSupported(version) {
  return isAtLeast(version, MIN_NODE_VERSION);
}

function getUnsupportedNodeVersionMessage(version) {
  return [
    `CUELO requires Node.js ${MIN_NODE_VERSION} or newer.`,
    `Current Node.js version: ${version}.`,
    "Upgrade Node.js and try again: https://nodejs.org/",
  ].join("\n");
}

function getUnsupportedBunVersionMessage(version) {
  return [
    `CUELO requires Bun ${MIN_BUN_VERSION} or newer.`,
    `Current Bun version: ${version}.`,
    "Upgrade Bun and try again: https://bun.sh/",
  ].join("\n");
}

function isBunVersionSupported(version) {
  return isAtLeast(version, MIN_BUN_VERSION);
}

function bunExecutableName() {
  return process.platform === "win32" ? "bun.exe" : "bun";
}

/**
 * Locate a Bun executable.
 *
 * omp's SDK (`@oh-my-pi/pi-*`) ships TypeScript sources and imports `bun:`
 * builtins, so the server half of CUELO can only run on the Bun runtime.
 * Order: the current process (when CUELO itself was launched by Bun), an
 * explicit `CUELO_BUN` override, `$BUN_INSTALL/bin`, `~/.bun/bin`, `$PATH`.
 */
function resolveBunPath(env = process.env) {
  // An explicit override wins even when Bun is already running us, so an
  // operator can pin a specific build without changing PATH.
  const candidates = [];
  if (env.CUELO_BUN) candidates.push(env.CUELO_BUN);
  if (!env.CUELO_BUN && process.versions.bun && process.execPath) return process.execPath;

  if (env.BUN_INSTALL) candidates.push(join(env.BUN_INSTALL, "bin", bunExecutableName()));
  candidates.push(join(homedir(), ".bun", "bin", bunExecutableName()));
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, bunExecutableName()));
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // Unreadable PATH entry — keep looking.
    }
  }
  return null;
}

function getMissingBunMessage() {
  return [
    "CUELO could not find a Bun runtime.",
    "",
    "The omp SDK (@oh-my-pi/pi-*) is distributed as TypeScript sources and uses",
    "Bun-only builtins, so CUELO serves its API routes on Bun — exactly like",
    "the omp CLI itself.",
    "",
    "Install Bun and try again:",
    "  curl -fsSL https://bun.sh/install | bash        # macOS / Linux",
    '  powershell -c "irm bun.sh/install.ps1 | iex"    # Windows',
    "",
    "Already installed somewhere unusual? Point CUELO at it:",
    "  CUELO_BUN=/path/to/bun CUELO",
  ].join("\n");
}

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/**
 * Bun's fetch reads HTTP_PROXY/HTTPS_PROXY/NO_PROXY once at process start and, since
 * 1.4, proxies loopback too unless NO_PROXY lists it. Local providers (ollama,
 * lm-studio, llama.cpp) must stay direct, so the server env always exempts loopback
 * while keeping every entry the user already set.
 */
function withLoopbackNoProxy(env) {
  const current = env.NO_PROXY ?? env.no_proxy ?? "";
  const entries = current.split(",").map((entry) => entry.trim()).filter(Boolean);
  const known = new Set(entries.map((entry) => entry.toLowerCase()));
  if (known.has("*")) return env;
  const merged = [...entries, ...LOOPBACK_HOSTS.filter((host) => !known.has(host))].join(",");
  return { ...env, NO_PROXY: merged, no_proxy: merged };
}

module.exports = {
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  getMissingBunMessage,
  getUnsupportedBunVersionMessage,
  getUnsupportedNodeVersionMessage,
  isBunVersionSupported,
  isNodeVersionSupported,
  resolveBunPath,
  withLoopbackNoProxy,
};
