import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommandArgs, buildOnVm, quoteWindowsArg, resolveVmProject, summarizeTests } from "./build";
import { parseCliArgs, parseConfig, runVmBuild, withLock } from "./index";
import { encodeRemoteScript, parseRemoteResult, RESULT_MARKER, runProcess, type RunOptions, type RunResult, type Runner } from "./remote";
import { Blocked, decideSync, scpRemotePath, type VmState } from "./sync";

const A = "a".repeat(40);
const B = "b".repeat(40);
const S = "5".repeat(40);

function vm(overrides: Partial<VmState> = {}): VmState {
  return { head: A, branch: "main", branchTip: A, snapshotRef: "", status: "", statusCode: 0, has: [], temp: "C:\\T", localAppData: "C:\\L", ...overrides };
}

describe("decideSync", () => {
  test("clean VM behind Linux fast-forwards and asks for a pack only when the tip is missing", () => {
    expect(decideSync({ branch: "main", commit: B, vm: vm(), ancestry: "ancestor" }))
      .toEqual({ kind: "apply", leaveSnapshot: false, clearSnapshotRef: false, needPack: true });
    expect(decideSync({ branch: "main", commit: B, vm: vm({ has: [B] }), ancestry: "ancestor" }))
      .toMatchObject({ kind: "apply", needPack: false });
  });

  test("VM already at the Linux commit is current; at the same snapshot too", () => {
    expect(decideSync({ branch: "main", commit: A, vm: vm(), ancestry: "equal" })).toEqual({ kind: "current" });
    expect(decideSync({ branch: "main", commit: A, snapshot: S, vm: vm({ head: S, branch: "", snapshotRef: S }), ancestry: "equal" }))
      .toEqual({ kind: "current" });
  });

  test("dirty VM, failed status, other branch, missing branch and foreign detached HEAD all block", () => {
    expect(decideSync({ branch: "main", commit: B, vm: vm({ status: "?? out.txt" }), ancestry: "ancestor" })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("out.txt") });
    expect(decideSync({ branch: "main", commit: B, vm: vm({ statusCode: 128, status: "fatal" }), ancestry: "ancestor" }).kind).toBe("blocked");
    expect(decideSync({ branch: "main", commit: B, vm: vm({ branch: "dev" }), ancestry: "ancestor" })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("dev") });
    expect(decideSync({ branch: "main", commit: B, vm: vm({ branchTip: "" }) }).kind).toBe("blocked");
    expect(decideSync({ branch: "main", commit: B, vm: vm({ branch: "", head: B, snapshotRef: S }), ancestry: "ancestor" }))
      .toMatchObject({ kind: "blocked", reason: expect.stringContaining("detached") });
  });

  test("VM history Linux does not have, or a VM branch ahead of Linux, blocks", () => {
    expect(decideSync({ branch: "main", commit: B, vm: vm(), ancestry: "unknown-commit" })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("Linux에 없는 커밋") });
    expect(decideSync({ branch: "main", commit: B, vm: vm(), ancestry: "diverged" })).toMatchObject({ kind: "blocked", reason: expect.stringContaining("조상이 아니다") });
  });

  test("leaving the tool's own snapshot returns to the branch and clears the ref in commit mode", () => {
    const fromSnapshot = vm({ branch: "", head: S, snapshotRef: S, has: [B] });
    expect(decideSync({ branch: "main", commit: B, vm: fromSnapshot, ancestry: "ancestor" }))
      .toEqual({ kind: "apply", leaveSnapshot: true, clearSnapshotRef: true, needPack: false });
    expect(decideSync({ branch: "main", commit: A, snapshot: S, vm: vm(), ancestry: "equal" }))
      .toEqual({ kind: "apply", leaveSnapshot: false, clearSnapshotRef: false, needPack: true });
  });
});

