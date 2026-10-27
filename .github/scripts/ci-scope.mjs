#!/usr/bin/env node
// Decides whether the public CI app jobs (`Verify build (Linux)`, `Verify build
// (Windows smoke)`) must run for this revision. The `harness-linux` job never depends on
// this decision.
//
// The app jobs are skipped only when BOTH hold:
//   1. A baseline exists: the newest successful `push` run of this workflow on `main`
//      whose two app jobs both finished with `success` (skipped, failed or cancelled app
//      jobs do not count, so an earlier unverified or cancelled commit can never be
//      skipped past).
//   2. Every path that differs between that baseline tree and this checkout is an added or
//      modified regular file (git mode 100644) on the positive allowlist below. A deletion,
//      rename, symlink, submodule, mode change, unknown path, empty diff, fetch failure,
//      API failure, timeout or any other doubt means `app=true`.
// Only `push` runs can skip (a pull request runs its own copy of this script, so the
// workflow forces the app jobs there). One 20 s budget bounds API and git calls together.
//
// A version bump edits package.json, which is not on the allowlist, so a release revision
// always gets the full app jobs. A docs-only revision after an unreleased bump has an
// app tree identical to the verified baseline, so the release workflow's "CI succeeded"
// trust still points at a verified build.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const APP_JOBS = ["Verify build (Linux)", "Verify build (Windows smoke)"];

// Files no app job reads. Evidence: app tests and the build read harness files only
// through temp fixtures or `.ts`/`.js` modules; `prepare:source` reads patches/ and
// notices/ (not listed here); the harness job keeps validating every path below.
const HARNESS = "Tools/OMP_Global_Config/agent";
const SKIPPABLE = [
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^docs\/(?:[^/]+\/)*[^/]+\.md$/,
  new RegExp(`^${HARNESS}/(?:AGENTS|RULES|WATCHDOG|TITLE_SYSTEM)\\.md$`),
  new RegExp(`^${HARNESS}/(?:prompt-copies|rules|sop|agents)/[^/]+\\.md$`),
];

export function isSkippablePath(path) {
  if (typeof path !== "string" || path === "" || path.includes("\\") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
    return false;
  }
  return SKIPPABLE.some((pattern) => pattern.test(path));
}

/**
 * Parses `git diff --raw --abbrev=40 --no-renames -z` into `{status, path, oldMode, newMode}`.
 * `--name-status` is not enough: it reports a symlink or submodule as a plain `A`.
 */
export function parseRawDiff(output) {
  const parts = output.split("\0");
  if (parts.at(-1) === "") parts.pop();
  if (parts.length % 2 !== 0) throw new Error("unparseable git diff output");
  const changes = [];
  for (let i = 0; i < parts.length; i += 2) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} ([A-Z])\d*$/.exec(parts[i]);
    if (!meta) throw new Error("unparseable git diff output");
    changes.push({ oldMode: meta[1], newMode: meta[2], status: meta[3], path: parts[i + 1] });
  }
  return changes;
}

/** `{app, reason}` for a list of changes. Anything not positively known runs everything. */
export function classifyChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    return { app: true, reason: "no changed paths found, so the scope is unknown" };
  }
  for (const { status, path, oldMode, newMode } of changes) {
    if (status !== "A" && status !== "M") {
      return { app: true, reason: `${status} ${path}: only added or modified files can be skipped` };
    }
    if (newMode !== REGULAR_FILE || (status === "M" && oldMode !== REGULAR_FILE)) {
      return { app: true, reason: `${path} is not a regular file (mode ${oldMode} -> ${newMode})` };
    }
    if (!isSkippablePath(path)) return { app: true, reason: `${path} is not a known docs or harness-instruction path` };
  }
  return { app: false, reason: `${changes.length} changed path(s), all regular docs or harness instruction files` };
}

/** Head SHA of the newest push run on main whose app jobs both succeeded, or null. */
export async function pickBaseline({ runs, currentRunId, jobsOf }) {
  for (const run of runs) {
    if (String(run.id) === String(currentRunId)) continue;
    if (run.conclusion !== "success" || run.event !== "push" || run.head_branch !== "main") continue;
    const jobs = await jobsOf(run.id);
    if (APP_JOBS.every((name) => jobs.some((job) => job.name === name && job.conclusion === "success"))) {
      return run.head_sha;
    }
  }
  return null;
}

