"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { copyText } from "@/lib/clipboard";
import {
  UPKEEP_STATUS_LABELS,
  buildDuePrompt,
  buildFullPrompt,
  buildMetricPrompt,
  buildSectionPrompt,
  describeDue,
  fixComparison,
  fixTag,
  formatUpkeepChange,
  formatUpkeepValue,
  hasFlaggedItems,
  isFlagged,
  kstDateTime,
  sortDueItems,
  windowRanges,
} from "@/lib/upkeep/prompt";
import type { UpkeepDueItem, UpkeepMetric, UpkeepReport, UpkeepSection, UpkeepStatus, UpkeepVerdict } from "@/lib/upkeep/types";
import { UPKEEP_TEXT as T } from "./text";

// 섹션 안에서는 섹션 판정을 정하는 점검 안 한 문제·주의·미확인 행을 먼저 보여 준다. 점검 완료 표시한 행은 섹션 판정에서
// 빠지므로 그 뒤, 정상 행 앞에 둔다. 같은 자리끼리는 수집기 순서(비용은 큰 순)를 지킨다.
const STATUS_RANK: Record<UpkeepStatus, number> = { problem: 0, watch: 1, unknown: 2, ok: 4 };
const rowRank = (metric: UpkeepMetric) => (metric.check && isFlagged(metric.status) ? 3 : STATUS_RANK[metric.status]);

type MarkKind = "fix" | "check";

/**
 * 보수 대시보드. 사이드바 「보수」나 `/?view=upkeep`로 열리고 화면 전체를 덮는다. 뒤의 작업 화면은
 * 마운트된 채 남아 선택 세션·초안·실행 중인 작업이 그대로다. 「작업 프롬프트로 새 세션」은 프롬프트를
 * 만들어 `onStartSession`에 넘길 뿐 보내지 않는다(사용자가 입력창에서 직접 보낸다).
 */

interface Props {
  open: boolean;
  onClose: () => void;
  /** 화면을 닫고 새 세션 입력창에 프롬프트를 채운다. cwd가 null이면 부모가 복사·안내로 대신한다. */
  onStartSession: (prompt: string, cwd: string | null) => void;
}

type LoadState =
  | { phase: "idle" | "loading" }
  | { phase: "error"; error: string }
  | { phase: "ready" };

const FOCUSABLES = "a[href], button:not([disabled]), summary, [tabindex]:not([tabindex='-1'])";

function StatusLabel({ status, text }: { status: string; text: string }) {
  return <span className="upkeep-status" data-status={status}>{text}</span>;
}

/** 짧은 괄호 묶음(예: 「(양쪽 표본 20개 이상)」)이 좁은 화면에서 중간에 끊기지 않게 한 덩어리로 둔다. 긴 괄호는 그대로 줄바꿈된다. */
function keepParens(text: string): ReactNode {
  return text.split(/(\([^()]{1,24}\))/).map((part, index) => (
    index % 2 ? <span key={index} className="upkeep-nowrap">{part}</span> : part
  ));
}

/** 섹션 지표들이 가장 많이 쓰는 기준. 섹션 머리에 한 번 적고, 행에는 이와 다를 때만 적는다. */
function commonCriterion(metrics: readonly UpkeepMetric[]): string | null {
  const counts = new Map<string, number>();
  for (const metric of metrics) counts.set(metric.criterion, (counts.get(metric.criterion) ?? 0) + 1);
  let best: string | null = null;
  for (const [criterion, count] of counts) if (best === null || count > (counts.get(best) ?? 0)) best = criterion;
  return best;
}

