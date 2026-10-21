import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCleanup, buildPrelude, buildScript, createFactory, defaultExec, runEgoBrowser, spaceName, type Exec, type ExecResult } from "./index";

// 검증 범위: 스크립트 조립(공간 이름·프로필 id·finish), 종료 코드별 결과 문구, stdin 전달과 ENOENT·시간 초과(가짜 ego-browser 실행 파일).
// 가짜 경계: fakeExec는 ego-browser를 대신한다. 실제 TaskSpace·프로필 격리·페이지 동작은 여기서 증명하지 않는다(실제 스모크는 작업 기록 참고).
function fakeExec(result: ExecResult | Error): { exec: Exec; calls: { args: string[]; input: string; timeoutMs: number }[] } {
  const calls: { args: string[]; input: string; timeoutMs: number }[] = [];
  const exec: Exec = async (args, input, options) => {
    calls.push({ args, input, timeoutMs: options.timeoutMs });
    if (result instanceof Error) throw result;
    return result;
  };
  return { exec, calls };
}
const UUID_A = "0199f6a1-2b3c-7d4e-8f50-123456789abc";
const UUID_B = "0199f6a1-2b3c-7d4e-8f50-123456789abd"; // 앞 32자가 같고 마지막만 다르다
const ok = (stdout: string, stderr = ""): ExecResult => ({ code: 0, stdout, stderr, killed: false });

describe("runEgoBrowser script assembly", () => {
  test("binds one stable space per session and profile; verify pins Profile 2, user leaves the profile to ego", async () => {
    const { exec, calls } = fakeExec(ok("x"));
    await runEgoBrowser({ script: "console.log(1)" }, { exec, sessionId: UUID_A });
    await runEgoBrowser({ script: "console.log(2)", profile: "verify" }, { exec, sessionId: UUID_A });
    await runEgoBrowser({ script: "console.log(3)", profile: "verify" }, { exec, sessionId: UUID_A });
    await runEgoBrowser({ script: "console.log(4)", profile: "verify" }, { exec, sessionId: UUID_B });
    expect(calls.every((call) => call.args.join(" ") === "nodejs")).toBe(true);
    expect(calls[0].input).toContain(`taskSpace("cuelo-${UUID_A}-user")`);
    expect(calls[0].input).not.toContain("profileId");
    expect(calls[1].input).toContain(`taskSpace("cuelo-${UUID_A}-verify", { profileId: "Profile 2" })`);
    expect(calls[2].input.split("\n")[0]).toBe(calls[1].input.split("\n")[0]);
    expect(calls[3].input).toContain(`taskSpace("cuelo-${UUID_B}-verify"`);
    expect(calls[0].input).toContain('const page = task.page("p1");');
    expect(calls[0].input.indexOf("taskSpace(")).toBeLessThan(calls[0].input.indexOf("console.log(1)"));
  });

  test("finish closes the space even when the script throws; without finish nothing is closed", async () => {
    const execute = async (finish: boolean, body: string) => {
      const finished: unknown[] = [];
      const task = { page: () => ({}), finish: async (options: unknown) => { finished.push(options); } };
      const source = buildScript("n", "user", body, finish);
      const outcome = await new Function("taskSpace", `return (async () => { ${source} })()`)(async () => task).then(() => "ok", (error: Error) => error.message);
      return { finished, outcome };
    };
    expect(await execute(true, "throw new Error('script failed')")).toEqual({ finished: [{ keep: [] }], outcome: "script failed" });
    expect(await execute(true, "const note = 1;")).toEqual({ finished: [{ keep: [] }], outcome: "ok" });
    expect(await execute(false, "throw new Error('script failed')")).toEqual({ finished: [], outcome: "script failed" });
    expect(await execute(false, "const task2 = task; void task2;")).toEqual({ finished: [], outcome: "ok" });
  });

  test("the prelude resumes an existing space instead of failing on profileId, and still surfaces other errors", async () => {
    // ego의 실제 계약: profileId를 준 taskSpace()는 이미 있는 이름이면 거절한다(0.6.0.16 실측).
    const spaces = new Map<string, { profileId?: string }>();
    const fakeTaskSpace = async (name: string, options?: { profileId?: string }) => {
      if (name === "broken") throw new Error("EGO_BACKEND_DOWN");
      if (spaces.has(name) && options?.profileId) throw new Error(`taskSpace profileId only applies when creating a new task space; "${name}" already exists`);
      if (!spaces.has(name)) spaces.set(name, { profileId: options?.profileId });
      return { name, profileId: spaces.get(name)!.profileId, page: () => ({}) };
    };
    const run = (name: string) => new Function("taskSpace", `return (async () => { ${buildPrelude(name, "verify")} return task; })()`)(fakeTaskSpace);
    expect((await run("s-verify")).profileId).toBe("Profile 2");
    expect((await run("s-verify")).profileId).toBe("Profile 2"); // 두 번째 호출: 만들 때의 프로필을 그대로 이어 쓴다
    await expect(run("broken")).rejects.toThrow("EGO_BACKEND_DOWN");
  });

  test("session ids that differ only at the end never share a space", () => {
    expect(spaceName(UUID_A, "user")).not.toBe(spaceName(UUID_B, "user"));
    expect(spaceName(UUID_A, "user")).not.toBe(spaceName(UUID_A, "verify"));
  });

  test("rejects an empty script and an unknown profile before launching ego", async () => {
    const { exec, calls } = fakeExec(ok(""));
    await expect(runEgoBrowser({ script: "  \n" }, { exec, sessionId: "s" })).rejects.toThrow("비어");
    await expect(runEgoBrowser({ script: "1", profile: "other" as never }, { exec, sessionId: "s" })).rejects.toThrow("profile");
    expect(calls).toHaveLength(0);
  });

  test("bounds the timeout", async () => {
    const { exec, calls } = fakeExec(ok(""));
    await runEgoBrowser({ script: "1", timeoutMs: 99_999_999 }, { exec, sessionId: "s" });
    await runEgoBrowser({ script: "1", timeoutMs: -5 }, { exec, sessionId: "s" });
    expect(calls.map((call) => call.timeoutMs)).toEqual([600_000, 120_000]);
  });
});

