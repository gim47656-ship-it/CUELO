import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessions } from "./sessions.ts";
import { applyFixMarks, costSection, makerMetrics, memorySection, opsSection } from "./collect.ts";
import { activeFixMarks, clearFixMark, FIX_MARKS_FILE, fixMarkTimeFrom, fixMetricIdFrom, readFixMarks, setFixMark } from "./fixes.ts";
import { fixTag } from "./prompt.ts";

const DAY = 86_400_000;
const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
const iso = (ms) => new Date(ms).toISOString();

function withDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-fix-"));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

const sectionOf = (id, metrics) => ({ id, title: id, status: "ok", summary: "", metrics, warnings: [] });

/** 10-28·10-30 Terra partial 3건이 고치기 전에 있고, 표시 뒤에는 정상 종료만 있는 실제 사례를 줄인 것. */
function makerFixture(agentDir, now, mark) {
  const finished = [["A", now - 3 * DAY, "partial"], ["B", now - 2 * DAY, "partial"], ["C", now - 1.5 * DAY, "partial"], ["D", now - 3_600_000, "completed"]];
  writeFileSync(join(agentDir, "routing-ledger.jsonl"), lines(finished.map(([name]) => ({
    type: "dispatch", name, assignmentId: "S#c#0", chosenModel: "openai-codex/gpt-6.1-terra",
  }))));
  mkdirSync(join(agentDir, "sessions"));
  writeFileSync(join(agentDir, "sessions", "s.jsonl"), lines([
    { type: "session", id: "S", timestamp: iso(now - 4 * DAY) },
    ...finished.map(([name, at, status], i) => ({
      type: "custom_message", id: `n${i}`, customType: "async-result", timestamp: iso(at),
      content: `<task-result id="${name}" agent="maker" status="completed" duration="45s">\n<output>\n{"status":"${status}"}\n</output>\n</task-result>`,
    })),
  ]));
  return scanSessions(join(agentDir, "sessions"), now, mark === undefined ? [] : [mark]);
}

test("a fix mark judges Maker partial exits only after the mark, and stays unknown until enough results arrive after it", () =>
  withDir(async (agentDir) => {
    const now = Date.now(), mark = now - DAY;
    const scan = await makerFixture(agentDir, now, mark);
    const unmarked = (await makerMetrics(agentDir, now, [], scan.makerResults)).exits;
    assert.equal(unmarked.status, "watch");
    assert.equal(unmarked.current, 3);

    const after = (await makerMetrics(agentDir, now, [], scan.makerResults, { includes: (time) => time >= mark, label: "고침 뒤" })).exits;
    assert.equal(after.current, 0);
    assert.match(after.note, /^고침 뒤 모델별 partial\/결과: gpt-6\.1-terra 0\/1\./);

    const sections = [sectionOf("bottleneck", [unmarked])];
    await applyFixMarks(sections, scan, { "maker-early-exits": mark }, { agentDir, now, handoffs: [] });
    const [marked] = sections[0].metrics;
    assert.equal(marked.current, 0);
    // 표시 뒤 결과가 1건뿐이라 고친 것이 아직 확인되지 않았다. 정상으로 읽히면 안 된다.
    assert.equal(marked.status, "unknown");
    assert.match(marked.note, /^고침 뒤 관찰 중 \(Maker 결과 1\/최소 20건\)\./);
    assert.deepEqual(marked.fix, { markedAt: iso(mark), before: 3, beforeMs: 6 * DAY, afterMs: DAY, perDay: true, observing: true });
    assert.equal(marked.evidence.length, 3, "pre-fix cases stay openable");
    assert.equal(sections[0].status, "unknown");
  }));

test("a marked count with no denominator is observed for 24 hours after the mark before it is judged", () =>
  withDir(async (dir) => {
    const now = Date.now();
    const judged = async (mark) => {
      const scan = await scanSessions(join(dir, "missing"), now, [mark]);
      const sections = [memorySection(scan, [])];
      await applyFixMarks(sections, scan, { "memory-export-failures": mark }, { agentDir: dir, now, handoffs: [] });
      return sections[0].metrics.find((m) => m.id === "memory-export-failures");
    };
    const fresh = await judged(now - 3_600_000);
    assert.equal(fresh.status, "unknown");
    assert.match(fresh.note, /^고침 뒤 관찰 중 \(경과 1\/최소 24시간\)\./);
    assert.equal(fresh.fix.observing, true);
    const settled = await judged(now - 25 * 3_600_000);
    assert.equal(settled.status, "ok");
    assert.doesNotMatch(settled.note, /관찰 중/);
    assert.equal(settled.fix.observing, false);
  }));

