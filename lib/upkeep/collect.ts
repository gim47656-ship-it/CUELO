/**
 * 보수 대시보드 보고서 조립. 세션 스캔·HANDOFF·배포 기록을 읽어 `UpkeepReport`를 만든다.
 * 결과는 5분 동안 globalThis에 두고, 동시에 들어온 요청은 진행 중인 스캔 하나를 함께 기다린다.
 * 「고침 표시」(`./fixes`)가 최근 7일 안에 있는 지표는 표시 뒤 기록만으로 다시 판정한다. 쓰는 파일은 창 밖으로 밀린
 * 고침 표시를 지우는 그 파일 하나뿐이다.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import {
  CACHE_WRITE_FLOOR, CI_STALE_MS, COST_CRITERION, COST_FLOOR_USD, COST_TOP, EARLY_EXIT_REPORT_COUNT, GENERIC_CRITERION,
  FIX_OBSERVE_MS, MIN_SAMPLE, OVERDUE_PROBLEM, OVERDUE_WATCH, SLOW_GAP_MS, STALE_WORKTREE_MS, TRANSLATION_CACHE_BASELINE, TRANSLATION_CACHE_BEFORE, compare, perTurns, worst,
} from "./criteria";
import { inspectDeploy, type DeployState } from "./deploy";
import { activeFixMarks, isFixableMetricId } from "./fixes";
import { readHandoffs } from "./handoff";
import {
  REWRITE_CAUSES, REWRITE_CAUSE_LABELS, maskSecrets, scanSessions,
  type MakerResult, type ScanResult, type SessionCost, type UsageTotal, type WindowCounts,
} from "./sessions";
import { inspectWorkspace, type WorkspaceLeftovers } from "./workspace";
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

/**
 * 고침 표시를 바꾼 뒤의 보고서. 진행 중인 스캔은 바꾸기 전 표시를 읽었을 수 있으므로 그 스캔이 끝난 뒤 새로 만든다.
 * 그사이 다른 요청이 시작한 스캔은 바뀐 표시를 읽으므로 그대로 함께 기다린다.
 */
