import { describe, expect, test } from "bun:test";
import { checkLaunchStatus, detectHostKind, runDeployVerify, type Exec, type ExecResult, type VerifyDeps } from "./index";

const HOME = "/home/user";
const FULL = "e76beacb5d4507b20d224c11e93b336e74cc4395";
const SCRIPT = `${HOME}/cuelo-run/Tools/CUELO_Setup/linux/launch.sh`;
const healthOk = [
  "OK   web 127.0.0.1:30141 GET /api/update-maintenance -> 200",
  "OK   usage 127.0.0.1:30142 OPTIONS /usage -> 204",
  "OK   btw 127.0.0.1:30143 GET /health -> 200",
  "OK   subagent 127.0.0.1:30144 GET /health -> 200",
].join("\n");
const matchedJson = JSON.stringify({ host: "linux", unit: "cuelo-30141", port: 30141, active: "active", expectedHome: HOME, observedHome: HOME, matched: true });

function nativeDeps(launch: ExecResult | Error = { code: 0, stdout: matchedJson }) {
  const calls: { command: string; args: string[] }[] = [];
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    if (command === "bash") {
      if (launch instanceof Error) throw launch;
      return launch;
    }
    if (command === "node") return { code: 0, stdout: healthOk };
    throw new Error(`unexpected command ${command}`);
  };
  const deps: VerifyDeps = {
    exec,
    readText: async (path) => ({
      [`${HOME}/.omp/wsl-update/20261101T120000Z.log`]: `2026-11-01T12:00:00Z READY ${FULL} OK web`,
      [`${HOME}/.omp/agent/config.yml`]: "modelRoles:\n  default: anthropic/claude-opus-5-5\n",
    })[path],
    listDir: async () => ["20261101T120000Z.log"],
    get: async () => ({ status: 200, text: JSON.stringify({ roles: [{ role: "default", selector: "anthropic/claude-opus-5-5" }] }) }),
    home: HOME,
    // 네이티브에는 배포판이 없지만 값이 있어도 무시해야 한다.
    envDistro: "Ubuntu-24.04",
    portBase: 30141,
    hostKind: "linux",
  };
  return { deps, calls };
}

describe("host kind", () => {
  test("any one WSL signal means wsl; none means native linux", () => {
    expect(detectHostKind({ WSL_INTEROP: "/run/WSL/1_interop" }, false)).toBe("wsl");
    expect(detectHostKind({ WSL_DISTRO_NAME: "Ubuntu" }, false)).toBe("wsl");
    expect(detectHostKind({}, true)).toBe("wsl");
    expect(detectHostKind({ WSL_INTEROP: "", WSL_DISTRO_NAME: "" }, false)).toBe("linux");
  });
});

describe("native launch status", () => {
  test("runs only `bash linux/launch.sh status --port-base`, never wslpath or powershell", async () => {
    const f = nativeDeps();
    expect(await checkLaunchStatus(f.deps, "Ubuntu-24.04")).toMatchObject({ matched: true, raw: { host: "linux", observedHome: HOME } });
    expect(f.calls).toEqual([{ command: "bash", args: [SCRIPT, "status", "--port-base", "30141"] }]);
  });

  test("exit 3 with matched:false is a clean mismatch; contradicting codes and spawn errors are errors", async () => {
    const mismatch = await checkLaunchStatus(nativeDeps({ code: 3, stdout: '{"matched": false, "active": "inactive"}' }).deps, undefined);
    expect(mismatch).toEqual({ matched: false, raw: { matched: false, active: "inactive" } });
    const contradicts = await checkLaunchStatus(nativeDeps({ code: 0, stdout: '{"matched": false}' }).deps, undefined);
    expect(contradicts).toMatchObject({ matched: false, error: expect.stringContaining("linux/launch.sh status") });
    const crashed = await checkLaunchStatus(nativeDeps({ code: 2, stdout: "usage: launch.sh" }).deps, undefined);
    expect(crashed).toMatchObject({ matched: false, error: expect.stringContaining("exit 2") });
    const missing = await checkLaunchStatus(nativeDeps(new Error("spawn bash ENOENT")).deps, undefined);
    expect(missing).toMatchObject({ matched: false, error: expect.stringContaining("ENOENT") });
  });

  test("a native deploy passes end to end with only bash and node executed", async () => {
    const f = nativeDeps();
    const result = await runDeployVerify({ revision: FULL.slice(0, 12), cwd: `${HOME}/src/CUELO-private` }, f.deps);
    expect(result.pass).toBe(true);
    expect(f.calls.map((c) => c.command).sort()).toEqual(["bash", "node"]);
  });
});
