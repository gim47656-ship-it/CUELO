"use client";

import { useContext, useEffect, useId, useMemo, useState } from "react";
import {
  findExactLiveSnapshot,
  findLiveSnapshot,
  listMakerAttempts,
  presentMaker,
  readDispatchMembers,
  type MakerAttempt,
  type MakerPresentation,
  type MakerRunState,
  type VerdictRecord,
} from "@/lib/answer-status/dispatch";
import { summarizeTurn, type TurnSummary } from "@/lib/answer-status/turn-summary";
import { createHanseSubagentClient } from "@/lib/hanse-subagent-client";
import { buildSubagentFlow, traceSubagentRun, type SubagentRunTrace } from "@/lib/subagent-progress";
import type { AssistantContentBlock, SubagentSnapshot, ToolCallContent, ToolResultMessage } from "@/lib/types";
import { isActiveSubagentStatus, useSubagentTranscripts, type LiveTranscriptView, type SubagentTranscriptRead } from "@/hooks/useSubagentTranscripts";
import { useI18n } from "@/hooks/useI18n";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { useAnswerStatusText, type AnswerStatusMessageKey, type AnswerStatusTranslate } from "./i18n";
import { SubagentFlowGraph, SubagentLiveEta, todoText, useSubagentProgress } from "./SubagentProgress";

export const RUN_LABEL: Record<MakerRunState, AnswerStatusMessageKey> = {
  dispatching: "run.dispatching",
  pending: "run.pending",
  running: "run.running",
  completed: "run.completed",
  failed: "run.failed",
  aborted: "run.aborted",
  unobserved: "run.unobserved",
};

export const VERDICT_LABEL: Record<"accepted" | "rework" | "held" | "none", AnswerStatusMessageKey> = {
  accepted: "verdict.accepted",
  rework: "verdict.rework",
  held: "verdict.held",
  none: "verdict.none",
};

/** Maker 실행 상태와 Main 판정을 화살표로 이은 한 줄. 둘은 서로 다른 상태다. */
export function MakerStatusPair({ maker, st }: { maker: Pick<MakerPresentation, "run" | "verdict">; st: AnswerStatusTranslate }) {
  const verdict = maker.verdict?.verdict ?? "none";
  const attempt = maker.verdict?.attempt;
  return (
    <span className="answer-status-pair">
      <span className="answer-status-run" data-state={maker.run}>{st(RUN_LABEL[maker.run])}</span>
      <span className="answer-status-arrow" aria-hidden="true">→</span>
      <span className="answer-status-verdict" data-verdict={verdict}>
        {st(VERDICT_LABEL[verdict])}
        {attempt != null && attempt > 1 ? ` · ${st("verdict.attempt", { attempt })}` : null}
      </span>
    </span>
  );
}

/**
 * Maker 한 실행의 기록에서 실제로 쓴 파일과 실행한 검사. Main 턴 요약과 같은 규칙(`summarizeTurn`)을 그 Maker의
 * 실시간 기록 전체에 적용한다. 디스크 기록에는 도구 결과가 없어 이 요약을 만들 수 없다.
 */
export function summarizeMakerRun(entries: readonly LiveTranscriptView[], cwd?: string): TurnSummary {
  const blocks: AssistantContentBlock[] = [];
  const toolResults = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (!("message" in entry)) continue;
    if (entry.message.role === "assistant") blocks.push(...(entry.message.content ?? []));
    else if (entry.message.role === "toolResult") toolResults.set(entry.message.toolCallId, entry.message);
  }
  return summarizeTurn(blocks, toolResults, cwd);
}

/** 실행 기록 파일 이름(디스크 기록 이름). 그 실행 자신의 파일이라 이름 추측이 아니다. */
function sessionFileName(snapshot: SubagentSnapshot): string | undefined {
  return snapshot.sessionFile?.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "") || undefined;
}

type LaneChecks = { kind: "running" } | { kind: "loading" } | { kind: "unobserved" } | { kind: "counted"; passed: number; total: number };

