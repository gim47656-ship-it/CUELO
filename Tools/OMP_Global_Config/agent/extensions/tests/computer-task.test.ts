import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  CHILD_ENV,
  parseSelector,
  parseVerdict,
  runComputerTask,
  spawnChild,
  type ComputerTaskDeps,
  type SpawnRequest,
  type SpawnOutcome,
} from "../lib/computer-task";

const input = { goal: "type 가Ω→42 into the field", target: "the Character Map window you launch", done: "field reads back 가Ω→42" };
const SELECTOR = "openai-codex/gpt-6.1-terra:high";

const toolStart = (name: string) => JSON.stringify({ type: "tool_execution_start", toolCallId: `c-${name}`, toolName: name, args: {} });
const toolEnd = (name: string, isError?: boolean) => JSON.stringify({ type: "tool_execution_end", toolCallId: `c-${name}`, toolName: name, result: { content: [] }, ...(isError ? { isError: true } : {}) });
const assistant = (text: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  type: "message_end", message: { role: "assistant", provider: "openai-codex", model: "gpt-6.1-terra", stopReason: "stop", content: [{ type: "text", text }], ...extra },
});
const verdictLine = (value: object) => JSON.stringify({ issues: "", ...value });

function fakeSpawn(lines: string[], outcome: Partial<SpawnOutcome> = {}, seen?: SpawnRequest[]): ComputerTaskDeps["spawn"] {
  return async (request, onLine) => {
    seen?.push(request);
    for (const line of lines) onLine(line);
    return { exitCode: 0, timedOut: false, aborted: false, stderr: "", ...outcome };
  };
}

function deps(spawn: ComputerTaskDeps["spawn"], overrides: Partial<ComputerTaskDeps> = {}): ComputerTaskDeps {
  return { selector: SELECTOR, exe: "/fake/omp", env: { PATH: "/bin" }, spawn, ...overrides };
}

const signal = () => new AbortController().signal;


describe("selector and child command", () => {
  test("splits the modelRoles.computer selector into model and thinking level", () => {
    expect(parseSelector(SELECTOR)).toEqual({ model: "openai-codex/gpt-6.1-terra", thinking: "high" });
    expect(parseSelector("openai-codex/gpt-6.1-terra")).toEqual({ model: "openai-codex/gpt-6.1-terra", thinking: undefined });
    expect(parseSelector("hive/deepseek-ai/deepseek-v4.1-flash-1017:auto")).toEqual({ model: "hive/deepseek-ai/deepseek-v4.1-flash-1017", thinking: "auto" });
    expect(parseSelector(undefined)).toBeUndefined();
    expect(parseSelector("terra")).toBeUndefined();
  });

});

describe("verdict parsing", () => {
  test("accepts the done and not-done JSON final line", () => {
    expect(parseVerdict(`working notes\n${verdictLine({ done: true, observed: "field=가Ω→42", issues: "" })}`)).toEqual({ done: true, observed: "field=가Ω→42", issues: "" });
    expect(parseVerdict(verdictLine({ done: false, observed: "no window", issues: "charmap missing" }))).toEqual({ done: false, observed: "no window", issues: "charmap missing" });
    expect(parseVerdict(`${verdictLine({ done: true, observed: "ok" })}\n\n`)).toEqual({ done: true, observed: "ok", issues: "" });
  });

  test("rejects anything but a JSON object with a boolean done on the last line", () => {
    expect(parseVerdict("All done, the field now reads 가Ω→42.")).toBeUndefined();
    expect(parseVerdict(`${verdictLine({ done: true, observed: "x" })}\nthanks!`)).toBeUndefined();
    expect(parseVerdict(verdictLine({ done: "true", observed: "x" }))).toBeUndefined();
    expect(parseVerdict(JSON.stringify({ done: true }))).toBeUndefined();
    // `issues` is part of the contract: missing or non-string means the answer is malformed, not a quiet success.
    expect(parseVerdict(JSON.stringify({ done: true, observed: "x" }))).toBeUndefined();
    expect(parseVerdict(JSON.stringify({ done: true, observed: "x", issues: false }))).toBeUndefined();
    expect(parseVerdict("```json\n{\"done\":true,\"observed\":\"x\"}\n```")).toBeUndefined();
    expect(parseVerdict("")).toBeUndefined();
  });
});

