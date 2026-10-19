import type { CSSProperties, ReactNode } from "react";
import {
  latestChecks,
  WORK_STAGES,
  type CommandStep,
  type StageView,
  type StepOutcome,
  type WorkFlow,
  type WorkStep,
} from "@/lib/answer-status/work-flow";
import type { AnswerStatusTranslate } from "./i18n";

/**
 * 작업 흐름 표시의 공용 조각. 끝난 턴 카드의 세로 단계 줄과 입력창 위 가로 단계 줄이 같은 단계 이름, 상태 말,
 * 노드 모양, 검사 행을 쓴다. 한 상태에는 한 낱말만 쓰고, 색은 그 낱말을 거들 뿐이다.
 */

/** 단계 행의 표시 상태. 노드 모양과 글자색이 이것을 따른다. */
export type StageLook = "done" | "active" | "running" | "waiting" | "skipped" | "approval" | "unverified" | "failed";

/**
 * 끝난 턴은 다음 차례 단계 하나를, 진행 중인 턴은 지금 단계 하나를 active로 둔다. 판정이 남은 지난 단계는 노드가
 * 중립이고 글자가 판정을 전한다. 아직 오지 않은 배포는 마름모 노드다. 건너뛴 단계와 필요 없는 배포는 흐린 대시 노드다.
 */
export function stageLook(view: StageView, flow: WorkFlow, live: boolean): StageLook {
  if (live ? flow.current === view.stage : flow.next?.stage === view.stage) return "active";
  if (view.status === "waiting") return view.stage === "deploy" ? "approval" : "waiting";
  if (view.status === "skipped") return "skipped";
  if (view.status === "done" || view.status === "passed") return "done";
  if (view.status === "failed" || view.status === "running") return view.status;
  return "unverified";
}

const CHEVRON = (
  <svg className="flow-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export function StageNode({ look }: { look: StageLook }) {
  return (
    <span className="flow-node" aria-hidden="true">
      {look === "done" && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="5 12 10 17 19 7" />
        </svg>
      )}
      {look === "unverified" && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="12" y1="6" x2="12" y2="13" />
          <line x1="12" y1="18" x2="12" y2="18.5" />
        </svg>
      )}
      {look === "failed" && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="7" y1="7" x2="17" y2="17" />
          <line x1="17" y1="7" x2="7" y2="17" />
        </svg>
      )}
      {look === "skipped" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <line x1="6" y1="12" x2="18" y2="12" />
        </svg>
      )}
    </span>
  );
}