describe("runEgoBrowser results", () => {
  test("exit 127 and a missing executable both say ego lite is unavailable and point at the normal browser tool", async () => {
    const wrapper = fakeExec({ code: 127, stdout: "", stderr: "ego-browser: ego lite가 설치돼 있지 않다", killed: false });
    await expect(runEgoBrowser({ script: "1" }, { exec: wrapper.exec, sessionId: "s" })).rejects.toThrow(/ego lite가 없다[\s\S]*`browser` 도구[\s\S]*설치돼 있지 않다/);
    const noisy = fakeExec({ code: 127, stdout: "wrapper said this on stdout", stderr: "", killed: false });
    await expect(runEgoBrowser({ script: "1" }, { exec: noisy.exec, sessionId: "s" })).rejects.toThrow("wrapper said this on stdout");
    const missing = fakeExec(Object.assign(new Error("spawn ego-browser ENOENT"), { code: "ENOENT" }));
    await expect(runEgoBrowser({ script: "1" }, { exec: missing.exec, sessionId: "s" })).rejects.toThrow("`browser` 도구");
  });

  test("a nonzero exit surfaces stderr and stdout; other errors pass through", async () => {
    const { exec } = fakeExec({ code: 1, stdout: "partial", stderr: "SyntaxError: boom", killed: false });
    await expect(runEgoBrowser({ script: "1" }, { exec, sessionId: "s" })).rejects.toThrow(/exit 1[\s\S]*partial[\s\S]*SyntaxError: boom/);
    const failing = fakeExec(new Error("EPERM"));
    await expect(runEgoBrowser({ script: "1" }, { exec: failing.exec, sessionId: "s" })).rejects.toThrow("EPERM");
  });

  test("a killed run reports the timeout and that the space may remain", async () => {
    const { exec } = fakeExec({ code: -1, stdout: "", stderr: "", killed: true });
    await expect(runEgoBrowser({ script: "1", timeoutMs: 5000 }, { exec, sessionId: "s" })).rejects.toThrow(/5초[\s\S]*남아 있을 수 있다/);
  });

  test("success returns the space label, stdout, and marks a finished space; long output keeps head and tail", async () => {
    const long = `HEAD${"x".repeat(60_000)}TAIL`;
    const { exec } = fakeExec(ok(long, "warn"));
    const run = await runEgoBrowser({ script: "1", profile: "verify", finish: true }, { exec, sessionId: "s" });
    expect(run.finished).toBe(true);
    expect(run.text).toContain("Profile 2");
    expect(run.text).toContain("정리됨");
    expect(run.text).toContain("HEAD");
    expect(run.text).toContain("TAIL");
    expect(run.text).toContain("생략");
    expect(run.text).toContain("\nwarn");
    expect(run.text).not.toContain("[stderr]");
    expect(run.text.length).toBeLessThan(30_000);
  });
});

