import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * computer_task: hand ONE multi-step desktop goal to a child omp session that runs on `modelRoles.computer`
 * (2026-10-27 user decision, evidence doc/history/2026/10/27-terra-sol-eval/computer) and return what it observed.
 * The child only gets eval (the `computer` global), read, bash and windows_control; it never gets computer_task
 * (tool allow-list plus the CHILD_ENV guard), so it cannot recurse.
 */

/** Set in the child's environment; the tool refuses to run when it is present. */
export const CHILD_ENV = "CUELO_COMPUTER_TASK_CHILD";
export const COMPUTER_ROLE = "computer";
export const CHILD_TOOLS = "eval,read,bash,windows_control";
export const DEFAULT_TIMEOUT_SEC = 600;
const MIN_TIMEOUT_SEC = 10;
const MAX_TIMEOUT_SEC = 1800;
/** After SIGTERM the child gets this long before SIGKILL. */
const KILL_GRACE_MS = 5_000;
const STDERR_TAIL_BYTES = 4_000;
const RAW_TAIL_CHARS = 1_500;

export interface ComputerTaskInput { goal: string; target: string; done: string; timeoutSec?: number }
export interface SpawnRequest { exe: string; args: string[]; cwd: string; env: Record<string, string | undefined>; signal: AbortSignal; timeoutMs: number }
export interface SpawnOutcome { exitCode: number | null; timedOut: boolean; aborted: boolean; stderr: string }
/** Injectable so tests never launch a real process. `onLine` receives each stdout line as it arrives. */
export type Spawner = (request: SpawnRequest, onLine: (line: string) => void) => Promise<SpawnOutcome>;
export interface ComputerTaskDeps {
  /** `modelRoles.computer` as configured, e.g. `openai-codex/gpt-6.1-terra:high`. */
  selector: string | undefined;
  /** Path of the omp executable (`OMP_EXE`). */
  exe: string | undefined;
  /** Environment handed to the child, plus CHILD_ENV. */
  env: Record<string, string | undefined>;
  spawn: Spawner;
  /** Parent of the per-call scratch cwd. Defaults to the OS temp dir. */
  scratchRoot?: string;
}
export interface ComputerTaskStats { model: string; wallSec: number; toolCalls: number; toolErrors: number }
export interface ComputerTaskResult { done: boolean; isError: boolean; text: string; stats: ComputerTaskStats }
export interface Verdict { done: boolean; observed: string; issues: string }

const THINKING_SUFFIX = /:(auto|inherit|off|minimal|low|medium|high|xhigh|max)$/u;

/** Splits `provider/model[:thinking]`. Undefined when it is not a provider/model selector. */
export function parseSelector(selector: string | undefined): { model: string; thinking: string | undefined } | undefined {
  const value = selector?.trim();
  if (!value) return undefined;
  const thinking = THINKING_SUFFIX.exec(value)?.[1];
  const model = thinking ? value.slice(0, -(thinking.length + 1)) : value;
  return /^[^\s/]+\/\S+$/u.test(model) ? { model, thinking } : undefined;
}

export function buildPrompt(input: ComputerTaskInput): string {
  return [
    "You are a desktop-operation worker. Achieve exactly ONE goal on the host Windows desktop, using the `computer` global inside `eval` (read `xd://eval/computer` once first) or the `windows_control` tool, then report only what you observed.",
    "",
    `Goal: ${input.goal.trim()}`,
    `Target (the only window or app you may touch): ${input.target.trim()}`,
    `Done when (verify this by reading it back after acting): ${input.done.trim()}`,
    "",
    "Rules:",
    "- Touch only the target above, or a window you launched yourself for it. Never touch other windows, the user's foreground window or any other process.",
    "- Never press irreversible buttons (delete, send, pay, accept terms, save over or overwrite existing user files). Never close, kill or modify anything you did not launch yourself, and leave the target open unless the goal says to close it.",
    "- Act once, then verify the result by AX or readback in the same step when possible. Never resend or vary input while waiting for a delayed effect; if the window, title or focus is not what you expect, stop and re-observe.",
    "- A delivered input, a clipboard write or `verified` on one element is not proof of the goal. Verify the done condition itself.",
    "- Report only what you actually observed. If you could not observe the done condition, done is false.",
    "- In `observed`, include the PID and window id of every window you launched so the caller can close it.",
    "",
    'End with the last line being exactly one JSON line, no code fence and no text after it: {"done":true|false,"observed":"...","issues":"..."}',
  ].join("\n");
}

