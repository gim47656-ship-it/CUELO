import type { CSSProperties, ReactNode } from "react";
import {
  isCompoundFailure,
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
 * 작업 흐름 표시의 공용 조각. 끝난 턴 카드의 그래프와 입력창 위 가로 단계 줄이 같은 단계 이름, 상태 말,
 * 노드 모양, 검사 행을 쓴다. 한 상태에는 한 낱말만 쓰고, 색은 그 낱말을 거들 뿐이다.
 */

/** 단계 행의 표시 상태. 노드 모양과 글자색이 이것을 따른다. */
export type StageLook = "done" | "active" | "running" | "waiting" | "skipped" | "approval" | "stale" | "unverified" | "failed";

/**
 * 진행 중인 턴은 지금 단계 하나를 active로 둔다. 끝난 턴에는 active가 없다 — 다음 차례도 진행 중도 없다. 판정이 남은 지난
 * 단계는 노드가 중립이고 글자가 판정을 전한다. 아직 오지 않은 배포는 마름모 노드다. 건너뛴 단계와 필요 없는 단계는 흐린 대시
 * 노드다. 수정 전에 통과한 단계는 점선 체크 노드다 — 마지막 수정본을 보증하지 않는다.
 */
export function stageLook(view: StageView, flow: WorkFlow, live: boolean): StageLook {
  if (live && flow.current === view.stage) return "active";
  if (view.status === "waiting") return view.stage === "deploy" ? "approval" : "waiting";
  if (view.status === "skipped" || view.status === "notNeeded") return "skipped";
  if (view.status === "stale") return "stale";
  if (view.status === "done" || view.status === "passed") return "done";
  if (view.status === "failed" || view.status === "running") return view.status;
  return "unverified";
}

/** 사건 하나의 표시 판정: 수정 전에 통과·완료한 것은 stale이다. */
function stepTone(step: WorkStep): StepOutcome | "stale" {
  return step.stale ? "stale" : step.outcome;
}

const CHEVRON = (
  <svg className="flow-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="6 9 12 15 18 9" />
  </svg>
);

export function StageNode({ look }: { look: StageLook }) {
  return (
    <span className="flow-node" aria-hidden="true">
      {(look === "done" || look === "stale") && (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" strokeDasharray={look === "stale" ? "3 4" : undefined}>
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

function ResultIcon({ outcome }: { outcome: StepOutcome | "stale" }) {
  const common = { className: "flow-check-icon", width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true } as const;
  if (outcome === "stale") {
    return <svg {...common} strokeWidth={2}><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l4 2" /></svg>;
  }
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

/** 사건 하나의 판정 말. 교차리뷰는 지적 수를, 커밋은 커밋 앞 7자리를 함께 보인다. 수정 전 통과·완료는 그렇게 적는다. */
function StepVerdict({ step, st }: { step: WorkStep; st: AnswerStatusTranslate }) {
  let word = st(`flow.state.${step.outcome}`);
  if (step.stale) {
    word = st(step.outcome === "passed" ? "flow.state.stale" : "flow.state.staleDone");
  } else if (step.stage === "review" && step.outcome === "failed" && step.findings !== null) {
    const findingsKey = step.findings === 1 ? "flow.state.findings.one" : "flow.state.findings";
    word = st(step.action === "resolve" ? "flow.state.open" : findingsKey, { count: step.findings });
  } else if (step.stage === "review" && step.unusable) {
    word = st("flow.state.reviewUnusable");
  } else if (step.stage === "review" && step.outcome === "done") {
    word = st("flow.state.noFindings");
  }
  return (
    <span className="flow-tone" data-tone={stepTone(step)}>
      {word}
      {step.stage === "commit" && step.commit && <> <span className="flow-sha-tail">·&nbsp;<code className="flow-sha">{step.commit.slice(0, 7)}</code></span></>}
    </span>
  );
}

function stepLabel(step: WorkStep, st: AnswerStatusTranslate): string {
  if (step.stage === "check") return step.labels.map((label) => st(`flow.label.${label}`)).join("·") || st("flow.label.check");
  if (step.stage === "review") return st(step.action === "resolve" ? "flow.label.resolve" : "flow.label.review");
  if (step.stage === "ci" || step.stage === "deploy" || step.stage === "commit") return st(`flow.label.${step.stage}`);
  return st(`flow.stage.${step.stage}`);
}

/**
 * 펼친 검사 행: 판정 미확인이면 무엇이 확인됐고 무엇이 없는지, 그리고 원래 명령과 셸 종료 코드. 여러 단계를 한 명령으로
 * 돌려 실패했으면 명령 전체의 실패만 확인됐고, 어느 단계의 실패인지는 없다. 기다린 실행이 이 커밋의 CI가 아니었으면 그 실행이
 * 끝난 결과만 확인됐다. 셸 종료 코드가 아닌 기록(echo한 종료 코드, 백그라운드 job의 완료, 배포 로그 줄, 이어진 CI 실행)으로
 * 판정했으면 그 기록 한 줄을 함께 보인다.
 */
function CommandDetail({ step, label, st }: { step: CommandStep; label: string; st: AnswerStatusTranslate }) {
  const compoundFailed = isCompoundFailure(step);
  const stages = step.compound?.stages.map((stage) => st(`flow.stage.${stage}`)).join("·") ?? "";
  const other = step.otherRun;
  const confirmed = compoundFailed ? st("flow.why.compoundConfirmed", { stages })
    : other?.kind === "unjudged" ? st("flow.why.watched.unjudged", { conclusion: other.conclusion })
    : other ? st(`flow.why.watched.${other.outcome}`)
    : st("flow.why.exitZero");
  const why = compoundFailed ? st("flow.why.compoundMissing")
    : step.stage === "check" ? st("flow.why.check", { label })
    : other?.kind === "commit" ? st("flow.why.ciOtherRun", { sha: other.sha })
    : other?.kind === "publish" ? st("flow.why.ciPublishRun")
    : other?.kind === "unjudged" ? st("flow.why.ciUnjudged", { conclusion: other.conclusion })
    : st(`flow.why.${step.stage}`);
  const exit = step.exitCode !== null
    ? st("flow.exit", { code: step.exitCode })
    : st(step.outcome === "failed" ? "flow.exit.error" : step.outcome === "running" ? "flow.state.running" : "flow.exit.none");
  return (
    <div className="flow-raw">
      {step.outcome === "unverified" && (
        <p className="flow-why">
          <b>{st("flow.why.confirmed")}</b> {confirmed}
          <br />
          <b>{st("flow.why.missing")}</b> {why}
        </p>
      )}
      {step.stale && <p className="flow-why">{st("flow.why.stale")}</p>}
      {step.commandKey === undefined
        ? <code className="flow-raw-command">{step.command}</code>
        : <p className="flow-why">{st("flow.commandOmitted")}</p>}
      <div className="flow-exit">{exit}</div>
      {step.evidence && <div className="flow-exit">{st("flow.evidence")} <code className="flow-evidence">{step.evidence}</code></div>}
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
        const tone = stepTone(step);
        const head = (
          <>
            <ResultIcon outcome={tone} />
            <StepVerdict step={step} st={st} />
            <span className="flow-check-label">
              {attempts ? `${st("flow.attempt", { attempt: step.attempt })} · ${label}` : label}
              {isCompoundFailure(step) && <span className="flow-compound">{st("flow.compound.failed")}</span>}
            </span>
          </>
        );
        if (step.stage !== "check" && step.stage !== "ci" && step.stage !== "deploy") {
          return (
            <li key={step.toolCallId} className="flow-check" data-result={tone}>
              <div className="flow-check-head">{head}</div>
            </li>
          );
        }
        return (
          <li key={`${step.toolCallId}#${step.stage}`} className="flow-check" data-result={tone}>
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
const CHECK_COUNT_ORDER = ["failed", "unverified", "unobserved", "stale", "running", "passed"] as const;

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
  if (view.status === "skipped" || view.status === "notNeeded") return st(`flow.state.${view.status}`);
  const latest = view.steps[view.steps.length - 1];
  if (view.stage === "investigate") return st(view.status === "running" ? "flow.state.running" : "flow.state.done");
  if (view.stage === "edit" && view.status === "done") return st(flow.attempt > 1 ? "flow.state.redone" : "flow.state.done");
  if (view.stage === "check" && !compact) {
    const counts = new Map<StepOutcome | "stale", number>();
    for (const step of latestChecks(view.steps)) counts.set(stepTone(step), (counts.get(stepTone(step)) ?? 0) + 1);
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

/** 입력창 위 줄의 맨 앞 말: 진행 중일 때만 지금 단계(2회차부터 회차도). 끝난 턴이나 단계가 없으면 null. */
export function stripLead(flow: WorkFlow, busy: boolean, st: AnswerStatusTranslate): string | null {
  if (!busy || !flow.current) return null;
  const running = st("flow.strip.running", { stage: st(`flow.stage.${flow.current}`) });
  return flow.attempt > 1 ? `${running} · ${st("flow.attempt", { attempt: flow.attempt })}` : running;
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
                  <StageWord view={view} flow={flow} live={live} st={st} compact />
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
