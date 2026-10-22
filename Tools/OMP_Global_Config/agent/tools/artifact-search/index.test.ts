import { afterAll, describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import { SessionManager, type CustomToolContext } from "@oh-my-pi/pi-coding-agent";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createArtifactSearchTool, MAX_ARTIFACT_BYTES, parseArtifactPath, planQuery, type ArtifactSearchDetails } from "./index";

// 검증 범위: 실제 SessionManager/ArtifactManager가 만든 artifact 파일을 이 도구가 색인·검색하는 동작(격리, 위치표, 취소, 수명주기, 거부).
// 가짜 경계: 없음. 모델·네트워크는 쓰지 않는다. 실제 `read` 도구와의 줄 번호 일치는 evidence/smoke.ts.txt(SDK 스모크)가 증명한다.
// 미증명: 실제 모델이 이 도구를 고르는지, 수 MiB를 넘는 로그에서의 지연(벤치마크 evidence 참고).

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-search-test-"));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

interface Fixture {
  sm: SessionManager;
  ctx: CustomToolContext;
  save(content: string, toolType?: string): Promise<string>;
  dir(): string;
}

let counter = 0;
function session(): Fixture {
  const root = path.join(scratch, `s${counter++}`);
  fs.mkdirSync(root, { recursive: true });
  const sm = SessionManager.create(root, path.join(root, "sessions"));
  // Test seam: execute() only reads sessionManager.getArtifactManager(); the rest of the context is unused.
  const ctx = { sessionManager: sm } as unknown as CustomToolContext;
  const manager = sm.getArtifactManager();
  if (!manager) throw new Error("fixture session has no artifact manager");
  return { sm, ctx, save: (content, toolType = "bash") => manager.save(content, toolType), dir: () => manager.dir };
}

function newTool(readChunkBytes?: number) {
  return createArtifactSearchTool({ zod }, { readChunkBytes });
}
type Tool = ReturnType<typeof newTool>;

async function search(tool: Tool, ctx: CustomToolContext, id: string, query: string, extra: { limit?: number; offset?: number; signal?: AbortSignal } = {}) {
  const result = await tool.execute("t", { path: `artifact://${id}`, query, limit: extra.limit, offset: extra.offset }, undefined, ctx, extra.signal);
  return { text: result.content[0].text, details: result.details as ArtifactSearchDetails };
}