export async function refreshUpkeepAfterMarkChange(): Promise<UpkeepReport> {
  await cache.pending?.catch(() => undefined);
  return collectUpkeep(true);
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

/** 비용 상위 세션. 시각은 그 세션이 이 키로 처음·마지막 사용한 때라, 고침 표시와 견주어 화면·프롬프트에 「고침 전」이 붙는다. */
function sessionRows(rows: SessionCost[] | undefined): UpkeepEvidence[] {
  return (rows ?? []).map((row) => ({
    label: `세션 비용 $${row.cost.toFixed(2)}`,
    sessionId: row.sessionId,
    sessionPath: row.sessionPath,
    ...(row.lastAt === undefined ? {} : { timestamp: new Date(row.lastAt).toISOString() }),
    ...(row.firstAt === undefined || row.firstAt === row.lastAt ? {} : { since: new Date(row.firstAt).toISOString() }),
  }));
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
  attemptId?: string;
  agentId?: string;
  sessionId?: string;
  chosenModel?: string;
  verdict?: string;
};
const UNKNOWN_MODEL = "모델 미확인";

/** `openai-codex/gpt-6.1-sol:auto` → `gpt-6.1-sol` */
function shortModel(selector: string): string {
  return selector.split("/").at(-1)?.split(":")[0] ?? selector;
}

/**
 * Maker 원장 지표 둘. 조기 종료는 `partial`로 끝난 결과를 모델별로 센다(HANDOFF 「기본 Maker 관찰」).
 * `partial`은 원장에 남지 않아 부모 세션의 결과 알림(`async-result`)에서 읽는다. 짧게 끝난 정상 결과
 * (읽기 전용 일괄 작업 등)가 많아 경과 시간은 판정에 쓰지 않는다. 모델은 원장 발주 행의 chosenModel이며
 * assignmentId는 `<세션>#<호출>#<순번>` 꼴이다. 판정 비율은 시도(attemptId)마다 마지막 판정만 세어 rework·held의 몫을 본다.
 * `period`는 최근 7일 안에서 셀 시각(고침 표시 전·후)과 메모에 적을 그 기간 이름이다.
 */
export async function makerMetrics(
  agentDir: string,
  now: number,
  handoffs: UpkeepDueItem[],
  makerResults: MakerResult[],
  period: { includes: (time: number) => boolean; label: string } = { includes: () => true, label: "최근 7일" },
): Promise<{ exits: UpkeepMetric; verdicts: UpkeepMetric; warning?: string; samples: { exits: number; verdicts: number } }> {
  const m = metric("maker-early-exits", "Maker partial 종료", "count", null, null, "unknown",
    `partial로 끝난 Maker 결과가 한 모델에서 ${EARLY_EXIT_REPORT_COUNT}회 이상이거나, 결과 대비 비율이 직전보다 50% 넘게 늘면 주의`);
  const verdicts = metric("maker-verdicts", "Maker 판정 중 rework·held 비율", "ratio", null, null, "unknown",
    "시도마다 마지막 판정 중 rework·held의 비율이 직전 7일보다 50% 넘게 늘면 주의, 2배 이상이면 문제 (두 기간 모두 판정 20건 이상일 때)");
  m.handoff = handoffs.find((x) => x.ref.title.includes("기본 Maker 관찰"))?.ref;
  let text: string;
  try {
    text = await readFile(join(agentDir, "routing-ledger.jsonl"), "utf8");
  } catch {
    return { exits: m, verdicts, warning: "Maker 원장을 읽을 수 없습니다.", samples: { exits: 0, verdicts: 0 } };
  }
  const windowOf = (ts: string | undefined) => {
    const time = Date.parse(ts ?? "");
    if (!Number.isFinite(time) || time > now || time < now - 14 * DAY_MS) return null;
    if (time < now - 7 * DAY_MS) return 1;
    return period.includes(time) ? 0 : null;
  };
  // 원장은 한 번만 훑고, 줄마다 모양을 확인해 이상한 행 하나가 보고서 전체를 멈추지 않게 한다.
  const modelByName: Record<string, string> = {};
  let parsed = 0;
  const latest = new Map<string, { time: number; verdict: string; evidence: UpkeepEvidence }>();
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
    } else if (r.type === "verdict" && typeof r.verdict === "string" && typeof r.ts === "string") {
      const time = Date.parse(r.ts);
      const attempt = r.attemptId ?? r.assignmentId;
      // 기간 밖 판정은 고르기 전에 뺀다. 고침 전 집계는 표시 뒤에 다시 받은 판정이 아니라 표시 전에 서 있던 판정을 센다.
      if (attempt && Number.isFinite(time) && windowOf(r.ts) !== null && time >= (latest.get(attempt)?.time ?? -Infinity)) {
        latest.set(attempt, { time, verdict: r.verdict, evidence: { label: `${r.agentId ?? r.name ?? "Maker"} ${r.verdict}`, sessionId: r.sessionId, timestamp: r.ts } });
      }
    }
  }
  if (!parsed && text.trim()) return { exits: m, verdicts, warning: "Maker 원장을 해석할 수 없습니다.", samples: { exits: 0, verdicts: 0 } };

  const tally = [{ accepted: 0, rework: 0, held: 0, other: 0 }, { accepted: 0, rework: 0, held: 0, other: 0 }];
  const flaggedCurrent: { time: number; evidence: UpkeepEvidence }[] = [];
  for (const x of latest.values()) {
    const window = windowOf(x.evidence.timestamp);
    if (window === null) continue;
    const kind = x.verdict === "accepted" || x.verdict === "rework" || x.verdict === "held" ? x.verdict : "other";
    tally[window][kind]++;
    if (window === 0 && (kind === "rework" || kind === "held")) flaggedCurrent.push(x);
  }
  const total = (t: (typeof tally)[0]) => t.accepted + t.rework + t.held + t.other;
  const share = (t: (typeof tally)[0]) => (total(t) ? (t.rework + t.held) / total(t) : null);
  verdicts.current = share(tally[0]);
  verdicts.previous = share(tally[1]);
  verdicts.status = compare(verdicts.current, verdicts.previous, total(tally[0]), total(tally[1]));
  const counts = (t: (typeof tally)[0]) => `${t.accepted}/${t.rework}/${t.held}${t.other ? ` (그 밖 ${t.other})` : ""}`;
  verdicts.note = `accepted/rework/held ${period.label} ${counts(tally[0])}, 직전 7일 ${counts(tally[1])}건. held는 검증을 마치지 못한 판정입니다.`;
  verdicts.evidence = flaggedCurrent.sort((x, y) => y.time - x.time).slice(0, 10).map((x) => x.evidence);

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
  m.note = `${period.label} 모델별 partial/결과: ${models.map(([model, x]) => `${model} ${x.early}/${x.total}`).join(", ") || "결과 없음"}. 직전 7일 결과 ${previous.length}건.`;
  m.evidence = earlyCurrent.slice(0, 10).map((x) => ({ ...x.evidence, label: `${x.evidence.label} · ${x.model}` }));
  // 고침 표시 판정이 표시 뒤 표본(Maker 결과·판정 수)을 본다.
  return { exits: m, verdicts, samples: { exits: current.length, verdicts: total(tally[0]) } };
}

/**
 * 두 판정을 한 행에 합칠 때(2026-10-31 사용자 결정) 보조 판정이 주의·문제이고 더 나쁘면 그쪽을 따르고, 어느 쪽이 정했는지
 * 메모에 적는다. 보조 판정의 미확인은 행을 미확인으로 바꾸지 않는다.
 */
function adoptWorse(m: UpkeepMetric, other: UpkeepStatus, part: string) {
  if ((other !== "watch" && other !== "problem") || worst([m.status, other]) === m.status) return;
  m.status = other;
  m.note = `${m.note ?? ""} 상태는 ${part} 기준으로 정했습니다.`.trim();
}