// 세션 도구 수준: 실제 팩토리에 가짜 ego 실행기를 주입해 execute와 shutdown 정리를 끝까지 돌린다.
describe("session tool lifecycle", () => {
  const chain: any = new Proxy(() => chain, { get: () => chain, apply: () => chain });
  const pi = { zod: { object: () => chain, string: () => chain, enum: () => chain, boolean: () => chain, number: () => chain } } as any;
  const ctx = (id: string) => ({ sessionManager: { getSessionId: () => id } }) as any;
  const shutdown = { reason: "shutdown", previousSessionFile: undefined } as const;

  function setup(results: (ExecResult | Error)[] = []) {
    const calls: string[] = [];
    const exec: Exec = async (_args, input) => {
      calls.push(input);
      const next = results.shift() ?? ok("");
      if (next instanceof Error) throw next;
      return next;
    };
    return { tool: createFactory(exec)(pi) as any, calls };
  }
  const cleanups = (calls: string[]) => calls.filter((input) => input.includes("listTaskSpaces"));

  test("a space left open is cleaned at shutdown, once per profile, by name", async () => {
    const { tool, calls } = setup();
    await tool.execute("1", { script: "1" }, undefined, ctx(UUID_A));
    await tool.execute("2", { script: "2", profile: "verify" }, undefined, ctx(UUID_A));
    await tool.onSession(shutdown, ctx(UUID_A));
    const cleaned = cleanups(calls);
    expect(cleaned).toHaveLength(2);
    expect(cleaned.some((input) => input.includes(`"cuelo-${UUID_A}-user"`))).toBe(true);
    expect(cleaned.some((input) => input.includes(`"cuelo-${UUID_A}-verify"`))).toBe(true);
    await tool.onSession(shutdown, ctx(UUID_A));
    expect(cleanups(calls)).toHaveLength(2);
  });

  test("finish:true leaves nothing to clean, and other lifecycle events never clean", async () => {
    const { tool, calls } = setup();
    await tool.execute("1", { script: "1", finish: true }, undefined, ctx(UUID_A));
    await tool.onSession({ reason: "switch", previousSessionFile: "x" }, ctx(UUID_A));
    await tool.onSession(shutdown, ctx(UUID_A));
    expect(cleanups(calls)).toHaveLength(0);
  });

  test("a first call that fails or times out after creating the space is still cleaned", async () => {
    const { tool, calls } = setup([{ code: 1, stdout: "", stderr: "boom", killed: false }, { code: -1, stdout: "", stderr: "", killed: true }]);
    await expect(tool.execute("1", { script: "1" }, undefined, ctx(UUID_A))).rejects.toThrow("exit 1");
    await expect(tool.execute("2", { script: "2", profile: "verify", finish: true }, undefined, ctx(UUID_A))).rejects.toThrow("중단");
    await tool.onSession(shutdown, ctx(UUID_A));
    expect(cleanups(calls)).toHaveLength(2);
  });

  test("a failing cleanup does not break shutdown", async () => {
    const { tool } = setup([ok(""), Object.assign(new Error("gone"), { code: "ENOENT" })]);
    await tool.execute("1", { script: "1" }, undefined, ctx(UUID_A));
    await expect(tool.onSession(shutdown, ctx(UUID_A))).resolves.toBeUndefined();
  });

  test("the cleanup script closes only agent-created, still agent-held spaces and never creates one", async () => {
    // ownership 값은 ego 0.6.0.16 실측: 기본 "agent", task.handOff() 뒤 "agentDelegatedToUser".
    const run = async (spaces: object[]) => {
      const log: string[] = [];
      const created: string[] = [];
      const taskSpace = async (id: unknown) => { created.push(String(id)); return { finish: async () => { log.push(`finish:${id}`); } }; };
      const listTaskSpaces = async () => spaces;
      const output: string[] = [];
      const fakeConsole = { log: (...parts: unknown[]) => { output.push(parts.join(" ")); } };
      await new Function("taskSpace", "listTaskSpaces", "console", `return (async () => { ${buildCleanup("target")} })()`)(taskSpace, listTaskSpaces, fakeConsole);
      return { log, created, output: output.join("|") };
    };
    const base = { name: "target", id: 7, createdBy: "agent", ownership: "agent" };
    expect((await run([base, { ...base, name: "other", id: 8 }])).log).toEqual(["finish:7"]);
    for (const skipped of [{ ownership: "agentDelegatedToUser" }, { createdBy: "user", ownership: "user" }, { ownership: "user" }]) {
      const result = await run([{ ...base, ...skipped }]);
      expect(result.log).toEqual([]);
      expect(result.created).toEqual([]);
      expect(result.output).toContain("skipped");
    }
    const missing = await run([{ ...base, name: "unrelated" }]);
    expect(missing.created).toEqual([]);
    expect(missing.output).toContain("not found");
  });
});