const REGULAR_FILE = "100644";
export const DEFAULT_BUDGET_MS = 20_000;

/** Runs git in `cwd`, killed after `timeoutMs`. Never prompts for credentials. */
export function runGit(args, cwd, timeoutMs) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * Decides for one run. `api(path, {timeoutMs})` returns parsed JSON for a repository API
 * path; `git(args, {timeoutMs})` runs git in the checkout. One shared budget bounds the
 * whole decision: when it runs out, or anything fails, the answer is `app=true`. Never throws.
 * Only `push` runs can skip: a pull request runs the PR's own copy of this script, so it is
 * never trusted (the workflow also forces its app jobs, independent of this output).
 */
export async function decide({ event, api, git, currentRunId, runLimit = 20, budgetMs = DEFAULT_BUDGET_MS }) {
  try {
    if (event !== "push") return { app: true, reason: `${event || "unknown"} event always runs the full checks` };
    const deadline = Date.now() + budgetMs;
    const bounded = async (work) => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error(`classifier budget of ${budgetMs} ms exhausted`);
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`classifier budget of ${budgetMs} ms exhausted`)), ms);
      });
      try {
        return await Promise.race([work(ms), expired]);
      } finally {
        clearTimeout(timer);
      }
    };
    const callApi = (path) => bounded((timeoutMs) => api(path, { timeoutMs }));
    const callGit = (args) => bounded((timeoutMs) => git(args, { timeoutMs }));

    const listing = await callApi(`/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=${runLimit}`);
    const baseline = await pickBaseline({
      runs: listing.workflow_runs ?? [],
      currentRunId,
      jobsOf: async (id) => (await callApi(`/actions/runs/${id}/jobs?filter=latest&per_page=100`)).jobs ?? [],
    });
    if (!baseline || !/^[0-9a-f]{40}$/.test(baseline)) {
      return { app: true, reason: "no earlier run with passing app jobs to compare against" };
    }
    try {
      await callGit(["cat-file", "-e", `${baseline}^{commit}`]);
    } catch (error) {
      if (/budget/.test(error?.message)) throw error;
      await callGit(["fetch", "--no-tags", "--depth=1", "origin", baseline]);
    }
    const head = (await callGit(["rev-parse", "HEAD"])).trim();
    if (head === baseline) return { app: true, reason: "this revision is its own baseline; rerunning everything" };
    const changes = parseRawDiff(await callGit(["diff", "--raw", "--abbrev=40", "--no-renames", "--no-ext-diff", "-z", baseline, "HEAD"]));
    return { ...classifyChanges(changes), baseline };
  } catch (error) {
    return { app: true, reason: `classifier error, running everything: ${String(error?.message ?? error).split("\n")[0]}` };
  }
}

export function githubApi(env) {
  const base = env.GITHUB_API_URL || "https://api.github.com";
  return async (path, { timeoutMs }) => {
    const response = await fetch(`${base}/repos/${env.GITHUB_REPOSITORY}${path}`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub API ${path.split("?")[0]} answered ${response.status}`);
    return response.json();
  };
}

async function main(env = process.env) {
  const budgetMs = Number(env.CI_SCOPE_BUDGET_MS) > 0 ? Number(env.CI_SCOPE_BUDGET_MS) : DEFAULT_BUDGET_MS;
  const result = await decide({
    event: env.GITHUB_EVENT_NAME,
    api: githubApi(env),
    git: (args, { timeoutMs }) => runGit(args, process.cwd(), timeoutMs),
    currentRunId: env.GITHUB_RUN_ID,
    budgetMs,
  });
  const reason = result.reason.replace(/\s+/g, " ").slice(0, 300);
  const lines = [`app=${result.app}`, `reason=${reason}`, ...(result.baseline ? [`baseline=${result.baseline}`] : [])];
  console.log(lines.join("\n"));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `**App jobs ${result.app ? "run" : "skipped"}**: ${reason}${result.baseline ? ` (baseline \`${result.baseline.slice(0, 12)}\`)` : ""}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  // A stalled socket or child must not keep the step alive after the answer is written.
  process.exit(0);
}
