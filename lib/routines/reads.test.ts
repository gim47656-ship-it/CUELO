import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitRoutineChange, syncRoutineRepo } from "./git-sync";
import { FLUSH_DELAY_MS, flushRoutineReads, mergeOwnReads, queueRoutineReads, readSavedReadKeys, routineReadKeys } from "./reads";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();

/** 실행 시각 `at`(ms)의 글 키. 파일 이름의 시각은 한국 시간이다. */
function keyAt(at: number, routine = "r-1", host = "instabox"): string {
  const iso = new Date(at + 9 * 3_600_000).toISOString();
  return `${routine}/${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}-${host}.md`;
}

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const ownFile = (dir: string, host: string) => join(dir, "reads", `${host}.json`);
const writeReads = (dir: string, host: string, content: unknown) => {
  mkdirSync(join(dir, "reads"), { recursive: true });
  writeFileSync(ownFile(dir, host), typeof content === "string" ? content : JSON.stringify(content));
};

const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

const savedSource = process.env.CUELO_NIGHTLY_SOURCE;
beforeEach(() => {
  process.env.CUELO_NIGHTLY_SOURCE = "host-a";
});
afterEach(() => {
  const held = globalThis.__cueloRoutineReads;
  if (held?.timer) clearTimeout(held.timer);
  globalThis.__cueloRoutineReads = undefined;
  if (savedSource === undefined) delete process.env.CUELO_NIGHTLY_SOURCE;
  else process.env.CUELO_NIGHTLY_SOURCE = savedSource;
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("saved read keys", () => {
  test("union of every host's file", () => {
    const dir = temp("reads-union-");
    const a = keyAt(now - DAY, "r-1");
    const b = keyAt(now - 2 * DAY, "r-2");
    const c = keyAt(now - 3 * DAY, "r-1", "cuelo-home");
    writeReads(dir, "instabox", { version: 1, posts: [a, b] });
    writeReads(dir, "cuelo-home", { version: 1, posts: [b, c] });
    expect([...readSavedReadKeys(dir, now)].sort()).toEqual([a, b, c].sort());
  });

  test("ignores broken, other-version and malformed content, wrong keys and non-json files", () => {
    const dir = temp("reads-bad-");
    const good = keyAt(now - DAY);
    writeReads(dir, "good", { version: 1, posts: [good, "../etc/passwd", "r-1", "r-1/a/b.md", "R-1/x.md", 5, keyAt(now - DAY, "r-1", "UP PER")] });
    writeReads(dir, "broken", "{not json");
    writeReads(dir, "v2", { version: 2, posts: [keyAt(now - 2 * DAY, "r-9")] });
    writeReads(dir, "noposts", { version: 1 });
    writeReads(dir, "array", [keyAt(now - 2 * DAY, "r-8")]);
    writeFileSync(join(dir, "reads", "note.txt"), JSON.stringify({ version: 1, posts: [keyAt(now - 2 * DAY, "r-7")] }));
    expect([...readSavedReadKeys(dir, now)]).toEqual([good]);
  });

  test("drops keys older than the keep window and keys with impossible dates", () => {
    const dir = temp("reads-old-");
    const fresh = keyAt(now - 7 * DAY);
    writeReads(dir, "a", { version: 1, posts: [fresh, keyAt(now - 9 * DAY, "r-2"), "r-3/20261340T2561-x.md"] });
    expect([...readSavedReadKeys(dir, now)]).toEqual([fresh]);
  });

  test("does not follow symlinks out of the repository", () => {
    const dir = temp("reads-link-");
    const outside = temp("reads-outside-");
    const key = keyAt(now - DAY);
    writeFileSync(join(outside, "secret.json"), JSON.stringify({ version: 1, posts: [key] }));
    mkdirSync(join(dir, "reads"));
    symlinkSync(join(outside, "secret.json"), ownFile(dir, "linked"));
    expect(readSavedReadKeys(dir, now).size).toBe(0);

    const dir2 = temp("reads-linkdir-");
    mkdirSync(join(outside, "folder"));
    writeFileSync(join(outside, "folder", "x.json"), JSON.stringify({ version: 1, posts: [key] }));
    symlinkSync(join(outside, "folder"), join(dir2, "reads"));
    expect(readSavedReadKeys(dir2, now).size).toBe(0);
  });
});

describe("own reads file", () => {
  test("merges into only this host's file, keeps earlier keys and prunes old ones", () => {
    const dir = temp("reads-merge-");
    const old = keyAt(now - 9 * DAY, "r-old");
    const kept = keyAt(now - 2 * DAY, "r-kept");
    const other = keyAt(now - DAY, "r-other");
    writeReads(dir, "host-b", { version: 1, posts: [other] });
    const otherBefore = readFileSync(ownFile(dir, "host-b"), "utf8");
    writeReads(dir, "host-a", { version: 1, posts: [old, kept] });
    const added = keyAt(now - 3600_000, "r-new");
    const result = mergeOwnReads(dir, "host-a", [added, "garbage", keyAt(now - 10 * DAY, "r-ancient")], now);
    expect(result.paths).toEqual(["reads/host-a.json"]);
    expect(JSON.parse(readFileSync(ownFile(dir, "host-a"), "utf8"))).toEqual({ version: 1, posts: [kept, added].sort() });
    expect(readFileSync(ownFile(dir, "host-b"), "utf8")).toBe(otherBefore);
    expect(existsSync(`${ownFile(dir, "host-a")}.tmp`)).toBe(false);
  });

  test("an unchanged merge rewrites nothing but still names the file so a failed earlier commit gets retried", () => {
    const dir = temp("reads-same-");
    const key = keyAt(now - DAY);
    expect(mergeOwnReads(dir, "host-a", [key], now)).toEqual({ paths: ["reads/host-a.json"], result: 1 });
    const written = readFileSync(ownFile(dir, "host-a"), "utf8");
    expect(mergeOwnReads(dir, "host-a", [key], now)).toEqual({ paths: ["reads/host-a.json"], result: 0 });
    expect(readFileSync(ownFile(dir, "host-a"), "utf8")).toBe(written);
    expect(mergeOwnReads(temp("reads-empty-"), "host-a", [], now)).toEqual({ paths: [], result: 0 });
  });

  test("never writes through a pre-planted symlink next to the own file", () => {
    const dir = temp("reads-tmp-link-");
    const outside = temp("reads-sentinel-");
    const sentinel = join(outside, "sentinel.txt");
    writeFileSync(sentinel, "untouched");
    mkdirSync(join(dir, "reads"));
    symlinkSync(sentinel, `${ownFile(dir, "host-a")}.tmp`);
    mergeOwnReads(dir, "host-a", [keyAt(now - DAY)], now);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  });

  test("refuses unsafe host names and a symlinked own file", () => {
    const dir = temp("reads-unsafe-");
    const key = keyAt(now - DAY);
    for (const host of ["../evil", "a/b", "A", "", "-x", "a.b"]) expect(() => mergeOwnReads(dir, host, [key], now)).toThrow();
    const outside = temp("reads-target-");
    mkdirSync(join(dir, "reads"));
    symlinkSync(join(outside, "target.json"), ownFile(dir, "host-a"));
    expect(() => mergeOwnReads(dir, "host-a", [key], now)).toThrow();
    expect(existsSync(join(outside, "target.json"))).toBe(false);
  });
});

describe("pending reads", () => {
  test("queue drops invalid or old keys and shows up in the served set", () => {
    const dir = temp("reads-queue-");
    const key = keyAt(now - DAY);
    expect(queueRoutineReads(dir, [key, "nope", keyAt(now - 9 * DAY, "r-2")], now)).toBe(1);
    expect(routineReadKeys(dir, now)).toEqual([key]);
    expect(FLUSH_DELAY_MS).toBeGreaterThanOrEqual(30_000);
    expect(FLUSH_DELAY_MS).toBeLessThanOrEqual(60_000);
  });

  test("a failed flush keeps the keys for the next attempt", async () => {
    const dir = temp("reads-failflush-");
    mkdirSync(join(dir, "reads"));
    symlinkSync(temp("reads-nowhere-"), join(dir, "reads", "host-a.json"));
    const key = keyAt(now - 3600_000);
    queueRoutineReads(dir, [key]);
    await flushRoutineReads();
    expect(routineReadKeys(dir)).toEqual([key]);
    expect(globalThis.__cueloRoutineReads?.timer).not.toBeNull();
  });
});

describe("through real git", () => {
  function setup() {
    const root = temp("reads-git-");
    const remote = join(root, "remote.git");
    sh(root, "init", "--bare", "-b", "main", remote);
    const seed = join(root, "seed");
    sh(root, "clone", "-q", remote, seed);
    mkdirSync(join(seed, "routines", "r-1"), { recursive: true });
    writeFileSync(join(seed, "routines", "r-1", "routine.json"), "{}\n");
    sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "add", "-A");
    sh(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");
    sh(seed, "push", "-q", "-u", "origin", "HEAD:main");
    const clone = (name: string) => {
      const dir = join(root, name);
      sh(root, "clone", "-q", remote, dir);
      sh(dir, "config", "user.name", name);
      sh(dir, "config", "user.email", `${name}@t`);
      return dir;
    };
    return { remote, a: clone("a"), b: clone("b") };
  }
  const remoteFile = (remote: string, host: string) => JSON.parse(sh(remote, "show", `main:reads/${host}.json`)) as { posts: string[] };

  test("A flushes and pushes, B sees the union after a sync", async () => {
    const { remote, a, b } = setup();
    const keyA = keyAt(now - 3600_000, "r-1", "host-a");
    queueRoutineReads(a, [keyA]);
    const startedAt = performance.now();
    await flushRoutineReads();
    const flushMs = performance.now() - startedAt;
    expect(remoteFile(remote, "host-a").posts).toEqual([keyA]);
    expect(sh(a, "log", "-1", "--format=%s")).toBe("reads(host-a): 1 posts\n");
    expect(globalThis.__cueloRoutineReads?.keys.size).toBe(0);

    // B already has its own file locally.
    process.env.CUELO_NIGHTLY_SOURCE = "host-b";
    const keyB = keyAt(now - 7200_000, "r-1", "host-b");
    queueRoutineReads(b, [keyB]);
    await flushRoutineReads();
    expect(readSavedReadKeys(b).has(keyB)).toBe(true);
    const syncStart = performance.now();
    await syncRoutineRepo(b);
    const syncMs = performance.now() - syncStart;
    expect([...readSavedReadKeys(b)].sort()).toEqual([keyA, keyB].sort());
    console.log(`reads latency (local bare remote): flush+push ${flushMs.toFixed(0)} ms, B sync ${syncMs.toFixed(0)} ms`);
    expect(sh(b, "status", "--porcelain")).toBe("");
  });

  test("a push rejected because the other PC pushed first still lands both files", async () => {
    const { remote, a, b } = setup();
    const keyA = keyAt(now - 3600_000, "r-1", "host-a");
    const keyB = keyAt(now - 7200_000, "r-1", "host-b");
    // B pulls first inside commitRoutineChange; A's commit reaches the remote only afterwards (inside mutate),
    // so B's first push is rejected as non-fast-forward.
    await commitRoutineChange(b, "reads(host-b): 1 posts", () => {
      sh(a, "pull", "-q", "--rebase");
      mergeOwnReads(a, "host-a", [keyA]);
      sh(a, "add", "-A");
      sh(a, "commit", "-q", "-m", "reads(host-a): 1 posts");
      sh(a, "push", "-q");
      return mergeOwnReads(b, "host-b", [keyB]);
    });
    expect(remoteFile(remote, "host-a").posts).toEqual([keyA]);
    expect(remoteFile(remote, "host-b").posts).toEqual([keyB]);
    expect(sh(b, "rev-list", "--count", "@{u}..HEAD").trim()).toBe("0");
  });

  test("a commit that failed after the file was written is committed by the next flush", async () => {
    const { remote, a } = setup();
    const key = keyAt(now - 3600_000, "r-1", "host-a");
    const hook = join(a, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    queueRoutineReads(a, [key]);
    await flushRoutineReads();
    expect(globalThis.__cueloRoutineReads?.keys.size).toBe(1);
    rmSync(hook);
    await flushRoutineReads();
    expect(globalThis.__cueloRoutineReads?.keys.size).toBe(0);
    expect(remoteFile(remote, "host-a").posts).toEqual([key]);
    expect(sh(a, "status", "--porcelain")).toBe("");
  });

  test("a commit that failed after pruning the file to empty is committed by the retry", async () => {
    const { remote, a } = setup();
    const expired = keyAt(now - 9 * DAY, "r-1", "host-a");
    mkdirSync(join(a, "reads"));
    writeFileSync(join(a, "reads", "host-a.json"), `${JSON.stringify({ version: 1, posts: [expired] })}\n`);
    sh(a, "add", "-A");
    sh(a, "commit", "-q", "-m", "old reads");
    sh(a, "push", "-q");
    const hook = join(a, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const prune = () => commitRoutineChange(a, "reads(host-a): prune", () => mergeOwnReads(a, "host-a", []));
    await expect(prune()).rejects.toThrow();
    rmSync(hook);
    await prune();
    expect(remoteFile(remote, "host-a").posts).toEqual([]);
    expect(sh(a, "status", "--porcelain")).toBe("");
  });

  test("an offline flush keeps a local commit that a later sync pushes", async () => {
    const { remote, a } = setup();
    const key = keyAt(now - 3600_000, "r-1", "host-a");
    sh(a, "remote", "set-url", "origin", join(remote, "missing"));
    queueRoutineReads(a, [key]);
    await flushRoutineReads();
    expect(sh(a, "rev-list", "--count", "@{u}..HEAD").trim()).toBe("1");
    expect(globalThis.__cueloRoutineReads?.keys.size).toBe(0);
    sh(a, "remote", "set-url", "origin", remote);
    await syncRoutineRepo(a);
    expect(remoteFile(remote, "host-a").posts).toEqual([key]);
  });
});
