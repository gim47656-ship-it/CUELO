import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDuePrompt,
  buildFullPrompt,
  buildMetricPrompt,
  buildSectionPrompt,
  hasFlaggedItems,
  sortDueItems,
} from "./prompt.ts";

const report = JSON.parse(readFileSync(new URL("./fixture-report.json", import.meta.url), "utf8"));
const section = (id) => report.sections.find((candidate) => candidate.id === id);

test("metric prompt carries the report values, window, criterion, HANDOFF text and evidence", () => {
  const prompt = buildMetricPrompt(report, "bottleneck", "maker-wait");
  const metric = section("bottleneck").metrics.find((candidate) => candidate.id === "maker-wait");
  assert.match(prompt, /최근 7일: 2026-10-23 ~ 2026-10-29/);
  assert.match(prompt, /직전 7일\): 2026-10-16 ~ 2026-10-22/);
  assert.match(prompt, /최근 7일 값: 412초/);
  assert.match(prompt, /직전 7일 값: 178초 \(변화 \+234초 \(\+131%\)\)/);
  assert.match(prompt, /판정: 문제/);
  assert.ok(prompt.includes(metric.criterion));
  assert.ok(prompt.includes(metric.handoff.text), "HANDOFF text must be verbatim");
  assert.ok(prompt.includes(`(${metric.handoff.path}, 「${metric.handoff.title}」)`));
  for (const evidence of metric.evidence) {
    assert.ok(prompt.includes(`세션 ${evidence.sessionId}`));
    assert.ok(prompt.includes(evidence.sessionPath));
  }
  assert.match(prompt, /멈춰서 저에게 물어봐/);
});

test("null values are written as unmeasured, never as a number", () => {
  const prompt = buildMetricPrompt(report, "complaints", "repeat-complaints");
  assert.match(prompt, /최근 7일 값: 9건/);
  assert.match(prompt, /직전 7일 값: 측정 불가\n/);
  assert.doesNotMatch(prompt, /변화/);
});

test("an unchanged value reads 「변화 없음」 once, and ratios keep one decimal", () => {
  const flat = structuredClone(report);
  const metric = flat.sections.find((s) => s.id === "memory").metrics.find((m) => m.id === "recall-unused");
  metric.current = 0.04;
  metric.previous = 0.04;
  const prompt = buildMetricPrompt(flat, "memory", "recall-unused");
  assert.match(prompt, /최근 7일 값: 4\.0%/);
  assert.match(prompt, /직전 7일 값: 4\.0% \(변화 없음\)/);
  assert.doesNotMatch(prompt, /변화 변화/);
});

test("full prompt lists only non-ok metrics and overdue items", () => {
  const prompt = buildFullPrompt(report);
  const okLabels = report.sections.flatMap((s) => s.metrics.filter((m) => m.status === "ok").map((m) => m.label));
  const flaggedLabels = report.sections.flatMap((s) => s.metrics.filter((m) => m.status !== "ok").map((m) => m.label));
  assert.ok(okLabels.length > 0 && flaggedLabels.length > 0);
  for (const label of okLabels) assert.ok(!prompt.includes(label), `ok metric leaked: ${label}`);
  for (const label of flaggedLabels) assert.ok(prompt.includes(`## ${label}`), `flagged metric missing: ${label}`);
  for (const item of section("due").items) {
    assert.equal(prompt.includes(item.ref.text), item.overdue, `overdue filter wrong for ${item.ref.title}`);
  }
  assert.ok(!prompt.includes("# 비용"), "a section with nothing flagged gets no heading");
  assert.ok(prompt.includes("2026-10-17 세션 파일 3개를 읽지 못함"));
});

test("section prompt narrows to flagged metrics, or keeps all when the section is clean", () => {
  const bottleneck = buildSectionPrompt(report, "bottleneck");
  assert.ok(bottleneck.includes("## Maker 결과 대기 중앙값"));
  assert.ok(!bottleneck.includes("같은 도구 연속 재시도"));
  const cost = buildSectionPrompt(report, "cost");
  assert.ok(cost.includes("## API 과금 합계") && cost.includes("## 캐시 미적중 입력 토큰"));
  assert.match(cost, /모두 정상으로 나왔습니다/);
});

test("due prompt quotes the HANDOFF bullet and its source", () => {
  const item = section("due").items.find((candidate) => candidate.overdue);
  const prompt = buildDuePrompt(report, item);
  assert.ok(prompt.includes(item.ref.text));
  assert.ok(prompt.includes(`${item.ref.path}의 「${item.section}」 절`));
  assert.match(prompt, /배포일 기준 계산 2026-10-28 · 기한 지남/);
});

test("due items sort overdue first, then by date, then condition and undated", () => {
  const items = [
    { ref: { title: "none" }, dueDate: null, dueKind: "none", overdue: false },
    { ref: { title: "later" }, dueDate: "2026-11-09", dueKind: "date", overdue: false },
    { ref: { title: "condition" }, dueDate: null, dueKind: "condition", overdue: false },
    { ref: { title: "sooner" }, dueDate: "2026-11-02", dueKind: "date", overdue: false },
    { ref: { title: "overdue" }, dueDate: "2026-10-20", dueKind: "date", overdue: true },
  ];
  assert.deepEqual(sortDueItems(items).map((item) => item.ref.title), ["overdue", "sooner", "later", "condition", "none"]);
});

test("hasFlaggedItems is false only when every metric is ok, nothing is overdue and nothing failed to read", () => {
  assert.equal(hasFlaggedItems(report), true);
  const clean = {
    ...report,
    sections: report.sections.map((s) => ({
      ...s,
      metrics: s.metrics.map((m) => ({ ...m, status: "ok" })),
      items: s.items?.map((item) => ({ ...item, overdue: false })),
      warnings: [],
    })),
  };
  assert.equal(hasFlaggedItems(clean), false);
  const warningOnly = structuredClone(clean);
  warningOnly.sections[2].warnings = ["비용 원장을 읽지 못함"];
  assert.equal(hasFlaggedItems(warningOnly), true);
  const prompt = buildFullPrompt(warningOnly);
  assert.ok(prompt.includes("# 비용") && prompt.includes("- 비용 원장을 읽지 못함"));
});

test("HANDOFF text keeps its own blank lines verbatim", () => {
  const spaced = structuredClone(report);
  const metric = spaced.sections[0].metrics.find((m) => m.id === "maker-wait");
  metric.handoff.text = "- **항목**: 첫 줄\n\n\n  - 세 줄 띄운 하위 항목\n";
  const prompt = buildMetricPrompt(spaced, "bottleneck", "maker-wait");
  assert.ok(prompt.includes(`\`\`\`text\n${metric.handoff.text}\n\`\`\``));
  assert.ok(buildFullPrompt(spaced).includes(metric.handoff.text));
});
