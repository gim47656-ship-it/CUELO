/**
 * 보수 대시보드 보고서 조립. 세션 스캔·HANDOFF·배포 기록을 읽어 `UpkeepReport`를 만든다.
 * 결과는 5분 동안 globalThis에 두고, 동시에 들어온 요청은 진행 중인 스캔 하나를 함께 기다린다.
 * 읽기 전용이며 어떤 파일도 쓰지 않는다.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import {
  CACHE_WRITE_FLOOR, CI_STALE_MS, COST_FLOOR_USD, COST_TOP, EARLY_EXIT_REPORT_COUNT, GENERIC_CRITERION,
  OVERDUE_PROBLEM, OVERDUE_WATCH, SLOW_GAP_MS, TRANSLATION_CACHE_BASELINE, TRANSLATION_CACHE_BEFORE, compare, perTurns, worst,
} from "./criteria";
import { inspectDeploy, type DeployState } from "./deploy";
import { readHandoffs } from "./handoff";
import { maskSecrets, scanSessions, type MakerResult, type ScanResult, type SessionCost, type UsageTotal } from "./sessions";
import type { UpkeepDueItem, UpkeepEvidence, UpkeepMetric, UpkeepReport, UpkeepSection, UpkeepStatus } from "./types";

const DAY_MS = 86_400_000;
const CACHE_TTL_MS = 300_000;

type Cache = { report?: UpkeepReport; expires?: number; pending?: Promise<UpkeepReport> };
const cache = ((globalThis as typeof globalThis & { __cueloUpkeepCache?: Cache }).__cueloUpkeepCache ??= {});

export function collectUpkeep(refresh = false): Promise<UpkeepReport> {
  if (cache.pending) return cache.pending;
  if (!refresh && cache.report && (cache.expires ?? 0) > Date.now()) return Promise.resolve(cache.report);
  const pending = buildReport()
    .then((report) => {
      cache.report = report;
      cache.expires = Date.now() + CACHE_TTL_MS;
      return report;
    })
    .finally(() => {
      delete cache.pending;
    });
  cache.pending = pending;
  return pending;
}

/** 작업 프롬프트로 새 세션을 열 CUELO 저장소. HANDOFF가 있어야 점검 기한도 읽을 수 있다. */
function findRepo(): string | null {
  const preferred = join(homedir(), "src/CUELO-private");
  if (existsSync(join(preferred, ".git")) && existsSync(join(preferred, "HANDOFF.md"))) return preferred;
  return existsSync(join(process.cwd(), "HANDOFF.md")) ? process.cwd() : null;
}

function metric(
  id: string,
  label: string,
  unit: UpkeepMetric["unit"],
  current: number | null,
  previous: number | null,
  status: UpkeepStatus,
  criterion = GENERIC_CRITERION,
): UpkeepMetric {
  return { id, label, unit, current, previous, status, criterion, evidence: [] };
}

function section(id: UpkeepSection["id"], title: string, metrics: UpkeepMetric[], warnings: string[] = [], items?: UpkeepDueItem[]): UpkeepSection {
  return { id, title, status: worst(metrics.map((m) => m.status)), summary: "", metrics, warnings, ...(items ? { items } : {}) };
}

function findHandoff(items: UpkeepDueItem[], titlePrefix: string) {
  return items.find((item) => item.ref.title.startsWith(titlePrefix))?.ref;
}

function sessionRows(rows: SessionCost[] | undefined): UpkeepEvidence[] {
  return (rows ?? []).map((row) => ({ label: `세션 비용 $${row.cost.toFixed(2)}`, sessionId: row.sessionId, sessionPath: row.sessionPath }));
}

/** 건수 지표: 사용자 요청 100건당으로 비교하고 원 건수는 note에 남긴다. */
function perTurnMetric(id: string, label: string, scan: ScanResult, pick: (w: ScanResult["windows"][0]) => number): UpkeepMetric {
  const [a, b] = scan.windows;
  const m = metric(id, `${label} (요청 100건당)`, "count", perTurns(pick(a), a.turns), perTurns(pick(b), b.turns), compare(perTurns(pick(a), a.turns), perTurns(pick(b), b.turns), a.turns, b.turns));
  m.note = `원 건수 ${pick(a)} / ${pick(b)}, 사용자 요청 ${a.turns} / ${b.turns}건`;
  m.evidence = scan.evidence[id] ?? [];
  return m;
}

