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

/**
 * 역할이 대화 밖에서 부른 보조 모델 호출(`model_usage` 기록: find·auto-thinking·skim 등) 묶음.
 * `purpose`·`role`·`model`이 같은 호출을 합친다. 토큰·비용은 호출한 역할의 합계에 **이미 들어 있는
 * 내역**이므로 역할·run 합계에 다시 더하지 않는다.
 */
export interface RunHelperUsage {
  /** 기록된 호출 목적(예: `skim`, `find`). */
  purpose: string;
  /** 호출이 거친 model role(예: `skim`, `tiny`). 기록에 없으면 `null`. */
  role: string | null;
  /** `provider/model` 실측값. */
  model: string;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  unpricedRequests: number;
  errorCount: number;
}

/** 한 역할(부모 본인 또는 자식 하나)이 이 run 안에서 남긴 기록. */
export interface RunRoleSegment {
  /** 부모는 `"main"`, 자식은 transcript 파일 이름(예: `"Web6Shim"`). */
  id: string;
  kind: RunRoleKind;
  purpose: RunRolePurpose | null;
  /**
   * 대화 요청에서 실제 관측된 모델 ID. 기록 순서를 유지하며 중복은 제거한다. 보조 호출
   * 모델은 `helpers`에만 있다.
   */
  models: string[];
  /** 실제 관측된 effort. 기록이 없으면 빈 배열이고 추정하지 않는다. */
  efforts: string[];
  /** 대화 요청(모델 왕복) 수. 보조 호출은 `helpers[].requestCount`로 따로 센다. */
  requestCount: number;
  /** 생성시간 합(ms). `wallClockMs`와 더하지 않는다. */
  busyMs: number;
  /** 이 역할의 첫 요청 시작~마지막 요청 종료 경과(ms). */
  spanMs: number;
  startedAt: number;
  endedAt: number;
  /** 토큰·비용 합계는 대화 요청과 `helpers`를 모두 한 번씩 포함한다. */
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
  /**
   * 첫 토큰까지 기다린 시간(ttft)의 합(ms). 요청 시작부터 재므로 각 요청 `duration`의 일부이며
   * `wallClockMs`와 더하지 않는다. 기록된 대화 요청이 하나도 없으면 `null`이고, 기록된 0은 0이다.
   */
  ttftMs: number | null;
  /** ttft가 기록된 대화 요청 수. 평균 첫 응답 대기 = `ttftMs / ttftRequests`. */
  ttftRequests: number;
  /** 이 역할이 부른 보조 모델 호출 내역. 합계에 다시 더하지 않는다. */
  helpers: RunHelperUsage[];
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
  /** `isError`이고 아래 두 분류에 들지 않는 결과(진짜 실패). */
  failed: number;
  /** `grep`·`test`류가 일치 없이 exit 1로 끝난 결과. 실패가 아니다. */
  noMatch: number;
  /** 사용자 메시지로 건너뛰었거나 중단·취소된 호출. */
  cancelled: number;
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
  /** 이 run의 구성 서명. Experiment Lab의 묶음 키와 같은 규칙이다. 하네스는 들어가지 않는다. */
  configSignature: string;
  /**
   * run 시작 시각에 설치돼 있던 CUELO 하네스 revision(40자 commit). WSL 갱신 기록
   * (`START old=`·`READY`·`ROLLED_BACK`·`ROLLBACK_FAILED`)으로만 정하며, 첫 기록 이전·기록 밖에서
   * 바뀐 구간·기록이 없는 PC는 `null`(unknown)이다. 추정하지 않는다.
   */
  harnessRevision: string | null;
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

/** `single`은 model·effort를 하나(또는 미기록)만 관측. `unknown`은 둘 이상 관측해 요청별 짝·순서를 모른다. */
export const EXPERIMENT_ROLE_PAIRINGS = ["single", "unknown"] as const;
export type ExperimentRolePairing = (typeof EXPERIMENT_ROLE_PAIRINGS)[number];

/**
 * 구성 서명의 한 항목. 같은 역할·모델 집합·effort 집합은 `count`로 합친다.
 *
 * `model`·`effort`는 화면용 라벨이다. 하나만 관측했으면 그 값이고, 둘 이상이면 정렬한 `{a,b}`다.
 * `pairing`이 `"unknown"`이면 이 역할에서 model 또는 effort를 둘 이상 관측한 것이다. 관측 배열은
 * 요청별 (model, effort) 짝도 순서도 담지 않으므로, 같은 집합이어도 같은 실행 조건이라고 말할 수 없다.
 * 원인(Auto effort, 모델 전환, fallback)도 이 값으로는 알 수 없다.
 */
export interface ExperimentConfigRole {
  kind: RunRoleKind;
  model: string;
  effort: string | null;
  count: number;
  /** 관측한 model 집합(정렬·중복 제거). 기록이 없으면 빈 배열. */
  models: string[];
  /** 관측한 effort 집합(정렬·중복 제거). 기록이 없으면 빈 배열이고 추정하지 않는다. */
  efforts: string[];
  pairing: ExperimentRolePairing;
}

/**
 * Experiment Lab 묶음 기준. `config`(기본)는 구성 서명만으로, `harness`는 구성 서명 x
 * 하네스 revision으로 묶는다.
 */
export const EXPERIMENT_GROUP_BYS = ["config", "harness"] as const;
export type ExperimentGroupBy = (typeof EXPERIMENT_GROUP_BYS)[number];

/** 하네스 필터에서 "기록으로 정하지 못한 run"을 가리키는 값. */
export const HARNESS_UNKNOWN_FILTER = "unknown";

/** 구성 비교의 보기 선택. `harness`는 40자 revision, `unknown`, 또는 전체(`null`)다. */
export interface ExperimentView {
  groupBy: ExperimentGroupBy;
  harness: string | null;
}

/** 하네스 revision별 run 수. `revision`이 `null`이면 unknown이다. 최근에 쓰인 revision이 먼저 온다. */
export interface ExperimentHarnessCount {
  revision: string | null;
  runCount: number;
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
  /**
   * 이 묶음의 run이 어떤 하네스 revision에서 돌았는지. `groupBy=harness`면 항목이 하나다.
   */
  harnesses: ExperimentHarnessCount[];
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
  /** 실제로 적용된 묶음 기준. 알 수 없는 요청 값은 `config`로 떨어진다. */
  groupBy: ExperimentGroupBy;
  /** 실제로 적용된 하네스 필터(40자 revision 또는 `unknown`). 전체면 `null`. */
  harness: string | null;
  /** 범위 필터 뒤·하네스 필터 전 run의 revision별 수. 하네스 선택지다. */
  harnesses: ExperimentHarnessCount[];
  unmeasured: RunUnmeasuredReason[];
}

/** 목록·집계가 한 번에 읽는 최대치. 요청이 이보다 크면 여기로 자른다. */
export const RUN_LIST_MAX_LIMIT = 50;
export const RUN_LIST_DEFAULT_LIMIT = 20;
export const EXPERIMENT_MAX_SESSIONS = 60;
export const EXPERIMENT_DEFAULT_SESSIONS = 30;

// ---------------------------------------------------------------------------
// "모델이 본 것" 요청별 보기 (읽기 전용, 근사)
// ---------------------------------------------------------------------------

/**
 * 요청 사이에 기록된 항목의 종류.
 * - `injection`: `custom_message`·`role:"custom"` 메시지(가드·JEV 조언 등 하네스가 넣은 글)
 * - `developer`: `role:"developer"` 메시지
 * - `user`: run 안에서 들어온 사용자 메시지(자식 transcript의 브리프 포함)
 * - `compaction`: 압축 요약이 앞선 기록을 대신한 지점
 * - `model`·`effort`: 모델·thinking 설정 변경
 * - `prompt`: 시스템 프롬프트 지문(`system-prompt-digest`)이 바뀐 지점. 본문은 기록에 없다.
 * - `rules`: TTSR 규칙 주입(이름만 기록)
 * - `memory`: 기억 회상. `memory_recall`은 본문이 있고, `mnemopi-recall`은 id만 있다.
 */
export const RUN_TURN_EVENT_KINDS = [
  "injection",
  "developer",
  "user",
  "compaction",
  "model",
  "effort",
  "prompt",
  "rules",
  "memory",
] as const;
export type RunTurnEventKind = (typeof RUN_TURN_EVENT_KINDS)[number];

export interface RunTurnEvent {
  /** transcript 항목 id. 전체 글은 `?entry=`로 따로 읽는다. */
  entryId: string;
  kind: RunTurnEventKind;
  /** `customType`, `[edit-lessons]` 같은 머리표, 또는 종류 이름. */
  source: string;
  at: number;
  /** 비밀값을 가린 앞부분(최대 `RUN_TURN_PREVIEW_CHARS`자). */
  preview: string;
  /** 가리기 전 전체 글자 수. 미리보기만으로 다 보이면 `preview.length`와 같다. */
  chars: number;
  /** `display:false`로 기록돼 채팅에는 보이지 않은 주입. */
  hiddenFromChat: boolean;
  /** 코어가 모델 문맥에서 빼는 종류(`autolearn-saved` 등)면 `false`. */
  sentToModel: boolean;
  /** 압축 전후 토큰. 기록에 없으면 `null`. */
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  /** `mnemopi-recall` 기록의 기억 id 수. */
  memoryIds?: number;
}

/** `failed`·`noMatch`·`cancelled`는 `RunToolTotal`과 같은 분류다. `missing`은 결과 기록이 없다. */
export const RUN_TURN_TOOL_STATUSES = ["ok", "failed", "noMatch", "cancelled", "missing"] as const;
export type RunTurnToolStatus = (typeof RUN_TURN_TOOL_STATUSES)[number];

export interface RunTurnToolCall {
  toolCallId: string;
  name: string;
  /** 비밀값을 가린 인자 JSON 앞부분. */
  argsPreview: string;
  argsChars: number;
  /** `tool_execution_start` 기록의 시작 시각. 없으면 `null`. */
  startedAt: number | null;
  /** 시작 기록~결과 기록. 둘 중 하나라도 없으면 `null`이고 추정하지 않는다. */
  durationMs: number | null;
  /** 결과 글자 수(텍스트 블록 합). 결과가 없으면 `null`. */
  resultChars: number | null;
  resultEntryId: string | null;
  status: RunTurnToolStatus;
}

export interface RunTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
}

