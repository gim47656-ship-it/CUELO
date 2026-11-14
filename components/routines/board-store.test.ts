import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { RoutinePostSummary } from "@/lib/routines/store";
import { isNewRoutinePost, markAllRoutinePostsRead } from "./board-store";

/**
 * Faked boundaries: `localStorage` (a Map that counts writes) and `fetch` (records each POST body).
 * `navigator.locks` is absent, so the store writes straight away, as it does on plain http.
 */
const storage = new Map<string, string>();
let writes = 0;
let posted: string[][] = [];
const fakeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    writes += 1;
    storage.set(key, value);
  },
};
const fakeFetch = async (_url: string, init: { body: string }) => {
  const body: unknown = JSON.parse(init.body);
  if (body && typeof body === "object" && "keys" in body && Array.isArray(body.keys)) posted.push(body.keys.map(String));
  return new Response("{}", { status: 200 });
};
// Installed for this file only: one bun process runs every test file, so a fetch left faked
// here breaks later files that call the real one.
const realGlobals = { localStorage: Reflect.get(globalThis, "localStorage"), fetch: globalThis.fetch };
beforeAll(() => {
  Object.assign(globalThis, { localStorage: fakeStorage, fetch: fakeFetch });
});
afterAll(() => {
  Object.assign(globalThis, realGlobals);
});

const NOW = Date.parse("2026-11-14T12:00:00Z");
/** The read-state logic uses only `file` and `startedAt`; the other metadata is irrelevant here. */
const post = (file: string, startedAt: string): RoutinePostSummary => ({ file, startedAt } as RoutinePostSummary);
const stored = (): string[] => JSON.parse(storage.get("cuelo-routine-read-posts") ?? "[]");

describe("markAllRoutinePostsRead", () => {
  beforeEach(() => {
    posted = [];
    writes = 0;
  });

  test("marks every new post of the given routines read and skips old ones", () => {
    const routines = [
      { id: "daily", posts: [post("20261114T0900-a.md", "2026-11-14T09:00:00Z"), post("20261101T0900-old.md", "2026-11-01T09:00:00Z")] },
      { id: "weekly", posts: [post("20261113T0800-b.md", "2026-11-13T08:00:00Z")] },
    ];
    expect(markAllRoutinePostsRead(routines, NOW)).toBe(2);
    expect(stored()).toEqual(expect.arrayContaining(["daily/20261114T0900-a.md", "weekly/20261113T0800-b.md"]));
    expect(stored()).not.toContain("daily/20261101T0900-old.md");
    expect(posted).toEqual([["daily/20261114T0900-a.md", "weekly/20261113T0800-b.md"]]);
    expect(isNewRoutinePost("daily", routines[0].posts[0], new Set(stored()), NOW)).toBe(false);
  });

  test("shares more than 500 keys in batches of at most 500 and writes storage once", () => {
    const posts = Array.from({ length: 1203 }, (_, i) => post(`20261114T1000-${i}.md`, "2026-11-14T10:00:00Z"));
    expect(markAllRoutinePostsRead([{ id: "bulk", posts }], NOW)).toBe(1203);
    expect(writes).toBe(1);
    expect(posted.map((batch) => batch.length)).toEqual([500, 500, 203]);
    expect(stored()).toContain("bulk/20261114T1000-1202.md");
  });

  test("is idempotent: a second pass finds nothing new and sends nothing", () => {
    const routines = [{ id: "daily", posts: [post("20261114T0900-a.md", "2026-11-14T09:00:00Z")] }];
    expect(markAllRoutinePostsRead(routines, NOW)).toBe(0);
    expect(writes).toBe(0);
    expect(posted).toEqual([]);
  });
});
