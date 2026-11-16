import { test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, rmdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

if (process.env.CUELO_REPLY_CHILD === "1") {
  const dir = process.env.CUELO_ROUTINES_DIR!;
  let answer = "[답 필요]\nWhich choice?";
  let prompts = 0;
  let resumes = 0;
  let live = false;
  mock.module("./model", () => ({ routineModelSettings: async () => ({ enabled: false }), runRoutineChecker: async () => "{}" }));
  // Preserve unrelated exports used by store/upkeep while replacing session resolution.
  const sessionReader = await import("../session-reader");
  mock.module("../session-reader", () => ({ ...sessionReader, invalidateSessionListCache() {}, resolveSessionPath: async () => "session.jsonl", readSessionHeader: () => ({ cwd: dir }) }));
  const session = {
    sessionId: "continued-session", isAlive: () => true, isSafelyIdle: () => true, isRunning: () => false,
    onEvent: () => () => {}, shutdown: async () => {},
    send: async (command: { type: string; message?: string }) => {
      if (command.type === "prompt") { prompts++; expect(command.message).toContain("first answer"); }
      if (command.type === "get_last_assistant_text") return { text: answer };
    },
  };
  mock.module("../rpc-manager", () => ({ getRpcSession: () => live ? session : undefined,
    startNewRpcSession: async () => { throw new Error("Must resume existing session"); },
    startRpcSession: async (id: string, _file: string, _cwd: string | undefined, options: { interactivePrompts?: false }) => {
      resumes++; expect(id).toBe("original-session"); expect(options.interactivePrompts).toBe(false);
      return { session, realSessionId: session.sessionId };
    },
  }));
  // Register process-wide mocks before loading the runner's module dependencies.
  const { writeRoutineFile, writePostFile, writeReplyFile, readReplies, thisRoutineHost } = await import("./store");
  const { startRoutineReply, isRoutineRunning, recordInterruptedRuns } = await import("./runner");
  const { readRoutineRunStates, updateRoutineRunState } = await import("./state");
  const { commitRoutineChange } = await import("./git-sync");
  const commitFixtures = () => commitRoutineChange(dir, "fixture input", () => ({ paths: ["routines"], result: undefined }));
  const routine = { id: "test", name: "Test", enabled: false, schedule: { kind: "hourly" as const, everyHours: 1, minute: 0 }, timezone: "Asia/Seoul", prompt: "Test", cwd: null, host: "different-current-host", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeRoutineFile(dir, routine);
  const file = writePostFile(dir, "test", "20261115T0900", thisRoutineHost(), { title: "Test", routineId: "test", host: thisRoutineHost(), status: "ok", sessionId: "original-session", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), body: "original" }).split("/").at(-1)!;
  const reply = writeReplyFile(dir, "test", file, { author: "user", host: "phone", createdAt: new Date().toISOString(), body: "first answer" }).reply;
  async function settled() {
    while (isRoutineRunning("test")) await Bun.sleep(20);
    // This integration exercises the real runner's deadline/poll timers and git subprocesses.
  }
  test("reply resumes by post host even for disabled/moved routines, commits once, and strips waiting marker", async () => {
    await commitFixtures();
    expect(startRoutineReply(dir, routine, file)).toBe(true);
    expect(startRoutineReply(dir, routine, file)).toBe(false);
    await settled();
    expect(prompts).toBe(1); expect(resumes).toBe(1);
    const replies = readReplies(dir, "test", file);
    expect(replies.at(-1)).toMatchObject({ author: "agent", body: "Which choice?", status: "waiting", sessionId: "continued-session" });
    expect(replies.at(-1)?.replyTo).toEqual([reply.file]);
    expect(startRoutineReply(dir, routine, file)).toBe(false);
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim()).toBe("routine(test): reply");
    const foreign = writePostFile(dir, "test", "20261115T0901", "other", { title: "Other", routineId: "test", host: "other", status: "ok", sessionId: null, startedAt: "", finishedAt: "", body: "original" }).split("/").at(-1)!;
    const { POST } = await import("../../app/api/routines/[id]/posts/[file]/replies/route");
    const call = (body: string, type = "application/json", origin = "http://localhost") => POST(new Request("http://localhost/api/routines/test/posts/file/replies", {
      method: "POST", headers: { host: "localhost", "content-type": type, origin }, body,
    }), { params: Promise.resolve({ id: "test", file: foreign }) });
    expect((await call("{}", "application/json", "https://evil.test")).status).toBe(403);
    expect((await call("{}", "text/plain")).status).toBe(415);
    expect((await call("{")).status).toBe(400);
    expect((await call('{"body":"  "}')).status).toBe(400);
    expect((await call(JSON.stringify({ body: "x".repeat(8001) }))).status).toBe(400);
    const posted = await call('{"body":"  from API  "}');
    expect(posted.status).toBe(201);
    expect((await posted.json()).reply.body).toBe("from API");
    expect(startRoutineReply(dir, routine, foreign)).toBe(false);
    expect(prompts).toBe(1);
    const count = readReplies(dir, "test", foreign).length;
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect((await call('{"body":"must not execute"}')).status).toBe(500);
    rmSync(hook);
    expect(readReplies(dir, "test", foreign).length).toBe(count);
    expect(execFileSync("git", ["status", "--porcelain", "--", `routines/test/replies/${foreign.slice(0, -3)}`], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
  }, 20000);
  test("crashed reservation retries once within three hours; exhausted or old claims write failed agent reply", async () => {
    live = true; answer = "Handled";
    for (const [attempt, age, shouldRetry] of [[1, 1000, true], [2, 1000, false], [1, 4 * 3600000, false]] as const) {
      const user = writeReplyFile(dir, "test", file, { author: "user", host: "phone", createdAt: new Date().toISOString(), body: "first answer" }).reply;
      await commitFixtures();
      const before = prompts;
      updateRoutineRunState("test", (current) => ({ ...current,
        handledReplyFiles: { [file]: [...(current.handledReplyFiles?.[file] ?? []), user.file] },
        running: { bootId: "old-boot", trigger: "reply", sessionId: session.sessionId, replyPost: file, replyFiles: [user.file], startedAt: new Date(Date.now() - age).toISOString(), attempt },
      }));
      await recordInterruptedRuns(dir); await settled();
      expect(prompts - before).toBe(shouldRetry ? 1 : 0);
      expect(readReplies(dir, "test", file).at(-1)?.status).toBe(shouldRetry ? "ok" : "failed");
      expect(readRoutineRunStates().test.running).toBeUndefined();
    }
    expect(readRoutineRunStates().test.handledReplyFiles?.[file]).toBeUndefined();
  }, 30000);
  test("failed publication preserves answer and retries commit without a second prompt", async () => {
    live = true; answer = "saved answer";
    writeReplyFile(dir, "test", file, { author: "user", host: "phone", createdAt: new Date().toISOString(), body: "first answer" });
    await commitFixtures();
    const before = prompts;
    mkdirSync(join(dir, ".git", "rebase-merge"));
    expect(startRoutineReply(dir, routine, file)).toBe(true);
    await settled();
    expect(readRoutineRunStates().test.pendingReply?.reply.body).toBe(answer);
    rmdirSync(join(dir, ".git", "rebase-merge"));
    await recordInterruptedRuns(dir); await settled();
    expect(prompts - before).toBe(1);
    expect(readReplies(dir, "test", file).at(-1)?.body).toBe(answer);
    expect(readRoutineRunStates().test.pendingReply).toBeUndefined();
    // Losing the file after a failed commit must recreate the durable answer without re-prompting.
    const hook = join(dir, ".git", "hooks", "pre-commit");
    writeReplyFile(dir, "test", file, { author: "user", host: "phone", createdAt: new Date().toISOString(), body: "first answer" });
    await commitFixtures();
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    expect(startRoutineReply(dir, routine, file)).toBe(true);
    await settled();
    const pending = readRoutineRunStates().test.pendingReply!;
    expect(pending.path).toBeDefined();
    rmSync(join(dir, pending.path!));
    rmSync(hook);
    const sentBeforeRecovery = prompts;
    await recordInterruptedRuns(dir); await settled();
    expect(prompts).toBe(sentBeforeRecovery);
    expect(readReplies(dir, "test", file).at(-1)?.body).toBe(answer);
    expect(readRoutineRunStates().test.running).toBeUndefined();
    expect(execFileSync("git", ["status", "--porcelain", "--", `routines/test/replies/${file.slice(0, -3)}`], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
    console.log("R3-ANT-1 recovery reused pending filename; thread git status clean");
  }, 20000);
} else {
  test("reply execution with real file and git boundaries in isolated process", async () => {
    const root = mkdtempSync(join(tmpdir(), "routine-reply-runner-"));
    try {
      execFileSync("git", ["init", "-q", root]);
      const child = Bun.spawn([process.execPath, "test", import.meta.path], { env: { ...process.env, CUELO_REPLY_CHILD: "1", CUELO_ROUTINES_DIR: root, PI_CODING_AGENT_DIR: join(root, "agent") }, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      console.log(stdout + stderr); expect(code).toBe(0);
    } finally { rmSync(root, { recursive: true }); }
  }, 60000);
}