describe("runComputerTask", () => {
  test("returns the observed result with the resolved model, selector and stats when the child reports done", async () => {
    const seen: SpawnRequest[] = [];
    const lines = [toolStart("read"), toolEnd("read"), toolStart("eval"), toolEnd("eval", true), toolStart("windows_control"), toolEnd("windows_control"),
      assistant(verdictLine({ done: true, observed: "RICHEDIT50W reads 가Ω→42", issues: "" }))];
    const result = await runComputerTask(input, deps(fakeSpawn(lines, {}, seen)), signal());
    expect(result.done).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("computer_task: DONE");
    expect(result.text).toContain("openai-codex/gpt-6.1-terra");
    expect(result.text).toContain(SELECTOR);
    expect(result.text).toContain("RICHEDIT50W reads 가Ω→42");
    expect(result.stats.toolCalls).toBe(3);
    expect(result.stats.toolErrors).toBe(1);
    expect(result.stats.model).toBe("openai-codex/gpt-6.1-terra");
    expect(seen).toHaveLength(1);
    expect(seen[0].exe).toBe("/fake/omp");
    expect(seen[0].args).toContain("openai-codex/gpt-6.1-terra");
    expect(seen[0].env[CHILD_ENV]).toBe("1");
    expect(seen[0].env.PATH).toBe("/bin");
  });

  test("uses a scratch cwd that is removed afterwards", async () => {
    const seen: SpawnRequest[] = [];
    await runComputerTask(input, deps(fakeSpawn([assistant(verdictLine({ done: true, observed: "x" }))], {}, seen)), signal());
    expect(seen[0].cwd).toBeTruthy();
    expect(existsSync(seen[0].cwd)).toBe(false);
  });

  test("returns not done when the child reports done:false and shows its issues", async () => {
    const result = await runComputerTask(input, deps(fakeSpawn([assistant(verdictLine({ done: false, observed: "no window", issues: "charmap did not start" }))])), signal());
    expect(result.done).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toContain("computer_task: NOT DONE");
    expect(result.text).toContain("charmap did not start");
  });

  test("returns not done when the last line is not the JSON contract, keeping the raw text", async () => {
    const result = await runComputerTask(input, deps(fakeSpawn([assistant("Looks good to me, the field is set.")])), signal());
    expect(result.done).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/malformed|not the required JSON/i);
    expect(result.text).toContain("Looks good to me");
  });

  test("returns not done when the child produced no answer at all", async () => {
    const result = await runComputerTask(input, deps(fakeSpawn([toolStart("eval")], { exitCode: 1, stderr: "boom: provider unavailable" })), signal());
    expect(result.done).toBe(false);
    expect(result.text).toContain("boom: provider unavailable");
  });

  test("text written before a tool call is not an answer: a last turn that is not `stop` is not done", async () => {
    const commentary = assistant(verdictLine({ done: true, observed: "premature" }), { stopReason: "toolUse" });
    const result = await runComputerTask(input, deps(fakeSpawn([commentary], { exitCode: 1 })), signal());
    expect(result.done).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/toolUse instead of a final answer/);
  });

  test("a timeout is never reported as success, even if the partial output looked done", async () => {
    const lines = [assistant(verdictLine({ done: true, observed: "partial" }))];
    const result = await runComputerTask({ ...input, timeoutSec: 30 }, deps(fakeSpawn(lines, { timedOut: true, exitCode: null })), signal());
    expect(result.done).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/timed out after 30s/i);
  });

  test("passes timeoutSec to the spawner, defaulting to 600 and clamping the range", async () => {
    const seen: SpawnRequest[] = [];
    const spawn = fakeSpawn([assistant(verdictLine({ done: true, observed: "x" }))], {}, seen);
    await runComputerTask(input, deps(spawn), signal());
    await runComputerTask({ ...input, timeoutSec: 5 }, deps(spawn), signal());
    await runComputerTask({ ...input, timeoutSec: 99999 }, deps(spawn), signal());
    expect(seen.map((request) => request.timeoutMs)).toEqual([600_000, 10_000, 1_800_000]);
  });

  test("an abort is reported as not done and the abort signal reaches the spawner", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const spawn: ComputerTaskDeps["spawn"] = async (request) => {
      received = request.signal;
      controller.abort();
      return { exitCode: null, timedOut: false, aborted: true, stderr: "" };
    };
    const result = await runComputerTask(input, deps(spawn), controller.signal);
    expect(received?.aborted).toBe(true);
    expect(result.done).toBe(false);
    expect(result.text).toMatch(/aborted/i);
  });

  test("a spawn failure becomes a not-done result", async () => {
    const spawn: ComputerTaskDeps["spawn"] = async () => { throw new Error("spawn ENOENT /fake/omp"); };
    const result = await runComputerTask(input, deps(spawn), signal());
    expect(result.done).toBe(false);
    expect(result.text).toContain("spawn ENOENT");
  });

  test("refuses without calling the spawner when the role, the executable or a required field is missing, or inside a computer_task child", async () => {
    let calls = 0;
    const spawn: ComputerTaskDeps["spawn"] = async () => { calls++; return { exitCode: 0, timedOut: false, aborted: false, stderr: "" }; };
    const noRole = await runComputerTask(input, deps(spawn, { selector: undefined }), signal());
    expect(noRole.text).toContain("modelRoles.computer");
    const noExe = await runComputerTask(input, deps(spawn, { exe: undefined }), signal());
    expect(noExe.text).toContain("OMP_EXE");
    const recursive = await runComputerTask(input, deps(spawn, { env: { [CHILD_ENV]: "1" } }), signal());
    expect(recursive.text).toMatch(/recurs|nested/i);
    const blank = await runComputerTask({ ...input, done: "  " }, deps(spawn), signal());
    expect(blank.text).toMatch(/goal, target and done/i);
    for (const result of [noRole, noExe, recursive, blank]) { expect(result.done).toBe(false); expect(result.isError).toBe(true); }
    expect(calls).toBe(0);
  });

  test("a scratch-dir failure is a not-done result and does not wedge the desktop queue", async () => {
    let calls = 0;
    const spawn: ComputerTaskDeps["spawn"] = async (_request, onLine) => {
      calls++; onLine(assistant(verdictLine({ done: true, observed: "ok" })));
      return { exitCode: 0, timedOut: false, aborted: false, stderr: "" };
    };
    const broken = await runComputerTask(input, deps(spawn, { scratchRoot: "/nonexistent-computer-task-root/deeper" }), signal());
    expect(broken.done).toBe(false);
    expect(broken.isError).toBe(true);
    expect(broken.text).toMatch(/could not run the child/i);
    expect(calls).toBe(0);
    const next = await runComputerTask(input, deps(spawn), signal());
    expect(next.done).toBe(true);
    expect(calls).toBe(1);
  });
});

