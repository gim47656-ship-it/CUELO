"use client";

import { useContext, useId, useMemo, useState } from "react";
import { presentMaker, readDispatchMembers } from "@/lib/answer-status/dispatch";
import { layoutMakerBars, type FinishedTurnSummary } from "@/lib/answer-status/turn-summary";
import { TurnWrittenFiles } from "../TurnWrittenFiles";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { MakerStatusPair } from "./DispatchCard";
import { useAnswerStatusText } from "./i18n";
import { elapsedText } from "./SubagentProgress";
import { EarlierAttempts, NextMark, StageNode, StageWord, stageLook, StepRows } from "./WorkFlow";

/** 막대 자리(0~1 비율)를 CSS 길이로. */
function percent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(2)}%`;
}

/**
 * 끝난 턴 아래 결과 카드. 접힌 한 줄의 기존 파일·검사·실패·Maker·남은 일·미확인 순서와 수를 유지하고
 * 판정 미확인 검사 수만 덧붙인다. 펼치면 조사 → 수정 → 검사 → 교차리뷰 → 커밋·푸시 → CI → 배포와 남은 일이 나온다.
 * Maker와 변경 파일, 검사·CI·배포 아래에는 판정이 먼저 오는 행이 붙는다. 수는 전부 도구 호출·결과·발주 원장에서
 * 온다 — 답변 글은 읽지 않는다. 가장 나중에 끝난 턴의 카드만 처음부터 펼쳐 두고, 누르면 어느 카드든 접고 편다.
 * 미확인 수는 실패·결과 미관측 검사와 실행 실패·중단·미관측 또는 수용되지 않은 Maker다.
 * 셸 exit 0이지만 검사 자체의 성공을 증명하지 못한 것은 별도 판정 미확인 수다.
 */
export function TurnSummaryLine({ summary, onOpenFile }: { summary: FinishedTurnSummary; onOpenFile?: (filePath: string) => void }) {
  const { ledger, subagents, toolResults } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  // 누르기 전에는 `latest`를 따른다. 새 턴이 끝나 이 턴이 가장 나중 것이 아니게 되면 저절로 접힌다.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? summary.latest;
  const bodyId = useId();
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
  const bars = useMemo(() => layoutMakerBars(summary.span, timings), [summary.span, timings]);
  const { flow, remaining } = summary;
  const failedChecks = summary.checks.filter((check) => check.state === "failed").length;
  const unconfirmedChecks = summary.checks.filter((check) => check.state === "failed" || check.state === "unobserved").length;
  const unverifiedVerdicts = summary.checks.filter((check) => check.state === "unverified").length;
  const unconfirmedMakers = makers.filter((maker) => (
    maker.run === "failed" || maker.run === "aborted" || maker.run === "unobserved"
    || maker.verdict?.verdict !== "accepted"
  )).length;
  const unconfirmed = unconfirmedChecks + unconfirmedMakers;
  // CI·배포 명령은 검사가 아니므로, 그것만 있던 턴도 교차리뷰 뒤 단계가 있으면 카드를 보인다.
  const laterStages = flow.steps.some((step) => step.stage === "review" || step.stage === "commit" || step.stage === "ci" || step.stage === "deploy");
  if (summary.files.length === 0 && summary.checks.length === 0 && makers.length === 0 && !remaining?.length && !laterStages) return null;

  const parts = [st("summary.files", { count: summary.files.length }), st("summary.checks", { count: summary.checks.length })];
  if (failedChecks > 0) parts.push(st("summary.checksFailed", { count: failedChecks }));
  if (makers.length > 0) parts.push(st("summary.makers", { count: makers.length }));
  if (remaining) parts.push(st("summary.remaining", { count: remaining.length }));
  if (unconfirmed > 0) parts.push(st("summary.unverified", { count: unconfirmed }));
  if (unverifiedVerdicts > 0) parts.push(st("summary.verdictUnverified", { count: unverifiedVerdicts }));

  const makerFact = makers.length > 0 && (
    <div className="flow-fact">
      <span className="flow-fact-label">Maker</span>
      <ul className="flow-fact-value flow-makers">
        {makers.map((maker, index) => {
          const bar = bars[index];
          const durationMs = timings[index].durationMs;
          const stillRunning = maker.run === "running" || maker.run === "pending" || maker.run === "dispatching";
          return (
            <li key={maker.member.key} className="answer-maker-time" data-run={maker.run}>
              <span className="answer-maker-time-name" title={maker.title}>{maker.title}</span>
              {bar && durationMs !== null ? (
                <>
                  <span className="answer-maker-time-track" aria-hidden="true">
                    <span className="answer-maker-time-bar" style={{ left: percent(bar.offset), width: percent(bar.width) }} />
                  </span>
                  <span className="answer-maker-time-value">{elapsedText(st, durationMs)}</span>
                </>
              ) : (
                <span className="answer-maker-time-missing">
                  {st(stillRunning ? "summary.time.running" : "summary.time.unobserved")}
                </span>
              )}
              <MakerStatusPair maker={maker} st={st} />
            </li>
          );
        })}
      </ul>
    </div>
  );

  return (
    <div className="answer-summary" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="answer-summary-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        title={st(open ? "summary.collapse" : "summary.expand")}
        onClick={() => setToggled(!open)}
      >
        <span className="answer-summary-text" data-unverified={unconfirmed > 0 || unverifiedVerdicts > 0 ? "" : undefined}>
          {parts.join(" · ")}
        </span>
        <svg className="answer-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="answer-summary-body" id={bodyId}>
          {flow.steps.length > 0 && (
            <section className="flow-section">
              <h4 className="flow-heading">{st("flow.heading")}</h4>
              <ol className="flow" aria-label={st("flow.aria")}>
                {flow.stages.map((view) => {
                  const look = stageLook(view, flow, false);
                  const rows = view.stage === "check" || view.stage === "ci" || view.stage === "deploy" ? view.steps : [];
                  const facts = view.stage === "edit" && (makerFact || summary.files.length > 0);
                  return (
                    <li
                      key={view.stage}
                      className="flow-stage"
                      data-state={look}
                      data-reentry={look === "active" && flow.next?.returning ? "" : undefined}
                      aria-current={look === "active" ? "step" : undefined}
                    >
                      <StageNode look={look} />
                      <span className="flow-stage-name">{st(`flow.stage.${view.stage}`)}</span>
                      <span className="flow-stage-state">
                        {look === "active" ? <NextMark view={view} flow={flow} st={st} /> : <StageWord view={view} flow={flow} live={false} st={st} />}
                      </span>
                      {(facts || rows.length > 0 || view.earlier.length > 0) && (
                        <div className="flow-stage-body">
                          {facts && (
                            <>
                              {makerFact}
                              {summary.files.length > 0 && (
                                <div className="flow-fact">
                                  <span className="flow-fact-label">{st("summary.heading.files")}</span>
                                  <div className="flow-fact-value">
                                    <TurnWrittenFiles files={summary.files} onOpenFile={onOpenFile} />
                                  </div>
                                </div>
                              )}
                            </>
                          )}
                          {(rows.length > 0 || view.earlier.length > 0) && (
                            <div className="flow-stage-rows">
                              {rows.length > 0 && <StepRows steps={rows} st={st} />}
                              <EarlierAttempts steps={view.earlier} st={st} />
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
          {remaining && (
            <section className="flow-remaining">
              <h4 className="flow-heading">{st("summary.heading.remaining")}</h4>
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
            </section>
          )}
        </div>
      )}
    </div>
  );
}
