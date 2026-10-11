import { selectCurrentTodo, summarizeTodo } from "./todo-state";
import type { AgentMessage, AssistantMessage, SubagentSnapshot, ToolCallContent, ToolResultMessage } from "./types";

/**
 * 실행 중인 서브에이전트 카드의 실시간 단계와 남은 시간 근거. 기록된 값에서만 계산하고,
 * 근거가 모자라면 아무것도 돌려주지 않는다(화면은 그 부분을 숨긴다).
 *
 * - 단계: 자식 자신의 도구 호출 흐름. 첫 edit/write 전은 조사, edit/write가 보이면 구현,
 *   마지막 edit 뒤 bash/eval은 검증, yield는 보고. 다시 고치면 구현으로 돌아간다 - 단조롭지 않다.
 *   자식은 todo를 거의 쓰지 않아(2026-09-07 이후 자식 기록 1,987개 중 9개) todo는 기준이 아니라
 *   있을 때만 덧붙인다.
 * - 남은 시간: routing ledger의 같은 모델·같은 작업 등급(NORMAL/HARD) 첫 시도 완료 기록 가운데
 *   지금 경과보다 오래 걸린 실행만 골라 `소요 − 경과`의 분포(p25·중앙·p75)를 낸다. 이미 그만큼
 *   지난 실행 사이의 조건부 분포라 경과가 늘수록 범위가 저절로 고쳐진다. 재작업 시도는 원장 소요
 *   시간이 대부분 0초로 남아 표본에서 빼고, 재작업 중인 카드에는 이 근거를 내지 않는다.
 */

/** 이보다 표본이 적으면 남은 시간 근거를 숨기거나(전체) 더 오래 걸린 실행 수로 바꾼다. */
export const ETA_MIN_SAMPLES = 3;

export type EtaWorkClass = "NORMAL" | "HARD";

/**
 * 한 자식 실행과 같은 묶음의 과거 소요 시간. 서버가 원장에서 만들어 이것만 내보낸다 - 원장 행·
 * 세션·발주 id는 담지 않는다. 경과가 계속 바뀌므로 분위는 화면이 매번 계산한다.
 */
export interface EtaHistory {
  model: string;
  /** 발주 때 정해진 작업 등급. 기록이 없으면 null이고 그때는 모델만 맞춘다. */
  workClass: EtaWorkClass | null;
  /** 이 실행이 재작업 시도(attempt ≥ 2)인가. 그러면 표본을 모으지 않는다. */
  rework: boolean;
  /** 같은 모델(·등급) 첫 시도 정상 완료의 소요 시간(초), 오름차순. */
  durationsSec: number[];
}

export interface SubagentEtaResponse {
  sessionId: string;
  /** 자식 id(원장 agentId, 그리고 다르면 jobId) → 과거 소요 시간. 이 세션에 발주 기록이 있는 자식만. */
  histories: Record<string, EtaHistory>;
}

interface LedgerDispatch {
  sessionId: string;
  attemptId: string;
  attempt: number;
  agentId: string;
  jobId: string;
  model: string;
  workClass: EtaWorkClass | null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** JSON Lines 원장을 읽는다. 깨진 줄은 건너뛴다 - 쓰는 중인 마지막 줄일 수 있다. */
export function parseLedgerLines(raw: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // 부분 기록은 근거가 아니다.
    }
  }
  return rows;
}

/** 정렬한 값의 q 분위(0~1), 이웃 두 값 사이를 선형 보간한다. 값이 없으면 null. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * 원장에서 `sessionId` 세션의 자식마다 같은 묶음의 과거 소요 시간을 모은다. 같은 자식 id의
 * 발주가 여럿이면 가장 나중 것이 지금 실행이다. 표본은 dispatch와 outcome을 attemptId로 이은
 * 첫 시도의 정상 완료(소요 > 0초)만, 같은 모델(그리고 등급이 기록돼 있으면 같은 등급)의 전부다.
 */