type LedgerRow = {
  type?: string;
  ts?: string;
  name?: string;
  assignmentId?: string;
  chosenModel?: string;
  verdict?: string;
};
const UNKNOWN_MODEL = "모델 미확인";

/** `openai-codex/gpt-6.1-sol:auto` → `gpt-6.1-sol` */
function shortModel(selector: string): string {
  return selector.split("/").at(-1)?.split(":")[0] ?? selector;
}

/**
 * Maker 조기 종료: `partial`로 끝난 결과를 모델별로 센다(HANDOFF 「기본 Maker 관찰」).
 * `partial`은 원장에 남지 않아 부모 세션의 결과 알림(`async-result`)에서 읽는다. 짧게 끝난 정상 결과
 * (읽기 전용 일괄 작업 등)가 많아 경과 시간은 판정에 쓰지 않는다. 모델은 원장 발주 행의 chosenModel이며
 * assignmentId는 `<세션>#<호출>#<순번>` 꼴이다.
 */
export async function makerEarlyExits(
  agentDir: string,
  now: number,
  handoffs: UpkeepDueItem[],
  makerResults: MakerResult[],
): Promise<{ metric: UpkeepMetric; warning?: string }> {
  const m = metric("maker-early-exits", "Maker partial 종료", "count", null, null, "unknown",
    `partial로 끝난 Maker 결과가 한 모델에서 ${EARLY_EXIT_REPORT_COUNT}회 이상이거나, 결과 대비 비율이 직전보다 50% 넘게 늘면 주의`);
  m.handoff = handoffs.find((x) => x.ref.title.includes("기본 Maker 관찰"))?.ref;
  let text: string;
  try {
    text = await readFile(join(agentDir, "routing-ledger.jsonl"), "utf8");
  } catch {
    return { metric: m, warning: "Maker 원장을 읽을 수 없습니다." };
  }
  const windowOf = (ts: string | undefined) => {
    const time = Date.parse(ts ?? "");
    if (!Number.isFinite(time) || time > now || time < now - 14 * DAY_MS) return null;
    return time >= now - 7 * DAY_MS ? 0 : 1;
  };
  // 원장은 한 번만 훑고, 줄마다 모양을 확인해 이상한 행 하나가 보고서 전체를 멈추지 않게 한다.
  const modelByName: Record<string, string> = {};
  let parsed = 0, reworks = 0;
  let lastYield = performance.now();
  for (const line of text.split("\n")) {
    if (performance.now() - lastYield >= 8) {
      await yieldEventLoop();
      lastYield = performance.now();
    }
    let r: LedgerRow;
    try {
      r = JSON.parse(line);
    } catch {
      continue; // 빈 줄·깨진 줄은 건너뛴다.
    }
    if (!r || typeof r !== "object") continue;
    parsed++;
    if (r.type === "dispatch" && typeof r.assignmentId === "string" && typeof r.chosenModel === "string" && typeof r.name === "string") {
      modelByName[`${r.assignmentId.split("#")[0]}#${r.name}`] = shortModel(r.chosenModel);
    } else if (r.type === "verdict" && r.verdict === "rework" && typeof r.ts === "string" && windowOf(r.ts) === 0) reworks++;
  }
  if (!parsed && text.trim()) return { metric: m, warning: "Maker 원장을 해석할 수 없습니다." };

  type Finished = { model: string; window: 0 | 1; early: boolean; evidence: UpkeepEvidence };
  const finished: Finished[] = [];
  for (const r of makerResults) {
    const window = windowOf(r.timestamp);
    if (window === null) continue;
    finished.push({
      model: modelByName[`${r.sessionId}#${r.name}`] ?? UNKNOWN_MODEL,
      window,
      early: r.partial,
      evidence: { label: `${r.name} partial로 종료${r.durationSec === null ? "" : ` (${r.durationSec}초)`}`, sessionId: r.sessionId, timestamp: r.timestamp },
    });
  }

  const current = finished.filter((x) => x.window === 0);
  const previous = finished.filter((x) => x.window === 1);
  const earlyCurrent = current.filter((x) => x.early);
  const earlyPrevious = previous.filter((x) => x.early);
  const byModel: Record<string, { early: number; total: number }> = {};
  for (const x of current) {
    const row = (byModel[x.model] ??= { early: 0, total: 0 });
    row.total++;
    if (x.early) row.early++;
  }
  const rate = (early: number, total: number) => (total ? early / total : null);
  const rateStatus = compare(rate(earlyCurrent.length, current.length), rate(earlyPrevious.length, previous.length), current.length, previous.length);
  // 원장에 발주가 없는 결과는 한 모델로 묶이지 않으므로 모델별 기준에서 뺀다.
  const modelStatus = Object.entries(byModel).some(([model, x]) => model !== UNKNOWN_MODEL && x.early >= EARLY_EXIT_REPORT_COUNT) ? "watch" : "ok";

  m.current = earlyCurrent.length;
  m.previous = earlyPrevious.length;
  m.status = rateStatus === "unknown" ? modelStatus : worst([rateStatus, modelStatus]);
  const models = Object.entries(byModel).sort((a, b) => b[1].early - a[1].early || b[1].total - a[1].total);
  m.note = `최근 7일 모델별 partial/결과: ${models.map(([model, x]) => `${model} ${x.early}/${x.total}`).join(", ") || "결과 없음"}. 직전 7일 결과 ${previous.length}건, 최근 rework 판정 ${reworks}건.`;
  m.evidence = earlyCurrent.slice(0, 10).map((x) => ({ ...x.evidence, label: `${x.evidence.label} · ${x.model}` }));
  return { metric: m };
}

