import { useContext, useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { findExactLiveSnapshot, type MakerPresentation } from "@/lib/answer-status/dispatch";
import { buildFlowGraph, replayBeats, type GraphMaker, type ReplayBeat } from "@/lib/answer-status/flow-graph";
import type { FinishedTurnSummary, MakerTiming } from "@/lib/answer-status/turn-summary";
import { isCompoundFailure, WORK_STAGES, type StageView, type WorkFlow, type WorkStage } from "@/lib/answer-status/work-flow";
import { TurnWrittenFiles } from "../TurnWrittenFiles";
import { AnswerStatusContext } from "./AnswerStatusContext";
import { FlowMotionToggle, useFlowMotionPaused } from "./flow-motion";
import { MakerRunFlow, MakerStatusPair, VERDICT_LABEL } from "./DispatchCard";
import { useAnswerStatusText, type AnswerStatusTranslate } from "./i18n";
import { elapsedText } from "./SubagentProgress";
import { EarlierAttempts, StageNode, StageWord, stageLook, StepRows } from "./WorkFlow";

/** 그래프에서 고를 수 있는 노드: 단계, Maker 하나, 변경 파일 묶음, 변경 문서 묶음. */
type NodeKey = `stage:${WorkStage}` | `maker:${string}` | "files" | "docs";

/** 재생에서 한 자리를 밝히는 시간. 일곱 단계와 갈래·귀환·결과까지 열 남짓 차례라 한 번 재생이 10초 안쪽이다. */
const REPLAY_BEAT_MS = 800;

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
 * 처음 펼친 자세히: 진행 중인 턴이 수정으로 되돌아가는 차례면 되돌아오게 한 단계, 아니면 실패·판정 미확인·수정 전 통과 단계,
 * 그것도 없으면 실제로 지난 가장 뒤 단계. 필요 없음·건너뜀 단계(게시 설명만 있는 CI 등)는 다른 단계가 없을 때만 고른다.
 * 끝난 턴은 다음 차례가 없으니 풀리지 않은 실패가 먼저다. 고를 노드가 없으면 null.
 */
function defaultNode(flow: WorkFlow, fileCount: number): NodeKey | null {
  const selectable = flow.stages.filter((view) => stageHasDetail(view, flow, fileCount));
  const loop = flow.loops[flow.loops.length - 1];
  const pick = (flow.next?.returning && loop ? selectable.find((view) => view.stage === loop.from) : undefined)
    ?? selectable.find((view) => view.status === "failed")
    ?? selectable.find((view) => view.status === "unverified" || view.status === "stale")
    ?? selectable.findLast((view) => view.status !== "notNeeded" && view.status !== "skipped")
    ?? selectable[selectable.length - 1];
  if (pick) return `stage:${pick.stage}`;
  return fileCount > 0 ? "files" : null;
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
 * 요청 카드의 작업 흐름 그래프. 넓으면 조사 → 수정 → 검사 → 교차리뷰 → 커밋·푸시 → CI → 배포 단계 상자가 한 줄이고(CI 파이프라인형),
 * 수정 단계에서 맡긴 Maker는 그 아래 갈래로, 수정에 되돌아온 일은 되돌아오게 한 단계에서 수정으로 가는 노란 화살표로,
 * 바꾼 파일과 문서는 마지막 결과 노드로 붙는다. 앞 회차에도 돈 단계 상자는 테두리가 한 장 더 겹친다. 좁으면 레일 하나에
 * 한 줄씩 쌓는 로그 레일이고, 되돌아온 회차 구간의 레일이 노랗다. 노드를 누르면 아래 한 자리에 그 노드의 실제 기록이 나온다.
 * 동시 실행은 같은 wait 스냅샷에서 함께 실행 중이었거나 지금 둘 다 실행 중일 때만 말하고, 같은 발주 묶음은 그렇게만 적는다.
 * 움직임은 지금 도는 자리에만 있다. `live`(이 요청이 실행 중)이면 지금 단계 상자의 진행 막대(좁으면 줄 끝 커서), 지금 실행
 * 중인 Maker 갈래의 진행 막대다. 움직임 멈춤 단추와 동작 줄이기 설정에서는 멈춘다. 끝난 요청은 정적이고, 사용자가 「재생」을
 * 누를 때만 실제로 지난 자리를 차례로(`replayBeats`) 다시 밝힌 뒤 정적 그래프로 돌아온다.
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
  const [chosen, setChosen] = useState<NodeKey | null | undefined>(undefined);
  const paused = useFlowMotionPaused();
  const fileCount = summary.files.length;
  const currentView = live && flow.current ? flow.stages.find((view) => view.stage === flow.current) : undefined;
  // undefined는 처음의 자동 선택, null은 사용자가 명시적으로 접은 상태다.
  const selected = chosen === undefined
    ? (currentView && stageHasDetail(currentView, flow, fileCount) ? `stage:${currentView.stage}` as const : defaultNode(flow, fileCount))
    : chosen;
  const loop = flow.loops[flow.loops.length - 1];
  const loopFrom = loop ? WORK_STAGES.indexOf(loop.from) : -1;
  const editIndex = WORK_STAGES.indexOf("edit");
  const currentIndex = currentView ? WORK_STAGES.indexOf(currentView.stage) : -1;
  const makerFlowing = graph.makers.some((entry) => entry.liveRunning);
  const moving = currentIndex >= 0 || makerFlowing;

  const hasOutputs = graph.files.length > 0 || graph.docs.length > 0;
  const beats = useMemo(
    () => (live ? [] : replayBeats(flow.stages, flow.loops, graph.makers.length > 0, hasOutputs)),
    [live, flow.stages, flow.loops, graph.makers.length, hasOutputs],
  );
  const [replay, setReplay] = useState<number | null>(null);
  // 카드가 다시 그려져 차례가 줄었거나 요청이 다시 실행 중이면 재생은 끝난 것이다.
  const replaying = replay !== null && replay < beats.length ? replay : null;
  useEffect(() => {
    if (replaying === null) return;
    const timer = window.setTimeout(() => setReplay(replaying + 1 < beats.length ? replaying + 1 : null), REPLAY_BEAT_MS);
    return () => window.clearTimeout(timer);
  }, [replaying, beats.length]);
  /** 재생 중 그 자리의 차례: 지금, 지났음, 아직. 재생 차례에 없는 자리(가지 않은 단계)와 재생하지 않을 때는 표시가 없다. */
  const beatOf = (beat: ReplayBeat): "now" | "past" | "ahead" | undefined => {
    if (replaying === null || !beats.includes(beat)) return undefined;
    if (beats[replaying] === beat) return "now";
    return beats.slice(0, replaying).includes(beat) ? "past" : "ahead";
  };

  // 갈래가 Main으로 돌아오는 자리: Maker마다 Main 판정(routing_verdict)을 센다. 실행 완료만으로는 수용이 아니다.
  const verdictCounts = new Map<keyof typeof VERDICT_LABEL, number>();
  for (const entry of graph.makers) {
    const verdict = entry.maker.verdict?.verdict ?? "none";
    verdictCounts.set(verdict, (verdictCounts.get(verdict) ?? 0) + 1);
  }
  const allAccepted = verdictCounts.size === 1 && verdictCounts.has("accepted");
  // 갈래가 합류하는 다음 단계(검사)가 아직 오지 않았거나 건너뛴 단계면 합류선은 옅은 선이고 화살촉이 없다 — 그 단계가 돌았다고 읽히지 않게.
  const mergeView = flow.stages[editIndex + 1];
  const mergeLook = mergeView ? stageLook(mergeView, flow, live) : "skipped";
  const quietMerge = mergeLook === "skipped" || mergeLook === "waiting" || mergeLook === "approval";
  const branch = graph.makers.length > 0 && (
    <li key="branch" className="flow-graph-branch" data-loop={loop && loopFrom > editIndex ? "" : undefined} data-merge={quietMerge ? "quiet" : undefined} data-beat={beatOf("branch")}>
      <p className="flow-graph-branch-head">
        <span>{st(graph.makers.length === 1 ? "graph.branch.one" : "graph.branch", { count: graph.makers.length })}</span>
        {graph.parallel !== "none" && <span className="flow-graph-chip" data-parallel={graph.parallel}>{st(`graph.parallel.${graph.parallel}`)}</span>}
      </p>
      <ul className="flow-graph-lanes">
        {graph.makers.map((entry) => {
          const key: NodeKey = `maker:${entry.maker.member.key}`;
          return (
            <li key={entry.maker.member.key} className="flow-graph-lane" data-run={entry.maker.run} data-live={entry.liveRunning ? "" : undefined}>
              <NodeButton selectable selected={selected === key} detailId={detailId} onSelect={() => setChosen(selected === key ? null : key)} className="flow-graph-maker">
                <span className="flow-graph-maker-name" title={entry.maker.title}>{entry.maker.title}</span>
                <MakerTags entry={entry} together={graph.makers.length > 1} st={st} />
                <span className="flow-graph-maker-time"><MakerTime entry={entry} st={st} /></span>
                <MakerStatusPair maker={entry.maker} st={st} />
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
    <li key="return" className="flow-graph-return" data-beat={beatOf("return")} style={{ "--from": editIndex + 1, "--to": loopFrom + 1 } as CSSProperties}>
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
        data-again={view.earlier.length > 0 ? "" : undefined}
        data-loop={loop && index >= editIndex && index < loopFrom ? "" : undefined}
        data-beat={beatOf(view.stage)}
        aria-current={look === "active" ? "step" : undefined}
        style={{ "--col": index + 1 } as CSSProperties}
      >
        <NodeButton selectable={stageHasDetail(view, flow, fileCount)} selected={selected === key} detailId={detailId} onSelect={() => setChosen(key)} className="flow-graph-stop">
          <span className="flow-graph-stop-name">{st(`flow.stage.${view.stage}`)}</span>
          <span className="flow-graph-stop-state">
            <StageNode look={look} />
            <span className="flow-graph-stop-word"><StageWord view={view} flow={flow} live={live} st={st} /></span>
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
      // 게시 근거로 CI가 「필요 없음」이면 상세는 그 근거만 보인다. 커밋 전의 CI 조회는 이 커밋의 판정이 아니다.
      const quietCi = view.stage === "ci" && flow.publication !== null && view.status === "notNeeded";
      const rows = view.stage === "edit" || quietCi ? [] : view.steps;
      detail = (
        <>
          <h5 className="flow-graph-detail-title">{st(`flow.stage.${view.stage}`)}</h5>
          {view.stage === "ci" && flow.publication && (
            <p className="flow-graph-note">
              {flow.publication.kind === "nothingToPublish"
                ? st("flow.ci.nothingToPublish", { sha: flow.publication.commit.slice(0, 7) })
                : st("flow.ci.notNeeded", {
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
          <MakerRunFlow maker={entry.maker} />
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
        <h5 className="flow-graph-detail-title">
          {selected === "files"
            ? st(graph.files.length === 1 ? "graph.files.one" : "graph.files", { count: graph.files.length })
            : st(graph.docs.length === 1 ? "graph.docs.one" : "graph.docs", { count: graph.docs.length })}
        </h5>
        <TurnWrittenFiles files={selected === "files" ? graph.files : graph.docs} onOpenFile={onOpenFile} />
      </>
    );
  }

  return (
    <section className="flow-section">
      <div className="flow-graph-head">
        <h4 className="flow-heading">{st("flow.heading")}</h4>
        {moving && <FlowMotionToggle paused={paused} />}
        {beats.length > 1 && (
          <button type="button" className="flow-graph-replay" onClick={() => setReplay(replaying === null ? 0 : null)}>
            {st(replaying === null ? "graph.replay" : "graph.replay.stop")}
          </button>
        )}
      </div>
      <div className="flow-graph-frame">
        <ol
          className="flow-graph"
          aria-label={st("flow.aria")}
          data-live={live ? "" : undefined}
          data-motion={paused ? "paused" : undefined}
          data-replay={replaying === null ? undefined : ""}
        >
          {items}
          {hasOutputs && (
            <li className="flow-graph-outputs" data-beat={beatOf("outputs")}>
              <span className="flow-graph-outputs-label">{st("graph.outputs")}</span>
              {graph.files.length > 0 && (
                <NodeButton selectable selected={selected === "files"} detailId={detailId} onSelect={() => setChosen("files")} className="flow-graph-output">
                  {st(graph.files.length === 1 ? "graph.files.one" : "graph.files", { count: graph.files.length })}
                </NodeButton>
              )}
              {graph.docs.length > 0 && (
                <NodeButton selectable selected={selected === "docs"} detailId={detailId} onSelect={() => setChosen("docs")} className="flow-graph-output">
                  {st(graph.docs.length === 1 ? "graph.docs.one" : "graph.docs", { count: graph.docs.length })}
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