/** The line numbers a result block reports as hits (`  <line>: ...`). */
function hitLines(text: string): number[] {
  return [...text.matchAll(/^ {2}(\d+): /gm)].map((m) => Number(m[1]));
}
function sha(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
/**
 * Runs `hook` just before the nth FileHandle.read of the next indexing, so cancellation lands inside the build
 * deterministically instead of by timing. Returns the restore function.
 */
async function onNthRead(n: number, hook: () => void): Promise<() => void> {
  const probe = await fs.promises.open(import.meta.path, "r");
  const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = proto.read;
  let calls = 0;
  proto.read = function patched(this: unknown, ...args: unknown[]) {
    if (++calls === n) hook();
    return original.apply(this, args);
  };
  return () => {
    proto.read = original;
  };
}
function noiseLog(lines: number): string[] {
  return Array.from({ length: lines }, (_, i) => `2026-10-22T10:${String(i % 60).padStart(2, "0")}:00Z INFO worker-${i % 7} processed item ${i} in ${i % 13}ms status=ok`);
}

describe("unique error in a long log", () => {
  test("finds the single hidden error and its stack, and the returned locator reads back the original lines", async () => {
    const fx = session();
    const lines = noiseLog(40_000);
    lines[27_345] = "2026-10-22T10:45:00Z ERROR payment-gateway E-QX7731 settlement rejected: ledger mismatch";
    lines[27_346] = "    at Settlement.commit (settle.ts:88:13)";
    lines[27_347] = "    at ZqLedgerReconcileException.throw (ledger.ts:12:3)";
    const id = await fx.save(lines.join("\n"));
    const tool = newTool();

    const { text, details } = await search(tool, fx.ctx, id, "E-QX7731");
    expect(details.total).toBe(1);
    expect(hitLines(text)).toEqual([27_346]);
    const locator = /read: artifact:\/\/\d+:(\d+)-(\d+)/.exec(text)!;
    const slice = lines.slice(Number(locator[1]) - 1, Number(locator[2]));
    expect(slice.join("\n")).toContain("E-QX7731 settlement rejected");
    expect(slice.join("\n")).toContain("ZqLedgerReconcileException");
    expect(text).toContain("discovery only");

    const stack = await search(tool, fx.ctx, id, "ZqLedgerReconcileException");
    expect(stack.details.total).toBe(1);
    expect(hitLines(stack.text)).toEqual([27_348]);
  });

  test("a second search of the same artifact reuses the index; changed content rebuilds it", async () => {
    const fx = session();
    const id = await fx.save("alpha\nneedle-one\n");
    const tool = newTool();
    expect((await search(tool, fx.ctx, id, "alpha")).details.cache).toBe("cold");
    expect((await search(tool, fx.ctx, id, "needle")).details.cache).toBe("warm");
    const file = path.join(fx.dir(), fs.readdirSync(fx.dir()).find((f) => f.startsWith(`${id}.`))!);
    fs.writeFileSync(file, "alpha\nreplacement-token\n");
    fs.utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    const after = await search(tool, fx.ctx, id, "replacement");
    expect(after.details.cache).toBe("cold");
    expect(after.details.total).toBe(1);
    expect((await search(tool, fx.ctx, id, "needle")).details.total).toBe(0);
  });
});

describe("session isolation", () => {
  test("the same artifact id in two session roots never mixes results, including ids missing from one root", async () => {
    const a = session();
    const b = session();
    const idA0 = await a.save("only-in-session-A zebra\n");
    const idB0 = await b.save("only-in-session-B walrus\n");
    const idA1 = await a.save("second artifact of A giraffe\n");
    expect(idA0).toBe(idB0);
    const tool = newTool(); // one tool instance shared by both contexts: the cache must be keyed by store

    expect((await search(tool, a.ctx, idA0, "zebra")).details.total).toBe(1);
    expect((await search(tool, b.ctx, idB0, "zebra")).details.total).toBe(0);
    expect((await search(tool, b.ctx, idB0, "walrus")).details.total).toBe(1);
    expect((await search(tool, a.ctx, idA0, "walrus")).details.total).toBe(0);
    await expect(search(tool, b.ctx, idA1, "giraffe")).rejects.toThrow("does not exist in this session's artifact store");
    expect((await search(tool, a.ctx, idA1, "giraffe")).details.total).toBe(1);
  });

  test("a child session that adopted the parent's artifact manager searches the parent's artifacts", async () => {
    const parent = session();
    const child = session();
    const parentId = await parent.save("parent output with token kestrel\n");
    child.sm.adoptArtifactManager(parent.sm.getArtifactManager()!);
    const tool = newTool();
    expect((await search(tool, child.ctx, parentId, "kestrel")).details.total).toBe(1);
  });
});

describe("path and store admission", () => {
  test("accepts only artifact://<digits>", () => {
    expect(parseArtifactPath("artifact://12")).toBe("12");
    for (const bad of ["artifact://12:1-5", "artifact://12/../x", "artifact://abc", "artifact://", "/etc/passwd", "file:///etc/passwd", "../0.bash.log", "agent://1", "artifact://1?x=1"]) {
      expect(() => parseArtifactPath(bad)).toThrow("artifact://<numeric id>");
    }
  });

  test("refuses a symlinked artifact that points outside the store, and leaves the target untouched", async () => {
    const fx = session();
    const id = await fx.save("placeholder\n");
    const outside = path.join(scratch, "outside-secret.txt");
    fs.writeFileSync(outside, "outside-secret-token\n");
    const link = path.join(fx.dir(), fs.readdirSync(fx.dir()).find((f) => f.startsWith(`${id}.`))!);
    fs.rmSync(link);
    fs.symlinkSync(outside, link);
    await expect(search(newTool(), fx.ctx, id, "outside-secret-token")).rejects.toThrow("symbolic link");
    expect(fs.readFileSync(outside, "utf8")).toBe("outside-secret-token\n");
  });

  test("refuses ambiguous ids instead of guessing a file", async () => {
    const fx = session();
    const id = await fx.save("first file token-one\n");
    fs.writeFileSync(path.join(fx.dir(), `${id}.other.log`), "second file token-two\n");
    await expect(search(newTool(), fx.ctx, id, "token")).rejects.toThrow("ambiguous");
  });

  test("a numeric prefix is not an id: artifact://1 never matches 12.bash.log", async () => {
    const fx = session();
    fs.mkdirSync(fx.dir(), { recursive: true });
    fs.writeFileSync(path.join(fx.dir(), "12.bash.log"), "twelve\n");
    await expect(search(newTool(), fx.ctx, "1", "twelve")).rejects.toThrow("does not exist");
  });

  test("refuses an artifact above the size limit with a native-read fallback and indexes nothing", async () => {
    const fx = session();
    fs.mkdirSync(fx.dir(), { recursive: true });
    const big = path.join(fx.dir(), "40.bash.log");
    fs.closeSync(fs.openSync(big, "w"));
    fs.truncateSync(big, MAX_ARTIFACT_BYTES + 1);
    await expect(search(newTool(), fx.ctx, "40", "anything")).rejects.toThrow("artifact://40:1-200");
  });
});

describe("query handling", () => {
  test("operators and quotes are literal text, never FTS syntax", async () => {
    const fx = session();
    const id = await fx.save("plain line with alpha and beta\nNEAR AND OR NOT markers\n");
    const tool = newTool();
    for (const query of ['alpha" OR "', "alpha*", "(alpha", "NEAR(alpha beta, 1)", "alpha:beta", "-alpha", "alpha^"]) {
      await expect(search(tool, fx.ctx, id, query)).resolves.toBeDefined();
    }
    expect(planQuery('a"b* OR (c)').units).toEqual(["a b", "OR", "c"]);
    await expect(search(tool, fx.ctx, id, '"*()-:^')).rejects.toThrow("no searchable word characters");
    await expect(search(tool, fx.ctx, id, "x".repeat(600))).rejects.toThrow("longer than");
  });

  test("an empty artifact and an absent word report no match with a native-read fallback", async () => {
    const fx = session();
    const empty = await fx.save("");
    const full = await fx.save("hello world\n");
    const tool = newTool();
    const e = await search(tool, fx.ctx, empty, "hello");
    expect(e.details).toMatchObject({ total: 0, lines: 0 });
    expect(e.text).toContain("does not prove the text is absent");
    expect(e.text).toContain(`artifact://${empty}:-100`);
    expect((await search(tool, fx.ctx, full, "missing")).text).toContain("does not prove the text is absent");
  });

  test("when no excerpt holds every word, falls back to any-word matches and says so", async () => {
    const fx = session();
    const lines = noiseLog(200);
    const id = await fx.save([...lines, "firstword appears here", ...noiseLog(200), "secondword appears here"].join("\n"));
    const { text, details } = await search(newTool(), fx.ctx, id, "firstword secondword");
    expect(details.mode).toBe("or");
    expect(text).toContain("ANY of");
    expect(hitLines(text).sort((a, b) => a - b)).toEqual([201, 402]);
  });

  test("pages through every matching range with limit/offset", async () => {
    const fx = session();
    const rows = Array.from({ length: 400 }, (_, i) => (i % 20 === 0 ? `marker-${i} periodic hit ${"x".repeat(60)}` : `filler line ${i} ${"y".repeat(60)}`));
    const id = await fx.save(rows.join("\n"));
    const tool = newTool();
    const seen = new Set<number>();
    let offset = 0;
    let total = -1;
    for (let guard = 0; guard < 20; guard++) {
      const page = await search(tool, fx.ctx, id, "periodic", { limit: 3, offset });
      total = page.details.total;
      for (const line of hitLines(page.text)) seen.add(line);
      if (page.details.nextOffset === null) break;
      expect(page.details.nextOffset).toBe(offset + page.details.shown);
      offset = page.details.nextOffset;
    }
    expect(total).toBeGreaterThan(3);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i * 20 + 1));
    expect((await search(tool, fx.ctx, id, "periodic", { offset: 9999 })).text).toContain("past the");
  });
});

