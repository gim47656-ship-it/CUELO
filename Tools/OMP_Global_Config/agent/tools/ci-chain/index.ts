import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";
import { parsePushPathsFilter, pushStartsWorkflow } from "./paths-filter";

export type CiChainLegState =
  | "completed"
  | "in_progress"
  | "pending"
  | "not-found-within-bound"
  | "skipped-no-public-change"
  | "skipped-paths-ignored"
  | "error";

export interface CiChainMirrorParams {
  repo: string;
  workflows: string[];
  title?: string;
}

export interface CiChainParams {
  repo: string;
  sha: string;
  workflows: string[];
  mirror?: CiChainMirrorParams;
  waitSeconds?: number;
  pollSeconds?: number;
}

export interface CiChainLegResult {
  repo: string;
  workflow: string;
  runId: number | null;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  matchedBy: "headSha" | "title";
  failedJobs?: string[];
  logTail?: string[];
  state: CiChainLegState;
  error?: string;
}

export interface CiChainResult {
  ok: boolean;
  repo: string;
  sha: string;
  mirrorTitle?: string | null;
  verdict: string;
  legs: CiChainLegResult[];
  polls: number;
  elapsedMs: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr?: string;
  killed?: boolean;
}

export type Exec = (
  command: string,
  args: string[],
  options: { cwd: string; timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>;

export interface CiChainDeps {
  exec: Exec;
  cwd: string;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

interface NormalizedRun {
  runId: number | null;
  workflow: string;
  status: string | null;
  conclusion: string | null;
  url: string | null;
  displayTitle: string;
  headSha: string;
  createdAt: string;
  updatedAt: string;
  rawJobs?: unknown[];
  rawFailedJobs?: string[];
}

const DEFAULT_WAIT_SECONDS = 0;
const MAX_WAIT_SECONDS = 1800;
const DEFAULT_POLL_SECONDS = 15;
const MAX_POLL_SECONDS = 300;
const LOG_TAIL_LINES = 40;
const GH_TIMEOUT_MS = 120_000;
const RUN_LIST_LIMIT = 100;
const EXCLUDED_WORKFLOW = "Publish CUELO web release";
const PUBLISH_MIRROR_WORKFLOW = "Publish public mirror";
const NON_FAILED_CONCLUSIONS: Record<string, true> = {
  success: true,
  skipped: true,
  neutral: true,
  cancelled: true,
};
const RUN_LIST_FIELDS =
  "databaseId,workflowName,name,status,conclusion,url,displayTitle,headSha,createdAt,updatedAt";

export function isFailedConclusion(conclusion: string | null | undefined): boolean {
  if (!conclusion) return false;
  return !NON_FAILED_CONCLUSIONS[conclusion.toLowerCase()];
}

/** GitHub cuts a run's displayTitle to 69 characters plus "…" (all 130 truncated public CI titles observed on 2026-10-27 are 70 characters long). */
const TRUNCATED_TITLE_LENGTH = 70;

/**
 * Matches a mirror workflow run's `displayTitle` against the private commit's subject line.
 * Only GitHub's own truncation counts as a prefix match; an ellipsis written inside a commit subject is literal text.
 */
export function matchesRunTitle(displayTitle: string, expectedTitle: string): boolean {
  const actual = displayTitle.trim();
  const expected = expectedTitle.trim();
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  // Count code points, not UTF-16 units, so an emoji in the subject does not change the measured cut.
  const actualLength = [...actual].length;
  return (
    actualLength === TRUNCATED_TITLE_LENGTH &&
    actual.endsWith("…") &&
    [...expected].length >= TRUNCATED_TITLE_LENGTH &&
    expected.startsWith(actual.slice(0, -1))
  );
}

function matchesSha(runSha: string, targetSha: string): boolean {
  const a = runSha.trim().toLowerCase();
  const b = targetSha.trim().toLowerCase();
  if (!a || !b) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

function normalizeRun(raw: Record<string, unknown>, repo: string): NormalizedRun {
  const rawId = raw.databaseId ?? raw.id ?? raw.runId;
  const runId = typeof rawId === "number" && Number.isFinite(rawId)
    ? rawId
    : typeof rawId === "string" && /^\d+$/.test(rawId)
      ? Number(rawId)
      : null;
  const workflow = String(raw.workflowName || raw.name || raw.workflow || "").trim();
  const status = typeof raw.status === "string" && raw.status.trim() ? raw.status.trim() : null;
  const conclusion = typeof raw.conclusion === "string" && raw.conclusion.trim() ? raw.conclusion.trim() : null;
  const rawUrl = typeof raw.url === "string" && raw.url.trim()
    ? raw.url.trim()
    : typeof raw.html_url === "string" && raw.html_url.trim()
      ? raw.html_url.trim()
      : null;
  const url = rawUrl ?? (runId !== null ? `https://github.com/${repo}/actions/runs/${runId}` : null);
  const displayTitle = String(raw.displayTitle ?? raw.title ?? raw.display_title ?? "").trim();
  const headSha = String(raw.headSha ?? raw.head_sha ?? raw.sha ?? "").trim();
  const createdAt = String(raw.createdAt ?? raw.created_at ?? "").trim();
  const updatedAt = String(raw.updatedAt ?? raw.updated_at ?? "").trim();
  const rawJobs = Array.isArray(raw.jobs) ? raw.jobs : undefined;
  const rawFailedJobs = Array.isArray(raw.failedJobs)
    ? raw.failedJobs.filter((j): j is string => typeof j === "string" && j.trim().length > 0)
    : undefined;
  return { runId, workflow, status, conclusion, url, displayTitle, headSha, createdAt, updatedAt, rawJobs, rawFailedJobs };
}

function pickNewestRun(runs: NormalizedRun[]): NormalizedRun | undefined {
  if (runs.length <= 1) return runs[0];
  const indexed = runs.map((run, index) => ({
    run,
    index,
    time: run.createdAt ? Date.parse(run.createdAt) : Number.NaN,
  }));
  indexed.sort((a, b) => {
    const aValid = !Number.isNaN(a.time);
    const bValid = !Number.isNaN(b.time);
    if (aValid && bValid && a.time !== b.time) return b.time - a.time;
    if (a.run.runId !== null && b.run.runId !== null && a.run.runId !== b.run.runId) {
      return b.run.runId - a.run.runId;
    }
    return a.index - b.index;
  });
  return indexed[0]?.run;
}

function splitLogLines(text: string): string[] {
  const cleaned = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!cleaned.trim()) return [];
  const lines = cleaned.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function extractTabJobNames(lines: string[]): string[] {
  const seen = new Set<string>();
  for (const line of lines) {
    const tabIdx = line.indexOf("\t");
    if (tabIdx > 0) {
      const jobName = line.slice(0, tabIdx).trim();
      if (jobName) seen.add(jobName);
    }
  }
  return [...seen];
}

function filterRequestedWorkflows(workflows: string[]): string[] {
  return workflows
    .map((w) => w.trim())
    .filter((w) => w.length > 0 && w !== EXCLUDED_WORKFLOW);
}

async function execGhJson<T>(
  deps: CiChainDeps,
  args: string[],
  label: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  let res: ExecResult;
  try {
    res = await deps.exec("gh", args, { cwd: deps.cwd, signal: deps.signal });
  } catch (err) {
    return { ok: false, error: `${label}: exec failed (${err instanceof Error ? err.message : String(err)})` };
  }
  if (res.killed || res.code !== 0) {
    const detail = (res.stderr || res.stdout || "").trim() || "no output";
    return { ok: false, error: `${label}: gh ${res.killed ? "was killed (timeout)" : `exited ${res.code}`} (${detail})` };
  }
  const stdout = res.stdout.trim();
  if (!stdout) {
    return { ok: false, error: `${label}: gh returned empty stdout` };
  }
  try {
    return { ok: true, data: JSON.parse(stdout) as T };
  } catch (err) {
    return {
      ok: false,
      error: `${label}: unparsable JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
}

async function fetchRunList(
  deps: CiChainDeps,
  repo: string,
  filter: { sha?: string; workflow?: string; createdSince?: string },
): Promise<{ ok: true; runs: NormalizedRun[]; pageFull: boolean } | { ok: false; error: string }> {
  const args = ["run", "list", "--repo", repo];
  if (filter.sha) args.push("--commit", filter.sha);
  if (filter.workflow) args.push("--workflow", filter.workflow);
  if (filter.createdSince) args.push("--created", `>=${filter.createdSince}`);
  args.push("--limit", String(RUN_LIST_LIMIT), "--json", RUN_LIST_FIELDS);
  const label = `gh run list (${repo}${filter.workflow ? `, ${filter.workflow}` : ""})`;
  const res = await execGhJson<unknown>(deps, args, label);
  if (!res.ok) return res;
  if (!Array.isArray(res.data)) {
    return { ok: false, error: `${label}: expected JSON array` };
  }
  const runs: NormalizedRun[] = [];
  for (const item of res.data) {
    if (typeof item !== "object" || item === null) return { ok: false, error: `${label}: run record is not an object` };
    const record = item as Record<string, unknown>;
    const run = normalizeRun(record, repo);
    // A record without identity, creation time or (for a commit query) head SHA cannot be matched; never guess with it.
    // An empty workflowName is real data (GitHub `startup_failure` runs carry none, e.g. on 53d26eb); such a run matches no workflow.
    if (typeof record.databaseId !== "number" || Number.isNaN(Date.parse(run.createdAt)) || (filter.sha && !run.headSha)) {
      return { ok: false, error: `${label}: run record lacks databaseId, createdAt or headSha` };
    }
    if (run.workflow && run.workflow !== EXCLUDED_WORKFLOW) runs.push(run);
  }
  return { ok: true, runs, pageFull: res.data.length >= RUN_LIST_LIMIT };
}

async function fetchCommitInfo(
  deps: CiChainDeps,
  repo: string,
  sha: string,
): Promise<{ ok: true; subject: string; fullSha?: string } | { ok: false; error: string }> {
  const res = await execGhJson<unknown>(
    deps,
    ["api", `repos/${repo}/commits/${sha}`],
    `gh api repos/${repo}/commits/${sha}`,
  );
  if (!res.ok) return res;
  const data = res.data as Record<string, unknown> | string | null;
  let message = "";
  let fullSha: string | undefined;
  if (typeof data === "string") {
    message = data;
  } else if (data && typeof data === "object") {
    const commitObj = data.commit as Record<string, unknown> | undefined;
    if (typeof commitObj?.message === "string") message = commitObj.message;
    else if (typeof data.message === "string") message = data.message;
    else if (typeof data.title === "string") message = data.title;
    if (typeof data.sha === "string" && /^[0-9a-f]{40}$/i.test(data.sha)) {
      fullSha = data.sha;
    }
  }
  const subject = message.split(/\r?\n/)[0]?.trim() ?? "";
  if (!subject) {
    return { ok: false, error: `gh api repos/${repo}/commits/${sha}: commit subject missing in response` };
  }
  return { ok: true, subject, fullSha };
}

type CommitFacts = {
  /** Files the commit changed (renames list both names), or null when they cannot stand for its diff: no files, or 300 or more. */
  paths: string[] | null;
  /** The only parent, or null for a root commit or a merge commit. */
  parent: string | null;
};

type PathsIgnoredCache = {
  /** `repo workflow sha` -> true once the commit was found to have been skipped by the workflow's filter. */
  decisions: Map<string, boolean>;
  /** `repo sha` -> what the commits API said; only successful lookups are kept. */
  commits: Map<string, CommitFacts>;
  /** `repo` -> workflow display name -> workflow file path, and whether the listing held every workflow of the repository. */
  workflowFiles?: Map<string, { byName: Map<string, string>; complete: boolean }>;
  /** `repo path ref` -> workflow file text; a file at a commit never changes, so a poll loop reads it once. */
  workflowTexts?: Map<string, string>;
};

/** GitHub lists at most 300 files per commit. */
const COMMIT_FILE_LIMIT = 300;

async function fetchCommitFacts(deps: CiChainDeps, repo: string, sha: string, cache: PathsIgnoredCache): Promise<CommitFacts | null> {
  const key = `${repo} ${sha}`;
  const known = cache.commits.get(key);
  if (known) return known;
  const res = await execGhJson<unknown>(deps, ["api", `repos/${repo}/commits/${sha}`], `gh api repos/${repo}/commits/${sha}`);
  if (!res.ok || typeof res.data !== "object" || res.data === null) return null;
  const parents: unknown = Reflect.get(res.data, "parents");
  const files: unknown = Reflect.get(res.data, "files");
  const onlyParent: unknown = Array.isArray(parents) && parents.length === 1 && typeof parents[0] === "object" && parents[0] !== null ? Reflect.get(parents[0], "sha") : undefined;
  const facts: CommitFacts = { paths: null, parent: typeof onlyParent === "string" && /^[0-9a-f]{40}$/i.test(onlyParent) ? onlyParent : null };
  if (Array.isArray(files) && files.length > 0 && files.length < COMMIT_FILE_LIMIT) {
    const collected: string[] = [];
    for (const file of files) {
      const name: unknown = typeof file === "object" && file !== null ? Reflect.get(file, "filename") : undefined;
      const previous: unknown = typeof file === "object" && file !== null ? Reflect.get(file, "previous_filename") : undefined;
      if (typeof name !== "string") {
        collected.length = 0;
        break;
      }
      collected.push(name);
      if (typeof previous === "string") collected.push(previous);
    }
    if (collected.length > 0) facts.paths = collected;
  }
  cache.commits.set(key, facts);
  return facts;
}

/** The repository's workflows by display name, or null when the listing could not be read. */
async function fetchWorkflowList(deps: CiChainDeps, repo: string, cache: PathsIgnoredCache): Promise<{ byName: Map<string, string>; complete: boolean } | null> {
  const files = (cache.workflowFiles ??= new Map());
  const known = files.get(repo);
  if (known) return known;
  const list = await execGhJson<unknown>(deps, ["api", `repos/${repo}/actions/workflows?per_page=100`], `gh api repos/${repo}/actions/workflows`);
  const data: unknown = list.ok ? list.data : undefined;
  const workflows: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "workflows") : undefined;
  // A failed or malformed listing is not cached, so the next poll asks again.
  if (typeof data !== "object" || data === null || !Array.isArray(workflows)) return null;
  const byName = new Map<string, string>();
  let valid = 0;
  for (const item of workflows) {
    const name: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "name") : undefined;
    const path: unknown = typeof item === "object" && item !== null ? Reflect.get(item, "path") : undefined;
    if (typeof name === "string" && typeof path === "string") {
      byName.set(name, path);
      valid++;
    }
  }
  // Only a listing whose stated total equals the entries it holds, none of them unreadable, can prove a name absent.
  const total: unknown = Reflect.get(data, "total_count");
  const entry = { byName, complete: total === workflows.length && valid === workflows.length };
  files.set(repo, entry);
  return entry;
}

/**
 * An error message when the repository has no workflow by this display name, so no run can ever appear; undefined when it
 * has one or the listing is unreadable or partial (more than one page), in which case the leg is left to the usual checks.
 */
async function unknownWorkflowError(deps: CiChainDeps, repo: string, workflow: string, cache: PathsIgnoredCache): Promise<string | undefined> {
  const list = await fetchWorkflowList(deps, repo, cache);
  if (!list || !list.complete || list.byName.has(workflow)) return undefined;
  return `${repo} has no workflow named "${workflow}" (a job or step name is not a workflow name); its workflows are: ${[...list.byName.keys()].join(", ")}`;
}

async function fetchWorkflowFile(deps: CiChainDeps, repo: string, workflow: string, sha: string, cache: PathsIgnoredCache): Promise<string | null> {
  const path = (await fetchWorkflowList(deps, repo, cache))?.byName.get(workflow);
  if (!path) return null;
  // The workflow file as of the pushed commit is the one GitHub evaluated.
  const textKey = `${repo} ${path} ${sha}`;
  const texts = (cache.workflowTexts ??= new Map());
  const cached = texts.get(textKey);
  if (cached !== undefined) return cached;
  const res = await execGhJson<unknown>(deps, ["api", `repos/${repo}/contents/${path}?ref=${sha}`], `gh api repos/${repo}/contents/${path}`);
  if (!res.ok || typeof res.data !== "object" || res.data === null) return null;
  const content: unknown = Reflect.get(res.data, "content");
  const encoding: unknown = Reflect.get(res.data, "encoding");
  if (typeof content !== "string" || encoding !== "base64") return null;
  const text = Buffer.from(content.replace(/\s/g, ""), "base64").toString("utf8");
  texts.set(textKey, text);
  return text;
}

/** How many consecutive commits without a run one verdict may explain; a longer unrun chain stays pending. */
const MAX_UNRUN_COMMITS = 10;

/**
 * True only when the workflow has a push path filter and GitHub never created a run for this commit because every file it
 * changed is filtered out. The commit's own diff is not the push's diff: a push of several commits is one diff over all of
 * them, so a doc-only tip can sit on top of a code commit that did start a run. The walk therefore goes back through parents
 * that have no run of this workflow, each of which must also be fully filtered, until it reaches a commit that has such a run
 * (an earlier push's tip, so the pushes are separate). A commit on the way that the filter lets through, a merge commit, an
 * oversized diff, an unreadable or unsupported filter, a failed lookup or a chain longer than MAX_UNRUN_COMMITS all end the
 * walk with false: the leg then stays pending, exactly as before, and is never reported as skipped on a guess.
 */
async function isPushPathsIgnored(deps: CiChainDeps, repo: string, workflow: string, sha: string, cache: PathsIgnoredCache): Promise<boolean> {
  const key = `${repo} ${workflow} ${sha}`;
  if (cache.decisions.get(key)) return true;
  let ignored = false;
  try {
    const text = await fetchWorkflowFile(deps, repo, workflow, sha, cache);
    const filter = text === null ? undefined : parsePushPathsFilter(text);
    if (filter && (filter.paths || filter.pathsIgnore)) {
      let current = sha;
      for (let depth = 0; depth < MAX_UNRUN_COMMITS; depth++) {
        const facts = await fetchCommitFacts(deps, repo, current, cache);
        if (!facts || !facts.paths || !facts.parent) break;
        if (pushStartsWorkflow(filter, facts.paths)) break;
        const parentRuns = await fetchRunList(deps, repo, { sha: facts.parent });
        if (!parentRuns.ok) break;
        if (parentRuns.runs.some((run) => run.workflow === workflow && matchesSha(run.headSha, facts.parent!))) {
          ignored = true;
          break;
        }
        current = facts.parent;
      }
    }
  } catch {
    ignored = false;
  }
  // Only a verdict of "ignored" is kept; a "not ignored" may be a failed lookup and is asked again on the next poll.
  if (ignored) cache.decisions.set(key, true);
  return ignored;
}

type FailureDetails = { failedJobs: string[]; logTail: string[]; error?: string };

async function fetchFailureDetails(
  deps: CiChainDeps,
  repo: string,
  run: NormalizedRun,
  cache: Map<string, FailureDetails>,
): Promise<FailureDetails> {
  // updatedAt changes when a run is re-attempted under the same databaseId, so a rerun is not served from an older attempt.
  const key = `${repo}#${run.runId}#${run.updatedAt}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const failedJobNames = new Set<string>();
  const failedJobIds: number[] = [];
  const errors: string[] = [];

  const jobs = await execGhJson<{ jobs?: unknown }>(
    deps,
    ["run", "view", String(run.runId), "--repo", repo, "--json", "jobs"],
    `gh run view ${run.runId} --json jobs`,
  );
  if (!jobs.ok) errors.push(jobs.error);
  else if (!Array.isArray(jobs.data?.jobs)) errors.push(`gh run view ${run.runId} --json jobs: jobs is not an array`);
  else {
    for (const item of jobs.data.jobs) {
      const job = (item ?? {}) as Record<string, unknown>;
      if (typeof job.conclusion !== "string" || !isFailedConclusion(job.conclusion)) continue;
      if (typeof job.name === "string" && job.name.trim()) failedJobNames.add(job.name.trim());
      if (typeof job.databaseId === "number") failedJobIds.push(job.databaseId);
    }
  }

  let logTail: string[] = [];
  try {
    const logRes = await deps.exec("gh", ["run", "view", String(run.runId), "--repo", repo, "--log-failed"], { cwd: deps.cwd, signal: deps.signal });
    if (!logRes.killed && logRes.code === 0 && logRes.stdout.trim()) {
      const lines = splitLogLines(logRes.stdout);
      logTail = lines.slice(-LOG_TAIL_LINES);
      if (failedJobNames.size === 0) {
        for (const name of extractTabJobNames(lines)) failedJobNames.add(name);
      }
    } else if (logRes.killed || logRes.code !== 0) {
      errors.push(`gh run view ${run.runId} --log-failed ${logRes.killed ? "was killed (timeout)" : `exit ${logRes.code}`}: ${logRes.stderr?.trim() || "no stderr"}`);
    } else if (failedJobIds.length === 0) {
      errors.push(`gh run view ${run.runId} --log-failed printed nothing and no failed job id is known for the job-log fallback`);
    } else {
      // Runs older than about a day: --log-failed prints nothing, but each job's log is still served by the jobs API.
      const lines: string[] = [];
      for (const jobId of failedJobIds) {
        const jobLog = await readJobLog(deps, repo, jobId);
        if ("text" in jobLog) lines.push(...splitLogLines(jobLog.text));
        else errors.push(`log fallback: ${jobLog.error}`);
      }
      logTail = lines.slice(-LOG_TAIL_LINES);
    }
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    errors.push(`failed log lookup for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const details: FailureDetails = { failedJobs: [...failedJobNames], logTail, ...(errors.length ? { error: errors.join("; ") } : {}) };
  cache.set(key, details);
  return details;
}

/**
 * Detects whether a `Publish public mirror` run log printed "nothing to publish".
 * GitHub Actions prints each `run:` script between `##[group]Run …` and `##[endgroup]` before running it, so lines in that
 * block are script source (echo, printf or anything else), not output, and are skipped.
 */
export function hasNothingToPublish(logText: string): boolean {
  let inScriptSource = false;
  for (const line of logText.split(/\r?\n/)) {
    if (line.includes("##[group]Run ")) {
      inScriptSource = true;
      continue;
    }
    if (inScriptSource) {
      if (line.includes("##[endgroup]")) inScriptSource = false;
      continue;
    }
    if (/nothing to publish/i.test(line)) return true;
  }
  return false;
}

type PublishLogCheck = { skipped: boolean } | { error: string };

/**
 * Reads the publish run's log for the "nothing to publish" line. `gh run view --log` prints nothing for runs older than about a day,
 * so an empty log falls back to each job's log through the jobs API; a log that still cannot be read is an error, not "changed".
 */
async function checkNothingToPublish(
  deps: CiChainDeps,
  repo: string,
  publishRun: NormalizedRun & { runId: number },
  cache: Map<string, PublishLogCheck>,
): Promise<PublishLogCheck> {
  const publishRunId = publishRun.runId;
  const key = `${repo}#${publishRunId}#${publishRun.updatedAt}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let result: PublishLogCheck;
  try {
    const res = await deps.exec(
      "gh",
      ["run", "view", String(publishRunId), "--repo", repo, "--log"],
      { cwd: deps.cwd, signal: deps.signal },
    );
    if (res.killed || res.code !== 0) {
      result = { error: `gh run view ${publishRunId} --log ${res.killed ? "was killed (timeout)" : `exit ${res.code}`}: ${res.stderr?.trim() || "no stderr"}` };
    } else if (res.stdout.trim()) {
      result = { skipped: hasNothingToPublish(res.stdout) };
    } else {
      result = await checkNothingToPublishByJobLogs(deps, repo, publishRunId);
    }
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    result = { error: `publish log lookup for run ${publishRunId} failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  cache.set(key, result);
  return result;
}

async function checkNothingToPublishByJobLogs(deps: CiChainDeps, repo: string, publishRunId: number): Promise<PublishLogCheck> {
  const label = `publish run ${publishRunId} (--log printed nothing)`;
  const jobs = await execGhJson<{ jobs?: Array<{ databaseId?: unknown }> }>(
    deps,
    ["run", "view", String(publishRunId), "--repo", repo, "--json", "jobs"],
    `${label} gh run view --json jobs`,
  );
  if (!jobs.ok) return { error: jobs.error };
  const jobIds = (Array.isArray(jobs.data?.jobs) ? jobs.data.jobs : [])
    .map((job) => job?.databaseId)
    .filter((id): id is number => typeof id === "number");
  if (jobIds.length === 0) return { error: `${label}: the run has no jobs` };
  // Read every job: one unreadable job must not hide another job's "nothing to publish", and is an error only if none says so.
  const unreadable: string[] = [];
  for (const jobId of jobIds) {
    const jobLog = await readJobLog(deps, repo, jobId);
    if ("error" in jobLog) {
      unreadable.push(jobLog.error);
      continue;
    }
    if (hasNothingToPublish(jobLog.text)) return { skipped: true };
  }
  return unreadable.length ? { error: `${label}: ${unreadable.join("; ")}` } : { skipped: false };
}

/** Reads one job's log through the jobs API; a failure of this job (exit, empty, kill or a thrown exec) never stops the caller's loop. */
async function readJobLog(deps: CiChainDeps, repo: string, jobId: number): Promise<{ text: string } | { error: string }> {
  try {
    const res = await deps.exec("gh", ["api", `repos/${repo}/actions/jobs/${jobId}/logs`], { cwd: deps.cwd, signal: deps.signal });
    if (!res.killed && res.code === 0 && res.stdout.trim()) return { text: res.stdout };
    return { error: `job ${jobId} log ${res.killed ? "was killed (timeout)" : res.code === 0 ? "printed nothing" : `exit ${res.code}`}` };
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return { error: `job ${jobId} log lookup failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

async function buildLegFromRun(
  deps: CiChainDeps,
  repo: string,
  workflow: string,
  matchedBy: "headSha" | "title",
  run: NormalizedRun | undefined,
  failureCache: Map<string, FailureDetails>,
): Promise<CiChainLegResult> {
  if (!run) {
    return {
      repo,
      workflow,
      runId: null,
      status: null,
      conclusion: null,
      url: null,
      matchedBy,
      state: "pending",
    };
  }
  const completed = run.status === "completed";
  const state: CiChainLegState = completed ? "completed" : "in_progress";
  const leg: CiChainLegResult = {
    repo,
    workflow,
    runId: run.runId,
    status: run.status,
    conclusion: run.conclusion,
    url: run.url,
    matchedBy,
    state,
  };
  if (completed && isFailedConclusion(run.conclusion)) {
    const { failedJobs, logTail, error } = await fetchFailureDetails(deps, repo, run, failureCache);
    leg.failedJobs = failedJobs;
    leg.logTail = logTail;
    if (error) leg.error = error;
  }
  return leg;
}

function isLegTerminal(leg: CiChainLegResult): boolean {
  return (
    leg.state === "completed" ||
    leg.state === "skipped-no-public-change" ||
    leg.state === "skipped-paths-ignored" ||
    leg.state === "error" ||
    leg.state === "not-found-within-bound"
  );
}

function isLegOk(leg: CiChainLegResult): boolean {
  if (leg.state === "skipped-no-public-change" || leg.state === "skipped-paths-ignored") return true;
  if (leg.state !== "completed") return false;
  return leg.conclusion === "success" || leg.conclusion === "skipped" || leg.conclusion === "neutral";
}

export function buildVerdict(repo: string, sha: string, legs: CiChainLegResult[]): string {
  const shortSha = sha.slice(0, 7);
  const allOk = legs.length > 0 && legs.every(isLegOk);
  const summary = legs
    .map((leg) => {
      const prefix = leg.repo === repo ? leg.workflow : `${leg.repo}:${leg.workflow}`;
      if (leg.state === "completed") {
        const idPart = leg.runId !== null ? `(${leg.runId})` : "";
        const failPart = leg.failedJobs?.length ? ` [failed: ${leg.failedJobs.join(", ")}]` : "";
        return `${prefix}=${leg.conclusion ?? "completed"}${idPart}${failPart}`;
      }
      if (leg.state === "in_progress") {
        const idPart = leg.runId !== null ? `(${leg.runId})` : "";
        return `${prefix}=in_progress${idPart}`;
      }
      if (leg.state === "error" && leg.error) {
        return `${prefix}=error(${leg.error})`;
      }
      return `${prefix}=${leg.state}`;
    })
    .join(", ");
  return `ci_chain ${allOk ? "ok" : "incomplete/failed"} (${repo}@${shortSha}): ${summary || "no workflows"}`;
}

export function formatCiChainResult(result: CiChainResult): string {
  return `${result.verdict}\n${JSON.stringify(result, null, 2)}`;
}

const defaultDeps = (cwd: string, exec: Exec, signal?: AbortSignal): CiChainDeps => ({
  exec,
  cwd,
  signal,
  now: () => Date.now(),
  sleep: (ms, sig) => {
    if (ms <= 0 || sig?.aborted) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      sig?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    sig?.addEventListener("abort", onAbort, { once: true });
    return promise;
  },
});

export async function runCiChain(
  params: CiChainParams,
  depsInput: Partial<CiChainDeps> & { exec: Exec },
): Promise<CiChainResult> {
  const base: CiChainDeps = {
    ...defaultDeps(depsInput.cwd ?? process.cwd(), depsInput.exec, depsInput.signal),
    ...depsInput,
  };
  // A hung gh call must not hold the tool past its bound: every call gets a timeout unless the caller set one.
  const deps: CiChainDeps = { ...base, exec: (command, args, options) => base.exec(command, args, { timeout: GH_TIMEOUT_MS, ...options }) };

  const repo = (params.repo ?? "").trim();
  const sha = (params.sha ?? "").trim();
  const workflows = filterRequestedWorkflows(params.workflows ?? []);
  const mirror = params.mirror
    ? {
        repo: params.mirror.repo.trim(),
        workflows: filterRequestedWorkflows(params.mirror.workflows ?? []),
        title: params.mirror.title?.trim() || undefined,
      }
    : undefined;

  const waitSeconds = Math.max(
    0,
    Math.min(MAX_WAIT_SECONDS, Number.isFinite(params.waitSeconds) ? Number(params.waitSeconds) : DEFAULT_WAIT_SECONDS),
  );
  const pollSeconds =
    params.pollSeconds !== undefined && Number.isFinite(params.pollSeconds) && params.pollSeconds > 0
      ? Math.min(MAX_POLL_SECONDS, Number(params.pollSeconds))
      : DEFAULT_POLL_SECONDS;

  const startMs = deps.now();
  const waitBoundMs = waitSeconds * 1000;
  let virtualElapsedMs = 0;
  let polls = 0;
  let effectiveSha = sha;
  let cachedMirrorTitle: string | undefined = mirror?.title;
  const failureCache = new Map<string, FailureDetails>();
  const publishLogCache = new Map<string, PublishLogCheck>();
  const pathsCache: PathsIgnoredCache = { decisions: new Map(), commits: new Map() };

  let legs: CiChainLegResult[] = [];

  while (true) {
    polls++;
    const currentLegs: CiChainLegResult[] = [];

    // 1. Query private / source repository runs for SHA
    let privateList = await fetchRunList(deps, repo, { sha: effectiveSha });
    if (
      privateList.ok &&
      privateList.runs.length === 0 &&
      effectiveSha.length < 40 &&
      /^[0-9a-f]{7,39}$/i.test(effectiveSha)
    ) {
      // `gh run list --commit` does not match an abbreviated SHA, so it must be resolved; a failed lookup is an error, not "no runs".
      const commitInfo = await fetchCommitInfo(deps, repo, effectiveSha);
      if (!commitInfo.ok) {
        privateList = { ok: false, error: commitInfo.error };
      } else {
        if (!cachedMirrorTitle) cachedMirrorTitle = commitInfo.subject;
        if (commitInfo.fullSha && commitInfo.fullSha.toLowerCase() !== effectiveSha.toLowerCase()) {
          effectiveSha = commitInfo.fullSha;
          privateList = await fetchRunList(deps, repo, { sha: effectiveSha });
        }
      }
    }

    if (!privateList.ok) {
      for (const wf of workflows) {
        currentLegs.push({
          repo,
          workflow: wf,
          runId: null,
          status: null,
          conclusion: null,
          url: null,
          matchedBy: "headSha",
          state: "error",
          error: privateList.error,
        });
      }
    } else {
      const shaRuns = privateList.runs.filter(
        (r) => matchesSha(r.headSha, effectiveSha) || matchesSha(r.headSha, sha),
      );
      for (const wf of workflows) {
        const wfRuns = shaRuns.filter((r) => r.workflow === wf);
        const chosen = pickNewestRun(wfRuns);
        const unknown = chosen ? undefined : await unknownWorkflowError(deps, repo, wf, pathsCache);
        if (unknown) {
          currentLegs.push({ repo, workflow: wf, runId: null, status: null, conclusion: null, url: null, matchedBy: "headSha", state: "error", error: unknown });
        } else if (!chosen && (await isPushPathsIgnored(deps, repo, wf, effectiveSha, pathsCache))) {
          currentLegs.push({ repo, workflow: wf, runId: null, status: null, conclusion: null, url: null, matchedBy: "headSha", state: "skipped-paths-ignored" });
        } else {
          currentLegs.push(await buildLegFromRun(deps, repo, wf, "headSha", chosen, failureCache));
        }
      }
    }

    // 2. Query mirror repository runs if configured
    if (mirror && mirror.workflows.length > 0) {
      if (!privateList.ok) {
        for (const wf of mirror.workflows) {
          currentLegs.push({
            repo: mirror.repo,
            workflow: wf,
            runId: null,
            status: null,
            conclusion: null,
            url: null,
            matchedBy: "title",
            state: "error",
            error: privateList.error,
          });
        }
      } else {
        const shaRuns = privateList.runs.filter(
          (r) => matchesSha(r.headSha, effectiveSha) || matchesSha(r.headSha, sha),
        );
        // The publish run is the anchor for mirror matching: without it a same-title mirror run of another commit could be taken.
        const publishRun = pickNewestRun(shaRuns.filter((r) => r.workflow === PUBLISH_MIRROR_WORKFLOW));

        let skippedNoPublicChange = false;
        let skippedPathsIgnored = false;
        let canQueryMirror = true;
        // A mirror run can never follow a publish run that did not succeed; finish those legs instead of waiting out the bound.
        let mirrorBlockedError: string | undefined;

        if (!publishRun || publishRun.runId === null) {
          canQueryMirror = false;
          // No publish run because the push touched only files the publish workflow ignores: nothing reached the mirror.
          skippedPathsIgnored = !publishRun && (await isPushPathsIgnored(deps, repo, PUBLISH_MIRROR_WORKFLOW, effectiveSha, pathsCache));
        } else if (publishRun.status !== "completed") {
          canQueryMirror = false;
        } else if (publishRun.conclusion !== "success") {
          canQueryMirror = false;
          mirrorBlockedError = `publish run ${publishRun.runId} concluded ${publishRun.conclusion ?? "without a conclusion"}; no mirror run will follow`;
        } else {
          const logCheck = await checkNothingToPublish(deps, repo, { ...publishRun, runId: publishRun.runId }, publishLogCache);
          if ("error" in logCheck) {
            canQueryMirror = false;
            mirrorBlockedError = logCheck.error;
          } else if (logCheck.skipped) {
            skippedNoPublicChange = true;
            canQueryMirror = false;
          }
        }

        if (skippedNoPublicChange || skippedPathsIgnored) {
          for (const wf of mirror.workflows) {
            currentLegs.push({
              repo: mirror.repo,
              workflow: wf,
              runId: null,
              status: null,
              conclusion: null,
              url: null,
              matchedBy: "title",
              state: skippedNoPublicChange ? "skipped-no-public-change" : "skipped-paths-ignored",
            });
          }
        } else if (mirrorBlockedError) {
          for (const wf of mirror.workflows) {
            currentLegs.push({
              repo: mirror.repo,
              workflow: wf,
              runId: null,
              status: null,
              conclusion: null,
              url: null,
              matchedBy: "title",
              state: "error",
              error: mirrorBlockedError,
            });
          }
        } else if (!canQueryMirror) {
          for (const wf of mirror.workflows) {
            currentLegs.push({
              repo: mirror.repo,
              workflow: wf,
              runId: null,
              status: null,
              conclusion: null,
              url: null,
              matchedBy: "title",
              state: "pending",
            });
          }
        } else {
          let titleError: string | undefined;
          if (!cachedMirrorTitle) {
            const commitInfo = await fetchCommitInfo(deps, repo, effectiveSha);
            if (!commitInfo.ok) {
              titleError = commitInfo.error;
            } else {
              cachedMirrorTitle = commitInfo.subject;
            }
          }

          if (titleError || !cachedMirrorTitle) {
            for (const wf of mirror.workflows) {
              currentLegs.push({
                repo: mirror.repo,
                workflow: wf,
                runId: null,
                status: null,
                conclusion: null,
                url: null,
                matchedBy: "title",
                state: "error",
                error: titleError ?? "Unable to determine mirror commit title",
              });
            }
          } else {
            // Anchor on the publish run's createdAt. Its run-level startedAt equals createdAt on every one of the last 60 publish runs, and on a
            // re-run it would move past the first attempt's mirror push, so it is no better bound.
            const anchorTime = publishRun!.createdAt;
            const baselineTime = Date.parse(anchorTime);
            for (const wf of mirror.workflows) {
              // Query each workflow from the publish time on, so older or unrelated runs cannot push the match out of the page.
              const mirrorList = await fetchRunList(deps, mirror.repo, { workflow: wf, createdSince: anchorTime });
              if (!mirrorList.ok) {
                currentLegs.push({
                  repo: mirror.repo,
                  workflow: wf,
                  runId: null,
                  status: null,
                  conclusion: null,
                  url: null,
                  matchedBy: "title",
                  state: "error",
                  error: mirrorList.error,
                });
                continue;
              }
              // The earliest same-title run at or after the publish run is this commit's; a later commit with the same subject comes after it.
              const chosen = mirrorList.runs
                .filter((r) => r.workflow === wf && matchesRunTitle(r.displayTitle, cachedMirrorTitle!) && Date.parse(r.createdAt) >= baselineTime)
                .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.runId! - b.runId!)[0];
              // The list is newest first: on a full page the oldest runs, where this commit's run sits, may be cut off, so no pick is safe.
              if (mirrorList.pageFull) {
                currentLegs.push({
                  repo: mirror.repo,
                  workflow: wf,
                  runId: null,
                  status: null,
                  conclusion: null,
                  url: null,
                  matchedBy: "title",
                  state: "error",
                  error: `${mirror.repo} ${wf}: ${RUN_LIST_LIMIT} or more runs since the publish run; the earliest match may be past the page`,
                });
                continue;
              }
              currentLegs.push(await buildLegFromRun(deps, mirror.repo, wf, "title", chosen, failureCache));
            }
          }
        }
      }
    }

    legs = currentLegs;

    if (legs.every(isLegTerminal)) {
      break;
    }

    if (waitSeconds <= 0) {
      break;
    }

    const realElapsedMs = Math.max(0, deps.now() - startMs);
    const effectiveElapsedMs = Math.max(realElapsedMs, virtualElapsedMs);
    const remainingMs = waitBoundMs - effectiveElapsedMs;

    if (remainingMs <= 0 || deps.signal?.aborted) {
      if (remainingMs <= 0) {
        legs = legs.map((leg) =>
          leg.state === "pending" ? { ...leg, state: "not-found-within-bound" } : leg,
        );
      }
      break;
    }

    const sleepMs = Math.min(pollSeconds * 1000, remainingMs);
    const beforeSleep = deps.now();
    await deps.sleep(sleepMs, deps.signal);
    const afterSleep = deps.now();
    virtualElapsedMs += Math.max(0, afterSleep - beforeSleep, sleepMs);

    if (deps.signal?.aborted) {
      break;
    }
  }

  const elapsedMs = Math.max(0, deps.now() - startMs, virtualElapsedMs);
  const ok = legs.length > 0 && legs.every(isLegOk);
  const verdict = buildVerdict(repo, sha, legs);

  return {
    ok,
    repo,
    sha,
    ...(mirror ? { mirrorTitle: cachedMirrorTitle ?? null } : {}),
    verdict,
    legs,
    polls,
    elapsedMs,
  };
}

const factory: CustomToolFactory = (pi) => ({
  name: "ci_chain",
  label: "CI Chain",
  loadMode: "essential",
  description:
    "Read-only GitHub Actions CI chain status checker for a commit SHA and its optional public mirror repository. "
    + "Matches source repository runs by headSha for an explicit workflow list (never waits on 'Publish CUELO web release'), "
    + "detects 'nothing to publish' in 'Publish public mirror' logs (reporting mirror legs as skipped-no-public-change), "
    + "reports a workflow with no run for the commit as skipped-paths-ignored when every file the commit changed matches the workflow's push paths-ignore/paths filter, "
    + "ends a source workflow name the repository does not have (a job or step name is not one) as an error listing its real workflows instead of waiting, "
    + "and matches mirror repository runs by commit title created at or after the private publish run. "
    + "On failure, reports failed job names and the last 40 lines of --log-failed.",
  parameters: pi.zod.object({
    repo: pi.zod.string().describe("Source GitHub repository (owner/name), e.g. gim47656-ship-it/CUELO-private"),
    sha: pi.zod.string().describe("Commit SHA in the source repository"),
    workflows: pi.zod
      .array(pi.zod.string())
      .describe("Explicit workflow names to inspect on the source repository, e.g. [\"CI\", \"Publish public mirror\"]"),
    mirror: pi.zod
      .object({
        repo: pi.zod.string().describe("Public mirror GitHub repository (owner/name), e.g. gim47656-ship-it/CUELO"),
        workflows: pi.zod.array(pi.zod.string()).describe("Explicit workflow names on the mirror repository, e.g. [\"CI\"]"),
        title: pi.zod
          .string()
          .optional()
          .describe("Commit subject line to match mirror displayTitle; derived via gh api repos/<repo>/commits/<sha> when omitted"),
      })
      .optional()
      .describe("Optional public mirror repository configuration"),
    waitSeconds: pi.zod
      .number()
      .optional()
      .describe("Maximum seconds to poll until all legs finish (default 0 = single snapshot, max 1800)"),
    pollSeconds: pi.zod
      .number()
      .optional()
      .describe("Polling interval in seconds when waitSeconds > 0 (default 15)"),
  }),

  async execute(_toolCallId, params, onUpdate, _ctx, signal) {
    const exec: Exec = (command, args, options) =>
      pi.exec(command, args, { cwd: options.cwd, timeout: options.timeout, signal: options.signal ?? signal });
    onUpdate?.({
      content: [{ type: "text", text: `Checking CI chain for ${params.repo}@${String(params.sha).slice(0, 7)}...` }],
      details: { phase: "poll", repo: params.repo, sha: params.sha },
    });
    const result = await runCiChain(params as CiChainParams, defaultDeps(pi.cwd, exec, signal));
    return {
      content: [{ type: "text", text: formatCiChainResult(result) }],
      details: result,
    };
  },
});

export default factory;
