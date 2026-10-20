import { useContext, useId, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { findExactLiveSnapshot, type MakerPresentation } from "@/lib/answer-status/dispatch";
import { buildFlowGraph, type GraphMaker } from "@/lib/answer-status/flow-graph";
import type { FinishedTurnSummary, MakerTiming } from "@/lib/answer-status/turn-summary";
import { isCompoundFailure, WORK_STAGES, type StageView, type WorkFlow, type WorkStage } from "@/lib/answer-status/work-flow";
import { TurnWrittenFiles } from "../TurnWrittenFiles";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { MakerStatusPair, VERDICT_LABEL } from "./DispatchCard";
import { useAnswerStatusText, type AnswerStatusTranslate } from "./i18n";
import { elapsedText } from "./SubagentProgress";
import { EarlierAttempts, NextMark, StageNode, StageWord, stageLook, StepRows } from "./WorkFlow";

/** 그래프에서 고를 수 있는 노드: 단계, Maker 하나, 변경 파일 묶음, 변경 문서 묶음. */
type NodeKey = `stage:${WorkStage}` | `maker:${string}` | "files" | "docs";

/** 막대 자리(0~1 비율)를 CSS 길이로. */
function percent(value: number): string {
  return `${(Math.min(1, Math.max(0, value)) * 100).toFixed(2)}%`;
}

/** 자세히 볼 기록이 있는 단계. 조사는 호출 수 말고 보일 것이 없어 고를 수 없다. */
function stageHasDetail(view: StageView, flow: WorkFlow, fileCount: number): boolean {
  if (view.stage === "investigate") return false;
  if (view.stage === "edit") return fileCount > 0 || view.earlier.length > 0;
  return view.steps.length > 0 || view.earlier.length > 0 || (view.stage === "ci" && flow.publication !== null);
}

/**
 * 처음 펼친 자세히: 수정으로 되돌아가는 차례면 되돌아오게 한 단계, 아니면 실패·판정 미확인·수정 전 통과 단계,
 * 그것도 없으면 기록이 있는 가장 뒤 단계. 고를 노드가 없으면 null.
 */
function defaultNode(flow: WorkFlow, fileCount: number): NodeKey | null {
  const selectable = flow.stages.filter((view) => stageHasDetail(view, flow, fileCount));
  const loop = flow.loops[flow.loops.length - 1];
  const pick = (flow.next?.returning && loop ? selectable.find((view) => view.stage === loop.from) : undefined)
    ?? selectable.find((view) => view.status === "failed")
    ?? selectable.find((view) => view.status === "unverified" || view.status === "stale")
    ?? selectable[selectable.length - 1];
  if (pick) return `stage:${pick.stage}`;
  return fileCount > 0 ? "files" : null;
}

/**
 * 실행 중인 그래프의 움직임을 멈춘 사용자 선택(WCAG 2.2.2). 실행이 끝나 카드가 다시 그려져도 이어지도록 이 브라우저에 남긴다.
 */
const MOTION_STORAGE_KEY = "omp-web:flow-motion";
const motionListeners = new Set<() => void>();
let motionPaused: boolean | null = null;

function readMotionPaused(): boolean {
  if (motionPaused === null) {
    try {
      motionPaused = window.localStorage.getItem(MOTION_STORAGE_KEY) === "paused";
    } catch {
      motionPaused = false;
    }
  }
  return motionPaused;
}

function subscribeMotion(listener: () => void): () => void {
  motionListeners.add(listener);
  return () => {
    motionListeners.delete(listener);
  };
}

function setMotionPaused(paused: boolean): void {
  motionPaused = paused;
  try {
    if (paused) window.localStorage.setItem(MOTION_STORAGE_KEY, "paused");
    else window.localStorage.removeItem(MOTION_STORAGE_KEY);
  } catch {
    // 저장하지 못해도 이 화면에서는 멈춘 채로 둔다.
  }
  for (const listener of motionListeners) listener();
}

function MakerTime({ entry, st }: { entry: GraphMaker; st: AnswerStatusTranslate }) {
  const stillRunning = entry.maker.run === "running" || entry.maker.run === "pending" || entry.maker.run === "dispatching";
  if (!entry.bar || entry.durationMs === null) {
    return <span className="flow-graph-time-missing">{st(stillRunning ? "summary.time.running" : "summary.time.unobserved")}</span>;
  }
  return (
    <>
      <span className="flow-graph-track" aria-hidden="true">
        <span className="flow-graph-bar" style={{ left: percent(entry.bar.offset), width: percent(entry.bar.width) }} />
      </span>
      <span className="flow-graph-time">{elapsedText(st, entry.durationMs)}</span>
    </>
  );
}

/**
 * Maker 종류(TASK_GUARD의 WORK_CLASS, 없으면 미기록)와, 여럿이면 동시 실행 관측. `batch`이면 같은 발주 묶음인지도 적는다.
 * 모르는 값은 점선 칩이다.
 */
function MakerTags({ entry, together, batch = false, st }: { entry: GraphMaker; together: boolean; batch?: boolean; st: AnswerStatusTranslate }) {
  const workClass = entry.maker.member.workClass;
  return (
    <span className="flow-graph-maker-tags">
      <span className="flow-graph-chip" data-unknown={workClass ? undefined : ""}>{st(`graph.kind.${workClass ?? "unknown"}`)}</span>
      {batch && entry.batchSize > 1 && <span className="flow-graph-chip">{st("graph.parallel.batch")}</span>}
      {together && (
        <span className="flow-graph-chip" data-unknown={entry.concurrency === "unknown" ? "" : undefined} data-concurrency={entry.concurrency}>
          {st(`graph.concurrency.${entry.concurrency}`)}
        </span>
      )}
    </span>
  );
}

/** 노드 단추. 기록이 없는 노드는 단추가 아니라 글이다. */
function NodeButton({ selectable, selected, detailId, onSelect, className, children, style }: {
  selectable: boolean;
  selected: boolean;
  detailId: string;
  onSelect: () => void;
  className: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  if (!selectable) return <div className={className} style={style}>{children}</div>;
  return (
    <button type="button" className={className} style={style} aria-pressed={selected} aria-controls={detailId} onClick={onSelect}>
      {children}
    </button>
  );
}

/**
 * 요청 카드의 작업 흐름 그래프. 위 줄은 조사 → 수정 → 검사 → 교차리뷰 → 커밋·푸시 → CI → 배포 단계 노드이고,
 * 수정 단계에서 맡긴 Maker는 그 아래 갈래로, 수정에 되돌아온 일은 되돌아오게 한 단계에서 수정으로 가는 화살표로,
 * 바꾼 파일과 문서는 마지막 결과 노드로 붙는다. 노드를 누르면 아래 한 자리에 그 노드의 실제 기록이 나온다.
 * 동시 실행은 같은 wait 스냅샷에서 함께 실행 중이었거나 지금 둘 다 실행 중일 때만 말하고, 같은 발주 묶음은 그렇게만 적는다.
 * 움직임은 실제로 지금 도는 길에만 있다. `live`(이 요청이 실행 중)이면 지금 단계로 들어오는 연결선, 되돌아온 뒤 수정 중이면
 * 되돌아온 화살표가 흐르고, 지금 실행 중인 Maker 갈래는 끝난 카드에서도 흐른다. 끝나면 선만 남는다. 움직임 멈춤 단추와
 * 동작 줄이기 설정에서는 멈춘다. 좁으면 세로 두 칸으로 쌓는다.
 */
export function FlowGraph({ summary, makers, timings, live = false, onOpenFile }: {
  summary: FinishedTurnSummary;
  makers: readonly MakerPresentation[];
  timings: readonly MakerTiming[];
  /** 이 요청이 지금 실행 중이다(세션이 바쁘다). 지금 단계가 「진행 중」이고 그 단계로 들어오는 길이 흐른다. */
  live?: boolean;
  onOpenFile?: (filePath: string) => void;
}) {
  const { subagents, onOpenMaker } = useContext(AnswerStatusContext);
  const { st } = useAnswerStatusText();
  const detailId = useId();
  const { flow } = summary;
  const graph = useMemo(() => buildFlowGraph(makers, timings, summary.span, summary.files), [makers, timings, summary.span, summary.files]);
  const [chosen, setChosen] = useState<NodeKey | null>(null);
  const paused = useSyncExternalStore(subscribeMotion, readMotionPaused, () => false);
  const fileCount = summary.files.length;
  const currentView = live && flow.current ? flow.stages.find((view) => view.stage === flow.current) : undefined;
  // 실행 중이면 처음 자세히는 지금 단계다(볼 기록이 있을 때).
  const selected = chosen
    ?? (currentView && stageHasDetail(currentView, flow, fileCount) ? `stage:${currentView.stage}` as const : defaultNode(flow, fileCount));
  const loop = flow.loops[flow.loops.length - 1];
  const loopFrom = loop ? WORK_STAGES.indexOf(loop.from) : -1;
  const editIndex = WORK_STAGES.indexOf("edit");
  const currentIndex = currentView ? WORK_STAGES.indexOf(currentView.stage) : -1;
  // 되돌아온 길이 흐르는 때: 실행 중이고, 마지막 되돌아옴 다음 회차의 수정을 지금 하고 있다.
  const returning = live && loop !== undefined && flow.current === "edit" && flow.attempt === loop.attempt + 1;
  const makerFlowing = graph.makers.some((entry) => entry.liveRunning);
  const moving = currentIndex >= 0 || makerFlowing;

  // 갈래가 Main으로 돌아오는 자리: Maker마다 Main 판정(routing_verdict)을 센다. 실행 완료만으로는 수용이 아니다.
  const verdictCounts = new Map<keyof typeof VERDICT_LABEL, number>();
  for (const entry of graph.makers) {
    const verdict = entry.maker.verdict?.verdict ?? "none";
    verdictCounts.set(verdict, (verdictCounts.get(verdict) ?? 0) + 1);
  }
  const allAccepted = verdictCounts.size === 1 && verdictCounts.has("accepted");
  const branch = graph.makers.length > 0 && (
    <li key="branch" className="flow-graph-branch" data-flowing={makerFlowing ? "" : undefined}>
      <p className="flow-graph-branch-head">
        <span>{st("graph.branch", { count: graph.makers.length })}</span>
        {graph.parallel !== "none" && <span className="flow-graph-chip" data-parallel={graph.parallel}>{st(`graph.parallel.${graph.parallel}`)}</span>}
      </p>
      <ul className="flow-graph-lanes">
        {graph.makers.map((entry) => {
          const key: NodeKey = `maker:${entry.maker.member.key}`;
          return (
            <li key={entry.maker.member.key} className="flow-graph-lane" data-run={entry.maker.run} data-live={entry.liveRunning ? "" : undefined}>
              <NodeButton selectable selected={selected === key} detailId={detailId} onSelect={() => setChosen(key)} className="flow-graph-maker">
                <span className="flow-graph-maker-name" title={entry.maker.title}>{entry.maker.title}</span>
                <MakerTags entry={entry} together={graph.makers.length > 1} st={st} />
                <span className="flow-graph-maker-time"><MakerTime entry={entry} st={st} /></span>
                <MakerStatusPair maker={entry.maker} st={st} />
                {entry.liveRunning && <span className="flow-graph-packet" aria-hidden="true" />}
              </NodeButton>
            </li>
          );
        })}
      </ul>
      <p className="flow-graph-join" data-state={allAccepted ? "done" : "unverified"}>
        <StageNode look={allAccepted ? "done" : "unverified"} />
        <span className="flow-graph-join-label">{st("graph.join")}</span>
        <span className="flow-graph-join-counts">
          {(["accepted", "rework", "held", "none"] as const).filter((verdict) => verdictCounts.has(verdict)).map((verdict) => (
            <span key={verdict} className="answer-status-verdict" data-verdict={verdict}>{st(VERDICT_LABEL[verdict])} {verdictCounts.get(verdict)}</span>
          ))}
        </span>
      </p>
    </li>
  );

  const returnEdge = loop && (
    <li key="return" className="flow-graph-return" data-flowing={returning ? "" : undefined} style={{ "--from": editIndex + 1, "--to": loopFrom + 1 } as CSSProperties}>
      <span className="flow-graph-return-line" aria-hidden="true">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="5 12 12 5 19 12" />
        </svg>
      </span>
      <span className="flow-graph-return-text">
        <b>{st("flow.loop.badge", { attempt: flow.attempt })}</b>
        {" "}
        {st(loop.from === "review" ? "flow.loop.findings" : "flow.loop.failed", { stage: st(`flow.stage.${loop.from}`), attempt: loop.attempt })}
      </span>
    </li>
  );

  const stations = flow.stages.map((view, index) => {
    const look = stageLook(view, flow, live);
    const key: NodeKey = `stage:${view.stage}`;
    const compound = view.steps.some(isCompoundFailure);
    return (
      <li
        key={view.stage}
        className="flow-graph-station"
        data-stage={view.stage}
        data-state={look}
        data-reentry={look === "active" && !live && flow.next?.returning ? "" : undefined}
        data-feeds={currentIndex > 0 && index === currentIndex - 1 ? "" : undefined}
        aria-current={look === "active" ? "step" : undefined}
        style={{ "--col": index + 1 } as CSSProperties}
      >
        <StageNode look={look} />
        <NodeButton selectable={stageHasDetail(view, flow, fileCount)} selected={selected === key} detailId={detailId} onSelect={() => setChosen(key)} className="flow-graph-stop">
          <span className="flow-graph-stop-name">{st(`flow.stage.${view.stage}`)}</span>
          <span className="flow-graph-stop-state">
            {look === "active" && !live ? <NextMark view={view} flow={flow} st={st} /> : <StageWord view={view} flow={flow} live={live} st={st} />}
          </span>
          {compound && <span className="flow-compound">{st("flow.compound.failed")}</span>}
        </NodeButton>
      </li>
    );
  });

  // 읽는 차례(좁은 화면의 세로 차례, 키보드 차례)대로: 수정 뒤에 Maker 갈래, 되돌아오게 한 단계 뒤에 되돌아온 화살표.
  const items: ReactNode[] = [];
  stations.forEach((station, index) => {
    items.push(station);
    if (index === editIndex && branch) items.push(branch);
    if (index === loopFrom && returnEdge) items.push(returnEdge);
  });

  let detail: ReactNode = null;
  if (selected?.startsWith("stage:")) {
    const view = flow.stages.find((entry) => `stage:${entry.stage}` === selected);
    if (view) {
      const rows = view.stage === "edit" ? [] : view.steps;
      detail = (
        <>
          <h5 className="flow-graph-detail-title">{st(`flow.stage.${view.stage}`)}</h5>
          {view.stage === "ci" && flow.publication && (
            <p className="flow-graph-note">
              {st("flow.ci.notNeeded", {
                run: flow.publication.runId,
                repo: flow.publication.repo,
                ref: flow.publication.ref,
                sha: flow.publication.sha.slice(0, 7),
              })}
            </p>
          )}
          {view.stage === "edit" && <TurnWrittenFiles files={summary.files} onOpenFile={onOpenFile} />}
          {rows.length > 0 && <StepRows steps={rows} st={st} />}
          <EarlierAttempts steps={view.earlier} st={st} />
        </>
      );
    }
  } else if (selected?.startsWith("maker:")) {
    const entry = graph.makers.find((candidate) => `maker:${candidate.maker.member.key}` === selected);
    if (entry) {
      const exact = findExactLiveSnapshot(entry.maker.member, subagents);
      detail = (
        <>
          <h5 className="flow-graph-detail-title">{entry.maker.title}</h5>
          <MakerTags entry={entry} together={graph.makers.length > 1} batch st={st} />
          <p className="flow-graph-detail-line"><MakerStatusPair maker={entry.maker} st={st} /></p>
          <div className="flow-graph-maker-time"><MakerTime entry={entry} st={st} /></div>
          {exact && onOpenMaker ? (
            <button
              type="button"
              className="flow-graph-open"
              onClick={() => onOpenMaker({
                key: `live:${exact.id}`,
                toolCallId: entry.maker.member.toolCallId,
                origin: entry.maker.member.key,
                status: { run: entry.maker.run, verdict: entry.maker.verdict },
              })}
            >
              {st("graph.maker.open")}
            </button>
          ) : (
            <p className="flow-graph-note">{st("graph.maker.unavailable")}</p>
          )}
        </>
      );
    }
  } else if (selected === "files" || selected === "docs") {
    detail = (
      <>
        <h5 className="flow-graph-detail-title">{st(selected === "files" ? "graph.files" : "graph.docs", { count: (selected === "files" ? graph.files : graph.docs).length })}</h5>
        <TurnWrittenFiles files={selected === "files" ? graph.files : graph.docs} onOpenFile={onOpenFile} />
      </>
    );
  }

  return (
    <section className="flow-section">
      <div className="flow-graph-head">
        <h4 className="flow-heading">{st("flow.heading")}</h4>
        {moving && (
          <button type="button" className="flow-graph-motion" aria-pressed={paused} onClick={() => setMotionPaused(!paused)}>
            {st("graph.motion.pause")}
          </button>
        )}
      </div>
      <div className="flow-graph-frame">
        <ol className="flow-graph" aria-label={st("flow.aria")} data-live={live ? "" : undefined} data-motion={paused ? "paused" : undefined}>
          {items}
          {(graph.files.length > 0 || graph.docs.length > 0) && (
            <li className="flow-graph-outputs">
              <span className="flow-graph-outputs-label">{st("graph.outputs")}</span>
              {graph.files.length > 0 && (
                <NodeButton selectable selected={selected === "files"} detailId={detailId} onSelect={() => setChosen("files")} className="flow-graph-output">
                  {st("graph.files", { count: graph.files.length })}
                </NodeButton>
              )}
              {graph.docs.length > 0 && (
                <NodeButton selectable selected={selected === "docs"} detailId={detailId} onSelect={() => setChosen("docs")} className="flow-graph-output">
                  {st("graph.docs", { count: graph.docs.length })}
                </NodeButton>
              )}
            </li>
          )}
        </ol>
      </div>
      {detail && (
        <div className="flow-graph-detail" id={detailId} role="region" aria-label={st("graph.detail.aria")}>
          {detail}
        </div>
      )}
    </section>
  );
}