describe("resolveVmProject", () => {
  test("maps a repo-relative path with spaces under the VM root", () => {
    expect(resolveVmProject("D:\\HANSE", "B33/Orbit Vb/App.vbproj")).toEqual({ relative: "B33/Orbit Vb/App.vbproj", windows: "D:\\HANSE\\B33\\Orbit Vb\\App.vbproj" });
  });

  test("rejects paths that escape the repository or are not project files", () => {
    expect(() => resolveVmProject("D:\\HANSE", "../other/App.sln")).toThrow(Blocked);
    expect(() => resolveVmProject("D:\\HANSE", "a/../../App.sln")).toThrow(Blocked);
    expect(() => resolveVmProject("D:\\HANSE", "C:\\VDrive\\HANSE\\App.sln")).toThrow(Blocked);
    expect(() => resolveVmProject("D:\\HANSE", "/abs/App.sln")).toThrow(Blocked);
    expect(() => resolveVmProject("D:\\HANSE", "src/Form1.vb")).toThrow(Blocked);
  });
});

describe("buildCommandArgs", () => {
  test("msbuild defaults to one node and keeps the windows_build safety checks", () => {
    const args = buildCommandArgs({ project: "x" }, "D:\\r\\App.sln", "__LOG__");
    expect(args).toContain("-m:1");
    expect(args).not.toContain("-m");
    expect(args.at(-1)).toBe("D:\\r\\App.sln");
    expect(buildCommandArgs({ project: "x", maxCpuCount: 9 }, "p.sln", "__LOG__")).toContain("-m:4");
    expect(() => buildCommandArgs({ project: "x", target: "Publish" }, "p.sln", "__LOG__")).toThrow("Publish");
    expect(() => buildCommandArgs({ project: "x", msbuildProperties: { PostBuildEvent: "calc" } }, "p.sln", "__LOG__")).toThrow("PostBuildEvent");
  });

  test("dotnet test keeps console output, forwards properties and adds --no-restore unless restore is on", () => {
    const args = buildCommandArgs({ project: "x", action: "test", configuration: "Debug" }, "D:\\r\\T.csproj", "__LOG__");
    expect(args.slice(0, 2)).toEqual(["test", "D:\\r\\T.csproj"]);
    expect(args).toContain("-p:Configuration=Debug");
    expect(args).toContain("--no-restore");
    expect(args).not.toContain("-noconlog");
    expect(args.some((arg) => arg.startsWith("-flp:logfile=__LOG__"))).toBe(true);
    expect(buildCommandArgs({ project: "x", action: "test", restore: true }, "T.csproj", "__LOG__")).not.toContain("--no-restore");
  });

  test("test needs dotnet and refuses targets", () => {
    expect(() => buildCommandArgs({ project: "x", action: "test", engine: "msbuild" }, "T.csproj", "__LOG__")).toThrow(Blocked);
    expect(() => buildCommandArgs({ project: "x", action: "test", target: "Rebuild" }, "T.csproj", "__LOG__")).toThrow(Blocked);
  });
});

describe("quoteWindowsArg", () => {
  test("quotes spaces and escapes quotes and trailing backslashes per CreateProcess rules", () => {
    expect(quoteWindowsArg("-m:1")).toBe("-m:1");
    expect(quoteWindowsArg("D:\\a b\\App.sln")).toBe('"D:\\a b\\App.sln"');
    expect(quoteWindowsArg('-p:X=a "b"')).toBe('"-p:X=a \\"b\\""');
    expect(quoteWindowsArg("C:\\dir with space\\")).toBe('"C:\\dir with space\\\\"');
    expect(quoteWindowsArg("")).toBe('""');
  });
});