function laneChecks(read: SubagentTranscriptRead | undefined, snapshot: SubagentSnapshot | undefined, cwd: string | undefined): LaneChecks {
  if (!snapshot) return { kind: "unobserved" };
  // 실행 중인 Maker의 기록은 단계 표시(useSubagentProgress)가 이미 읽는다. 검사 수는 끝난 뒤에 센다.
  if (isActiveSubagentStatus(snapshot.status)) return { kind: "running" };
  const state = read?.state;
  if (!state || state.kind === "loading") return { kind: "loading" };
  if (state.kind === "ready-live") {
    const { checks } = summarizeMakerRun(state.entries, cwd);
    return { kind: "counted", passed: checks.filter((check) => check.state === "passed").length, total: checks.length };
  }
  if (state.kind === "empty" && state.source === "live") return { kind: "counted", passed: 0, total: 0 };
  return { kind: "unobserved" };
}

/**
 * 끝난 실행의 실시간 기록에서 읽은 마지막 실행 흐름. 디스크 기록은 도구 결과가 없고 앞부분이 잘릴 수 있어 쓰지 않는다 —
 * 그때 그래프는 기록 미관측이다.
 */
function finishedRunTrace(read: SubagentTranscriptRead | undefined, cwd: string | undefined): SubagentRunTrace | null {
  const state = read?.state;
  if (state?.kind !== "ready-live") return null;
  return traceSubagentRun(state.entries.flatMap((entry) => ("message" in entry ? [entry.message] : [])), cwd);
}

/**
 * Maker 이름 자리. 지난 판정 뒤에 다시 깨운 실행이면 그 실행의 제목을 쓰고, 그 제목이 기록에 없으면 보이는 제목이 첫 발주의
 * 제목임을 밝힌다.
 */
function MakerName({ maker, st }: { maker: MakerPresentation; st: AnswerStatusTranslate }) {
  const name = maker.runTitle ?? maker.title;
  return (
    <>
      <span className="answer-dispatch-name" title={name}>{name}</span>
      {maker.priorVerdict && !maker.runTitle && <span className="answer-dispatch-title-note">{st("subflow.firstTitle")}</span>}
    </>
  );
}

function verdictText(st: AnswerStatusTranslate, verdict: VerdictRecord): string {
  const attempt = verdict.attempt !== null && verdict.attempt > 1 ? ` · ${st("verdict.attempt", { attempt: verdict.attempt })}` : "";
  return `${st(VERDICT_LABEL[verdict.verdict])}${attempt}${verdict.reason ? ` · ${verdict.reason}` : ""}`;
}

/**
 * 서브에이전트 발주가 있는 답변 안의 접힌 카드. 접힌 상태에서도 Maker마다 업무 제목과
 * 「실행 상태 → Main 판정」 한 줄이 보이고, 실행 중이면 그 아래 경과·남은 시간 한 줄이 붙는다.
 * 펼치면 Maker마다 「제목 · 실행(단계) · 검사 n/m → 판정」 한 줄과 그 Maker 상세로 가는 버튼이 나오고,
 * 재작업이 있었으면 시도가 차례로 묶인다. 그 아래 모델·판정 사유와 패널 링크가 이어진다.
 */
