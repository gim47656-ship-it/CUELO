import { afterAll, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBuildReservationStore, BUILD_RESERVATION_MS, BUILD_TOMBSTONE_RETENTION_MS } from "./build-reservations";

const root = mkdtempSync(join(tmpdir(), "build-reservation-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("back-to-back sessions refuse until the exact reservation expiry, then allow", () => {
  let now = 1700000000000;
  const directory = join(root, "expiry");
  const first = createBuildReservationStore(directory, () => now);
  const second = createBuildReservationStore(directory, () => now);
  const owner = { cwd: "/work/first", sessionId: "first" };
  expect(first.reserve(owner)).toBeUndefined();
  expect(second.reserve({ cwd: "/work/second", sessionId: "second" })).toEqual({ ...owner, createdAt: now });
  now += BUILD_RESERVATION_MS - 1;
  expect(second.reserve({ cwd: "/work/second", sessionId: "second" })?.sessionId).toBe("first");
  now += 1;
  expect(second.reserve({ cwd: "/work/second", sessionId: "second" })).toBeUndefined();
  expect(first.reserve(owner)?.sessionId).toBe("second");
});

test("independent OS processes claim one reservation, including reclaim of an expired revision", async () => {
  const directory = join(root, "concurrent");
  const old = createBuildReservationStore(directory, () => 1);
  expect(old.reserve({ cwd: "/work/old", sessionId: "expired" })).toBeUndefined();
  const module = new URL("./build-reservations.ts", import.meta.url).pathname;
  const code = `import {createBuildReservationStore} from ${JSON.stringify(module)};
    await new Response(Bun.stdin).text();
    const blocked=createBuildReservationStore(process.argv[1]).reserve({cwd:process.cwd(),sessionId:String(process.pid)});
    console.log(blocked ? "refused" : "allowed");`;
  const children = Array.from({ length: 4 }, () => Bun.spawn([process.execPath, "-e", code, directory], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  }));
  for (const child of children) child.stdin.end();
  const results = await Promise.all(children.map(async (child) => {
    const [exit, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]);
    expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
    return stdout.trim();
  }));
  expect(results.filter((result) => result === "allowed")).toHaveLength(1);
  expect(results.filter((result) => result === "refused")).toHaveLength(3);
});

test("filesystem errors fail open and log rather than disabling all build commands", () => {
  const file = join(root, "not-a-directory");
  writeFileSync(file, "existing file");
  const logs: string[] = [];
  const store = createBuildReservationStore(file, Date.now, (message) => logs.push(message));
  expect(store.reserve({ cwd: "/work", sessionId: "first" })).toBeUndefined();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("예약 파일 오류");
});

test("a corrupt latest claim is ignored once, then subsequent starts are reserved normally", () => {
  for (const [index, payload] of [
    "", "{", "null", '{"createdAt":null}', '{"createdAt":1700000000001}', '{"createdAt":9000000000000000}',
  ].entries()) {
    const directory = join(root, `corrupt-${index}`);
    mkdirSync(directory);
    writeFileSync(join(directory, "1.json"), payload);
    const logs: string[] = [];
    const store = createBuildReservationStore(directory, () => 1700000000000, (message) => logs.push(message));
    expect(store.reserve({ cwd: "/work/first", sessionId: "first" })).toBeUndefined();
    expect(store.reserve({ cwd: "/work/second", sessionId: "second" })?.sessionId).toBe("first");
    expect(logs).toHaveLength(1);
  }
});

test("prune old tombstones but retain the latest claim and recent revisions", () => {
  const directory = join(root, "retention");
  mkdirSync(directory);
  const now = 1700000000000;
  for (const revision of [1, 2, 3, 4]) {
    const path = join(directory, `${revision}.json`);
    writeFileSync(path, JSON.stringify({ createdAt: now, cwd: "/active", sessionId: "active" }));
    const modified = new Date(revision === 3 ? now : now - BUILD_TOMBSTONE_RETENTION_MS - 1);
    utimesSync(path, modified, modified);
  }
  const store = createBuildReservationStore(directory, () => now);
  expect(store.reserve({ cwd: "/later", sessionId: "later" })?.sessionId).toBe("active");
  expect(readdirSync(directory).sort()).toEqual(["3.json", "4.json"]);
});

test("a delayed contender cannot allow by recreating an old pruned revision", () => {
  const directory = join(root, "delayed");
  mkdirSync(directory);
  let now = Date.now();
  const path = join(directory, "1.json");
  writeFileSync(path, JSON.stringify({ createdAt: 1, cwd: "/old", sessionId: "old" }));
  utimesSync(path, new Date(1), new Date(1));
  const other = createBuildReservationStore(directory, () => now);
  let paused = true;
  const delayed = createBuildReservationStore(directory, () => now, console.warn, (source, destination) => {
    if (paused) {
      paused = false;
      expect(other.reserve({ cwd: "/second", sessionId: "second" })).toBeUndefined();
      now += 2 * BUILD_TOMBSTONE_RETENTION_MS;
      expect(other.reserve({ cwd: "/third", sessionId: "third" })).toBeUndefined();
      now += 2 * BUILD_TOMBSTONE_RETENTION_MS;
      expect(other.reserve({ cwd: "/fourth", sessionId: "fourth" })).toBeUndefined();
    }
    linkSync(source, destination);
  });
  expect(delayed.reserve({ cwd: "/delayed", sessionId: "delayed" })?.sessionId).toBe("fourth");
});