describe("remote transport", () => {
  test("the result line survives surrounding noise and carries Korean text", () => {
    const payload = Buffer.from(JSON.stringify({ path: "D:\\한세제어_원격저장소", n: 1 }), "utf8").toString("base64");
    const stdout = `#< CLIXML\nnoise\n${RESULT_MARKER}${payload}\r\n`;
    expect(parseRemoteResult<{ path: string; n: number }>({ code: 0, stdout, stderr: "", killed: false })).toEqual({ path: "D:\\한세제어_원격저장소", n: 1 });
  });

  test("a missing result line reports ssh exit and stderr", () => {
    expect(() => parseRemoteResult({ code: 255, stdout: "", stderr: "Connection refused", killed: false })).toThrow(/ssh exit 255.*Connection refused/);
  });

  test("parameters are embedded as UTF-8 base64, not as raw text in the script", () => {
    const script = Buffer.from(encodeRemoteScript("Emit $P", { repo: "D:\\한세'; rm" }), "base64").toString("utf16le");
    expect(script).not.toContain("한세");
    expect(script).toContain(Buffer.from(JSON.stringify({ repo: "D:\\한세'; rm" }), "utf8").toString("base64"));
  });

  test("scp target paths reject characters scp would reinterpret", () => {
    expect(scpRemotePath("C:\\Temp\\build-tmp\\x.pack")).toBe("C:/Temp/build-tmp/x.pack");
    expect(() => scpRemotePath("C:\\Temp\\a b\\x.pack")).toThrow(Blocked);
  });
});

describe("config and CLI", () => {
  test("config needs a host and absolute Linux / drive Windows paths", () => {
    expect(parseConfig('{"host":"winboat","repos":[{"linux":"/srv/src/r","vm":"D:\\\\r\\\\"}]}', "c")).toEqual({ host: "winboat", repos: [{ linux: "/srv/src/r", vm: "D:\\r" }] });
    expect(() => parseConfig('{"host":"winboat","repos":[{"linux":"r","vm":"D:\\\\r"}]}', "c")).toThrow(Blocked);
    expect(() => parseConfig('{"host":"winboat","repos":[{"linux":"/r","vm":"\\\\\\\\srv\\\\r"}]}', "c")).toThrow(Blocked);
    expect(() => parseConfig('{"host":"a b","repos":[{"linux":"/r","vm":"D:\\\\r"}]}', "c")).toThrow(Blocked);
    expect(() => parseConfig("{", "c")).toThrow(Blocked);
  });

  test("CLI flags map to parameters and repeated --property merges", () => {
    expect(parseCliArgs(["--repo", "/r", "--mode", "snapshot", "--project", "a b/App.sln", "--restore", "--property", "A=1;2", "--property", "B=x=y", "--max-cpu", "2", "--json"]))
      .toEqual({ json: true, params: { repo: "/r", mode: "snapshot", project: "a b/App.sln", restore: true, msbuildProperties: { A: "1;2", B: "x=y" }, maxCpuCount: 2 } });
    expect(() => parseCliArgs(["--repo"])).toThrow("usage");
    expect(() => parseCliArgs(["--bogus", "1"])).toThrow("usage");
  });
});

describe("summarizeTests", () => {
  test("keeps the dotnet test result lines only", () => {
    const text = "Build succeeded.\n  Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: 173 ms - X.dll (net10.0)\nother";
    expect(summarizeTests(text)).toEqual(["Passed!  - Failed:     0, Passed:     2, Skipped:     0, Total:     2, Duration: 173 ms - X.dll (net10.0)"]);
  });
});

describe("action and engine are checked at run time", () => {
  test("a dotnet verb other than build or test is refused before anything runs", () => {
    expect(() => buildCommandArgs({ project: "x", engine: "dotnet", action: "publish" as never }, "A.csproj", "__LOG__")).toThrow(Blocked);
    expect(() => buildCommandArgs({ project: "x", engine: "pwsh" as never }, "A.csproj", "__LOG__")).toThrow(Blocked);
  });
});

