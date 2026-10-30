import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bottleneckSection, costSection, makerMetrics, memorySection, workspaceMetric } from "./collect.ts";
import { scanSessions } from "./sessions.ts";
import { inspectWorkspace } from "./workspace.ts";

const DAY = 86_400_000, MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-signals-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const user = (id, at) => ({ type: "message", id, timestamp: iso(at), message: { role: "user", content: "x" } });
/** 본 요청(assistant) 하나. `write`는 캐시 쓰기 토큰, `writeCost`는 그 비용 */
const reply = (id, at, { read = 0, write = 0, writeCost = 0, model = "m1", provider = "anthropic", credentialId = 1, cttl, credentialKind, cost = writeCost } = {}) => ({
  type: "message", id, timestamp: iso(at),
  message: {
    role: "assistant", provider, model, timestamp: at, credentialId,
    usage: { input: 100, cacheRead: read, cacheWrite: write, cost: { total: cost, cacheWrite: writeCost }, ...(cttl ? { cttl } : {}), ...(credentialKind ? { credentialKind } : {}) },
  },
});
const metricOf = (section, id) => section.metrics.find((m) => m.id === id);

test("main-request cache rewrites are classified by cause, a repeated digest or a fork copy changes nothing, and cold starts stay out of the value", () =>
  withDir(async (dir) => {
    const now = Date.now(), t = now - 2 * DAY;
    const original = [
      { type: "session", id: "A", timestamp: iso(t - MIN), cwd: "/w/a" },
      user("u", t - MIN),
      { type: "custom", id: "d0", customType: "system-prompt-digest", timestamp: iso(t - MIN), data: "h1" },
      reply("r1", t, { write: 30_000, writeCost: 1 }),
      reply("r2", t + MIN, { read: 30_100, write: 500, writeCost: 0.01 }),
    ];
    writeFileSync(join(dir, "a.jsonl"), lines([
      ...original,
      { type: "compaction", id: "c", timestamp: iso(t + 2 * MIN) },
      reply("r3", t + 3 * MIN, { write: 25_000, writeCost: 0.8 }),
      { type: "custom", id: "d1", customType: "system-prompt-digest", timestamp: iso(t + 4 * MIN), data: "h2" },
      reply("r4", t + 5 * MIN, { read: 1000, write: 25_000, writeCost: 0.7 }),
      { type: "custom", id: "d2", customType: "system-prompt-digest", timestamp: iso(t + 5 * MIN + 1000), data: "h2" },
      reply("r5", t + 6 * MIN, { write: 30_000, writeCost: 0.9, model: "m2" }),
      reply("r6", t + 7 * MIN, { write: 30_000, writeCost: 0.6, model: "m2", credentialId: 2 }),
      reply("r7", t + 20 * MIN, { write: 30_000, writeCost: 0.5, model: "m2", credentialId: 2 }),
      reply("r8", t + 30 * MIN, { write: 30_000, writeCost: 0.4, model: "m2", credentialId: 2, cttl: { ephemeral1h: 30_000 } }),
    ]));
    // fork 사본: 원본 entry를 그대로 복사한 뒤 이어서 쓴 요청은 세션 첫 요청이 아니다.
    writeFileSync(join(dir, "fork.jsonl"), lines([
      ...original.map((row) => (row.type === "session" ? { ...row, id: "F" } : row)),
      reply("f1", t + MIN + 1000, { write: 30_000, writeCost: 0.3 }),
    ]));
    const scan = await scanSessions(dir, now);
    const counts = Object.fromEntries(Object.entries(scan.windows[0].rewrites).map(([cause, x]) => [cause, [x.count, Number(x.cost.toFixed(2))]]));
    assert.deepEqual(counts, {
      first: [1, 1], compaction: [1, 0.8], prompt: [1, 0.7], model: [1, 0.9], credential: [1, 0.6], expired: [1, 0.5], prefix: [2, 0.7],
    });

    const row = metricOf(costSection(scan, []), "session-cache-rewrite");
    assert.equal(Number(row.current.toFixed(2)), 420, "avoidable $4.20 per 1 request, cold start excluded");
    assert.match(row.note, /세션 첫 요청 1건 \$1\.00/);
    assert.equal(row.evidence[0].label, "캐시 다시 쓰기 $0.90 · 모델 바뀜");
    assert.equal(row.evidence.at(-1).label, "캐시 다시 쓰기 $1.00 · 세션 첫 요청");
    assert.equal(scan.cwdActivity["/w/a"], t + 30 * MIN);
  }));

