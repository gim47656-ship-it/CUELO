"use client";

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { MakerAttempt, VerdictRecord } from "@/lib/answer-status/dispatch";
import type { HanseSubagentClient } from "@/lib/hanse-subagent-client";
import {
  classifySubagentPhase,
  estimateConditionalEta,
  estimateTodoRemainingMs,
  readSubagentTodoProgress,
  splitApproxDuration,
  subagentElapsedMs,
  traceSubagentRun,
  SUBAGENT_PHASES,
  type EtaHistory,
  type SubagentEtaResponse,
  type SubagentFlow,
  type SubagentPhase,
  type SubagentRunTrace,
  type SubagentStation,
  type SubagentStationState,
  type SubagentTodoProgress,
} from "@/lib/subagent-progress";
import type { SubagentSnapshot } from "@/lib/types";
import { isActiveSubagentStatus, useSubagentTranscripts } from "@/hooks/useSubagentTranscripts";
import { useNow } from "@/hooks/useNow";
import { FlowMotionToggle, useFlowMotionPaused } from "./flow-motion";
import { useAnswerStatusText, type AnswerStatusTranslate } from "./i18n";
import { StageNode, type StageLook } from "./WorkFlow";

/** 경과·남은 시간을 다시 그리는 간격. 진행 보고가 없는 동안에도 경과가 흐른다. */
const LIVE_TICK_MS = 5_000;

/** 실행 중 자식 하나의 관측: 도구 흐름으로 읽은 단계, 있으면 todo, 같은 묶음의 과거 소요 시간. */
export interface SubagentProgressView {
  phase: SubagentPhase | null;
  /** 자식 기록에서 읽은 지금 실행의 흐름. 기록을 읽지 않았으면 null. */
  trace: SubagentRunTrace | null;
  todo: SubagentTodoProgress | null;
  history: EtaHistory | null;
}

/**
 * 실행 중인 자식마다 단계·todo(자식 자신의 기록)와 과거 소요 시간(서버가 원장에서 낸 요약)을
 * 모은다. 끝난 자식은 읽지 않는다. 기록은 다른 화면이 쓰는 같은 훅으로 읽어 기록이 바뀔 때마다
 * 다시 계산된다. 경과에 따라 바뀌는 값은 `SubagentLiveEta`가 그 자리에서 계산한다.
 * 기록 읽기는 자식마다 처음에 전체(수 MB)를 받으므로 `transcripts: false`면 건너뛰고 단계·todo는
 * null로 둔다 - 경과·남은 시간은 스냅샷과 작은 요약만으로 계속 나온다.
 */