describe("withLock", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "vm-build-lock-"));

  test("a second caller is blocked while the first holds the lock, and can run once it is released", async () => {
    const d = dir();
    try {
      const entered = Promise.withResolvers<void>();
      const held = Promise.withResolvers<void>();
      const first = withLock(d, () => {
        entered.resolve();
        return held.promise;
      });
      await entered.promise;
      await expect(withLock(d, async () => "second")).rejects.toThrow(Blocked);
      held.resolve();
      await first;
      expect(await withLock(d, async () => "after")).toBe("after");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a lock file left behind with any content does not block the next run", async () => {
    const d = dir();
    try {
      writeFileSync(join(d, "lock"), "2147483646:dead");
      expect(await withLock(d, async () => "ran")).toBe("ran");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("a lock held by another process blocks, and is free again once that process exits", async () => {
    const d = dir();
    try {
      const module = new URL("./index.ts", import.meta.url).pathname;
      const child = Bun.spawn(["bun", "--no-install", "-e",
        `import { withLock } from ${JSON.stringify(module)}; await withLock(${JSON.stringify(d)}, async () => { console.log("held"); for await (const _ of Bun.stdin.stream()) {} });`],
        { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
      const reader = child.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("held");
      await expect(withLock(d, async () => "ran")).rejects.toThrow(Blocked);
      child.stdin.end();
      await child.exited;
      expect(await withLock(d, async () => "ran")).toBe("ran");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  test("many simultaneous callers never run work at the same time", async () => {
    const d = dir();
    try {
      let active = 0;
      let peak = 0;
      let settled = 0;
      const gate = Promise.withResolvers<void>();
      const callers = Array.from({ length: 8 }, () => withLock(d, async () => {
        active++;
        peak = Math.max(peak, active);
        await gate.promise;
        active--;
      }).then(() => "ran", (error) => { settled++; return error instanceof Blocked ? "blocked" : String(error); }));
      while (settled + active < callers.length) await new Promise((done) => setImmediate(done));
      gate.resolve();
      const results = await Promise.all(callers);
      expect(peak).toBe(1);
      expect(results.filter((item) => item === "ran")).toHaveLength(1);
      expect(results.filter((item) => item !== "ran").every((item) => item === "blocked")).toBe(true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("scripts sent to the VM", () => {
  // 2026-11-09: Bun rewrote non-ASCII text inside String.raw templates as literal \uXXXX, so the VM printed
  // "\uAC00 \uBC29…" instead of the Korean message. The scripts must reach PowerShell as written.
  test("the build script carries no literal \\u escapes", async () => {
    const scripts: string[] = [];
    const run: Runner = async (_command, args) => {
      scripts.push(Buffer.from(String(args.at(-1)).split(" ").at(-1) ?? "", "base64").toString("utf16le"));
      const payload = Buffer.from(JSON.stringify({ fatal: "stop" }), "utf8").toString("base64");
      return { code: 0, stdout: `${RESULT_MARKER}${payload}\n`, stderr: "", killed: false };
    };
    await expect(buildOnVm({ run, host: "vm", now: () => 0 }, "D:\\r", "a".repeat(40), { project: "App.sln" }, 60, 5)).rejects.toThrow(Blocked);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("Emit @{ fatal =");
    expect(scripts[0]).not.toMatch(/\\u[0-9A-Fa-f]{4}/);
  });
});

describe("cancellation (#82)", () => {
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", killed: false });
  const fromVm = (value: unknown): RunResult => ok(`${RESULT_MARKER}${Buffer.from(JSON.stringify(value), "utf8").toString("base64")}\n`);
  type OnCall = (label: string, controller: AbortController, options?: RunOptions) => Promise<RunResult> | undefined;

  /**
   * A fake VM one commit behind Linux that already holds the commit, so a run is inspect → apply → build with no pack.
   * `onCall` sees every command by label ("git status", "ssh apply", …) and may replace its result.
   */
  async function runAgainstFakeVm(onCall: OnCall) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "vm-build-cancel-")));
    const controller = new AbortController();
    const calls: { label: string; signal?: AbortSignal }[] = [];
    const run: Runner = async (command, args, options) => {
      // lowPriority() wraps git/scp in ionice/nice.
      const [tool, ...rest] = command === "git" || command === "ssh" ? [command, ...args] : args.slice(args.findIndex((arg) => arg === "git" || arg === "scp"));
      let label = tool;
      if (tool === "git") label = `git ${rest.includes("status") ? "status" : rest.includes("--show-toplevel") ? "toplevel" : rest[0]}`;
      if (tool === "ssh") {
        const script = Buffer.from(String(rest.at(-1)).split(" ").at(-1) ?? "", "base64").toString("utf16le");
        label = `ssh ${script.includes("$r = @{ temp") ? "inspect" : script.includes("$steps = @()") ? "apply" : "build"}`;
      }
      calls.push({ label, signal: options?.signal });
      const replaced = onCall(label, controller, options);
      if (replaced) return replaced;
      switch (label) {
        case "git toplevel": return ok(root);
        case "git symbolic-ref": return ok("main");
        case "git rev-parse": return ok(B);
        case "ssh inspect": return fromVm(vm({ has: [B] }));
        case "ssh apply": return fromVm({ head: B, branch: "main", status: "", steps: [`merge --ff-only ${B}`] });
        case "ssh build": return fromVm({
          exitCode: 0, killed: false, tool: "fake", version: "1", durationMs: 1, source: { head: B, branch: "main", status: "" },
          statusAfter: "", logPath: "C:\\L\\b.log", log: "", stdout: "", stderr: "",
        });
        default: return ok();
      }
    };
    try {
      const result = await runVmBuild({ project: "App.sln" }, {
        run, cwd: root, signal: controller.signal, now: () => 0, lockDir: join(root, ".lock"),
        readConfig: async () => ({ host: "vm", repos: [{ linux: root, vm: "D:\\r" }] }),
        saveLog: async () => join(root, "b.log"),
      });
      return { result, calls, signal: controller.signal, remote: calls.map((call) => call.label).filter((label) => /^(ssh|scp)/.test(label)) };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  test("without a cancel the fake VM is inspected, updated and built", async () => {
    const { result, remote } = await runAgainstFakeVm(() => undefined);
    expect(remote).toEqual(["ssh inspect", "ssh apply", "ssh build"]);
    expect(result).toMatchObject({ ok: true, status: "built" });
  });

  test("a cancel during the local status check reaches that git call and starts no VM request", async () => {
    const { result, calls, signal, remote } = await runAgainstFakeVm((label, controller) => {
      if (label === "git status") controller.abort();
      return undefined;
    });
    expect(calls.find((call) => call.label === "git status")?.signal).toBe(signal);
    expect(remote).toEqual([]);
    expect(result).toMatchObject({ ok: false, status: "cancelled" });
    expect(result.sync).toBeUndefined();
  });

  test("a cancel after the VM copy was updated keeps the sync result and does not start the build", async () => {
    const { result, remote } = await runAgainstFakeVm((label, controller) => {
      if (label === "ssh apply") controller.abort();
      return undefined;
    });
    expect(remote).toEqual(["ssh inspect", "ssh apply"]);
    expect(result).toMatchObject({ ok: false, status: "cancelled", sync: { status: "synced", vmHead: B } });
    expect(result.build).toBeUndefined();
  });

  test("a cancel that cuts the running VM update is reported as cancelled, not thrown as a transport error", async () => {
    const { result, remote } = await runAgainstFakeVm((label, controller, options) => {
      if (label !== "ssh apply") return undefined;
      const cut = Promise.withResolvers<RunResult>();
      options?.signal?.addEventListener("abort", () => cut.resolve({ code: 128, stdout: "", stderr: "", killed: true }), { once: true });
      queueMicrotask(() => controller.abort());
      return cut.promise;
    });
    expect(remote).toEqual(["ssh inspect", "ssh apply"]);
    expect(result).toMatchObject({ ok: false, status: "cancelled" });
    expect(result.sync).toBeUndefined();
  });

  test("runProcess starts nothing for an already cancelled signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vm-build-run-"));
    try {
      const marker = join(dir, "ran");
      const result = await runProcess("sh", ["-c", `: > "${marker}"`], { signal: AbortSignal.abort() });
      expect(existsSync(marker)).toBe(false);
      expect(result.killed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("runProcess stops a running process when the signal is cancelled", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess("sleep", ["10"], { signal: controller.signal });
    controller.abort();
    expect((await pending).killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