export function buildEtaHistories(rows: readonly unknown[], sessionId: string): Record<string, EtaHistory> {
  const dispatches = new Map<string, LedgerDispatch>();
  const sessionLatest = new Map<string, LedgerDispatch>();
  const samples: Array<{ attemptId: string; model: string; workClass: EtaWorkClass | null; sec: number }> = [];

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (record.type === "dispatch") {
      const attemptId = text(record.attemptId);
      const model = text(record.chosenModel);
      if (!attemptId || !model) continue;
      const dispatch: LedgerDispatch = {
        sessionId: text(record.sessionId),
        attemptId,
        attempt: typeof record.attempt === "number" ? record.attempt : 1,
        agentId: text(record.agentId),
        jobId: text(record.jobId),
        model,
        workClass: record.workClass === "NORMAL" || record.workClass === "HARD" ? record.workClass : null,
      };
      dispatches.set(attemptId, dispatch);
      if (dispatch.sessionId === sessionId) {
        for (const id of new Set([dispatch.agentId, dispatch.jobId])) {
          if (id) sessionLatest.set(id, dispatch);
        }
      }
      continue;
    }
    if (record.type !== "outcome" || record.status !== "completed") continue;
    const dispatch = dispatches.get(text(record.attemptId));
    const sec = record.durationSec;
    // 0초 이하는 측정이 아니라 즉시 정산된 기록이다.
    if (!dispatch || dispatch.attempt !== 1 || typeof sec !== "number" || !(sec > 0)) continue;
    samples.push({ attemptId: dispatch.attemptId, model: dispatch.model, workClass: dispatch.workClass, sec });
  }

  const histories: Record<string, EtaHistory> = {};
  for (const [id, dispatch] of sessionLatest) {
    const rework = dispatch.attempt !== 1;
    histories[id] = {
      model: dispatch.model,
      workClass: dispatch.workClass,
      rework,
      durationsSec: rework
        ? []
        : samples
          .filter((sample) => sample.attemptId !== dispatch.attemptId
            && sample.model === dispatch.model
            && (dispatch.workClass === null || sample.workClass === dispatch.workClass))
          .map((sample) => sample.sec)
          .sort((left, right) => left - right),
    };
  }
  return histories;
}

/** 단계 순서. 화면의 단계 표시가 이 순서로 그린다. */
export const SUBAGENT_PHASES = ["investigate", "implement", "verify", "report"] as const;
export type SubagentPhase = (typeof SUBAGENT_PHASES)[number];

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, ast_edit: true, multiedit: true, notebookedit: true };
const RUN_TOOLS: Record<string, true> = { bash: true, eval: true };

/**
 * 자식 자신의 도구 호출로 지금 단계를 읽는다. 순서대로 따라가며 edit/write는 구현, 구현 뒤의
 * bash/eval은 검증, yield는 보고로 옮긴다. 첫 edit 전의 bash/eval은 아직 조사다. 고친 뒤 다시
 * 고치면 구현으로 돌아가므로 지금 단계만 말할 뿐 앞으로만 간다고 주장하지 않는다.
 * 기록이 비었으면 null.
 */
export function classifySubagentPhase(messages: readonly AgentMessage[]): SubagentPhase | null {
  if (messages.length === 0) return null;
  let phase: SubagentPhase = "investigate";
  let editedSinceReport = false;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const blocks = (message as AssistantMessage).content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type !== "toolCall") continue;
      // 확장 이름공간(`ext.edit` 등)은 마지막 이름만 본다.
      const name = ((block as ToolCallContent).toolName ?? "").toLowerCase().split(/[.:/]/).pop() ?? "";
      if (EDIT_TOOLS[name]) {
        editedSinceReport = true;
        phase = "implement";
      } else if (RUN_TOOLS[name]) {
        phase = editedSinceReport ? "verify" : "investigate";
      } else if (name === "yield") {
        phase = "report";
        editedSinceReport = false;
      }
    }
  }
  return phase;
}

export interface SubagentTodoProgress {
  completed: number;
  total: number;
  percent: number;
  /** 진행 중 항목, 없으면 다음 대기 항목. */
  activeTask: string | null;
}

