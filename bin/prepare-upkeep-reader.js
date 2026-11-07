#!/usr/bin/env node
"use strict";

// Prepares the upkeep reader native module (native/upkeep-reader) that lib/upkeep/upkeep-reader.ts
// loads from bin/native/upkeep-reader/<platform>-<arch>.node. Next to each binary,
// <platform>-<arch>.json records the crate source it was built from and the binary's SHA-256;
// an artifact is used only when both still match.
//   --check   validate the host artifact and load it (npm installs, readiness checks)
//   --ensure  source checkouts: reuse a valid artifact, else take the matching asset of this
//             version's public GitHub release, else build with a local cargo
//   --build   build with a local cargo (CI and release builds); --glibc VERSION (Linux) links with
//             cargo-zigbuild against that glibc, so the published binary loads on older systems
// --root (default: this package) and --out (default: <root>/bin/native/upkeep-reader) point at
// another tree; --target checks a non-host artifact without loading it.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require("node:crypto");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");

const RELEASE_DOWNLOAD_URL = "https://github.com/gim47656-ship-it/CUELO/releases/download";
// The six targets of the omp SDK's own native packages (@oh-my-pi/pi-natives optionalDependencies).
const RUST_TARGETS = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};
const LIBRARY = { linux: "libcuelo_upkeep_reader.so", darwin: "libcuelo_upkeep_reader.dylib", win32: "cuelo_upkeep_reader.dll" };
const SHA256 = /^[0-9a-f]{64}$/;

const hostTarget = () => `${process.platform}-${process.arch}`;
const crateDir = (root) => path.join(root, "native", "upkeep-reader");
const defaultOut = (root) => path.join(root, "bin", "native", "upkeep-reader");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