test("cold starts alone never flag the rewrite row, avoidable growth does", () =>
  withDir(async (dir) => {
    const now = Date.now();
    const week = (prefix, start, avoidable) => [
      { type: "session", id: prefix, timestamp: iso(start) },
      ...Array.from({ length: 25 }, (_, i) => user(`${prefix}u${i}`, start + i * 1000)),
      reply(`${prefix}r0`, start + MIN, { write: 30_000, writeCost: 5 }),
      ...Array.from({ length: avoidable }, (_, i) => reply(`${prefix}r${i + 1}`, start + (i + 2) * MIN, { write: 30_000, writeCost: 1 })),
    ];
    // 세션마다 파일이 따로라 각 파일의 첫 요청이 세션 첫 요청이다.
    const write = (previous, current) => {
      writeFileSync(join(dir, "p.jsonl"), lines(week("P", now - 9 * DAY, previous)));
      writeFileSync(join(dir, "c.jsonl"), lines(week("C", now - 2 * DAY, current)));
    };
    write(0, 0);
    assert.equal(metricOf(costSection(await scanSessions(dir, now), []), "session-cache-rewrite").status, "ok");
    write(1, 3);
    assert.equal(metricOf(costSection(await scanSessions(dir, now), []), "session-cache-rewrite").status, "problem");
  }));

test("API-key billing is counted from credentialKind and any billed call is watch", () =>
  withDir(async (dir) => {
    const now = Date.now(), t = now - DAY;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: iso(t) },
      reply("a", t, { cost: 2, credentialKind: "api-key" }),
      reply("b", t + MIN, { cost: 7, credentialKind: "oauth" }),
      { type: "model_usage", id: "m", timestamp: iso(t + 2 * MIN), purpose: "review", provider: "anthropic", usage: { input: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 }, credentialKind: "api-key" } },
    ]));
    const row = metricOf(costSection(await scanSessions(dir, now), []), "billed-api-key");
    assert.equal(row.current, 2.5);
    assert.equal(row.status, "watch");
    assert.match(row.note, /^호출 2 \/ 0건/);
    assert.deepEqual(row.evidence.map((e) => e.sessionId), ["S"]);
    writeFileSync(join(dir, "s.jsonl"), lines([{ type: "session", id: "S", timestamp: iso(t) }, reply("b", t + MIN, { cost: 7, credentialKind: "oauth" })]));
    assert.equal(metricOf(costSection(await scanSessions(dir, now), []), "billed-api-key").status, "ok");
  }));

test("one model served by two providers is one cost row", () =>
  withDir(async (dir) => {
    const now = Date.now();
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: iso(now - 9 * DAY) },
      reply("p", now - 9 * DAY, { cost: 1, model: "gemini-4-argon", provider: "aistudio" }),
      reply("a", now - DAY, { cost: 1, model: "gemini-4-argon", provider: "aistudio" }),
      reply("v", now - DAY + MIN, { cost: 1, model: "gemini-4-argon", provider: "google-vertex" }),
    ]));
    const section = costSection(await scanSessions(dir, now), []);
    const ids = section.metrics.map((m) => m.id).filter((id) => id.startsWith("model:"));
    assert.deepEqual(ids, ["model:gemini-4-argon"]);
    assert.match(metricOf(section, "model:gemini-4-argon").note, /원 금액 \$2\.00 \/ \$1\.00, 호출 2 \/ 1건.*제공자 aistudio, google-vertex 합산/);
  }));

