"use client";

import { useContext, useId, useMemo, useState } from "react";
import { presentMaker, readDispatchMembers } from "@/lib/answer-status/dispatch";
import { layoutMakerBars, type FinishedTurnSummary } from "@/lib/answer-status/turn-summary";
import { TurnWrittenFiles } from "../TurnWrittenFiles";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { MakerStatusPair } from "./DispatchCard";
import { useAnswerStatusText } from "./i18n";
import { elapsedText } from "./SubagentProgress";

/** 막대 자리(0~1 비율)를 CSS 길이로. */
function percent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(2)}%`;
}

/**
 * 끝난 턴 아래 결과 카드. 접힌 한 줄에는 변경 파일·검사·Maker·남은 일·미확인 수만 보이고, 펼치면 Maker별 실행
 * 시간 막대, 파일, 검사, 남은 일, 미확인 목록이 나온다. 수는 전부 도구 호출·결과·발주 원장에서 온다 — 답변
 * 글은 읽지 않는다. 가장 나중에 끝난 턴의 카드만 처음부터 펼쳐 두고, 누르면 어느 카드든 접고 편다.
 * 미확인은 관측된 근거만 센다: 실패했거나 결과를 못 본 검사, 실행이 실패·중단·미관측인 Maker,
 * Main 판정이 수용이 아니거나 없는 Maker.
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
  const remaining = summary.remaining;
  const failedChecks = summary.checks.filter((check) => check.state === "failed");
  const unverifiedChecks = summary.checks.filter((check) => check.state !== "passed");
  const unverifiedMakers = makers.filter((maker) => (
    maker.run === "failed" || maker.run === "aborted" || maker.run === "unobserved"
    || maker.verdict?.verdict !== "accepted"
  ));
  const unverifiedCount = unverifiedChecks.length + unverifiedMakers.length;
  if (summary.files.length === 0 && summary.checks.length === 0 && makers.length === 0 && !remaining?.length) return null;

  const parts = [st("summary.files", { count: summary.files.length }), st("summary.checks", { count: summary.checks.length })];
  if (failedChecks.length > 0) parts.push(st("summary.checksFailed", { count: failedChecks.length }));
  if (makers.length > 0) parts.push(st("summary.makers", { count: makers.length }));
  if (remaining) parts.push(st("summary.remaining", { count: remaining.length }));
  if (unverifiedCount > 0) parts.push(st("summary.unverified", { count: unverifiedCount }));

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
        <span className="answer-summary-text" data-unverified={unverifiedCount > 0 ? "" : undefined}>{parts.join(" · ")}</span>
        <svg className="answer-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="answer-summary-body" id={bodyId}>
          {makers.length > 0 && (
            <section>
              <h4 className="answer-summary-heading">{st("summary.heading.makers")}</h4>
              <ul className="answer-summary-list answer-maker-times">
                {makers.map((maker, index) => {
                  const bar = bars[index];
                  const durationMs = timings[index].durationMs;
                  const ended = maker.run === "failed" || maker.run === "aborted" ? st(`run.${maker.run}`) : null;
                  const stillRunning = maker.run === "running" || maker.run === "pending" || maker.run === "dispatching";
                  return (
                    <li key={maker.member.key} className="answer-maker-time" data-run={maker.run}>
                      <span className="answer-maker-time-name" title={maker.title}>{maker.title}</span>
                      {bar && durationMs !== null ? (
                        <>
                          <span className="answer-maker-time-track" aria-hidden="true">
                            <span className="answer-maker-time-bar" style={{ left: percent(bar.offset), width: percent(bar.width) }} />
                          </span>
                          <span className="answer-maker-time-value">
                            {ended ? `${elapsedText(st, durationMs)} · ${ended}` : elapsedText(st, durationMs)}
                          </span>
                        </>
                      ) : (
                        <span className="answer-maker-time-missing">
                          {st(stillRunning ? "summary.time.running" : "summary.time.unobserved")}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {summary.files.length > 0 && (
            <section>
              <h4 className="answer-summary-heading">{st("summary.heading.files")}</h4>
              <TurnWrittenFiles files={summary.files} onOpenFile={onOpenFile} />
            </section>
          )}
          {summary.checks.length > 0 && (
            <section>
              <h4 className="answer-summary-heading">{st("summary.heading.checks")}</h4>
              <ul className="answer-summary-list">
                {summary.checks.map((check) => (
                  <li key={check.toolCallId} className="answer-check" data-state={check.state}>
                    <code className="answer-check-command" title={check.command}>{check.command}</code>
                    <span className="answer-check-result">
                      {check.exitCode !== null
                        ? st("summary.check.exit", { code: check.exitCode })
                        : st(check.state === "failed" ? "summary.check.error" : "summary.check.unobserved")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {remaining && (
            <section>
              <h4 className="answer-summary-heading">{st("summary.heading.remaining")}</h4>
              {remaining.length === 0 ? (
                <p className="answer-summary-empty">{st("summary.todo.none")}</p>
              ) : (
                <ul className="answer-summary-list">
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
          {unverifiedCount > 0 && (
            <section>
              <h4 className="answer-summary-heading">{st("summary.heading.unverified")}</h4>
              <ul className="answer-summary-list">
                {unverifiedChecks.map((check) => (
                  <li key={`check-${check.toolCallId}`}>
                    {st(check.state === "failed" ? "summary.u.checkFailed" : "summary.u.checkUnobserved", { command: check.command })}
                  </li>
                ))}
                {unverifiedMakers.map((maker) => (
                  <li key={`maker-${maker.member.key}`} className="answer-summary-maker">
                    <span className="answer-dispatch-name" title={maker.title}>{maker.title}</span>
                    <MakerStatusPair maker={maker} st={st} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
