import { afterAll, test, expect, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { RoutinePost } from "./post";

// Module mocks are process-wide in Bun; isolate them from every other test file.
if (process.env.CUELO_ROUTINE_MODEL_CHILD === "1") {
let selected: string | undefined;
let enabled = true;
let failStart = false;
let checkerFails = false;
let settingsFail = false;
let checks = 0;
let prompts: string[] = [];
let answer = "original";
const posts: RoutinePost[] = [];
const states = new Map();
let stopOnPrompt = false;
let currentRoutine: object = {};
mock.module("./model", () => ({
  routineModelSettings: async () => { if (settingsFail) throw new Error("routine-model.json: invalid model sonnet"); return { enabled, model: enabled ? selected : undefined }; },
  runRoutineChecker: async () => { checks++; if (checkerFails) throw new Error("checker offline"); return '{"findings":["missing item"]}'; },
}));
mock.module("../session-reader", () => ({ invalidateSessionListCache() {} }));
let failNextRunningWrite = false;
mock.module("./state", () => ({
  readRoutineRunStates: () => Object.fromEntries(states),
  updateRoutineRunState: (id: string, update: (current: object) => { running?: object }) => {
    const next = update(states.get(id) ?? {});
    // 상태 파일 쓰기 실패 한 번(디스크 가득 참 등). 새 실행 표시를 쓰는 때만 흉내 낸다.
    if (failNextRunningWrite && next.running) { failNextRunningWrite = false; throw new Error("ENOSPC"); }
    states.set(id, next);
  },
}));
mock.module("./git-sync", () => ({ commitRoutineChange: async (_dir: string, _message: string, change: () => { result: boolean }) => change().result }));
mock.module("./store", () => ({
  expandHome: (path: string) => path,
  isExistingDirectory: () => true,
  readRoutine: () => currentRoutine,
  routinePaths: (dir: string) => ({ folder: dir, posts: dir }),
  thisRoutineHost: () => "test-pc",
  writePostFile: (_dir: string, _id: string, _stamp: string, _host: string, post: RoutinePost) => { posts.push(post); return "post.md"; },
}));
mock.module("../rpc-manager", () => ({ startNewRpcSession: async (_request: unknown, _cwd: string, options: { initialModel?: { provider: string; modelId: string } }) => {
  expect(options.initialModel).toEqual(enabled && selected ? { provider: "anthropic", modelId: selected.split("/").slice(1).join("/") } : undefined);
  if (failStart) throw new Error(`Model is not available in the enabled scope: ${selected}`);
  let alive = true;
  return { realSessionId: "isolated", session: {
    send: async (command: { type: string; message?: string }) => {
      if (command.type === "prompt") {
        prompts.push(command.message!); answer = prompts.length === 1 ? "original" : "revised";
        // 서버 종료: 프로세스가 신호를 받고 세션 레지스트리가 세션을 닫는다.
        if (stopOnPrompt) { process.emit("SIGTERM" as never); alive = false; }
      }
      if (command.type === "get_last_assistant_text") return { text: answer };
    },
    onEvent: () => () => {}, isAlive: () => alive, isRunning: () => false, isSafelyIdle: () => true,
    shutdown: async () => {},
  } };
} }));
// Load after mock registration to exercise the runner's dependency boundary.
const { startRoutineRun, recordInterruptedRuns } = await import("./runner");
const dir = mkdtempSync(join(tmpdir(), "routine-runner-smoke-"));
  test("runner publishes named model/PC failure, revised answer, original on checker failure, and disabled legacy answer", async () => {
    const cases = [
      { enabled: true, failStart: true, checkerFails: false, expected: "failed", body: "test-pc", count: 0 },
      { enabled: true, failStart: false, checkerFails: false, expected: "ok", body: "revised", count: 1 },
      { enabled: true, failStart: false, checkerFails: true, expected: "ok", body: "original", count: 1 },
      { enabled: false, failStart: false, checkerFails: false, expected: "ok", body: "original", count: 0 },
      { enabled: false, failStart: true, checkerFails: false, expected: "failed", body: "세션을 실행하지 못했습니다: Model is not available", count: 0 },
      { enabled: true, failStart: false, checkerFails: false, expected: "failed", body: "PC test-pc의 루틴 모델 설정", count: 0, settingsFail: true },
    ] as const;
    for (const scenario of cases) {
      enabled = scenario.enabled; failStart = scenario.failStart; checkerFails = scenario.checkerFails;
      settingsFail = "settingsFail" in scenario;
      selected = "anthropic/claude-sonnet-5-5"; checks = 0; prompts = []; posts.length = 0;
      const routine = { id: "r-smoke", name: "smoke", enabled: true, host: "test-pc", prompt: "required", cwd: dir, timezone: "Asia/Seoul", schedule: { kind: "weekly" as const, days: [1], times: ["10:00"] }, createdAt: "", updatedAt: "" };
      expect(startRoutineRun(dir, routine, "manual")).toBe(true);
      await globalThis.__cueloRoutineRuns!.get(routine.id);
      const posted = posts.at(-1);
      expect(posted?.status).toBe(scenario.expected);
      expect(posted?.body).toContain(scenario.body);
      if (scenario.failStart) expect(posted?.body).toContain(selected);
      if (!enabled && failStart) expect(posted?.body).not.toContain("루틴 모델");
      expect(checks).toBe(scenario.count);
      expect(prompts.length).toBeLessThanOrEqual(2);
    }
  }, 60_000);
  test("a run cut by the server stopping posts nothing, the next boot reruns it once, then gives up", async () => {
    const routine = { id: "r-cut", name: "cut", enabled: true, host: "test-pc", prompt: "required", cwd: dir, timezone: "Asia/Seoul", schedule: { kind: "weekly" as const, days: [1], times: ["10:00"] }, createdAt: "", updatedAt: "" };
    currentRoutine = routine;
    enabled = false; failStart = false; settingsFail = false; prompts = []; posts.length = 0;
    // 새 프로세스: 부팅 id가 바뀌고 종료 신호를 받은 적이 없다.
    const reboot = () => { globalThis.__cueloRoutineBootId = `boot-${Math.random()}`; globalThis.__cueloRoutineServerStop!.since = null; };
    const settle = async () => { await globalThis.__cueloRoutineRuns!.get(routine.id); };

    // 1. 종료 중에 닫힌 회차: 실패 글 없이 실행 표시만 남는다.
    stopOnPrompt = true;
    expect(startRoutineRun(dir, routine, "schedule")).toBe(true);
    await settle();
    expect(posts).toHaveLength(0);
    expect(states.get(routine.id).running?.trigger).toBe("schedule");

    // 2. 다음 부팅: 새 세션으로 다시 돌리고 그 답을 올린다.
    reboot(); stopOnPrompt = false;
    await recordInterruptedRuns(dir);
    await settle();
    expect(posts.map((post) => post.status)).toEqual(["ok"]);
    expect(prompts.at(-1)).toContain("새 세션으로 다시 실행한다");
    expect(states.get(routine.id).running).toBeUndefined();

    // 3. 다시 돌린 회차도 끊기면 더 돌리지 않고 실패 글로 끝낸다.
    posts.length = 0; prompts = []; stopOnPrompt = true;
    reboot();
    expect(startRoutineRun(dir, routine, "schedule")).toBe(true);
    await settle();
    reboot();
    await recordInterruptedRuns(dir);
    await settle();
    expect(states.get(routine.id).running?.attempt).toBe(2);
    expect(posts).toHaveLength(0);
    reboot();
    await recordInterruptedRuns(dir);
    expect(prompts).toHaveLength(2);
    expect(posts.map((post) => post.status)).toEqual(["failed"]);
    expect(posts[0].body).toContain("다시 실행한 회차도");
    expect(states.get(routine.id).running).toBeUndefined();

    // 4. 너무 오래전에 끊긴 회차는 다시 돌리지 않는다.
    posts.length = 0; prompts = []; stopOnPrompt = false;
    states.set(routine.id, { running: { bootId: "old-boot", sessionId: null, startedAt: new Date(Date.now() - 4 * 60 * 60_000).toISOString(), trigger: "schedule" } });
    await recordInterruptedRuns(dir);
    expect(prompts).toHaveLength(0);
    expect(posts.map((post) => post.status)).toEqual(["failed"]);
    expect(posts[0].body).toContain("결과를 받지 못했습니다");

    // 5. 종료 신호를 받고도 서버가 살아남았으면(같은 부팅) 종료 창이 지난 뒤 그 표시가 다시 돈다.
    posts.length = 0; prompts = []; stopOnPrompt = true;
    expect(startRoutineRun(dir, routine, "schedule")).toBe(true);
    await settle();
    await recordInterruptedRuns(dir);
    expect(prompts).toHaveLength(1);
    globalThis.__cueloRoutineServerStop!.since = Date.now() - 6 * 60_000; stopOnPrompt = false;
    await recordInterruptedRuns(dir);
    await settle();
    expect(posts.map((post) => post.status)).toEqual(["ok"]);
    expect(states.get(routine.id).running).toBeUndefined();

    // 6. 다시 돌리려다 새 실행 표시를 못 쓰면 원래 표시가 남아 다음 틱이 다시 한다.
    posts.length = 0; prompts = [];
    const cut = { bootId: "old-boot", sessionId: null, startedAt: new Date().toISOString(), trigger: "schedule" };
    states.set(routine.id, { running: cut });
    failNextRunningWrite = true;
    await recordInterruptedRuns(dir);
    await settle();
    expect(states.get(routine.id).running).toEqual(cut);
    expect(prompts).toHaveLength(0);
    expect(posts).toHaveLength(0);
    await recordInterruptedRuns(dir);
    await settle();
    expect(posts.map((post) => post.status)).toEqual(["ok"]);
  }, 60_000);
afterAll(() => {
  // Only this test's empty workspace; no real repository or publisher is used.
  rmSync(dir, { recursive: true, force: true });
});
} else {
  test("routine runner integration in an isolated process", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, CUELO_ROUTINE_MODEL_CHILD: "1" }, stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    console.log(stdout + stderr);
    expect(code).toBe(0);
  }, 60_000);
}
