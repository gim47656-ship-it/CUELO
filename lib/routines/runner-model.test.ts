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
mock.module("./model", () => ({
  routineModelSettings: async () => { if (settingsFail) throw new Error("routine-model.json: invalid model sonnet"); return { enabled, model: enabled ? selected : undefined }; },
  runRoutineChecker: async () => { checks++; if (checkerFails) throw new Error("checker offline"); return '{"findings":["missing item"]}'; },
}));
mock.module("../session-reader", () => ({ invalidateSessionListCache() {} }));
mock.module("./state", () => ({
  readRoutineRunStates: () => Object.fromEntries(states),
  updateRoutineRunState: (id: string, update: (current: object) => object) => states.set(id, update(states.get(id) ?? {})),
}));
mock.module("./git-sync", () => ({ commitRoutineChange: async (_dir: string, _message: string, change: () => { result: boolean }) => change().result }));
mock.module("./store", () => ({
  expandHome: (path: string) => path,
  isExistingDirectory: () => true,
  readRoutine: () => ({}),
  routinePaths: (dir: string) => ({ folder: dir, posts: dir }),
  thisRoutineHost: () => "test-pc",
  writePostFile: (_dir: string, _id: string, _stamp: string, _host: string, post: RoutinePost) => { posts.push(post); return "post.md"; },
}));
mock.module("../rpc-manager", () => ({ startNewRpcSession: async (_request: unknown, _cwd: string, options: { initialModel?: { provider: string; modelId: string } }) => {
  expect(options.initialModel).toEqual(enabled && selected ? { provider: "anthropic", modelId: selected.split("/").slice(1).join("/") } : undefined);
  if (failStart) throw new Error(`Model is not available in the enabled scope: ${selected}`);
  return { realSessionId: "isolated", session: {
    send: async (command: { type: string; message?: string }) => {
      if (command.type === "prompt") { prompts.push(command.message!); answer = prompts.length === 1 ? "original" : "revised"; }
      if (command.type === "get_last_assistant_text") return { text: answer };
    },
    onEvent: () => () => {}, isAlive: () => true, isRunning: () => false, isSafelyIdle: () => true,
    shutdown: async () => {},
  } };
} }));
// Load after mock registration to exercise the runner's dependency boundary.
const { startRoutineRun } = await import("./runner");
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
