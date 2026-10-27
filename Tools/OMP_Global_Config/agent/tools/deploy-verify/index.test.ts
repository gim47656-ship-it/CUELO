import { describe, expect, test } from "bun:test";
import {
  buildVerdict, checkHealth, checkLaunchStatus, checkRoles, checkUpdateLog, compareRoles, liveRoleSelectors, newestUpdateLog,
  parseHealth, parseLaunchStatus, parseModelRoles, parseReadyRevision, revisionMatches, runDeployVerify,
  type Exec, type ExecResult, type VerifyDeps,
} from "./index";

const FULL = "e76beacb5d4507b20d224c11e93b336e74cc4395";
const HOME = "/home/user";

// 실제 update.sh 로그의 끝 부분 모양이다(READY 줄 앞에 `WSL_CUELO_READY` 줄이 있다).
const updateLog = [
  "WSL_CUELO_READY http://127.0.0.1:30141 home=/home/user",
  "2026-10-27T14:23:05Z CLEANUP succeeded removed=20/20 kept=0",
  "2026-10-27T14:23:12Z HELPER rebuilt e76beacb5d45 verified: windows=5",
  `2026-10-27T14:23:12Z READY ${FULL} OK   web 127.0.0.1:30141 GET /api/update-maintenance -> 200 OK   usage 127.0.0.1:30142 OPTIONS /usage -> 204`,
].join("\n");

const healthOk = [
  "OK   web 127.0.0.1:30141 GET /api/update-maintenance -> 200",
  "OK   usage 127.0.0.1:30142 OPTIONS /usage -> 204",
  "OK   btw 127.0.0.1:30143 GET /health -> 200",
  "OK   subagent 127.0.0.1:30144 GET /health -> 200",
].join("\n");

const configYaml = [
  "# comment",
  "modelRoles:",
  "  # 주석 줄",
  "  default: anthropic/claude-opus-5-5",
  "  implSonnet: anthropic/claude-sonnet-5-5:auto # 뒤 주석",
  "  quoted: \"openai/gpt-6\"",
  "",
  "  smol: anthropic/claude-fable-5-1",
  "other:",
  "  default: not-a-role",
].join("\n");

const liveBody = {
  models: { "a:b": "B" },
  roles: [
    { role: "default", selector: "anthropic/claude-opus-5-5", resolved: {} },
    { role: "implSonnet", selector: "anthropic/claude-sonnet-5-5:auto" },
    { role: "quoted", selector: "openai/gpt-6" },
    { role: "smol", selector: "anthropic/claude-fable-5-1" },
    { role: "widget", source: "default" },
  ],
};

const ok = (stdout: string, code = 0): ExecResult => ({ code, stdout });

interface Fake {
  deps: VerifyDeps;
  calls: { command: string; args: string[] }[];
  urls: string[];
}

function fake(overrides: Partial<{
  files: Record<string, string>;
  dir: string[] | undefined;
  launch: ExecResult | Error;
  health: ExecResult | Error;
  response: { status: number; text: string } | Error;
  envDistro: string;
}> = {}): Fake {
  const calls: Fake["calls"] = [];
  const urls: string[] = [];
  const files: Record<string, string> = {
    [`${HOME}/.omp/wsl-update/20261027T142014Z.log`]: updateLog,
    [`${HOME}/.omp/agent/config.yml`]: configYaml,
    ...overrides.files,
  };
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    if (command === "wslpath") return ok("\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\cuelo-run\\launch.ps1\n");
    if (command === "powershell.exe") {
      const result = overrides.launch ?? ok(JSON.stringify({ distribution: "Ubuntu-24.04", matched: true }));
      if (result instanceof Error) throw result;
      return result;
    }
    const result = overrides.health ?? ok(healthOk);
    if (result instanceof Error) throw result;
    return result;
  };
  const deps: VerifyDeps = {
    exec,
    readText: async (path) => files[path],
    listDir: async () => ("dir" in overrides ? overrides.dir : ["20261027T113911Z.log", "20261027T142014Z.log", "update.lock"]),
    get: async (url) => {
      urls.push(url);
      const response = overrides.response ?? { status: 200, text: JSON.stringify(liveBody) };
      if (response instanceof Error) throw response;
      return response;
    },
    home: HOME,
    envDistro: overrides.envDistro,
    portBase: 30141,
  };
  return { deps, calls, urls };
}

