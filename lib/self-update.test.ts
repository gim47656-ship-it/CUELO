import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// The route is imported statically: it keeps no import-time state, and every path it takes
// (install-mode detection, the release check, the worker spawn) reads process state per request.
import { POST as applyUpdate } from "@/app/api/updates/apply/route";
import type { CueloUpdateResponse } from "@/lib/api-types";
import {
  detectInstallMode,
  readSelfUpdateJob,
  readSelfUpdateState,
  resolveSelfUpdateDir,
  startSelfUpdate,
} from "./self-update";

// These tests run the real worker as its own process against real git repos, files and ports, so the
// 5 s default is not enough for the ones that stop and restart a supervisor.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cuelo-self-update-${name}-`));
  roots.push(dir);
  return dir;
}

function touch(root: string, relative: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
}

function release(version: string): CueloUpdateResponse {
  return {
    currentAppVersion: "0.10.94",
    latestRelease: {
      version,
      tagName: `v${version}`,
      name: `v${version}`,
      body: "",
      htmlUrl: `https://github.com/gim47656-ship-it/CUELO/releases/tag/v${version}`,
      publishedAt: null,
    },
    updateAvailable: true,
    checkedAt: new Date().toISOString(),
  };
}

const UP_TO_DATE: CueloUpdateResponse = {
  currentAppVersion: "0.10.95",
  latestRelease: {
    version: "0.10.95",
    tagName: "v0.10.95",
    name: "v0.10.95",
    body: "",
    htmlUrl: "https://github.com/gim47656-ship-it/CUELO/releases/tag/v0.10.95",
    publishedAt: null,
  },
  updateAvailable: false,
  checkedAt: new Date().toISOString(),
};

const SOURCE_MODE = { mode: "source" as const, supported: true, reason: null };

describe("install mode detection", () => {
  test("a WSL ops service is recognised from the unit in the cgroup and its update script", () => {
    const home = tempDir("wsl");
    touch(home, "cuelo-run/Tools/CUELO_Setup/wsl/update.sh");
    const info = detectInstallMode({
      appRoot: path.join(home, "cuelo-run"),
      homeDir: home,
      cgroupText: "0::/user.slice/app.slice/cuelo-30141.service\n",
    });
    expect(info).toEqual({ mode: "wsl", supported: true, reason: null });
  });

  test("a server outside the service tree is not treated as a service update", () => {
    const home = tempDir("dev-in-service-cgroup");
    touch(home, "cuelo-run/Tools/CUELO_Setup/wsl/update.sh");
    const devTree = tempDir("dev-tree");
    for (const relative of [".git/HEAD", "bun.lock", "app/layout.tsx", ".next/BUILD_ID"]) touch(devTree, relative);
    // A development server started from inside a CUELO session shares the unit's cgroup.
    const info = detectInstallMode({
      appRoot: devTree,
      homeDir: home,
      cgroupText: "0::/user.slice/app.slice/cuelo-30141.service\n",
    });
    expect(info.mode).toBe("source");
    expect(info.supported).toBe(true);
  });

  test("the service tree without its update script stays unsupported", () => {
    const home = tempDir("wsl-missing");
    const info = detectInstallMode({
      appRoot: path.join(home, "cuelo-run"),
      homeDir: home,
      cgroupText: "0::/user.slice/app.slice/cuelo-30141.service\n",
    });
    expect(info.supported).toBe(false);
    expect(info.mode).toBeNull();
    expect(info.reason).toContain("cuelo-run");
  });

  test("a checkout with .git, bun.lock and app/layout.tsx is a source install", () => {
    const root = tempDir("source");
    for (const relative of [".git/HEAD", "bun.lock", "app/layout.tsx", "package.json", ".next/BUILD_ID"]) touch(root, relative);
    expect(detectInstallMode({ appRoot: root, homeDir: tempDir("source-home"), cgroupText: "" }).mode).toBe("source");
  });

  test("a development server stays unsupported because its dist dir must not be rebuilt", () => {
    const root = tempDir("dev-source");
    for (const relative of [".git/HEAD", "bun.lock", "app/layout.tsx"]) touch(root, relative);
    const info = detectInstallMode({ appRoot: root, homeDir: tempDir("dev-home"), cgroupText: "" });
    expect(info.mode).toBe("source");
    expect(info.supported).toBe(false);
    expect(info.reason).toContain("production build");
  });

  test("an isolated dist dir is the build that counts", () => {
    const root = tempDir("verify-source");
    for (const relative of [".git/HEAD", "bun.lock", "app/layout.tsx", ".next-verify/BUILD_ID"]) touch(root, relative);
    expect(detectInstallMode({ appRoot: root, homeDir: tempDir("verify-home"), cgroupText: "", distDir: ".next-verify" }).supported).toBe(true);
    expect(detectInstallMode({ appRoot: root, homeDir: tempDir("verify-home"), cgroupText: "" }).supported).toBe(false);
  });

  test("a packaged build without .git is an npm install", () => {
    // `npm install -g cuelo` unpacks the package into `…/node_modules/cuelo`.
    const root = path.join(tempDir("npm"), "node_modules", "cuelo");
    fs.mkdirSync(root, { recursive: true });
    for (const relative of [".next/BUILD_ID", "install.mjs"]) touch(root, relative);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cuelo", version: "0.10.95" }));
    const info = detectInstallMode({ appRoot: root, homeDir: tempDir("npm-home"), cgroupText: "" });
    expect(info).toEqual({ mode: "npm", supported: true, reason: null });
  });

  test("an unpacked source archive is not an npm install", () => {
    const root = tempDir("archive");
    for (const relative of [".next/BUILD_ID", "install.mjs"]) touch(root, relative);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "cuelo", version: "0.10.95" }));
    const info = detectInstallMode({ appRoot: root, homeDir: tempDir("archive-home"), cgroupText: "" });
    expect(info.supported).toBe(false);
  });

  test("anything else stays unsupported so the manual command remains", () => {
    const info = detectInstallMode({ appRoot: tempDir("other"), homeDir: tempDir("other-home"), cgroupText: "" });
    expect(info.supported).toBe(false);
    expect(info.reason).toBeTruthy();
  });
});

