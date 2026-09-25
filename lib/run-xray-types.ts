/**
 * Run X-Ray / Experiment Lab 공용 계약.
 *
 * 이 기능은 **새 계측을 하지 않는다.** 이미 쌓인 `~/.omp/stats.db`(읽기 전용)와
 * 세션 JSONL만 읽는다. 따라서 모든 필드는 "기록에 남은 것"이거나 "기록에 없어
 * 비워둔 것"이며, 값을 추정해 채우지 않는다.
 *
 * 절대 깨지 않는 표현 규칙:
 * - `wallClockMs`(경과)와 `busyMs`(생성시간 합)를 **더하지 않는다.** 자식이
 *   병렬로 돌면 busy 합이 경과를 넘는 것이 정상이다.
 * - 비용은 언제나 **추정 비용**이다. `unpricedRequests > 0`이면 그 추정치는
 *   하한이며, 구독 소모량·실지출과 다르다.
 * - 측정되지 않은 구간에 원인을 붙이지 않는다. 라벨은 `원인 미측정 공백`으로
 *   고정하고 사유 코드는 `wait-attribution`이다.
 * - 단일 "효율 점수"를 만들지 않는다.
 */

/**
 * 역할 종류. `main`은 부모 transcript, 나머지는 자식 transcript다.
 * `maker`/`checker`는 부모 JSONL의 `task` 호출 인자(`tasks[].agent`)로만
 * 확정한다. 자식 system prompt로 추론하지 않는다 — 전역 preamble이 공유돼
 * 구분되지 않는 것이 실측으로 확인됐다.
 */
export const RUN_ROLE_KINDS = ["main", "maker", "checker", "advisor", "unattributed"] as const;
export type RunRoleKind = (typeof RUN_ROLE_KINDS)[number];

/** 브리프의 `PURPOSE:`. 기록에 없으면 `null`이며 기본값을 가정하지 않는다. */
export const RUN_ROLE_PURPOSES = ["primary", "rework", "review"] as const;
export type RunRolePurpose = (typeof RUN_ROLE_PURPOSES)[number];

/**
 * run이 끝난 방식. 부모의 마지막 모델 응답 `stop_reason`에서 온다.
 *
 * `interrupted`는 최종 답변에 도달하기 전에 **다음 사용자 요청이 들어와** 창이
 * 닫힌 경우다. 과거 기록에서 흔하며 `running`(아직 진행 중)과 구분해야 한다.
 * 둘을 합치면 끝난 작업이 영원히 "진행 중"으로 보인다.
 */
