import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  type AutoSyncDeps,
  createGitNexusAutoSync,
  defaultDeps,
  syncGitNexusIndex,
  type WorkerJob,
} from "../gitnexus-autosync";

const HEAD = "b".repeat(40);
const OLD = "a".repeat(40);
const roots: string[] = [];
const workerPids: number[] = [];

async function waitForExit(pid: number) {
  for (let i = 0; i < 200 && defaultDeps.isAlive(pid); i++) await Bun.sleep(50);
  expect(defaultDeps.isAlive(pid)).toBe(false);
}

afterEach(async () => {
  // lock 제거는 워커의 finally 안에서 일어난다. cwd 잠금이 풀리는 실제 종료까지 기다린다.
  for (const pid of workerPids.splice(0)) await waitForExit(pid);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

interface Repo {
  root: string;
  storage: string;
  lockPath: string;
  logPath: string;
  gitCore: string;
}

function repo(options: { index?: boolean; lastCommit?: string } = {}): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gnx-autosync-"));
  roots.push(root);
  const storage = path.join(root, ".gitnexus");
  if (options.index !== false) {
    fs.mkdirSync(storage);
    fs.writeFileSync(path.join(storage, "meta.json"), JSON.stringify({ lastCommit: options.lastCommit ?? OLD }));
  }
  // Git mingw64 배치를 흉내 낸다: <git>/mingw64/libexec/git-core 와 <git>/mingw64/bin/libssl-3-x64.dll
  const gitCore = path.join(root, "git", "mingw64", "libexec", "git-core");
  fs.mkdirSync(gitCore, { recursive: true });
  fs.mkdirSync(path.join(root, "git", "mingw64", "bin"));
  fs.writeFileSync(path.join(root, "git", "mingw64", "bin", "libssl-3-x64.dll"), "");
  return { root, storage, lockPath: path.join(storage, "autosync.lock"), logPath: path.join(storage, "autosync.log"), gitCore };
}

function deps(r: Repo, overrides: Partial<AutoSyncDeps> = {}) {
  const jobs: WorkerJob[] = [];
  const value: AutoSyncDeps = {
    platform: "win32",
    now: () => Date.now(),
    git: async (args) => {
      if (args.includes("--show-toplevel")) return r.root;
      if (args.includes("--exec-path")) return r.gitCore;
      return HEAD;
    },
    which: (command) => ({ node: "node-bin", bun: "bun-bin" } as Record<string, string | undefined>)[command],
    isAlive: () => true,
    spawnWorker: (job) => {
      jobs.push(job);
      return process.pid;
    },
    ...overrides,
  };
  return { value, jobs };
}

const readLog = (r: Repo) => (fs.existsSync(r.logPath) ? fs.readFileSync(r.logPath, "utf8") : "");

describe("gitnexus autosync 판정", () => {
  test("색인이 없는 저장소는 아무것도 하지 않는다", async () => {
    const r = repo({ index: false });
    const d = deps(r);
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("no-index");
    expect(d.jobs).toHaveLength(0);
    expect(fs.existsSync(r.storage)).toBe(false);
  });

  test("lastCommit이 HEAD와 같고 그 커밋의 무결성 검사 결과가 있으면 실행하지 않는다", async () => {
    const r = repo({ lastCommit: HEAD });
    fs.writeFileSync(path.join(r.storage, "autosync-health.json"), JSON.stringify({ lastCommit: HEAD, rows: null }));
    const d = deps(r);
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("fresh");
    expect(d.jobs).toHaveLength(0);
  });

  test("lastCommit이 HEAD와 같아도 검사 기록이 없거나 다른 커밋의 것이면 검사만 하는 워커를 띄운다", async () => {
    const r = repo({ lastCommit: HEAD });
    const d = deps(r);
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("started");
    expect(d.jobs[0].verifyOnly).toBe(true);
    fs.rmSync(r.lockPath);
    fs.writeFileSync(path.join(r.storage, "autosync-health.json"), JSON.stringify({ lastCommit: OLD }));
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("started");
    expect(d.jobs[1].verifyOnly).toBe(true);
  });

  test("뒤처진 색인은 캐시된 gitnexus를 설치 없이 analyze --index-only로 한 번 돌리고 잠금을 워커 pid로 넘긴다", async () => {
    const r = repo();
    const d = deps(r, { spawnWorker: (job) => { d.jobs.push(job); return 4242; } });
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("started");
    expect(d.jobs).toHaveLength(1);
    const [job] = d.jobs;
    expect(job.command).toEqual(["bun-bin", "x", "--no-install", "gitnexus", "analyze", "--index-only"]);
    expect(job.shell).toBe(false);
    expect(job.pathPrefix).toBe(path.join(r.root, "git", "mingw64", "bin"));
    expect(job.dbPath).toBe(path.join(r.storage, "lbug"));
    expect(JSON.parse(fs.readFileSync(r.lockPath, "utf8"))).toMatchObject({ pid: 4242, token: job.token });
  });

  test("PATH의 gitnexus가 있으면 그것을 먼저 쓰고, Windows .cmd는 셸로 실행한다", async () => {
    const r = repo();
    const which = (command: string) =>
      ({ node: "node-bin", bun: "bun-bin", gitnexus: "C:\\tools\\gitnexus.cmd" } as Record<string, string | undefined>)[command];
    const d = deps(r, { which });
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("started");
    expect(d.jobs[0].command).toEqual(['"C:\\tools\\gitnexus.cmd"', "analyze", "--index-only"]);
    expect(d.jobs[0].shell).toBe(true);
  });

  test("설치된 gitnexus도 bun도 없으면 내려받지 않고 로그만 남긴다", async () => {
    const r = repo();
    const d = deps(r, { which: (command) => (command === "node" ? "node-bin" : undefined) });
    expect(await syncGitNexusIndex(r.root, d.value)).toBe("no-runner");
    expect(d.jobs).toHaveLength(0);
    expect(readLog(r)).toContain("no node or GitNexus runner");
    expect(fs.existsSync(r.lockPath)).toBe(false);
  });

  test("동시에 두 번 시작해도 워커는 하나다", async () => {
    const r = repo();
    const d = deps(r);
    const outcomes = await Promise.all([syncGitNexusIndex(r.root, d.value), syncGitNexusIndex(r.root, d.value)]);
    expect(outcomes.sort()).toEqual(["locked", "started"]);
    expect(d.jobs).toHaveLength(1);
  });

  test("살아 있는 최근 잠금은 존중하고, 죽은 pid나 오래된 잠금은 회수한다", async () => {
    const r = repo();
    const now = Date.now();
    fs.writeFileSync(r.lockPath, JSON.stringify({ pid: 777, token: "<live>", startedAt: now }));
    expect(await syncGitNexusIndex(r.root, deps(r).value)).toBe("locked");

    const dead = deps(r, { isAlive: (pid) => pid !== 777 });
    expect(await syncGitNexusIndex(r.root, dead.value)).toBe("started");
    expect(dead.jobs).toHaveLength(1);
    expect(readLog(r)).toContain("reclaim stale lock (pid 777)");

    fs.writeFileSync(r.lockPath, JSON.stringify({ pid: 778, token: "<old>", startedAt: now - 7 * 60 * 60 * 1000 }));
    const old = deps(r);
    expect(await syncGitNexusIndex(r.root, old.value)).toBe("started");
    expect(readLog(r)).toContain("reclaim stale lock (pid 778)");

    fs.writeFileSync(r.lockPath, "{broken");
    expect(await syncGitNexusIndex(r.root, deps(r).value)).toBe("started");
  });

  test("실패는 세션으로 올라가지 않고 로그에만 남으며 잠금을 남기지 않는다", async () => {
    const r = repo();
    const failingGit = deps(r, {
      git: async (args) => {
        if (args.includes("--show-toplevel")) return r.root;
        throw new Error("git exploded");
      },
    });
    expect(await syncGitNexusIndex(r.root, failingGit.value)).toBe("error");
    expect(readLog(r)).toContain("error: git exploded");

    const failingSpawn = deps(r, { spawnWorker: () => { throw new Error("spawn exploded"); } });
    expect(await syncGitNexusIndex(r.root, failingSpawn.value)).toBe("error");
    expect(readLog(r)).toContain("error: spawn exploded");
    expect(fs.existsSync(r.lockPath)).toBe(false);

    expect(await syncGitNexusIndex(r.root, deps(r, { git: async () => { throw new Error("not a repo"); } }).value)).toBe("no-repo");
  });

  test("session_start는 기다리지 않고 main 세션에서만 돌며 오류를 던지지 않는다", async () => {
    const r = repo();
    const spawned = Promise.withResolvers<void>();
    const d = deps(r, { spawnWorker: (job) => { d.jobs.push(job); spawned.resolve(); return process.pid; } });
    const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
    createGitNexusAutoSync(d.value)({
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
        if (name === "session_start") handlers.push(handler);
      },
    } as unknown as ExtensionAPI);
    expect(handlers).toHaveLength(1);
    // sub 판정은 동기적으로 끝나므로 이후 main 세션의 spawn 하나만 관측돼야 한다.
    expect(handlers[0]({}, { cwd: r.root, agent: { kind: "sub" } })).toBeUndefined();
    expect(handlers[0]({}, { cwd: r.root, agent: { kind: "main" } })).toBeUndefined();
    expect(d.jobs).toHaveLength(0);
    await spawned.promise;
    expect(d.jobs).toHaveLength(1);
  });
});

