import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maskSecrets, scanSessions } from "./sessions.ts";
import { costSection, makerEarlyExits, maskReport } from "./collect.ts";

const lines = (rows) => rows.map((row) => JSON.stringify(row)).join("\n");

function withDir(prefix, run) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return Promise.resolve(run(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a forked copy of the same calls and failure is counted once", () =>
  withDir("upkeep-dedupe-", async (dir) => {
    const now = Date.now(), timestamp = new Date(now - 1000).toISOString();
    const body = lines([
      { type: "session", id: "one", timestamp },
      { type: "message", id: "a", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call", name: "edit" }] } },
      { type: "message", id: "b", timestamp, message: { role: "toolResult", toolCallId: "call", isError: true, content: [{ text: "failure" }] } },
    ]);
    for (const name of ["a.jsonl", "b.jsonl"]) {
      writeFileSync(join(dir, name), body);
      utimesSync(join(dir, name), new Date(now), new Date(now));
    }
    const { windows } = await scanSessions(dir, now);
    assert.equal(windows[0].calls, 1);
    assert.equal(windows[0].errors, 1);
  }));

test("notices stored as custom_message are counted", () =>
  withDir("upkeep-custom-", async (dir) => {
    const now = Date.now(), timestamp = new Date(now - 1000).toISOString();
    writeFileSync(join(dir, "s.jsonl"), lines([
      { type: "session", id: "s", timestamp },
      ...["todo-nudge", "mid-run-todo-nudge", "autolearn-saved"].map((customType, i) => ({ type: "custom_message", id: String(i), customType, timestamp })),
    ]));
    const { windows } = await scanSessions(dir, now);
    assert.equal(windows[0].nudges, 2);
    assert.equal(windows[0].saves, 1);
  }));

test("slow-gap evidence lists the longest waits first", () =>
  withDir("upkeep-gaps-", async (dir) => {
    const now = Date.now();
    const base = now - 120_000;
    const at = (ms) => new Date(base + ms).toISOString();
    const rows = [{ type: "session", id: "s", timestamp: at(0) }];
    // 도구 결과 뒤 25초, 45초를 기다린 두 번의 다음 요청
    for (const [i, start, wait] of [[1, 0, 25_000], [2, 30_000, 45_000]]) {
      rows.push({ type: "message", id: `r${i}`, timestamp: at(start), message: { role: "toolResult", toolCallId: "x" } });
      rows.push({ type: "message", id: `a${i}`, timestamp: at(start + wait), message: { role: "assistant", timestamp: base + start + wait, content: [] } });
    }
    writeFileSync(join(dir, "s.jsonl"), lines(rows));
    const { evidence } = await scanSessions(dir, now);
    assert.deepEqual(evidence["slow-gaps"].map((e) => e.label), ["도구 결과 뒤 45초 대기", "도구 결과 뒤 25초 대기"]);
  }));

test("credential-shaped values are masked but their names stay", () => {
  // Built at runtime so the public mirror's token-shape scan does not flag this fake value.
  const githubToken = ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");
  const cases = [
    ["SECRET_KEY=abcdefgh123", "abcdefgh123"],
    ["auth_token: Bearer abcXYZ123secret", "abcXYZ123secret"],
    ['{"client_secret":"abcdEFGH1234"}', "abcdEFGH1234"],
    [`token ${githubToken}`, githubToken],
  ];
  for (const [text, secret] of cases) assert.ok(!maskSecrets(text).includes(secret), maskSecrets(text));
  assert.match(maskSecrets("SECRET_KEY=abcdefgh123"), /^SECRET_KEY=/);
});

test("hyphenated key names and quoted values with spaces are masked", () => {
  assert.equal(maskSecrets("x-api-key: abcd1234efgh5678"), "x-api-key: [가림]");
  assert.equal(maskSecrets('password: "correct horse battery staple" next'), "password: [가림] next");
  assert.equal(maskSecrets('TOKEN="abc def'), "TOKEN=[가림]");
});

test("a fork that continues a copied call still counts its new failure", () =>
  withDir("upkeep-fork-", async (dir) => {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const call = { type: "message", id: "a", timestamp, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit" }] } };
    writeFileSync(join(dir, "a.jsonl"), lines([{ type: "session", id: "orig", timestamp }, call]));
    writeFileSync(join(dir, "b.jsonl"), lines([
      { type: "session", id: "fork", timestamp }, call,
      { type: "message", id: "r", timestamp, message: { role: "toolResult", toolCallId: "c1", isError: true, content: [{ text: "failure" }] } },
    ]));
    const { windows } = await scanSessions(dir, now);
    assert.equal(windows[0].calls, 1);
    assert.equal(windows[0].errors, 1);
  }));

test("Maker results arriving as async-result notices carry name, duration and partial status", () =>
  withDir("upkeep-async-", async (dir) => {
    const now = Date.now(), timestamp = new Date(now - 5000).toISOString();
    const notice = (id, duration, status) => ({
      type: "custom_message", id: `n-${id}`, customType: "async-result", timestamp,
      content: `<system-notice>\n<task-result id="${id}" agent="maker" status="completed" duration="${duration}">\n\n<output>\n{\n  "status": "${status}",\n  "summary": "x"\n}`,
    });
    writeFileSync(join(dir, "s.jsonl"), lines([{ type: "session", id: "S", timestamp }, notice("Collector", "11m6s", "partial"), notice("Screen", "2m19s", "completed")]));
    const { makerResults } = await scanSessions(dir, now);
    assert.deepEqual(makerResults.map((r) => [r.sessionId, r.name, r.durationSec, r.partial]), [["S", "Collector", 666, true], ["S", "Screen", 139, false]]);
  }));

const ledger = (dir, rows) => writeFileSync(join(dir, "routing-ledger.jsonl"), lines(rows));
const result = (name, ago, durationSec, partial = false, sessionId = "S") => ({ sessionId, name, timestamp: new Date(Date.now() - ago).toISOString(), durationSec, partial });

test("a partial Maker counts as an early exit even when it ran long, attributed to its dispatch model", () =>
  withDir("upkeep-maker-", async (dir) => {
    ledger(dir, [
      { type: "dispatch", name: "Collector", assignmentId: "S#call#0", chosenModel: "openai-codex/gpt-6.1-terra:auto" },
      { type: "dispatch", name: "Screen", assignmentId: "S#call#1", chosenModel: "anthropic/claude-opus-5-5:auto" },
      // 결과 알림과 같은 결과의 원장 행은 두 번 세지 않는다.
      { type: "outcome", agentId: "Collector", sessionId: "S", assignmentId: "S#call#0", ts: new Date(Date.now() - 5000).toISOString(), durationSec: 666 },
    ]);
    const { metric } = await makerEarlyExits(dir, Date.now(), [], [result("Collector", 5000, 666, true), result("Screen", 5000, 1380)]);
    assert.equal(metric.current, 1);
    assert.deepEqual(metric.evidence.map((e) => e.label), ["Collector partial로 종료 (666초) · gpt-6.1-terra"]);
    assert.match(metric.note, /gpt-6.1-terra 1\/1, claude-opus-5-5 0\/1/);
    assert.equal(metric.status, "ok");
  }));

test("two partial exits of one model in the last week are reported; a short normal finish is not an exit", () =>
  withDir("upkeep-maker2-", async (dir) => {
    ledger(dir, ["A", "B", "C"].map((name, i) => ({ type: "dispatch", name, assignmentId: `S#c#${i}`, chosenModel: "openai-codex/gpt-6.1-sol:auto" })));
    const one = await makerEarlyExits(dir, Date.now(), [], [result("A", 5000, 53, true), result("C", 7000, 20)]);
    assert.equal(one.metric.current, 1);
    assert.equal(one.metric.status, "ok");
    const two = await makerEarlyExits(dir, Date.now(), [], [result("A", 5000, 53, true), result("B", 6000, 900, true)]);
    assert.equal(two.metric.status, "watch");
  }));

test("partial results with no dispatch row are not treated as one model", () =>
  withDir("upkeep-maker-unknown-", async (dir) => {
    ledger(dir, [{ type: "dispatch", name: "Other", assignmentId: "S#c#0", chosenModel: "openai-codex/gpt-6.1-sol:auto" }]);
    const { metric } = await makerEarlyExits(dir, Date.now(), [], [result("A", 5000, 53, true), result("B", 6000, 900, true)]);
    assert.equal(metric.current, 2);
    assert.equal(metric.status, "ok");
  }));

test("malformed ledger rows are skipped instead of failing the report", () =>
  withDir("upkeep-maker-malformed-", async (dir) => {
    writeFileSync(join(dir, "routing-ledger.jsonl"), [
      "null",
      JSON.stringify({ type: "dispatch", name: "A", assignmentId: 5, chosenModel: "openai-codex/gpt-6.1-terra" }),
      JSON.stringify({ type: "dispatch", name: "A", assignmentId: "S#c#0", chosenModel: "openai-codex/gpt-6.1-sol" }),
      JSON.stringify({ type: "verdict", verdict: "rework", ts: { toString: 1 } }),
    ].join("\n"));
    const { metric, warning } = await makerEarlyExits(dir, Date.now(), [], [result("A", 5000, 53, true)]);
    assert.equal(warning, undefined);
    assert.deepEqual(metric.evidence.map((e) => e.label), ["A partial로 종료 (53초) · gpt-6.1-sol"]);
  }));

test("results older than seven days count as the previous week", () =>
  withDir("upkeep-maker3-", async (dir) => {
    ledger(dir, [{ type: "dispatch", name: "A", assignmentId: "S#c#0", chosenModel: "openai-codex/gpt-6.1-sol" }]);
    const { metric } = await makerEarlyExits(dir, Date.now(), [], [result("A", 1000, 40, true), result("A", 9 * 86_400_000, 30, true)]);
    assert.equal(metric.current, 1);
    assert.equal(metric.previous, 1);
  }));

test("a missing or unparsable ledger leaves the metric unmeasured with a warning", () =>
  withDir("upkeep-noledger-", async (dir) => {
    mkdirSync(join(dir, "empty"));
    const missing = await makerEarlyExits(join(dir, "empty"), Date.now(), [], []);
    assert.equal(missing.metric.status, "unknown");
    assert.ok(missing.warning);
    writeFileSync(join(dir, "routing-ledger.jsonl"), "not json\n{broken");
    const broken = await makerEarlyExits(dir, Date.now(), [], []);
    assert.equal(broken.metric.current, null);
    assert.equal(broken.metric.status, "unknown");
    assert.ok(broken.warning);
  }));

function window(purposes) {
  return { turns: 100, calls: 0, errors: 0, rejects: 0, compactions: 0, nudges: 0, recalls: 0, emptyRecalls: 0, gated: 0, nearGate: 0, recallCalls: 0,
    saves: 0, jev: 0, complaints: 0, cost: 0, missingCost: false, gaps: [], purposes, models: {}, errorsBySignature: {} };
}
const usage = (cost, input = 100, write = 0) => ({ cost, input, write, missingCost: false, missingCache: false });
const costRows = (current, previous) => {
  const scan = { windows: [window(current), window(previous)], scannedFiles: 0, warnings: [], evidence: {}, topSessions: { "purpose:new": [{ sessionId: "s1", sessionPath: "/p", cost: 3 }] }, makerResults: [] };
  return Object.fromEntries(costSection(scan, []).metrics.map((m) => [m.id, m]));
};

test("cost rows: under the floor is ok, a new key is watch, a recorded zero is compared", () => {
  const rows = costRows({ tiny: usage(0.5), new: usage(3), zero: usage(3) }, { tiny: usage(0.1), zero: usage(0) });
  assert.equal(rows["purpose:tiny"].status, "ok");
  assert.match(rows["purpose:tiny"].note, /\$1 미만/);
  assert.equal(rows["purpose:new"].status, "watch");
  assert.equal(rows["purpose:new"].note, "직전 7일 기록 없음");
  assert.deepEqual(rows["purpose:new"].evidence.map((e) => e.label), ["세션 비용 $3.00"]);
  assert.equal(rows["purpose:zero"].status, "problem");
});

test("cost rows beyond the top 12 fold into one total", () => {
  const current = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`p${i}`, usage(20 - i)]));
  const rows = costRows(current, current);
  assert.equal(Object.keys(rows).filter((id) => id.startsWith("purpose:")).length, 12);
  assert.equal(rows["cost-other"].current, 7 + 8);
  assert.equal(rows["cost-other"].label, "그 밖의 2개 합계");
});

