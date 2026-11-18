import { afterAll, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoutineRunState } from "./state";
import type { Routine } from "./store";

// Module mocks are process-wide in Bun; isolate them from every other test file.
if (process.env.CUELO_ROUTINE_CONCURRENCY_CHILD === "1") {
  const states = new Map<string, RoutineRunState>();
  const routines = new Map<string, Routine>();
  const posts: { routineId: string; status: string }[] = [];
  const started: string[] = []; // cwd of each session start, in order
  const prompts = new Map<string, string>();
  const gates = new Map<string, () => void>();
  let autoRelease = false;
  let open = 0;
  let peak = 0;
  const logs: string[] = [];
  const realLog = console.log;
  let failStateWrite = false;
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")); realLog(...args); };

  mock.module("./model", () => ({ routineModelSettings: async () => ({ enabled: false }), runRoutineChecker: async () => "{}" }));
  mock.module("../session-reader", () => ({ invalidateSessionListCache() {}, resolveSessionPath: async () => null, readSessionHeader: () => null }));
  mock.module("./state", () => ({
    readRoutineRunStates: () => Object.fromEntries(states),
    updateRoutineRunState: (id: string, update: (current: object) => object) => {
      if (failStateWrite) throw new Error("ENOSPC");
      states.set(id, update(states.get(id) ?? {}));
    },
  }));
  mock.module("./git-sync", () => ({ commitRoutineChange: async (_dir: string, _message: string, change: () => { result: unknown }) => change().result }));
  const replyPost = { title: "t", routineId: "rep", host: "test-pc", status: "ok", sessionId: null, startedAt: "", finishedAt: "", body: "original" };
  const userReply = { file: "a-user.md", author: "user", host: "phone", createdAt: "2026-11-17T00:00:00Z", body: "question" };
  mock.module("./store", () => ({
    expandHome: (path: string) => path,
    isExistingDirectory: () => true,
    readRoutine: (_dir: string, id: string) => routines.get(id),
    readRoutines: () => [...routines.values()], listPosts: () => [], readRoutinesPause: () => ({ paused: false, changedAt: null }),
    readPost: (_dir: string, id: string) => (id === "rep" ? replyPost : null),
    readReplies: (_dir: string, id: string) => (id === "rep" ? [userReply] : []),
    writeReplyFile: () => ({ path: "reply.md" }),
    routinePaths: (dir: string) => ({ folder: dir, posts: dir }),
    thisRoutineHost: () => "test-pc",
    writePostFile: (_dir: string, id: string, _stamp: string, _host: string, post: { status: string }) => { posts.push({ routineId: id, status: post.status }); return "post.md"; },
  }));
  const listeners = new Set<(event: { type: string }) => void>();
  mock.module("../rpc-manager", () => ({
    getRpcSession: () => undefined,
    startRpcSession: async () => { throw new Error("Unexpected resume"); },
    startNewRpcSession: async (_request: unknown, cwd: string) => {
      started.push(cwd);
      open++; peak = Math.max(peak, open);
      if (!autoRelease) await new Promise<void>((resolve) => gates.set(cwd, resolve));
      else open--;
      return { realSessionId: `s-${cwd}`, session: {
        send: async (command: { type: string; message?: string }) => {
          if (command.type === "prompt") {
            setImmediate(() => { for (const listener of listeners) listener({ type: "prompt_done" }); });
            prompts.set(cwd, command.message!);
          }
          if (command.type === "get_last_assistant_text") return { text: "answer" };
        },
        onEvent: (listener: (event: { type: string }) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        isAlive: () => true, isRunning: () => false, isSafelyIdle: () => true, shutdown: async () => {},
      } };
    },
  }));
  const { startRoutineRun, startRoutineReply, startManualRoutineRun, isRoutineRunning, recordInterruptedRuns } = await import("./runner");
  const dir = mkdtempSync(join(tmpdir(), "routine-concurrency-"));
  const make = (id: string) => {
    const routine = { id, name: id, enabled: true, host: "test-pc", prompt: "required", cwd: `/w/${id}`, timezone: "Asia/Seoul", schedule: { kind: "weekly" as const, days: [1], times: ["10:00"] }, createdAt: "", updatedAt: "" };
    routines.set(id, routine);
    return routine;
  };
  const until = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5); expect(check()).toBe(true); };
  /** Lets the open session of `id` finish and waits for the whole run (post and slot release). */
  const finish = async (id: string) => {
    await until(() => gates.has(`/w/${id}`));
    open--; gates.get(`/w/${id}`)!(); gates.delete(`/w/${id}`);
    await until(() => !isRoutineRunning(id));
  };
  const reboot = () => {
    // A new process: empty in-memory queue and run map, new boot id, no stop signal.
    globalThis.__cueloRoutineRuns = undefined; globalThis.__cueloRoutineSlots = undefined;
    globalThis.__cueloRoutineBootId = `boot-${Math.random()}`; globalThis.__cueloRoutineServerStop = { since: null };
  };

  test("five simultaneous starts open two sessions; each finish starts the next, replies first then manual then scheduled", async () => {
    reboot();
    const [s1, s2, s3, s4, m1] = ["s1", "s2", "s3", "s4", "m1"].map(make);
    make("rep");
    expect(startRoutineRun(dir, s1, "schedule")).toBe(true);
    expect(startRoutineRun(dir, s2, "schedule")).toBe(true);
    expect(startRoutineRun(dir, s3, "schedule")).toBe(true);
    expect(startRoutineRun(dir, s4, "catch-up")).toBe(true);
    expect(startManualRoutineRun(dir, m1)).toBe(true);
    expect(startRoutineReply(dir, routines.get("rep")!, "post.md")).toBe(true);
    await until(() => started.length === 2);
    await Bun.sleep(60);
    expect(started).toEqual(["/w/s1", "/w/s2"]);
    expect(logs).toContain("[routines] s3 queued: 2 routines already running");
    expect(logs).toContain("[routines] rep queued: 2 routines already running");

    // A queued routine counts as running: the scheduler tick (isRoutineRunning / running marker) and a second start skip it.
    expect(isRoutineRunning("s3")).toBe(true);
    expect(states.get("s3")!.running).toMatchObject({ trigger: "schedule", attempt: 0, sessionId: null });
    expect(startRoutineRun(dir, s3, "schedule")).toBe(false);
    expect(startManualRoutineRun(dir, s3)).toBe(false);
    expect(started).toHaveLength(2);

    await finish("s1");
    await until(() => started.length === 3);
    expect(started[2]).toBe("/w/rep");
    await finish("s2");
    await until(() => started.length === 4);
    expect(started[3]).toBe("/w/m1");
    await finish("rep");
    await until(() => started.length === 5);
    expect(started[4]).toBe("/w/s3");
    await finish("m1");
    await until(() => started.length === 6);
    expect(started[5]).toBe("/w/s4");
    await finish("s3"); await finish("s4");
    expect(peak).toBeLessThanOrEqual(2);
    expect(posts.map((post) => post.routineId).sort()).toEqual(["m1", "s1", "s2", "s3", "s4"]);
    expect(states.get("rep")!.running).toBeUndefined();
    expect(states.get("s3")!.running).toBeUndefined();
    expect(states.get("s3")!.lastRun!.status).toBe("ok");
  }, 30_000);

  test("an immediate reply start still throws when its running marker cannot be written", () => {
    reboot();
    make("rep");
    failStateWrite = true;
    try { expect(() => startRoutineReply(dir, routines.get("rep")!, "post.md")).toThrow("ENOSPC"); }
    finally { failStateWrite = false; }
    expect(isRoutineRunning("rep")).toBe(false);
    expect(globalThis.__cueloRoutineSlots!.active).toBe(0);
  });

  test("a run queued when the server dies is rerun by the existing recovery without spending an attempt", async () => {
    started.length = 0; prompts.clear(); gates.clear(); posts.length = 0; states.clear();
    reboot();
    const [h1, h2, q1, q2] = ["h1", "h2", "q1", "q2"].map(make);
    expect(startRoutineRun(dir, h1, "schedule")).toBe(true);
    expect(startRoutineRun(dir, h2, "schedule")).toBe(true);
    await until(() => started.length === 2);
    expect(startRoutineRun(dir, q1, "schedule")).toBe(true);
    // A restart-after-cut run (attempt 1 was cut) waits too; its old marker is not rewritten while queued.
    const cut = { bootId: "old-boot", sessionId: null, startedAt: new Date().toISOString(), trigger: "schedule" as const };
    states.set("q2", { running: cut });
    expect(startRoutineRun(dir, q2, "schedule", cut)).toBe(true);
    await Bun.sleep(40);
    expect(started).toHaveLength(2);
    expect(states.get("q1")!.running).toMatchObject({ trigger: "schedule", attempt: 0 });
    expect(states.get("q2")!.running).toEqual(cut);

    // The process dies: the in-memory queue is gone, the state file stays. The two held runs were cut as well, so drop theirs.
    const dead = globalThis.__cueloRoutineSlots!;
    dead.queue.splice(0);
    states.delete("h1"); states.delete("h2");
    reboot();
    started.length = 0; autoRelease = true;
    await recordInterruptedRuns(dir);
    await until(() => !isRoutineRunning("q1") && !isRoutineRunning("q2"));
    expect(posts.map((post) => post.routineId).sort()).toEqual(["q1", "q2"]);
    // q1 never ran: rerun as a first attempt. q2 was cut once: this is its second attempt.
    expect(prompts.get("/w/q1")).not.toContain("새 세션으로 다시 실행한다");
    expect(prompts.get("/w/q2")).toContain("새 세션으로 다시 실행한다");
    expect(states.get("q1")!.running).toBeUndefined();
    expect(states.get("q2")!.running).toBeUndefined();
    autoRelease = false;
    // Release the dead process's sessions so the child exits cleanly.
    for (const open of gates.values()) open();
    gates.clear();
  }, 30_000);

  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
} else {
  test("routine run concurrency cap in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CUELO_ROUTINE_CONCURRENCY_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log(stdout + stderr);
    expect(code).toBe(0);
  }, 90_000);
}