// 실제 Node 워커를 PATH의 가짜 gitnexus로 끝까지 돌린다. 워커는 저장소 루트를 cwd로 analyze를 실행한다.
const FAKE_GITNEXUS = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const dir = path.join(process.cwd(), ".gitnexus");
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH");
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.txt"), args.join(" ") + "|" + process.env[pathKey].split(path.delimiter)[0] + "\n");
const rowsFile = path.join(dir, "rows.txt");
if (args[0] === "cypher") {
  // Function 행 수 질의는 total, id가 온전한 행 수 질의(STARTS WITH)는 intact를 돌려준다.
  const [total, intact] = fs.readFileSync(rowsFile, "utf8").split(" ").map(Number);
  const value = args[1].includes("STARTS") ? intact : total;
  const output = "\n  GitNexus Cypher (fake)\n" + JSON.stringify({ markdown: "| c |\n| --- |\n| " + value + " |", row_count: 1 }, null, 2);
  if (args[1].includes("STARTS") && fs.existsSync(path.join(dir, "hold-on-count"))) {
    const holder = require("node:child_process").spawn(process.execPath, [
      "-e",
      "const fs = require('node:fs'); fs.openSync(process.argv[1], 'r'); fs.watch(process.argv[1], () => {}); process.stdout.write('ready');",
      path.join(dir, "lbug"),
    ], { detached: true, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    holder.stdout.once("data", () => {
      fs.writeFileSync(path.join(dir, "holder.pid"), String(holder.pid));
      console.log(output);
      process.exit(0);
    });
  } else {
    console.log(output);
    process.exit(0);
  }
  return;
}
const exit = Number(fs.readFileSync(path.join(dir, "exit.txt"), "utf8"));
if (exit === 0) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  meta.lastCommit = fs.readFileSync(path.join(dir, "head.txt"), "utf8");
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta));
  // --force 전체 재빌드는 빈 id를 없앤다(rows.txt 세 번째 값 stuck이면 없애지 못하는 경우를 흉내 낸다).
  if (args.includes("--force") && !fs.readFileSync(rowsFile, "utf8").includes("stuck")) fs.writeFileSync(rowsFile, "10 10");
}
process.exit(exit);
`;

const nodePath = Bun.which("node");

// detached 워커는 기다릴 핸들이 없어 잠금 파일이 사라지는 것을 실제 시간으로 기다린다(실제 프로세스 통합 검사).
async function waitForRelease(lockPath: string) {
  for (let i = 0; i < 200 && fs.existsSync(lockPath); i++) await Bun.sleep(50);
  expect(fs.existsSync(lockPath)).toBe(false);
}

describe.skipIf(!nodePath)("gitnexus autosync 워커", () => {
  function realDeps(r: Repo, rows = "10 10") {
    fs.writeFileSync(path.join(r.storage, "head.txt"), HEAD);
    fs.writeFileSync(path.join(r.storage, "rows.txt"), rows);
    const bin = path.join(r.root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "fake-gitnexus.cjs"), FAKE_GITNEXUS);
    const wrapper = path.join(bin, process.platform === "win32" ? "gitnexus.cmd" : "gitnexus");
    fs.writeFileSync(
      wrapper,
      process.platform === "win32"
        ? `@"${nodePath}" "%~dp0fake-gitnexus.cjs" %*\r\n`
        : `#!/bin/sh\nexec "${nodePath}" "$(dirname "$0")/fake-gitnexus.cjs" "$@"\n`,
      { mode: 0o755 },
    );
    const which = (c: string) => ({ node: nodePath ?? undefined, gitnexus: wrapper } as Record<string, string | undefined>)[c];
    return deps(r, {
      platform: process.platform,
      which,
      spawnWorker: (job, node) => {
        const pid = defaultDeps.spawnWorker(job, node);
        workerPids.push(pid);
        return pid;
      },
    }).value;
  }

  const readCalls = (r: Repo) => fs.readFileSync(path.join(r.storage, "calls.txt"), "utf8").trim().split("\n");

  test("뒤처진 색인을 analyze로 HEAD까지 올리고 잠금을 풀며, 다음 세션은 fresh로 본다", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    const d = realDeps(r);
    expect(await syncGitNexusIndex(r.root, d)).toBe("started");
    await waitForRelease(r.lockPath);
    const calls = readCalls(r);
    expect(calls.filter((c) => !c.startsWith("cypher "))).toHaveLength(1);
    expect(calls[0].startsWith("analyze --index-only|")).toBe(true);
    if (process.platform === "win32") expect(calls[0].endsWith(path.join(r.root, "git", "mingw64", "bin"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(r.storage, "meta.json"), "utf8")).lastCommit).toBe(HEAD);
    expect(readLog(r)).toMatch(/end: exit=0 .*\(matches head\)/);
    expect(await syncGitNexusIndex(r.root, d)).toBe("fresh");
  });

  test("analyze 실패는 로그에 exit 코드로 남고 잠금을 풀어 다음 세션이 다시 시도한다", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "3");
    const d = realDeps(r);
    expect(await syncGitNexusIndex(r.root, d)).toBe("started");
    await waitForRelease(r.lockPath);
    expect(readLog(r)).toMatch(/end: exit=3 .*\(differs from head\)/);
    expect(JSON.parse(fs.readFileSync(path.join(r.storage, "meta.json"), "utf8")).lastCommit).toBe(OLD);
  });

  test("증분 갱신 뒤 id 손상이 보이면 --force로 한 번 다시 만들고 결과를 남긴다", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    const d = realDeps(r, "10 4");
    expect(await syncGitNexusIndex(r.root, d)).toBe("started");
    await waitForRelease(r.lockPath);
    expect(readCalls(r).filter((c) => c.startsWith("analyze ")).map((c) => c.split("|")[0])).toEqual([
      "analyze --index-only",
      "analyze --index-only --force",
    ]);
    expect(readLog(r)).toContain("integrity: 10/10 Function rows have their id");
    expect(JSON.parse(fs.readFileSync(path.join(r.storage, "autosync-health.json"), "utf8"))).toMatchObject({
      lastCommit: HEAD,
      rows: { total: 10, intact: 10 },
    });
    expect(await syncGitNexusIndex(r.root, d)).toBe("fresh");
  });

  test("막 전체 재빌드했는데도 손상이면 다시 만들지 않고 로그와 기록만 남겨 세션마다 반복하지 않는다", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    const d = realDeps(r, "10 4 stuck");
    expect(await syncGitNexusIndex(r.root, d)).toBe("started");
    await waitForRelease(r.lockPath);
    // 증분 analyze 한 번과 그 뒤 --force 재빌드 한 번. 재빌드 뒤에도 손상이어도 더 반복하지 않는다.
    expect(readCalls(r).filter((c) => c.startsWith("analyze "))).toHaveLength(2);
    expect(readLog(r)).toContain("integrity: 4/10 Function rows have their id");
    expect(await syncGitNexusIndex(r.root, d)).toBe("fresh");
  });

  test("HEAD와 같지만 검사한 적 없는 색인은 analyze 없이 검사만 하고, 손상이면 전체 재빌드를 한 번 한다", async () => {
    const r = repo({ lastCommit: HEAD });
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    const d = realDeps(r, "10 0");
    expect(await syncGitNexusIndex(r.root, d)).toBe("started");
    await waitForRelease(r.lockPath);
    expect(readCalls(r).filter((c) => c.startsWith("analyze "))).toEqual([
      expect.stringMatching(/^analyze --index-only --force\|/),
    ]);
    expect(readLog(r)).toContain("verify: index is at head");
    expect(readLog(r)).toContain("10 of 10 Function rows lost their id");
    expect(await syncGitNexusIndex(r.root, d)).toBe("fresh");
  });

  test("무결성 검사가 건강하면 다시 만들지 않는다", async () => {
    const r = repo({ lastCommit: HEAD });
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    await syncGitNexusIndex(r.root, realDeps(r, "10 10"));
    await waitForRelease(r.lockPath);
    expect(readCalls(r).every((c) => c.startsWith("cypher "))).toBe(true);
    expect(readLog(r)).toContain("integrity: 10/10 Function rows have their id");
  });

  test.skipIf(process.platform !== "win32")("조회 뒤 DB가 열려 복구를 미루면 같은 커밋에서도 다음 세션이 다시 시도한다", async () => {
    const r = repo({ lastCommit: HEAD });
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    fs.writeFileSync(path.join(r.storage, "lbug"), "db");
    const trigger = path.join(r.storage, "hold-on-count");
    const pidFile = path.join(r.storage, "holder.pid");
    fs.writeFileSync(trigger, "");
    const d = realDeps(r, "10 4");
    try {
      expect(await syncGitNexusIndex(r.root, d)).toBe("started");
      await waitForRelease(r.lockPath);
      expect(readLog(r)).toContain("rebuild deferred");
      expect(readCalls(r).every((c) => c.startsWith("cypher "))).toBe(true);
      expect(fs.existsSync(path.join(r.storage, "autosync-health.json"))).toBe(false);
    } finally {
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        process.kill(pid);
        await waitForExit(pid);
      }
      fs.unlinkSync(trigger);
    }
    expect(await syncGitNexusIndex(r.root, d)).toBe("started");
    await waitForRelease(r.lockPath);
    expect(readLog(r)).toContain("integrity: 10/10 Function rows have their id");
    expect(await syncGitNexusIndex(r.root, d)).toBe("fresh");
  });

  test.skipIf(process.platform !== "win32")("다른 프로세스가 색인 DB를 열고 있으면 analyze 없이 건너뛴다", async () => {
    const r = repo();
    fs.writeFileSync(path.join(r.storage, "exit.txt"), "0");
    fs.writeFileSync(path.join(r.storage, "lbug"), "db");
    const held = fs.openSync(path.join(r.storage, "lbug"), "r");
    try {
      expect(await syncGitNexusIndex(r.root, realDeps(r))).toBe("started");
      await waitForRelease(r.lockPath);
    } finally {
      fs.closeSync(held);
    }
    expect(readLog(r)).toContain("skip: index DB is open by another process");
    expect(fs.existsSync(path.join(r.storage, "calls.txt"))).toBe(false);
  });
});