describe("update log", () => {
  test("parses the last READY line and ignores WSL_CUELO_READY", () => {
    expect(parseReadyRevision(updateLog)).toBe(FULL);
    expect(parseReadyRevision("WSL_CUELO_READY http://x\nno ready here")).toBeNull();
  });

  test("matches full revision and a 7+ char prefix, rejects wrong or too short", () => {
    expect(revisionMatches(FULL, FULL)).toBe(true);
    expect(revisionMatches("e76beac", FULL)).toBe(true);
    expect(revisionMatches("E76BEAC", FULL)).toBe(true);
    expect(revisionMatches("0000000", FULL)).toBe(false);
    expect(revisionMatches("e76bea", FULL)).toBe(false);
  });

  test("picks the newest timestamped log and skips update.lock", () => {
    expect(newestUpdateLog(["update.lock", "20261027T113911Z.log", "20261027T142014Z.log", "notes.log"])).toBe("20261027T142014Z.log");
    expect(newestUpdateLog(["update.lock"])).toBeUndefined();
  });

  test("reports matches true for a prefix and false for the wrong revision", async () => {
    const f = fake();
    expect(await checkUpdateLog("e76beac", f.deps)).toEqual({
      file: `${HOME}/.omp/wsl-update/20261027T142014Z.log`, readyRevision: FULL, matches: true,
    });
    const wrong = await checkUpdateLog("0000000", f.deps);
    expect(wrong.matches).toBe(false);
    expect(wrong.readyRevision).toBe(FULL);
  });

  test("reports its own error for a log without READY, a missing folder and a bad revision", async () => {
    const noReady = fake({ files: { [`${HOME}/.omp/wsl-update/20261027T142014Z.log`]: "WSL_CUELO_READY x\nFAILED" } });
    expect(await checkUpdateLog(FULL, noReady.deps)).toMatchObject({ matches: false, readyRevision: null, error: expect.stringContaining("READY") });
    expect(await checkUpdateLog(FULL, fake({ dir: undefined }).deps)).toMatchObject({ matches: false, error: expect.stringContaining("폴더") });
    expect(await checkUpdateLog("xyz", fake().deps)).toMatchObject({ matches: false, error: expect.stringContaining("revision") });
  });
});

describe("launch status", () => {
  test("parses matched true/false JSON, including the exit-3 mismatch output", () => {
    expect(parseLaunchStatus('{\n  "port": 30141,\n  "matched": true\n}')).toMatchObject({ matched: true, raw: { port: 30141 } });
    expect(parseLaunchStatus('{"matched": false}')).toMatchObject({ matched: false });
    expect(parseLaunchStatus("garbage")).toMatchObject({ matched: false, error: expect.stringContaining("JSON") });
    expect(parseLaunchStatus("{not json}")).toMatchObject({ matched: false, error: expect.stringContaining("해석") });
  });

  test("always passes -Status, converts the path with wslpath, and adds -Distribution only when known", async () => {
    const f = fake();
    expect(await checkLaunchStatus(f.deps, "Ubuntu")).toMatchObject({ matched: true });
    expect(f.calls[0]).toEqual({ command: "wslpath", args: ["-w", `${HOME}/cuelo-run/Tools/CUELO_Setup/wsl/launch.ps1`] });
    const ps = f.calls[1];
    expect(ps.command).toBe("powershell.exe");
    expect(ps.args).toContain("-Status");
    expect(ps.args).not.toContain("-Run");
    expect(ps.args.slice(ps.args.indexOf("-Distribution"))).toEqual(["-Distribution", "Ubuntu"]);
    expect(ps.args[ps.args.indexOf("-File") + 1]).toBe("\\\\wsl.localhost\\Ubuntu-24.04\\home\\u\\cuelo-run\\launch.ps1");

    const none = fake();
    await checkLaunchStatus(none.deps, undefined);
    expect(none.calls[1].args).not.toContain("-Distribution");
  });

  test("reports matched false for exit 3 JSON and an error when powershell fails to run", async () => {
    const mismatch = fake({ launch: ok('{"matched": false, "observedHome": "/home/example"}', 3) });
    expect(await checkLaunchStatus(mismatch.deps, undefined)).toMatchObject({ matched: false, raw: { observedHome: "/home/example" } });
    const broken = fake({ launch: new Error("spawn powershell.exe ENOENT") });
    expect(await checkLaunchStatus(broken.deps, undefined)).toMatchObject({ matched: false, error: expect.stringContaining("ENOENT") });
  });

  test("does not trust status JSON when the run failed, was killed or the exit code contradicts it", async () => {
    const crashed = await checkLaunchStatus(fake({ launch: ok('{"matched": true}', 1) }).deps, undefined);
    expect(crashed).toMatchObject({ matched: false, error: expect.stringContaining("exit 1") });
    const killed = await checkLaunchStatus(fake({ launch: { code: 0, stdout: '{"matched": true}', killed: true } }).deps, undefined);
    expect(killed).toMatchObject({ matched: false, error: expect.stringContaining("killed") });
    const contradicts = await checkLaunchStatus(fake({ launch: ok('{"matched": false}', 0) }).deps, undefined);
    expect(contradicts).toMatchObject({ matched: false, error: expect.stringContaining("exit 3") });
  });
});

