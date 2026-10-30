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
  formatUpkeepChange,
  formatUpkeepValue,
  hasFlaggedItems,
  isFlagged,
  kstDateTime,
  sortDueItems,
  windowRanges,
} from "@/lib/upkeep/prompt";
import type { UpkeepDueItem, UpkeepMetric, UpkeepReport, UpkeepSection, UpkeepStatus } from "@/lib/upkeep/types";
import { UPKEEP_TEXT as T } from "./text";

// 섹션 안에서는 문제·주의 행을 먼저 보여 준다. 같은 상태끼리는 수집기 순서(비용은 큰 순)를 지킨다.
const STATUS_RANK: Record<UpkeepStatus, number> = { problem: 0, watch: 1, unknown: 2, ok: 3 };

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

/** 「…새 세션」과 「복사」. 맨 위 전체 점검만 채운 주 버튼이고 섹션·행은 보조 모양이다. */
function PromptActions({ build, onStart, target, label = T.startSession, primary = false }: {
  build: () => string;
  onStart: (prompt: string) => void;
  /** 화면 낭독기에 붙여 읽을 대상 이름 */
  target: string;
  label?: string;
  primary?: boolean;
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
        aria-label={primary ? undefined : T.actionFor(label, target)}
        onClick={() => onStart(build())}
      >
        {label}
      </button>
      <button
        type="button"
        className="upkeep-button"
        aria-label={T.actionFor(copyLabel, target)}
        onClick={() => {
          copyText(build()).then(() => setCopyState("copied"), () => setCopyState("failed"));
        }}
      >
        <span aria-live="polite">{copyLabel}</span>
      </button>
    </div>
  );
}

function MetricRow({ report, section, metric, sectionCriterion, onStart }: {
  report: UpkeepReport;
  section: UpkeepSection;
  metric: UpkeepMetric;
  sectionCriterion: string | null;
  onStart: (prompt: string) => void;
}) {
  const change = formatUpkeepChange(metric);
  return (
    <li className="upkeep-row" data-status={metric.status}>
      <div className="upkeep-row-head">
        <h4>{metric.label}</h4>
        <StatusLabel status={metric.status} text={UPKEEP_STATUS_LABELS[metric.status]} />
      </div>
      <dl className="upkeep-values">
        <div><dt>{T.current}</dt><dd>{formatUpkeepValue(metric.unit, metric.current)}</dd></div>
        <div><dt>{T.previous}</dt><dd>{formatUpkeepValue(metric.unit, metric.previous)}</dd></div>
        <div><dt>{T.change}</dt><dd>{change ?? "—"}</dd></div>
      </dl>
      {metric.criterion !== sectionCriterion ? (
        <p className="upkeep-line"><span className="upkeep-line-label">{T.criterion}</span>{keepParens(metric.criterion)}</p>
      ) : null}
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
        <PromptActions build={() => buildMetricPrompt(report, section.id, metric.id)} onStart={onStart} target={T.itemTarget(metric.label)} />
      ) : null}
    </li>
  );
}

function DueRow({ report, item, onStart }: { report: UpkeepReport; item: UpkeepDueItem; onStart: (prompt: string) => void }) {
  return (
    <li className="upkeep-row" data-status={item.overdue ? "problem" : "unknown"}>
      <div className="upkeep-row-head">
        <h4>{item.ref.title}</h4>
        <StatusLabel status={item.overdue ? "problem" : "unknown"} text={describeDue(item)} />
      </div>
      <p className="upkeep-line upkeep-note">{T.dueSource(item.ref.path, item.section)}</p>
      <details className="upkeep-details">
        <summary>{T.dueText}</summary>
        <pre className="upkeep-quote">{item.ref.text}</pre>
      </details>
      <PromptActions build={() => buildDuePrompt(report, item)} onStart={onStart} target={T.itemTarget(item.ref.title)} />
    </li>
  );
}

