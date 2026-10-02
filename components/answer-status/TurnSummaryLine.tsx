"use client";

import { useContext, useId, useMemo, useState } from "react";
import { presentMaker, readDispatchMembers } from "@/lib/answer-status/dispatch";
import type { TurnSummary } from "@/lib/answer-status/turn-summary";
import { TurnWrittenFiles } from "../TurnWrittenFiles";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { MakerStatusPair } from "./DispatchCard";
import { useAnswerStatusText } from "./i18n";

/**
 * 끝난 턴 아래 한 줄 요약. 변경 파일·실행한 검사·미확인 수만 보이고 펼치면 목록이 나온다.
 * 미확인은 관측된 근거만 센다: 실패했거나 결과를 못 본 검사, 실행이 실패·중단·미관측인 Maker,
 * Main 판정이 수용이 아니거나 없는 Maker.
 */
export function TurnSummaryLine({ summary, onOpenFile }: { summary: TurnSummary; onOpenFile?: (filePath: string) => void }) {
  const { ledger, subagents, toolResults } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const makers = useMemo(
    () => summary.dispatchCalls
      .flatMap((call) => readDispatchMembers(call, toolResults.get(call.toolCallId)) ?? [])
      .map((member) => presentMaker(member, subagents, ledger)),
    [summary.dispatchCalls, toolResults, subagents, ledger],
  );
  const failedChecks = summary.checks.filter((check) => check.state === "failed");
  const unverifiedChecks = summary.checks.filter((check) => check.state !== "passed");
  const unverifiedMakers = makers.filter((maker) => (
    maker.run === "failed" || maker.run === "aborted" || maker.run === "unobserved"
    || maker.verdict?.verdict !== "accepted"
  ));
  const unverifiedCount = unverifiedChecks.length + unverifiedMakers.length;
  if (summary.files.length === 0 && summary.checks.length === 0 && makers.length === 0) return null;

  const parts = [st("summary.files", { count: summary.files.length }), st("summary.checks", { count: summary.checks.length })];
  if (failedChecks.length > 0) parts.push(st("summary.checksFailed", { count: failedChecks.length }));
  if (unverifiedCount > 0) parts.push(st("summary.unverified", { count: unverifiedCount }));

  return (
    <div className="answer-summary">
      <button
        type="button"
        className="answer-summary-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        title={st(open ? "summary.collapse" : "summary.expand")}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="answer-summary-text" data-unverified={unverifiedCount > 0 ? "" : undefined}>{parts.join(" · ")}</span>
        <svg className="answer-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="answer-summary-body" id={bodyId}>
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
