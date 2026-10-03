"use client";

import { useContext, useId, useMemo, useState } from "react";
import { presentMaker, readDispatchMembers, type MakerPresentation, type MakerRunState } from "@/lib/answer-status/dispatch";
import type { ToolCallContent } from "@/lib/types";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { useAnswerStatusText, type AnswerStatusMessageKey, type AnswerStatusTranslate } from "./i18n";

const RUN_LABEL: Record<MakerRunState, AnswerStatusMessageKey> = {
  dispatching: "run.dispatching",
  pending: "run.pending",
  running: "run.running",
  completed: "run.completed",
  failed: "run.failed",
  aborted: "run.aborted",
  unobserved: "run.unobserved",
};

const VERDICT_LABEL: Record<"accepted" | "rework" | "held" | "none", AnswerStatusMessageKey> = {
  accepted: "verdict.accepted",
  rework: "verdict.rework",
  held: "verdict.held",
  none: "verdict.none",
};

/** Maker 실행 상태와 Main 판정을 화살표로 이은 한 줄. 둘은 서로 다른 상태다. */
export function MakerStatusPair({ maker, st }: { maker: MakerPresentation; st: AnswerStatusTranslate }) {
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
 * 서브에이전트 발주가 있는 답변 안의 접힌 카드. 접힌 상태에서도 Maker마다 업무 제목과
 * 「실행 상태 → Main 판정」 한 줄이 보이고, 펼치면 현재 단계·모델·판정 사유와 상세 패널 링크가 나온다.
 */
export function DispatchCard({ calls }: { calls: readonly ToolCallContent[] }) {
  const { ledger, subagents, toolResults, onOpenPanel, focusedDispatch } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const makers = useMemo(
    () => calls
      .flatMap((call) => readDispatchMembers(call, toolResults.get(call.toolCallId)) ?? [])
      .map((member) => presentMaker(member, subagents, ledger)),
    [calls, toolResults, subagents, ledger],
  );
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
      <ul className="answer-dispatch-list" id={bodyId}>
        {makers.map((maker) => (
          <li key={maker.member.key} className="answer-dispatch-row" data-focused={maker.member.key === focusedDispatch ? "" : undefined}>
            <div className="answer-dispatch-line">
              <span className="answer-dispatch-name" title={maker.title}>{maker.title}</span>
              <MakerStatusPair maker={maker} st={st} />
            </div>
            {open && (
              <dl className="answer-dispatch-detail">
                <div>
                  <dt>{st("detail.stage")}</dt>
                  <dd>{maker.stage ?? st("detail.stageNone")}</dd>
                </div>
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
                {maker.verdict?.reason && (
                  <div>
                    <dt>{st("detail.reason")}</dt>
                    <dd>{maker.verdict.reason}</dd>
                  </div>
                )}
              </dl>
            )}
          </li>
        ))}
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