describe("health", () => {
  test("counts 4/4 and partial results from OK/FAIL lines", async () => {
    expect(parseHealth(healthOk)).toMatchObject({ ok: 4, total: 4 });
    const partial = healthOk.replace("OK   btw", "FAIL btw").replace("-> 200\nOK   subagent", "-> ECONNREFUSED\nOK   subagent");
    expect(await checkHealth(fake({ health: ok(partial, 1) }).deps)).toMatchObject({ ok: 3, total: 4 });
    expect(await checkHealth(fake().deps)).toMatchObject({ ok: 4, total: 4 });
  });

  test("reports an error when there are no health lines", async () => {
    expect(await checkHealth(fake({ health: ok("", 2) }).deps)).toMatchObject({ ok: 0, total: 0, error: expect.stringContaining("exit 2") });
    expect(await checkHealth(fake({ health: new Error("boom") }).deps)).toMatchObject({ total: 0, error: expect.stringContaining("boom") });
  });

  test("a run that dies or is killed after printing some OK lines is an error, not a pass", async () => {
    const crashed = await checkHealth(fake({ health: ok("OK   web 127.0.0.1:30141 GET /api/update-maintenance -> 200", 1) }).deps);
    expect(crashed).toMatchObject({ ok: 1, total: 1, error: expect.stringContaining("exit 1") });
    const killed = await checkHealth(fake({ health: { code: 0, stdout: healthOk, killed: true } }).deps);
    expect(killed.error).toContain("killed");
    const verdict = await runDeployVerify({ revision: FULL, cwd: "/w" }, fake({ health: ok("OK   web 127.0.0.1:30141 GET / -> 200", 1) }).deps);
    expect(verdict.pass).toBe(false);
    expect(verdict.verdict).toContain("health:");
  });
});

