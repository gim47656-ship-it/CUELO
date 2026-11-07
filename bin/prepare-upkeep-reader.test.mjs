import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reader = require("./prepare-upkeep-reader.js");
const host = `${process.platform}-${process.arch}`;
const CRATE_INPUTS = ["Cargo.toml", "Cargo.lock", "build.rs", "src"];
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cuelo-upkeep-reader-${name}-`));
}

// A tree with this repository's crate inputs and a package.json, as a source checkout has them.
function sourceTree(name) {
  const root = tempDir(name);
  for (const input of CRATE_INPUTS) {
    fs.cpSync(path.join(repo, "native", "upkeep-reader", input), path.join(root, "native", "upkeep-reader", input), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cuelo", version: "9.9.9" }));
  return root;
}

function writeArtifact(outDir, target, bytes, sourceSha256, binarySha256 = sha256(bytes)) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${target}.node`), bytes);
  fs.writeFileSync(path.join(outDir, `${target}.json`), JSON.stringify({ target, sourceSha256, binarySha256 }));
}

// Serves a fixed map of release asset paths; anything else is a 404, like a GitHub release download.
async function releaseServer(assets) {
  const server = http.createServer((request, response) => {
    const asset = assets[request.url];
    response.writeHead(asset === undefined ? 404 : 200);
    response.end(typeof asset === "function" ? asset() : asset);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

const unusedFetch = async (url) => {
  throw new Error(`unexpected download of ${url}`);
};

test("source hash covers every crate input and nothing outside them", () => {
  const a = sourceTree("hash-a");
  const b = sourceTree("hash-b");
  const crate = path.join(b, "native", "upkeep-reader");
  const base = reader.sourceSha256(a);
  assert.equal(reader.sourceSha256(b), base);

  fs.mkdirSync(path.join(crate, "target", "release"), { recursive: true });
  fs.writeFileSync(path.join(crate, "target", "release", "out.so"), "build output");
  fs.writeFileSync(path.join(crate, "README.md"), "notes");
  assert.equal(reader.sourceSha256(b), base);

  for (const [file, change] of [["src/lib.rs", "\n"], ["Cargo.lock", "\n"], ["Cargo.toml", "\n"], ["build.rs", "\n"], ["src/extra.rs", ""]]) {
    const target = path.join(crate, file);
    const original = fs.existsSync(target) ? fs.readFileSync(target) : null;
    fs.writeFileSync(target, Buffer.concat([original ?? Buffer.alloc(0), Buffer.from(change)]));
    assert.notEqual(reader.sourceSha256(b), base, `${file} must change the source hash`);
    if (original) fs.writeFileSync(target, original);
    else fs.rmSync(target);
  }
  // A CRLF copy is different source: .gitattributes keeps these files LF in every checkout.
  const lib = path.join(crate, "src", "lib.rs");
  fs.writeFileSync(lib, fs.readFileSync(lib, "utf8").replace(/\n/g, "\r\n"));
  assert.notEqual(reader.sourceSha256(b), base);
});

test("an artifact is valid only while its source and bytes match its metadata", () => {
  const root = sourceTree("inspect");
  const outDir = path.join(root, "out");
  const source = reader.sourceSha256(root);
  writeArtifact(outDir, "linux-arm64", Buffer.from("binary"), source);
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "valid");

  fs.appendFileSync(path.join(root, "native", "upkeep-reader", "src", "lib.rs"), "\n");
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "stale");
  writeArtifact(outDir, "linux-arm64", Buffer.from("binary"), reader.sourceSha256(root));
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "valid");

  fs.writeFileSync(path.join(outDir, "linux-arm64.node"), "binarY");
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "corrupt");
  writeArtifact(outDir, "linux-arm64", Buffer.from("binary"), reader.sourceSha256(root));
  fs.writeFileSync(path.join(outDir, "linux-arm64.json"), JSON.stringify({ target: "linux-x64", sourceSha256: reader.sourceSha256(root), binarySha256: sha256("binary") }));
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "corrupt");
  fs.writeFileSync(path.join(outDir, "linux-arm64.json"), "{");
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "corrupt");
  fs.rmSync(path.join(outDir, "linux-arm64.json"));
  assert.equal(reader.inspect({ root, outDir, target: "linux-arm64" }).state, "missing");
});

