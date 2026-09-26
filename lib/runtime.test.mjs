import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");
const {
  MIN_BUN_VERSION,
  MIN_NODE_VERSION,
  getMissingBunMessage,
  getUnsupportedBunVersionMessage,
  getUnsupportedNodeVersionMessage,
  isBunVersionSupported,
  isNodeVersionSupported,
  resolveBunPath,
  withLoopbackNoProxy,
} = require("../bin/runtime.js");

test("accepts the minimum supported Node.js version and newer versions", () => {
  for (const version of ["22.19.0", "v22.19.0", "22.19.1", "23.0.0"]) {
    assert.equal(isNodeVersionSupported(version), true, version);
  }
});

test("rejects older and invalid Node.js versions", () => {
  for (const version of ["20.19.5", "22.18.99", "invalid"]) {
    assert.equal(isNodeVersionSupported(version), false, version);
  }
});

test("accepts the minimum supported Bun version and newer versions", () => {
  for (const version of ["1.4.2", "v1.4.2", "1.4.3", "2.0.0"]) {
    assert.equal(isBunVersionSupported(version), true, version);
  }
});

test("rejects older and invalid Bun versions", () => {
  for (const version of ["1.4.1", "1.3.14", "1.2.99", "0.8.1", "nope"]) {
    assert.equal(isBunVersionSupported(version), false, version);
  }
});

test("keeps the package engines aligned with the startup checks", () => {
  assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
  assert.equal(packageJson.engines.bun, `>=${MIN_BUN_VERSION}`);
});

test("reports both the required and current Node.js versions", () => {
  const message = getUnsupportedNodeVersionMessage("20.19.5");
  assert.match(message, /requires Node\.js 22\.19\.0 or newer/);
  assert.match(message, /Current Node\.js version: 20\.19\.5/);
});
test("reports both the required and current Bun versions", () => {
  const message = getUnsupportedBunVersionMessage("1.2.99");
  assert.match(message, /requires Bun 1\.4\.2 or newer/);
  assert.match(message, /Current Bun version: 1\.2\.99/);
});

test("explains how to install Bun and how to override its location", () => {
  const message = getMissingBunMessage();
  assert.match(message, /bun\.sh\/install/);
  assert.match(message, /CUELO_BUN=/);
});

test("prefers CUELO_BUN over PATH lookups", () => {
  const dir = mkdtempSync(join(tmpdir(), "cuelo-runtime-"));
  try {
    const override = join(dir, "custom-bun");
    writeFileSync(override, "");
    assert.equal(resolveBunPath({ CUELO_BUN: override, PATH: "" }), override);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Bun 런처가 사용하는 프록시 요청과 loopback 예외를 로컬 서버로 관측한다. */
async function startRecordingProxy(t) {
  const connectTargets = [];
  const forwardedRequests = [];
  const proxy = createServer((req, res) => {
    forwardedRequests.push(`${req.method} ${req.url}`);
    res.writeHead(204, { Connection: "close" });
    res.end();
  });
  proxy.on("connect", (req, socket) => {
    connectTargets.push(req.url);
    socket.destroy();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve, reject) => {
    proxy.close((error) => error ? reject(error) : resolve());
  }));

  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, connectTargets, forwardedRequests };
}

const bunOnly = typeof process.versions.bun === "string" ? test : test.skip;

// Bun은 프록시 환경변수를 프로세스 시작 시 읽으므로 자식 프로세스로 검사한다.
bunOnly("the launcher env routes remote hosts through HTTP_PROXY and reaches loopback directly", async (t) => {
  const proxy = await startRecordingProxy(t);
  const direct = createServer((_req, res) => {
    res.writeHead(200, { Connection: "close" });
    res.end("direct");
  });
  direct.listen(0, "127.0.0.1");
  await once(direct, "listening");
  t.after(() => new Promise((resolve, reject) => {
    direct.close((error) => error ? reject(error) : resolve());
  }));
  const directPort = direct.address().port;

  const script = `
    try {
      const res = await fetch("http://target.invalid/through-http-proxy", { signal: AbortSignal.timeout(5000) });
      console.log("proxied:" + res.status);
    } catch (error) { console.log("proxied-error:" + error.message); }
    try {
      const res = await fetch("http://127.0.0.1:${directPort}/local", { signal: AbortSignal.timeout(5000) });
      console.log("loopback:" + (await res.text()));
    } catch (error) { console.log("loopback-error:" + error.message); }
  `;

  const child = spawn(process.execPath, ["-e", script], {
    env: withLoopbackNoProxy({ ...process.env, HTTP_PROXY: proxy.url, HTTPS_PROXY: proxy.url, NO_PROXY: "", no_proxy: "" }),
    stdio: ["ignore", "pipe", "inherit"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  const [code] = await once(child, "exit");

  assert.equal(code, 0, output);
  assert.match(output, /proxied:204/);
  // Bun의 HTTP 전달 형식에서 기본 포트 표기는 버전에 따라 달라진다.
  assert.equal(proxy.forwardedRequests.length, 1);
  assert.match(proxy.forwardedRequests[0], /^GET http:\/\/target\.invalid(:80)?\/through-http-proxy$/);
  // 로컬 provider 주소는 프록시를 거치면 안 된다.
  assert.match(output, /loopback:direct/);
  assert.equal(proxy.forwardedRequests.length + proxy.connectTargets.length, 1);
});