function bottleneckSection(scan: ScanResult, makerExits: UpkeepMetric, warnings: string[]): UpkeepSection {
  const [a, b] = scan.windows;
  const errorRate = metric("tool-error-rate", "도구 오류율", "ratio", a.calls ? a.errors / a.calls : null, b.calls ? b.errors / b.calls : null,
    compare(a.calls ? a.errors / a.calls : null, b.calls ? b.errors / b.calls : null, a.calls, b.calls));
  errorRate.note = `오류 ${a.errors} / ${b.errors}건, 호출 ${a.calls} / ${b.calls}건. 사용자 중단·취소·검색 무일치는 뺐습니다.`;
  errorRate.evidence = Object.entries(a.errorsBySignature).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([label, count]) => ({ label, count }));

  const p90 = (values: number[]) => (values.length ? [...values].sort((x, y) => x - y)[Math.ceil(values.length * 0.9) - 1] : null);
  const gapP90 = metric("slow-gap-p90", "도구 결과 뒤 다음 요청까지 p90", "ms", p90(a.gaps), p90(b.gaps), compare(p90(a.gaps), p90(b.gaps), a.gaps.length, b.gaps.length));
  gapP90.evidence = scan.evidence["slow-gaps"] ?? [];

  return section("bottleneck", "작업 병목", [
    errorRate,
    perTurnMetric("dispatch-rejects", "작업 발주 거절", scan, (w) => w.rejects),
    perTurnMetric("slow-gaps", `${SLOW_GAP_MS / 1000}초 넘는 대기`, scan, (w) => w.gaps.filter((g) => g > SLOW_GAP_MS).length),
    gapP90,
    perTurnMetric("compactions", "컨텍스트 압축", scan, (w) => w.compactions),
    perTurnMetric("todo-nudges", "할 일 갱신 알림", scan, (w) => w.nudges),
    makerExits,
  ], warnings);
}

