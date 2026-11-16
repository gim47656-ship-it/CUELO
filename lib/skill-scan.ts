import { execFile } from "child_process";
import { createHash } from "crypto";
import { constants } from "fs";
import { access, cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from "fs/promises";
import { homedir, tmpdir } from "os";
import { basename, delimiter, dirname, join, resolve, sep } from "path";
import { promisify } from "util";
import type {
  SkillInstallScope,
  SkillScanIssue,
  SkillScanReason,
  SkillScanSummary,
} from "@/lib/api-types";
import { getSafeNpxEnv, redactNpxOutput, runNpx } from "@/lib/npx";
import { getGlobalSkillsLockPath } from "@/lib/skill-lock";

const execFileAsync = promisify(execFile);

/** Whole scan budget for one install or update request, across every staged skill. */
export const SKILL_SCAN_BUDGET_MS = 180_000;
const STAGE_TIMEOUT_MS = 60_000;
const MAX_SUMMARY_ISSUES = 5;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ANSI_RE = /\x1B\[[0-9;]*m/g;
const SEVERITY_RANK: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2, INFO: 1 };

// ── Result classification ────────────────────────────────────────────────

export type SkillScanItem =
  | { status: "safe"; score: number; recommendation: "SAFE"; issues: SkillScanIssue[] }
  | { status: "risk"; score?: number; recommendation: string; issues: SkillScanIssue[] }
  | { status: "incomplete" | "unavailable"; reason: SkillScanReason; score?: number; recommendation?: string; issues: SkillScanIssue[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pickIssues(report: Record<string, unknown>): SkillScanIssue[] {
  const raw = Array.isArray(report.issues) ? report.issues : [];
  const issues: SkillScanIssue[] = [];
  for (const entry of raw) {
    const issue = asRecord(entry);
    if (!issue) continue;
    const location = asRecord(issue.location);
    const file = typeof location?.file === "string" ? location.file : "";
    const line = typeof location?.start_line === "number" ? `:${location.start_line}` : "";
    const ruleId = redactNpxOutput(String(issue.rule_id ?? issue.id ?? ""));
    // `pattern` is the scanner's own rule title; the matched content (`finding`) is untrusted skill text and stays out.
    const message = redactNpxOutput(String(issue.pattern ?? issue.category ?? "")).slice(0, 160);
    issues.push({
      ruleId,
      severity: typeof issue.severity === "string" ? redactNpxOutput(issue.severity.toUpperCase()) : "",
      file: file ? redactNpxOutput(`${file}${line}`) : "",
      message,
    });
  }
  const seen = new Set<string>();
  return issues
    .filter((issue) => {
      const key = `${issue.ruleId}|${issue.file}|${issue.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => (SEVERITY_RANK[b.issue.severity] ?? 0) - (SEVERITY_RANK[a.issue.severity] ?? 0) || a.index - b.index)
    .slice(0, MAX_SUMMARY_ISSUES)
    .map(({ issue }) => issue);
}

/**
 * Turn one `skillspector scan --format json` run into a verdict.
 * A skill passes only when the recommendation is SAFE, the exit code is 0 and the
 * analysis completed (complete or complete_with_caveats).
 */
export function classifySkillScanReport(exitCode: number, reportText: string | undefined): SkillScanItem {
  if (exitCode !== 0 && exitCode !== 1) {
    return { status: "incomplete", reason: "scan-failed", issues: [] };
  }
  let report: Record<string, unknown> | undefined;
  try {
    report = asRecord(JSON.parse(reportText ?? ""));
  } catch {
    report = undefined;
  }
  const assessment = asRecord(report?.risk_assessment);
  const recommendation = assessment?.recommendation;
  if (!report || typeof recommendation !== "string" || !["SAFE", "CAUTION", "DO_NOT_INSTALL"].includes(recommendation)) {
    return { status: "incomplete", reason: "unreadable-report", issues: [] };
  }
  const score = typeof assessment?.score === "number" ? assessment.score : undefined;
  const issues = pickIssues(report);
  if (recommendation !== "SAFE" || exitCode !== 0) {
    return { status: "risk", score, recommendation, issues };
  }
  const completeness = asRecord(report.analysis_completeness)?.status;
  if (completeness !== "complete" && completeness !== "complete_with_caveats") {
    return { status: "incomplete", reason: "partial-analysis", score, recommendation, issues };
  }
  return { status: "safe", score: score ?? 0, recommendation: "SAFE", issues };
}

/** `undefined`: not a confirmation. `null`: `confirmed` without a valid `scanned` value. Otherwise the scanned hash. */
export function parseConfirmedScan(confirmed: unknown, scanned: unknown): string | undefined | null {
  if (confirmed !== true) return undefined;
  return typeof scanned === "string" && /^[a-f0-9]{64}$/.test(scanned) ? scanned : null;
}

const WORST_ORDER: Record<SkillScanItem["status"], number> = { safe: 0, unavailable: 1, incomplete: 2, risk: 3 };

/** The worst result decides. Returns null only when every skill passed. */
export function worstSkillScan(results: { name: string; item: SkillScanItem }[]): SkillScanSummary | null {
  const failing = results.filter((entry) => entry.item.status !== "safe");
  if (failing.length === 0) return null;
  const top = Math.max(...failing.map((entry) => WORST_ORDER[entry.item.status]));
  const worst = failing.filter((entry) => WORST_ORDER[entry.item.status] === top);
  const lead = worst.reduce((best, entry) => ((entry.item.score ?? -1) > (best.item.score ?? -1) ? entry : best), worst[0]);
  const prefix = results.length > 1;
  const issues = worst
    .flatMap(({ name, item }) => item.issues.map((issue) => ({ ...issue, file: prefix ? `${name}/${issue.file}` : issue.file })))
    .map((issue, index) => ({ issue, index }))
    .sort((a, b) => (SEVERITY_RANK[b.issue.severity] ?? 0) - (SEVERITY_RANK[a.issue.severity] ?? 0) || a.index - b.index)
    .slice(0, MAX_SUMMARY_ISSUES)
    .map(({ issue }) => issue);
  const item = lead.item;
  return {
    status: item.status === "safe" ? "incomplete" : item.status,
    score: item.score,
    recommendation: item.recommendation,
    reason: "reason" in item ? item.reason : undefined,
    issues,
  };
}

// ── Scanner invocation ───────────────────────────────────────────────────

interface BinaryLookup {
  env?: { PATH?: string };
  home?: string;
}

/** PATH first, then `$HOME/.local/bin` (the server may run without it on PATH). */
export async function findSkillspector({ env = { PATH: process.env.PATH }, home = homedir() }: BinaryLookup = {}): Promise<string | null> {
  const names = process.platform === "win32" ? ["skillspector.exe", "skillspector.cmd", "skillspector"] : ["skillspector"];
  const dirs = [...(env.PATH ?? "").split(delimiter).filter(Boolean), join(home, ".local", "bin")];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        await access(candidate, constants.X_OK);
        if ((await lstat(candidate)).isDirectory()) continue;
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface SkillFolder {
  name: string;
  dir: string;
}

export interface ScanOptions extends BinaryLookup {
  budgetMs?: number;
}

export type SkillScanOutcome =
  | { passed: true }
  | { passed: false; summary: SkillScanSummary };

async function scanFolder(binary: string, folder: SkillFolder, reportFile: string, deadline: number, env: NodeJS.ProcessEnv): Promise<SkillScanItem> {
  const remaining = deadline - Date.now();
  if (remaining < 1000) return { status: "incomplete", reason: "timed-out", issues: [] };
  let exitCode = 0;
  try {
    await execFileAsync(binary, ["scan", folder.dir, "--no-llm", "--format", "json", "--output", reportFile], {
      timeout: remaining,
      killSignal: "SIGKILL",
      env,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; signal?: string | null };
    if (failure.killed || failure.signal) return { status: "incomplete", reason: "timed-out", issues: [] };
    if (failure.code === "ENOENT" || failure.code === "EACCES") return { status: "unavailable", reason: "not-installed", issues: [] };
    exitCode = typeof failure.code === "number" ? failure.code : -1;
  }
  const text = await readFile(reportFile, "utf8").catch(() => undefined);
  return classifySkillScanReport(exitCode, text);
}

/** Scan every staged skill folder with SkillSpector (static analysis only, no LLM) within one shared budget. */
export async function scanSkillFolders(folders: SkillFolder[], options: ScanOptions = {}): Promise<SkillScanOutcome> {
  const binary = await findSkillspector(options);
  if (!binary) {
    return { passed: false, summary: { status: "unavailable", reason: "not-installed", issues: [] } };
  }
  const deadline = Date.now() + (options.budgetMs ?? SKILL_SCAN_BUDGET_MS);
  const reportDir = await mkdtemp(join(tmpdir(), "cuelo-skill-report-"));
  try {
    const env = getSafeNpxEnv({ NO_COLOR: "1" });
    const results = await Promise.all(
      folders.map(async (folder, index) => ({
        name: folder.name,
        item: await scanFolder(binary, folder, join(reportDir, `${index}.json`), deadline, env),
      })),
    );
    const summary = worstSkillScan(results);
    return summary ? { passed: false, summary } : { passed: true };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}

// ── Content hash ─────────────────────────────────────────────────────────

async function folderEntries(root: string, rel: string, lines: string[]): Promise<void> {
  const entries = await readdir(join(root, rel), { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    const full = join(root, path);
    if (entry.isSymbolicLink()) {
      const target = await readlink(full);
      // Every link must resolve inside the skill folder; effective content outside it is not part of the hash.
      const resolved = await realpath(full).catch(() => null);
      const rootReal = await realpath(root);
      if (!resolved || (resolved !== rootReal && !resolved.startsWith(rootReal + sep))) {
        throw new GateError(500, `The skill contains a link that points outside its folder: ${path}`);
      }
      lines.push(JSON.stringify(["L", path, target]));
    } else if (entry.isDirectory()) {
      lines.push(JSON.stringify(["D", path]));
      await folderEntries(root, path, lines);
    } else if (entry.isFile()) {
      lines.push(JSON.stringify(["F", path, createHash("sha256").update(await readFile(full)).digest("hex")]));
    }
  }
}

/** One hash over the paths and bytes of every skill folder, independent of where the folders live. */
export async function hashSkillFolders(folders: SkillFolder[]): Promise<string> {
  const lines: string[] = [];
  for (const folder of [...folders].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    lines.push(JSON.stringify(["S", folder.name]));
    await folderEntries(folder.dir, "", lines);
  }
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ── Stage, scan, apply ───────────────────────────────────────────────────

export interface SkillGateInput {
  /** `skills add ...` arguments without `--json`. */
  args: string[];
  scope: SkillInstallScope;
  /** Project folder; required for project scope. */
  cwd: string;
  /** `scanned` value returned by an earlier needs-confirmation response. */
  confirmedScan?: string;
}

export type SkillGateOutcome =
  | { kind: "installed"; output: string }
  | { kind: "confirm"; scanned: string; scan: SkillScanSummary }
  | { kind: "error"; status: number; message: string };

class GateError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

interface CliItem {
  status?: unknown;
  name?: unknown;
  path?: unknown;
  error?: unknown;
  reason?: unknown;
}

function tidy(text: string, limit = 1000): string {
  return redactNpxOutput(text).replace(ANSI_RE, "").trim().slice(-limit);
}

function parseCliItems(stdout: string): CliItem[] {
  const text = stdout.trim();
  for (const candidate of [text, text.slice(text.lastIndexOf("\n[") + 1)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed.filter((item): item is CliItem => !!asRecord(item));
    } catch {
      // try the next candidate
    }
  }
  return [];
}

function cliFailure(error: unknown, fallback: string): GateError {
  const detail = error as { stdout?: string; stderr?: string };
  const reported = parseCliItems(detail.stdout ?? "").find((item) => typeof item.error === "string" || typeof item.reason === "string");
  const message = reported ? String(reported.error ?? reported.reason) : `${detail.stdout ?? ""}${detail.stderr ?? ""}`;
  return new GateError(500, tidy(message) || fallback);
}

function stagingEnv(root: string): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const overrides: Record<string, string | undefined> = {
    FORCE_COLOR: "0",
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_TERMINAL_PROMPT: "0",
    // Keep the real npm cache so staging does not redownload the skills CLI.
    npm_config_cache: process.env.npm_config_cache
      ?? (process.platform === "win32"
        ? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "npm-cache") : undefined)
        : join(homedir(), ".npm")),
  };
  const env = getSafeNpxEnv(overrides);
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/** Install target folders for the staged skill names, mirroring where the skills CLI writes for claude-code. */
function installTargets(names: string[], scope: SkillInstallScope, cwd: string): SkillFolder[] {
  const base = scope === "global"
    ? join(process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude"), "skills")
    : join(cwd, ".claude", "skills");
  return names.map((name) => ({ name, dir: join(base, name) }));
}

async function stage(input: SkillGateInput, root: string): Promise<SkillFolder[]> {
  const projectDir = join(root, "project");
  await mkdir(projectDir, { recursive: true });
  await mkdir(join(root, "home"), { recursive: true });
  let stdout: string;
  try {
    ({ stdout } = await runNpx([...input.args, "--json"], {
      timeout: STAGE_TIMEOUT_MS,
      cwd: projectDir,
      env: stagingEnv(root),
    }));
  } catch (error) {
    throw cliFailure(error, "Could not fetch the skill package");
  }
  const items = parseCliItems(stdout);
  const failed = items.find((item) => item.status !== "installed");
  if (items.length === 0 || failed) {
    const detail = failed ? String(failed.error ?? failed.reason ?? "") : "";
    throw new GateError(500, tidy(detail) || "Could not fetch the skill package");
  }
  const rootPrefixes = [resolve(root), await realpath(root)].map((path) => path + sep);
  return items.map((item) => {
    const dir = typeof item.path === "string" ? resolve(item.path) : "";
    const name = typeof item.name === "string" ? item.name : "";
    if (!rootPrefixes.some((prefix) => dir.startsWith(prefix)) || !SAFE_NAME_RE.test(name) || basename(dir) !== name) {
      throw new GateError(500, "The skills CLI reported an unexpected install location");
    }
    return { name, dir };
  });
}

let applyQueue: Promise<unknown> = Promise.resolve();
/** One apply at a time: snapshots, the shared lock file and rollback must not interleave across requests. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = applyQueue.then(task, task);
  applyQueue = run.catch(() => undefined);
  return run;
}

async function apply(input: SkillGateInput, staged: SkillFolder[], scanned: string): Promise<string> {
  const targets = installTargets(staged.map((folder) => folder.name), input.scope, input.cwd);
  const baseDir = dirname(targets[0].dir);
  const lockPath = input.scope === "global" ? getGlobalSkillsLockPath() : join(input.cwd, "skills-lock.json");
  const backup = await mkdtemp(join(tmpdir(), "cuelo-skill-backup-"));
  let keepBackup = false;
  try {
    // Snapshot the whole skills folder, not just the staged names: a misbehaving CLI run may touch more than that.
    for (const path of [baseDir, ...targets.map((target) => target.dir)]) {
      if ((await lstat(path).catch(() => null))?.isSymbolicLink()) {
        throw new GateError(409, `${basename(path)} is a link; replace it with a regular folder and try again`);
      }
    }
    const baseInfo = await lstat(baseDir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new GateError(500, "Cannot inspect the skills folder; nothing was changed");
    });
    const hadBase = baseInfo !== null;
    if (hadBase) {
      try {
        await cp(baseDir, join(backup, "base"), { recursive: true, verbatimSymlinks: true });
      } catch {
        throw new GateError(500, "Cannot back up the skills folder; nothing was changed");
      }
    }
    let lockBefore: Buffer | null = null;
    try {
      lockBefore = await readFile(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new GateError(500, "Cannot read the skills lock file; nothing was changed");
      }
    }
    try {
      let stdout: string;
      try {
        ({ stdout } = await runNpx([...input.args, "--json"], {
          timeout: STAGE_TIMEOUT_MS,
          cwd: input.scope === "project" ? input.cwd : undefined,
          env: getSafeNpxEnv({ FORCE_COLOR: "0" }),
        }));
      } catch (error) {
        throw cliFailure(error, "Install failed");
      }
      const real = (path: string) => realpath(path).catch(() => resolve(path));
      const reported = await Promise.all(
        parseCliItems(stdout)
          .filter((item) => item.status === "installed")
          .map((item) => (typeof item.path === "string" ? real(item.path) : "")),
      );
      const expected = await Promise.all(targets.map((target) => real(target.dir)));
      if (reported.length !== expected.length || expected.some((path) => !reported.includes(path))) {
        throw new GateError(500, "The skills CLI installed to an unexpected location; nothing was kept");
      }
      if ((await hashSkillFolders(targets)) !== scanned) {
        throw new GateError(409, "The installed content differs from the scanned content; nothing was kept. Try again.");
      }
      return `Installed ${targets.map((target) => target.name).join(", ")}`;
    } catch (error) {
      try {
        await rm(baseDir, { recursive: true, force: true });
        if (hadBase) await cp(join(backup, "base"), baseDir, { recursive: true, verbatimSymlinks: true });
        if (lockBefore) await writeFile(lockPath, lockBefore);
        else await rm(lockPath, { force: true });
      } catch {
        keepBackup = true;
        throw new GateError(500, `Install failed and the previous state could not be fully restored; the original folder is kept at ${join(backup, "base")}`);
      }
      throw error;
    }
  } finally {
    if (!keepBackup) await rm(backup, { recursive: true, force: true });
  }
}

/**
 * Stage the package in a scratch HOME, scan every staged skill, and only then write
 * to the real skill folders. Without `confirmedScan` anything that is not a clean SAFE
 * result stops with a confirmation request; with it the content is re-fetched, must
 * hash to the same value, and is applied without a rescan.
 */
export async function runSkillGate(input: SkillGateInput, options: ScanOptions = {}): Promise<SkillGateOutcome> {
  const root = await mkdtemp(join(tmpdir(), "cuelo-skill-stage-"));
  try {
    const staged = await stage(input, root);
    const scanned = await hashSkillFolders(staged);
    if (input.confirmedScan !== undefined) {
      if (scanned !== input.confirmedScan) {
        throw new GateError(409, "The skill content changed since it was checked. Run the check again.");
      }
    } else {
      const outcome = await scanSkillFolders(staged, options);
      if (!outcome.passed) return { kind: "confirm", scanned, scan: outcome.summary };
    }
    return { kind: "installed", output: await serialized(() => apply(input, staged, scanned)) };
  } catch (error) {
    if (error instanceof GateError) return { kind: "error", status: error.status, message: error.message };
    throw error;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