describe("target selection", () => {
  test("nothing is written when the release is not newer than this build", async () => {
    const dir = tempDir("uptodate");
    let spawned = 0;
    const result = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => UP_TO_DATE,
      spawnWorker: () => {
        spawned += 1;
        return 1;
      },
    });
    expect(result.state).toBe("up-to-date");
    expect(spawned).toBe(0);
    expect(fs.existsSync(path.join(dir, "plan.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "update.lock"))).toBe(false);
  });

  test("the plan carries the release version the server read", async () => {
    const dir = tempDir("plan");
    let planPath = "";
    const result = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: (plan) => {
        planPath = plan;
        return process.pid;
      },
    });
    expect(result.state).toBe("started");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    expect(plan.targetVersion).toBe("0.10.95");
    expect(plan.tagName).toBe("v0.10.95");
    expect(plan.mode).toBe("source");
  });
});

describe("lock", () => {
  test("a second press while an update runs returns that job instead of starting another", async () => {
    const dir = tempDir("running");
    let spawned = 0;
    const options = {
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    };
    expect((await startSelfUpdate(options)).state).toBe("started");
    const second = await startSelfUpdate(options);
    expect(second.state).toBe("running");
    expect(spawned).toBe(1);
    const state = readSelfUpdateState(dir);
    expect(state.running).toBe(true);
    expect(state.job?.targetVersion).toBe("0.10.95");
  });

  test("a lock and job left by a dead worker do not block the next attempt", async () => {
    const dir = tempDir("stale");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "update.lock"), JSON.stringify({ pid: 999_999_999 }));
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
      schemaVersion: 1,
      mode: "source",
      phase: "installing",
      currentVersion: "0.10.90",
      targetVersion: "0.10.94",
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    }));
    expect(readSelfUpdateJob(dir).running).toBe(false);
    const result = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => process.pid,
    });
    expect(result.state).toBe("started");
  });

  test("a lock held by this live process is not taken even when its job reads terminal", async () => {
    const dir = tempDir("own-lock");
    fs.mkdirSync(dir, { recursive: true });
    // The server wrote the lock and the job; the worker has not claimed it yet. A second press in the
    // same process must not delete that lock and start a second worker.
    fs.writeFileSync(path.join(dir, "update.lock"), JSON.stringify({ pid: process.pid }));
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
      schemaVersion: 1, mode: "source", phase: "failed", currentVersion: "0.10.94",
      targetVersion: "0.10.94", pid: process.pid, startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), error: "earlier run",
    }));
    let spawned = 0;
    const result = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    });
    expect(spawned).toBe(0);
    expect(result.state).toBe("error");
    expect(fs.existsSync(path.join(dir, "update.lock"))).toBe(true);
  });

  test("an unreadable lock is only abandoned after it has been left alone", async () => {
    const dir = tempDir("corrupt-lock");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "update.lock"), "");
    let spawned = 0;
    const blocked = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    });
    expect(blocked.state).toBe("error");
    expect(spawned).toBe(0);

    // An old, malformed lock is what a crashed writer leaves; that one must not block forever.
    const old = new Date(Date.now() - 60 * 60_000);
    fs.utimesSync(path.join(dir, "update.lock"), old, old);
    const started = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
    });
    expect(started.state).toBe("started");
    expect(spawned).toBe(1);
  });

  test("the lock directory follows CUELO_SELF_UPDATE_DIR", () => {
    const dir = tempDir("env");
    expect(resolveSelfUpdateDir({ CUELO_SELF_UPDATE_DIR: dir })).toBe(dir);
    expect(resolveSelfUpdateDir({})).toBe(path.join(os.homedir(), ".cuelo", "self-update"));
  });
});