export function bottleneckSection(scan: ScanResult, maker: { exits: UpkeepMetric; verdicts: UpkeepMetric }, warnings: string[]): UpkeepSection {
  const [a, b] = scan.windows;
  const errorRate = metric("tool-error-rate", "도구 오류율", "ratio", a.calls ? a.errors / a.calls : null, b.calls ? b.errors / b.calls : null,
    compare(a.calls ? a.errors / a.calls : null, b.calls ? b.errors / b.calls : null, a.calls, b.calls));
  errorRate.note = `오류 ${a.errors} / ${b.errors}건, 호출 ${a.calls} / ${b.calls}건. 사용자 중단·취소·검색 무일치는 뺐습니다.`;
  errorRate.evidence = Object.entries(a.errorsBySignature).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([label, count]) => ({ label, count }));

  // 느린 대기 행은 도구 결과 뒤 다음 요청까지 걸린 시간의 p90도 같은 기준으로 보고 더 나쁜 쪽을 따른다.
  const slowGaps = perTurnMetric("slow-gaps", `${SLOW_GAP_MS / 1000}초 넘는 대기`, scan, (w) => w.gaps.filter((g) => g > SLOW_GAP_MS).length);
  const p90 = (values: number[]) => (values.length ? [...values].sort((x, y) => x - y)[Math.ceil(values.length * 0.9) - 1] : null);
  const seconds = (ms: number | null) => (ms === null ? "기록 없음" : ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}초`);
  slowGaps.criterion = `${GENERIC_CRITERION}. 도구 결과 뒤 다음 요청까지 걸린 시간의 p90도 같은 기준으로 보고 더 나쁜 쪽을 따릅니다`;
  slowGaps.note = `${slowGaps.note}. 도구 결과 뒤 다음 요청까지 p90 ${seconds(p90(a.gaps))} / ${seconds(p90(b.gaps))}.`;
  adoptWorse(slowGaps, compare(p90(a.gaps), p90(b.gaps), a.gaps.length, b.gaps.length), "p90");

  return section("bottleneck", "작업 병목", [
    errorRate,
    perTurnMetric("dispatch-rejects", "작업 발주 거절", scan, (w) => w.rejects),
    slowGaps,
    perTurnMetric("compactions", "컨텍스트 압축", scan, (w) => w.compactions),
    perTurnMetric("todo-nudges", "할 일 갱신 알림", scan, (w) => w.nudges),
    maker.exits,
    maker.verdicts,
  ], warnings);
}

export function memorySection(scan: ScanResult, handoffs: UpkeepDueItem[]): UpkeepSection {
  const [a, b] = scan.windows;
  const recallRate = metric("recall-per-turn", "요청당 기억 회상 주입", "ratio", a.turns ? a.recalls / a.turns : null, b.turns ? b.recalls / b.turns : null,
    compare(a.turns ? a.recalls / a.turns : null, b.turns ? b.recalls / b.turns : null, a.turns, b.turns, "lower"));
  recallRate.note = `주입 ${a.recalls} / ${b.recalls}건, 그중 빈 회상 ${a.emptyRecalls} / ${b.emptyRecalls}건. 줄어들면 나빠진 것으로 봅니다.`;
  recallRate.handoff = findHandoff(handoffs, "11-02 후속 점검");

  const gatedShare = (w: ScanResult["windows"][0]) => (w.gated + w.recalls ? w.gated / (w.gated + w.recalls) : null);
  const gated = metric("gated-ratio", "게이트에 걸려 빠진 회상 비율", "ratio", gatedShare(a), gatedShare(b),
    compare(gatedShare(a), gatedShare(b), a.gated + a.recalls, b.gated + b.recalls));
  gated.evidence = scan.evidence["gated-ratio"] ?? [];
  gated.note = `게이트 기준 바로 아래(0.05 이내)에서 빠진 회상 ${a.nearGate} / ${b.nearGate}건`;
  if (a.nearGate) gated.evidence = [...(scan.evidence["near-gate"] ?? []), ...gated.evidence].slice(0, 10);

  const recallCalls = perTurnMetric("recall-calls", "명시적 회상 호출", scan, (w) => w.recallCalls);
  recallCalls.status = recallCalls.status === "unknown" ? "unknown" : "ok";
  recallCalls.criterion = "참고용(판정 안 함)";

  const exportFailures = metric("memory-export-failures", "기억 export 실패", "count", a.exportFailures, b.exportFailures,
    a.exportFailures > 0 ? "watch" : "ok", "git_finalize 결과에 기억 export 실패가 한 번이라도 있으면 주의");
  exportFailures.note = "실패해도 커밋은 진행되지만 기억 동기화 파일은 갱신되지 않습니다.";
  exportFailures.evidence = scan.evidence["memory-export-failures"] ?? [];

  return section("memory", "기억 회상", [recallRate, gated, recallCalls, exportFailures]);
}

const usd = (value: number) => `$${value.toFixed(2)}`;

/**
 * 비용 행(2026-10-30 사용자 결정): 요청 100건당 금액으로 비교하고, 두 기간 모두 그 키의 호출이 MIN_SAMPLE 이상일 때만
 * 판정한다. 원 금액·호출 수와 그중 OAuth(구독) 사용분은 판정에 쓰지 않고 메모로만 보여 준다.
 */
function costMetric(id: string, label: string, current: UsageTotal | undefined, previous: UsageTotal | undefined, turns: [number, number]): UpkeepMetric {
  const per = (u: UsageTotal | undefined, t: number) => (u?.missingCost || !t ? null : perTurns(u?.cost ?? 0, t));
  const m = metric(id, `${label} (요청 100건당)`, "usd", per(current, turns[0]), per(previous, turns[1]), "unknown", COST_CRITERION);
  const notes = [`원 금액 ${usd(current?.cost ?? 0)} / ${usd(previous?.cost ?? 0)}, 호출 ${current?.calls ?? 0} / ${previous?.calls ?? 0}건`];
  if (current?.subscription) notes.push(`최근 7일 중 OAuth(구독) 사용분 ${usd(current.subscription)}는 실제 청구액이 아닙니다.`);
  if (current?.unknownAuth) notes.push(`인증 종류가 기록되지 않은 Anthropic 사용분 ${usd(current.unknownAuth)}는 구독인지 알 수 없습니다.`);
  const raw = Math.max(current?.cost ?? 0, previous?.cost ?? 0);
  if (m.current === null || m.previous === null) {
    notes.push(!turns[0] || !turns[1] ? "사용자 요청 기록이 없는 기간이 있습니다." : "일부 사용량 기록에 비용이 없습니다.");
  } else if (raw < COST_FLOOR_USD) {
    m.status = "ok";
    notes.push(`두 기간 모두 $${COST_FLOOR_USD} 미만이라 판정하지 않습니다.`);
  } else {
    m.status = compare(m.current, m.previous, current?.calls ?? 0, previous?.calls ?? 0);
    if (!previous) notes.push("직전 7일 기록 없음");
    if (m.status === "unknown") notes.push(`호출이 ${MIN_SAMPLE}건 미만인 기간이 있어 판정하지 않습니다.`);
  }
  m.note = notes.join(" ");
  return m;
}

/** 캐시 쓰기 비율 판정: 기준(10%) 미만이면 정상, 이상이면 직전과 비교하고 직전 기록이 없으면 주의. */
function cacheWriteShare(current: UsageTotal | undefined, previous: UsageTotal | undefined): { current: number | null; previous: number | null; status: UpkeepStatus } {
  const share = (u: UsageTotal | undefined) => (!u || u.missingCache || !u.input ? null : u.write / u.input);
  const now = share(current), before = share(previous);
  const status = now === null ? "unknown"
    : now < CACHE_WRITE_FLOOR ? "ok"
    : before === null ? "watch"
    : compare(now, before, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  return { current: now, previous: before, status };
}

const percent = (value: number | null) => (value === null ? "기록 없음" : `${(value * 100).toFixed(1)}%`);

/** `folded`: 직전 7일 호출이 없고 최근 호출도 MIN_SAMPLE 미만인 새 행. 따로 보이지 않고 「그 밖의」 합계로 간다. */
type CostRow = { metric: UpkeepMetric; label: string; cost: number; folded: boolean };

/**
 * 본 요청 캐시 다시 쓰기(2026-10-31 사용자 결정). 값과 판정은 피할 수 있었던 원인만 센 금액이고, 세션 첫 요청은 늘 캐시를
 * 새로 쓰므로 원인별 내역에만 남긴다.
 */
function cacheRewriteMetric(scan: ScanResult): UpkeepMetric {
  const [a, b] = scan.windows;
  const avoidable = (w: WindowCounts) => REWRITE_CAUSES.filter((c) => c !== "first").reduce((n, c) => ({ count: n.count + w.rewrites[c].count, cost: n.cost + w.rewrites[c].cost }), { count: 0, cost: 0 });
  const now = avoidable(a), before = avoidable(b);
  // 피할 수 있었던 다시 쓰기에 캐시 쓰기 비용이 빠진 기간은 $0으로 보지 않고 미측정으로 둔다(판정에서 빠지는 세션 첫 요청은 상관없다).
  const per = (cost: number, w: WindowCounts) => (w.missingRewriteCost ? null : perTurns(cost, w.turns));
  const m = metric("session-cache-rewrite", "본 요청 캐시 다시 쓰기 (요청 100건당)", "usd", per(now.cost, a), per(before.cost, b), "unknown",
    `세션 첫 요청을 뺀 다시 쓰기 금액이 요청 100건당 직전 7일보다 50% 넘게 늘면 주의, 2배 이상이면 문제 (두 기간 모두 요청 ${MIN_SAMPLE}건 이상이고 큰 쪽 원 금액이 $${COST_FLOOR_USD} 이상일 때)`);
  if (m.current !== null && m.previous !== null) {
    m.status = Math.max(now.cost, before.cost) < COST_FLOOR_USD ? "ok" : compare(m.current, m.previous, a.turns, b.turns);
  }
  const share = (cost: number, w: WindowCounts) => (w.cacheWriteCost ? cost / w.cacheWriteCost : null);
  const causes = REWRITE_CAUSES.filter((c) => a.rewrites[c].count).map((c) => `${REWRITE_CAUSE_LABELS[c]} ${a.rewrites[c].count}건 ${usd(a.rewrites[c].cost)}`);
  m.note = [
    `원 금액 ${usd(now.cost)} / ${usd(before.cost)} (${now.count} / ${before.count}건), 본 요청 캐시 쓰기 비용 중 ${percent(share(now.cost, a))} / ${percent(share(before.cost, b))}.`,
    causes.length ? `원인별: ${causes.join(", ")}.` : "",
    a.missingRewriteCost || b.missingRewriteCost ? "캐시 쓰기 비용이 기록되지 않은 다시 쓰기가 있는 기간은 판정하지 않습니다." : "",
    "세션 첫 요청은 피할 수 없어 판정에서 뺍니다.",
  ].filter(Boolean).join(" ");
  m.evidence = scan.evidence["session-cache-rewrite"] ?? [];
  return m;
}

/** API 키로 청구된 사용(credentialKind `api-key`). 구독 대신 실제 돈이 나간 호출이라 한 건이라도 있으면 주의. */
function billedApiKeyMetric(scan: ScanResult): UpkeepMetric {
  const [a, b] = scan.windows;
  const m = metric("billed-api-key", "API 키 청구 금액", "usd", a.apiKeyCost, b.apiKeyCost, a.apiKeyCalls > 0 ? "watch" : "ok",
    "API 키로 청구된 호출이 한 건이라도 있으면 주의");
  m.note = `호출 ${a.apiKeyCalls} / ${b.apiKeyCalls}건. 인증 종류는 Anthropic 호출만 기록돼 다른 제공자의 API 키 사용은 여기 잡히지 않습니다.`;
  m.evidence = sessionRows(scan.topSessions["api-key"]);
  return m;
}

/**
 * 비용 섹션 후보 전부(상위 선택·접기 전). 고침 표시도 이 목록에서 행을 찾는다. 목적·모델 행은 금액과 캐시 쓰기 비율을
 * 한 행에서 판정한다(원 금액이 기준 이상일 때만 비율도 보고 더 나쁜 쪽을 따른다). `keyWindows`는 행을 만들 목적·모델
 * 키를 모을 기간들이다. 표시 뒤 묶음처럼 일부 기간만 볼 때도 최근 7일의 키를 넘겨, 표시 뒤 사용이 없는 키도 행이 생기게 한다.
 */
function costCandidates(scan: ScanResult, handoffs: UpkeepDueItem[], keyWindows: readonly WindowCounts[] = scan.windows): { fixed: UpkeepMetric[]; rows: CostRow[] } {
  const [a, b] = scan.windows;
  const perTurn = metric("cost-per-turn", "요청당 추정 비용", "usd", a.missingCost || !a.turns ? null : a.cost / a.turns,
    b.missingCost || !b.turns ? null : b.cost / b.turns, "unknown");
  perTurn.status = compare(perTurn.current, perTurn.previous, a.turns, b.turns);
  perTurn.note = "토큰 단가 환산 추정치입니다. OAuth 구독 사용분은 실제 청구액이 아닙니다.";
  perTurn.evidence = sessionRows(scan.topSessions.total);

  const rows: CostRow[] = [];
  const add = (id: string, label: string, current: UsageTotal | undefined, previous: UsageTotal | undefined, evidence: SessionCost[] | undefined) => {
    const m = costMetric(id, label, current, previous, [a.turns, b.turns]);
    m.criterion = `${COST_CRITERION}. 원 금액이 $${COST_FLOOR_USD} 이상이면 캐시 쓰기 비율(${CACHE_WRITE_FLOOR * 100}% 이상이면서 직전보다 50% 넘게 늘면 주의, 2배 이상이면 문제)도 보고 더 나쁜 쪽을 따릅니다`;
    m.evidence = sessionRows(evidence);
    const cache = cacheWriteShare(current, previous);
    const extra: string[] = [];
    if (cache.current !== null) extra.push(`캐시 쓰기 비율 ${percent(cache.current)} / ${percent(cache.previous)}.`);
    const providers = [...new Set([...(current?.providers ?? []), ...(previous?.providers ?? [])])];
    if (providers.length > 1) extra.push(`제공자 ${providers.join(", ")} 합산.`);
    // 통역 캐시 쓰기 비율은 HANDOFF 「리뷰 게이트 다듬기 후속」의 관찰 대상이라 그 항목과 기준선을 붙인다.
    if (id === "purpose:user-input-translation") {
      m.handoff = findHandoff(handoffs, "리뷰 게이트 다듬기 후속");
      extra.push(`캐시 쓰기 비율 참고 수준: 수정 전 ${TRANSLATION_CACHE_BEFORE * 100}%, 평소 ${TRANSLATION_CACHE_BASELINE * 100}%.`);
    }
    m.note = [m.note, ...extra].join(" ");
    if (Math.max(current?.cost ?? 0, previous?.cost ?? 0) >= COST_FLOOR_USD) adoptWorse(m, cache.status, "캐시 쓰기 비율");
    rows.push({ metric: m, label, cost: current?.cost ?? 0, folded: !previous?.calls && (current?.calls ?? 0) < MIN_SAMPLE });
  };
  for (const key of new Set(keyWindows.flatMap((w) => Object.keys(w.purposes)))) {
    add(`purpose:${key}`, `보조 호출 ${key}`, a.purposes[key], b.purposes[key], scan.topSessions[`purpose:${key}`]);
  }
  for (const key of new Set(keyWindows.flatMap((w) => Object.keys(w.models)))) {
    add(`model:${key}`, `모델 ${key}`, a.models[key], b.models[key], scan.topSessions[`model:${key}`]);
  }
  return { fixed: [perTurn, cacheRewriteMetric(scan), billedApiKeyMetric(scan)], rows };
}

export function costSection(scan: ScanResult, handoffs: UpkeepDueItem[]): UpkeepSection {
  const { fixed, rows } = costCandidates(scan, handoffs);
  rows.sort((x, y) => y.cost - x.cost);

  const shown = rows.filter((r) => !r.folded);
  const top = shown.slice(0, COST_TOP);
  const rest = [...shown.slice(COST_TOP), ...rows.filter((r) => r.folded)];
  const metrics = [...fixed, ...top.map((r) => r.metric)];
  if (rest.length) {
    const sum = (pick: (m: UpkeepMetric) => number | null) => (rest.some((r) => pick(r.metric) === null) ? null : rest.reduce((n, r) => n + (pick(r.metric) ?? 0), 0));
    const other = metric("cost-other", `그 밖의 ${rest.length}개 합계 (요청 100건당)`, "usd", sum((m) => m.current), sum((m) => m.previous), "ok");
    other.criterion = `참고용(판정 안 함). 상위 ${COST_TOP}개 밖의 행과, 직전 7일 기록이 없고 호출이 ${MIN_SAMPLE}건 미만인 새 행을 묶습니다`;
    other.note = rest.map((r) => r.label).join(", ");
    metrics.push(other);
  }
  return section("cost", "불필요한 비용", metrics);
}

function overdueMetric(items: UpkeepDueItem[], warnings: string[]): UpkeepMetric {
  const overdue = items.filter((x) => x.overdue);
  const m = metric("overdue", "기한 지난 점검", "count", warnings.length && !items.length ? null : overdue.length, null,
    warnings.length && !items.length ? "unknown" : overdue.length >= OVERDUE_PROBLEM ? "problem" : overdue.length >= OVERDUE_WATCH ? "watch" : "ok",
    `기한 지난 항목 ${OVERDUE_WATCH}건 이상 주의, ${OVERDUE_PROBLEM}건 이상 문제`);
  m.evidence = overdue.slice(0, 10).map((item) => ({ label: `${item.ref.title} · ${item.dueDate}`, detail: item.ref.path }));
  return m;
}

function complaintSection(scan: ScanResult): UpkeepSection {
  const m = perTurnMetric("repeat-complaints", "다시 지적하는 표현", scan, (w) => w.complaints);
  m.note = `${m.note}. 정해 둔 표현 목록에 없는 지적은 놓칩니다.`;
  return section("complaints", "사용자 지적 반복", [m]);
}

/** 배포 리비전과 공개 CI 행. */
export function deployMetrics(deploy: DeployState, now: number): UpkeepMetric[] {
  // 비교하지 못하면(pending null) 미확인이다. 대개 개발 사본이 다른 곳에서 게시·배포한 커밋을 아직 받지 않은 경우라, 「배포 필요」로
  // 두면 사실과 반대로 말한다(10-31 사무실: 배포 7139168d가 개발 사본 HEAD de202b74보다 앞섰다).
  const differs = deploy.head && deploy.deployed
    ? deploy.head.toLowerCase().startsWith(deploy.deployed.toLowerCase()) ? false : deploy.pending === null ? null : deploy.pending.length > 0
    : null;
  const revision = metric("revision-diff", "배포 리비전과 저장소 HEAD", "count", differs === null ? null : Number(differs), null,
    differs === null ? "unknown" : differs ? "watch" : "ok", "배포한 리비전 뒤 HEAD에 기록(doc/, HANDOFF.md, 기억 동기화 파일) 밖의 변경이 있으면 주의");
  revision.note = "1이면 배포가 필요한 변경이 남음, 0이면 같거나 기록만 다름.";
  const pending = deploy.pending?.length ? ` · 배포 필요 ${deploy.pending.length}개: ${deploy.pending.slice(0, 5).join(", ")}${deploy.pending.length > 5 ? " 외" : ""}` : "";
  const records = deploy.records ? ` · 기록만 다름 ${deploy.records}개` : "";
  revision.evidence = [{ label: `HEAD ${deploy.head?.slice(0, 12) ?? "미확인"} / 배포 ${deploy.deployed?.slice(0, 12) ?? "미확인"}${pending}${records}` }];

  const ci = deploy.ci;
  const age = Date.parse(ci?.createdAt ?? "");
  let ciStatus: UpkeepStatus = "unknown";
  if (ci?.status === "completed") ciStatus = ci.conclusion === "success" ? "ok" : "problem";
  else if (ci && Number.isFinite(age)) ciStatus = now - age > CI_STALE_MS ? "watch" : "ok";
  const ciMetric = metric("ci", "공개 CI 최근 실행", "count", null, null, ciStatus, "최근 실행이 실패하면 문제, 1시간 넘게 진행 중이면 주의");
  if (ci) ciMetric.evidence = [{ label: `${ci.workflowName ?? "CI"}: ${ci.status ?? "?"} / ${ci.conclusion || "진행 중"} · ${ci.headSha?.slice(0, 12) ?? ""}`, timestamp: ci.createdAt }];
  return [revision, ciMetric];
}

/** 남은 작업 공간: 지금 상태라 직전 값이 없고 고침 표시도 받지 않는다. 하나라도 있으면 주의. */
export function workspaceMetric(w: WorkspaceLeftovers): UpkeepMetric {
  const parts = [w.worktrees, w.branches, w.banks];
  const total = parts.reduce((n, p) => n + (p?.length ?? 0), 0);
  const known = parts.every((p) => p !== null);
  const m = metric("workspace-leftovers", "남은 작업 공간", "count", known || total ? total : null, null, total ? "watch" : known ? "ok" : "unknown",
    `세션 기록이 ${STALE_WORKTREE_MS / DAY_MS}일 넘게 없는 worktree, origin/main에 병합된 원격 wt/* 브랜치, wt- 기억 bank가 하나라도 있으면 주의`);
  const count = (p: unknown[] | null) => (p === null ? "미확인" : `${p.length}개`);
  m.note = `오래된 worktree ${count(w.worktrees)}, 병합된 원격 브랜치 ${count(w.branches)}, worktree 기억 bank ${count(w.banks)}. 원격 브랜치는 마지막으로 받아 둔 origin 기준입니다.`;
  m.evidence = [
    ...(w.worktrees ?? []).map((x) => ({
      label: `worktree ${x.branch ?? x.path}${x.lastActive === null ? " · 14일 안 세션 기록 없음" : ""}`,
      detail: x.path,
      ...(x.lastActive === null ? {} : { timestamp: new Date(x.lastActive).toISOString() }),
    })),
    ...(w.branches ?? []).map((name) => ({ label: `원격 브랜치 ${name} · origin/main에 병합됨` })),
    ...(w.banks ?? []).map((name) => ({ label: `기억 bank ${name}` })),
  ].slice(0, 10);
  return m;
}

/** 운영(2026-10-31 사용자 결정): 점검 기한·배포·CI·남은 작업 공간. 모두 지금 상태를 보는 값이다. */
export function opsSection(items: UpkeepDueItem[], dueWarnings: string[], deploy: DeployState, workspace: WorkspaceLeftovers, now: number): UpkeepSection {
  return section("ops", "운영", [overdueMetric(items, dueWarnings), ...deployMetrics(deploy, now), workspaceMetric(workspace)],
    [...dueWarnings, ...deploy.warnings, ...workspace.warnings], items);
}

