import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bottleneckSection, costSection, memorySection, skillSection } from "./collect.ts";
import { emptySkillWindow } from "./skill-usage.ts";
import { scanSessions, REWRITE_CAUSES } from "./sessions.ts";

const window = (extra = {}) => ({ turns: 100, calls: 100, errors: 0, rejects: 0, compactions: 0, requests: 100, nudges: 0, recalls: 0, emptyRecalls: 0, gated: 0, nearGate: 0, recallCalls: 0, exportFailures: 0, complaints: 0, cost: 100, missingCost: false, apiKeyCalls: 0, apiKeyCost: 0, cacheWriteCost: 100, missingRewriteCost: false, rewrites: Object.fromEntries(REWRITE_CAUSES.map(c => [c, { count: 0, cost: 0 }])), gaps: [], purposes: {}, models: {}, errorsBySignature: {}, ...extra });
const scan = (a, b = {}, recent) => ({ windows: [window(a), window(b)], recent, warnings: [], evidence: {}, topSessions: {}, skills: { windows: [{}, {}], sessions: {} } });
const maker = { exits: { id: "maker-early-exits", status: "ok" }, verdicts: { id: "maker-verdicts", status: "ok" } };
const row = (section, id) => section.metrics.find(m => m.id === id);
const bottleneck = s => bottleneckSection(s, maker, []);
const usage = cost => ({ cost, input: 1000, write: 0, calls: 100, subscription: 0, unknownAuth: 0, missingCost: false, missingCache: false, providers: ["deepseek"] });

test("tiny incident ratios do not alarm, sustained errors still do", () => {
  assert.equal(row(bottleneck(scan({ calls: 39, errors: 1 }, { calls: 261, errors: 2 })), "tool-error-rate").status, "ok");
  assert.equal(row(bottleneck(scan({ errors: 10 }, { errors: 2 })), "tool-error-rate").status, "problem");
});

test("both skill-correlation false positives remain informational", () => {
  const s = scan({});
  for (const [name, afterCalls, afterFailures, restCalls, restFailures] of [["writing-skills", 39, 1, 261, 2], ["receiving-code-review", 750, 34, 4304, 96]]) {
    s.skills.windows[0][name] = { ...emptySkillWindow(), opens: 1, afterCalls, afterFailures, restCalls, restFailures };
  }
  const section = skillSection(s, [], Date.now());
  for (const name of ["writing-skills", "receiving-code-review"]) assert.equal(row(section, `skill:${name}`).status, "ok");
});

test("small intended model allocation increases do not alarm, material increases do", () => {
  const model = cost => row(costSection(scan({ models: { deepseek: usage(cost) } }, { models: { deepseek: usage(0.35) } }), []), "model:deepseek");
  assert.equal(model(7.23).status, "ok");
  assert.equal(model(20).status, "problem");
});

test("old API-key spend resets only after enough recent opportunities with no new incident", () => {
  const status = recent => row(costSection(scan({ apiKeyCost: 92.69, apiKeyCalls: 50 }, {}, window(recent)), []), "billed-api-key").status;
  assert.equal(status({ requests: 20 }), "ok");
  assert.equal(status({ requests: 19 }), "watch");
  assert.equal(status({ requests: 20, apiKeyCalls: 1 }), "watch");
});

test("memory export resets only after actual finalize opportunities, never unrelated tools", () => {
  const status = recent => row(memorySection(scan({ exportFailures: 1 }, {}, window(recent)), []), "memory-export-failures").status;
  assert.equal(status({ calls: 100, finalizeResults: 0 }), "watch");
  assert.equal(status({ calls: 100, finalizeResults: 19 }), "watch");
  assert.equal(status({ calls: 100, finalizeResults: 20 }), "ok");
  assert.equal(status({ calls: 100, finalizeResults: 20, exportFailures: 1 }), "watch");
});

test("chronic weekly budgets flag stable waste and never reset from quiet recent activity", () => {
  const a = window({ nudges: 58.5, cacheWriteCost: 467 });
  a.rewrites.prompt = { count: 50, cost: 247.12 };
  const s = scan(a, a, window({}));
  assert.equal(row(costSection(s, []), "session-cache-rewrite").status, "problem");
  assert.equal(row(bottleneck(s), "todo-nudges").status, "problem");
  const low = window({ nudges: 24, cacheWriteCost: 100 });
  low.rewrites.prompt = { count: 10, cost: 9 };
  assert.equal(row(costSection(scan(low, low), []), "session-cache-rewrite").status, "ok");
  assert.equal(row(bottleneck(scan(low, low)), "todo-nudges").status, "ok");
});

test("48h scan counts new requests, preserves old spend and excludes only exact harness or finalizer gate notices", async () => {
  const dir = mkdtempSync(join(tmpdir(), "upkeep-hardening-"));
  try {
    const now = Date.parse("2026-11-12T07:17:50.968Z");
    const msg = (id, at, message) => ({ type: "message", id, timestamp: new Date(at).toISOString(), message });
    const recent = now - 1000;
    const rows = [{ type: "session", id: "S", timestamp: new Date(now - 6 * 86400000).toISOString() },
      msg("old", now - 6 * 86400000, { role: "assistant", model: "m", provider: "anthropic", usage: { input: 100, cacheRead: 0, cacheWrite: 0, credentialKind: "api-key", cost: { total: 92.69, cacheWrite: 0 } } }),
      ...Array.from({ length: 20 }, (_, i) => msg(`new-${i}`, recent, { role: "assistant", model: "m", usage: { input: 100, cost: { total: 0, cacheWrite: 0 } } })),
    ];
    const results = [
      ["bash", "[검사 종료 코드] 검사 명령의 종료 코드를 보존하세요."],
      ["git_finalize", "git_finalize failed at cross-review: cross-family review required before this commit (docs, tests excluded)"],
      ["git_finalize", "fatal: remote rejected push; cross_review was mentioned in the log"],
      ["bash", "test failed: expected [검사 종료 코드] notice"],
      ["bash", "AssertionError: expected 2 but got 1\nCommand exited with code 1\n[검사 종료 코드] 검사와 출력 가공 명령을 함께 실행했다. 이 안내는 실패 판정이 아닙니다."],
      ["bash", "[검사 종료 코드] 검사와 출력 가공 명령을 함께 실행했다. 안내\nError: real failure\nCommand exited with code 1"],
    ];
    results.forEach(([name, text], i) => rows.push(msg(`a${i}`, recent, { role: "assistant", content: [{ type: "toolCall", id: `call${i}`, name, arguments: {} }] }), msg(`r${i}`, recent, { role: "toolResult", toolCallId: `call${i}`, toolName: name, isError: true, content: [{ text }] })));
    writeFileSync(join(dir, "s.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
    const s = await scanSessions(dir, now);
    assert.equal(s.windows[0].errors, 4);
    assert.equal(s.recent.finalizeResults, 0, "gate refusals and failed pushes did not attempt memory export");
    assert.equal(Object.keys(s.windows[0].errorsBySignature).some(k => k.startsWith("bash: [검사 종료 코드]")), false);
    assert.equal(s.recent.requests, 20);
    assert.equal(s.recent.apiKeyCalls, 0);
    const billed = row(costSection(s, []), "billed-api-key");
    assert.equal(billed.current, 92.69);
    assert.equal(billed.status, "ok");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