function ResultIcon({ outcome }: { outcome: StepOutcome }) {
  const common = { className: "flow-check-icon", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
  if (outcome === "passed" || outcome === "done") {
    return <svg {...common} strokeWidth={2.5}><polyline points="5 12 10 17 19 7" /></svg>;
  }
  if (outcome === "failed") {
    return <svg {...common} strokeWidth={2.5}><line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" /></svg>;
  }
  if (outcome === "running") {
    return (
      <svg {...common} strokeWidth={2}>
        <path d="M10.1 2.182a10 10 0 0 1 3.8 0" /><path d="M13.9 21.818a10 10 0 0 1-3.8 0" /><path d="M17.609 3.721a10 10 0 0 1 2.69 2.7" />
        <path d="M2.182 13.9a10 10 0 0 1 0-3.8" /><path d="M20.279 17.609a10 10 0 0 1-2.7 2.69" /><path d="M21.818 10.1a10 10 0 0 1 0 3.8" />
        <path d="M3.721 6.391a10 10 0 0 1 2.7-2.69" /><path d="M6.391 20.279a10 10 0 0 1-2.69-2.7" />
      </svg>
    );
  }
  return <svg {...common} strokeWidth={2}><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>;
}

/** 사건 하나의 판정 말. 교차리뷰는 지적 수를, 커밋은 커밋 앞 7자리를 함께 보인다. */
function StepVerdict({ step, st }: { step: WorkStep; st: AnswerStatusTranslate }) {
  let word = st(`flow.state.${step.outcome}`);
  if (step.stage === "review" && step.outcome === "failed" && step.findings !== null) {
    word = st(step.action === "resolve" ? "flow.state.open" : "flow.state.findings", { count: step.findings });
  } else if (step.stage === "review" && step.unusable) {
    word = st("flow.state.reviewUnusable");
  } else if (step.stage === "review" && step.outcome === "done") {
    word = st("flow.state.noFindings");
  }
  return (
    <span className="flow-tone" data-tone={step.outcome}>
      {word}
      {step.stage === "commit" && step.commit && <> · <code className="flow-sha">{step.commit.slice(0, 7)}</code></>}
    </span>
  );
}

function stepLabel(step: WorkStep, st: AnswerStatusTranslate): string {
  if (step.stage === "check") return step.labels.map((label) => st(`flow.label.${label}`)).join("·") || st("flow.label.check");
  if (step.stage === "review") return st(step.action === "resolve" ? "flow.label.resolve" : "flow.label.review");
  if (step.stage === "ci" || step.stage === "deploy" || step.stage === "commit") return st(`flow.label.${step.stage}`);
  return st(`flow.stage.${step.stage}`);
}

/** 펼친 검사 행: 판정 미확인이면 무엇이 확인됐고 무엇이 없는지, 그리고 원래 명령과 셸 종료 코드. */
function CommandDetail({ step, label, st }: { step: CommandStep; label: string; st: AnswerStatusTranslate }) {
  const why = step.stage === "check" ? st("flow.why.check", { label }) : st(`flow.why.${step.stage}`);
  const exit = step.exitCode !== null
    ? st("flow.exit", { code: step.exitCode })
    : st(step.outcome === "failed" ? "flow.exit.error" : step.outcome === "running" ? "flow.state.running" : "flow.exit.none");
  return (
    <div className="flow-raw">
      {step.outcome === "unverified" && (
        <p className="flow-why">
          <b>{st("flow.why.confirmed")}</b> {st("flow.why.exitZero")}
          <br />
          <b>{st("flow.why.missing")}</b> {why}
        </p>
      )}
      <code className="flow-raw-command">{step.command}</code>
      <div className="flow-exit">{exit}</div>
    </div>
  );
}

/**
 * 판정이 먼저 오는 행: 아이콘 | 판정 | 이름 | 자세히. bash 명령이 있는 행(검사·CI·배포)만 펼쳐서 원래 명령을 본다.
 * `attempts`이면 이름 앞에 회차를 붙인다.
 */
export function StepRows({ steps, st, attempts = false }: { steps: readonly WorkStep[]; st: AnswerStatusTranslate; attempts?: boolean }) {
  return (
    <ul className="flow-checks">
      {steps.map((step) => {
        const label = stepLabel(step, st);
        const head = (
          <>
            <ResultIcon outcome={step.outcome} />
            <StepVerdict step={step} st={st} />
            <span className="flow-check-label">{attempts ? `${st("flow.attempt", { attempt: step.attempt })} · ${label}` : label}</span>
          </>
        );
        if (step.stage !== "check" && step.stage !== "ci" && step.stage !== "deploy") {
          return (
            <li key={step.toolCallId} className="flow-check" data-result={step.outcome}>
              <div className="flow-check-head">{head}</div>
            </li>
          );
        }
        return (
          <li key={step.toolCallId} className="flow-check" data-result={step.outcome}>
            <details>
              <summary className="flow-check-head">
                {head}
                <span className="flow-disclose">{st("flow.details")}{CHEVRON}</span>
              </summary>
              <CommandDetail step={step} label={label} st={st} />
            </details>
          </li>
        );
      })}
    </ul>
  );
}

/** 앞 회차에 이 단계에서 있었던 일. 접어 두고, 펼치면 회차를 붙인 행으로 보인다. */
export function EarlierAttempts({ steps, st }: { steps: readonly WorkStep[]; st: AnswerStatusTranslate }) {
  if (steps.length === 0) return null;
  return (
    <details className="flow-earlier">
      <summary className="flow-earlier-toggle">{st("flow.earlier", { count: steps.length })}{CHEVRON}</summary>
      <StepRows steps={steps} st={st} attempts />
    </details>
  );
}

/** 검사 단계의 요약 말: 같은 명령은 마지막 결과만 세어 판정별 수를 주의가 필요한 것부터 보인다. */
const CHECK_COUNT_ORDER = ["failed", "unverified", "unobserved", "running", "passed"] as const;

/**
 * 단계 상태 말. 진행 중인 턴의 지금 단계는 늘 「진행 중」이다(결과가 온 뒤에도 그 단계에서 다음 일을 고르는 중이다).
 * `compact`이면 가로 단계 줄처럼 한 낱말만 보인다.
 */
export function StageWord({ view, flow, live, st, compact = false }: {
  view: StageView;
  flow: WorkFlow;
  live: boolean;
  st: AnswerStatusTranslate;
  compact?: boolean;
}): ReactNode {
  if (live && flow.current === view.stage) return st("flow.state.running");
  if (view.status === "waiting") return st("flow.state.waiting");
  // 마지막 배포는 뒤 단계가 없어 건너뛸 수 없다. 배포의 skipped는 문서만 바꾼 커밋이라 필요 없다는 뜻이다.
  if (view.status === "skipped") return st(view.stage === "deploy" ? "flow.state.notNeeded" : "flow.state.skipped");
  const latest = view.steps[view.steps.length - 1];
  if (view.stage === "investigate") return st(view.status === "running" ? "flow.state.running" : "flow.state.done");
  if (view.stage === "edit" && view.status === "done") return st(flow.attempt > 1 ? "flow.state.redone" : "flow.state.done");
  if (view.stage === "check" && !compact) {
    const counts = new Map<StepOutcome, number>();
    for (const step of latestChecks(view.steps)) counts.set(step.outcome, (counts.get(step.outcome) ?? 0) + 1);
    return CHECK_COUNT_ORDER.filter((outcome) => counts.has(outcome)).map((outcome, index) => (
      <span key={outcome}>
        {index > 0 && " · "}
        <span className="flow-tone" data-tone={outcome}>{st(`flow.count.${outcome}`, { count: counts.get(outcome) ?? 0 })}</span>
      </span>
    ));
  }
  if (view.stage === "check" || view.stage === "edit") return <span className="flow-tone" data-tone={view.status}>{st(`flow.state.${view.status}`)}</span>;
  return <StepVerdict step={latest} st={st} />;
}

/**
 * 끝난 턴의 다음 차례 단계에 붙는 말. 수정으로 돌아가는 차례면 몇 번째 수정까지 끝났는지 함께 적는다.
 */
export function NextMark({ view, flow, st }: { view: StageView; flow: WorkFlow; st: AnswerStatusTranslate }) {
  if (flow.next?.returning) {
    return (
      <>
        <span className="flow-now">{st("flow.next.returning")}</span>
        {" · "}
        {st(flow.attempt > 1 ? "flow.next.attemptDone" : "flow.next.firstDone", { attempt: flow.attempt })}
      </>
    );
  }
  const now = <span className="flow-now">{st("flow.next")}</span>;
  return view.status === "waiting" ? now : <>{now} · <StageWord view={view} flow={flow} live={false} st={st} /></>;
}

/** 입력창 위 줄의 맨 앞 말: 진행 중이면 지금 단계(2회차부터 회차도), 멈췄으면 다음 차례 단계. 둘 다 없으면 null. */
export function stripLead(flow: WorkFlow, busy: boolean, st: AnswerStatusTranslate): string | null {
  if (busy) {
    if (!flow.current) return null;
    const running = st("flow.strip.running", { stage: st(`flow.stage.${flow.current}`) });
    return flow.attempt > 1 ? `${running} · ${st("flow.attempt", { attempt: flow.attempt })}` : running;
  }
  if (!flow.next) return null;
  return flow.next.returning ? st("flow.strip.returning") : st("flow.strip.next", { stage: st(`flow.stage.${flow.next.stage}`) });
}

/**
 * 입력창 위에서 펼치는 가로 단계 줄. 수정에 되돌아온 적이 있으면 마지막으로 되돌아오게 한 단계에서 수정으로 가는
 * U자 화살표와 지금 회차를 붙이고, 그 단계의 회차별 결과를 아래에 보인다. 좁으면 세로로 쌓고 화살표 대신 글로 적는다.
 */
export function WorkFlowChain({ flow, live, st, id }: { flow: WorkFlow; live: boolean; st: AnswerStatusTranslate; id: string }) {
  const loop = flow.loops[flow.loops.length - 1];
  const loopSteps = loop ? flow.steps.filter((step) => step.stage === loop.from) : [];
  const badge = st("flow.loop.badge", { attempt: flow.attempt });
  return (
    <div className="flow-chain-panel" id={id}>
      <div
        className="flow-chain-wrap"
        data-loop={loop ? "" : undefined}
        style={loop ? { "--loop-from": WORK_STAGES.indexOf(loop.from) } as CSSProperties : undefined}
      >
        <ol className="flow-chain" aria-label={st("flow.aria")}>
          {flow.stages.map((view) => {
            const look = stageLook(view, flow, live);
            return (
              <li key={view.stage} className="flow-link" data-state={look} aria-current={look === "active" ? "step" : undefined}>
                <StageNode look={look} />
                <span className="flow-link-name">{st(`flow.stage.${view.stage}`)}</span>
                <span className="flow-link-state">
                  {!live && look === "active" ? st("flow.next") : <StageWord view={view} flow={flow} live={live} st={st} compact />}
                </span>
              </li>
            );
          })}
        </ol>
        {loop && (
          <>
            <div className="flow-loop" aria-hidden="true">
              <svg width="22" height="15" viewBox="0 0 22 15">
                <polyline points="3 12 11 3 19 12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="flow-loop-count">{badge}</span>
            </div>
            <p className="flow-loop-caption">
              <span className="flow-loop-caption-count">{badge}</span>
              {st(loop.from === "review" ? "flow.loop.findings" : "flow.loop.failed", { stage: st(`flow.stage.${loop.from}`), attempt: loop.attempt })}
            </p>
          </>
        )}
      </div>
      {loopSteps.length > 0 && (
        <div className="flow-chain-attempts">
          <StepRows steps={loopSteps} st={st} attempts />
        </div>
      )}
    </div>
  );
}
