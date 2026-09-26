#!/usr/bin/env node
"use strict";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");

const pkgDir = path.resolve(__dirname, "..");
const isCheck = process.argv.length === 3 && process.argv[2] === "--check";
if (process.argv.length > (isCheck ? 3 : 2)) {
  console.error("Usage: node bin/prepare-runtime.js [--check]");
  process.exit(1);
}

// 소스 체크아웃의 npm postinstall은 작업 중인 node_modules를 수정하지 않는다.
// 서버 준비 검사는 bun.lock을 추가해도 이 소스 분기를 사용하지 않는다.
if (!isCheck &&
    fs.existsSync(path.join(pkgDir, "bun.lock")) &&
    fs.existsSync(path.join(pkgDir, "app", "layout.tsx"))) {
  console.log("CUELO source install: runtime patch preparation is handled by the source release path.");
  process.exit(0);
}

const buildId = path.join(pkgDir, ".next", "BUILD_ID");
if (!fs.existsSync(buildId)) {
  console.error("CUELO npm package has no production build (.next/BUILD_ID). Install a prepared tarball.");
  process.exit(1);
}

const coreRoot = path.join(pkgDir, "node_modules", "@oh-my-pi");
const corePackages = ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"];
const actualRoot = fs.realpathSync(pkgDir);
for (const name of corePackages) {
  const expected = path.join(coreRoot, name);
  let actual;
  try {
    actual = fs.realpathSync(expected);
  } catch {
    console.error(`CUELO requires a package-owned SDK at ${expected}. Install globally into an isolated prefix, not a hoisted/shared dependency tree.`);
    process.exit(1);
  }
  const expectedRelative = path.join("node_modules", "@oh-my-pi", name);
  const actualRelative = path.relative(actualRoot, actual);
  if ((process.platform === "win32" ? actualRelative.toLowerCase() : actualRelative) !==
      (process.platform === "win32" ? expectedRelative.toLowerCase() : expectedRelative)) {
    console.error(`CUELO refuses to patch an SDK outside its own package: ${actual}`);
    process.exit(1);
  }
}

const sdk = path.join(coreRoot, "pi-coding-agent");
const home = path.join(pkgDir, ".runtime-patch-home");
if (!isCheck) fs.mkdirSync(home, { recursive: true });
const env = { ...process.env, OMP_CORE_PATCH_TARGET: sdk, HOME: home, USERPROFILE: home };
const mode = isCheck ? ["--check"] : [];
const commands = [
  [path.join(pkgDir, "Tools", "CUELO_Setup", "files", "native-runtime-patch.js"), ["--target", pkgDir, ...mode]],
  [path.join(pkgDir, "Tools", "OMP_Global_Config", "patches", "apply-core-patch.mjs"), mode],
  [path.join(pkgDir, "Tools", "OMP_Global_Config", "patches", "apply-notices.mjs"), mode],
];
for (const [script, args] of commands) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: pkgDir,
    env,
    encoding: "utf8",
    stdio: isCheck ? "pipe" : "inherit",
  });
  if (result.error || result.status !== 0) {
    if (isCheck) {
      if (result.stdout) process.stderr.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    console.error(`CUELO runtime preparation ${isCheck ? "check" : "apply"} failed at ${path.basename(script)}: ${result.error?.message ?? `exit ${result.status}`}`);
    if (isCheck) console.error("If installation scripts did not run, use npm run prepare:runtime inside the installed cuelo package.");
    process.exit(1);
  }
}
if (!isCheck) console.log("CUELO npm runtime patches applied and verified inside this package.");