describe("long lines and Unicode", () => {
  test("finds a token deep inside a 600 KB single JSON line and anywhere past a segment cut", async () => {
    const fx = session();
    const filler = Array.from({ length: 30_000 }, (_, i) => `{"k${i}":"v${i}"}`).join(",");
    const json = `{"events":[${filler},{"code":"DEEP-ZK9921","msg":"tail"}],"end":"last-marker-qq7"}`;
    const id = await fx.save(`header line\n${json}\ntrailer line\n`);
    const tool = newTool();
    const deep = await search(tool, fx.ctx, id, "DEEP-ZK9921");
    expect(deep.details.total).toBe(1);
    expect(hitLines(deep.text)).toEqual([2]);
    expect(deep.text).toContain("long line, segment from char");
    expect(deep.text).toContain("first 50 KB");
    const early = await search(tool, fx.ctx, await fx.save(`${"x".repeat(5000)} early-needle-77 ${"y".repeat(5000)}\n`), "early-needle-77");
    expect(early.text).toContain("long line, segment from char");
    expect(early.text).not.toContain("first 50 KB");
    expect((await search(tool, fx.ctx, id, "last-marker-qq7")).details.total).toBe(1);
    expect((await search(tool, fx.ctx, id, "k29999")).details.total).toBeGreaterThan(0);
    expect((await search(tool, fx.ctx, id, "trailer")).details.total).toBe(1);
  });

  test("finds Korean words by whole word or word start, case-insensitively for Latin; no morphology", async () => {
    const fx = session();
    const id = await fx.save("연결 시간초과가 발생했다 ERR_Conn_Reset\n전혀 다른 줄\n");
    const tool = newTool();
    expect((await search(tool, fx.ctx, id, "시간초과")).details.total).toBe(1); // word start
    expect((await search(tool, fx.ctx, id, "시간초과가")).details.total).toBe(1);
    expect((await search(tool, fx.ctx, id, "err_conn_reset")).details.total).toBe(1);
    expect((await search(tool, fx.ctx, id, "초과")).details.total).toBe(0); // mid-word: documented limitation
  });

  test("CRLF lines count like the native reader and the \\r is not shown", async () => {
    const fx = session();
    const id = await fx.save("one\r\ntwo needle\r\nthree\r\n");
    const { text, details } = await search(newTool(), fx.ctx, id, "needle");
    expect(details.lines).toBe(3);
    expect(hitLines(text)).toEqual([2]);
    expect(text).not.toContain("\r");
  });
});

