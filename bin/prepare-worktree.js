#!/usr/bin/env node
"use strict";

// Prepares a fresh git worktree of this repository so tests and typechecks run: dependencies, the
// native upkeep reader and the core patch are not carried by git. lib/session-worktree starts this
// in the background after it creates an automatic worktree (package.json "prepare:worktree").
// Steps run in order and the first failure stops the run with that step's name and exit code.
// When CUELO_WORKTREE_PREPARE_STATUS names a file, the state (running|done|failed, step, finish
// time) is written there so an agent can tell preparation in progress from a real failure.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const STEPS = [
  { name: "install", command: "bun", args: ["install", "--frozen-lockfile"] },
  { name: "upkeep-reader", command: process.execPath, args: ["bin/prepare-upkeep-reader.js", "--ensure"] },
  { name: "prepare-source", command: "bun", args: ["run", "prepare:source"] },
];
const statusPath = process.env.CUELO_WORKTREE_PREPARE_STATUS;
const startedAt = new Date().toISOString();

function report(state, extra = {}) {
  if (!statusPath) return;
  try {
    fs.writeFileSync(statusPath, JSON.stringify({ state, startedAt, ...(state === "running" ? {} : { finishedAt: new Date().toISOString() }), ...extra }));
  } catch (error) {
    console.error(`prepare-worktree: cannot write ${statusPath}: ${error.message}`);
  }
}

for (const step of STEPS) {
  console.log(`prepare-worktree: ${step.name}: ${step.command} ${step.args.join(" ")}`);
  report("running", { step: step.name });
  const result = spawnSync(step.command, step.args, { cwd: root, stdio: "inherit" });
  const code = result.status ?? 1;
  if (code !== 0) {
    const reason = result.error ? result.error.message : `exit ${code}`;
    console.error(`prepare-worktree: step "${step.name}" failed (${reason})`);
    report("failed", { step: step.name, exitCode: code, ...(result.error ? { error: result.error.message } : {}) });
    process.exit(code);
  }
}
report("done", { step: STEPS[STEPS.length - 1].name });
console.log("prepare-worktree: done");
