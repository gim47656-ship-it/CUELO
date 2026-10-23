"use client";

import { useContext, useId, useMemo, useState } from "react";
import { pickDeliverables } from "@/lib/answer-status/deliverables";
import { presentMaker, readDispatchMembers } from "@/lib/answer-status/dispatch";
import type { FinishedTurnSummary } from "@/lib/answer-status/turn-summary";
import { latestChecks } from "@/lib/answer-status/work-flow";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { FlowGraph } from "./FlowGraph";
import { ResultPreview } from "./ResultPreview";
import { useAnswerStatusText } from "./i18n";

/**
 * 요청 아래 결과 카드. 접힌 한 줄의 기존 파일·검사·실패·Maker·남은 일·미확인 순서와 수를 유지하고
 * 판정 미확인 검사 수, 수정 전에 통과한 검사 수, 여러 단계를 묶어 실패한 명령 수를 덧붙인다. 펼치면 작업 흐름 그래프
 * (`FlowGraph`)와 남은 일이 나온다. 수는 전부 도구 호출·결과·발주 원장에서 온다 — 답변 글은 읽지 않는다. 가장 나중에
 * 끝난 요청의 카드만 처음부터 펼쳐 두고, 누르면 어느 카드든 접고 편다.
 * 미확인 수는 실패·결과 미관측 검사와 실행 실패·중단·미관측 또는 수용되지 않은 Maker다.
 * 셸 exit 0이지만 검사 자체의 성공을 증명하지 못한 것은 별도 판정 미확인 수다. 기록된 작업 단계가 있으면(조사만이어도)
 * 카드와 그래프를 남긴다.
 * `live`이면 지금 실행 중인 요청의 카드다. 맨 앞에 진행 중이라고 적고, 아직 결과가 오지 않은 검사·Maker를 미확인으로 세지 않는다.
 * 끝난 턴이 화면·문서·이미지 결과물(`pickDeliverables`)을 만들었으면 그 미리보기와 「결과 보기」를 수보다 먼저 두고,
 * 과정(그래프·남은 일)은 가장 나중 턴이어도 접어 두었다가 누르면 편다.
 */
export function TurnSummaryLine({ summary, live = false, onOpenFile }: {
  summary: FinishedTurnSummary;
  live?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const { ledger, subagents, toolResults } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  // 누르기 전에는 `latest`를 따른다. 새 턴이 끝나 이 턴이 가장 나중 것이 아니게 되면 저절로 접힌다.
  // 결과물이 있으면 결과가 앞이고 과정은 필요할 때 편다.
  const deliverables = useMemo(() => (live ? [] : pickDeliverables(summary.files)), [live, summary.files]);
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? (summary.latest && deliverables.length === 0);
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
  const { flow, remaining } = summary;
  const failedChecks = summary.checks.filter((check) => check.state === "failed").length;
  const unconfirmedChecks = summary.checks.filter((check) => check.state === "failed" || check.state === "unobserved").length;
  const compoundFailed = summary.checks.filter((check) => check.compound?.failed).length;
  const unverifiedVerdicts = summary.checks.filter((check) => check.state === "unverified" && !check.compound?.failed).length;
  const staleChecks = latestChecks(flow.steps).filter((step) => step.stale).length;
  const unconfirmedMakers = makers.filter((maker) => (
    maker.run === "failed" || maker.run === "aborted" || maker.run === "unobserved"
    || maker.verdict?.verdict !== "accepted"
  )).length;
  const unconfirmed = unconfirmedChecks + unconfirmedMakers;
  // 기록된 작업 단계가 하나라도 있으면(조사만 했어도) 끝난 뒤에도 선으로 이어진 그래프를 남긴다.
  // 단계도 파일·검사·Maker·남은 일도 없는 대화만 숨긴다. 실행 중 카드는 단계가 생기기 전에는 보이지 않는다.
  if (flow.steps.length === 0 && (live || (summary.files.length === 0 && summary.checks.length === 0 && makers.length === 0 && !remaining?.length))) return null;

  const parts = [
    st(summary.files.length === 1 ? "summary.files.one" : "summary.files", { count: summary.files.length }),
    st(summary.checks.length === 1 ? "summary.checks.one" : "summary.checks", { count: summary.checks.length }),
  ];
  if (live) parts.unshift(st("summary.live"));
  if (failedChecks > 0) parts.push(st("summary.checksFailed", { count: failedChecks }));
  if (compoundFailed > 0) parts.push(st("summary.compoundFailed", { count: compoundFailed }));
  if (makers.length > 0) parts.push(st(makers.length === 1 ? "summary.makers.one" : "summary.makers", { count: makers.length }));
  if (remaining) parts.push(st("summary.remaining", { count: remaining.length }));
  if (!live && unconfirmed > 0) parts.push(st("summary.unverified", { count: unconfirmed }));
  if (unverifiedVerdicts > 0) parts.push(st(unverifiedVerdicts === 1 ? "summary.verdictUnverified.one" : "summary.verdictUnverified", { count: unverifiedVerdicts }));
  if (staleChecks > 0) parts.push(st("summary.stale", { count: staleChecks }));
  const attention = (!live && unconfirmed > 0) || failedChecks > 0 || unverifiedVerdicts > 0 || compoundFailed > 0 || staleChecks > 0;

  return (
    <div className="answer-summary" data-open={open ? "" : undefined} data-live={live ? "" : undefined} data-result={deliverables.length > 0 ? "" : undefined}>
      {deliverables.length > 0 && <ResultPreview deliverables={deliverables} onOpenFile={onOpenFile} />}
      <button
        type="button"
        className="answer-summary-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        title={st(open ? "summary.collapse" : "summary.expand")}
        onClick={() => setToggled(!open)}
      >
        <span className="answer-summary-text" data-unverified={attention ? "" : undefined}>
          {parts.join(" · ")}
        </span>
        <svg className="answer-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <div className="answer-summary-body" id={bodyId}>
          {flow.steps.length > 0 && <FlowGraph summary={summary} makers={makers} timings={timings} live={live} onOpenFile={onOpenFile} />}
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