test("a corrupt local artifact fails closed instead of being replaced", async () => {
  const root = sourceTree("local-corrupt");
  const outDir = path.join(root, "out");
  // Also when the crate source has moved on since that artifact was built.
  for (const source of [reader.sourceSha256(root), "0".repeat(64)]) {
    writeArtifact(outDir, host, Buffer.from("binary"), source, sha256("other"));
    await assert.rejects(
      reader.ensure({ root, outDir, cargo: process.execPath, fetchImpl: unusedFetch, log: () => {} }),
      /does not match its SHA-256.*Remove/,
    );
    assert.equal(fs.readFileSync(path.join(outDir, `${host}.node`), "utf8"), "binary");
  }
});

test("a downloaded binary that differs from its published digest is refused", async () => {
  const root = sourceTree("download-corrupt");
  const outDir = path.join(root, "out");
  const asset = `/v9.9.9/upkeep-reader-${host}`;
  const server = await releaseServer({
    [`${asset}.json`]: JSON.stringify({ target: host, sourceSha256: reader.sourceSha256(root), binarySha256: sha256("published") }),
    [`${asset}.node`]: "tampered",
  });
  try {
    // A cargo that exists: the refusal must not turn into a local build.
    await assert.rejects(
      reader.ensure({ root, outDir, cargo: process.execPath, baseUrl: server.url, log: () => {} }),
      /does not match its published SHA-256/,
    );
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(path.join(outDir, `${host}.node`)), false);
  assert.equal(fs.existsSync(path.join(outDir, `${host}.json`)), false);
});

test("a download is refused when the crate source changes while it runs", async () => {
  const root = sourceTree("download-moved");
  const outDir = path.join(root, "out");
  const asset = `/v9.9.9/upkeep-reader-${host}`;
  const server = await releaseServer({
    [`${asset}.json`]: JSON.stringify({ target: host, sourceSha256: reader.sourceSha256(root), binarySha256: sha256("published") }),
    [`${asset}.node`]: () => {
      fs.appendFileSync(path.join(root, "native", "upkeep-reader", "src", "lib.rs"), "\n");
      return "published";
    },
  });
  try {
    await assert.rejects(reader.ensure({ root, outDir, cargo: process.execPath, baseUrl: server.url, log: () => {} }), /changed while/);
  } finally {
    await server.close();
  }
  assert.equal(fs.existsSync(path.join(outDir, `${host}.node`)), false);
});

test("invalid published metadata or a missing published binary fails closed", async () => {
  const root = sourceTree("download-invalid");
  const outDir = path.join(root, "out");
  const asset = `/v9.9.9/upkeep-reader-${host}`;
  const otherTarget = Object.keys(reader.RUST_TARGETS).find((target) => target !== host);
  const source = reader.sourceSha256(root);
  for (const [assets, error] of [
    [{ [`${asset}.json`]: "not json" }, /is not valid .* metadata/],
    [{ [`${asset}.json`]: JSON.stringify({ target: otherTarget, sourceSha256: source, binarySha256: sha256("x") }) }, /is not valid .* metadata/],
    // Not a digest string, so not "a valid asset for other source" that may start a build.
    [{ [`${asset}.json`]: JSON.stringify({ target: host, sourceSha256: [source], binarySha256: sha256("x") }) }, /is not valid .* metadata/],
    [{ [`${asset}.json`]: JSON.stringify({ target: host, sourceSha256: source, binarySha256: sha256("x") }) }, /is missing although its metadata is published/],
  ]) {
    const server = await releaseServer(assets);
    try {
      await assert.rejects(reader.ensure({ root, outDir, cargo: process.execPath, baseUrl: server.url, log: () => {} }), error);
    } finally {
      await server.close();
    }
    assert.equal(fs.existsSync(path.join(outDir, `${host}.node`)), false);
  }
});