describe("serialization", () => {
  test("one computer_task runs at a time per process; later calls wait in order", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const slow = (name: string): ComputerTaskDeps["spawn"] => async (_request, onLine) => {
      active++; peak = Math.max(peak, active); order.push(`start ${name}`);
      // Yield several times: without serialization the other calls would start (and raise `active`) in these gaps.
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
      onLine(assistant(verdictLine({ done: true, observed: name })));
      order.push(`end ${name}`); active--;
      return { exitCode: 0, timedOut: false, aborted: false, stderr: "" };
    };
    const results = await Promise.all(["a", "b", "c"].map((name) => runComputerTask(input, deps(slow(name)), signal())));
    expect(peak).toBe(1);
    expect(order).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(results.every((result) => result.done)).toBe(true);
  });

  test("a call aborted while queued never spawns and does not block the next call", async () => {
    const gate = Promise.withResolvers<void>();
    const blockerStarted = Promise.withResolvers<void>();
    const started: string[] = [];
    const blocker: ComputerTaskDeps["spawn"] = async (_request, onLine) => {
      started.push("blocker"); blockerStarted.resolve(); await gate.promise;
      onLine(assistant(verdictLine({ done: true, observed: "b" })));
      return { exitCode: 0, timedOut: false, aborted: false, stderr: "" };
    };
    const quick: ComputerTaskDeps["spawn"] = async (_request, onLine) => {
      started.push("quick"); onLine(assistant(verdictLine({ done: true, observed: "q" })));
      return { exitCode: 0, timedOut: false, aborted: false, stderr: "" };
    };
    const first = runComputerTask(input, deps(blocker), signal());
    await blockerStarted.promise;
    const controller = new AbortController();
    const queued = runComputerTask(input, deps(quick), controller.signal);
    const third = runComputerTask(input, deps(quick), signal());
    controller.abort();
    const queuedResult = await queued;
    expect(queuedResult.done).toBe(false);
    expect(queuedResult.text).toMatch(/aborted/i);
    gate.resolve();
    expect((await first).done).toBe(true);
    expect((await third).done).toBe(true);
    expect(started).toEqual(["blocker", "quick"]);
  });
});