class PrepareError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// Everything cargo compiles for this crate: the manifest, the lockfile, the build script and src/.
// Paths use "/" so every platform hashes the same tree the same way (.gitattributes keeps it LF).
function sourceSha256(root) {
  const dir = crateDir(root);
  const files = ["Cargo.toml", "Cargo.lock", "build.rs"];
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
      else throw new PrepareError(`Unexpected non-file crate input: ${path.join(dir, child)}`);
    }
  };
  walk("src");
  files.sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const bytes = fs.readFileSync(path.join(dir, rel));
    hash.update(`${rel}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

function parseMetadata(text, target) {
  let meta;
  try {
    meta = JSON.parse(text);
  } catch {
    return null;
  }
  const keys = meta && typeof meta === "object" ? Object.keys(meta).sort().join(",") : "";
  if (keys !== "binarySha256,sourceSha256,target" || meta.target !== target ||
      typeof meta.sourceSha256 !== "string" || !SHA256.test(meta.sourceSha256) ||
      typeof meta.binarySha256 !== "string" || !SHA256.test(meta.binarySha256)) return null;
  return meta;
}

// { state: "valid" | "missing" | "stale" | "corrupt", reason }
function inspect({ root, outDir = defaultOut(root), target = hostTarget(), source = sourceSha256(root) }) {
  const metaFile = path.join(outDir, `${target}.json`);
  const binary = path.join(outDir, `${target}.node`);
  if (!fs.existsSync(metaFile)) return { state: "missing", reason: `${metaFile} is missing` };
  const meta = parseMetadata(fs.readFileSync(metaFile, "utf8"), target);
  if (!meta) return { state: "corrupt", reason: `${metaFile} is not valid ${target} metadata` };
  // Damaged bytes are reported as such even when the crate source has also moved on.
  if (!fs.existsSync(binary)) return { state: "corrupt", reason: `${binary} is missing` };
  if (sha256(fs.readFileSync(binary)) !== meta.binarySha256) return { state: "corrupt", reason: `${binary} does not match its SHA-256 in ${metaFile}` };
  if (meta.sourceSha256 !== source) return { state: "stale", reason: `${binary} was built from other crate source` };
  return { state: "valid", reason: `${binary} matches the crate source` };
}

function load(outDir) {
  const binary = path.join(outDir, `${hostTarget()}.node`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const native = require(binary);
  if (typeof native.UpkeepReader !== "function") throw new PrepareError(`${binary} does not export UpkeepReader`);
}

// The metadata goes last and is removed first, so an interrupted write reads as "missing".
function writeArtifact(outDir, target, bytes, source) {
  fs.mkdirSync(outDir, { recursive: true });
  const metaFile = path.join(outDir, `${target}.json`);
  const binary = path.join(outDir, `${target}.node`);
  const temp = `.tmp-${process.pid}`;
  fs.rmSync(metaFile, { force: true });
  try {
    fs.writeFileSync(binary + temp, bytes);
    fs.renameSync(binary + temp, binary);
    fs.writeFileSync(metaFile + temp, `${JSON.stringify({ target, sourceSha256: source, binarySha256: sha256(bytes) }, null, 2)}\n`);
    fs.renameSync(metaFile + temp, metaFile);
  } finally {
    fs.rmSync(binary + temp, { force: true });
    fs.rmSync(metaFile + temp, { force: true });
  }
}

// install.mjs and prepare-runtime.js point HOME at an isolated build home. rustup and cargo keep
// their default homes under the account's own home, so name those unless they are already set.
function cargoEnv(env) {
  const home = os.userInfo().homedir;
  return {
    ...env,
    CARGO_HOME: env.CARGO_HOME || path.join(home, ".cargo"),
    RUSTUP_HOME: env.RUSTUP_HOME || path.join(home, ".rustup"),
  };
}

function cargoAvailable(cargo, env = process.env) {
  const result = spawnSync(cargo, ["--version"], { encoding: "utf8", env: cargoEnv(env) });
  return !result.error && result.status === 0;
}

function build({ root, outDir = defaultOut(root), cargo = "cargo", env = process.env, glibc }) {
  const target = hostTarget();
  const triple = RUST_TARGETS[target];
  if (!triple) throw new PrepareError(`No upkeep reader build target for ${target}`);
  const dir = crateDir(root);
  const source = sourceSha256(root);
  const buildEnv = cargoEnv(env);
  const targetDir = buildEnv.CARGO_TARGET_DIR ? path.resolve(buildEnv.CARGO_TARGET_DIR) : path.join(dir, "target");
  // Keep the build machine's paths out of panic messages in the binary.
  const flags = buildEnv.CARGO_ENCODED_RUSTFLAGS
    ? buildEnv.CARGO_ENCODED_RUSTFLAGS.split("\x1f")
    : (buildEnv.RUSTFLAGS ?? "").split(/\s+/).filter(Boolean);
  flags.push(
    `--remap-path-prefix=${dir}=upkeep-reader`,
    `--remap-path-prefix=${path.resolve(buildEnv.CARGO_HOME)}=cargo`,
    `--remap-path-prefix=${targetDir}=target`,
  );
  // A plain Linux build links against the build machine's glibc (2.34+ on current hosts) and then
  // refuses to load on older ones. The SDK's own binaries use zig with a glibc 2.17 floor.
  const cargoArgs = glibc ? ["zigbuild", "--target", `${triple}.${glibc}`] : ["build", "--target", triple];
  const result = spawnSync(cargo, [...cargoArgs, "--release", "--locked", "--target-dir", targetDir], {
    cwd: dir,
    env: { ...buildEnv, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
    stdio: "inherit",
  });
  if (result.error) throw new PrepareError(`cargo could not run: ${result.error.message}`);
  if (result.status !== 0) throw new PrepareError(`cargo build failed (exit ${result.status ?? result.signal})`, result.status || 1);
  if (sourceSha256(root) !== source) throw new PrepareError(`${dir} changed during the build`);
  writeArtifact(outDir, target, fs.readFileSync(path.join(targetDir, triple, "release", LIBRARY[process.platform])), source);
}

async function download(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new PrepareError(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Returns "reused" | "downloaded" | "built".
async function ensure({ root, outDir = defaultOut(root), cargo = "cargo", baseUrl = RELEASE_DOWNLOAD_URL, fetchImpl = fetch, log = console.log }) {
  const target = hostTarget();
  const source = sourceSha256(root);
  const local = inspect({ root, outDir, target, source });
  if (local.state === "valid") {
    load(outDir);
    return "reused";
  }
  if (local.state === "corrupt") throw new PrepareError(`${local.reason}. Remove ${outDir} and prepare again.`);

  const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const assetUrl = `${baseUrl}/v${version}/upkeep-reader-${target}`;
  const metaBytes = await download(`${assetUrl}.json`, fetchImpl);
  let reason;
  if (!metaBytes) {
    reason = `CUELO v${version} has no published upkeep reader for ${target}`;
  } else {
    const meta = parseMetadata(metaBytes.toString("utf8"), target);
    if (!meta) throw new PrepareError(`${assetUrl}.json is not valid ${target} metadata`);
    if (meta.sourceSha256 === source) {
      const bytes = await download(`${assetUrl}.node`, fetchImpl);
      if (!bytes) throw new PrepareError(`${assetUrl}.node is missing although its metadata is published`);
      if (sha256(bytes) !== meta.binarySha256) throw new PrepareError(`${assetUrl}.node does not match its published SHA-256`);
      if (sourceSha256(root) !== source) throw new PrepareError(`${crateDir(root)} changed while the release asset was downloading`);
      writeArtifact(outDir, target, bytes, source);
      load(outDir);
      return "downloaded";
    }
    reason = `the current crate source differs from the source of the CUELO v${version} release asset`;
  }
  if (!cargoAvailable(cargo)) {
    throw new PrepareError(`${reason}, and no cargo is available to build ${crateDir(root)}. ` +
      "Install a Rust toolchain or use a released CUELO version.");
  }
  log(`${reason}; building the upkeep reader with the local cargo.`);
  build({ root, outDir, cargo });
  load(outDir);
  return "built";
}

function check({ root, outDir = defaultOut(root), target = hostTarget() }) {
  const result = inspect({ root, outDir, target });
  if (result.state !== "valid") throw new PrepareError(`Upkeep reader ${result.state}: ${result.reason}`);
  if (target === hostTarget()) load(outDir);
}

module.exports = { RUST_TARGETS, sourceSha256, inspect, build, ensure, check };

if (require.main === module) {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const options = {};
  while (args.length >= 2 && ["--root", "--out", "--target", "--glibc"].includes(args[0])) {
    const [flag, value] = args.splice(0, 2);
    options[flag.slice(2)] = flag === "--root" || flag === "--out" ? path.resolve(value) : value;
  }
  if (!["--check", "--ensure", "--build"].includes(mode) || args.length ||
      // An empty value (an unset shell variable) is an error, not "flag omitted".
      (options.target !== undefined && (mode !== "--check" || !Object.hasOwn(RUST_TARGETS, options.target))) ||
      (options.glibc !== undefined && (mode !== "--build" || process.platform !== "linux" || !/^2\.\d+$/.test(options.glibc)))) {
    console.error("Usage: node bin/prepare-upkeep-reader.js --check|--ensure|--build [--root DIR] [--out DIR] [--target PLATFORM-ARCH (--check only)] [--glibc 2.N (--build on Linux only)]");
    process.exit(1);
  }
  const root = options.root ?? path.resolve(__dirname, "..");
  const outDir = options.out ?? defaultOut(root);
  (async () => {
    if (mode === "--check") {
      check({ root, outDir, target: options.target });
    } else if (mode === "--build") {
      build({ root, outDir, glibc: options.glibc });
      load(outDir);
      console.log(`Upkeep reader built: ${path.join(outDir, `${hostTarget()}.node`)}`);
    } else {
      const how = await ensure({ root, outDir });
      console.log(`Upkeep reader ${how}: ${path.join(outDir, `${hostTarget()}.node`)}`);
    }
  })().catch((error) => {
    console.error(`CUELO upkeep reader: ${error.message}`);
    process.exit(error.exitCode ?? 1);
  });
}