export function DispatchCard({ calls }: { calls: readonly ToolCallContent[] }) {
  const { ledger, subagents, toolResults, onOpenPanel, focusedDispatch, sessionId, cwd, onOpenMaker, selectedMaker } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const client = useMemo(() => createHanseSubagentClient(), []);
  const makers = useMemo(
    () => calls
      .flatMap((call) => readDispatchMembers(call, toolResults.get(call.toolCallId)) ?? [])
      .map((member) => presentMaker(member, subagents, ledger)),
    [calls, toolResults, subagents, ledger],
  );
  // 이 카드의 실행 중 Maker 스냅샷. 경과·남은 시간은 접힌 상태에서도 보이고, 자식 기록(수 MB)을
  // 읽어야 하는 단계는 펼쳤을 때만 읽는다. 끝난 자식은 읽지 않는다.
  const runningSnapshots = useMemo(
    () => makers.flatMap((maker): SubagentSnapshot[] => {
      if (maker.run !== "pending" && maker.run !== "running") return [];
      const live = findLiveSnapshot(maker.member, subagents, ledger);
      return live ? [live] : [];
    }),
    [makers, subagents, ledger],
  );
  const progressViews = useSubagentProgress({ sessionId, snapshots: runningSnapshots, client, enabled: true, transcripts: open, cwd });
  // 펼친 카드의 검사 수는 그 발주가 정확히 띄운 실행의 기록에서만 센다. 이름이 같은 다른 실행은 쓰지 않는다.
  const exactSnapshots = useMemo(
    () => new Map(makers.flatMap((maker) => {
      const snapshot = findExactLiveSnapshot(maker.member, subagents);
      return snapshot ? [[maker.member.key, snapshot] as const] : [];
    })),
    [makers, subagents],
  );
  const laneTargets = useMemo(
    () => (open
      ? [...exactSnapshots]
        .filter(([, snapshot]) => !isActiveSubagentStatus(snapshot.status))
        .map(([key, snapshot]) => ({ key, liveId: snapshot.id, status: snapshot.status, archiveName: sessionFileName(snapshot) }))
      : []),
    [exactSnapshots, open],
  );
  const laneReads = useSubagentTranscripts(laneTargets, { sessionId: sessionId ?? "", client, enabled: open && Boolean(sessionId) && laneTargets.length > 0 });

  // 덱에 열린 Maker가 이 카드의 행이면 그 상세의 실행 상태·판정을 이 카드의 관측으로 맞춘다.
  const selectedHere = selectedMaker?.origin ? makers.find((maker) => maker.member.key === selectedMaker.origin) : undefined;
  const selectedRun = selectedHere?.run;
  const selectedVerdict = selectedHere?.verdict ?? null;
  useEffect(() => {
    if (!selectedMaker || !onOpenMaker || !selectedRun) return;
    const current = selectedMaker.status;
    if (current && current.run === selectedRun && current.verdict?.order === selectedVerdict?.order) return;
    onOpenMaker({ ...selectedMaker, status: { run: selectedRun, verdict: selectedVerdict } }, false);
  }, [onOpenMaker, selectedMaker, selectedRun, selectedVerdict]);

  if (makers.length === 0) return null;

  let running = 0;
  let done = 0;
  let accepted = 0;
  for (const maker of makers) {
    if (maker.run === "dispatching" || maker.run === "pending" || maker.run === "running") running += 1;
    if (maker.run === "completed") done += 1;
    if (maker.verdict?.verdict === "accepted") accepted += 1;
  }

  return (
    <section
      className={focusedDispatch && makers.some((maker) => maker.member.key === focusedDispatch) ? "answer-dispatch answer-dispatch-flash" : "answer-dispatch"}
      aria-label={st("dispatch.title", { count: makers.length })}
    >
      <button
        type="button"
        className="answer-dispatch-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        title={st(open ? "dispatch.collapse" : "dispatch.expand")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="answer-dispatch-heading">{st("dispatch.title", { count: makers.length })}</span>
        <span className="answer-dispatch-tally">{st("dispatch.tally", { running, done, accepted })}</span>
        <svg className="answer-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      <ul className="answer-dispatch-list" id={bodyId} aria-label={open ? t("dispatchLane.label") : undefined}>
        {makers.map((maker) => {
          const active = maker.run === "pending" || maker.run === "running";
          const snapshot = active ? runningSnapshots.find((entry) => entry.id === maker.member.agentId) : undefined;
          const view = snapshot ? progressViews.get(snapshot.id) : undefined;
          const exact = exactSnapshots.get(maker.member.key);
          const focused = maker.member.key === focusedDispatch || maker.member.key === selectedMaker?.origin;
          // 기록만 실행 중이라고 하는 것은 실시간 관측이 아니다. 진행·대기 칸과 움직임은 실시간 스냅샷이 있을 때만 그린다.
          const liveRun = active && maker.runSource === "live";
          // 펼친 카드만 자식 기록을 읽는다. 실행 중이면 진행 관측의 기록, 끝났으면 그 발주가 띄운 실행의 실시간 기록이다.
          const flow = open ? buildSubagentFlow(liveRun ? view?.trace ?? null : finishedRunTrace(laneReads.get(maker.member.key), cwd), liveRun) : null;
          const attempts = open ? listMakerAttempts(maker.member, ledger) : [];
          return (
          <li key={maker.member.key} className="answer-dispatch-row" data-dispatch-key={maker.member.key} data-focused={focused ? "" : undefined}>
            {open
              ? (
                <DispatchLaneLine
                  maker={maker}
                  phase={liveRun && flow?.run ? st(`phase.${flow.run.phase}`) : null}
                  checks={laneChecks(laneReads.get(maker.member.key), exact, cwd)}
                  onOpen={exact && onOpenMaker
                    ? () => onOpenMaker({
                      key: `live:${exact.id}`,
                      toolCallId: maker.member.toolCallId,
                      origin: maker.member.key,
                      status: { run: maker.run, verdict: maker.verdict },
                    })
                    : null}
                />
              )
              : (
                <div className="answer-dispatch-line">
                  <MakerName maker={maker} st={st} />
                  <MakerStatusPair maker={maker} st={st} />
                </div>
              )}
            {flow && (
              <SubagentFlowGraph flow={flow} live={liveRun} verdict={maker.verdict} attempts={attempts} />
            )}
            {open && <AttemptChain attempts={attempts} />}
            {snapshot && view && (
              <div className="answer-dispatch-progress">
                {view.todo ? `${todoText(st, view.todo)} · ` : null}
                <SubagentLiveEta snapshot={snapshot} view={view} />
              </div>
            )}
            {open && (
              <dl className="answer-dispatch-detail">
                {/* 끝난 Maker의 마지막 의도·도구는 지금 단계가 아니라서 실행 중일 때만 보인다. */}
                {active && (
                  <div>
                    <dt>{st("detail.stage")}</dt>
                    <dd>{maker.stage ?? st("detail.stageNone")}</dd>
                  </div>
                )}
                <div>
                  <dt>{st("detail.model")}</dt>
                  <dd title={maker.model?.model ?? undefined}>
                    {maker.model?.modelShort
                      ? `${maker.model.modelShort}${maker.model.effort ? ` · ${maker.model.effort}` : ""}${maker.model.modelIsFallback ? ` · ${st("detail.fallback")}` : ""}`
                      : st("detail.modelNone")}
                  </dd>
                </div>
                <div>
                  <dt>{st("detail.agentId")}</dt>
                  <dd>
                    <span className="answer-mono">{maker.member.agentId}</span>
                    {maker.runSource ? ` · ${st(maker.runSource === "live" ? "detail.source.live" : "detail.source.record")}` : ""}
                  </dd>
                </div>
                {maker.priorVerdict && (
                  <div>
                    <dt>{st("subflow.prior")}</dt>
                    <dd>{verdictText(st, maker.priorVerdict)}</dd>
                  </div>
                )}
                {maker.priorVerdict && (
                  <div>
                    <dt>{st(maker.runTitle ? "subflow.firstTitle" : "subflow.runTitle")}</dt>
                    <dd>{maker.runTitle ? maker.title : st("detail.stageNone")}</dd>
                  </div>
                )}
                {maker.verdict?.reason && (
                  <div>
                    <dt>{st("detail.reason")}</dt>
                    <dd>{maker.verdict.reason}</dd>
                  </div>
                )}
              </dl>
            )}
          </li>
          );
        })}
      </ul>
      {open && onOpenPanel && (
        <div className="answer-dispatch-links">
          <button type="button" className="answer-link" onClick={() => onOpenPanel("subagents")}>{st("detail.openSubagents")}</button>
          <button type="button" className="answer-link" onClick={() => onOpenPanel("process")}>{st("detail.openProcess")}</button>
        </div>
      )}
    </section>
  );
}