/** 고침 표시를 받을 수 있는 지표가 있는 섹션(세션 기록에서 나온 값) */
const SESSION_SECTIONS: Record<string, true> = { bottleneck: true, memory: true, cost: true, complaints: true };

/**
 * 같은 빌더로 만든 세션 지표 전부를 id로 찾는 표. 비용 행은 상위 선택·접기 전 후보에서 찾는다.
 * Maker 원장 지표는 세션 스캔이 아니라 원장과 Maker 결과 목록으로 다시 세므로(`makerMetrics`) 빈 자리만 채운다.
 */
function sessionMetricsById(scan: ScanResult, handoffs: UpkeepDueItem[], keyWindows: readonly WindowCounts[]): Map<string, UpkeepMetric> {
  const { fixed, rows } = costCandidates(scan, handoffs, keyWindows);
  const placeholder = (id: string) => metric(id, "", "count", null, null, "unknown");
  const metrics = [
    ...bottleneckSection(scan, { exits: placeholder("maker-early-exits"), verdicts: placeholder("maker-verdicts") }, []).metrics,
    ...memorySection(scan, handoffs).metrics,
    ...complaintSection(scan).metrics,
    ...fixed,
    ...rows.map((row) => row.metric),
  ];
  return new Map(metrics.map((m) => [m.id, m]));
}