/** The worker is run as its own process, exactly as the server starts it. */
async function runWorker(plan: Record<string, unknown>, env: Record<string, string> = {}): Promise<string> {
  const planPath = path.join(String(plan.selfUpdateDir), "scratch-plan.json");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  // Async, not spawnSync: the supervisor this test hands the worker is its own child, and a blocked
  // event loop would never reap it, leaving a zombie the worker waits out.
  const finished = Promise.withResolvers<number | null>();
  const child = spawn(process.execPath, [path.join(import.meta.dir, "..", "bin", "self-update.js"), planPath], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.on("error", finished.reject);
  child.on("exit", (status) => finished.resolve(status));
  expect(await finished.promise).toBe(0);
  return fs.readFileSync(path.join(String(plan.selfUpdateDir), "job.json"), "utf8");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "HEAD", signal: AbortSignal.timeout(500) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`the stand-in supervisor never answered on ${port}`);
}

function waitForGone(pid: number, timeoutMs = 10_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

describe("worker", () => {
  test("a dirty source checkout is refused before anything is fetched", async () => {
    const root = tempDir("dirty");
    git(root, ["init", "--quiet", "-b", "main"]);
    touch(root, "app/layout.tsx");
    git(root, ["add", "."]);
    git(root, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "init"]);
    fs.writeFileSync(path.join(root, "app/layout.tsx"), "dirty\n");

    // A supervisor record, so the run reaches the tree check rather than stopping at the
    // "cannot restart" guard; the dirty tree is what this test is about.
    const stateDir = tempDir("dirty-state");
    const job = JSON.parse(await runWorker({
      schemaVersion: 1,
      mode: "source",
      appRoot: root,
      selfUpdateDir: stateDir,
      currentVersion: "0.10.94",
      targetVersion: "0.10.95",
      tagName: "v0.10.95",
      supervisor: { schemaVersion: 1, pid: process.pid, command: process.execPath, args: ["install.mjs", "start"], cwd: stateDir },
    }));
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("local changes");
  });

  test("source mode fast-forwards to the release tag, runs setup, stops the supervisor and relaunches the same argv", async () => {
    const remote = tempDir("remote");
    git(remote, ["init", "--quiet", "--bare", "-b", "main"]);
    const work = tempDir("work");
    git(work, ["clone", "--quiet", remote, "."]);
    touch(work, "app/layout.tsx");
    fs.writeFileSync(path.join(work, "package.json"), "{\"version\":\"0.10.94\"}\n");
    // The checkout's own installer. The real one runs a full build; this stand-in proves the worker
    // calls `<root>/install.mjs setup` from the fast-forwarded tree, which is the contract tested here.
    fs.writeFileSync(path.join(work, "install.mjs"), "process.stdout.write('setup ok\\n');\n");
    git(work, ["add", "."]);
    git(work, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "old"]);
    const oldHead = git(work, ["rev-parse", "HEAD"]).trim();
    git(work, ["push", "--quiet", "origin", "main"]);
    fs.writeFileSync(path.join(work, "package.json"), "{\"version\":\"0.10.95\"}\n");
    git(work, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-am", "new"]);
    git(work, ["tag", "v0.10.95"]);
    git(work, ["push", "--quiet", "--tags", "origin", "main"]);

    // The checkout still runs the older release, exactly like an install waiting for the tag.
    const checkout = tempDir("checkout");
    git(checkout, ["clone", "--quiet", remote, "."]);
    git(checkout, ["reset", "--quiet", "--hard", oldHead]);
    git(checkout, ["tag", "--delete", "v0.10.95"]);
    const before = git(checkout, ["rev-parse", "HEAD"]).trim();
    expect(before).toBe(oldHead);

    // A stand-in supervisor: it records its argv into the file named by --marker and answers on
    // --port, which is what the worker waits for before it reports the update as done. The worker
    // also refuses to stop a pid whose command line is not the recorded one, so the old process is
    // started from the same script as the relaunch.
    const marker = path.join(tempDir("marker"), "relaunch.json");
    const stub = path.join(tempDir("stub"), "supervisor.js");
    fs.writeFileSync(stub, `
const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
const markerAt = args[args.indexOf("--marker") + 1];
fs.writeFileSync(markerAt, JSON.stringify(args));
const port = Number(args[args.indexOf("--port") + 1]);
http.createServer((request, response) => response.end("ok")).listen(port, "127.0.0.1");
`);
    const port = 39000 + Math.floor(Math.random() * 2000);
    const oldMarker = path.join(tempDir("marker-old"), "old.json");
    const oldSupervisor = spawn(process.execPath, [stub, "--marker", oldMarker, "--port", String(port)], { stdio: "ignore" });
    const oldSupervisorPid = oldSupervisor.pid;
    if (oldSupervisorPid === undefined) throw new Error("the stand-in supervisor did not start");
    await waitForPort(port);
    try {
      const stateDir = tempDir("run-state");
      const job = JSON.parse(await runWorker({
        schemaVersion: 1,
        mode: "source",
        appRoot: checkout,
        selfUpdateDir: stateDir,
        currentVersion: "0.10.94",
        targetVersion: "0.10.95",
        tagName: "v0.10.95",
        webPort: port,
        supervisor: {
          schemaVersion: 1,
          pid: oldSupervisorPid,
          command: process.execPath,
          args: [stub, "--marker", marker, "--port", String(port)],
          cwd: stateDir,
        },
      }));

      expect(job.phase).toBe("done");
      expect(job.targetRef).toBe("v0.10.95");
      expect(git(checkout, ["rev-parse", "HEAD"]).trim()).not.toBe(before);
      expect(git(checkout, ["describe", "--tags"]).trim()).toBe("v0.10.95");
      expect(fs.readFileSync(path.join(stateDir, "update.log"), "utf8")).toContain("setup ok");
      expect(waitForGone(oldSupervisorPid)).toBe(true);
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(["--marker", marker, "--port", String(port)]);
      if (job.relaunchedPid) process.kill(job.relaunchedPid, "SIGTERM");
    } finally {
      try {
        process.kill(oldSupervisorPid, "SIGKILL");
      } catch {
        // Already stopped by the worker.
      }
    }
  });

  test("a supervisor record that names another process is refused instead of killed", async () => {
    const remote = tempDir("foreign-remote");
    git(remote, ["init", "--quiet", "--bare", "-b", "main"]);
    const work = tempDir("foreign-work");
    git(work, ["clone", "--quiet", remote, "."]);
    touch(work, "app/layout.tsx");
    fs.writeFileSync(path.join(work, "install.mjs"), "process.stdout.write('setup ok\\n');\n");
    git(work, ["add", "."]);
    git(work, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "old"]);
    const oldHead = git(work, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(work, "package.json"), "{}\n");
    git(work, ["add", "-A"]);
    git(work, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "new"]);
    git(work, ["tag", "v0.10.95"]);
    git(work, ["push", "--quiet", "--tags", "origin", "main"]);
    const checkout = tempDir("foreign-checkout");
    git(checkout, ["clone", "--quiet", remote, "."]);
    git(checkout, ["reset", "--quiet", "--hard", oldHead]);
    git(checkout, ["tag", "--delete", "v0.10.95"]);

    // An unrelated long-running process, as a recycled or overwritten pid would find.
    const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const bystanderPid = bystander.pid;
    if (bystanderPid === undefined) throw new Error("the bystander did not start");
    try {
      const job = JSON.parse(await runWorker({
        schemaVersion: 1,
        mode: "source",
        appRoot: checkout,
        selfUpdateDir: tempDir("foreign-state"),
        currentVersion: "0.10.94",
        targetVersion: "0.10.95",
        tagName: "v0.10.95",
        webPort: 1,
        supervisor: {
          schemaVersion: 1,
          pid: bystanderPid,
          command: process.execPath,
          args: [path.join(tempDir("foreign-stub"), "supervisor.js"), "--marker", "x"],
          cwd: checkout,
        },
      }));
      expect(job.phase).toBe("failed");
      expect(job.error).toContain("refusing to stop it");
      // The checkout was not touched: the guard runs before anything is fetched or built.
      expect(git(checkout, ["rev-parse", "HEAD"]).trim()).toBe(oldHead);
      expect(() => process.kill(bystanderPid, 0)).not.toThrow();
    } finally {
      process.kill(bystanderPid, "SIGKILL");
    }
  });

  test("npm mode installs the exact release spec and restarts the recorded supervisor", async () => {
    const npmLog = path.join(tempDir("npm"), "argv.json");
    const npmStub = path.join(tempDir("npm-stub"), "npm");
    // A real `npm` is an executable on PATH, so the stub is one too (shebang + exec bit).
    fs.writeFileSync(npmStub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(npmLog)}\n`, { mode: 0o755 });
    const stub = path.join(tempDir("npm-stub"), "supervisor.js");
    const marker = path.join(tempDir("npm-marker"), "argv.json");
    fs.writeFileSync(stub, `
const fs = require("node:fs");
const http = require("node:http");
const args = process.argv.slice(2);
fs.writeFileSync(args[args.indexOf("--marker") + 1], JSON.stringify(args));
http.createServer((request, response) => response.end("ok")).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
`);
    const port = 41000 + Math.floor(Math.random() * 2000);
    const oldMarker = path.join(tempDir("npm-marker-old"), "argv.json");
    const supervisor = spawn(process.execPath, [stub, "--marker", oldMarker, "--port", String(port)], { stdio: "ignore" });
    const supervisorPid = supervisor.pid;
    if (supervisorPid === undefined) throw new Error("the stand-in supervisor did not start");
    await waitForPort(port);
    const stateDir = tempDir("npm-state");
    try {
      const job = JSON.parse(await runWorker({
        schemaVersion: 1,
        mode: "npm",
        appRoot: tempDir("npm-app"),
        selfUpdateDir: stateDir,
        currentVersion: "0.10.94",
        targetVersion: "0.10.95",
        tagName: "v0.10.95",
        npmBin: npmStub,
        webPort: port,
        supervisor: { schemaVersion: 1, pid: supervisorPid, command: process.execPath, args: [stub, "--marker", marker, "--port", String(port)], cwd: stateDir },
      }));
      expect(job.phase).toBe("done");
      expect(fs.readFileSync(npmLog, "utf8").trim().split("\n")).toEqual(["install", "-g", "cuelo@0.10.95"]);
      expect(job.targetRef).toBe("cuelo@0.10.95");
      expect(waitForGone(supervisorPid)).toBe(true);
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(["--marker", marker, "--port", String(port)]);
      if (job.relaunchedPid) process.kill(job.relaunchedPid, "SIGTERM");
    } finally {
      try {
        process.kill(supervisorPid, "SIGKILL");
      } catch {
        // Already stopped by the worker.
      }
    }
  });

  test("npm mode refuses to install over a server it could not restart", async () => {
    // No recorded supervisor: `npm install -g` would replace files the live server has open and
    // nothing could start it again, so the worker must not try.
    const npmLog = path.join(tempDir("npm-refuse"), "argv.json");
    const npmStub = path.join(tempDir("npm-refuse-stub"), "npm");
    fs.writeFileSync(npmStub, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(npmLog)}\n`, { mode: 0o755 });
    const job = JSON.parse(await runWorker({
      schemaVersion: 1,
      mode: "npm",
      appRoot: tempDir("npm-refuse-app"),
      selfUpdateDir: tempDir("npm-refuse-state"),
      currentVersion: "0.10.94",
      targetVersion: "0.10.95",
      tagName: "v0.10.95",
      npmBin: npmStub,
      webPort: 1,
    }));
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("install.mjs start");
    expect(fs.existsSync(npmLog)).toBe(false);
  });

  test("wsl mode hands the update to its own transient unit and never runs update.sh here", async () => {
    const stateDir = tempDir("wsl-state");
    const script = touch(tempDir("wsl-script"), "cuelo-run/Tools/CUELO_Setup/wsl/update.sh");
    const job = JSON.parse(await runWorker({
      schemaVersion: 1,
      mode: "wsl",
      appRoot: tempDir("wsl-app"),
      selfUpdateDir: stateDir,
      currentVersion: "0.10.94",
      targetVersion: "0.10.95",
      tagName: "v0.10.95",
      wsl: { script, distro: "Ubuntu-24.04", port: 30141 },
    }, { CUELO_SELF_UPDATE_DRY_RUN: "1" }));
    expect(job.phase).toBe("handed-off");
    expect(job.targetRef).toMatch(/^cuelo-update-\d+$/);
    const log = fs.readFileSync(path.join(stateDir, "update.log"), "utf8");
    expect(log).toContain("systemd-run --user --unit=cuelo-update-");
    expect(log).toContain("--setenv=WSL_DISTRO_NAME=Ubuntu-24.04");
    expect(log).toContain(script);
  });

  test("wsl mode records the hand-off after systemd-run really returns", async () => {
    // Not a dry run: the worker spawns `systemd-run` from PATH and must still be alive to record
    // `handed-off` once it exits. A stub stands in so update.sh never runs here.
    const stubDir = tempDir("wsl-systemd-run");
    const argvLog = path.join(stubDir, "argv.txt");
    fs.writeFileSync(path.join(stubDir, "systemd-run"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\n`, { mode: 0o755 });
    const stateDir = tempDir("wsl-real-state");
    const script = touch(tempDir("wsl-real-script"), "cuelo-run/Tools/CUELO_Setup/wsl/update.sh");
    const job = JSON.parse(await runWorker({
      schemaVersion: 1,
      mode: "wsl",
      appRoot: tempDir("wsl-real-app"),
      selfUpdateDir: stateDir,
      currentVersion: "0.10.95",
      targetVersion: "0.10.96",
      tagName: "v0.10.96",
      wsl: { script, distro: "Ubuntu-24.04", port: 30141 },
    }, { PATH: `${stubDir}:${process.env.PATH ?? ""}` }));
    expect(job.phase).toBe("handed-off");
    expect(job.targetRef).toMatch(/^cuelo-update-\d+$/);
    expect(fs.readFileSync(argvLog, "utf8").trim().split("\n")).toEqual([
      "--user", `--unit=${job.targetRef}`, "--collect", "--setenv=WSL_DISTRO_NAME=Ubuntu-24.04", "bash", script,
    ]);
    expect(fs.readFileSync(path.join(stateDir, "update.log"), "utf8")).toContain(`handed off to ${job.targetRef}`);
  });
});

describe("failures after the supervisor stopped", () => {
  /** A release repo plus a checkout of the older commit, and an HTTP-serving supervisor. */
  async function fixture(name: string) {
    const remote = tempDir(`${name}-remote`);
    git(remote, ["init", "--quiet", "--bare", "-b", "main"]);
    const work = tempDir(`${name}-work`);
    git(work, ["clone", "--quiet", remote, "."]);
    touch(work, "app/layout.tsx");
    // This installer is the one the worker runs after the fast-forward; `--fail` makes it fail.
    fs.writeFileSync(path.join(work, "install.mjs"), `
if (process.argv.includes("--fail")) { console.error("build failed"); process.exit(1); }
process.stdout.write("setup ok\\n");
`);
    git(work, ["add", "."]);
    git(work, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "old"]);
    const oldHead = git(work, ["rev-parse", "HEAD"]).trim();
    fs.writeFileSync(path.join(work, "package.json"), "{}\n");
    git(work, ["add", "-A"]);
    git(work, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "new"]);
    git(work, ["tag", "v0.10.95"]);
    git(work, ["push", "--quiet", "--tags", "origin", "main"]);
    const checkout = tempDir(`${name}-checkout`);
    git(checkout, ["clone", "--quiet", remote, "."]);
    git(checkout, ["reset", "--quiet", "--hard", oldHead]);
    git(checkout, ["tag", "--delete", "v0.10.95"]);
    return { oldHead, checkout };
  }

  test("a failed build goes back to the previous release and a server answers again", async () => {
    const { oldHead, checkout } = await fixture("rollback");
    // Fail the build only when the new release is checked out, so the rollback build succeeds.
    fs.writeFileSync(path.join(checkout, "install.mjs"), `
const fs = require("node:fs");
if (fs.readFileSync("package.json", "utf8").includes("0.10.95")) { console.error("build failed"); process.exit(1); }
process.stdout.write("setup ok\\n");
`);
    git(checkout, ["add", "-A"]);
    git(checkout, ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "release-aware setup"]);
    // `fixture` also gives the work tree this file; make the tag carry the failing variant.
    const port = 43000 + Math.floor(Math.random() * 2000);
    const stub = path.join(tempDir("rollback-stub"), "supervisor.js");
    fs.writeFileSync(stub, `
const http = require("node:http");
const args = process.argv.slice(2);
http.createServer((request, response) => response.end("ok")).listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
`);
    const supervisor = spawn(process.execPath, [stub, "--port", String(port)], { stdio: "ignore" });
    const supervisorPid = supervisor.pid;
    if (supervisorPid === undefined) throw new Error("the stand-in supervisor did not start");
    await waitForPort(port);
    const stateDir = tempDir("rollback-state");
    try {
      const job = JSON.parse(await runWorker({
        schemaVersion: 1,
        mode: "source",
        appRoot: checkout,
        selfUpdateDir: stateDir,
        currentVersion: "0.10.94",
        targetVersion: "0.10.95",
        tagName: "v0.10.95",
        webPort: port,
        supervisor: { schemaVersion: 1, pid: supervisorPid, command: process.execPath, args: [stub, "--port", String(port)], cwd: stateDir },
      }));
      // The tag is not an ancestor of the local commit, so the fast-forward is what fails here.
      expect(job.phase).toBe("failed");
      expect(job.error).toContain("ff-only");
      expect(git(checkout, ["rev-parse", "HEAD"]).trim()).not.toBe(oldHead);
      // A server answers again: the machine is not left without CUELO.
      expect(job.relaunchedPid).not.toBeNull();
      await waitForPort(port);
      if (job.relaunchedPid) process.kill(job.relaunchedPid, "SIGTERM");
    } finally {
      try {
        process.kill(supervisorPid, "SIGKILL");
      } catch {
        // Already stopped by the worker.
      }
    }
  });

  test("source mode refuses to build under a server it could not restart", async () => {
    const { oldHead, checkout } = await fixture("no-supervisor");
    const job = JSON.parse(await runWorker({
      schemaVersion: 1,
      mode: "source",
      appRoot: checkout,
      selfUpdateDir: tempDir("no-supervisor-state"),
      currentVersion: "0.10.94",
      targetVersion: "0.10.95",
      tagName: "v0.10.95",
      webPort: 1,
    }));
    expect(job.phase).toBe("failed");
    expect(job.error).toContain("install.mjs start");
    // Nothing was touched: no fetch-time checkout, no build.
    expect(git(checkout, ["rev-parse", "HEAD"]).trim()).toBe(oldHead);
  });
});

describe("hand-off and untrusted records", () => {
  test("a server that was not started by install.mjs start gets no supervisor to trust", async () => {
    const dir = tempDir("untrusted");
    fs.mkdirSync(dir, { recursive: true });
    // A record naming some other pid, while this server has no CUELO_SUPERVISOR_PID of its own.
    fs.writeFileSync(path.join(dir, "supervisor.json"), JSON.stringify({
      schemaVersion: 1,
      pid: 999_999_998,
      command: process.execPath,
      args: [path.join(dir, "supervisor.js"), "--port-base", "39999"],
      cwd: dir,
    }));
    let planPath = "";
    const result = await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: (plan) => {
        planPath = plan;
        return process.pid;
      },
    });
    expect(result.state).toBe("started");
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    expect(plan.supervisor).toBeNull();
    // No invented `--home $HOME` either: that would move a custom PI_CODING_AGENT_DIR.
    expect(plan.home).toBeNull();
  });

  test("the recorded supervisor is trusted only when it is this server's own", async () => {
    const dir = tempDir("trusted");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "supervisor.json"), JSON.stringify({
      schemaVersion: 1,
      pid: 4242,
      command: process.execPath,
      args: [path.join(dir, "install.mjs"), "start", "--port-base", "39999", "--home", "/tmp/profile"],
      cwd: dir,
    }));
    let planPath = "";
    await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: { CUELO_SUPERVISOR_PID: "4242" },
      status: async () => release("0.10.95"),
      spawnWorker: (plan) => {
        planPath = plan;
        return process.pid;
      },
    });
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    expect(plan.supervisor?.pid).toBe(4242);
    expect(plan.webPort).toBe(39999);
    expect(plan.home).toBe("/tmp/profile");
  });

  test("a relative --home is resolved against the directory the supervisor started in", async () => {
    const dir = tempDir("relative-home");
    const startDir = tempDir("relative-start");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "supervisor.json"), JSON.stringify({
      schemaVersion: 1,
      pid: 4343,
      command: process.execPath,
      args: [path.join(dir, "install.mjs"), "start", "--home", "./prof"],
      // `install.mjs start` records the directory it was launched from.
      cwd: startDir,
    }));
    let planPath = "";
    await startSelfUpdate({
      dir,
      mode: SOURCE_MODE,
      env: { CUELO_SUPERVISOR_PID: "4343" },
      status: async () => release("0.10.95"),
      spawnWorker: (plan) => {
        planPath = plan;
        return process.pid;
      },
    });
    const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
    expect(plan.home).toBe(path.join(startDir, "prof"));
  });

  test("a WSL hand-off keeps its lock while update.sh still runs", async () => {
    const dir = tempDir("handoff");
    fs.mkdirSync(dir, { recursive: true });
    const updatedAt = new Date().toISOString();
    // The worker that handed off has exited; the unit name is the only thing left to ask.
    fs.writeFileSync(path.join(dir, "update.lock"), JSON.stringify({ pid: 999_999_997, startedAt: updatedAt }));
    fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
      schemaVersion: 1,
      mode: "wsl",
      phase: "handed-off",
      currentVersion: "0.10.90",
      targetVersion: "0.10.95",
      targetRef: "cuelo-update-1761000000",
      pid: 999_999_997,
      startedAt: updatedAt,
      updatedAt,
      error: null,
    }));
    let spawned = 0;
    const result = await startSelfUpdate({
      dir,
      mode: { mode: "wsl", supported: true, reason: null },
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
      // The real check asks systemd; the test supplies the answer instead of creating a unit.
      unitRunning: () => true,
    });
    expect(result.state).toBe("running");
    expect(spawned).toBe(0);

    // Once that unit is gone, the same record no longer blocks a new attempt.
    const after = await startSelfUpdate({
      dir,
      mode: { mode: "wsl", supported: true, reason: null },
      env: {},
      status: async () => release("0.10.95"),
      spawnWorker: () => {
        spawned += 1;
        return process.pid;
      },
      unitRunning: () => false,
    });
    expect(after.state).toBe("started");
    expect(spawned).toBe(1);
  });
});

describe("POST /api/updates/apply", () => {
  test("a request body cannot choose the version, the mode or a command", async () => {
    const dir = tempDir("route");
    // An isolated npm-shaped tree and HOME: detection then cannot depend on the host running the test.
    const appRoot = path.join(tempDir("route-app"), "node_modules", "cuelo");
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ name: "cuelo", version: "0.10.90" }));
    touch(appRoot, ".next/BUILD_ID");
    // The package ships `install.mjs` and `bin/`; the server copies its worker out of this tree.
    touch(appRoot, "install.mjs");
    fs.mkdirSync(path.join(appRoot, "bin"), { recursive: true });
    fs.copyFileSync(path.join(import.meta.dir, "..", "bin", "self-update.js"), path.join(appRoot, "bin", "self-update.js"));
    const home = tempDir("route-home");
    const previous = {
      dir: process.env.CUELO_SELF_UPDATE_DIR,
      node: process.env.CUELO_SELF_UPDATE_NODE,
      version: process.env.NEXT_PUBLIC_APP_VERSION,
      appDir: process.env.CUELO_DIR,
      home: process.env.HOME,
      fetch: globalThis.fetch,
    };
    process.env.CUELO_SELF_UPDATE_DIR = dir;
    process.env.CUELO_SELF_UPDATE_NODE = "true";
    process.env.NEXT_PUBLIC_APP_VERSION = "0.10.94";
    process.env.CUELO_DIR = appRoot;
    process.env.HOME = home;
    // The server resolves its tree from its own working directory; the test runs the route from the
    // isolated tree so the host checkout it lives in cannot decide the mode.
    const previousCwd = process.cwd();
    process.chdir(appRoot);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      tag_name: "v0.10.95",
      name: "v0.10.95",
      body: "",
      html_url: "https://github.com/gim47656-ship-it/CUELO/releases/tag/v0.10.95",
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

    try {
      const response = await applyUpdate(new Request("http://127.0.0.1:30141/api/updates/apply", {
        method: "POST",
        headers: { host: "127.0.0.1:30141", "content-type": "application/json" },
        body: JSON.stringify({ version: "9.9.9", tagName: "v9.9.9", mode: "npm", command: "rm -rf /" }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { state: string; mode: string; job: { targetVersion: string } };
      expect(body.state).toBe("started");
      expect(body.mode).toBe("npm");
      expect(body.job.targetVersion).toBe("0.10.95");
      const plan = JSON.parse(fs.readFileSync(path.join(dir, "plan.json"), "utf8"));
      expect(plan.targetVersion).toBe("0.10.95");
      expect(plan.tagName).toBe("v0.10.95");
      // The isolated tree is an npm build, and the body's `mode` never reached the plan.
      expect(plan.mode).toBe("npm");
    } finally {
      if (previous.dir === undefined) delete process.env.CUELO_SELF_UPDATE_DIR;
      else process.env.CUELO_SELF_UPDATE_DIR = previous.dir;
      if (previous.node === undefined) delete process.env.CUELO_SELF_UPDATE_NODE;
      else process.env.CUELO_SELF_UPDATE_NODE = previous.node;
      if (previous.version === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
      else process.env.NEXT_PUBLIC_APP_VERSION = previous.version;
      if (previous.appDir === undefined) delete process.env.CUELO_DIR;
      else process.env.CUELO_DIR = previous.appDir;
      if (previous.home === undefined) delete process.env.HOME;
      else process.env.HOME = previous.home;
      process.chdir(previousCwd);
      globalThis.fetch = previous.fetch;
    }
  });

  test("the route refuses a non-JSON body before starting anything", async () => {
    const response = await applyUpdate(new Request("http://127.0.0.1:30141/api/updates/apply", {
      method: "POST",
      headers: { host: "127.0.0.1:30141", "content-type": "text/plain" },
      body: "version=9.9.9",
    }));
    expect(response.status).toBe(415);
  });
});
