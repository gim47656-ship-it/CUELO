import type {
  UpkeepDueItem,
  UpkeepEvidence,
  UpkeepHandoffRef,
  UpkeepMetric,
  UpkeepReport,
  UpkeepSection,
  UpkeepSectionId,
  UpkeepStatus,
  UpkeepUnit,
} from "./types";

/**
 * 보수 대시보드의 작업 프롬프트 생성기. `UpkeepReport`에 들어 있는 값만 옮겨 적고, 새 CUELO 세션의
 * 입력창에 채워 둘 한국어 지시문을 만든다. 화면의 값 표기도 같은 함수를 써서 두 쪽 숫자가 어긋나지 않는다.
 */

export const UPKEEP_STATUS_LABELS: Record<UpkeepStatus, string> = {
  ok: "정상",
  watch: "주의",
  problem: "문제",
  unknown: "미확인",
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function kstIso(iso: string): string | null {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return null;
  return new Date(time + KST_OFFSET_MS).toISOString();
}

/** ISO 시각을 한국 날짜(YYYY-MM-DD)로. 읽지 못하면 원문 그대로. */
export function kstDate(iso: string): string {
  return kstIso(iso)?.slice(0, 10) ?? iso;
}

/** ISO 시각을 한국 시각(YYYY-MM-DD HH:mm)으로. 읽지 못하면 원문 그대로. */
export function kstDateTime(iso: string): string {
  const value = kstIso(iso);
  return value ? `${value.slice(0, 10)} ${value.slice(11, 16)}` : iso;
}

/** 창의 끝 시각은 다음 날 0시일 수 있어 날짜 범위는 끝 시각 1ms 전 날짜로 적는다. */
function rangeEnd(iso: string): string {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? iso : kstDate(new Date(time - 1).toISOString());
}

export function windowRanges(report: UpkeepReport): { current: string; previous: string } {
  const { currentStart, currentEnd, previousStart } = report.window;
  return {
    current: `${kstDate(currentStart)} ~ ${rangeEnd(currentEnd)}`,
    previous: `${kstDate(previousStart)} ~ ${rangeEnd(currentStart)}`,
  };
}

function groupDigits(value: number): string {
  const [whole, fraction] = String(value).split(".");
  const sign = whole.startsWith("-") ? "-" : "";
  const digits = sign ? whole.slice(1) : whole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${grouped}${fraction ? `.${fraction}` : ""}`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** 지표 단위에 맞춘 값 표기. null은 「측정 불가」. */
export function formatUpkeepValue(unit: UpkeepUnit, value: number | null): string {
  if (value === null) return "측정 불가";
  switch (unit) {
    case "count":
      return `${groupDigits(round(value, 2))}건`;
    case "ratio":
      return `${(value * 100).toFixed(1)}%`;
    case "usd":
      return `$${groupDigits(round(value, 2))}`;
    case "ms":
      return value >= 1000 ? `${groupDigits(round(value / 1000, 1))}초` : `${groupDigits(round(value, 0))}ms`;
    case "tokens":
      return `${groupDigits(Math.round(value))} 토큰`;
  }
}

/** 직전 7일 대비 변화. 둘 중 하나라도 없으면 null. ratio는 %p로 적는다. */
export function formatUpkeepChange(metric: Pick<UpkeepMetric, "unit" | "current" | "previous">): string | null {
  const { unit, current, previous } = metric;
  if (current === null || previous === null) return null;
  const delta = current - previous;
  // 화면은 「변화」 칸 옆에, 프롬프트는 「변화 …」 뒤에 붙이므로 값 자리에는 「없음」만 적는다.
  if (delta === 0) return "없음";
  const sign = delta > 0 ? "+" : "-";
  if (unit === "ratio") return `${sign}${(Math.abs(delta) * 100).toFixed(1)}%p`;
  const amount = formatUpkeepValue(unit, Math.abs(delta));
  const percent = previous === 0 ? "" : ` (${sign}${round((Math.abs(delta) / Math.abs(previous)) * 100, 0)}%)`;
  return `${sign}${amount}${percent}`;
}

const DUE_KIND_ORDER: Record<UpkeepDueItem["dueKind"], number> = { date: 0, "after-deploy": 0, condition: 1, none: 2 };

/** 기한 지난 것 먼저, 그다음 날짜 있는 것을 이른 날짜순, 마지막에 조건부·날짜 없음. */
export function sortDueItems(items: readonly UpkeepDueItem[]): UpkeepDueItem[] {
  return [...items].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
    if (Boolean(a.dueDate) !== Boolean(b.dueDate)) return a.dueDate ? -1 : 1;
    return DUE_KIND_ORDER[a.dueKind] - DUE_KIND_ORDER[b.dueKind];
  });
}

/** 기한 한 줄, 예: 「2026-10-28 · 기한 지남」, 「조건이 생기면」. */
export function describeDue(item: UpkeepDueItem): string {
  if (item.dueKind === "condition") return "조건이 생기면 점검";
  if (!item.dueDate) return "점검일 미기재";
  const basis = item.dueKind === "after-deploy" ? "배포일 기준 계산" : "점검일";
  return `${basis} ${item.dueDate}${item.overdue ? " · 기한 지남" : ""}`;
}

export function isFlagged(status: UpkeepStatus): boolean {
  return status !== "ok";
}

export function findSection(report: UpkeepReport, sectionId: UpkeepSectionId): UpkeepSection {
  const section = report.sections.find((candidate) => candidate.id === sectionId);
  if (!section) throw new Error(`upkeep section not found: ${sectionId}`);
  return section;
}

/** 전체 점검 프롬프트에 실을 것이 있는지. 화면이 「전체 점검 프롬프트」를 켤지 정한다. */
export function hasFlaggedItems(report: UpkeepReport): boolean {
  return report.sections.some((section) => (
    section.metrics.some((metric) => isFlagged(metric.status))
    || (section.items ?? []).some((item) => item.overdue)
    || section.warnings.length > 0
  ));
}

// ── 프롬프트 조각 ──────────────────────────────────────────────────────────

function periodLines(report: UpkeepReport): string[] {
  const ranges = windowRanges(report);
  return [
    `- 최근 7일: ${ranges.current}`,
    `- 비교 기간(직전 7일): ${ranges.previous}`,
    `- 보고서 생성: ${kstDateTime(report.generatedAt)} (세션 파일 ${groupDigits(report.scannedFiles)}개를 읽음)`,
  ];
}

function evidenceLine(evidence: UpkeepEvidence): string {
  const parts = [evidence.label];
  if (evidence.count !== undefined) parts.push(`${groupDigits(evidence.count)}회`);
  if (evidence.sessionId) parts.push(`세션 ${evidence.sessionId}`);
  if (evidence.sessionPath) parts.push(evidence.sessionPath);
  if (evidence.timestamp) parts.push(kstDateTime(evidence.timestamp));
  if (evidence.detail) parts.push(evidence.detail);
  return `- ${parts.join(" · ")}`;
}

function handoffBlock(ref: UpkeepHandoffRef, heading: string): string[] {
  return [`${heading} (${ref.path}, 「${ref.title}」):`, "```text", ref.text, "```"];
}

function metricBlock(metric: UpkeepMetric): string[] {
  const change = formatUpkeepChange(metric);
  const lines = [
    `- 최근 7일 값: ${formatUpkeepValue(metric.unit, metric.current)}`,
    `- 직전 7일 값: ${formatUpkeepValue(metric.unit, metric.previous)}${change ? ` (변화 ${change})` : ""}`,
    `- 판정: ${UPKEEP_STATUS_LABELS[metric.status]}`,
    `- 판정 기준: ${metric.criterion}`,
  ];
  if (metric.note) lines.push(`- 해석 주의: ${metric.note}`);
  if (metric.handoff) lines.push("", ...handoffBlock(metric.handoff, "이 기준을 적은 HANDOFF 항목"));
  lines.push("", "근거 사례:");
  if (metric.evidence.length) lines.push(...metric.evidence.map(evidenceLine));
  else lines.push("- 보고서에 사례가 없습니다. 아래 요청 1번에서 직접 찾아야 합니다.");
  return lines;
}

function dueBlock(item: UpkeepDueItem): string[] {
  return [
    `- 기한: ${describeDue(item)}`,
    `- 출처: ${item.ref.path}의 「${item.section}」 절`,
    "",
    ...handoffBlock(item.ref, "HANDOFF 원문"),
  ];
}

function warningLines(section: UpkeepSection): string[] {
  if (!section.warnings.length) return [];
  return ["", "이 섹션을 만들 때 읽지 못한 자료:", ...section.warnings.map((warning) => `- ${warning}`)];
}

const REQUEST_LINES = [
  "요청:",
  "1. 위 근거 사례의 세션 파일과 경로를 직접 열어, 이 판정이 나온 원인을 찾아 주세요. 근거가 부족하면 그 사실부터 알려 주세요.",
  "2. 원인이 CUELO-private 저장소 범위 안이면 고치고, 고친 동작을 실제로 검증해 주세요.",
  "3. HANDOFF.md와 작업 기록(doc/history)에 원인·조치·검증 결과를 남겨 주세요.",
  "4. 사용자 결정이 필요한 일(기준 변경, 비용·배포·삭제 등)이면 고치지 말고 멈춰서 저에게 물어봐 주세요.",
];

const DUE_REQUEST_LINES = [
  "요청:",
  "1. 이 항목이 적어 둔 관찰·점검을 지금 해 주세요. 판정은 원문에 적힌 조건과 기준으로만 내려 주세요.",
  "2. 점검에서 결함이 나오고 CUELO-private 저장소 범위 안이면 고치고 검증해 주세요.",
  "3. 결과에 맞게 HANDOFF.md 항목(끝났으면 정리, 남으면 다음 점검일)과 작업 기록(doc/history)을 고쳐 주세요.",
  "4. 사용자 결정이 필요한 일이면 고치지 말고 멈춰서 저에게 물어봐 주세요.",
];

/** 조각 사이의 빈 줄만 하나로 줄인다. HANDOFF 원문처럼 한 줄 안에 든 줄바꿈은 손대지 않는다. */
function join(lines: string[]): string {
  const kept = lines.filter((line, index) => line !== "" || (index > 0 && lines[index - 1] !== ""));
  while (kept[0] === "") kept.shift();
  while (kept.at(-1) === "") kept.pop();
  return kept.join("\n");
}

// ── 공개 생성기 ───────────────────────────────────────────────────────────

export function buildMetricPrompt(report: UpkeepReport, sectionId: UpkeepSectionId, metricId: string): string {
  const section = findSection(report, sectionId);
  const metric = section.metrics.find((candidate) => candidate.id === metricId);
  if (!metric) throw new Error(`upkeep metric not found: ${sectionId}/${metricId}`);
  return join([
    `CUELO 보수 점검: ${section.title} › ${metric.label}`,
    "",
    "점검 기간:",
    ...periodLines(report),
    "",
    `「${metric.label}」 지표 판정이 「${UPKEEP_STATUS_LABELS[metric.status]}」입니다.`,
    ...metricBlock(metric),
    "",
    ...REQUEST_LINES,
  ]);
}

export function buildDuePrompt(report: UpkeepReport, item: UpkeepDueItem): string {
  return join([
    `CUELO 보수 점검: HANDOFF 점검 기한 › ${item.ref.title}`,
    "",
    "점검 기간:",
    ...periodLines(report),
    "",
    item.overdue ? "HANDOFF에 적힌 점검일이 지났습니다." : "HANDOFF에 남아 있는 점검 항목입니다.",
    ...dueBlock(item),
    "",
    ...DUE_REQUEST_LINES,
  ]);
}

export function buildSectionPrompt(report: UpkeepReport, sectionId: UpkeepSectionId): string {
  const section = findSection(report, sectionId);
  const flagged = section.metrics.filter((metric) => isFlagged(metric.status));
  const metrics = flagged.length ? flagged : section.metrics;
  const items = sortDueItems(section.items ?? []);
  const overdue = items.filter((item) => item.overdue);
  const dueItems = overdue.length ? overdue : items;
  const lines = [
    `CUELO 보수 점검: ${section.title} 섹션`,
    "",
    "점검 기간:",
    ...periodLines(report),
    "",
    `섹션 판정: ${UPKEEP_STATUS_LABELS[section.status]} · ${section.summary}`,
  ];
  if (metrics.length) {
    lines.push(flagged.length
      ? "아래는 이 섹션에서 정상이 아닌 지표입니다."
      : "이 섹션의 지표가 모두 정상으로 나왔습니다. 판정이 맞는지 근거로 확인해 주세요.");
  }
  for (const metric of metrics) lines.push("", `## ${metric.label}`, ...metricBlock(metric));
  if (dueItems.length) {
    lines.push("", overdue.length ? "점검일이 지난 HANDOFF 항목:" : "남아 있는 HANDOFF 점검 항목:");
    for (const item of dueItems) lines.push("", `## ${item.ref.title}`, ...dueBlock(item));
  }
  lines.push(...warningLines(section), "", ...(metrics.length ? REQUEST_LINES : DUE_REQUEST_LINES));
  return join(lines);
}

/** 보고서 전체에서 정상이 아닌 지표, 기한 지난 항목, 읽지 못한 자료만 모은 프롬프트. */
export function buildFullPrompt(report: UpkeepReport): string {
  const lines = [
    "CUELO 보수 전체 점검",
    "",
    "점검 기간:",
    ...periodLines(report),
    "",
    "보수 대시보드에서 정상이 아닌 지표, 점검일이 지난 HANDOFF 항목, 읽지 못한 자료만 모았습니다. 섹션 순서대로 처리하고, 항목마다 원인과 조치를 따로 적어 주세요.",
  ];
  let flaggedCount = 0;
  for (const section of report.sections) {
    const metrics = section.metrics.filter((metric) => isFlagged(metric.status));
    const overdue = sortDueItems(section.items ?? []).filter((item) => item.overdue);
    if (!metrics.length && !overdue.length && !section.warnings.length) continue;
    flaggedCount += metrics.length + overdue.length;
    lines.push("", `# ${section.title} (${UPKEEP_STATUS_LABELS[section.status]})`);
    for (const metric of metrics) lines.push("", `## ${metric.label}`, ...metricBlock(metric));
    for (const item of overdue) lines.push("", `## 점검일 지남: ${item.ref.title}`, ...dueBlock(item));
    lines.push(...warningLines(section));
  }
  if (!flaggedCount) lines.push("", "이번 보고서에는 정상이 아닌 지표와 기한 지난 항목이 없습니다.");
  lines.push(
    "",
    ...REQUEST_LINES,
    "5. 점검일이 지난 HANDOFF 항목은 원문에 적힌 조건과 기준으로 판정하고, 결과에 맞게 그 항목을 고쳐 주세요.",
  );
  return join(lines);
}
