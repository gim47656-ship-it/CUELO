import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildDuePrompt,
  buildFullPrompt,
  buildMetricPrompt,
  buildSectionPrompt,
  fixComparison,
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

test("a marked metric's prompt states the mark time, the after and pre-fix values, and tags earlier cases", () => {
  const marked = structuredClone(report);
  const metric = marked.sections.find((s) => s.id === "bottleneck").metrics.find((m) => m.id === "maker-wait");
  const [first, ...rest] = metric.evidence;
  metric.fix = { markedAt: "2026-10-31T05:30:00.000Z", before: 600_000, beforeMs: 6 * 86_400_000, afterMs: 7_200_000, perDay: false, observing: false };
  metric.evidence = [{ ...first, timestamp: "2026-10-31T05:00:00.000Z" }, ...rest.map((e) => ({ ...e, timestamp: "2026-10-31T06:00:00.000Z" }))];
  const prompt = buildMetricPrompt(marked, "bottleneck", "maker-wait");
  assert.match(prompt, /고침 표시: 2026-10-31 14:30\. 판정은 이 시각 이후 기록만으로/);
  assert.match(prompt, /고침 뒤 값\(표시 뒤 2시간\): 412초/);
  assert.match(prompt, /고침 전 값\(최근 7일 중 표시 전 6일\): 600초 \(고침 전 대비 변화 -188초 \(-31%\)\)/);
  assert.doesNotMatch(prompt, /- 최근 7일 값:/);
  assert.equal(prompt.match(/ · 고침 전/g)?.length, 1, "only the case before the mark is tagged");
});

test("a marked metric compares after and before the mark in the same unit with both window lengths, per day for window totals", () => {
  const marked = structuredClone(report);
  const metric = marked.sections.find((s) => s.id === "complaints").metrics.find((m) => m.id === "repeat-complaints");
  metric.current = 0;
  metric.previous = 5;
  metric.fix = { markedAt: "2026-10-31T05:30:00.000Z", before: 3, beforeMs: 6 * 86_400_000, afterMs: 86_400_000, perDay: true, observing: false };
  const prompt = buildMetricPrompt(marked, "complaints", "repeat-complaints");
  assert.match(prompt, /- 고침 뒤 값\(표시 뒤 1일\): 0건\/일\n/);
  assert.match(prompt, /- 고침 전 값\(최근 7일 중 표시 전 6일\): 0\.5건\/일 \(고침 전 대비 변화 -0\.5건\/일 \(-100%\)\)\n/);
  // 판정 기준인 직전 7일 값은 그대로 두되, 길이가 다른 고침 뒤 값과 바로 견주지 않는다.
  assert.match(prompt, /- 직전 7일 값: 5건\n/);

  metric.fix = { ...metric.fix, before: 0.25, beforeMs: 6.5 * 86_400_000, afterMs: 5 * 60_000, perDay: false };
  metric.unit = "ratio";
  metric.current = 0.1;
  const rate = buildMetricPrompt(marked, "complaints", "repeat-complaints");
  assert.match(rate, /- 고침 뒤 값\(표시 뒤 5분\): 10\.0%\n/);
  assert.match(rate, /- 고침 전 값\(최근 7일 중 표시 전 6\.5일\): 25\.0% \(고침 전 대비 변화 -15\.0%p\)\n/);
});

test("while the after-mark sample is short, neither the card cells nor the prompt show an after value or a change figure", () => {
  const marked = structuredClone(report);
  const metric = marked.sections.find((s) => s.id === "complaints").metrics.find((m) => m.id === "repeat-complaints");
  metric.current = 0;
  metric.previous = 5;
  metric.fix = { markedAt: "2026-10-31T05:30:00.000Z", before: 3, beforeMs: 7 * 86_400_000, afterMs: 0, perDay: true, observing: true };
  const cells = fixComparison(metric, metric.fix);
  assert.deepEqual([cells.after, cells.change, cells.before, cells.beforeWindow], ["관찰 중", "관찰 중", "0.43건/일", "7일"]);
  const prompt = buildMetricPrompt(marked, "complaints", "repeat-complaints");
  assert.match(prompt, /- 고침 뒤 값\(표시 뒤 0분\): 관찰 중\n/);
  assert.match(prompt, /- 고침 전 값\(최근 7일 중 표시 전 7일\): 0\.43건\/일\n/);
  assert.doesNotMatch(prompt, /고침 전 대비 변화|-100%/);
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
  for (const item of section("ops").items) {
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
  const item = section("ops").items.find((candidate) => candidate.overdue);
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
