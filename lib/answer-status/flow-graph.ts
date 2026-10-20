import type { WrittenFile } from "@/lib/turn-written-files";
import type { MakerPresentation } from "./dispatch";
import { layoutMakerBars, type MakerBar, type MakerTiming, type TurnSpan } from "./turn-summary";

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