test("the pre-mark Maker verdict share counts verdicts as they stood before the mark, even when an attempt was judged again after it", () =>
  withDir(async (agentDir) => {
    const now = Date.now(), mark = now - 2 * DAY;
    const verdict = (attemptId, verdict, at) => ({ type: "verdict", attemptId, verdict, ts: iso(at), name: attemptId });
    writeFileSync(join(agentDir, "routing-ledger.jsonl"), lines([
      ...Array.from({ length: 20 }, (_, i) => verdict(`P${i}`, "accepted", now - 9 * DAY)),
      // 표시 전 rework였다가 표시 뒤 accepted가 된 시도 20건
      ...Array.from({ length: 20 }, (_, i) => verdict(`C${i}`, "rework", mark - DAY)),
      ...Array.from({ length: 20 }, (_, i) => verdict(`C${i}`, "accepted", now - DAY)),
    ]));
    const scan = await scanSessions(join(agentDir, "missing"), now, [mark]);
    const sections = [sectionOf("bottleneck", [(await makerMetrics(agentDir, now, [], [])).verdicts])];
    await applyFixMarks(sections, scan, { "maker-verdicts": mark }, { agentDir, now, handoffs: [] });
    const [marked] = sections[0].metrics;
    assert.equal(marked.current, 0);
    assert.equal(marked.fix.before, 1);
    assert.equal(marked.fix.observing, false);
  }));

test("clearing the mark restores the rolling seven-day judgement", () =>
  withDir(async (agentDir) => {
    const now = Date.now();
    setFixMark(agentDir, "maker-early-exits", new Date(now - DAY));
    clearFixMark(agentDir, "maker-early-exits");
    const marks = activeFixMarks(agentDir, now - 7 * DAY);
    assert.deepEqual(marks, {});
    const scan = await makerFixture(agentDir, now);
    const sections = [sectionOf("bottleneck", [(await makerMetrics(agentDir, now, [], scan.makerResults)).exits])];
    await applyFixMarks(sections, scan, marks, { agentDir, now, handoffs: [] });
    assert.equal(sections[0].metrics[0].status, "watch");
    assert.equal(sections[0].metrics[0].current, 3);
    assert.equal(sections[0].metrics[0].fix, undefined);
    assert.equal(sections[0].metrics[0].fixable, true);
  }));

/** 비용 행 사용량. 입력 1000 토큰 중 `write`만큼 캐시 쓰기 */
const usage = (id, at, purpose, write, cost) => ({
  type: "model_usage", id, timestamp: iso(at), purpose, provider: "anthropic",
  usage: { input: 1000 - write, cacheRead: 0, cacheWrite: write, cost: { total: cost }, credentialKind: "api_key" },
});

test("one scan counts current-week events before and after each mark, and a marked cost row is rejudged on its cache share after it", () =>
  withDir(async (dir) => {
    const now = Date.now(), mark = now - DAY;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: iso(now - 9 * DAY) },
      usage("p", now - 8 * DAY, "cross-review", 50, 2),
      usage("b", now - 2 * DAY, "cross-review", 600, 3),
      usage("a", now - 3_600_000, "cross-review", 10, 0.5),
      { type: "message", id: "u1", timestamp: iso(now - 2 * DAY), message: { role: "user", content: "x" } },
      { type: "message", id: "u2", timestamp: iso(mark), message: { role: "user", content: "y" } },
    ]));
    const scan = await scanSessions(dir, now, [mark]);
    assert.ok(scan.splits instanceof Map, "scan returns per-mark buckets");
    const counts = scan.splits.get(mark);
    assert.deepEqual([counts.before.turns, counts.after.turns, scan.windows[0].turns], [1, 1, 2], "the mark time itself counts as after");
    assert.equal(counts.after.purposes["cross-review"].write, 10);

    const sections = [costSection(scan, [])];
    const row = () => sections[0].metrics.find((m) => m.id === "purpose:cross-review");
    assert.equal(row().status, "problem");
    assert.match(row().note, /상태는 캐시 쓰기 비율 기준으로 정했습니다/);
    await applyFixMarks(sections, scan, { "purpose:cross-review": mark }, { agentDir: dir, now, handoffs: [] });
    // 표시 뒤 캐시 쓰기 비율은 1%라 문제가 풀리고, 금액은 호출 20건 미만이라 판정하지 않는다.
    assert.equal(row().status, "unknown");
    assert.match(row().note, /캐시 쓰기 비율 1\.0% \/ 5\.0%/);
    assert.equal(row().current, 50);
    assert.deepEqual(row().fix, { markedAt: iso(mark), before: 300, beforeMs: 6 * DAY, afterMs: DAY, perDay: false, observing: true });
    assert.match(row().note, /^고침 뒤 관찰 중 \(호출 \d+\/최소 20건\)\./);
  }));

test("a marked cost row the section would fold away is still shown with its mark", () =>
  withDir(async (dir) => {
    const now = Date.now(), mark = now - DAY;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: iso(now - 9 * DAY) },
      usage("a", now - 3_600_000, "quiet", 80, 2),
    ]));
    const scan = await scanSessions(dir, now, [mark]);
    const sections = [costSection(scan, [])];
    assert.equal(sections[0].metrics.some((m) => m.id === "purpose:quiet"), false);
    await applyFixMarks(sections, scan, { "purpose:quiet": mark }, { agentDir: dir, now, handoffs: [] });
    const row = sections[0].metrics.find((m) => m.id === "purpose:quiet");
    assert.equal(row?.fix?.markedAt, iso(mark));
  }));