test("an unpublished version or other release source without cargo names what is missing", async () => {
  const root = sourceTree("no-producer");
  const outDir = path.join(root, "out");
  const missingCargo = path.join(root, "no-such-cargo");
  const asset = `/v9.9.9/upkeep-reader-${host}`;
  for (const [assets, reason] of [
    [{}, /CUELO v9\.9\.9 has no published upkeep reader/],
    [{ [`${asset}.json`]: JSON.stringify({ target: host, sourceSha256: "0".repeat(64), binarySha256: sha256("x") }) }, /current crate source differs/],
  ]) {
    const server = await releaseServer(assets);
    try {
      await assert.rejects(
        reader.ensure({ root, outDir, cargo: missingCargo, baseUrl: server.url, log: () => {} }),
        (error) => reason.test(error.message) && /no cargo is available/.test(error.message),
      );
    } finally {
      await server.close();
    }
  }
});

// The npm package carries the binary next to the crate inputs it was built from; an installed
// copy validates and loads it without cargo or network. Needs the prepared host artifact
// (`bun run prepare:source` makes it before tests in CI).
// A real `npm pack` took over bun's default 5 s on a loaded machine (load average 6.6).
test("an installed package validates and loads its packed reader", { timeout: 60_000 }, () => {
  const artifacts = path.join(repo, "bin", "native", "upkeep-reader");
  reader.check({ root: repo, outDir: artifacts });
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
  const fixture = tempDir("package");
  fs.mkdirSync(path.join(fixture, "bin", "native", "upkeep-reader"), { recursive: true });
  fs.copyFileSync(path.join(repo, "bin", "prepare-upkeep-reader.js"), path.join(fixture, "bin", "prepare-upkeep-reader.js"));
  for (const name of [`${host}.node`, `${host}.json`]) fs.copyFileSync(path.join(artifacts, name), path.join(fixture, "bin", "native", "upkeep-reader", name));
  fs.cpSync(path.join(repo, "native", "upkeep-reader"), path.join(fixture, "native", "upkeep-reader"), {
    recursive: true,
    filter: (source) => path.basename(source) !== "target",
  });
  // The repository's own `files` entries and ignore rules decide what is packed.
  fs.copyFileSync(path.join(repo, ".gitignore"), path.join(fixture, ".gitignore"));
  const files = pkg.files.filter((entry) => entry === "bin" || entry.startsWith("native/"));
  fs.writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ name: "cuelo-reader-fixture", version: "1.0.0", files }));

  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(npm, ["pack", "--ignore-scripts", "--silent"], { cwd: fixture, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(packed.status, 0, packed.stderr);
  const installed = tempDir("installed");
  const untar = spawnSync("tar", ["-xzf", path.join(fixture, packed.stdout.trim()), "-C", installed], { encoding: "utf8" });
  assert.equal(untar.status, 0, untar.stderr);
  const pkgDir = path.join(installed, "package");

  const checked = spawnSync(process.execPath, [path.join(pkgDir, "bin", "prepare-upkeep-reader.js"), "--check"], { encoding: "utf8" });
  assert.equal(checked.status, 0, checked.stderr);
  const jsonl = path.join(installed, "session.jsonl");
  fs.writeFileSync(jsonl, `${JSON.stringify({ type: "session", id: "s1", extra: "dropped" })}\n`);
  const read = spawnSync(process.execPath, ["-e", `
    const { UpkeepReader } = require(${JSON.stringify(path.join(pkgDir, "bin", "native", "upkeep-reader", `${host}.node`))});
    const r = new UpkeepReader(${JSON.stringify(jsonl)});
    r.next().then((batch) => { console.log(batch); r.close(); });
  `], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  assert.deepEqual(JSON.parse(read.stdout), [{ type: "session", id: "s1" }]);

  fs.rmSync(path.join(pkgDir, "bin", "native", "upkeep-reader", `${host}.node`));
  const missing = spawnSync(process.execPath, [path.join(pkgDir, "bin", "prepare-upkeep-reader.js"), "--check"], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Upkeep reader corrupt: .* is missing/);
});