export const RUN_OUTCOMES = ["completed", "error", "aborted", "interrupted", "running"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/**
 * 화면이 "이건 측정되지 않았다"고 정직하게 말해야 하는 항목.
 * UI는 사유마다 고정 문구만 쓰고 원인을 추측하지 않는다.
 */
export const RUN_UNMEASURED_REASONS = [
  /** 역할이 아무 요청도 처리하지 않은 경과 구간. 원인은 기록에 없다. */
  "wait-attribution",
  /** 가격이 기록되지 않은 요청이 있어 추정 비용이 하한이다. */
  "unpriced-cost",
  /** 해당 transcript에 effort 변경 기록이 없어 effort를 모른다. */
  "effort-unrecorded",
  /** 부모의 `task` 인자에서 역할을 찾지 못한 자식이 있다. */
  "role-unattributed",
  /** 응답 소요시간이 기록되지 않은 요청이 있어 생성시간 합이 하한이다. */
  "busy-unrecorded",
] as const;
export type RunUnmeasuredReason = (typeof RUN_UNMEASURED_REASONS)[number];

/**
 * 구성 비교의 집계 범위. `all`은 기록된 run 전부, `attributed`는 역할을
 * 하나라도 확정하지 못한 run을 빼고 센다. 기본값은 `all`이다.
 */
export const EXPERIMENT_SCOPES = ["all", "attributed"] as const;
export type ExperimentScope = (typeof EXPERIMENT_SCOPES)[number];

/** 한 역할(부모 본인 또는 자식 하나)이 이 run 안에서 남긴 기록. */
export interface RunRoleSegment {
  /** 부모는 `"main"`, 자식은 transcript 파일 이름(예: `"Web6Shim"`). */
  id: string;
  kind: RunRoleKind;
  purpose: RunRolePurpose | null;
  /** 실제 관측된 모델 ID. 기록 순서를 유지하며 중복은 제거한다. */
  models: string[];
  /** 실제 관측된 effort. 기록이 없으면 빈 배열이고 추정하지 않는다. */
  efforts: string[];
  requestCount: number;
  /** 생성시간 합(ms). `wallClockMs`와 더하지 않는다. */
  busyMs: number;
  /** 이 역할의 첫 요청 시작~마지막 요청 종료 경과(ms). */
  spanMs: number;
  startedAt: number;
  endedAt: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** 추정 비용(USD). 가격 미기록 요청은 여기에 들어가지 않는다. */
  estimatedCostUsd: number;
  unpricedRequests: number;
  /**
   * 소요시간(`duration`)이 기록되지 않은 요청 수. 이 요청들은 `busyMs`에 0으로
   * 들어가므로 `busyMs`는 하한이다. 0이 아니면 화면이 그 사실을 밝혀야 한다.
   */
  untimedRequests: number;
  errorCount: number;
  abortedCount: number;
  toolCalls: number;
}

/** 이 run에서 관측된 크기가 큰 항목. 원인 설명이 아니다. */
export interface RunBottleneck {
  /** `role-busy`는 역할의 생성시간, `unmeasured-gap`은 아무 요청도 없던 구간. */
  kind: "role-busy" | "unmeasured-gap";
  /** `role-busy`면 `RunRoleSegment.id`, `unmeasured-gap`이면 `"unmeasured"`. */
  id: string;
  ms: number;
  /**
   * 뽑힌 항목 중 1위 대비 비율(0~1). 막대 길이 전용이며 백분율로 쓰지 않는다.
   * 경과시간을 분모로 쓰지 않는다 — 역할은 병렬이라 합이 경과를 넘는다.
   */
  relative: number;
}

export interface RunToolTotal {
  toolName: string;
  calls: number;
  errors: number;
}

/** 목록 한 줄. 상세를 열지 않아도 결론이 보이는 값만 담는다. */
export interface RunSummary {
  /** `${sessionId}:${entryId}` — 라우트에서는 `decodeURIComponent` 후 쓴다. */
  runId: string;
  sessionId: string;
  entryId: string;
  /** 세션 안 순번(1부터). 사용자가 "몇 번째 요청"으로 찾게 한다. */
  index: number;
  /** 요청 원문 앞부분(최대 120자). 기록에서 찾지 못하면 `null`. */
  title: string | null;
  startedAt: number;
  /** 다음 사용자 요청 시작 또는 마지막 기록 시각. 진행 중이면 `null`. */
  endedAt: number | null;
  wallClockMs: number;
  outcome: RunOutcome;
  busyMs: number;
  childCount: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedRequests: number;
  /** 이 run의 구성 서명. Experiment Lab의 묶음 키와 같은 규칙이다. */
  configSignature: string;
}

export interface RunDetail extends RunSummary {
  roles: RunRoleSegment[];
  /** 최대 3개. 큰 것부터 정렬한다. */
  bottlenecks: RunBottleneck[];
  /** 어떤 역할도 요청을 처리하지 않던 경과(ms). 원인은 기록에 없다. */
  unmeasuredMs: number;
  toolTotals: RunToolTotal[];
  unmeasured: RunUnmeasuredReason[];
}

export interface RunListResponse {
  sessionId: string;
  /** 최신 run이 먼저 온다. */
  runs: RunSummary[];
  unmeasured: RunUnmeasuredReason[];
}

/** 구성 서명의 한 항목. 같은 역할·모델·effort는 `count`로 합친다. */
export interface ExperimentConfigRole {
  kind: RunRoleKind;
  model: string;
  effort: string | null;
  count: number;
}

/**
 * 한 구성(역할↔모델·effort 조합)으로 실행된 run들의 집계.
 *
 * 서로 다른 작업이 섞여 있으므로 **난이도는 보정되지 않는다.** 이 숫자는
 * "이 구성이 더 낫다"가 아니라 "이 구성으로 돌렸을 때 실제로 이만큼 걸리고
 * 이만큼 썼다"는 관측이다. 중앙값을 쓰는 이유는 한 번의 긴 작업이 평균을
 * 끌어가는 것을 막기 위해서다.
 */
export interface ExperimentConfig {
  signature: string;
  roles: ExperimentConfigRole[];
  runCount: number;
  medianWallClockMs: number;
  medianBusyMs: number;
  medianTotalTokens: number;
  medianEstimatedCostUsd: number;
  totalEstimatedCostUsd: number;
  /** 가격 미기록 요청이 있던 run 수. 0이 아니면 비용 비교는 하한 비교다. */
  unpricedRuns: number;
  /** 소요시간 미기록 요청이 있던 run 수. 0이 아니면 `medianBusyMs`는 하한이다. */
  untimedRuns: number;
  /** `PURPOSE: rework` 자식이 있던 run 수. */
  reworkRuns: number;
  /** 부모가 오류로 끝난 run 수. */
  errorRuns: number;
  /** run당 평균 자식 수. */
  childRunsAvg: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ExperimentResponse {
  /** stats.db의 folder 값. 전체를 볼 때는 `null`. */
  folder: string | null;
  /** 폴더 선택지. 기록에 있는 것만 담는다. */
  folders: string[];
  /** 실제로 적용된 집계 범위. 알 수 없는 요청 값은 `all`로 떨어진다. */
  scope: ExperimentScope;
  /** `runCount`가 많은 구성이 먼저 온다. */
  configs: ExperimentConfig[];
  /** 집계에 들어간 run 총수. */
  runCount: number;
  /** 집계에 run을 하나라도 보탠 세션 총수. */
  sessionCount: number;
  /** `scope`가 `attributed`라서 뺀 run 수. `all`이면 0이다. */
  excludedRunCount: number;
  unmeasured: RunUnmeasuredReason[];
}

/** 목록·집계가 한 번에 읽는 최대치. 요청이 이보다 크면 여기로 자른다. */
export const RUN_LIST_MAX_LIMIT = 50;
export const RUN_LIST_DEFAULT_LIMIT = 20;
export const EXPERIMENT_MAX_SESSIONS = 60;
export const EXPERIMENT_DEFAULT_SESSIONS = 30;