test("marks older than the window are dropped from the file and ignored", () =>
  withDir(async (agentDir) => {
    const now = Date.now();
    writeFileSync(join(agentDir, FIX_MARKS_FILE), JSON.stringify({
      "slow-gaps": iso(now - 8 * DAY), compactions: iso(now - DAY), ci: iso(now - DAY), "tool-error-rate": "not a time",
    }));
    assert.deepEqual(activeFixMarks(agentDir, now - 7 * DAY), { compactions: now - DAY });
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, FIX_MARKS_FILE), "utf8")), { compactions: iso(now - DAY) });
  }));

test("a mark may carry the time the fix went live within the window, never a future or out-of-window time", () => {
  const now = new Date("2026-10-31T01:00:00.000Z");
  assert.equal(fixMarkTimeFrom({ metricId: "slow-gaps" }, now), now);
  assert.equal(fixMarkTimeFrom({ at: "2026-10-30T15:34:00Z" }, now)?.toISOString(), "2026-10-30T15:34:00.000Z");
  assert.equal(fixMarkTimeFrom({ at: "2026-10-24T01:00:00Z" }, now)?.toISOString(), "2026-10-24T01:00:00.000Z");
  for (const at of ["2026-10-31T01:00:01Z", "2026-10-24T00:59:59Z", "yesterday", 1793389445445, null]) {
    assert.equal(fixMarkTimeFrom({ at }, now), null, String(at));
  }
});

test("point-in-time metrics never take a mark", () =>
  withDir(async (dir) => {
    const now = Date.now();
    for (const metricId of ["revision-diff", "ci", "overdue", "cost-other", "recall-calls", "purpose:"]) {
      assert.equal(fixMetricIdFrom({ metricId }), null, metricId);
    }
    assert.equal(fixMetricIdFrom({ metricId: "purpose:skim" }), "purpose:skim");
    writeFileSync(join(dir, FIX_MARKS_FILE), JSON.stringify({ ci: iso(now) }));
    assert.deepEqual(readFixMarks(dir), {});

    const deploy = opsSection([], [], { deployed: "a", head: "b", pending: ["lib/a.ts"], records: 0, ci: null, warnings: [] }, { worktrees: [], branches: [], banks: [], warnings: [] }, now);
    const before = structuredClone(deploy);
    const scan = await scanSessions(join(dir, "missing"), now, [now - 1000]);
    await applyFixMarks([deploy], scan, { "revision-diff": now - 1000 }, { agentDir: dir, now, handoffs: [] });
    assert.deepEqual(deploy, before);
  }));

test("a cost key used only before the mark and never in the previous week still takes the mark", () =>
  withDir(async (dir) => {
    const now = Date.now(), mark = now - DAY;
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "S", timestamp: iso(now - 3 * DAY) },
      { type: "message", id: "u", timestamp: iso(now - 2 * DAY), message: { role: "user", content: "x" } },
      usage("b", now - 2 * DAY, "fresh", 500, 3),
    ]));
    const scan = await scanSessions(dir, now, [mark]);
    const sections = [costSection(scan, [])];
    const row = () => sections[0].metrics.find((m) => m.id === "purpose:fresh");
    await applyFixMarks(sections, scan, { "purpose:fresh": mark }, { agentDir: dir, now, handoffs: [] });
    assert.equal(row().fix?.markedAt, iso(mark));
    assert.equal(row().fix.before, 300);
    assert.equal(row().current, null);
  }));

test("cost evidence tags sessions that ended before the mark and sessions that span it", () =>
  withDir(async (dir) => {
    const now = Date.now(), mark = now - DAY;
    const session = (id, ...events) => writeFileSync(join(dir, `${id}.jsonl`), lines([{ type: "session", id, timestamp: iso(now - 9 * DAY) }, ...events]));
    // 직전 7일 사용이 있어야 새 행으로 접히지 않는다.
    session("PREV", usage("p", now - 8 * DAY, "review", 0, 1));
    session("OLD", usage("o", now - 2 * DAY, "review", 0, 5));
    session("SPAN", usage("s1", now - 2 * DAY, "review", 0, 3), usage("s2", now - 3_600_000, "review", 0, 0.01));
    session("NEW", usage("n", now - 3_600_000, "review", 0, 2));
    const scan = await scanSessions(dir, now, [mark]);
    const row = costSection(scan, []).metrics.find((m) => m.id === "purpose:review");
    const fix = { markedAt: iso(mark), before: null };
    assert.deepEqual(row.evidence.map((e) => [e.sessionId, fixTag(e, fix)]), [["OLD", "고침 전"], ["SPAN", "고침 전 사용 포함"], ["NEW", null]]);
  }));

test("an unreadable marks file is neither overwritten nor reported as cleared", () =>
  withDir(async (agentDir) => {
    const path = join(agentDir, FIX_MARKS_FILE);
    writeFileSync(path, "{ broken");
    assert.throws(() => setFixMark(agentDir, "compactions", new Date()));
    assert.throws(() => clearFixMark(agentDir, "compactions"));
    assert.deepEqual(activeFixMarks(agentDir, Date.now() - 7 * DAY), {});
    assert.equal(readFileSync(path, "utf8"), "{ broken");
  }));
