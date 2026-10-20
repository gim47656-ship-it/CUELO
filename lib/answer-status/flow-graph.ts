import type { WrittenFile } from "@/lib/turn-written-files";
import type { MakerPresentation } from "./dispatch";
import { layoutMakerBars, type MakerBar, type MakerTiming, type TurnSpan } from "./turn-summary";
import { WORK_STAGES, type LoopBack, type StageView, type WorkStage } from "./work-flow";

/**
 * 결과 카드 그래프의 Maker 갈래와 변경 결과. 전부 발주 원장·실시간 스냅샷·도구 결과에서 온다.
 *
 * - 같은 task 호출로 띄운 Maker는 같은 발주 묶음일 뿐이다. 큐가 차례로 돌렸을 수 있어 동시에 돌았다는 증거가 아니다.
 * - 동시 실행은 같은 기록에서 둘 다 running으로 관측되었거나, 둘 다 지금 실시간 스냅샷에서 실행 중일 때만 말한다.
 * - 발주 시각과 소요는 실제 실행 시작을 보장하지 않는다. 대기열이 있었을 수 있으므로 겹침 판정에 쓰지 않는다.
 */
export type MakerConcurrency = "overlapped" | "unknown";

export interface GraphMaker {
  maker: MakerPresentation;
  /** 턴 시간축 위 막대. 시작이나 소요가 없으면 null. */
  bar: MakerBar | null;
  durationMs: number | null;
  concurrency: MakerConcurrency;
  /** 같은 task 호출로 함께 띄운 Maker 수(자신 포함). */
  batchSize: number;
  /** 실시간 스냅샷이 지금 실행 중이라고 한다 — 그 갈래에만 움직임을 보인다. */
  liveRunning: boolean;
}

export interface FlowGraphModel {
  makers: GraphMaker[];
  /** observed: 겹친 실행이 관측됨. batch: 함께 발주했지만 동시 실행은 관측 안 됨. none: 그 밖. */
  parallel: "observed" | "batch" | "none";
  /** 문서가 아닌 변경 파일. */
  files: WrittenFile[];
  /** 변경한 문서(.md·.mdx·.markdown·.txt). */
  docs: WrittenFile[];
}

const DOC_FILE = /\.(?:md|mdx|markdown|txt)$/i;

export function buildFlowGraph(
  makers: readonly MakerPresentation[],
  timings: readonly MakerTiming[],
  span: TurnSpan,
  written: readonly WrittenFile[],
): FlowGraphModel {
  const bars = layoutMakerBars(span, timings);
  const liveRunning = makers.map((maker) => maker.runSource === "live" && maker.run === "running");
  const batches = new Map<string, number>();
  for (const maker of makers) batches.set(maker.member.toolCallId, (batches.get(maker.member.toolCallId) ?? 0) + 1);
  const graphMakers = makers.map((maker, index): GraphMaker => {
    let concurrency: MakerConcurrency = "unknown";
    for (let other = 0; other < makers.length; other += 1) {
      if (other === index) continue;
      if ((liveRunning[index] && liveRunning[other]) || maker.observedParallelWith?.has(makers[other].member.key)) {
        concurrency = "overlapped";
        break;
      }
    }
    return {
      maker,
      bar: bars[index],
      durationMs: timings[index]?.durationMs ?? null,
      concurrency,
      batchSize: batches.get(maker.member.toolCallId) ?? 1,
      liveRunning: liveRunning[index],
    };
  });
  return {
    makers: graphMakers,
    parallel: graphMakers.some((entry) => entry.concurrency === "overlapped") ? "observed"
      : graphMakers.some((entry) => entry.batchSize > 1) ? "batch" : "none",
    files: written.filter((file) => !DOC_FILE.test(file.filePath)),
    docs: written.filter((file) => DOC_FILE.test(file.filePath)),
  };
}

/** 재생의 한 차례: 단계 상자 하나, Maker 갈래, 되돌아온 화살표, 변경 결과. */
export type ReplayBeat = WorkStage | "branch" | "return" | "outputs";

/**
 * 끝난 요청 그래프를 다시 흐르게 할 때 밝히는 차례. 기록의 시각이 아니라 차례만 보인다.
 * - 실제로 지난 단계만 WORK_STAGES 차례로 넣는다. 대기·건너뜀·필요 없음 단계는 넣지 않는다.
 * - Maker 갈래는 처음 수정 바로 뒤다. Main이 직접 수정하지 않았으면 수정 다음 단계 앞이다.
 * - 되돌아온 일이 있으면 그래프가 그리는 마지막 귀환만 다시 보인다. 앞 회차에 돈 단계를 되돌아오게 한 단계까지 밝히고,
 *   귀환선을 그린 뒤, 수정부터 지금 회차의 단계를 다시 밝힌다.
 * - 변경 결과는 맨 끝이다.
 */
export function replayBeats(stages: readonly StageView[], loops: readonly LoopBack[], hasBranch: boolean, hasOutputs: boolean): ReplayBeat[] {
  const editIndex = WORK_STAGES.indexOf("edit");
  const reached = (view: StageView) => view.status !== "waiting" && view.status !== "skipped" && view.status !== "notNeeded";
  const beats: ReplayBeat[] = [];
  let branchPending = hasBranch;
  const push = (view: StageView) => {
    const index = WORK_STAGES.indexOf(view.stage);
    if (branchPending && index > editIndex) {
      beats.push("branch");
      branchPending = false;
    }
    beats.push(view.stage);
    if (branchPending && index === editIndex) {
      beats.push("branch");
      branchPending = false;
    }
  };
  const loop = loops[loops.length - 1];
  if (loop) {
    const fromIndex = WORK_STAGES.indexOf(loop.from);
    for (const view of stages) {
      const index = WORK_STAGES.indexOf(view.stage);
      if (index <= fromIndex && (reached(view) || view.earlier.length > 0 || view.stage === loop.from)) push(view);
    }
    if (branchPending) {
      beats.push("branch");
      branchPending = false;
    }
    beats.push("return");
    for (const view of stages) {
      if (WORK_STAGES.indexOf(view.stage) >= editIndex && reached(view)) push(view);
    }
  } else {
    for (const view of stages) if (reached(view)) push(view);
  }
  if (branchPending) beats.push("branch");
  if (hasOutputs) beats.push("outputs");
  return beats;
}