/** 펼친 카드의 Maker 한 줄: 제목 · 실행(단계) · 검사 n/m → 판정, 그리고 상세로 가는 버튼. */
function DispatchLaneLine({ maker, phase, checks, onOpen }: {
  maker: MakerPresentation;
  phase: string | null;
  checks: LaneChecks;
  onOpen: (() => void) | null;
}) {
  const { st } = useAnswerStatusText();
  const { t } = useI18n();
  const verdict = maker.verdict?.verdict ?? "none";
  const run = st(RUN_LABEL[maker.run]);
  const checksLabel = checks.kind === "running"
    ? null
    : checks.kind === "counted"
      ? t("dispatchLane.checks", { passed: checks.passed, total: checks.total })
      : t(checks.kind === "loading" ? "dispatchLane.checksLoading" : "dispatchLane.checksUnobserved");
  return (
    <div className="answer-dispatch-line is-lane">
      <MakerName maker={maker} st={st} />
      <span className="answer-status-pair">
        <span className="answer-status-run" data-state={maker.run}>{phase ? t("dispatchLane.runPhase", { run, phase }) : run}</span>
        {checksLabel && <span className="answer-dispatch-checks" data-checks={checks.kind === "counted" && checks.passed < checks.total ? "failed" : checks.kind}>{checksLabel}</span>}
        <span className="answer-status-arrow" aria-hidden="true">→</span>
        <span className="answer-status-verdict" data-verdict={verdict}>{st(VERDICT_LABEL[verdict])}</span>
      </span>
      {onOpen
        ? (
          <button type="button" className="answer-link answer-dispatch-open" aria-label={t("dispatchLane.openLabel", { title: maker.title })} onClick={onOpen}>
            {t("dispatchLane.open")}
          </button>
        )
        : <span className="answer-dispatch-unavailable" title={t("makerDetail.unavailable")}>{t("dispatchLane.unavailable")}</span>}
    </div>
  );
}