test("cache-write rows appear only at or above $1 and 10% share, translation included", () => {
  const rows = costRows(
    { big: usage(5, 100, 30), low: usage(5, 100, 5), cheap: usage(0.5, 100, 50), "user-input-translation": usage(0.2, 100, 60) },
    { big: usage(5, 100, 10), low: usage(5, 100, 5), cheap: usage(0.5, 100, 50), "user-input-translation": usage(0.2, 100, 1) },
  );
  assert.equal(rows["purpose-cache:big"].status, "problem");
  assert.equal(rows["purpose-cache:low"], undefined);
  assert.equal(rows["purpose-cache:cheap"], undefined);
  assert.equal(rows["purpose-cache:user-input-translation"], undefined);
});

test("report masking reaches ids and session paths", () => {
  const report = { sections: [{ id: "cost", title: "", status: "ok", summary: "", warnings: [], metrics: [{
    id: "purpose:API_KEY=upkeepvalue123", label: "API_KEY=upkeepvalue123", unit: "usd", current: 1, previous: 1, status: "ok", criterion: "",
    evidence: [{ label: "x", sessionPath: "/tmp/TOKEN=pathvalue456/s.jsonl" }],
  }] }] };
  maskReport(report);
  const text = JSON.stringify(report);
  assert.ok(!text.includes("upkeepvalue123") && !text.includes("pathvalue456"), text);
});