describe("cancellation, lifecycle, concurrency", () => {
  const big = () => noiseLog(30_000).join("\n");

  test("an already-aborted signal rejects without indexing; the next call works", async () => {
    const fx = session();
    const id = await fx.save("alpha needle\n");
    const tool = newTool();
    const ac = new AbortController();
    ac.abort(new Error("stop"));
    await expect(search(tool, fx.ctx, id, "needle", { signal: ac.signal })).rejects.toThrow("stop");
    expect((await search(tool, fx.ctx, id, "needle")).details.total).toBe(1);
  });

  test("aborting during the index build cancels it, publishes nothing, and a later call is correct and cold", async () => {
    const fx = session();
    const id = await fx.save(`${big()}\nfinal-needle-zz`);
    const tool = newTool(4096);
    const ac = new AbortController();
    const restore = await onNthRead(3, () => ac.abort(new Error("user cancelled")));
    const running = search(tool, fx.ctx, id, "final-needle-zz", { signal: ac.signal });
    await expect(running).rejects.toThrow("user cancelled");
    restore();
    const again = await search(tool, fx.ctx, id, "final-needle-zz");
    expect(again.details.cache).toBe("cold");
    expect(again.details.total).toBe(1);
  });

  test("a session switch during indexing cancels the build instead of publishing a stale index", async () => {
    const fx = session();
    const id = await fx.save(`${big()}\nfinal-needle-zz`);
    const tool = newTool(4096);
    const restore = await onNthRead(3, () => tool.onSession({ reason: "switch" }));
    const running = search(tool, fx.ctx, id, "final-needle-zz");
    await expect(running).rejects.toThrow("session switch");
    restore();
    const after = await search(tool, fx.ctx, id, "final-needle-zz");
    expect(after.details).toMatchObject({ cache: "cold", total: 1 });
    tool.onSession({ reason: "shutdown" });
    expect((await search(tool, fx.ctx, id, "final-needle-zz")).details.cache).toBe("cold");
    tool.onSession({ reason: "auto_retry_start" }); // unrelated events keep the cache
    expect((await search(tool, fx.ctx, id, "final-needle-zz")).details.cache).toBe("warm");
  });

  test("concurrent searches of one artifact each get their own correct result, even when one caller aborts", async () => {
    const fx = session();
    const rows = noiseLog(20_000);
    rows[100] = "needle-alpha-100";
    rows[15_000] = "needle-beta-15000";
    rows[19_999] = "needle-gamma-19999";
    const id = await fx.save(rows.join("\n"));
    const tool = newTool(8192);
    const ac = new AbortController();
    const restore = await onNthRead(3, () => ac.abort(new Error("one caller left")));
    const calls = [
      search(tool, fx.ctx, id, "needle-alpha-100"),
      search(tool, fx.ctx, id, "needle-beta-15000"),
      search(tool, fx.ctx, id, "needle-gamma-19999", { signal: ac.signal }),
      search(tool, fx.ctx, id, "needle-alpha-100"),
    ];
    const settled = await Promise.allSettled(calls);
    restore();
    expect(settled[2].status).toBe("rejected");
    const lines = settled.map((s) => (s.status === "fulfilled" ? hitLines(s.value.text) : null));
    expect(lines[0]).toEqual([101]);
    expect(lines[1]).toEqual([15_001]);
    expect(lines[3]).toEqual([101]);
    expect((await search(tool, fx.ctx, id, "needle-gamma-19999")).details.total).toBe(1);
  });

  test("when every waiter leaves, the shared build is cancelled and later calls rebuild cleanly", async () => {
    const fx = session();
    const id = await fx.save(`${big()}\nfinal-needle-zz`);
    const tool = newTool(4096);
    const a = new AbortController();
    const b = new AbortController();
    const restore = await onNthRead(3, () => {
      a.abort(new Error("a left"));
      b.abort(new Error("b left"));
    });
    const first = search(tool, fx.ctx, id, "final-needle-zz", { signal: a.signal });
    const second = search(tool, fx.ctx, id, "final-needle-zz", { signal: b.signal });
    const settled = await Promise.allSettled([first, second]);
    restore();
    expect(settled.map((s) => s.status)).toEqual(["rejected", "rejected"]);
    expect(String((settled[0] as PromiseRejectedResult).reason)).toContain("a left");
    expect(String((settled[1] as PromiseRejectedResult).reason)).toContain("b left");
    expect((await search(tool, fx.ctx, id, "final-needle-zz")).details).toMatchObject({ cache: "cold", total: 1 });
  });
});

