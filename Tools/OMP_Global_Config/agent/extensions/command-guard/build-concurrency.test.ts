import { describe, expect, test } from "bun:test";
import {
  buildConcurrencyBlockReason,
  MIN_BUILD_AVAILABLE_BYTES,
  readBuildResources,
  type BuildResourceReaders,
} from "./build-concurrency";

function fakeProc(options: { bytes?: number; argv?: string[][]; fail?: string; currentPid?: number } = {}) {
  const files = new Map<string, string>([
    ["/proc/meminfo", `MemTotal: 32000000 kB\nMemAvailable: ${(options.bytes ?? MIN_BUILD_AVAILABLE_BYTES) / 1024} kB\n`],
    ["/proc/stat", "cpu 1 2 3\nbtime 1700000000\n"],
  ]);
  const pids = (options.argv ?? []).map((argv, index) => {
    const pid = String(100 + index);
    files.set(`/proc/${pid}/cmdline`, argv.join("\0") + "\0");
    files.set(`/proc/${pid}/stat`, `${pid} (next (build)) S ${Array(18).fill("0").join(" ")} 12300 0`);
    files.set(`/proc/${pid}/environ`, "OTHER=value\0CUELO_DIST_DIR=.next-verify-owner\0");
    return pid;
  });
  const logs: string[] = [];
  let reads = 0;
  const readers: BuildResourceReaders = {
    currentPid: options.currentPid ?? 999,
    listPids: () => {
      if (options.fail === "/proc") throw new Error("proc unavailable");
      return ["self", ...pids];
    },
    readFile: (path) => {
      reads += 1;
      if (path === options.fail) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("exited"), { code: "ENOENT" });
      return value;
    },
    readLink: (path) => {
      if (path === options.fail) throw new Error("cwd unreadable");
      return "/work/other-maker";
    },
    log: (message) => logs.push(message),
  };
  return { readers, logs, files, reads: () => reads };
}

const buildArgv = ["/usr/bin/node", "/work/node_modules/next/dist/bin/next", "build", "--webpack"];