export function childArgs(selector: { model: string; thinking?: string }, prompt: string): string[] {
  return ["-p", "--no-session", "--mode", "json", "--model", selector.model,
    ...(selector.thinking ? ["--thinking", selector.thinking] : []), `--tools=${CHILD_TOOLS}`, prompt];
}

/** The last non-empty line must be a JSON object with a boolean `done` and string `observed` and `issues`. */
export function parseVerdict(text: string): Verdict | undefined {
  const last = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).at(-1);
  if (!last?.startsWith("{")) return undefined;
  let value: unknown;
  try { value = JSON.parse(last); } catch { return undefined; }
  if (typeof value !== "object" || value === null) return undefined;
  const { done, observed, issues } = value as Record<string, unknown>;
  if (typeof done !== "boolean" || typeof observed !== "string" || typeof issues !== "string") return undefined;
  return { done, observed, issues };
}

/** Reads the child's `--mode json` event stream line by line; keeps only what the result needs. */
class StreamAnalyzer {
  toolCalls = 0;
  toolErrors = 0;
  model: string | undefined;
  finalText = "";
  stopReason: string | undefined;
  errorMessage: string | undefined;

  push(line: string): void {
    let event: { type?: string; isError?: boolean; message?: { role?: string; provider?: string; model?: string; stopReason?: string; errorMessage?: string; content?: unknown } };
    try { event = JSON.parse(line); } catch { return; }
    if (event.type === "tool_execution_start") this.toolCalls++;
    else if (event.type === "tool_execution_end" && event.isError === true) this.toolErrors++;
    else if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      if (message.provider && message.model) this.model = `${message.provider}/${message.model}`;
      this.stopReason = message.stopReason;
      this.errorMessage = message.errorMessage;
      const parts = Array.isArray(message.content) ? message.content as { type?: string; text?: string }[] : [];
      // Only a turn that ended with `stop` is an answer; commentary written before a tool call is not.
      this.finalText = message.stopReason === "stop" ? parts.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("") : "";
    }
  }
}

// One desktop per machine: computer_task calls in this process run one at a time, in arrival order.
let queueTail: Promise<void> = Promise.resolve();

/** Waits for earlier calls. Returns undefined (and passes the slot on) when `signal` aborts while queued. */
async function acquireDesktop(signal: AbortSignal): Promise<(() => void) | undefined> {
  const previous = queueTail;
  const mine = Promise.withResolvers<void>();
  queueTail = previous.then(() => mine.promise);
  const abort = Promise.withResolvers<false>();
  const onAbort = () => abort.resolve(false);
  if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
  const turn = await Promise.race([previous.then(() => true as const), abort.promise]);
  signal.removeEventListener("abort", onAbort);
  if (!turn || signal.aborted) { mine.resolve(); return undefined; }
  return mine.resolve;
}

function clampTimeoutSec(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(MAX_TIMEOUT_SEC, Math.max(MIN_TIMEOUT_SEC, Math.round(value)));
}

const clip = (text: string, max: number) => (text.length > max ? `...${text.slice(-max)}` : text);

function notDone(reason: string, stats: Partial<ComputerTaskStats>, selector?: string, extra: string[] = []): ComputerTaskResult {
  const full: ComputerTaskStats = { model: stats.model ?? "none", wallSec: stats.wallSec ?? 0, toolCalls: stats.toolCalls ?? 0, toolErrors: stats.toolErrors ?? 0 };
  const lines = ["computer_task: NOT DONE", `reason: ${reason}`];
  if (selector) lines.push(`model: ${full.model} (modelRoles.${COMPUTER_ROLE} = ${selector})`);
  lines.push(`stats: ${full.wallSec}s wall, ${full.toolCalls} tool calls, ${full.toolErrors} tool errors`, ...extra);
  return { done: false, isError: true, text: lines.join("\n"), stats: full };
}

