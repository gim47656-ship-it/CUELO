"use client";

import { useEffect, useMemo, useState } from "react";
import type { HanseSubagentClient } from "@/lib/hanse-subagent-client";
import {
  classifySubagentPhase,
  estimateConditionalEta,
  estimateTodoRemainingMs,
  readSubagentTodoProgress,
  splitApproxDuration,
  subagentElapsedMs,
  SUBAGENT_PHASES,
  type EtaHistory,
  type SubagentEtaResponse,
  type SubagentPhase,
  type SubagentTodoProgress,
} from "@/lib/subagent-progress";
import type { SubagentSnapshot } from "@/lib/types";
import { isActiveSubagentStatus, useSubagentTranscripts } from "@/hooks/useSubagentTranscripts";
import { useNow } from "@/hooks/useNow";
import { useAnswerStatusText, type AnswerStatusTranslate } from "./i18n";

/** 경과·남은 시간을 다시 그리는 간격. 진행 보고가 없는 동안에도 경과가 흐른다. */
const LIVE_TICK_MS = 5_000;

/** 실행 중 자식 하나의 관측: 도구 흐름으로 읽은 단계, 있으면 todo, 같은 묶음의 과거 소요 시간. */
export interface SubagentProgressView {
  phase: SubagentPhase | null;
  todo: SubagentTodoProgress | null;
  history: EtaHistory | null;
}

/**
 * 실행 중인 자식마다 단계·todo(자식 자신의 기록)와 과거 소요 시간(서버가 원장에서 낸 요약)을
 * 모은다. 끝난 자식은 읽지 않는다. 기록은 다른 화면이 쓰는 같은 훅으로 읽어 기록이 바뀔 때마다
 * 다시 계산된다. 경과에 따라 바뀌는 값은 `SubagentLiveEta`가 그 자리에서 계산한다.
 */
export function useSubagentProgress({
  sessionId,
  snapshots,
  client,
  enabled,
}: {
  sessionId: string | null | undefined;
  snapshots: readonly SubagentSnapshot[];
  client: HanseSubagentClient;
  enabled: boolean;
}): ReadonlyMap<string, SubagentProgressView> {
  const active = useMemo(() => snapshots.filter((snapshot) => isActiveSubagentStatus(snapshot.status)), [snapshots]);
  const on = enabled && Boolean(sessionId) && active.length > 0;
  const targets = useMemo(
    () => active.map((snapshot) => ({ key: snapshot.id, liveId: snapshot.id, status: snapshot.status })),
    [active],
  );
  const reads = useSubagentTranscripts(targets, { sessionId: sessionId ?? "", client, enabled: on });

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
      const messages = (reads.get(snapshot.id)?.entries ?? []).flatMap((entry) => ("message" in entry ? [entry.message] : []));
      views.set(snapshot.id, {
        phase: classifySubagentPhase(messages),
        todo: readSubagentTodoProgress(messages),
        history: sessionHistories?.[snapshot.id] ?? null,
      });
    }
    return views;
  }, [active, histories, on, reads, sessionId]);
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
function elapsedText(st: AnswerStatusTranslate, ms: number): string {
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

/** todo가 있을 때만 붙는 덧붙임 한 조각. */
export function todoText(st: AnswerStatusTranslate, todo: SubagentTodoProgress): string {
  const head = st("progress.todo", { completed: todo.completed, total: todo.total, percent: todo.percent });
  return todo.activeTask ? `${head} · ${todo.activeTask}` : head;
}

/**
 * 경과와 남은 시간 한 줄. 5초마다, 그리고 기록이 바뀔 때마다 다시 계산한다. 과거 기록 근거
 * (경과를 조건으로 한 범위·% 추정)와 todo 근거는 섞지 않고 각자 라벨을 달아 나란히 둔다.
 * 더 오래 걸린 표본이 적으면 그 수를, 하나도 없으면 최장 기록에 도달한 사실을 경고색으로 말한다.
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
  return (
    <span id={id} className="subagent-live-eta" data-eta={eta?.kind ?? "none"}>
      <span data-elapsed={Math.floor(elapsedMs / 1000)}>{st("eta.elapsed", { duration: elapsedText(st, elapsedMs) })}</span>
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
