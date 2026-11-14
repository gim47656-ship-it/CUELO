"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { pickDeliverables } from "@/lib/answer-status/deliverables";
import { presentMaker, readDispatchMembers } from "@/lib/answer-status/dispatch";
import type { FinishedTurnSummary } from "@/lib/answer-status/turn-summary";
import type { ToolCallContent } from "@/lib/types";
import { latestChecks } from "@/lib/answer-status/work-flow";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { DispatchCard } from "./DispatchCard";
import { FlowGraph } from "./FlowGraph";
import { ResultPreview } from "./ResultPreview";
import { useAnswerStatusText, type AnswerStatusTranslate } from "./i18n";

/** A turn in the transcript: its summary position, or `live` for the turn that is still running. */
export type TurnKey = number | "live";

/**
 * Which turn the inspector's 이번 턴 view shows. ChatWindow owns the selection; a stream row selects its
 * turn and asks the shell to bring 이번 턴 on screen.
 */
export const TurnSelectionContext = createContext<{
  selected: TurnKey | null;
  /** 이번 턴 is on screen. While it is, a turn shows one result row; otherwise it shows the full card. */
  shown: boolean;
  select: (key: TurnKey) => void;
  /** The newest finished turn: the one a compaction's hidden dispatches belong to. */
  latestTurn?: number | null;
  compactedCalls?: readonly ToolCallContent[];
  onOpenFile?: (filePath: string) => void;
}>({ selected: null, shown: false, select: () => {} });

/**
 * The counts of a turn, from tool calls, results and the dispatch ledger only; answer text is never read.
 * Unconfirmed = failed or unobserved checks plus Makers that failed, stopped, went unobserved or were not
 * accepted. A shell exit 0 that does not prove the check passed is counted apart as an unconfirmed
 * verdict. A live turn does not count results that have not arrived yet as unconfirmed.
 */
function useTurnCounts(summary: FinishedTurnSummary, live: boolean) {
  const { ledger, subagents, toolResults } = useContext(AnswerStatusContext);
  const deliverables = useMemo(() => (live ? [] : pickDeliverables(summary.files)), [live, summary.files]);
  const makers = useMemo(
    () => summary.dispatchCalls
      .flatMap((call) => readDispatchMembers(call, toolResults.get(call.toolCallId)) ?? [])
      .map((member) => presentMaker(member, subagents, ledger)),
    [summary.dispatchCalls, toolResults, subagents, ledger],
  );
  const timings = useMemo(
    () => makers.map((maker) => ({
      startedAt: ledger.spawnedAt.get(maker.member.key) ?? null,
      durationMs: ledger.durations.get(maker.member.key) ?? null,
    })),
    [makers, ledger],
  );
  // 같은 명령을 다시 돌렸으면 그 명령의 유효한 결과 하나만 센다. 검사 단계의 맨 위 행과 같은 기준이다.
  const checks = latestChecks(summary.flow.steps);
  const failed = checks.filter((check) => check.outcome === "failed").length;
  const unconfirmedChecks = checks.filter((check) => check.outcome === "failed" || check.outcome === "unobserved").length;
  const compoundFailed = checks.filter((check) => check.compound?.failed).length;
  const verdictUnconfirmed = checks.filter((check) => check.outcome === "unverified" && !check.compound?.failed).length;
  const stale = checks.filter((step) => step.stale).length;
  const unconfirmedMakers = makers.filter((maker) => (
    maker.run === "failed" || maker.run === "aborted" || maker.run === "unobserved"
    || maker.verdict?.verdict !== "accepted"
  )).length;
  const unconfirmed = live ? 0 : unconfirmedChecks + unconfirmedMakers;
  // 기록된 작업 단계가 하나라도 있으면(조사만 했어도) 끝난 뒤에도 남긴다. 단계도 파일·검사·Maker·남은 일도 없는
  // 대화만 숨긴다. 실행 중인 턴은 단계가 생기기 전에는 보이지 않는다.
  const empty = summary.flow.steps.length === 0
    && (live || (summary.files.length === 0 && summary.checks.length === 0 && makers.length === 0 && !summary.remaining?.length));
  return {
    deliverables, makers, timings, checks, failed, compoundFailed, verdictUnconfirmed, stale, unconfirmed, empty,
    attention: unconfirmed > 0 || failed > 0 || verdictUnconfirmed > 0 || compoundFailed > 0 || stale > 0,
  };
}