export type FixContext = { agentDir: string; now: number; handoffs: UpkeepDueItem[] };

/** Maker 원장에서 나오는 지표 id → `makerMetrics` 결과 키 */
const LEDGER_METRICS: Record<string, "exits" | "verdicts"> = { "maker-early-exits": "exits", "maker-verdicts": "verdicts" };

/** 고침 표시한 세션 지표가 판정에 쓰는 분모. 표시 뒤 기간에 이것이 MIN_SAMPLE에 못 미치면 판정하지 않고 관찰 중으로 둔다. */
const FIX_DENOMINATORS: Record<string, [label: string, size: (w: WindowCounts) => number]> = {
  "tool-error-rate": ["도구 호출", (w) => w.calls],
  "dispatch-rejects": ["사용자 요청", (w) => w.turns],
  "slow-gaps": ["사용자 요청", (w) => w.turns],
  compactions: ["사용자 요청", (w) => w.turns],
  "todo-nudges": ["사용자 요청", (w) => w.turns],
  "recall-per-turn": ["사용자 요청", (w) => w.turns],
  "gated-ratio": ["회상", (w) => w.gated + w.recalls],
  "cost-per-turn": ["사용자 요청", (w) => w.turns],
  "session-cache-rewrite": ["사용자 요청", (w) => w.turns],
  "repeat-complaints": ["사용자 요청", (w) => w.turns],
};