/** 모델 요청 한 번. 앞에 들어온 항목, 그 응답이 부른 도구를 함께 담는다. */
export interface RunTurn {
  /** 이 run·이 transcript 안 순번(1부터). */
  index: number;
  /** assistant 항목 id. */
  entryId: string;
  /** 요청 시작(`message.timestamp`). 없으면 항목 기록 시각. */
  at: number;
  /** 요청 시작~응답 기록. 둘 중 하나라도 없으면 `null`. */
  durationMs: number | null;
  model: string | null;
  stopReason: string | null;
  effort: string | null;
  usage: RunTurnUsage | null;
  /** `requestControls.tools.active` 수. 기록이 없으면 `null`. */
  activeTools: number | null;
  /** 같은 transcript의 직전 요청 대비 켜진·꺼진 도구. 첫 요청은 빈 배열이다. */
  toolsAdded: string[];
  toolsRemoved: string[];
  /** 응답 본문 글자 수. */
  textChars: number;
  /** 이 요청 전에 기록된 항목(모델은 이 요청에서 처음 본다). */
  before: RunTurnEvent[];
  toolCalls: RunTurnToolCall[];
}

export interface RunTurnCounts {
  turns: number;
  /** `injection`·`developer` 종류 합. */
  injections: number;
  /** `source`별 주입 수(`injection`·`developer`만). */
  bySource: Record<string, number>;
  toolCalls: number;
  /** `failed` 상태 도구 수. */
  toolFailures: number;
}