function memorySection(scan: ScanResult, handoffs: UpkeepDueItem[]): UpkeepSection {
  const [a, b] = scan.windows;
  const recallRate = metric("recall-per-turn", "요청당 기억 회상 주입", "ratio", a.turns ? a.recalls / a.turns : null, b.turns ? b.recalls / b.turns : null,
    compare(a.turns ? a.recalls / a.turns : null, b.turns ? b.recalls / b.turns : null, a.turns, b.turns, "lower"));
  recallRate.note = `주입 ${a.recalls} / ${b.recalls}건. 줄어들면 나빠진 것으로 봅니다.`;
  recallRate.handoff = findHandoff(handoffs, "11-02 후속 점검");

  const gatedShare = (w: ScanResult["windows"][0]) => (w.gated + w.recalls ? w.gated / (w.gated + w.recalls) : null);
  const gated = metric("gated-ratio", "게이트에 걸려 빠진 회상 비율", "ratio", gatedShare(a), gatedShare(b),
    compare(gatedShare(a), gatedShare(b), a.gated + a.recalls, b.gated + b.recalls));
  gated.evidence = scan.evidence["gated-ratio"] ?? [];
  gated.note = `게이트 기준 바로 아래(0.05 이내)에서 빠진 회상 ${a.nearGate} / ${b.nearGate}건`;
  if (a.nearGate) gated.evidence = [...(scan.evidence["near-gate"] ?? []), ...gated.evidence].slice(0, 10);

  const empty = perTurnMetric("empty-recall", "빈 회상", scan, (w) => w.emptyRecalls);
  const saves = perTurnMetric("autolearn", "교훈 자동 저장", scan, (w) => w.saves);
  // 저장이 줄면 나빠진 것: 방향을 뒤집어 다시 판정한다.
  saves.status = compare(saves.current, saves.previous, a.turns, b.turns, "lower");
  const recallCalls = perTurnMetric("recall-calls", "명시적 회상 호출", scan, (w) => w.recallCalls);
  recallCalls.status = recallCalls.status === "unknown" ? "unknown" : "ok";
  recallCalls.criterion = "참고용(판정 안 함)";
  const jev = perTurnMetric("jev-memory", "Jev 기억 적용 판정", scan, (w) => w.jev);

  return section("memory", "기억 회상", [recallRate, gated, empty, saves, recallCalls, jev]);
}