/** 값이 기간 합계(건수·금액)인 지표. 고침 전·뒤를 하루당으로 맞춰 견준다. */
const WINDOW_TOTAL_METRICS: Record<string, true> = { "maker-early-exits": true, "memory-export-failures": true, "billed-api-key": true };

/** 표시 뒤 표본 크기와 최소값. 분모가 없는 행(기억 export 실패·API 키 청구)은 표시 뒤 경과 시간을 본다. */
function fixSample(id: string, after: WindowCounts | undefined, ledgerSize: number | undefined, elapsedMs: number) {
  if (ledgerSize !== undefined) return { label: id === "maker-verdicts" ? "판정" : "Maker 결과", size: ledgerSize, min: MIN_SAMPLE, unit: "건" };
  const rule: [string, (w: WindowCounts) => number] | undefined = id.startsWith("purpose:") ? ["호출", (w) => w.purposes[id.slice("purpose:".length)]?.calls ?? 0]
    : id.startsWith("model:") ? ["호출", (w) => w.models[id.slice("model:".length)]?.calls ?? 0]
    : Object.hasOwn(FIX_DENOMINATORS, id) ? FIX_DENOMINATORS[id] : undefined;
  if (rule) return { label: rule[0], size: after ? rule[1](after) : 0, min: MIN_SAMPLE, unit: "건" };
  return { label: "경과", size: Math.floor(elapsedMs / 3_600_000), min: FIX_OBSERVE_MS / 3_600_000, unit: "시간" };
}