export async function runComputerTask(input: ComputerTaskInput, deps: ComputerTaskDeps, signal: AbortSignal): Promise<ComputerTaskResult> {
  if (deps.env[CHILD_ENV]) return notDone("computer_task cannot be nested: this session is already a computer_task child.", {});
  if (![input.goal, input.target, input.done].every((field) => typeof field === "string" && field.trim())) {
    return notDone("goal, target and done are all required and must not be blank.", {});
  }
  const parsed = parseSelector(deps.selector);
  if (!deps.selector) return notDone(`modelRoles.${COMPUTER_ROLE} is not configured.`, {});
  if (!parsed) return notDone(`modelRoles.${COMPUTER_ROLE} (${deps.selector}) is not a provider/model selector.`, {});
  if (!deps.exe) return notDone("OMP_EXE is not set, so the child omp session cannot be started.", {}, deps.selector);
  const timeoutSec = clampTimeoutSec(input.timeoutSec);

  const release = await acquireDesktop(signal);
  if (!release) return notDone("aborted while waiting for another computer_task to finish; nothing was started.", {}, deps.selector);
  const started = Date.now();
  const analyzer = new StreamAnalyzer();
  let scratch: string | undefined;
  try {
    // Inside the try: a failure here must still release the desktop slot.
    scratch = await mkdtemp(join(deps.scratchRoot ?? tmpdir(), "computer-task-"));
    let outcome: SpawnOutcome;
    try {
      outcome = await deps.spawn({
        exe: deps.exe, args: childArgs(parsed, buildPrompt(input)), cwd: scratch,
        env: { ...deps.env, [CHILD_ENV]: "1" }, signal, timeoutMs: timeoutSec * 1000,
      }, (line) => analyzer.push(line));
    } catch (error) {
      outcome = { exitCode: null, timedOut: false, aborted: false, stderr: error instanceof Error ? error.message : String(error) };
    }
    const stats: Partial<ComputerTaskStats> = {
      model: analyzer.model ?? parsed.model, wallSec: Math.round((Date.now() - started) / 100) / 10,
      toolCalls: analyzer.toolCalls, toolErrors: analyzer.toolErrors,
    };
    const stderr = outcome.stderr.trim();
    if (outcome.aborted) return notDone("aborted: the child was stopped; the desktop may be in a partial state, re-observe it.", stats, deps.selector);
    if (outcome.timedOut) return notDone(`timed out after ${timeoutSec}s: the child was killed; the desktop may be in a partial state, re-observe it.`, stats, deps.selector);
    if (analyzer.stopReason !== undefined && analyzer.stopReason !== "stop") {
      return notDone(`the child's last model turn ended with ${analyzer.stopReason} instead of a final answer: ${analyzer.errorMessage ?? "no message"}`, stats, deps.selector);
    }
    if (!analyzer.finalText.trim()) {
      return notDone(`the child produced no answer (exit ${outcome.exitCode}).`, stats, deps.selector, stderr ? [`stderr: ${clip(stderr, STDERR_TAIL_BYTES)}`] : []);
    }
    const verdict = parseVerdict(analyzer.finalText);
    if (!verdict) {
      return notDone('malformed final line: the child did not end with the required JSON {"done":...,"observed":...,"issues":...}.', stats, deps.selector, [`raw answer tail: ${clip(analyzer.finalText.trim(), RAW_TAIL_CHARS)}`]);
    }
    if (verdict.done && outcome.exitCode !== 0) {
      return notDone(`the child reported done but exited with code ${outcome.exitCode}.`, stats, deps.selector, [`observed: ${verdict.observed}`]);
    }
    const full = stats as ComputerTaskStats;
    const lines = [
      `computer_task: ${verdict.done ? "DONE" : "NOT DONE"}`,
      `model: ${full.model} (modelRoles.${COMPUTER_ROLE} = ${deps.selector})`,
      `stats: ${full.wallSec}s wall, ${full.toolCalls} tool calls, ${full.toolErrors} tool errors`,
      `observed: ${verdict.observed}`,
      ...(verdict.issues ? [`issues: ${verdict.issues}`] : []),
    ];
    return { done: verdict.done, isError: !verdict.done, text: lines.join("\n"), stats: full };
  } catch (error) {
    return notDone(`could not run the child: ${error instanceof Error ? error.message : String(error)}`, {}, deps.selector);
  } finally {
    release();
    // Best effort: a scratch dir that cannot be removed (EBUSY on Windows mounts) must not turn a finished result into a rejection.
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** After the child exited, how long to keep reading its pipes (a grandchild may still hold them open). */
const DRAIN_GRACE_MS = 2_000;

/** Signals the child's whole process group (it is started detached), falling back to the child alone. */
function signalGroup(child: { pid: number; kill(signal: NodeJS.Signals): void }, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/**
 * Real spawner: streams stdout lines; on abort or timeout it SIGTERMs the child's process group, SIGKILLs it after a
 * grace period, and never waits for a grandchild that kept the pipes open longer than DRAIN_GRACE_MS.
 */
export const spawnChild: Spawner = async (request, onLine) => {
  if (request.signal.aborted) return { exitCode: null, timedOut: false, aborted: true, stderr: "" };
  const env = Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const child = Bun.spawn([request.exe, ...request.args], { cwd: request.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  let timedOut = false;
  let aborted = false;
  let closed = false;
  let hardKill: NodeJS.Timeout | undefined;
  const stop = () => {
    signalGroup(child, "SIGTERM");
    hardKill ??= setTimeout(() => signalGroup(child, "SIGKILL"), KILL_GRACE_MS);
  };
  const onAbort = () => { aborted = true; stop(); };
  const timer = setTimeout(() => { timedOut = true; stop(); }, request.timeoutMs);
  request.signal.addEventListener("abort", onAbort, { once: true });
  const stdout = child.stdout.getReader();
  const stderrPipe = child.stderr.getReader();
  let stderrTail = "";
  let pending = "";
  const emit = (line: string) => { if (!closed && line) onLine(line); };
  const flushPending = () => { const line = pending.trim(); pending = ""; emit(line); };
  const readLines = async () => {
    const decoder = new TextDecoder();
    for (let chunk = await stdout.read(); !chunk.done; chunk = await stdout.read()) {
      pending += decoder.decode(chunk.value, { stream: true });
      let newline = pending.indexOf("\n");
      for (; newline >= 0; newline = pending.indexOf("\n")) {
        emit(pending.slice(0, newline).replace(/\r$/u, ""));
        pending = pending.slice(newline + 1);
      }
    }
    flushPending();
  };
  // Only the tail is kept, so a chatty grandchild cannot grow the parent's memory.
  const readStderr = async () => {
    const decoder = new TextDecoder();
    for (let chunk = await stderrPipe.read(); !chunk.done; chunk = await stderrPipe.read()) {
      stderrTail = (stderrTail + decoder.decode(chunk.value, { stream: true })).slice(-STDERR_TAIL_BYTES);
    }
  };
  try {
    const reading = Promise.all([readLines(), readStderr()]);
    const exitCode = await child.exited;
    const drained = Promise.withResolvers<void>();
    const drainTimer = setTimeout(drained.resolve, DRAIN_GRACE_MS);
    await Promise.race([reading, drained.promise]);
    clearTimeout(drainTimer);
    // A final line without a newline that was still buffered when the drain deadline hit is not lost.
    flushPending();
    return { exitCode: aborted || timedOut ? (exitCode === 0 ? null : exitCode) : exitCode, timedOut, aborted, stderr: stderrTail };
  } finally {
    closed = true;
    // Drop pipes a grandchild may still hold: nothing keeps reading or buffering after this call returns.
    void stdout.cancel().catch(() => {});
    void stderrPipe.cancel().catch(() => {});
    clearTimeout(timer);
    clearTimeout(hardKill);
    // Anything this child left behind in its group must not outlive a call that was stopped.
    if (aborted || timedOut) signalGroup(child, "SIGKILL");
    request.signal.removeEventListener("abort", onAbort);
  }
};
