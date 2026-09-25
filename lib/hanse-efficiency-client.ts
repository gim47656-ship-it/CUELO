import type {
  ExperimentConfig,
  ExperimentConfigRole,
  ExperimentResponse,
  ExperimentScope,
  RunBottleneck,
  RunDetail,
  RunListResponse,
  RunRoleSegment,
  RunSummary,
  RunToolTotal,
} from "./run-xray-types";
import {
  EXPERIMENT_SCOPES,
  RUN_OUTCOMES,
  RUN_ROLE_KINDS,
  RUN_ROLE_PURPOSES,
  RUN_UNMEASURED_REASONS,
} from "./run-xray-types";

export const EFFICIENCY_RUNS_BASE = "/api/runs";
export const EFFICIENCY_EXPERIMENTS_BASE = "/api/experiments";

export type EfficiencyClientErrorKind = "unreachable" | "http" | "invalid-response";

export class EfficiencyClientError extends Error {
  readonly kind: EfficiencyClientErrorKind;
  readonly status: number | null;

  constructor(kind: EfficiencyClientErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "EfficiencyClientError";
    this.kind = kind;
    this.status = status;
  }
}

export type EfficiencyFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HanseEfficiencyClient {
  listRuns: (sessionId: string, limit: number, signal?: AbortSignal) => Promise<RunListResponse>;
  getRun: (runId: string, signal?: AbortSignal) => Promise<RunDetail>;
  listExperiments: (
    folder: string | null,
    sessions: number,
    scope: ExperimentScope,
    signal?: AbortSignal,
  ) => Promise<ExperimentResponse>;
}

const RUN_OUTCOME_VALUES: readonly string[] = RUN_OUTCOMES;
const RUN_ROLE_KIND_VALUES: readonly string[] = RUN_ROLE_KINDS;
const RUN_ROLE_PURPOSE_VALUES: readonly string[] = RUN_ROLE_PURPOSES;
const RUN_UNMEASURED_VALUES: readonly string[] = RUN_UNMEASURED_REASONS;
const EXPERIMENT_SCOPE_VALUES: readonly string[] = EXPERIMENT_SCOPES;

// `object`로 좁힌다. `Record<string, unknown>`으로 좁히면 구체 타입으로의
// 단언이 "겹치지 않는 변환"으로 거부되므로, 이 좁히기를 쓴다.
function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validRunSummary(raw: unknown): raw is RunSummary {
  if (!isObject(raw)) return false;
  const summary = raw as RunSummary;
  return typeof summary.runId === "string"
    && typeof summary.sessionId === "string"
    && typeof summary.entryId === "string"
    && typeof summary.index === "number" && Number.isFinite(summary.index)
    && (summary.title === null || typeof summary.title === "string")
    && typeof summary.startedAt === "number" && Number.isFinite(summary.startedAt)
    && (summary.endedAt === null || (typeof summary.endedAt === "number" && Number.isFinite(summary.endedAt)))
    && typeof summary.wallClockMs === "number" && Number.isFinite(summary.wallClockMs)
    && typeof summary.outcome === "string" && RUN_OUTCOME_VALUES.includes(summary.outcome)
    && typeof summary.busyMs === "number" && Number.isFinite(summary.busyMs)
    && typeof summary.childCount === "number" && Number.isFinite(summary.childCount)
    && typeof summary.totalTokens === "number" && Number.isFinite(summary.totalTokens)
    && typeof summary.estimatedCostUsd === "number" && Number.isFinite(summary.estimatedCostUsd)
    && typeof summary.unpricedRequests === "number" && Number.isFinite(summary.unpricedRequests)
    && typeof summary.configSignature === "string";
}

function validRoleSegment(raw: unknown): raw is RunRoleSegment {
  if (!isObject(raw)) return false;
  const segment = raw as RunRoleSegment;
  return typeof segment.id === "string"
    && typeof segment.kind === "string" && RUN_ROLE_KIND_VALUES.includes(segment.kind)
    && (segment.purpose === null
      || (typeof segment.purpose === "string" && RUN_ROLE_PURPOSE_VALUES.includes(segment.purpose)))
    && isStringArray(segment.models)
    && isStringArray(segment.efforts)
    && typeof segment.requestCount === "number" && Number.isFinite(segment.requestCount)
    && typeof segment.busyMs === "number" && Number.isFinite(segment.busyMs)
    && typeof segment.spanMs === "number" && Number.isFinite(segment.spanMs)
    && typeof segment.startedAt === "number" && Number.isFinite(segment.startedAt)
    && typeof segment.endedAt === "number" && Number.isFinite(segment.endedAt)
    && typeof segment.inputTokens === "number" && Number.isFinite(segment.inputTokens)
    && typeof segment.outputTokens === "number" && Number.isFinite(segment.outputTokens)
    && typeof segment.cacheReadTokens === "number" && Number.isFinite(segment.cacheReadTokens)
    && typeof segment.cacheWriteTokens === "number" && Number.isFinite(segment.cacheWriteTokens)
    && typeof segment.totalTokens === "number" && Number.isFinite(segment.totalTokens)
    && typeof segment.estimatedCostUsd === "number" && Number.isFinite(segment.estimatedCostUsd)
    && typeof segment.unpricedRequests === "number" && Number.isFinite(segment.unpricedRequests)
    && typeof segment.untimedRequests === "number" && Number.isFinite(segment.untimedRequests)
    && typeof segment.errorCount === "number" && Number.isFinite(segment.errorCount)
    && typeof segment.abortedCount === "number" && Number.isFinite(segment.abortedCount)
    && typeof segment.toolCalls === "number" && Number.isFinite(segment.toolCalls);
}