describe("defaultExec with a stand-in ego-browser on PATH", () => {
  const dir = mkdtempSync(join(tmpdir(), "ego-exec-"));
  const originalPath = process.env.PATH;
  afterAll(() => {
    process.env.PATH = originalPath;
    rmSync(dir, { recursive: true, force: true });
  });
  function installStandIn(body: string): void {
    const file = join(dir, "ego-browser");
    writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(file, 0o755);
    process.env.PATH = `${dir}:${originalPath}`;
  }

  test("feeds the script through stdin and returns the child's streams and exit code", async () => {
    installStandIn('echo "args:$*"; cat; echo oops >&2; exit 3');
    const result = await defaultExec(["nodejs"], "한글 script\nline2", { timeoutMs: 5000 });
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("args:nodejs\n한글 script\nline2");
    expect(result.stderr).toBe("oops\n");
    expect(result.killed).toBe(false);
  });

  test("kills a run that outlives its timeout", async () => {
    installStandIn("exec sleep 30");
    const started = Date.now();
    const result = await defaultExec(["nodejs"], "", { timeoutMs: 200 });
    expect(result.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("settles at the timeout even when a descendant keeps the pipes open, and kills the whole process group", async () => {
    // 하위 프로세스를 PID로만 식별한다: 같은 명령을 쓰는 다른 프로세스가 있어도 결과가 바뀌지 않는다.
    const pidFile = join(dir, "descendant.pid");
    installStandIn(`sleep 6 &\necho $! > "${pidFile}"\nwait\necho late`);
    const started = Date.now();
    const result = await defaultExec(["nodejs"], "", { timeoutMs: 300 });
    expect(result.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let waited = 0; alive() && waited < 1000; waited += 20) await Bun.sleep(20);
    expect(alive()).toBe(false);
  });

  test("an abort signal stops the run the same way", async () => {
    installStandIn("sleep 6\necho late");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    const result = await defaultExec(["nodejs"], "", { timeoutMs: 20_000, signal: controller.signal });
    expect(result.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a missing executable rejects with ENOENT so the tool can report ego lite as unavailable", async () => {
    process.env.PATH = dir;
    rmSync(join(dir, "ego-browser"), { force: true });
    await expect(defaultExec(["nodejs"], "", { timeoutMs: 1000 })).rejects.toMatchObject({ code: "ENOENT" });
  });
});