type TurnCounts = ReturnType<typeof useTurnCounts>;

/** The one-line form of the counts, in the order the former result card used. */
function countParts(summary: FinishedTurnSummary, counts: TurnCounts, live: boolean, st: AnswerStatusTranslate): string[] {
  const parts = [
    st(summary.files.length === 1 ? "summary.files.one" : "summary.files", { count: summary.files.length }),
    st(counts.checks.length === 1 ? "summary.checks.one" : "summary.checks", { count: counts.checks.length }),
  ];
  if (live) parts.unshift(st("summary.live"));
  if (counts.failed > 0) parts.push(st("summary.checksFailed", { count: counts.failed }));
  if (counts.compoundFailed > 0) parts.push(st("summary.compoundFailed", { count: counts.compoundFailed }));
  if (counts.makers.length > 0) parts.push(st(counts.makers.length === 1 ? "summary.makers.one" : "summary.makers", { count: counts.makers.length }));
  if (summary.remaining) parts.push(st("summary.remaining", { count: summary.remaining.length }));
  if (counts.unconfirmed > 0) parts.push(st("summary.unverified", { count: counts.unconfirmed }));
  if (counts.verdictUnconfirmed > 0) parts.push(st(counts.verdictUnconfirmed === 1 ? "summary.verdictUnverified.one" : "summary.verdictUnverified", { count: counts.verdictUnconfirmed }));
  if (counts.stale > 0) parts.push(st("summary.stale", { count: counts.stale }));
  return parts;
}

/**
 * The stream keeps one compact row per turn: its counts and where to read the rest. Pressing it selects
 * the turn in the inspector's 이번 턴 view (and opens that view when it is not on screen).
 */
export function TurnResultRow({ summary, turnKey, live = false }: {
  summary: FinishedTurnSummary;
  turnKey: TurnKey;
  live?: boolean;
}) {
  const { st } = useAnswerStatusText();
  const counts = useTurnCounts(summary, live);
  const { selected, shown, select } = useContext(TurnSelectionContext);
  if (counts.empty) return null;
  const current = selected === turnKey && shown;
  return (
    <button
      type="button"
      className="turn-row"
      aria-pressed={current}
      data-live={live ? "" : undefined}
      onClick={() => select(turnKey)}
    >
      <TurnStateIcon attention={counts.attention} live={live} />
      <span className="turn-row-counts" data-attention={counts.attention ? "" : undefined}>
        {countParts(summary, counts, live, st).join(" · ")}
      </span>
      <span className="turn-row-go">
        <span className="turn-row-go-label">{st(current ? "turn.shown" : "turn.show")}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
      </span>
    </button>
  );
}

/**
 * One turn in the stream. While the inspector's 이번 턴 is on screen the stream keeps only the compact
 * result row; when the inspector is closed, stacked away or on another view, the same body the inspector
 * shows stands here in full, so a turn is never without its work flow.
 */
export function TurnStreamRow({ summary, turnKey, live = false }: {
  summary: FinishedTurnSummary;
  turnKey: TurnKey;
  live?: boolean;
}) {
  const { shown } = useContext(TurnSelectionContext);
  return shown
    ? <TurnResultRow summary={summary} turnKey={turnKey} live={live} />
    : <TurnInlineCard summary={summary} turnKey={turnKey} live={live} />;
}

/** The inspector's 이번 턴 body, unfolded, in the stream; opening it in the inspector stays a secondary action. */
function TurnInlineCard({ summary, turnKey, live }: { summary: FinishedTurnSummary; turnKey: TurnKey; live: boolean }) {
  const { st, locale } = useAnswerStatusText();
  const counts = useTurnCounts(summary, live);
  const { select, latestTurn, compactedCalls, onOpenFile } = useContext(TurnSelectionContext);
  const turnCompacted = turnKey === "live" || turnKey === latestTurn ? compactedCalls : undefined;
  if (counts.empty && !(turnCompacted?.length)) return null;
  return (
    <section className="turn-inline" data-live={live ? "" : undefined}>
      <TurnInspectorBody summary={summary} live={live} folded={false} compactedCalls={turnCompacted} onOpenFile={onOpenFile} st={st} locale={locale} />
      <div className="turn-inline-actions">
        <button type="button" className="turn-inline-show" onClick={() => select(turnKey)}>
          {st("turn.show")}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6" /></svg>
        </button>
      </div>
    </section>
  );
}