function validBottleneck(raw: unknown): raw is RunBottleneck {
  if (!isObject(raw)) return false;
  const bottleneck = raw as RunBottleneck;
  return (bottleneck.kind === "role-busy" || bottleneck.kind === "unmeasured-gap")
    && typeof bottleneck.id === "string"
    && typeof bottleneck.ms === "number" && Number.isFinite(bottleneck.ms)
    && typeof bottleneck.relative === "number" && Number.isFinite(bottleneck.relative);
}

function validToolTotal(raw: unknown): raw is RunToolTotal {
  if (!isObject(raw)) return false;
  const total = raw as RunToolTotal;
  return typeof total.toolName === "string"
    && typeof total.calls === "number" && Number.isFinite(total.calls)
    && typeof total.errors === "number" && Number.isFinite(total.errors);
}

function validExperimentConfigRole(raw: unknown): raw is ExperimentConfigRole {
  if (!isObject(raw)) return false;
  const role = raw as ExperimentConfigRole;
  return typeof role.kind === "string" && RUN_ROLE_KIND_VALUES.includes(role.kind)
    && typeof role.model === "string"
    && (role.effort === null || typeof role.effort === "string")
    && typeof role.count === "number" && Number.isFinite(role.count);
}

function validExperimentConfig(raw: unknown): raw is ExperimentConfig {
  if (!isObject(raw)) return false;
  const config = raw as ExperimentConfig;
  return typeof config.signature === "string"
    && Array.isArray(config.roles) && config.roles.every(validExperimentConfigRole)
    && typeof config.runCount === "number" && Number.isFinite(config.runCount)
    && typeof config.medianWallClockMs === "number" && Number.isFinite(config.medianWallClockMs)
    && typeof config.medianBusyMs === "number" && Number.isFinite(config.medianBusyMs)
    && typeof config.medianTotalTokens === "number" && Number.isFinite(config.medianTotalTokens)
    && typeof config.medianEstimatedCostUsd === "number" && Number.isFinite(config.medianEstimatedCostUsd)
    && typeof config.totalEstimatedCostUsd === "number" && Number.isFinite(config.totalEstimatedCostUsd)
    && typeof config.unpricedRuns === "number" && Number.isFinite(config.unpricedRuns)
    && typeof config.untimedRuns === "number" && Number.isFinite(config.untimedRuns)
    && typeof config.reworkRuns === "number" && Number.isFinite(config.reworkRuns)
    && typeof config.errorRuns === "number" && Number.isFinite(config.errorRuns)
    && typeof config.childRunsAvg === "number" && Number.isFinite(config.childRunsAvg)
    && typeof config.firstSeenAt === "number" && Number.isFinite(config.firstSeenAt)
    && typeof config.lastSeenAt === "number" && Number.isFinite(config.lastSeenAt);
}

function validUnmeasuredList(raw: unknown): boolean {
  return Array.isArray(raw)
    && raw.every((item) => typeof item === "string" && RUN_UNMEASURED_VALUES.includes(item));
}

/**
 * 목록 응답. 깨진 필드는 버리지 않고 전체를 `invalid-response`로 실패한다.
 * 서버를 신뢰하지 않으므로 배열·숫자·열거값을 모두 확인한다.
 */
export function parseRunListResponse(raw: unknown): RunListResponse {
  if (!isObject(raw)) {
    throw new EfficiencyClientError("invalid-response", "실행 목록 응답이 올바르지 않습니다.");
  }
  const response = raw as RunListResponse;
  const valid = typeof response.sessionId === "string"
    && Array.isArray(response.runs) && response.runs.every(validRunSummary)
    && validUnmeasuredList(response.unmeasured);
  if (!valid) {
    throw new EfficiencyClientError("invalid-response", "실행 목록 응답이 올바르지 않습니다.");
  }
  return response;
}

/**
 * run 상세 응답. 역할·병목·도구 집계까지 같은 규칙으로 검증한다.
 */