/**
 * 고침 표시(2026-10-31 사용자 결정)를 보고서에 반영한다. `marks`는 지표 id → 표시 시각(ms)이며 최근 7일 안의 것만 온다.
 * 표시한 지표는 표시 이후 기록과 직전 7일을 같은 빌더·같은 기준으로 다시 판정하고, 표시 전 값은 `fix.before`에 둔다.
 * 이름·HANDOFF 항목·근거 사례는 최근 7일 그대로 두어 고치기 전 사례도 계속 열 수 있다. 표시한 비용 행이 상위 선택이나
 * 접기에서 빠졌으면 다시 넣어 표시가 화면에서 사라지지 않게 한다.
 */
export async function applyFixMarks(sections: UpkeepSection[], scan: ScanResult, marks: Record<string, number>, ctx: FixContext) {
  const markOf = (id: string): number | undefined => marks[id] ?? marks[maskSecrets(id)];
  const views = new Map<string, Map<string, UpkeepMetric>>();
  const ledgerSamples = new Map<string, number>();
  const split = async (id: string, at: number, part: "before" | "after"): Promise<UpkeepMetric | undefined> => {
    const ledger = Object.hasOwn(LEDGER_METRICS, id) ? LEDGER_METRICS[id] : undefined;
    if (ledger) {
      const period = part === "after"
        ? { includes: (time: number) => time >= at, label: "고침 뒤" }
        : { includes: (time: number) => time < at, label: "고침 전" };
      const result = await makerMetrics(ctx.agentDir, ctx.now, ctx.handoffs, scan.makerResults, period);
      if (part === "after") ledgerSamples.set(id, result.samples[ledger]);
      return result[ledger];
    }
    const key = `${at}:${part}`;
    let view = views.get(key);
    if (!view) {
      const counts = scan.splits.get(at);
      view = counts ? sessionMetricsById({ ...scan, windows: [counts[part], scan.windows[1]] }, ctx.handoffs, scan.windows) : new Map();
      views.set(key, view);
    }
    return view.get(id);
  };

  for (const s of sections) {
    if (!Object.hasOwn(SESSION_SECTIONS, s.id)) continue;
    if (s.id === "cost") {
      const shown = new Set(s.metrics.map((m) => m.id));
      const { fixed, rows } = costCandidates(scan, ctx.handoffs);
      const hidden = [...fixed, ...rows.map((row) => row.metric)]
        .filter((m) => !shown.has(m.id) && markOf(m.id) !== undefined);
      const other = s.metrics.findIndex((m) => m.id === "cost-other");
      s.metrics.splice(other < 0 ? s.metrics.length : other, 0, ...hidden);
    }
    for (const [index, m] of s.metrics.entries()) {
      if (!isFixableMetricId(m.id)) continue;
      m.fixable = true;
      const at = markOf(m.id);
      if (at === undefined) continue;
      const [after, before] = await Promise.all([split(m.id, at, "after"), split(m.id, at, "before")]);
      if (!after) continue;
      // 표시 뒤 기간이 그 행의 최소 표본에 못 미치면 고친 것이 아직 확인되지 않았으므로 정상으로 두지 않는다.
      const sample = fixSample(m.id, scan.splits.get(at)?.after, ledgerSamples.get(m.id), ctx.now - at);
      const observing = sample.size < sample.min;
      s.metrics[index] = {
        ...after,
        id: m.id,
        label: m.label,
        handoff: m.handoff,
        evidence: m.evidence,
        fixable: true,
        status: observing ? "unknown" : after.status,
        note: [observing ? `고침 뒤 관찰 중 (${sample.label} ${sample.size}/최소 ${sample.min}${sample.unit}).` : "", after.note ?? ""].filter(Boolean).join(" ") || undefined,
        fix: {
          markedAt: new Date(at).toISOString(),
          before: before?.current ?? null,
          beforeMs: at - (ctx.now - 7 * DAY_MS),
          afterMs: ctx.now - at,
          perDay: Object.hasOwn(WINDOW_TOTAL_METRICS, m.id),
          observing,
        },
      };
    }
    s.status = worst(s.metrics.map((m) => m.status));
  }
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
  const marks = activeFixMarks(agentDir, start - 7 * DAY_MS);
  const [scan, deploy] = await Promise.all([
    scanSessions(getSessionsDir(agentDir), start, Object.values(marks)),
    inspectDeploy(agentDir, repo),
  ]);
  // Maker 결과(partial)와 세션 cwd별 마지막 기록은 세션 스캔에서 나오므로 스캔 뒤에 센다.
  const [maker, workspace] = await Promise.all([
    makerMetrics(agentDir, start, handoffs.items, scan.makerResults),
    inspectWorkspace(repo, agentDir, scan.warnings.length ? null : scan.cwdActivity, start),
  ]);
  const sections = [
    bottleneckSection(scan, maker, [...scan.warnings, ...(maker.warning ? [maker.warning] : [])]),
    memorySection(scan, handoffs.items),
    costSection(scan, handoffs.items),
    complaintSection(scan),
    opsSection(handoffs.items, handoffs.warnings, deploy, workspace, start),
  ];
  await applyFixMarks(sections, scan, marks, { agentDir, now: start, handoffs: handoffs.items });
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