/** 자식 기록에 남은 마지막 todo 목록의 진행률. todo가 없거나 항목이 비었으면 null. */
export function readSubagentTodoProgress(messages: readonly AgentMessage[]): SubagentTodoProgress | null {
  const toolResults = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") toolResults.set(message.toolCallId, message);
  }
  const phases = selectCurrentTodo([...messages], toolResults);
  if (!phases) return null;
  const summary = summarizeTodo(phases);
  if (summary.total === 0 || summary.percent === null) return null;
  return {
    completed: summary.completed,
    total: summary.total,
    percent: summary.percent,
    activeTask: summary.activeTask?.content ?? null,
  };
}

/**
 * 지금까지 걸린 시간. 스냅샷의 durationMs는 마지막 진행 보고 시점 값이라, 도는 동안에는
 * 그 뒤로 흐른 시간을 더한다.
 */
export function subagentElapsedMs(snapshot: SubagentSnapshot, now: number): number | null {
  const reported = snapshot.progress?.durationMs;
  if (typeof reported !== "number") return null;
  const active = snapshot.status === "pending" || snapshot.status === "running";
  const since = active && snapshot.lastUpdate > 0 ? Math.max(0, now - snapshot.lastUpdate) : 0;
  return reported + since;
}

export type SubagentEta =
  | {
    kind: "remaining";
    /** 지금 경과보다 오래 걸린 과거 실행의 `소요 − 경과` 분위. */
    p25Ms: number;
    medianMs: number;
    p75Ms: number;
    /** 그 조건을 만족한 과거 실행 수. */
    samples: number;
    /** 경과 / (경과 + 남은 시간 중앙값), 정수 %. 추정이다. */
    percent: number;
  }
  | {
    kind: "overrun";
    /** 경과보다 오래 걸린 과거 실행이 3건 미만 - 그 묶음에서 가장 오래 걸린 실행. */
    longestMs: number;
    samples: number;
    /** 현재 경과보다 더 오래 걸린 실행 수(0~2). 0일 때만 최장 기록에 도달했다. */
    longerRuns: number;
  };

/**
 * 경과를 조건으로 한 남은 시간. 과거 표본이 3건 미만이면 null(숨김). 경과보다 오래 걸린 실행이
 * 3건 이상이면 그 실행들의 `소요 − 경과` p25·중앙·p75와 진행 % 추정을, 아니면 더 오래 걸린
 * 실행 수와 최장 기록을 낸다. 화면은 0건과 1~2건을 구분한다.
 */
export function estimateConditionalEta(history: EtaHistory | null | undefined, elapsedMs: number | null): SubagentEta | null {
  if (!history || history.rework || elapsedMs === null || history.durationsSec.length < ETA_MIN_SAMPLES) return null;
  const remaining = history.durationsSec
    .map((sec) => sec * 1000 - elapsedMs)
    .filter((ms) => ms > 0);
  if (remaining.length < ETA_MIN_SAMPLES) {
    return { kind: "overrun", longestMs: Math.max(...history.durationsSec) * 1000, samples: history.durationsSec.length, longerRuns: remaining.length };
  }
  const medianMs = quantile(remaining, 0.5) ?? 0;
  return {
    kind: "remaining",
    p25Ms: quantile(remaining, 0.25) ?? 0,
    medianMs,
    p75Ms: quantile(remaining, 0.75) ?? 0,
    samples: remaining.length,
    percent: Math.round((elapsedMs / (elapsedMs + medianMs)) * 100),
  };
}

/**
 * todo가 있을 때만 쓰는 덧붙임 근거: `경과 × 남은 단계 / 완료 단계`. 끝낸 단계가 없거나 모두
 * 끝났으면 null. 단계 크기가 제각각이라 거친 값이다.
 */
export function estimateTodoRemainingMs(progress: SubagentTodoProgress | null, elapsedMs: number | null): number | null {
  if (!progress || elapsedMs === null || progress.completed === 0 || progress.completed >= progress.total) return null;
  return (elapsedMs * (progress.total - progress.completed)) / progress.completed;
}

/**
 * 카드에 쓰는 대략의 길이. 분 단위로 반올림하고, 1분 미만이면 null - 화면은 그때 따로 말한다.
 * 문구는 화면 언어 팩이 맡는다.
 */
export function splitApproxDuration(ms: number): { hours: number; minutes: number } | null {
  if (ms < 60_000) return null;
  const total = Math.round(ms / 60_000);
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