test("memory export failures come only from git_finalize results, with the failing line as evidence", () =>
  withDir(async (dir) => {
    const now = Date.now(), t = now - DAY;
    const result = (id, toolName, text) => ({ type: "message", id, timestamp: iso(t), message: { role: "toolResult", toolName, toolCallId: id, content: [{ type: "text", text }] } });
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: iso(t) },
      result("g", "git_finalize", "Committed and pushed abc to origin. 기억 export 실패(커밋은 진행): Bun v1.4.4 (Linux x64)\nWindows 대응 사본이 있으면: …"),
      result("r", "read", "return { note: `기억 export 실패(커밋은 진행): ${reason}` };"),
    ]));
    const scan = await scanSessions(dir, now);
    const memory = memorySection(scan, []);
    const row = metricOf(memory, "memory-export-failures");
    assert.deepEqual([row.current, row.status], [1, "watch"]);
    assert.deepEqual(row.evidence.map((e) => e.label), ["기억 export 실패(커밋은 진행): Bun v1.4.4 (Linux x64)"]);
    assert.deepEqual(memory.metrics.map((m) => m.id), ["recall-per-turn", "gated-ratio", "recall-calls", "memory-export-failures"]);
  }));

test("the slow-wait row also judges p90 and names it when p90 sets the status", () => {
  const window = (gaps, turns) => ({ turns, calls: 0, errors: 0, rejects: 0, compactions: 0, nudges: 0, recalls: 0, emptyRecalls: 0, gated: 0, nearGate: 0, recallCalls: 0,
    exportFailures: 0, complaints: 0, cost: 0, missingCost: false, apiKeyCalls: 0, apiKeyCost: 0, cacheWriteCost: 0, rewrites: {}, gaps, purposes: {}, models: {}, errorsBySignature: {} });
  const scan = { windows: [window(Array(30).fill(15_000), 30), window(Array(30).fill(5_000), 30)], evidence: {} };
  const placeholder = (id) => ({ id, label: "", unit: "count", current: null, previous: null, status: "unknown", criterion: "", evidence: [] });
  const section = bottleneckSection(scan, { exits: placeholder("maker-early-exits"), verdicts: placeholder("maker-verdicts") }, []);
  const row = metricOf(section, "slow-gaps");
  assert.equal(row.status, "problem");
  assert.match(row.note, /p90 15초 \/ 5초\. 상태는 p90 기준으로 정했습니다\./);
  assert.equal(metricOf(section, "slow-gap-p90"), undefined);
});

test("Maker verdict share counts each attempt's latest verdict and flags a rising rework·held share", () =>
  withDir(async (dir) => {
    const now = Date.now();
    const verdict = (attemptId, verdict, at) => ({ type: "verdict", attemptId, agentId: attemptId, sessionId: "S", verdict, ts: iso(at) });
    const rows = [
      verdict("A", "rework", now - 3 * DAY), verdict("A", "accepted", now - 2 * DAY),
      verdict("B", "held", now - DAY), verdict("C", "accepted", now - DAY),
      verdict("D", "rework", now - 9 * DAY),
    ];
    writeFileSync(join(dir, "routing-ledger.jsonl"), lines(rows));
    const { verdicts } = await makerMetrics(dir, now, [], []);
    assert.deepEqual([verdicts.current, verdicts.previous, verdicts.status], [1 / 3, 1, "unknown"]);
    assert.match(verdicts.note, /accepted\/rework\/held 최근 7일 2\/0\/1, 직전 7일 0\/1\/0건/);
    assert.deepEqual(verdicts.evidence.map((e) => e.label), ["B held"]);

    const many = (prefix, at, flagged) => Array.from({ length: 20 }, (_, i) => verdict(`${prefix}${i}`, i < flagged ? "rework" : "accepted", at));
    writeFileSync(join(dir, "routing-ledger.jsonl"), lines([...many("P", now - 9 * DAY, 2), ...many("C", now - DAY, 10)]));
    assert.equal((await makerMetrics(dir, now, [], [])).verdicts.status, "problem");
  }));