describe("the original artifact", () => {
  test("is never modified by indexing or searching", async () => {
    const fx = session();
    const id = await fx.save(`${noiseLog(5000).join("\n")}\nunique-marker-ab12\n`);
    const file = path.join(fx.dir(), fs.readdirSync(fx.dir()).find((f) => f.startsWith(`${id}.`))!);
    const before = { hash: sha(file), mtime: fs.statSync(file).mtimeMs };
    const tool = newTool();
    await search(tool, fx.ctx, id, "unique-marker-ab12");
    await search(tool, fx.ctx, id, "nothing-here");
    tool.onSession({ reason: "shutdown" });
    expect({ hash: sha(file), mtime: fs.statSync(file).mtimeMs }).toEqual(before);
    expect(fs.readdirSync(fx.dir()).filter((f) => f.startsWith(`${id}.`))).toHaveLength(1);
  });
});

// Regressions from cross-review of r1 (R1-OAI-1..5). Each was reproduced failing against r1 before the r2 fix.
// (no wall-clock timers: the tests below wait on signals the code under test produces)
function fdCount(): number | null {
  try {
    return fs.readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}
/** Ctx whose manager.listFiles() (the first async step of admission) waits for `gate`; `entered` resolves once it was called. */
function delayedCtx(fx: Fixture, gate: Promise<void>): { ctx: CustomToolContext; entered: Promise<void> } {
  const real = fx.sm.getArtifactManager()!;
  const entered = Promise.withResolvers<void>();
  const manager = {
    dir: real.dir,
    listFiles: async () => {
      entered.resolve();
      await gate;
      return real.listFiles();
    },
  };
  // Test seam: execute() only reads sessionManager.getArtifactManager().
  return { ctx: { sessionManager: { getArtifactManager: () => manager } } as unknown as CustomToolContext, entered: entered.promise };
}
/** Holds the first FileHandle.read until released; later reads pass straight through. */
async function gateFirstRead(): Promise<{ started: Promise<void>; secondAdmitted: Promise<void>; release: () => void; restore: () => void }> {
  const probe = await fs.promises.open(import.meta.path, "r");
  const proto = Object.getPrototypeOf(probe) as { read: (...args: unknown[]) => Promise<unknown>; stat: (...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const originalRead = proto.read;
  const originalStat = proto.stat;
  const started = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let first = true;
  proto.read = function patched(this: unknown, ...args: unknown[]) {
    if (!first) return originalRead.apply(this, args);
    first = false;
    started.resolve();
    return gate.promise.then(() => originalRead.apply(this, args));
  };
  // After the first read is pending, the next handle.stat() is the second caller's admission (its last async admission step).
  proto.stat = function patched(this: unknown, ...args: unknown[]) {
    const result = originalStat.apply(this, args);
    if (!first) void result.then(() => admitted.resolve());
    return result;
  };
  return {
    started: started.promise,
    secondAdmitted: admitted.promise,
    release: () => gate.resolve(),
    restore: () => {
      proto.read = originalRead;
      proto.stat = originalStat;
    },
  };
}

describe("review r1 regressions", () => {
  test("R1-OAI-1: an ordinary error code straddling a long-line cut is found, with its line and char offset", async () => {
    const fx = session();
    const id = await fx.save(`${"x".repeat(1994)} ERR_CONN_RESET tail\nnext line\n`);
    const { text, details } = await search(newTool(), fx.ctx, id, "ERR_CONN_RESET");
    expect(details.total).toBeGreaterThanOrEqual(1);
    expect(hitLines(text)).toContain(1);
    expect(text).toContain("ERR_CONN_RESET");
    expect(text).toContain("hit at char 1995");
  });

  test("R1-OAI-1: every word of a minified long line stays findable wherever the cuts fall", async () => {
    const fx = session();
    const body = Array.from({ length: 4000 }, (_, i) => `"c${i}":"ERR_CODE_${i}"`).join(",");
    const id = await fx.save(`{${body}}\n`);
    const tool = newTool();
    for (const i of [0, 77, 1999, 2000, 2001, 3333, 3999]) {
      const { details } = await search(tool, fx.ctx, id, `ERR_CODE_${i}`);
      expect(details.total).toBeGreaterThanOrEqual(1);
    }
  });

  test("R1-OAI-2: a phrase never matches across a line break, and every returned locator covers the matching text", async () => {
    const fx = session();
    const rows = noiseLog(80);
    rows[20] = "prefix ERR";
    rows[21] = "CONN_RESET suffix";
    rows[60] = "real ERR_CONN_RESET here";
    const id = await fx.save(rows.join("\n"));
    const { text, details } = await search(newTool(), fx.ctx, id, "ERR_CONN_RESET");
    expect(details.total).toBe(1);
    expect(hitLines(text)).toEqual([61]);
    const locator = /read: artifact:\/\/\d+:(\d+)-(\d+)/.exec(text)!;
    expect(rows.slice(Number(locator[1]) - 1, Number(locator[2])).join("\n")).toContain("ERR_CONN_RESET");
    const split = await search(newTool(), fx.ctx, id, "ERR CONN_RESET");
    expect(split.details.total).toBeGreaterThanOrEqual(1);
  });

  test("R1-OAI-3: a caller arriving after the last waiter cancelled a build does not inherit that cancellation", async () => {
    const fx = session();
    const id = await fx.save(`${noiseLog(2000).join("\n")}\nwanted-needle\n`);
    const tool = newTool(4096);
    const gate = await gateFirstRead();
    try {
      const ac = new AbortController();
      const first = search(tool, fx.ctx, id, "wanted-needle", { signal: ac.signal });
      await gate.started;
      ac.abort(new Error("first left"));
      await expect(first).rejects.toThrow("first left");
      const second = search(tool, fx.ctx, id, "wanted-needle");
      await gate.secondAdmitted; // second's admission finished; the cancelled build's read is still pending
      await new Promise((resolve) => setImmediate(resolve));
      gate.release();
      const result = await second;
      expect(result.details).toMatchObject({ total: 1, cache: "cold" });
    } finally {
      gate.restore();
    }
  });

  test("R1-OAI-4: a warm request cancelled during a slow admission step is cancelled, not answered, and leaks no file handle", async () => {
    const fx = session();
    const id = await fx.save("alpha needle\n");
    const tool = newTool();
    await search(tool, fx.ctx, id, "needle"); // warm the cache
    const gate = Promise.withResolvers<void>();
    const ac = new AbortController();
    const before = fdCount();
    const delayed = delayedCtx(fx, gate.promise);
    const running = search(tool, delayed.ctx, id, "needle", { signal: ac.signal });
    const outcome = running.then(
      () => "answered",
      (error: Error) => error.message,
    );
    await delayed.entered;
    ac.abort(new Error("cancelled in admission"));
    gate.resolve();
    expect(await outcome).toBe("cancelled in admission");
    if (before !== null) expect(fdCount()).toBeLessThanOrEqual(before);
  });

  for (const reason of ["switch", "shutdown"]) {
    test(`R1-OAI-5: a request that was admitting when the session ${reason} event arrived neither succeeds nor repopulates the cache`, async () => {
      const fx = session();
      const id = await fx.save("alpha needle\n");
      const tool = newTool();
      const gate = Promise.withResolvers<void>();
      const delayed = delayedCtx(fx, gate.promise);
      const running = search(tool, delayed.ctx, id, "needle");
      const outcome = running.then(
        () => "answered",
        (error: Error) => error.message,
      );
      await delayed.entered;
      tool.onSession({ reason });
      gate.resolve();
      expect(await outcome).toContain("session");
      const next = await search(tool, fx.ctx, id, "needle");
      expect(next.details.cache).toBe("cold");
    });
  }
});

/** The next FileHandle.close really closes the handle but its returned promise is withheld until released. */
async function gateNextClose(): Promise<{ entered: Promise<void>; release: () => void; restore: () => void }> {
  const probe = await fs.promises.open(import.meta.path, "r");
  const proto = Object.getPrototypeOf(probe) as { close: (...args: unknown[]) => Promise<unknown> };
  await probe.close();
  const original = proto.close;
  const entered = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let armed = true;
  proto.close = function patched(this: unknown, ...args: unknown[]) {
    const closing = original.apply(this, args);
    if (!armed) return closing;
    armed = false;
    entered.resolve();
    return gate.promise.then(() => closing);
  };
  return { entered: entered.promise, release: () => gate.resolve(), restore: () => void (proto.close = original) };
}

describe("review r2 regression (R2-OAI-1)", () => {
  const events = [
    { name: "abort", expected: "left during close", warmAfter: true },
    { name: "switch", expected: "session", warmAfter: false },
    { name: "shutdown", expected: "session", warmAfter: false },
  ];
  for (const event of events) {
    test(`a warm request whose admitted handle is still closing is cancelled by ${event.name}, not answered; a later clean request is correct`, async () => {
      const fx = session();
      const id = await fx.save("alpha needle\n");
      const tool = newTool();
      await search(tool, fx.ctx, id, "needle"); // warm the cache
      const gate = await gateNextClose();
      try {
        const ac = new AbortController();
        const outcome = search(tool, fx.ctx, id, "needle", { signal: ac.signal }).then(
          () => "answered",
          (error: Error) => error.message,
        );
        await gate.entered;
        if (event.name === "abort") ac.abort(new Error("left during close"));
        else tool.onSession({ reason: event.name });
        gate.release();
        expect(await outcome).toContain(event.expected);
      } finally {
        gate.restore();
      }
      const next = await search(tool, fx.ctx, id, "needle");
      expect(next.details).toMatchObject({ total: 1, cache: event.warmAfter ? "warm" : "cold" });
    });
  }
});