/** The phone's collapsed sheet strip above the composer: the counts and a way into the full view. */
export function TurnPeek({ summary, live = false, onOpen }: {
  summary: FinishedTurnSummary;
  live?: boolean;
  onOpen: () => void;
}) {
  const { st } = useAnswerStatusText();
  const counts = useTurnCounts(summary, live);
  if (counts.empty) return null;
  return (
    <button type="button" className="turn-peek" onClick={onOpen}>
      <TurnStateIcon attention={counts.attention} live={live} />
      <span className="turn-peek-counts">{countParts(summary, counts, live, st).join(" · ")}</span>
      <span className="turn-peek-open">{st("turn.peek")}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
    </button>
  );
}

function TurnStateIcon({ attention, live }: { attention: boolean; live: boolean }) {
  if (live) return <span className="workbench-lamp" aria-hidden="true" />;
  return attention ? (
    <svg className="turn-state-icon" data-tone="warning" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>
  ) : (
    <svg className="turn-state-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></svg>
  );
}

/**
 * One block of the 이번 턴 view. On the phone the blocks fold into filled groups (title, one-line summary,
 * chevron) so the sheet opens short; on the desktop inspector they stand open.
 */
function TurnBlock({ title, summaryLine, folded, open = false, children }: {
  title: string;
  summaryLine?: string;
  folded: boolean;
  open?: boolean;
  children: ReactNode;
}) {
  if (!folded) {
    return (
      <section className="turn-block">
        <h4 className="turn-block-title">{title}</h4>
        {children}
      </section>
    );
  }
  return (
    <details className="turn-block" data-folded="" open={open}>
      <summary className="turn-block-summary">
        <span className="turn-block-title">{title}</span>
        {summaryLine && <span className="turn-block-line">{summaryLine}</span>}
        <svg className="turn-block-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <div className="turn-block-body">{children}</div>
    </details>
  );
}

/** One-line count for the folded subagent block: surviving Makers plus the ones a compaction hid. */
function dispatchSummaryLine(
  compactedCalls: readonly ToolCallContent[] | undefined,
  makerCount: number,
  toolResults: React.ContextType<typeof AnswerStatusContext>["toolResults"],
  st: AnswerStatusTranslate,
): string {
  const count = makerCount + (compactedCalls ?? [])
    .reduce((total, call) => total + (readDispatchMembers(call, toolResults.get(call.toolCallId))?.length ?? 0), 0);
  return st(count === 1 ? "summary.makers.one" : "summary.makers", { count });
}

/**
 * 이번 턴: the selected turn's counts, its work flow with the selected stage's detail and its outputs, the
 * subagent dispatches with their verdicts, and what is left. Everything here used to sit in the stream as
 * the result card and the dispatch cards.
 */
