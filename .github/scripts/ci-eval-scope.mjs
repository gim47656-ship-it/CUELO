#!/usr/bin/env node
// Decides whether the private job's `Eval analyzer tests` step must run for this revision.
//
// The analyzers copy and run files under Tools/OMP_Global_Config/{evals,agent,patches}, so
// only a change there can move their result. The step is skipped only when BOTH hold:
//   1. A baseline exists: the head of the newest successful `push` or `workflow_dispatch`
//      run of this workflow on `main` whose `Verify private files (Linux)` job succeeded.
//      The newest success is used, not the push's parent: when a quick follow-up push cancels
//      the run of a commit that changed evals, the follow-up still diffs against the last
//      verified commit and so still sees that change.
//   2. The diff between that baseline and this checkout is non-empty and touches none of the
//      three trees. A fetch failure, API failure, timeout, empty diff or any other doubt
//      means `run=true`.
// Only `push` runs can skip; a manual run always runs the step. One 20 s budget bounds the
// API and git calls together.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { DEFAULT_BUDGET_MS, githubApi, runGit } from "./ci-scope.mjs";

export const PRIVATE_JOB = "Verify private files (Linux)";
const ROOT = "Tools/OMP_Global_Config/";
export const EVAL_INPUT_PREFIXES = [`${ROOT}evals/`, `${ROOT}agent/`, `${ROOT}patches/`];

export function touchesEvalInputs(paths) {
  return paths.some((path) => EVAL_INPUT_PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/** Head SHA of the newest successful main run whose private job succeeded, or null. */
export async function pickBaseline({ runs, currentRunId, jobsOf }) {
  for (const run of runs) {
    if (String(run.id) === String(currentRunId)) continue;
    if (run.conclusion !== "success" || run.head_branch !== "main") continue;
    if (run.event !== "push" && run.event !== "workflow_dispatch") continue;
    const jobs = await jobsOf(run.id);
    if (jobs.some((job) => job.name === PRIVATE_JOB && job.conclusion === "success")) return run.head_sha;
  }
  return null;
}

/**
 * `{run, reason, baseline?}` for one run. `api(path, {timeoutMs})` returns parsed JSON for a
 * repository API path; `git(args, {timeoutMs})` runs git in the checkout. Never throws.
 */
export async function decide({ event, api, git, currentRunId, runLimit = 20, budgetMs = DEFAULT_BUDGET_MS }) {
  try {
    if (event !== "push") return { run: true, reason: `${event || "unknown"} event always runs the step` };
    const deadline = Date.now() + budgetMs;
    const remaining = () => {
      const ms = deadline - Date.now();
      if (ms <= 0) throw new Error(`budget of ${budgetMs} ms exhausted`);
      return ms;
    };
    const listing = await api(`/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=${runLimit}`, { timeoutMs: remaining() });
    const baseline = await pickBaseline({
      runs: listing.workflow_runs ?? [],
      currentRunId,
      jobsOf: async (id) => (await api(`/actions/runs/${id}/jobs?filter=latest&per_page=100`, { timeoutMs: remaining() })).jobs ?? [],
    });
    if (!baseline || !/^[0-9a-f]{40}$/.test(baseline)) {
      return { run: true, reason: "no earlier successful run to compare against" };
    }
    try {
      await git(["cat-file", "-e", `${baseline}^{commit}`], { timeoutMs: remaining() });
    } catch (error) {
      if (/budget/.test(error?.message)) throw error;
      await git(["fetch", "--no-tags", "--depth=1", "origin", baseline], { timeoutMs: remaining() });
    }
    const head = (await git(["rev-parse", "HEAD"], { timeoutMs: remaining() })).trim();
    if (head === baseline) return { run: true, reason: "this revision is its own baseline", baseline };
    const output = await git(["diff", "--name-only", "--no-renames", "--no-ext-diff", "-z", baseline, "HEAD"], { timeoutMs: remaining() });
    const paths = output.split("\0").filter(Boolean);
    if (paths.length === 0) return { run: true, reason: "no changed paths found, so the scope is unknown", baseline };
    if (touchesEvalInputs(paths)) return { run: true, reason: "evals/, agent/ or patches/ changed since the last verified revision", baseline };
    return { run: false, reason: `${paths.length} changed path(s), none under evals/, agent/ or patches/`, baseline };
  } catch (error) {
    return { run: true, reason: `scope error, running the step: ${String(error?.message ?? error).split("\n")[0]}` };
  }
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
  const lines = [`run=${result.run}`, `reason=${reason}`, ...(result.baseline ? [`baseline=${result.baseline}`] : [])];
  console.log(lines.join("\n"));
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `**Eval analyzer tests ${result.run ? "run" : "skipped"}**: ${reason}${result.baseline ? ` (baseline \`${result.baseline.slice(0, 12)}\`)` : ""}\n`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
  // A stalled socket or child must not keep the step alive after the answer is written.
  process.exit(0);
}