function costMetric(id: string, label: string, current: UsageTotal | undefined, previous: UsageTotal | undefined): UpkeepMetric {
  const m = metric(id, label, "usd", current?.missingCost ? null : current?.cost ?? 0, previous?.missingCost ? null : previous?.cost ?? 0, "unknown");
  if (m.current === null || m.previous === null) {
    m.note = "일부 사용량 기록에 비용이 없습니다.";
    return m;
  }
  if (Math.max(m.current, m.previous) < COST_FLOOR_USD) {
    m.status = "ok";
    m.note = `두 기간 모두 $${COST_FLOOR_USD} 미만이라 판정하지 않습니다.`;
  } else if (!previous) {
    m.status = "watch";
    m.note = "직전 7일 기록 없음";
  } else {
    m.status = compare(m.current, m.previous, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  }
  return m;
}

/** 캐시 쓰기 비율: 기준(10%) 미만이면 정상, 이상이면 직전과 비교하고 직전 기록이 없으면 주의. */
function cacheWriteMetric(id: string, label: string, current: UsageTotal | undefined, previous: UsageTotal | undefined): UpkeepMetric {
  const share = (u: UsageTotal | undefined) => (!u || u.missingCache || !u.input ? null : u.write / u.input);
  const m = metric(id, label, "ratio", share(current), share(previous), "ok",
    `캐시 쓰기 비율이 ${CACHE_WRITE_FLOOR * 100}% 이상이면서 직전보다 50% 넘게 늘면 주의, 2배 이상이면 문제`);
  if (m.current === null) m.status = "unknown";
  else if (m.current < CACHE_WRITE_FLOOR) m.status = "ok";
  else if (m.previous === null) {
    m.status = "watch";
    m.note = "직전 7일 기록 없음";
  } else m.status = compare(m.current, m.previous, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return m;
}

export function costSection(scan: ScanResult, handoffs: UpkeepDueItem[]): UpkeepSection {
  const [a, b] = scan.windows;
  const perTurn = metric("cost-per-turn", "요청당 추정 비용", "usd", a.missingCost || !a.turns ? null : a.cost / a.turns,
    b.missingCost || !b.turns ? null : b.cost / b.turns, "unknown");
  perTurn.status = compare(perTurn.current, perTurn.previous, a.turns, b.turns);
  perTurn.note = "토큰 단가 환산 추정치입니다. OAuth 구독 사용분은 실제 청구액이 아닙니다.";
  perTurn.evidence = sessionRows(scan.topSessions.total);

  const rows: { metric: UpkeepMetric; cache: UpkeepMetric }[] = [];
  for (const key of new Set([...Object.keys(a.purposes), ...Object.keys(b.purposes)])) {
    const m = costMetric(`purpose:${key}`, `보조 호출 ${key}`, a.purposes[key], b.purposes[key]);
    m.evidence = sessionRows(scan.topSessions[`purpose:${key}`]);
    rows.push({ metric: m, cache: cacheWriteMetric(`purpose-cache:${key}`, `보조 호출 ${key} 캐시 쓰기 비율`, a.purposes[key], b.purposes[key]) });
  }
  for (const key of new Set([...Object.keys(a.models), ...Object.keys(b.models)])) {
    const m = costMetric(`model:${key}`, `모델 ${key}`, a.models[key], b.models[key]);
    m.evidence = sessionRows(scan.topSessions[`model:${key}`]);
    m.note = [m.note, m.id.startsWith("model:openai-codex/") ? "ChatGPT 구독 사용분이라 실제 청구액이 아닙니다." : ""].filter(Boolean).join(" ");
    rows.push({ metric: m, cache: cacheWriteMetric(`model-cache:${key}`, `모델 ${key} 캐시 쓰기 비율`, a.models[key], b.models[key]) });
  }
  rows.sort((x, y) => (y.metric.current ?? 0) - (x.metric.current ?? 0));

  const top = rows.slice(0, COST_TOP);
  const rest = rows.slice(COST_TOP);
  // 캐시 쓰기 비율은 금액이 기준 이상이고 비율도 기준 이상인 항목만 보여 준다.
  const caches = top
    .filter((r) => Math.max(r.metric.current ?? 0, r.metric.previous ?? 0) >= COST_FLOOR_USD && (r.cache.current ?? 0) >= CACHE_WRITE_FLOOR)
    .map((r) => r.cache);
  // 통역 캐시 쓰기 비율은 HANDOFF 「리뷰 게이트 다듬기 후속」의 관찰 대상이라, 기준을 넘겨 보일 때 그 항목과 기준선을 붙인다.
  const translation = caches.find((c) => c.id === "purpose-cache:user-input-translation");
  if (translation) {
    translation.handoff = findHandoff(handoffs, "리뷰 게이트 다듬기 후속");
    translation.note = [translation.note, `참고 수준: 수정 전 ${TRANSLATION_CACHE_BEFORE * 100}%, 평소 ${TRANSLATION_CACHE_BASELINE * 100}%.`].filter(Boolean).join(" ");
  }

  const metrics = [perTurn, ...top.map((r) => r.metric), ...caches];
  if (rest.length) {
    const sum = (pick: (m: UpkeepMetric) => number | null) => (rest.some((r) => pick(r.metric) === null) ? null : rest.reduce((n, r) => n + (pick(r.metric) ?? 0), 0));
    const other = metric("cost-other", `그 밖의 ${rest.length}개 합계`, "usd", sum((m) => m.current), sum((m) => m.previous), "ok");
    other.criterion = "참고용(판정 안 함)";
    other.note = rest.map((r) => r.metric.label).join(", ");
    metrics.push(other);
  }
  return section("cost", "불필요한 비용", metrics);
}

function dueSection(items: UpkeepDueItem[], warnings: string[]): UpkeepSection {
  const overdue = items.filter((x) => x.overdue);
  const m = metric("overdue", "기한 지난 점검", "count", warnings.length && !items.length ? null : overdue.length, null,
    warnings.length && !items.length ? "unknown" : overdue.length >= OVERDUE_PROBLEM ? "problem" : overdue.length >= OVERDUE_WATCH ? "watch" : "ok",
    `기한 지난 항목 ${OVERDUE_WATCH}건 이상 주의, ${OVERDUE_PROBLEM}건 이상 문제`);
  m.evidence = overdue.slice(0, 10).map((item) => ({ label: `${item.ref.title} · ${item.dueDate}`, detail: item.ref.path }));
  return section("due", "점검 기한", [m], warnings, items);
}

function complaintSection(scan: ScanResult): UpkeepSection {
  const m = perTurnMetric("repeat-complaints", "다시 지적하는 표현", scan, (w) => w.complaints);
  m.note = `${m.note}. 정해 둔 표현 목록에 없는 지적은 놓칩니다.`;
  return section("complaints", "사용자 지적 반복", [m]);
}

function deploySection(deploy: DeployState, now: number): UpkeepSection {
  const differs = deploy.head && deploy.deployed ? !deploy.head.toLowerCase().startsWith(deploy.deployed.toLowerCase()) : null;
  const revision = metric("revision-diff", "배포 리비전과 저장소 HEAD", "count", differs === null ? null : Number(differs), null,
    differs === null ? "unknown" : differs ? "watch" : "ok", "배포한 리비전이 저장소 HEAD와 다르면 주의");
  revision.note = "1이면 다름, 0이면 같음.";
  revision.evidence = [{ label: `HEAD ${deploy.head?.slice(0, 12) ?? "미확인"} / 배포 ${deploy.deployed?.slice(0, 12) ?? "미확인"}` }];

  const ci = deploy.ci;
  const age = Date.parse(ci?.createdAt ?? "");
  let ciStatus: UpkeepStatus = "unknown";
  if (ci?.status === "completed") ciStatus = ci.conclusion === "success" ? "ok" : "problem";
  else if (ci && Number.isFinite(age)) ciStatus = now - age > CI_STALE_MS ? "watch" : "ok";
  const ciMetric = metric("ci", "공개 CI 최근 실행", "count", null, null, ciStatus, "최근 실행이 실패하면 문제, 1시간 넘게 진행 중이면 주의");
  if (ci) ciMetric.evidence = [{ label: `${ci.workflowName ?? "CI"}: ${ci.status ?? "?"} / ${ci.conclusion || "진행 중"} · ${ci.headSha?.slice(0, 12) ?? ""}`, timestamp: ci.createdAt }];
  return section("deploy", "배포·CI", [revision, ciMetric], deploy.warnings);
}

function summarize(s: UpkeepSection): string {
  const count = (status: UpkeepStatus) => s.metrics.filter((m) => m.status === status).length;
  const parts = [`문제 ${count("problem")}`, `주의 ${count("watch")}`, `정상 ${count("ok")}`];
  if (count("unknown")) parts.push(`미확인 ${count("unknown")}`);
  const worstMetric = s.status === "problem" || s.status === "watch" ? s.metrics.find((m) => m.status === s.status) : undefined;
  return parts.join(" · ") + (worstMetric ? ` — ${worstMetric.label}` : "");
}

/** 서버 밖으로 나가는 모든 자유 문자열에서 비밀값처럼 보이는 값을 가린다. */
export function maskReport(report: UpkeepReport) {
  for (const s of report.sections) {
    s.summary = maskSecrets(s.summary);
    s.warnings = s.warnings.map(maskSecrets);
    for (const item of s.items ?? []) {
      item.ref.title = maskSecrets(item.ref.title);
      item.ref.text = maskSecrets(item.ref.text);
    }
    for (const m of s.metrics) {
      // id에는 목적·모델 이름이 들어가므로 같이 가린다.
      m.id = maskSecrets(m.id);
      m.label = maskSecrets(m.label);
      if (m.note) m.note = maskSecrets(m.note);
      if (m.handoff) m.handoff = { ...m.handoff, title: maskSecrets(m.handoff.title), text: maskSecrets(m.handoff.text) };
      for (const e of m.evidence) {
        e.label = maskSecrets(e.label);
        if (e.detail) e.detail = maskSecrets(e.detail);
        if (e.sessionPath) e.sessionPath = maskSecrets(e.sessionPath);
      }
    }
  }
}

async function buildReport(): Promise<UpkeepReport> {
  const start = Date.now();
  const agentDir = getAgentDir();
  const repo = findRepo();
  const handoffs = readHandoffs(repo, new Date(start));
  const [scan, deploy] = await Promise.all([scanSessions(getSessionsDir(agentDir), start), inspectDeploy(agentDir, repo)]);
  // Maker 결과(partial)는 세션 스캔에서 나오므로 스캔 뒤에 센다.
  const makerExits = await makerEarlyExits(agentDir, start, handoffs.items, scan.makerResults);
  const sections = [
    bottleneckSection(scan, makerExits.metric, [...scan.warnings, ...(makerExits.warning ? [makerExits.warning] : [])]),
    memorySection(scan, handoffs.items),
    costSection(scan, handoffs.items),
    dueSection(handoffs.items, handoffs.warnings),
    complaintSection(scan),
    deploySection(deploy, start),
  ];
  for (const s of sections) s.summary = summarize(s);
  const report: UpkeepReport = {
    generatedAt: new Date(start).toISOString(),
    window: {
      currentStart: new Date(start - 7 * DAY_MS).toISOString(),
      currentEnd: new Date(start).toISOString(),
      previousStart: new Date(start - 14 * DAY_MS).toISOString(),
    },
    scannedFiles: scan.scannedFiles,
    scanMs: Date.now() - start,
    repoCwd: repo,
    sections,
  };
  maskReport(report);
  return report;
}