/**
 * Maker 한 명의 단계 흐름(조사 → 구현 → 검증 → 보고 → Main 판정)과 시도 차례. 발주 카드를 펼쳤을 때와 같은 자료를 같은
 * 규칙으로 읽는다: 실시간으로 실행 중이면 진행 관측의 기록, 끝났으면 그 발주가 정확히 띄운 실행의 실시간 기록이다.
 * 마운트된 동안만 기록을 읽으므로, 작업 흐름 그래프는 Maker 줄을 골랐을 때만 이것을 그린다.
 */
export function MakerRunFlow({ maker }: { maker: MakerPresentation }) {
  const { ledger, subagents, sessionId, cwd } = useContext(AnswerStatusContext);
  const client = useMemo(() => createHanseSubagentClient(), []);
  const active = maker.run === "pending" || maker.run === "running";
  const liveRun = active && maker.runSource === "live";
  const liveSnapshot = active ? findLiveSnapshot(maker.member, subagents, ledger) : undefined;
  const runningSnapshots = useMemo(() => (liveSnapshot ? [liveSnapshot] : []), [liveSnapshot]);
  const progressViews = useSubagentProgress({ sessionId, snapshots: runningSnapshots, client, enabled: true, transcripts: true, cwd });
  const exact = findExactLiveSnapshot(maker.member, subagents);
  const targets = useMemo(
    () => (exact && !isActiveSubagentStatus(exact.status)
      ? [{ key: maker.member.key, liveId: exact.id, status: exact.status, archiveName: sessionFileName(exact) }]
      : []),
    [exact, maker.member.key],
  );
  const reads = useSubagentTranscripts(targets, { sessionId: sessionId ?? "", client, enabled: Boolean(sessionId) && targets.length > 0 });
  const view = liveSnapshot ? progressViews.get(liveSnapshot.id) : undefined;
  const flow = buildSubagentFlow(liveRun ? view?.trace ?? null : finishedRunTrace(reads.get(maker.member.key), cwd), liveRun);
  const attempts = listMakerAttempts(maker.member, ledger);
  return (
    <>
      <SubagentFlowGraph flow={flow} live={liveRun} verdict={maker.verdict} attempts={attempts} />
      <AttemptChain attempts={attempts} />
    </>
  );
}

/** 같은 assignment에 판정이 둘 이상 남았을 때 시도를 순서대로 잇는다(시도 1 재작업 → 시도 2 수용). */
function AttemptChain({ attempts }: { attempts: readonly MakerAttempt[] }) {
  const { t } = useI18n();
  if (attempts.length < 2) return null;
  return (
    <ol className="answer-dispatch-attempts" aria-label={t("dispatchLane.label")}>
      {attempts.map((entry, index) => (
        <li key={`${entry.attempt ?? "n"}-${index}`} data-verdict={entry.verdict} title={entry.reason ?? undefined}>
          {index > 0 && <span className="answer-status-arrow" aria-hidden="true">→ </span>}
          {entry.attempt === null ? t("dispatchLane.attemptUnknown") : t("dispatchLane.attempt", { attempt: entry.attempt })}
          {" "}
          {t(`dispatchLane.verdict.${entry.verdict}`)}
        </li>
      ))}
    </ol>
  );
}