test("an unpriced avoidable rewrite leaves the row unmeasured instead of $0; an unpriced cold start does not", () =>
  withDir(async (dir) => {
    const now = Date.now();
    const week = (prefix, start) => [
      { type: "session", id: prefix, timestamp: iso(start) },
      ...Array.from({ length: 25 }, (_, i) => user(`${prefix}u${i}`, start + i * 1000)),
      reply(`${prefix}r0`, start + MIN, { write: 30_000, writeCost: 1 }),
      reply(`${prefix}r1`, start + 2 * MIN, { write: 30_000, writeCost: 1 }),
    ];
    const scanWithUnpriced = async (index) => {
      writeFileSync(join(dir, "p.jsonl"), lines(week("P", now - 9 * DAY)));
      const current = week("C", now - 2 * DAY);
      delete current.at(index).message.usage.cost.cacheWrite;
      writeFileSync(join(dir, "c.jsonl"), lines(current));
      return metricOf(costSection(await scanSessions(dir, now), []), "session-cache-rewrite");
    };
    const avoidable = await scanWithUnpriced(-1);
    assert.deepEqual([avoidable.current, avoidable.status], [null, "unknown"]);
    assert.match(avoidable.note, /캐시 쓰기 비용이 기록되지 않은 다시 쓰기/);
    const cold = await scanWithUnpriced(-2);
    assert.deepEqual([cold.current, cold.status], [4, "ok"]);
  }));

test("leftover worktrees without recent sessions, merged wt branches and wt banks are counted; any is watch", () =>
  withDir(async (dir) => {
    const now = Date.now();
    const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "pipe" });
    const repo = join(dir, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "a");
    const stale = join(dir, "wt-stale"), busy = join(dir, "wt-busy");
    git(repo, "worktree", "add", "-q", "-b", "wt/stale", stale);
    git(repo, "worktree", "add", "-q", "-b", "wt/busy", busy);
    const agentDir = join(dir, "agent");
    mkdirSync(join(agentDir, "memories", "mnemopi", "banks", "wt-old"), { recursive: true });
    mkdirSync(join(agentDir, "memories", "mnemopi", "banks", "CUELO-private-x"), { recursive: true });

    // 하위 폴더에서 연 세션도 그 worktree의 사용으로 본다(R3-OAI-2).
    const found = await inspectWorkspace(repo, agentDir, { [join(realpathSync(busy), "src")]: now - DAY }, now);
    assert.deepEqual(found.worktrees.map((w) => w.branch), ["wt/stale"]);
    assert.deepEqual(found.banks, ["wt-old"]);
    // origin이 없는 저장소라 병합된 원격 브랜치는 확인하지 못한다.
    assert.equal(found.branches, null);
    const row = workspaceMetric(found);
    assert.deepEqual([row.current, row.status], [2, "watch"]);
    assert.match(row.note, /병합된 원격 브랜치 미확인/);

    const clean = workspaceMetric({ worktrees: [], branches: [], banks: [], warnings: [] });
    assert.deepEqual([clean.current, clean.status, clean.fixable], [0, "ok", undefined]);
    const empty = await inspectWorkspace(null, join(dir, "no-agent"), {}, now);
    assert.deepEqual([empty.banks, workspaceMetric(empty).status], [[], "unknown"]);
    // 세션 기록을 다 읽지 못했으면 worktree가 쓰이는지 모르므로 남은 것으로 세지 않는다(R3-OAI-1).
    const unread = await inspectWorkspace(repo, agentDir, null, now);
    assert.equal(unread.worktrees, null);
    assert.ok(unread.warnings.some((w) => w.includes("세션 기록")));
  }));