describe("machine-wide production build guard", () => {
  test("another build refuses and identifies PID, cwd, start time, dist and memory", () => {
    const proc = fakeProc({ argv: [buildArgv] });
    const reason = buildConcurrencyBlockReason("bun --bun next build --webpack", proc.readers);
    expect(reason).toContain("[BuildConcurrencyGuard]");
    expect(reason).toContain("pid=100 cwd=/work/other-maker");
    expect(reason).toContain("시작=2023-11-14T22:15:23.000Z");
    expect(reason).toContain("dist=.next-verify-owner");
    expect(reason).toContain("MemAvailable=6.00 GiB");
    expect(reason).toContain("한 번에 하나만");
    expect(proc.logs).toEqual([]);
  });

  test("low memory refuses without a build, exact threshold and above allow", () => {
    const low = fakeProc({ bytes: MIN_BUILD_AVAILABLE_BYTES - 1024 });
    expect(buildConcurrencyBlockReason("next build", low.readers)).toContain("프로덕션 빌드 명령을 차단");
    expect(buildConcurrencyBlockReason("next build", fakeProc().readers)).toBeUndefined();
    expect(buildConcurrencyBlockReason("next build", fakeProc({ bytes: MIN_BUILD_AVAILABLE_BYTES + 1024 }).readers)).toBeUndefined();
  });

  for (const command of [
    "npm --offline exec --call='next build'",
    "npm --prefix web exec --call='next build'",
    "npx -c='next build'",
    "npm exec -c='next build'",
    "npm --offline --prefix=web exec --call 'next build'",
    "npm --cache /tmp/cache --registry=https://registry.npmjs.org exec -c 'next build'",
    "npm --workspace web --yes exec --package=next -c='next build'",
    "env CI=1 nice npm --prefix web exec -c='next build'",
    "bash -lc \"npm --offline exec -c='next build'\"",
    "npm --scope @org exec -c='next build'",
    "npm --proxy http://localhost:8080 --cafile cert.pem exec -c='next build'",
    "npm --color always --depth 1 --auth-type legacy exec -c='next build'",
    "npm x -c='next build'",
    "npm --offline x --call='next build'",
    "npm --offline false --color exec -c='next build'",
    "npm --color always exec --offline false -c='next build'",
    "npm -L project --userconfig config -C web exec -c='next build'",
    "npm --reg https://registry.npmjs.org exec -c='next build'",
    "npm --enjoy-by 2024-01-01 exec -c='next build'",
    "npm -reg https://registry.npmjs.org x -c='next build'",
    "npm -enjoy-by 2024-01-01 x -c='next build'",
  ]) {
    test(`call form enters low-memory and active-process checks: ${command}`, () => {
      expect(buildConcurrencyBlockReason(command, fakeProc({ bytes: 1024 }).readers)).toContain("MemAvailable=0.00 GiB");
      expect(buildConcurrencyBlockReason(command, fakeProc({ argv: [buildArgv] }).readers)).toContain("pid=100");
    });
  }

  test("runners, env, wrappers, nested shells and chains reach the same refusal", () => {
    const proc = fakeProc({ argv: [buildArgv] });
    for (const command of [
      "next build", "./node_modules/.bin/next build", "bun --bun next build --webpack",
      "bunx next@16 build", "npx --yes next build", "node ./node_modules/next/dist/bin/next build",
      "bun run build", "npm run build", "pnpm build", "pnpm run build", "yarn build",
      "npm exec -- next build", "pnpm exec next build", "bun run next build",
      "pnpm --filter web build", "npm -w web run build", "yarn workspace web build", "pnpm dlx next build",
      "pnpm -w build", "pnpm --workspace-root build", "pnpm -w run build",
      "npx -w web next build", "npx -w web -c 'next build'",
      "npx -c 'next build'", "npm exec --call='next build'",
      "npx --package next -c 'next build'", "npm exec --package next --call 'next build'",
      "CUELO_DIST_DIR=.next-verify-1 bun --bun next build --webpack",
      "env CUELO_DIST_DIR=.next-verify-2 bun run build",
      "systemd-run --user --scope -p MemoryMax=8G --unit verify -- bun --bun next build",
      "systemd-run --user --scope --property=MemoryMax=8G -- bun run build",
      "systemd-run --user --scope --nice 10 next build",
      "systemd-run --user --on-active 1m --timer-property AccuracySec=1s -- next build",
      "bash -lc 'CUELO_DIST_DIR=.next-verify-3 bun --bun next build --webpack'",
      "bun test && bun run build",
    ]) {
      expect(buildConcurrencyBlockReason(command, proc.readers), command).toContain("pid=100");
    }
  });

  test("tests/typecheck/dev/start and quoted mentions never probe or refuse even under pressure", () => {
    const proc = fakeProc({ bytes: 1024, argv: [buildArgv] });
    // Positive control: removing the guard must not make this collection silently pass.
    expect(buildConcurrencyBlockReason("next build", proc.readers)).toContain("pid=100");
    const before = proc.reads();
    for (const command of [
      "bun test", "bun run typecheck", "npm run lint", "next dev", "next start",
      "bun --bun next start", "npx next dev", "pnpm test", "echo 'next build'",
      "printf '%s' 'bun run build'", "# next build\necho ok", "node -e 'console.log(\"next build\")'",
      "npx jest -c 'next build'", "npx -- jest -c 'next build'", "npm exec -- eslint -c 'next build'",
      "npx jest -c='next build'", "npm exec jest -c='next build'",
      "npm --prefix web exec -- jest -c='next build'",
      "npm --offline exec -- -c='next build'", "npx -- -c='next build'",
      "npm --prefix exec echo --call='next build'",
      "npm --cache exec echo --call='next build'",
      "npm run echo --call='next build'",
      "npm --offline exec --call=\"echo 'next build'\"",
      "echo \"npm --offline exec --call='next build'\"",
      "npm --scope exec echo --call='next build'",
      "npm --offline x jest -c='next build'",
      "npm --scope @org x -- jest -c='next build'",
    ]) expect(buildConcurrencyBlockReason(command, proc.readers), command).toBeUndefined();
    expect(proc.reads()).toBe(before);
  });

  test("running servers, tests and shell arguments are not builds; current process is excluded", () => {
    const proc = fakeProc({ argv: [
      ["next-server (v16.0.0)"], ["next-render-worker-app"], ["node", "next", "start"], ["next", "dev"],
      ["bun", "test", "build.test.ts"], ["bash", "-lc", "next build"], buildArgv,
    ], currentPid: 106 });
    expect(buildConcurrencyBlockReason("next build", fakeProc({ argv: [buildArgv] }).readers)).toContain("pid=100");
    expect(readBuildResources(proc.readers)).toEqual({ availableBytes: MIN_BUILD_AVAILABLE_BYTES, builds: [] });
    expect(buildConcurrencyBlockReason("next build", proc.readers)).toBeUndefined();
  });

  test("explicit Next build titles and package build processes refuse, multiple PIDs are listed", () => {
    const proc = fakeProc({ argv: [["next build (v16.0.0)"], ["bun", "run", "build"]] });
    const reason = buildConcurrencyBlockReason("next build", proc.readers);
    expect(reason).toContain("pid=100");
    expect(reason).toContain("pid=101");
  });

  test("proc listing, meminfo, cmdline or metadata failure logs and allows", () => {
    expect(buildConcurrencyBlockReason("next build", fakeProc({ argv: [buildArgv] }).readers)).toContain("pid=100");
    for (const fail of ["/proc", "/proc/meminfo", "/proc/100/cmdline", "/proc/100/cwd", "/proc/100/stat", "/proc/stat", "/proc/100/environ"]) {
      const proc = fakeProc({ argv: [buildArgv], fail });
      expect(buildConcurrencyBlockReason("next build", proc.readers), fail).toBeUndefined();
      expect(proc.logs).toHaveLength(1);
      expect(proc.logs[0]).toContain("/proc 조회 실패");
    }
  });

  test("missing MemAvailable fails open; an exited process does not hide another live build", () => {
    const missing = fakeProc();
    missing.files.set("/proc/meminfo", "MemTotal: 32000000 kB\n");
    expect(buildConcurrencyBlockReason("next build", missing.readers)).toBeUndefined();
    expect(missing.logs[0]).toContain("MemAvailable");
    const exited = fakeProc({ argv: [buildArgv, buildArgv] });
    exited.files.delete("/proc/100/cmdline");
    const reason = buildConcurrencyBlockReason("next build", exited.readers);
    expect(reason).toContain("pid=101");
    expect(reason).not.toContain("pid=100");
  });
});
