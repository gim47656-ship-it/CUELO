import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectTaskCost } from "./task-cost.ts";
import { costSection, taskCostMetrics } from "./collect.ts";

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");
const HOUR = 3_600_000, DAY = 24 * HOUR;

/** 부모 세션 `P` 아래 Maker 하위 세션 파일을 만든다. */
function fixture(now, { dispatches, verdicts = [], usages }) {
  const root = mkdtempSync(join(tmpdir(), "upkeep-task-cost-"));
  const sessions = join(root, "sessions");
  const dir = join(sessions, "-cwd-", "2026-11-10T00-00-00-000Z_P");
  mkdirSync(dir, { recursive: true });
  const iso = (ago) => new Date(now - ago).toISOString();
  const rows = [
    ...dispatches.map(({ ago, model = "openai-codex/gpt-6.1-sol", attempt = 1, agent = "Fix", n = 0 }) => ({ type: "dispatch", ts: iso(ago), sessionId: "P", attemptId: `P#t#${n}#a${attempt}`, agentId: agent, chosenModel: model })),
    ...verdicts.map(({ ago, verdict, attempt = 1, n = 0 }) => ({ type: "verdict", ts: iso(ago), sessionId: "P", attemptId: `P#t#${n}#a${attempt}`, verdict })),
  ];
  writeFileSync(join(root, "routing-ledger.jsonl"), `${lines(rows)}\nnot json\n`);
  const byAgent = {};
  for (const { ago, cost, agent = "Fix" } of usages) (byAgent[agent] ??= []).push({ type: "message", timestamp: iso(ago), message: { role: "assistant", usage: cost === undefined ? { input: 1 } : { cost: { total: cost } } } });
  for (const [agent, entries] of Object.entries(byAgent)) writeFileSync(join(dir, `${agent}.jsonl`), lines([{ type: "session", id: agent, timestamp: iso(0) }, ...entries]));
  return { root, sessions };
}

test("cost is split by attempt time range and divided by accepted attempts", async () => {
  const now = Date.now();
  const f = fixture(now, {
    dispatches: [{ ago: 2 * DAY, attempt: 1 }, { ago: 1 * DAY, attempt: 2 }, { ago: 9 * DAY, agent: "Old", n: 1 }],
    verdicts: [{ ago: 1.5 * DAY, verdict: "rework", attempt: 1 }, { ago: 6 * HOUR, verdict: "held", attempt: 2 }, { ago: 5 * HOUR, verdict: "accepted", attempt: 2 }, { ago: 8 * DAY, verdict: "accepted", agent: "Old", n: 1 }],
    usages: [{ ago: 2 * DAY - HOUR, cost: 1 }, { ago: DAY + HOUR, cost: 2 }, { ago: DAY - HOUR, cost: 4 }, { ago: 8.9 * DAY, cost: 10, agent: "Old" }],
  });
  try {
    const result = await collectTaskCost(f.root, f.sessions, now);
    assert.deepEqual(result.unlinked, [0, 0]);
    const [sol] = result.models;
    assert.equal(sol.model, "openai-codex/gpt-6.1-sol");
    // 시도 1은 시도 2 발주 직전까지(1+2=3), 시도 2는 그 뒤(4). 시도 2의 마지막 판정은 accepted.
    assert.deepEqual(sol.windows[0], { attempts: 2, accepted: 1, rework: 1, held: 0, cost: 7, missingCost: false });
    assert.deepEqual(sol.windows[1], { attempts: 1, accepted: 1, rework: 0, held: 0, cost: 10, missingCost: false });
    const [m] = taskCostMetrics(result);
    assert.equal(m.id, "task-cost:gpt-6.1-sol");
    assert.equal(m.current, 7);
    assert.equal(m.previous, 10);
    assert.equal(m.status, "ok");
    assert.match(m.note, /시도 2건, 수용 1건, rework 1건/);
    assert.match(m.note, /수용 시도가 \d+건 미만/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("missing costs and missing child sessions are not turned into zero", async () => {
  const now = Date.now();
  const f = fixture(now, {
    dispatches: [{ ago: DAY, agent: "A", n: 0 }, { ago: DAY, agent: "Gone", n: 1 }],
    verdicts: [{ ago: HOUR, verdict: "accepted", n: 0 }, { ago: HOUR, verdict: "accepted", n: 1 }],
    usages: [{ ago: DAY - HOUR, cost: undefined, agent: "A" }],
  });
  try {
    const result = await collectTaskCost(f.root, f.sessions, now);
    assert.deepEqual(result.unlinked, [1, 0]);
    const [m] = taskCostMetrics(result);
    assert.equal(m.current, null);
    assert.match(m.note, /비용이 없어/);
    assert.match(m.note, /시도 2건/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a missing child session blanks the model even when other attempts have costs, and a response without usage is missing cost", async () => {
  const now = Date.now();
  const f = fixture(now, {
    dispatches: [{ ago: DAY, agent: "A", n: 0 }, { ago: DAY, agent: "Gone", n: 1 }, { ago: 9 * DAY, agent: "Old", n: 2 }],
    verdicts: [{ ago: HOUR, verdict: "accepted", n: 0 }, { ago: HOUR, verdict: "accepted", n: 1 }, { ago: HOUR, verdict: "accepted", n: 2 }],
    usages: [{ ago: DAY - HOUR, cost: 5, agent: "A" }, { ago: 9 * DAY - HOUR, cost: 3, agent: "Old" }],
  });
  try {
    appendFileSync(join(f.sessions, "-cwd-", "2026-11-10T00-00-00-000Z_P", "Old.jsonl"), `\n${JSON.stringify({ type: "message", timestamp: new Date(now - 9 * DAY + HOUR).toISOString(), message: { role: "assistant" } })}`);
    const result = await collectTaskCost(f.root, f.sessions, now);
    assert.deepEqual(result.unlinked, [1, 0]);
    const [m] = taskCostMetrics(result);
    assert.equal(m.current, null);
    assert.equal(m.previous, null);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rows appear in the cost section without changing its status", () => {
  const rows = taskCostMetrics({ models: [{ model: "a/x:high", windows: [{ attempts: 3, accepted: 3, rework: 0, held: 0, cost: 6, missingCost: false }, { attempts: 0, accepted: 0, rework: 0, held: 0, cost: 0, missingCost: false }] }], unlinked: [0, 0] });
  assert.equal(rows[0].current, 2);
  assert.equal(rows[0].previous, null);
  assert.equal(rows[0].criterionId, "task-cost-v1");
  const scan = { windows: [0, 1].map(() => ({ turns: 0, cost: 0, missingCost: false, purposes: {}, models: {}, rewrites: Object.fromEntries(["first", "compaction", "prompt", "model", "credential", "expired", "prefix"].map((c) => [c, { count: 0, cost: 0 }])), apiKeyCost: 0, apiKeyCalls: 0, requests: 0 })), evidence: {}, topSessions: {} };
  const section = costSection(scan, [], rows);
  assert.ok(section.metrics.some((m) => m.id === "task-cost:x"));
});