export function TurnInspector({ summary, live = false, folded = false, compactedCalls, onOpenFile }: {
  summary: FinishedTurnSummary | null;
  live?: boolean;
  folded?: boolean;
  /** Dispatches a compaction hid from the transcript; only the latest turn gets them. */
  compactedCalls?: readonly ToolCallContent[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { st, locale } = useAnswerStatusText();
  const { toolResults } = useContext(AnswerStatusContext);
  if (!summary) {
    // A compaction can leave its dispatches behind with no surviving answer;
    // they stay reachable here instead of disappearing with the turn.
    if (compactedCalls && compactedCalls.length > 0) {
      return (
        <div className="turn-inspector">
          <TurnBlock title={st("turn.dispatches")} summaryLine={dispatchSummaryLine(compactedCalls, 0, toolResults, st)} folded={folded} open>
            <DispatchCard calls={compactedCalls} />
          </TurnBlock>
        </div>
      );
    }
    return <p className="inspector-empty">{st("turn.none")}</p>;
  }
  return <TurnInspectorBody summary={summary} live={live} folded={folded} compactedCalls={compactedCalls} onOpenFile={onOpenFile} st={st} locale={locale} />;
}

function TurnInspectorBody({ summary, live, folded, compactedCalls, onOpenFile, st, locale }: {
  summary: FinishedTurnSummary;
  live: boolean;
  folded: boolean;
  compactedCalls?: readonly ToolCallContent[];
  onOpenFile?: (filePath: string) => void;
  st: AnswerStatusTranslate;
  locale: string;
}) {
  const counts = useTurnCounts(summary, live);
  const { toolResults } = useContext(AnswerStatusContext);
  const at = summary.span.endedAt ?? summary.span.startedAt;
  const heading = live
    ? st("turn.headingLive")
    : at !== null
      ? st("turn.heading", { time: new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(new Date(at)) })
      : st("turn.headingUnknown");
  const metrics: { key: string; label: string; value: number; tone?: "warning" | "danger" }[] = [
    { key: "files", label: st("turn.metric.files"), value: summary.files.length },
    { key: "checks", label: st("turn.metric.checks"), value: counts.checks.length },
    { key: "remaining", label: st("turn.metric.remaining"), value: summary.remaining?.length ?? 0 },
  ];
  if (counts.failed > 0) metrics.push({ key: "failed", label: st("turn.metric.failed"), value: counts.failed, tone: "danger" });
  if (counts.unconfirmed > 0) metrics.push({ key: "unconfirmed", label: st("turn.metric.unverified"), value: counts.unconfirmed, tone: "warning" });
  if (counts.verdictUnconfirmed > 0) metrics.push({ key: "verdict", label: st("turn.metric.verdict"), value: counts.verdictUnconfirmed, tone: "warning" });
  if (counts.stale > 0) metrics.push({ key: "stale", label: st("turn.metric.stale"), value: counts.stale });
  const remaining = summary.remaining;

  return (
    <div className="turn-inspector" data-live={live ? "" : undefined}>
      <div className="turn-inspector-head">
        <h3 className="turn-inspector-title">{heading}</h3>
      </div>
      <dl className="turn-metrics" aria-label={st("turn.numbers")}>
        {metrics.map((metric) => (
          <div key={metric.key} className="turn-metric" data-tone={metric.tone}>
            <dd>{metric.value}</dd>
            <dt>{metric.label}</dt>
          </div>
        ))}
      </dl>
      {counts.deliverables.length > 0 && <ResultPreview deliverables={counts.deliverables} onOpenFile={onOpenFile} />}
      {counts.empty && !(compactedCalls?.length) ? (
        <p className="inspector-empty">{st("turn.empty")}</p>
      ) : summary.flow.steps.length > 0 && (folded ? (
        // The folded phone group names the flow in its summary; open on the desktop, FlowGraph's own heading
        // (next to 재생) is the only title. The bare section still gives it the answer-summary container.
        <TurnBlock title={st("flow.heading")} summaryLine={countParts(summary, counts, live, st).join(" · ")} folded open>
          <FlowGraph summary={summary} makers={counts.makers} timings={counts.timings} live={live} onOpenFile={onOpenFile} />
        </TurnBlock>
      ) : (
        <section className="turn-block">
          <FlowGraph summary={summary} makers={counts.makers} timings={counts.timings} live={live} onOpenFile={onOpenFile} />
        </section>
      ))}
      {(summary.dispatchCalls.length > 0 || (compactedCalls?.length ?? 0) > 0) && (
        <TurnBlock
          title={st("turn.dispatches")}
          summaryLine={dispatchSummaryLine(compactedCalls, counts.makers.length, toolResults, st)}
          folded={folded}
        >
          {summary.dispatchCalls.length > 0 && <DispatchCard calls={summary.dispatchCalls} />}
          {compactedCalls && compactedCalls.length > 0 && <DispatchCard calls={compactedCalls} />}
        </TurnBlock>
      )}
      {remaining && (
        <TurnBlock
          title={st("summary.heading.remaining")}
          summaryLine={remaining.length === 0 ? st("summary.todo.none") : st("summary.remaining", { count: remaining.length })}
          folded={folded}
        >
          {remaining.length === 0 ? (
            <p className="answer-summary-empty">{st("summary.todo.none")}</p>
          ) : (
            <ul className="flow-remaining-list">
              {remaining.map((task, index) => (
                <li key={`${task.phase}#${index}`} className="answer-remaining" data-status={task.status} title={task.phase || undefined}>
                  <span className="answer-remaining-status">{st(`summary.todo.${task.status}`)}</span>
                  <span className="answer-remaining-text">{task.content}</span>
                  {task.blocker && <span className="answer-remaining-blocker">{st("summary.todo.blocker", { blocker: task.blocker })}</span>}
                </li>
              ))}
            </ul>
          )}
        </TurnBlock>
      )}
    </div>
  );
}