// Real wall-clock time is deliberate here: these exercise real process kill and timeout behavior that fake timers cannot.
describe("spawnChild (real process)", () => {
  test("streams stdout lines to the callback and reports the exit code", async () => {
    const lines: string[] = [];
    const outcome = await spawnChild({ exe: "sh", args: ["-c", "printf 'one\\ntwo\\n'; echo oops >&2; exit 3"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "" }, signal: signal(), timeoutMs: 10_000 }, (line) => lines.push(line));
    expect(lines).toEqual(["one", "two"]);
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderr).toContain("oops");
    expect(outcome.timedOut).toBe(false);
    expect(outcome.aborted).toBe(false);
  });

  test("aborting the signal kills the child promptly", async () => {
    const controller = new AbortController();
    const started = Date.now();
    // `sh -c` leaves a grandchild `sleep` holding the pipes: the whole process group must be killed.
    const outcome = await spawnChild({ exe: "sh", args: ["-c", "echo ready; sleep 30"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "" }, signal: controller.signal, timeoutMs: 60_000 }, (line) => { if (line === "ready") controller.abort(); });
    expect(outcome.aborted).toBe(true);
    expect(outcome.exitCode).not.toBe(0);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the timeout kills the child and is reported as timedOut", async () => {
    const started = Date.now();
    const outcome = await spawnChild({ exe: "sleep", args: ["30"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "" }, signal: signal(), timeoutMs: 150 }, () => {});
    expect(outcome.timedOut).toBe(true);
    expect(outcome.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("returns after the drain grace when a grandchild keeps the pipes open, keeping what was already read", async () => {
    const lines: string[] = [];
    const started = Date.now();
    // The direct child exits 0 at once; the backgrounded subshell still holds stdout and stderr for 5 s.
    const outcome = await spawnChild({ exe: "sh", args: ["-c", "echo ready; printf partial; echo early >&2; (sleep 5; echo late >&2) & exit 0"], cwd: "/tmp", env: { PATH: process.env.PATH ?? "" }, signal: signal(), timeoutMs: 60_000 }, (line) => lines.push(line));
    expect(outcome.exitCode).toBe(0);
    expect(lines).toEqual(["ready", "partial"]);
    expect(outcome.stderr).toContain("early");
    expect(outcome.stderr).not.toContain("late");
    expect(Date.now() - started).toBeLessThan(4_000);
  });
});
