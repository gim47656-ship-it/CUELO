#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { copyHarness, createProfileConfig, harnessEntries, resolveProfile } from "../install.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { agentDir } = resolveProfile();
fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
copyHarness(path.join(root, "Tools/OMP_Global_Config/agent"), agentDir, harnessEntries(pkg.files));
createProfileConfig(agentDir, {});
const child = spawn(process.execPath, [path.join(root, "install.mjs"), "start", "--hostname", "0.0.0.0", ...process.argv.slice(2)], {
  cwd: root, env: process.env, stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