export function UpkeepView({ open, onClose, onStartSession }: Props) {
  const [report, setReport] = useState<UpkeepReport | null>(null);
  const [load, setLoad] = useState<LoadState>({ phase: "idle" });
  const rootRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 조건부·날짜 없는 HANDOFF 항목(수십 건)은 접어 두고, 기한 지난 것과 날짜 있는 것만 먼저 보인다.
  const [dueFoldOpen, setDueFoldOpen] = useState(false);

  const fetchReport = useCallback(async (refresh: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoad({ phase: "loading" });
    try {
      const response = await fetch(`/api/upkeep${refresh ? "?refresh=1" : ""}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json().catch(() => null) as (UpkeepReport & { error?: string }) | null;
      if (!response.ok || !body || !Array.isArray(body.sections)) {
        throw new Error(body?.error ?? `HTTP ${response.status}`);
      }
      setReport(body);
      setLoad({ phase: "ready" });
    } catch (error) {
      if (controller.signal.aborted) return;
      setLoad({ phase: "error", error: error instanceof Error ? error.message : String(error) });
    }
  }, []);

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

  const jumpTo = (sectionId: string) => {
    const heading = rootRef.current?.querySelector<HTMLElement>(`#upkeep-section-${sectionId} h3`);
    heading?.scrollIntoView({ block: "start", behavior: "smooth" });
    heading?.focus({ preventScroll: true });
  };

  const loading = load.phase === "loading";
  const ranges = report ? windowRanges(report) : null;
  const flagged = report ? hasFlaggedItems(report) : false;

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
      <header className="upkeep-header">
        <div className="upkeep-header-bar">
          <button type="button" className="upkeep-back" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            {T.back}
          </button>
          <h2 id="upkeep-title">{T.title}</h2>
          <button
            type="button"
            className="upkeep-button"
            onClick={() => void fetchReport(true)}
            disabled={loading}
            aria-busy={loading}
          >
            {loading ? T.refreshing : T.refresh}
          </button>
        </div>
        {report && ranges ? (
          <p className="upkeep-meta">
            <span>{T.periodCurrent} {ranges.current}</span>
            <span>{T.periodPrevious} {ranges.previous}</span>
            <span>{T.generated} {kstDateTime(report.generatedAt)}</span>
            <span>{T.scanned(report.scannedFiles.toLocaleString("ko-KR"), (report.scanMs / 1000).toFixed(1))}</span>
          </p>
        ) : null}
      </header>

      <div className="upkeep-body" aria-busy={loading}>
        {!report ? (
          load.phase === "error" ? (
            <div className="upkeep-empty" role="alert">
              <p>{T.loadFailed(load.error)}</p>
              <button type="button" className="upkeep-button" onClick={() => void fetchReport(false)}>{T.retry}</button>
            </div>
          ) : (
            <p className="upkeep-empty" role="status">{T.loading}</p>
          )
        ) : (
          <>
            {load.phase === "error" ? <p className="upkeep-banner" role="alert">{T.loadFailed(load.error)}</p> : null}
            {report.repoCwd === null ? <p className="upkeep-banner">{T.noRepo}</p> : null}

            <nav className="upkeep-strip" aria-label={T.sectionStatus}>
              {report.sections.map((section) => (
                <button key={section.id} type="button" className="upkeep-strip-item" data-status={section.status} onClick={() => jumpTo(section.id)}>
                  <span className="upkeep-strip-title">{section.title}</span>
                  <StatusLabel status={section.status} text={UPKEEP_STATUS_LABELS[section.status]} />
                </button>
              ))}
            </nav>

            <div className="upkeep-full">
              <p>{flagged ? T.fullPrompt : T.fullPromptEmpty}</p>
              {flagged ? (
                <PromptActions build={() => buildFullPrompt(report)} onStart={start} target={T.fullTarget} label={`${T.fullPrompt}로 새 세션`} primary />
              ) : null}
            </div>

            {report.sections.map((section) => {
              const items = sortDueItems(section.items ?? []);
              const dated = items.filter((item) => item.overdue || item.dueDate);
              const folded = items.filter((item) => !item.overdue && !item.dueDate);
              const criterion = commonCriterion(section.metrics);
              const dueRow = (item: UpkeepDueItem) => (
                <DueRow key={`${item.ref.path}-${item.ref.title}`} report={report} item={item} onStart={start} />
              );
              return (
                <section key={section.id} id={`upkeep-section-${section.id}`} className="upkeep-section" aria-labelledby={`upkeep-heading-${section.id}`}>
                  <div className="upkeep-section-head">
                    <div className="upkeep-section-title">
                      <h3 id={`upkeep-heading-${section.id}`} tabIndex={-1}>{section.title}</h3>
                      <StatusLabel status={section.status} text={UPKEEP_STATUS_LABELS[section.status]} />
                    </div>
                    <p className="upkeep-summary">{section.summary}</p>
                    {criterion ? (
                      <p className="upkeep-line"><span className="upkeep-line-label">{T.criterion}</span>{keepParens(criterion)}</p>
                    ) : null}
                    <PromptActions
                      build={() => buildSectionPrompt(report, section.id)}
                      onStart={start}
                      target={T.sectionTarget(section.title)}
                      label={T.sectionPrompt}
                    />
                  </div>
                  {section.warnings.length ? (
                    <div className="upkeep-warnings">
                      <span className="upkeep-line-label">{T.warnings}</span>
                      <ul>{section.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                    </div>
                  ) : null}
                  {section.metrics.length ? (
                    <ul className="upkeep-rows">
                      {[...section.metrics].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]).map((metric) => (
                        <MetricRow key={metric.id} report={report} section={section} metric={metric} sectionCriterion={criterion} onStart={start} />
                      ))}
                    </ul>
                  ) : section.id !== "due" ? <p className="upkeep-note">{T.noMetrics}</p> : null}
                  {section.id === "due" ? (
                    items.length ? (
                      <>
                        {dated.length ? <ul className="upkeep-rows">{dated.map(dueRow)}</ul> : null}
                        {folded.length ? (
                          <>
                            <button
                              type="button"
                              className="upkeep-button upkeep-fold"
                              aria-expanded={dueFoldOpen}
                              aria-controls="upkeep-due-folded"
                              onClick={() => setDueFoldOpen((value) => !value)}
                            >
                              {dueFoldOpen ? T.dueFoldedHide(folded.length) : T.dueFolded(folded.length)}
                            </button>
                            <ul id="upkeep-due-folded" className="upkeep-rows" hidden={!dueFoldOpen}>{folded.map(dueRow)}</ul>
                          </>
                        ) : null}
                      </>
                    ) : <p className="upkeep-note">{T.noDueItems}</p>
                  ) : null}
                </section>
              );
            })}
          </>
        )}
      </div>
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