/** 「…새 세션」과 「복사」. 고른 지표의 「작업 프롬프트로 새 세션」만 채운 주 버튼이고 전체·섹션은 보조 모양이다. `children`은 같은 줄 뒤에 붙는 행 동작이다. */
function PromptActions({ build, onStart, target, label = T.startSession, primary = false, children }: {
  build: () => string;
  onStart: (prompt: string) => void;
  /** 화면 낭독기에 붙여 읽을 대상 이름 */
  target: string;
  label?: string;
  primary?: boolean;
  children?: ReactNode;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (copyState === "idle") return;
    const timer = window.setTimeout(() => setCopyState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [copyState]);
  const copyLabel = copyState === "copied" ? T.copied : copyState === "failed" ? T.copyFailed : T.copy;
  return (
    <div className="upkeep-actions">
      <button
        type="button"
        className="upkeep-button"
        data-variant={primary ? "primary" : undefined}
        aria-label={T.actionFor(label, target)}
        onClick={() => onStart(build())}
      >
        {label}
      </button>
      <button
        type="button"
        className="upkeep-button"
        data-variant="ghost"
        aria-label={T.actionFor(copyLabel, target)}
        onClick={() => {
          copyText(build()).then(() => setCopyState("copied"), () => setCopyState("failed"));
        }}
      >
        <span aria-live="polite">{copyLabel}</span>
      </button>
      {children}
    </div>
  );
}

/** 섹션 표의 한 줄. 지표 이름 단추가 이 지표를 오른쪽 칸(좁으면 표 아래)에 펼친다. */
function MetricTableRow({ metric, selected, onSelect }: { metric: UpkeepMetric; selected: boolean; onSelect: () => void }) {
  const { fix, check } = metric;
  const compared = fix ? fixComparison(metric, fix) : null;
  return (
    <tr className="upkeep-row" data-status={metric.status} data-metric-row={metric.id} aria-selected={selected}>
      <td className="upkeep-cell-status" data-label={T.colStatus}><StatusLabel status={metric.status} text={UPKEEP_STATUS_LABELS[metric.status]} /></td>
      <th scope="row" className="upkeep-cell-label">
        <button type="button" className="upkeep-row-select" aria-pressed={selected} onClick={onSelect}>
          {metric.label}
        </button>
        {fix ? <span className="upkeep-cell-sub">{T.fixedSince(kstDateTime(fix.markedAt).slice(5))}</span> : null}
      </th>
      {compared ? (
        <>
          <td className="upkeep-cell-num" data-label={T.afterFix}>{compared.after}<span className="upkeep-cell-unit">{T.afterFix}</span></td>
          <td className="upkeep-cell-num" data-label={T.beforeFix}>{compared.before}<span className="upkeep-cell-unit">{T.beforeFix}</span></td>
          <td className="upkeep-cell-num" data-label={T.changeSinceFix}>{compared.change ?? "—"}</td>
        </>
      ) : (
        <>
          <td className="upkeep-cell-num" data-label={T.current}>{formatUpkeepValue(metric.unit, metric.current)}</td>
          <td className="upkeep-cell-num" data-label={T.previous}>{formatUpkeepValue(metric.unit, metric.previous)}</td>
          <td className="upkeep-cell-num" data-label={T.change}>{formatUpkeepChange(metric) ?? "—"}</td>
        </>
      )}
      <td className="upkeep-cell-check" data-label={T.colCheck}>
        {check ? <span className="upkeep-checked">{T.checkedAt(kstDateTime(check.checkedAt).slice(5))}</span> : null}
      </td>
      <td className="upkeep-cell-num" data-label={T.colEvidence}>{metric.evidence.length ? T.evidenceCount(metric.evidence.length) : "—"}</td>
    </tr>
  );
}

/** 고른 지표의 자세한 값·사유·근거와 행 동작. 오른쪽 칸을 채운다. */
function MetricDetail({ report, section, metric, onStart, onMark, busy }: {
  report: UpkeepReport;
  section: UpkeepSection;
  metric: UpkeepMetric;
  onStart: (prompt: string) => void;
  /** 고침·점검 표시를 남기거나(`mark` true) 지운다. 섹션 id는 행이 사라졌을 때 초점을 둘 곳이다. */
  onMark: (kind: MarkKind, metricId: string, mark: boolean, sectionId: UpkeepSection["id"], verdict?: UpkeepVerdict) => void;
  busy: boolean;
}) {
  const { fix, check } = metric;
  // 표시는 사건 시각으로 나눌 수 있는 주의·문제 행에만 새로 남기고, 이미 남긴 행은 판정과 관계없이 취소할 수 있다.
  const fixAction = fix || (metric.fixable && (metric.status === "watch" || metric.status === "problem")) ? (
    <button
      type="button"
      className="upkeep-button"
      data-fix-metric={metric.id}
      aria-label={T.fixActionFor(fix ? T.fixClear : T.fixMark, metric.label)}
      disabled={busy}
      onClick={() => onMark("fix", metric.id, !fix, section.id)}
    >
      {fix ? T.fixClear : T.fixMark}
    </button>
  ) : null;
  // 점검 표시는 판정을 바꾸지 않으므로 고칠 수 없는 행을 포함한 주의·문제 행 어디에나 남길 수 있다.
  const checkAction = check || metric.status === "watch" || metric.status === "problem" ? (
    <button
      type="button"
      className="upkeep-button"
      data-check-metric={metric.id}
      aria-label={T.fixActionFor(check ? T.checkClear : T.checkMark, metric.label)}
      disabled={busy}
      onClick={() => onMark("check", metric.id, !check, section.id)}
    >
      {check ? T.checkClear : T.checkMark}
    </button>
  ) : null;
  const markActions = fixAction || checkAction ? <>{fixAction}{checkAction}</> : null;
  const change = formatUpkeepChange(metric);
  // 고침 표시한 행은 길이가 다른 고침 뒤 값을 직전 7일과 바로 견주지 않고, 고침 전 값과 같은 단위로 견준다.
  const compared = fix ? fixComparison(metric, fix) : null;
  return (
    <div className="upkeep-detail" data-metric-detail={metric.id}>
      <h3 className="upkeep-detail-title">{metric.label}</h3>
      {compared ? (
        <dl className="upkeep-values">
          <div><dt>{T.withWindow(T.afterFix, compared.afterWindow)}</dt><dd>{compared.after}</dd></div>
          <div><dt>{T.withWindow(T.beforeFix, compared.beforeWindow)}</dt><dd>{compared.before}</dd></div>
          <div data-status={metric.status}><dt>{T.changeSinceFix}</dt><dd>{compared.change ?? "—"}</dd></div>
          <div><dt>{T.previous}</dt><dd>{formatUpkeepValue(metric.unit, metric.previous)}</dd></div>
        </dl>
      ) : (
        <dl className="upkeep-values">
          <div><dt>{T.current}</dt><dd>{formatUpkeepValue(metric.unit, metric.current)}</dd></div>
          <div><dt>{T.previous}</dt><dd>{formatUpkeepValue(metric.unit, metric.previous)}</dd></div>
          <div data-status={metric.status}><dt>{T.change}</dt><dd>{change ?? "—"}</dd></div>
        </dl>
      )}
      <p className="upkeep-detail-state">
        <StatusLabel status={metric.status} text={UPKEEP_STATUS_LABELS[metric.status]} />
        {check ? <span className="upkeep-checked">{T.checkedAt(kstDateTime(check.checkedAt).slice(5))}</span> : null}
      </p>
      {fix ? (
        <p className="upkeep-line">
          <span className="upkeep-line-label">{T.fixedSince(kstDateTime(fix.markedAt).slice(5))}</span>
        </p>
      ) : null}
      {check?.note ? (
        <div className="upkeep-block">
          <h4>{T.checkNote}</h4>
          <p className="upkeep-line">{check.note}</p>
        </div>
      ) : null}
      {metric.criterionId ? (
        <p className="upkeep-line upkeep-line-split" title={T.precisionNote}>
          <span className="upkeep-line-label">{T.precisionLabel}</span>
          <span>{metric.precision ? T.precisionValue(metric.precision) : T.precisionEmpty}</span>
        </p>
      ) : null}
      <div className="upkeep-block">
        <h4>{T.criterion}</h4>
        <p className="upkeep-line">{keepParens(metric.criterion)}</p>
      </div>
      {metric.handoff ? (
        <p className="upkeep-line">
          <span className="upkeep-line-label">{T.handoffSource}</span>
          {metric.handoff.path} · 「{metric.handoff.title}」
        </p>
      ) : null}
      {metric.note ? <p className="upkeep-line upkeep-note">{keepParens(metric.note)}</p> : null}
      {metric.evidence.length ? (
        <details className="upkeep-details">
          <summary>{T.evidence(metric.evidence.length)}</summary>
          <ul className="upkeep-evidence">
            {metric.evidence.map((evidence, index) => (
              <li key={`${evidence.sessionId ?? evidence.label}-${index}`}>
                <span className="upkeep-evidence-label">
                  {evidence.label}
                  {evidence.count !== undefined ? ` · ${evidence.count}회` : ""}
                  {evidence.timestamp ? ` · ${kstDateTime(evidence.timestamp)}` : ""}
                  {fixTag(evidence, fix) ? ` · ${fixTag(evidence, fix)}` : ""}
                </span>
                {evidence.detail ? <span className="upkeep-evidence-detail">{evidence.detail}</span> : null}
                {evidence.sessionId ? (
                  <a
                    className="upkeep-evidence-link"
                    href={`/?session=${encodeURIComponent(evidence.sessionId)}`}
                    target="_blank"
                    rel="noopener"
                    title={evidence.sessionPath ?? evidence.sessionId}
                  >
                    {T.openSession} · {evidence.sessionId}
                  </a>
                ) : evidence.sessionPath ? (
                  <span className="upkeep-evidence-detail">{evidence.sessionPath}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {isFlagged(metric.status) ? (
        <PromptActions build={() => buildMetricPrompt(report, section.id, metric.id)} onStart={onStart} target={T.itemTarget(metric.label)} primary>
          {markActions}
        </PromptActions>
      ) : markActions ? <div className="upkeep-actions">{markActions}</div> : null}
      {checkAction ? (
        <div className="upkeep-actions upkeep-verdict" role="group" aria-label={T.verdictAsk}>
          <span className="upkeep-line-label" aria-hidden="true">{T.verdictAsk}</span>
          {(["real", "false-positive"] as const).map((verdict) => (
            <button
              key={verdict}
              type="button"
              className="upkeep-button"
              data-variant={check?.verdict === verdict ? "chosen" : undefined}
              aria-label={T.fixActionFor(verdict === "real" ? T.verdictReal : T.verdictFalsePositive, metric.label)}
              aria-pressed={check?.verdict === verdict}
              disabled={busy}
              onClick={() => onMark("check", metric.id, true, section.id, verdict)}
            >
              {verdict === "real" ? T.verdictReal : T.verdictFalsePositive}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const dueKey = (item: UpkeepDueItem) => `${item.ref.path}-${item.ref.title}`;

function DueTableRow({ item, selected, onSelect }: { item: UpkeepDueItem; selected: boolean; onSelect: () => void }) {
  const status = item.overdue ? "problem" : "unknown";
  return (
    <tr className="upkeep-row" data-status={status} aria-selected={selected}>
      <td className="upkeep-cell-status" data-label={T.colStatus}><StatusLabel status={status} text={UPKEEP_STATUS_LABELS[status]} /></td>
      <th scope="row" className="upkeep-cell-label">
        <button type="button" className="upkeep-row-select" aria-pressed={selected} onClick={onSelect}>{item.ref.title}</button>
      </th>
      <td className="upkeep-cell-due" data-label={T.colDue}>{describeDue(item)}</td>
    </tr>
  );
}

function DueDetail({ report, item, onStart }: { report: UpkeepReport; item: UpkeepDueItem; onStart: (prompt: string) => void }) {
  return (
    <div className="upkeep-detail">
      <h3 className="upkeep-detail-title">{item.ref.title}</h3>
      <p className="upkeep-detail-state">
        <span className="upkeep-line">{describeDue(item)}</span>
        <StatusLabel status={item.overdue ? "problem" : "unknown"} text={UPKEEP_STATUS_LABELS[item.overdue ? "problem" : "unknown"]} />
      </p>
      <p className="upkeep-line upkeep-note">{T.dueSource(item.ref.path, item.section)}</p>
      <details className="upkeep-details" open>
        <summary>{T.dueText}</summary>
        <pre className="upkeep-quote">{item.ref.text}</pre>
      </details>
      <PromptActions build={() => buildDuePrompt(report, item)} onStart={onStart} target={T.itemTarget(item.ref.title)} primary />
    </div>
  );
}

/** 좁은 화면(인스펙터가 아래로 내려간 배치)에서만 고른 내용을 화면에 들인다. */
const STACKED_QUERY = "(max-width: 1231px)";

export function UpkeepView({ open, onClose, onStartSession }: Props) {
  const [report, setReport] = useState<UpkeepReport | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "idle" });
  const rootRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 표시를 바꾼 행은 판정·자리가 바뀔 수 있으므로, 새 보고서를 그린 뒤 그 행의 같은 종류 버튼으로 초점을 되돌린다.
  const markFocusRef = useRef<{ kind: MarkKind; metricId: string; sectionId: UpkeepSection["id"] } | null>(null);
  // 조건부·날짜 없는 HANDOFF 항목(수십 건)은 접어 두고, 기한 지난 것과 날짜 있는 것만 먼저 보인다.
  const [dueFoldOpen, setDueFoldOpen] = useState(false);
  // 고른 섹션과 그 안에서 고른 지표(또는 HANDOFF 항목). 보고서를 다시 읽어도 남아 있으면 그대로 둔다.
  const [sectionId, setSectionId] = useState<UpkeepSection["id"] | null>(null);
  const [pick, setPick] = useState<string | null>(null);

  /** 보고서를 받는 모든 요청(읽기·고침 표시)의 공통 경로. 실패 문구는 요청 종류마다 다르다. */
  const requestReport = useCallback(async (url: string, failed: (error: string) => string, init: RequestInit = {}) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoad({ phase: "loading" });
    try {
      const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
      const body = await response.json().catch(() => null) as (UpkeepReport & { error?: string }) | null;
      if (!response.ok || !body || !Array.isArray(body.sections)) {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      setReport(body);
      setLoad({ phase: "ready" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setLoad({ phase: "error", error: failed(error instanceof Error ? error.message : String(error)) });
    }
  }, []);

  const fetchReport = useCallback(
    (refresh: boolean) => requestReport(`/api/upkeep${refresh ? "?refresh=1" : ""}`, T.loadFailed),
    [requestReport],
  );

  const changeMark = useCallback((kind: MarkKind, metricId: string, mark: boolean, markSectionId: UpkeepSection["id"], verdict?: UpkeepVerdict) => {
    markFocusRef.current = { kind, metricId, sectionId: markSectionId };
    void requestReport(kind === "fix" ? "/api/upkeep" : "/api/upkeep/check", kind === "fix" ? T.fixFailed : T.checkFailed, {
      method: mark ? "POST" : "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metricId, verdict }),
    });
  }, [requestReport]);

  // 표시를 지워 버튼이 사라지면 같은 행의 다른 버튼으로, 행까지 사라지면(기준 밖 비용 행) 섹션 제목으로 보낸다.
  useEffect(() => {
    const target = markFocusRef.current;
    const root = rootRef.current;
    if (!target || !root || load.phase === "loading") return;
    markFocusRef.current = null;
    const id = CSS.escape(target.metricId);
    const focusTarget = root.querySelector<HTMLElement>(`[data-${target.kind}-metric="${id}"]`)
      ?? root.querySelector<HTMLElement>(`[data-metric-detail="${id}"] :is(button:not([disabled]), summary)`)
      ?? root.querySelector<HTMLElement>(`[data-metric-row="${id}"] button`)
      ?? root.querySelector<HTMLElement>(`#upkeep-heading-${target.sectionId}`);
    focusTarget?.focus();
  }, [report, load.phase]);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (open && !report && load.phase === "idle") void fetchReport(false);
  }, [fetchReport, load.phase, open, report]);

  // 화면을 열면 초점을 안으로 옮기고, 닫을 때까지 Tab이 밖으로 새지 않게 한다.
  useEffect(() => {
    const root = rootRef.current;
    if (!open || !root) return;
    const visible = () => Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLES))
      .filter((element) => element.getClientRects().length > 0);
    (visible()[0] ?? root).focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = visible();
      if (!items.length) return;
      const active = document.activeElement;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (active === first || !root.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !root.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };

  const start = useCallback((prompt: string) => onStartSession(prompt, report?.repoCwd ?? null), [onStartSession, report?.repoCwd]);

  // 처음 읽은 보고서는 판정이 가장 나쁜 섹션을 연다. 같은 판정끼리는 수집기 순서를 지킨다.
  const sections = report?.sections ?? [];
  const section = sections.find((candidate) => candidate.id === sectionId)
    ?? [...sections].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])[0]
    ?? null;
  const sortedMetrics = section ? [...section.metrics].sort((a, b) => rowRank(a) - rowRank(b)) : [];
  const sectionItems = section ? sortDueItems(section.items ?? []) : [];
  const metric = sortedMetrics.find((candidate) => candidate.id === pick) ?? null;
  const dueItem = metric ? null : sectionItems.find((item) => dueKey(item) === pick) ?? null;
  // 고른 것이 없으면 섹션 판정을 정한 가장 앞 행을 보인다.
  const shownMetric = metric ?? (dueItem ? null : sortedMetrics[0] ?? null);
  const shownDue = shownMetric ? null : dueItem ?? sectionItems.find((item) => item.overdue || item.dueDate) ?? null;

  const selectSection = (id: UpkeepSection["id"]) => {
    setSectionId(id);
    setPick(null);
    if (window.matchMedia(STACKED_QUERY).matches) mainRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    window.requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`#upkeep-heading-${CSS.escape(id)}`)?.focus({ preventScroll: true }));
  };

  const selectRow = (key: string) => {
    setPick(key);
    if (window.matchMedia(STACKED_QUERY).matches) window.requestAnimationFrame(() => inspectorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };

  const loading = load.phase === "loading";
  const ranges = report ? windowRanges(report) : null;
  const flagged = report ? hasFlaggedItems(report) : false;
  const criterion = section ? commonCriterion(section.metrics) : null;
  const dated = sectionItems.filter((item) => item.overdue || item.dueDate);
  const folded = sectionItems.filter((item) => !item.overdue && !item.dueDate);
  const dueRow = (item: UpkeepDueItem) => (
    <DueTableRow key={dueKey(item)} item={item} selected={shownDue === item} onSelect={() => selectRow(dueKey(item))} />
  );

  return (
    <section
      ref={rootRef}
      className="upkeep-view"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upkeep-title"
      tabIndex={-1}
      hidden={!open}
      onKeyDown={onKeyDown}
    >
      <aside className="upkeep-list" aria-label={T.title}>
        <div className="upkeep-list-bar">
          <button type="button" className="upkeep-back" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m12 19-7-7 7-7" />
              <path d="M19 12H5" />
            </svg>
            {T.back}
          </button>
          <button
            type="button"
            className="upkeep-button"
            data-variant="ghost"
            onClick={() => void fetchReport(true)}
            disabled={loading}
            aria-busy={loading}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
              <path d="M21 3v5h-5" />
              <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
              <path d="M8 16H3v5" />
            </svg>
            {loading ? T.refreshing : T.refresh}
          </button>
        </div>
        <h2 id="upkeep-title">{T.title}</h2>
        {report && ranges ? (
          <dl className="upkeep-meta">
            <div><dt>{T.periodCurrent}</dt><dd>{ranges.current}</dd></div>
            <div><dt>{T.periodPrevious}</dt><dd>{ranges.previous}</dd></div>
            <div><dt>{T.generated}</dt><dd>{kstDateTime(report.generatedAt)}</dd></div>
            <div><dt>{T.scannedLabel}</dt><dd>{T.scannedValue(report.scannedFiles.toLocaleString("ko-KR"), (report.scanMs / 1000).toFixed(1))}</dd></div>
          </dl>
        ) : null}
        {report ? (
          <>
            <nav className="upkeep-sections" aria-label={T.sectionStatus}>
              <h3 className="upkeep-group-title" aria-hidden="true">{T.sectionsTitle}</h3>
              {sections.map((candidate) => (
                <button
                  key={candidate.id}
                  type="button"
                  className="upkeep-section-item"
                  data-status={candidate.status}
                  aria-pressed={candidate === section}
                  onClick={() => selectSection(candidate.id)}
                >
                  <span className="upkeep-section-name">{candidate.title}</span>
                  <StatusLabel status={candidate.status} text={UPKEEP_STATUS_LABELS[candidate.status]} />
                </button>
              ))}
            </nav>
            <div className="upkeep-full">
              <h3 className="upkeep-group-title">{T.fullPrompt}</h3>
              {flagged ? (
                <PromptActions build={() => buildFullPrompt(report)} onStart={start} target={T.fullTarget} label={T.newSession} />
              ) : <p className="upkeep-note">{T.fullPromptEmpty}</p>}
            </div>
          </>
        ) : null}
      </aside>

      <div ref={mainRef} className="upkeep-main" aria-busy={loading}>
        {!report ? (
          load.phase === "error" ? (
            <div className="upkeep-empty" role="alert">
              <p>{load.error}</p>
              <button type="button" className="upkeep-button" onClick={() => void fetchReport(false)}>{T.retry}</button>
            </div>
          ) : (
            <p className="upkeep-empty" role="status">{T.loading}</p>
          )
        ) : (
          <>
            {load.phase === "error" ? <p className="upkeep-banner" role="alert">{load.error}</p> : null}
            {report.repoCwd === null ? <p className="upkeep-banner">{T.noRepo}</p> : null}
            {section ? (
              <section className="upkeep-section" id={`upkeep-section-${section.id}`} aria-labelledby={`upkeep-heading-${section.id}`}>
                <p className="upkeep-crumb">{T.title} / {T.sectionsTitle}</p>
                <div className="upkeep-section-head">
                  <div className="upkeep-section-title">
                    <h3 id={`upkeep-heading-${section.id}`} tabIndex={-1}>{section.title}</h3>
                    <StatusLabel status={section.status} text={UPKEEP_STATUS_LABELS[section.status]} />
                  </div>
                  <PromptActions
                    build={() => buildSectionPrompt(report, section.id)}
                    onStart={start}
                    target={T.sectionTarget(section.title)}
                    label={T.sectionPrompt}
                  />
                </div>
                <p className="upkeep-summary">{section.summary}</p>
                {criterion ? (
                  <p className="upkeep-line"><span className="upkeep-line-label">{T.criterion}</span>{keepParens(criterion)}</p>
                ) : null}
                {section.warnings.length ? (
                  <div className="upkeep-warnings">
                    <span className="upkeep-line-label">{T.warnings}</span>
                    <ul>{section.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                  </div>
                ) : null}
                {section.metrics.length ? (
                  <table className="upkeep-table">
                    <thead>
                      <tr>
                        <th scope="col">{T.colStatus}</th>
                        <th scope="col">{T.colMetric}</th>
                        <th scope="col" className="upkeep-cell-num">{T.current}</th>
                        <th scope="col" className="upkeep-cell-num">{T.previous}</th>
                        <th scope="col" className="upkeep-cell-num">{T.change}</th>
                        <th scope="col">{T.colCheck}</th>
                        <th scope="col" className="upkeep-cell-num">{T.colEvidence}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sortedMetrics.map((row) => (
                        <MetricTableRow key={row.id} metric={row} selected={row === shownMetric} onSelect={() => selectRow(row.id)} />
                      ))}
                    </tbody>
                  </table>
                ) : section.id !== "ops" ? <p className="upkeep-note">{T.noMetrics}</p> : null}
                {section.id === "ops" ? (
                  sectionItems.length ? (
                    <>
                      {dated.length ? (
                        <table className="upkeep-table" data-kind="due">
                          <thead><tr><th scope="col">{T.colStatus}</th><th scope="col">{T.colItem}</th><th scope="col">{T.colDue}</th></tr></thead>
                          <tbody>{dated.map(dueRow)}</tbody>
                        </table>
                      ) : null}
                      {folded.length ? (
                        <>
                          <button
                            type="button"
                            className="upkeep-button upkeep-fold"
                            data-variant="ghost"
                            aria-expanded={dueFoldOpen}
                            aria-controls="upkeep-due-folded"
                            onClick={() => setDueFoldOpen((value) => !value)}
                          >
                            {dueFoldOpen ? T.dueFoldedHide(folded.length) : T.dueFolded(folded.length)}
                          </button>
                          <table id="upkeep-due-folded" className="upkeep-table" data-kind="due" hidden={!dueFoldOpen}>
                            <thead><tr><th scope="col">{T.colStatus}</th><th scope="col">{T.colItem}</th><th scope="col">{T.colDue}</th></tr></thead>
                            <tbody>{folded.map(dueRow)}</tbody>
                          </table>
                        </>
                      ) : null}
                    </>
                  ) : <p className="upkeep-note">{T.noDueItems}</p>
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>

      <aside ref={inspectorRef} className="upkeep-inspector" aria-label={T.inspectorLabel}>
        {report && section && shownMetric ? (
          <MetricDetail
            report={report}
            section={section}
            metric={shownMetric}
            onStart={start}
            onMark={changeMark}
            busy={loading}
          />
        ) : report && shownDue ? (
          <DueDetail report={report} item={shownDue} onStart={start} />
        ) : report ? <p className="upkeep-note">{T.inspectorEmpty}</p> : null}
      </aside>
    </section>
  );
}

/** 보수 화면을 닫은 뒤 작업 화면 아래쪽에 잠깐 뜨는 안내. 몇 초 뒤 스스로 사라진다. */
export function UpkeepNotice({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(onDismiss, 8000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);
  if (!message) return null;
  return (
    <div className="upkeep-notice" role="status">
      <p>{message}</p>
      <button type="button" onClick={onDismiss} aria-label={T.dismiss} title={T.dismiss}>✕</button>
    </div>
  );
}