export function parseRunDetail(raw: unknown): RunDetail {
  if (!validRunSummary(raw)) {
    throw new EfficiencyClientError("invalid-response", "실행 상세 응답이 올바르지 않습니다.");
  }
  const detail = raw as RunDetail;
  const valid = Array.isArray(detail.roles) && detail.roles.every(validRoleSegment)
    && Array.isArray(detail.bottlenecks) && detail.bottlenecks.every(validBottleneck)
    && typeof detail.unmeasuredMs === "number" && Number.isFinite(detail.unmeasuredMs)
    && Array.isArray(detail.toolTotals) && detail.toolTotals.every(validToolTotal)
    && validUnmeasuredList(detail.unmeasured);
  if (!valid) {
    throw new EfficiencyClientError("invalid-response", "실행 상세 응답이 올바르지 않습니다.");
  }
  return detail;
}

/**
 * 구성 비교 응답. 중앙값·합계·비율을 그대로 검증하며 재계산하지 않는다.
 */
export function parseExperimentResponse(raw: unknown): ExperimentResponse {
  if (!isObject(raw)) {
    throw new EfficiencyClientError("invalid-response", "구성 비교 응답이 올바르지 않습니다.");
  }
  const response = raw as ExperimentResponse;
  const valid = (response.folder === null || typeof response.folder === "string")
    && isStringArray(response.folders)
    && typeof response.scope === "string" && EXPERIMENT_SCOPE_VALUES.includes(response.scope)
    && Array.isArray(response.configs) && response.configs.every(validExperimentConfig)
    && typeof response.runCount === "number" && Number.isFinite(response.runCount)
    && typeof response.sessionCount === "number" && Number.isFinite(response.sessionCount)
    && typeof response.excludedRunCount === "number" && Number.isFinite(response.excludedRunCount)
    && validUnmeasuredList(response.unmeasured);
  if (!valid) {
    throw new EfficiencyClientError("invalid-response", "구성 비교 응답이 올바르지 않습니다.");
  }
  return response;
}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new EfficiencyClientError("invalid-response", "효율 응답 JSON을 해석할 수 없습니다.", response.status);
  }
}

function decodeRunList(body: unknown, fallback: string, status: number | null = null): RunListResponse {
  try {
    return parseRunListResponse(body);
  } catch {
    throw new EfficiencyClientError("invalid-response", fallback, status);
  }
}

function decodeRunDetail(body: unknown, fallback: string, status: number | null = null): RunDetail {
  try {
    return parseRunDetail(body);
  } catch {
    throw new EfficiencyClientError("invalid-response", fallback, status);
  }
}

function decodeExperiments(body: unknown, fallback: string, status: number | null = null): ExperimentResponse {
  try {
    return parseExperimentResponse(body);
  } catch {
    throw new EfficiencyClientError("invalid-response", fallback, status);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body !== null && typeof body === "object" && "error" in body
    && typeof body.error === "string" && body.error) {
    return body.error;
  }
  return fallback;
}

export function createHanseEfficiencyClient(
  fetchImpl: EfficiencyFetch = (input, init) => fetch(input, init),
): HanseEfficiencyClient {
  const request = async (
    input: RequestInfo | URL,
    init: RequestInit,
  ): Promise<{ response: Response; body: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new EfficiencyClientError("unreachable", "효율 기록에 연결할 수 없습니다.");
    }
    const body = await decodeJson(response);
    if (!response.ok) {
      throw new EfficiencyClientError("http", errorMessage(body, `HTTP ${response.status}`), response.status);
    }
    return { response, body };
  };

  return {
    async listRuns(sessionId, limit, signal) {
      const { response, body } = await request(
        `${EFFICIENCY_RUNS_BASE}?sessionId=${encodeURIComponent(sessionId)}&limit=${encodeURIComponent(String(limit))}`,
        { method: "GET", signal },
      );
      return decodeRunList(body, "실행 목록 응답이 올바르지 않습니다.", response.status);
    },

    async getRun(runId, signal) {
      const { response, body } = await request(
        `${EFFICIENCY_RUNS_BASE}/${encodeURIComponent(runId)}`,
        { method: "GET", signal },
      );
      return decodeRunDetail(body, "실행 상세 응답이 올바르지 않습니다.", response.status);
    },

    async listExperiments(folder, sessions, scope, signal) {
      const params = new URLSearchParams();
      if (folder !== null && folder !== "") params.set("folder", folder);
      params.set("sessions", String(sessions));
      params.set("scope", scope);
      const { response, body } = await request(
        `${EFFICIENCY_EXPERIMENTS_BASE}?${params.toString()}`,
        { method: "GET", signal },
      );
      return decodeExperiments(body, "구성 비교 응답이 올바르지 않습니다.", response.status);
    },
  };
}