export function useSubagentProgress({
  sessionId,
  snapshots,
  client,
  enabled,
  transcripts = true,
  cwd,
}: {
  sessionId: string | null | undefined;
  snapshots: readonly SubagentSnapshot[];
  client: HanseSubagentClient;
  enabled: boolean;
  transcripts?: boolean;
  /** 이 대화의 작업 폴더. 자식의 임시 파일 쓰기 판정에 쓴다. */
  cwd?: string;
}): ReadonlyMap<string, SubagentProgressView> {
  const active = useMemo(() => snapshots.filter((snapshot) => isActiveSubagentStatus(snapshot.status)), [snapshots]);
  const on = enabled && Boolean(sessionId) && active.length > 0;
  const targets = useMemo(
    () => active.map((snapshot) => ({ key: snapshot.id, liveId: snapshot.id, status: snapshot.status })),
    [active],
  );
  const reads = useSubagentTranscripts(targets, { sessionId: sessionId ?? "", client, enabled: on && transcripts });

  const [histories, setHistories] = useState<SubagentEtaResponse | null>(null);
  // 발주 기록 반영 지연·일시적인 실패는 짧게 재시도하고, 이후에도 1분마다 새 기록을 읽는다.
  const activeIds = active.map((snapshot) => snapshot.id).sort().join("\n");
  useEffect(() => {
    if (!on || !sessionId) return;
    const controller = new AbortController();
    const ids = activeIds.split("\n");
    const url = `/api/subagents/eta?sessionId=${encodeURIComponent(sessionId)}`;
    let timer: number | undefined;
    let missingHistory = true;
    let quickRetries = 0;
    async function refresh() {
      try {
        const response = await fetch(url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        const body = response.ok ? await response.json() as SubagentEtaResponse : null;
        if (!controller.signal.aborted && body && body.sessionId === sessionId && body.histories && typeof body.histories === "object") {
          setHistories(body);
          missingHistory = ids.some((id) => !body.histories[id]);
        }
      } catch {
        // 실패해도 기존 근거·단계·경과는 유지하고 다음 주기에 다시 읽는다.
      } finally {
        if (!controller.signal.aborted) {
          const quick = missingHistory && quickRetries < 3;
          if (quick) quickRetries += 1;
          timer = window.setTimeout(refresh, quick ? 10_000 : 60_000);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [activeIds, on, sessionId]);

  return useMemo(() => {
    const views = new Map<string, SubagentProgressView>();
    if (!on) return views;
    const sessionHistories = histories && histories.sessionId === sessionId ? histories.histories : undefined;
    for (const snapshot of active) {
      // 기록 읽기를 멈추면 마지막으로 읽은 단계가 갱신 없이 남으므로 쓰지 않는다.
      const entries = transcripts ? reads.get(snapshot.id)?.entries ?? [] : [];
      const messages = entries.flatMap((entry) => ("message" in entry ? [entry.message] : []));
      views.set(snapshot.id, {
        phase: classifySubagentPhase(messages, cwd),
        trace: traceSubagentRun(messages, cwd),
        todo: readSubagentTodoProgress(messages),
        history: sessionHistories?.[snapshot.id] ?? null,
      });
    }
    return views;
  }, [active, cwd, histories, on, reads, sessionId, transcripts]);
}

/** 대략의 길이(분 단위). 1분 미만은 따로 말한다. */
function durationText(st: AnswerStatusTranslate, ms: number): string {
  const parts = splitApproxDuration(ms);
  if (!parts) return st("duration.underMinute");
  if (parts.hours === 0) return st("duration.minutes", { minutes: parts.minutes });
  return parts.minutes === 0
    ? st("duration.hours", { hours: parts.hours })
    : st("duration.hoursMinutes", { hours: parts.hours, minutes: parts.minutes });
}

/** 경과는 흐르는 게 보이도록 1시간 안에서는 초까지 쓴다. */
export function elapsedText(st: AnswerStatusTranslate, ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return st("duration.seconds", { seconds });
  if (seconds < 3600) return st("duration.minutesSeconds", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  return durationText(st, ms);
}

/** 「3~12분」처럼 범위. 양 끝이 1시간 안이면 단위를 한 번만 쓴다. */
function rangeText(st: AnswerStatusTranslate, lowMs: number, highMs: number): string {
  const low = splitApproxDuration(lowMs);
  const high = splitApproxDuration(highMs);
  if (low && high && low.hours === 0 && high.hours === 0) {
    return low.minutes === high.minutes
      ? st("duration.minutes", { minutes: low.minutes })
      : st("eta.rangeMinutes", { low: low.minutes, high: high.minutes });
  }
  return st("eta.range", { low: durationText(st, lowMs), high: durationText(st, highMs) });
}

/**
 * 단계 표시: 「조사 › 구현 › 검증 › 보고」에서 지금 단계만 강조한다. 단계는 돌아갈 수 있으므로
 * 지나간 단계를 완료로 칠하지 않는다.
 */
export function SubagentPhaseSteps({ phase }: { phase: SubagentPhase }) {
  const { st } = useAnswerStatusText();
  return (
    <span className="subagent-phase-steps" data-phase={phase} title={st("phase.hint")} style={{ position: "relative" }}>
      <span className="sr-only">{st("phase.current", { phase: st(`phase.${phase}`) })}</span>
      <span aria-hidden="true">
        {SUBAGENT_PHASES.map((step, index) => (
          <span key={step}>
            {index > 0 && <span style={{ color: "var(--seed-color-fg-neutral-subtle, var(--text-muted))" }}> › </span>}
            <span
              data-current={step === phase ? "" : undefined}
              style={step === phase
                ? { color: "var(--accent)", fontWeight: 700 }
                : { color: "var(--seed-color-fg-neutral-subtle, var(--text-muted))" }}
            >
              {st(`phase.${step}`)}
            </span>
          </span>
        ))}
      </span>
    </span>
  );
}

/** 칸 상태 → 노드 모양. 닿지 못한 칸은 건너뜀(—), 기록을 읽지 못한 칸은 본 그래프의 미확인(!)과 같은 모양이다. */
const STATION_LOOK: Record<SubagentStationState, StageLook> = {
  done: "done",
  stale: "stale",
  active: "active",
  waiting: "waiting",
  skipped: "skipped",
  none: "skipped",
  unobserved: "unverified",
};

function checksWord(st: AnswerStatusTranslate, checks: SubagentRunTrace["checks"]): ReactNode {
  const total = checks.passed + checks.failed + checks.unknown;
  const tone = checks.failed > 0 ? "failed" : checks.unknown > 0 ? "unverified" : "passed";
  return <span className="flow-tone" data-tone={tone}>{st("subflow.checks", { passed: checks.passed, total })}</span>;
}

/** 한 칸의 상태 말. 색만으로 나누지 않도록 상태마다 글이 다르다. */
function stationWord(st: AnswerStatusTranslate, station: SubagentStation, run: SubagentRunTrace | null): ReactNode {
  const checked = station.phase === "verify" && run !== null && run.checks.passed + run.checks.failed + run.checks.unknown > 0;
  switch (station.state) {
    case "active":
      return checked && run ? <>{st("flow.state.running")} · {checksWord(st, run.checks)}</> : st("flow.state.running");
    case "waiting":
      return st("flow.state.waiting");
    case "skipped":
      return st("flow.state.skipped");
    case "none":
      return st("detail.stageNone");
    case "unobserved":
      return st("subflow.unobserved");
    case "stale":
      return st(run && run.checks.passed > 0 ? "flow.state.stale" : "flow.state.staleDone");
    case "done":
      if (station.phase === "report") return st("subflow.reported");
      if (checked && run) return checksWord(st, run.checks);
      if (station.phase === "implement" && run && run.reedits > 0) {
        return `${st("subflow.calls", { count: station.calls })} · ${st("subflow.reedits", { count: run.reedits })}`;
      }
      return st("subflow.calls", { count: station.calls });
  }
}

/**
 * 서브에이전트 한 실행의 그래프: 조사 → 구현 → 검증 → 보고 칸은 자식 자신의 도구 호출(`buildSubagentFlow`)에서, 마지막
 * Main 판정 칸은 이 실행의 routing_verdict에서 온다. Main 재작업 요청이 있었으면 판정에서 구현으로 되돌아온 노란 화살표를
 * 그린다(좁으면 구현부터 판정까지 레일이 노랗다). 지난 실행의 판정은 이 칸에 넣지 않는다(카드의 「이전 판정」). 움직임은
 * 자식이 실행 중일 때 지금 칸의 진행 막대(좁으면 줄 끝 커서)에만 있고, 움직임 멈춤과 동작 줄이기 설정을 따른다.
 */
export function SubagentFlowGraph({ flow, live, verdict, attempts }: {
  flow: SubagentFlow;
  /** 이 발주가 띄운 자식이 지금 실시간으로 실행 중이다. 진행 중·대기 칸과 움직임은 이때만 있다. */
  live: boolean;
  verdict: VerdictRecord | null;
  attempts: readonly MakerAttempt[];
}) {
  const { st } = useAnswerStatusText();
  const paused = useFlowMotionPaused();
  const activeIndex = flow.stations.findIndex((station) => station.state === "active");
  const implementIndex = SUBAGENT_PHASES.indexOf("implement");
  const reworks = attempts.filter((entry) => entry.verdict === "rework").length;
  const verdictLook: StageLook = verdict ? (verdict.verdict === "accepted" ? "done" : "unverified") : "waiting";
  const verdictWord = verdict
    ? `${st(`verdict.${verdict.verdict}`)}${verdict.attempt !== null && verdict.attempt > 1 ? ` · ${st("verdict.attempt", { attempt: verdict.attempt })}` : ""}`
    : st(live ? "flow.state.waiting" : "verdict.none");
  return (
    <div className="subagent-flow">
      {live && activeIndex >= 0 && <FlowMotionToggle paused={paused} />}
      <ol className="flow-graph" aria-label={st("subflow.aria")} data-live={live ? "" : undefined} data-motion={paused ? "paused" : undefined}>
        {flow.stations.map((station, index) => {
          const look = STATION_LOOK[station.state];
          return (
            <li
              key={station.phase}
              className="flow-graph-station"
              data-stage={station.phase}
              data-state={look}
              data-loop={reworks > 0 && index >= implementIndex ? "" : undefined}
              aria-current={station.state === "active" ? "step" : undefined}
              style={{ "--col": index + 1 } as CSSProperties}
            >
              <div className="flow-graph-stop">
                <span className="flow-graph-stop-name">{st(`phase.${station.phase}`)}</span>
                <span className="flow-graph-stop-state">
                  <StageNode look={look} />
                  <span className="flow-graph-stop-word">{stationWord(st, station, flow.run)}</span>
                </span>
              </div>
            </li>
          );
        })}
        <li className="flow-graph-station" data-stage="verdict" data-state={verdictLook} style={{ "--col": SUBAGENT_PHASES.length + 1 } as CSSProperties}>
          <div className="flow-graph-stop">
            <span className="flow-graph-stop-name">{st("graph.join")}</span>
            <span className="flow-graph-stop-state">
              <StageNode look={verdictLook} />
              <span className="flow-graph-stop-word">{verdictWord}</span>
            </span>
          </div>
        </li>
        {reworks > 0 && (
          <li className="flow-graph-return" style={{ "--from": implementIndex + 1, "--to": SUBAGENT_PHASES.length + 1 } as CSSProperties}>
            <span className="flow-graph-return-line" aria-hidden="true">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </span>
            <span className="flow-graph-return-text">{st("subflow.rework", { count: reworks })}</span>
          </li>
        )}
      </ol>
    </div>
  );
}

/** todo가 있을 때만 붙는 덧붙임 한 조각. */
export function todoText(st: AnswerStatusTranslate, todo: SubagentTodoProgress): string {
  const head = st("progress.todo", { completed: todo.completed, total: todo.total, percent: todo.percent });
  return todo.activeTask ? `${head} · ${todo.activeTask}` : head;
}

/**
 * 경과와 남은 시간 한 줄. 5초마다, 그리고 기록이 바뀔 때마다 다시 계산한다. 과거 기록 근거
 * (경과를 조건으로 한 범위·% 추정)와 todo 근거는 섞지 않고 각자 라벨을 달아 나란히 둔다.
 * 더 오래 걸린 표본이 적으면 그 수를, 하나도 없으면 최장 기록에 도달한 사실을 경고색으로 말한다.
 * 재작업 시도는 추정 대신 시도 차수와 첫 발주부터의 시간을 보인다.
 */
export function SubagentLiveEta({ snapshot, view, id }: {
  snapshot: SubagentSnapshot;
  view: SubagentProgressView;
  id?: string;
}) {
  const { st } = useAnswerStatusText();
  const now = useNow(LIVE_TICK_MS);
  const elapsedMs = subagentElapsedMs(snapshot, now);
  if (elapsedMs === null) return null;
  const eta = estimateConditionalEta(view.history, elapsedMs);
  const todoMs = estimateTodoRemainingMs(view.todo, elapsedMs);
  const subtle = { color: "var(--seed-color-fg-neutral-subtle, var(--text-muted))" };
  const history = view.history;
  const sinceFirstMs = history?.rework && history.firstDispatchedAtMs !== null ? now - history.firstDispatchedAtMs : null;
  return (
    <span id={id} className="subagent-live-eta" data-eta={eta?.kind ?? (history?.rework ? "rework" : "none")}>
      <span data-elapsed={Math.floor(elapsedMs / 1000)}>{st("eta.elapsed", { duration: elapsedText(st, elapsedMs) })}</span>
      {history?.rework && (
        <>
          {" · "}
          <span style={subtle} title={st("eta.reworkHint")}>
            {sinceFirstMs !== null && sinceFirstMs >= 0
              ? st("eta.rework", { attempt: history.attempt, duration: elapsedText(st, sinceFirstMs) })
              : st("eta.reworkAttempt", { attempt: history.attempt })}
          </span>
        </>
      )}
      {eta?.kind === "remaining" && (
        <>
          {" · "}
          <span title={st("eta.hint")}>{st("eta.remaining", { range: rangeText(st, eta.p25Ms, eta.p75Ms), samples: eta.samples })}</span>
          {" · "}
          <span style={subtle}>{st("eta.percent", { percent: eta.percent })}</span>
        </>
      )}
      {eta?.kind === "overrun" && (
        <>
          {" · "}
          <span style={{ color: "var(--warning)" }} title={st("eta.hint")}>
            {eta.longerRuns === 0
              ? st("eta.overrun", { longest: durationText(st, eta.longestMs) })
              : st("eta.sparseTail", { samples: eta.samples, longerRuns: eta.longerRuns })}
          </span>
        </>
      )}
      {todoMs !== null && view.todo && (
        <>
          {" · "}
          <span style={subtle} title={st("eta.byTodoHint")}>
            {todoMs < 60_000
              ? st("eta.byTodoSoon", { completed: view.todo.completed, total: view.todo.total })
              : st("eta.byTodo", { duration: durationText(st, todoMs), completed: view.todo.completed, total: view.todo.total })}
          </span>
        </>
      )}
    </span>
  );
}