describe("roles", () => {
  test("parses only the modelRoles block, dropping comments and quotes", () => {
    expect(parseModelRoles(configYaml)).toEqual({
      default: "anthropic/claude-opus-5-5",
      implSonnet: "anthropic/claude-sonnet-5-5:auto",
      quoted: "openai/gpt-6",
      smol: "anthropic/claude-fable-5-1",
    });
  });

  test("reads quoted role keys and refuses non-string role values instead of dropping them", async () => {
    expect(parseModelRoles('modelRoles:\n  default: provider/a\n  "smol": provider/b\n')).toEqual({ default: "provider/a", smol: "provider/b" });
    const nested = fake({ files: { [`${HOME}/.omp/agent/config.yml`]: "modelRoles:\n  default: anthropic/claude-opus-5-5\n  smol:\n    model: x\n" } });
    expect(await checkRoles("/w", nested.deps)).toEqual({ error: expect.stringContaining("modelRoles.smol") });
    expect(nested.urls).toEqual([]);
  });

  test("reads roles from the array shape and rejects a non-array", () => {
    expect(liveRoleSelectors(liveBody)).toEqual({
      default: "anthropic/claude-opus-5-5", implSonnet: "anthropic/claude-sonnet-5-5:auto", quoted: "openai/gpt-6", smol: "anthropic/claude-fable-5-1",
    });
    expect(() => liveRoleSelectors({ roles: { default: "x" } })).toThrow("배열");
    expect(() => liveRoleSelectors(null)).toThrow("배열");
  });

  test("compare lists a changed role and a role missing live, but not live-only roles", () => {
    const result = compareRoles({ a: "x", b: "y", c: "z" }, { a: "x", b: "other", extra: "q" });
    expect(result.configured).toBe(3);
    expect(result.mismatches).toEqual([{ role: "b", config: "y", live: "other" }, { role: "c", config: "z", live: null }]);
  });

  test("end to end: no mismatch, then one mismatch, with cwd URL-encoded", async () => {
    const same = fake();
    expect(await checkRoles("/home/user/my proj", same.deps)).toEqual({ configured: 4, mismatches: [] });
    expect(same.urls).toEqual(["http://127.0.0.1:30141/api/models?cwd=%2Fhome%2Fuser%2Fmy%20proj"]);

    const drift = { ...liveBody, roles: liveBody.roles.map((r) => (r.role === "smol" ? { ...r, selector: "anthropic/other" } : r)) };
    const f = fake({ response: { status: 200, text: JSON.stringify(drift) } });
    expect(await checkRoles("/home/user", f.deps)).toEqual({
      configured: 4, mismatches: [{ role: "smol", config: "anthropic/claude-fable-5-1", live: "anthropic/other" }],
    });
  });

  test("missing cwd returns an explicit 403 message without calling the server", async () => {
    const f = fake();
    for (const cwd of [undefined, "", "  "]) {
      const roles = await checkRoles(cwd, f.deps);
      expect(roles).toEqual({ error: expect.stringContaining("403") });
      expect("error" in roles && roles.error).toContain("cwd");
    }
    expect(f.urls).toEqual([]);
  });

  test("reports server 403, other HTTP errors, connection errors and bad shapes as section errors", async () => {
    const denied = await checkRoles("/x", fake({ response: { status: 403, text: '{"error":"Access denied"}' } }).deps);
    expect(denied).toEqual({ error: expect.stringContaining("403") });
    expect(await checkRoles("/x", fake({ response: { status: 500, text: "oops" } }).deps)).toEqual({ error: expect.stringContaining("HTTP 500") });
    expect(await checkRoles("/x", fake({ response: new Error("ECONNREFUSED") }).deps)).toEqual({ error: expect.stringContaining("ECONNREFUSED") });
    expect(await checkRoles("/x", fake({ response: { status: 200, text: JSON.stringify({ models: [] }) } }).deps)).toEqual({ error: expect.stringContaining("roles") });
    expect(await checkRoles("/x", fake({ files: { [`${HOME}/.omp/agent/config.yml`]: "foo: 1" } }).deps)).toEqual({ error: expect.stringContaining("modelRoles") });
  });
});

describe("runDeployVerify", () => {
  test("passes when all four sections agree and runs only the three allowed commands", async () => {
    const f = fake({ envDistro: "Ubuntu-24.04" });
    const result = await runDeployVerify({ revision: "e76beac", cwd: "/home/user" }, f.deps);
    expect(result.pass).toBe(true);
    expect(result.verdict).toStartWith("PASS");
    expect(result.updateLog.matches).toBe(true);
    expect(result.launchStatus.matched).toBe(true);
    expect(result.health).toMatchObject({ ok: 4, total: 4 });
    expect(result.roles).toEqual({ configured: 4, mismatches: [] });
    expect(f.calls.map((c) => c.command).sort()).toEqual(["node", "powershell.exe", "wslpath"]);
    expect(f.calls.find((c) => c.command === "powershell.exe")?.args).toEqual(expect.arrayContaining(["-Status", "-Distribution", "Ubuntu-24.04"]));
    expect(f.calls.find((c) => c.command === "node")?.args).toEqual([`${HOME}/cuelo-run/install.mjs`, "health"]);
  });

  test("a wrong revision, partial health and a mismatch each surface in the verdict without throwing", async () => {
    const f = fake({ health: ok(healthOk.replace("OK   btw", "FAIL btw"), 1), launch: ok('{"matched": false}', 3) });
    const result = await runDeployVerify({ revision: "0000000" }, f.deps);
    expect(result.pass).toBe(false);
    expect(result.updateLog.matches).toBe(false);
    expect(result.verdict).toContain("updateLog");
    expect(result.verdict).toContain("launchStatus");
    expect(result.verdict).toContain("health: 3/4");
    expect(result.verdict).toContain("roles: cwd가 필요합니다");
  });

  test("verdict names mismatched roles", () => {
    const { pass, verdict } = buildVerdict({
      updateLog: { readyRevision: FULL, matches: true },
      launchStatus: { matched: true },
      health: { ok: 4, total: 4 },
      roles: { configured: 4, mismatches: [{ role: "smol", config: "a", live: "b" }] },
    });
    expect(pass).toBe(false);
    expect(verdict).toContain("1/4");
    expect(verdict).toContain("smol");
  });
});