/** `GET /api/runs/<runId>/turns` 한 쪽. */
export interface RunTurnsPage {
  runId: string;
  /** `"main"` 또는 자식 역할 id(`RunRoleSegment.id`). */
  role: string;
  /** 고를 수 있는 transcript. `main`이 먼저 온다. */
  roles: string[];
  /** `injectedOnly`면 주입이 있는 요청만 센다. */
  injectedOnly: boolean;
  /** 필터 뒤 요청 수. */
  total: number;
  offset: number;
  turns: RunTurn[];
  /** 마지막 요청 뒤에 기록된 항목. 마지막 쪽에만 싣고 나머지 쪽은 빈 배열이다. */
  trailing: RunTurnEvent[];
  /** 필터 전 이 run·transcript 전체 집계. */
  counts: RunTurnCounts;
}

/** `GET /api/runs/<runId>/turns?entry=` — 항목 하나의 전체 글(가림 적용, 상한 있음). */
export interface RunTurnEntryText {
  entryId: string;
  text: string;
  chars: number;
  truncated: boolean;
}

export interface RunPreludeDigest {
  entryId: string;
  at: number;
  digest: string;
}

/**
 * `GET /api/runs/<runId>/prelude` — 시스템 프롬프트·도구 목록.
 * `recorded`는 transcript에 실제로 남은 것, `rebuilt`는 지금 열려 있는 세션의 현재 설정으로
 * omp `/dump` 머리말 렌더러를 다시 돌린 결과다(보낸 그대로가 아니다).
 */
export interface RunPrelude {
  runId: string;
  role: string;
  recorded: {
    /** 이 run 끝까지 유효한 지문 기록. 마지막 것이 그 시점의 프롬프트다. run 이전 마지막 기록을 첫 항목으로 포함한다. */
    digests: RunPreludeDigest[];
    /** 이 run의 마지막 요청에 켜진 도구 이름. 기록이 없으면 `null`. */
    activeTools: string[] | null;
    /** 시스템 프롬프트에 들어간 기억 회상 블록(가림 적용). 없으면 `null`. */
    memoryRecall: { entryId: string; preview: string; chars: number } | null;
  };
  rebuilt:
    | {
        status: "rebuilt";
        /** 가림 적용, 상한 `RUN_PRELUDE_MAX_CHARS`. */
        text: string;
        chars: number;
        truncated: boolean;
        model: string | null;
        thinkingLevel: string | null;
        /** 지금 프롬프트의 지문. 계산할 수 없으면 `null`. */
        digest: string | null;
        /** `recorded.digests` 마지막과 같은지. 비교할 기록이 없으면 `null`. */
        matchesRecorded: boolean | null;
      }
    /** 세션이 열려 있어 다시 만들 수 있지만 `?rebuild=1`로 요청하지 않았다. */
    | { status: "available" }
    | { status: "not-loaded" };
}

export const RUN_TURN_PREVIEW_CHARS = 240;
export const RUN_TURN_ARGS_PREVIEW_CHARS = 200;
export const RUN_TURN_PAGE_DEFAULT = 30;
export const RUN_TURN_PAGE_MAX = 100;
export const RUN_TURN_ENTRY_MAX_CHARS = 100_000;
export const RUN_PRELUDE_MAX_CHARS = 400_000;
