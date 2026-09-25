import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTIVE_CLIENT_MS = 10_000;
const RECENT_CLIENT_MS = 5 * 60_000;

export type UpdateMaintenancePhase = "DRAINING" | "QUIESCENT" | "CUTOVER";

interface ExternalUpdateRequest {
  schemaVersion: number;
  completionContractVersion: 0 | 1;
  requestId: string;
  preparedStagePrefix: string;
  stageTransactionPath: string;
  maintenanceDirectory: string;
  transactionReceiptPath: string;
  resultPath: string;
  /**
   * 배포를 시작한 세션. 추론하지 않고 launcher 호출자가 명시로 넘긴 값만 담는다.
   * 비어 있으면 자동 재개를 하지 않는다 — 잘못된 세션을 깨우는 것보다 낫다.
   */
  initiatorSessionId: string | null;
  /** 그 값이 실제로 채워졌는지. Wake가 안 나간 이유를 사후에 읽는 근거다. */
  initiatorSessionSource: "explicit" | "absent";
}

interface MaintenanceCommand {
  schemaVersion: number;
  requestId: string;
  stageHash: string;
  phase: UpdateMaintenancePhase;
  revision: number;
  updatedAtUtc: string;
}

interface ClientReceipt {
  schemaVersion: number;
  clientId: string;
  sessionId: string | null;
  resumeUrl: string;
  lastSeenAtUtc: string;
  preservationError: string | null;
}

interface ActiveDeployment {
  request: ExternalUpdateRequest;
  command: MaintenanceCommand;
}

interface CleanupProgress {
  schemaVersion: 1;
  owner: "runtime-transaction";
  ownerPid: number;
  requestId: string;
  stageHash: string;
  phase: "ARTIFACT_CLEANUP";
  status: "running" | "succeeded" | "failed" | "skipped" | "pending-approval";
  reason: string | null;
  startedAtUtc: string;
  updatedAtUtc: string;
  finishedAtUtc: string | null;
  currentTarget: string | null;
  completedCount: number;
  totalCount: number;
  removedCount: number;
  keptCount: number;
  elapsedSeconds: number;
  failureCount: number;
}

interface DeploymentCompletion {
  completionContractVersion: 1;
  completed: true;
  writeSafe: true;
  completedAtUtc: string;
  requestId: string;
  stageHash: string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function externalUpdateRoot(): string {
  const configured = process.env.CUELO_EXTERNAL_UPDATE_ROOT?.trim();
  return resolve(configured || join(homedir(), ".omp", "external-update"));
}

function readJson(path: string): JsonRecord | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function requestPath(requestId: string): string {
  return join(externalUpdateRoot(), "requests", `${requestId}.json`);
}

function resultPath(requestId: string): string {
  return join(externalUpdateRoot(), "results", `${requestId}.json`);
}

function clientPath(clientId: string): string {
  return join(externalUpdateRoot(), "clients", `${clientId}.json`);
}

function normalizeRequest(requestId: string): ExternalUpdateRequest | null {
  if (!REQUEST_ID_PATTERN.test(requestId)) return null;
  const raw = readJson(requestPath(requestId));
  if (!raw || raw.schemaVersion !== 2 || raw.requestId !== requestId) return null;
  const completionContractVersion = raw.completionContractVersion === undefined
    ? 0
    : Number(raw.completionContractVersion);
  if (completionContractVersion !== 0 && completionContractVersion !== 1) return null;
  const maintenanceDirectory = resolve(String(raw.maintenanceDirectory ?? ""));
  const expectedMaintenance = resolve(join(externalUpdateRoot(), "maintenance", requestId));
  const transactionReceiptPath = resolve(String(raw.transactionReceiptPath ?? ""));
  const expectedTransaction = resolve(join(externalUpdateRoot(), "transactions", `${requestId}.json`));
  const expectedResult = resolve(resultPath(requestId));
  if (
    maintenanceDirectory !== expectedMaintenance
    || transactionReceiptPath !== expectedTransaction
    || resolve(String(raw.resultPath ?? "")) !== expectedResult
  ) return null;
  const declaredInitiator = raw.initiatorSessionId === null || raw.initiatorSessionId === undefined
    ? ""
    : String(raw.initiatorSessionId).trim().toLowerCase();
  const initiatorSessionId = SESSION_ID_PATTERN.test(declaredInitiator) ? declaredInitiator : null;
  return {
    schemaVersion: 2,
    completionContractVersion,
    requestId,
    preparedStagePrefix: String(raw.preparedStagePrefix ?? ""),
    stageTransactionPath: String(raw.stageTransactionPath ?? ""),
    maintenanceDirectory,
    transactionReceiptPath,
    resultPath: expectedResult,
    initiatorSessionId,
    initiatorSessionSource: initiatorSessionId ? "explicit" : "absent",
  };
}

function normalizeCommand(request: ExternalUpdateRequest): MaintenanceCommand | null {
  const raw = readJson(join(request.maintenanceDirectory, "command.json"));
  if (!raw || raw.schemaVersion !== 2 || raw.requestId !== request.requestId) return null;
  const phase = raw.phase;
  const stageHash = String(raw.stageHash ?? "");
  const revision = Number(raw.revision);
  if ((phase !== "DRAINING" && phase !== "QUIESCENT" && phase !== "CUTOVER") || !SHA256_PATTERN.test(stageHash) || !Number.isInteger(revision) || revision < 1) {
    return null;
  }
  return {
    schemaVersion: 2,
    requestId: request.requestId,
    stageHash,
    phase,
    revision,
    updatedAtUtc: String(raw.updatedAtUtc ?? ""),
  };
}

function normalizeCleanupProgress(
  request: ExternalUpdateRequest,
  command: MaintenanceCommand,
): CleanupProgress | null {
  const raw = readJson(join(request.maintenanceDirectory, "cleanup.json"));
  if (
    !raw
    || raw.schemaVersion !== 1
    || raw.owner !== "runtime-transaction"
    || raw.requestId !== request.requestId
    || raw.stageHash !== command.stageHash
    || raw.phase !== "ARTIFACT_CLEANUP"
  ) return null;
  const status = raw.status;
  if (
    status !== "running" && status !== "succeeded" && status !== "failed"
    && status !== "skipped" && status !== "pending-approval"
  ) return null;
  const ownerPid = Number(raw.ownerPid);
  const completedCount = Number(raw.completedCount);
  const totalCount = Number(raw.totalCount);
  const removedCount = Number(raw.removedCount);
  const keptCount = Number(raw.keptCount);
  const elapsedSeconds = Number(raw.elapsedSeconds);
  if (
    !Number.isInteger(ownerPid) || ownerPid <= 0
    || !Number.isInteger(completedCount) || completedCount < 0
    || !Number.isInteger(totalCount) || totalCount < completedCount
    || !Number.isInteger(removedCount) || removedCount < 0
    || !Number.isInteger(keptCount) || keptCount < 0
    || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0
  ) return null;
  if (status === "succeeded" && completedCount !== totalCount) return null;
  const currentTarget = raw.currentTarget === null ? null : String(raw.currentTarget ?? "");
  if (currentTarget !== null && !currentTarget) return null;
  const startedAtUtc = String(raw.startedAtUtc ?? "");
  const updatedAtUtc = String(raw.updatedAtUtc ?? "");
  const finishedAtUtc = raw.finishedAtUtc === null ? null : String(raw.finishedAtUtc ?? "");
  if (
    !Number.isFinite(Date.parse(startedAtUtc))
    || !Number.isFinite(Date.parse(updatedAtUtc))
    || (finishedAtUtc !== null && !Number.isFinite(Date.parse(finishedAtUtc)))
  ) return null;
  return {
    schemaVersion: 1,
    owner: "runtime-transaction",
    ownerPid,
    requestId: request.requestId,
    stageHash: command.stageHash,
    phase: "ARTIFACT_CLEANUP",
    status,
    reason: raw.reason === null ? null : String(raw.reason ?? ""),
    startedAtUtc,
    updatedAtUtc,
    finishedAtUtc,
    currentTarget,
    completedCount,
    totalCount,
    removedCount,
    keptCount,
    elapsedSeconds,
    failureCount: Array.isArray(raw.failures) ? raw.failures.length : 0,
  };
}

function normalizeDeploymentCompletion(
  request: ExternalUpdateRequest,
  command: MaintenanceCommand,
): DeploymentCompletion | null {
  if (request.completionContractVersion !== 1) return null;
  const receipt = readJson(request.transactionReceiptPath);
  if (
    !receipt
    || receipt.schemaVersion !== 2
    || receipt.kind !== "ompweb-runtime-transaction"
    || receipt.requestId !== request.requestId
    || receipt.stageHash !== command.stageHash
    || receipt.success !== true
    || (receipt.phase !== "RESUME_CONFIRMED" && receipt.phase !== "RESUME_PENDING")
  ) return null;
  const deployment = asRecord(receipt.deployment);
  const service = asRecord(deployment?.service);
  const resume = asRecord(deployment?.resume);
  const rollback = asRecord(deployment?.rollback);
  const cleanupOwner = asRecord(deployment?.cleanup);
  if (
    !deployment
    || deployment.completionContractVersion !== 1
    || deployment.completed !== true
    || deployment.writeSafe !== true
    || deployment.requestId !== request.requestId
    || deployment.stageHash !== command.stageHash
    || !Number.isFinite(Date.parse(String(deployment.completedAtUtc ?? "")))
    || service?.ready !== true
    || service.exact !== true
    || service.requestId !== request.requestId
    || service.stageHash !== command.stageHash
    || rollback?.packagePresent !== true
    || rollback.transactionRecorded !== true
    || cleanupOwner?.owner !== "runtime-transaction"
  ) return null;
  const resumeStatus = String(resume?.status ?? "");
  const targetCount = Number(resume?.targetCount);
  const confirmedCount = Number(resume?.confirmedCount);
  if (
    (resumeStatus !== "confirmed" && resumeStatus !== "pending")
    || !Number.isInteger(targetCount) || targetCount < 0
    || !Number.isInteger(confirmedCount) || confirmedCount < 0 || confirmedCount > targetCount
  ) return null;
  const rollbackTransactionPath = resolve(String(rollback.transactionPath ?? ""));
  const rollbackRoot = dirname(rollbackTransactionPath);
  const rollbackPackagePath = resolve(String(rollback.packagePath ?? ""));
  const rollbackShimDirectory = resolve(String(rollback.shimDirectory ?? ""));
  // rename 전 설치에서 올라온 첫 배포는 옛 `omp-web` 패키지와 shim을 rollback으로 백업한다.
  const packageName = basename(rollbackPackagePath);
  if (packageName !== "cuelo" && packageName !== "omp-web") return null;
  const requiredShims = [packageName, `${packageName}.cmd`, `${packageName}.ps1`];
  const backedUpShims = Array.isArray(rollback.backedUpShims)
    ? rollback.backedUpShims.map((value) => String(value))
    : [];
  if (
    rollbackTransactionPath !== join(rollbackRoot, "transaction.json")
    || rollbackPackagePath !== join(rollbackRoot, packageName)
    || rollbackShimDirectory !== join(rollbackRoot, "shims")
    || !existsSync(rollbackTransactionPath)
    || !existsSync(rollbackPackagePath)
    || requiredShims.some((name) => !backedUpShims.includes(name) || !existsSync(join(rollbackShimDirectory, name)))
  ) return null;
  const expectedCleanupPath = resolve(join(request.maintenanceDirectory, "cleanup.json"));
  if (
    resolve(String(cleanupOwner.progressPath ?? "")) !== expectedCleanupPath
    || Number(cleanupOwner.ownerPid) <= 0
  ) return null;
  // cleanup progress는 배포 완료 뒤 계속 바뀌는 비필수 receipt다. 여기 의존하면 파일 교체
  // 순간이나 정리 실패가 이미 열린 메시지 쓰기 경로를 다시 잠그므로 owner 포인터만 고정한다.
  return {
    completionContractVersion: 1,
    completed: true,
    writeSafe: true,
    completedAtUtc: String(deployment.completedAtUtc),
    requestId: request.requestId,
    stageHash: command.stageHash,
  };
}
function getActiveDeployment(): ActiveDeployment | null {
  const active = readJson(join(externalUpdateRoot(), "active.json"));
  const requestId = String(active?.requestId ?? "");
  if (active?.schemaVersion !== 2 || !REQUEST_ID_PATTERN.test(requestId)) return null;
  const request = normalizeRequest(requestId);
  if (!request || existsSync(request.resultPath)) return null;
  const command = normalizeCommand(request);
  if (!command || normalizeDeploymentCompletion(request, command)) return null;
  return { request, command };
}

function normalizeResumeUrl(value: string): string | null {
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  try {
    const url = new URL(value, "http://127.0.0.1");
    if (url.origin !== "http://127.0.0.1") return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function normalizeClientReceipt(raw: JsonRecord | null): ClientReceipt | null {
  if (!raw || raw.schemaVersion !== 2) return null;
  const clientId = String(raw.clientId ?? "");
  const resumeUrl = normalizeResumeUrl(String(raw.resumeUrl ?? ""));
  const sessionId = raw.sessionId === null ? null : String(raw.sessionId ?? "");
  if (!CLIENT_ID_PATTERN.test(clientId) || !resumeUrl || (sessionId !== null && !sessionId)) return null;
  return {
    schemaVersion: 2,
    clientId,
    sessionId,
    resumeUrl,
    lastSeenAtUtc: String(raw.lastSeenAtUtc ?? ""),
    preservationError: raw.preservationError === null ? null : String(raw.preservationError ?? ""),
  };
}

export function registerUpdateClient(input: {
  clientId: string;
  sessionId: string | null;
  resumeUrl: string;
  preservationError?: string | null;
}): { phase: "IDLE" | UpdateMaintenancePhase; requestId?: string; stageHash?: string } {
  const clientId = input.clientId.trim();
  const resumeUrl = normalizeResumeUrl(input.resumeUrl);
  const sessionId = input.sessionId?.trim() || null;
  if (!CLIENT_ID_PATTERN.test(clientId) || !resumeUrl) throw new Error("invalid update client identity");
  writeJsonAtomic(clientPath(clientId), {
    schemaVersion: 2,
    clientId,
    sessionId,
    resumeUrl,
    lastSeenAtUtc: new Date().toISOString(),
    preservationError: input.preservationError?.trim() || null,
  });
  const deployment = getActiveDeployment();
  if (!deployment) return { phase: "IDLE" };
  return {
    phase: deployment.command.phase,
    requestId: deployment.request.requestId,
    stageHash: deployment.command.stageHash,
  };
}

function validateRequestCommand(requestId: string, stageHash: string): ActiveDeployment {
  const request = normalizeRequest(requestId);
  if (!request) throw new Error("invalid update request identity");
  const command = normalizeCommand(request);
  if (!command || command.stageHash !== stageHash) throw new Error("update maintenance revision mismatch");
  return { request, command };
}

export function markUpdateClientParked(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
}): ClientReceipt {
  const deployment = validateRequestCommand(input.requestId, input.stageHash);
  if (
    deployment.command.phase !== "DRAINING"
    && deployment.command.phase !== "QUIESCENT"
    && deployment.command.phase !== "CUTOVER"
  ) {
    throw new Error("update is not draining");
  }
  const client = normalizeClientReceipt(readJson(clientPath(input.clientId)));
  if (!client || client.clientId !== input.clientId) throw new Error("update client registration missing");
  writeJsonAtomic(join(deployment.request.maintenanceDirectory, "clients", `${client.clientId}.parked.json`), {
    ...client,
    requestId: input.requestId,
    stageHash: input.stageHash,
    parkedAtUtc: new Date().toISOString(),
  });
  return client;
}

export function markUpdateClientResumed(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
}): void {
  const service = getDeployedServiceIdentity();
  if (!service.ready || service.requestId !== input.requestId || service.stageHash !== input.stageHash) {
    throw new Error("deployed service identity mismatch");
  }
  const request = normalizeRequest(input.requestId);
  if (!request) throw new Error("invalid update request identity");
  const client = normalizeClientReceipt(readJson(clientPath(input.clientId)));
  if (!client) throw new Error("update client registration missing");
  if ((client.sessionId ?? null) !== (input.sessionId?.trim() || null)) throw new Error("resumed session identity mismatch");
  writeJsonAtomic(join(request.maintenanceDirectory, "clients", `${client.clientId}.resumed.json`), {
    schemaVersion: 2,
    requestId: input.requestId,
    stageHash: input.stageHash,
    clientId: client.clientId,
    sessionId: client.sessionId,
    resumeUrl: client.resumeUrl,
    resumedAtUtc: new Date().toISOString(),
  });
}

export type UpdateWakeSkipReason =
  | "deployment-incomplete"
  | "no-initiator"
  | "user-already-active"
  | "already-claimed";

export type UpdateWakeDecision =
  | { wake: true; requestId: string; stageHash: string; sessionId: string }
  | { wake: false; reason: UpdateWakeSkipReason };

/**
 * 업데이트를 시작한 바로 그 세션을 한 번만 자동 재개할지 판정하고, 발화 권리를
 * 배타적으로 가져간다.
 *
 * initiator는 launcher 호출자가 명시로 넘긴 값만 쓴다. 비어 있으면 추론하지 않고
 * 발화하지 않는다(오늘까지의 수동 재개로 떨어진다). 잘못된 세션을 깨우는 것보다
 * 안 깨우는 쪽이 낫기 때문이다.
 *
 * `<maintenance>/<requestId>/wake/<sessionId>.json`을 `wx`로 만들어 request+session당
 * 정확히 1회만 통과시킨다. 여러 탭이 동시에 복귀를 확정해도 파일을 만든 쪽만 발화한다.
 * 발화하지 않은 경우의 이유도 같은 디렉터리에 남겨 사후에 읽을 수 있게 한다.
 */
export function claimUpdateWake(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
  sessionBusy: boolean;
}): UpdateWakeDecision {
  const request = normalizeRequest(input.requestId);
  if (!request) throw new Error("invalid update request identity");
  const wakeDirectory = join(request.maintenanceDirectory, "wake");
  const resumedSessionId = input.sessionId?.trim().toLowerCase() || null;
  const skip = (reason: UpdateWakeSkipReason): UpdateWakeDecision => {
    writeJsonAtomic(join(wakeDirectory, `${input.clientId}.skipped.json`), {
      schemaVersion: 1,
      requestId: input.requestId,
      stageHash: input.stageHash,
      clientId: input.clientId,
      resumedSessionId,
      initiatorSessionId: request.initiatorSessionId,
      initiatorSessionSource: request.initiatorSessionSource,
      reason,
      observedAtUtc: new Date().toISOString(),
    });
    return { wake: false, reason };
  };

  const command = normalizeCommand(request);
  const deployment = command && command.stageHash === input.stageHash.toLowerCase()
    ? normalizeDeploymentCompletion(request, command)
    : null;
  // 정리 실패는 여기서 보지 않는다. 배포 성공과 산출물 정리 결과는 분리한다.
  if (!deployment) return skip("deployment-incomplete");
  if (!request.initiatorSessionId) return skip("no-initiator");
  // 복귀한 탭이 다른 세션을 보고 있어도 주도 세션을 깨운다(2026-09-25: 다른 세션 탭만 열려 있어 재개가 누락됨).
  // 한 번만 깨우는 것은 아래 claim 파일이 보장한다. sessionBusy는 주도 세션 기준이다.
  if (input.sessionBusy) return skip("user-already-active");

  mkdirSync(wakeDirectory, { recursive: true });
  try {
    const handle = openSync(join(wakeDirectory, `${request.initiatorSessionId}.json`), "wx");
    try {
      writeSync(handle, `${JSON.stringify({
        schemaVersion: 1,
        requestId: input.requestId,
        stageHash: input.stageHash,
        clientId: input.clientId,
        sessionId: request.initiatorSessionId,
        claimedAtUtc: new Date().toISOString(),
      }, null, 2)}\n`);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return skip("already-claimed");
    throw error;
  }
  return {
    wake: true,
    requestId: input.requestId,
    stageHash: input.stageHash,
    sessionId: request.initiatorSessionId,
  };
}

/** request에 명시된 업데이트 주도 세션. 복귀 탭이 보는 세션과 다를 수 있다. */
export function getUpdateInitiatorSessionId(requestId: string): string | null {
  return normalizeRequest(requestId)?.initiatorSessionId ?? null;
}

/**
 * 발화에 실패한 claim을 반납한다.
 *
 * claim 파일은 동시 복귀 탭 사이의 배타성 때문에 발화 **전에** 만들어야 한다. 그래서
 * 발화가 터지면 아무도 깨우지 못한 채 `already-claimed`만 남아 다음 기회까지 막힌다.
 * 실패한 쪽이 claim을 지워 그 자리를 돌려주고, 왜 실패했는지는 같은 디렉터리의
 * `<sessionId>.failed.json`에 남겨 사후에 읽는다. 서버 stdout은 보관되지 않으므로
 * 이 파일이 유일한 원인 증거다.
 *
 * 기록 쓰기가 실패해도 반납은 시도한다. 기록 오류는 삼키지 않고 호출부로 올린다.
 */
export function releaseUpdateWakeClaim(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string;
  stage: "resume" | "prompt";
  error: unknown;
}): void {
  const request = normalizeRequest(input.requestId);
  if (!request) return;
  const wakeDirectory = join(request.maintenanceDirectory, "wake");
  try {
    writeJsonAtomic(join(wakeDirectory, `${input.sessionId}.failed.json`), {
      schemaVersion: 1,
      requestId: input.requestId,
      stageHash: input.stageHash,
      clientId: input.clientId,
      sessionId: input.sessionId,
      stage: input.stage,
      error: input.error instanceof Error
        ? { name: input.error.name, message: input.error.message, stack: input.error.stack ?? null }
        : { name: "unknown", message: String(input.error), stack: null },
      failedAtUtc: new Date().toISOString(),
    });
  } finally {
    // 반납 자체가 실패해도 배포·복귀는 이미 성공이다. 여기서 더 던지지 않는다.
    try {
      rmSync(join(wakeDirectory, `${input.sessionId}.json`), { force: true });
    } catch {
      // 다음 배포의 requestId는 다르므로 남은 claim이 영구 차단을 만들지는 않는다.
    }
  }
}

export type UpdateFailureNoticeSkipReason =
  | "no-terminal-result"
  | "deployment-succeeded"
  | "no-initiator"
  | "user-already-active"
  | "already-claimed";

export type UpdateFailureNoticeDecision =
  | { notice: true; requestId: string; stageHash: string; sessionId: string; terminalError: string | null }
  | { notice: false; reason: UpdateFailureNoticeSkipReason };

/**
 * 업데이트가 실패했을 때 배포를 시작한 세션에 한 번만 실패를 알릴지 판정하고, 발화 권리를
 * 배타적으로 가져간다.
 *
 * 실패 여부는 클라이언트 주장이 아니라 서버가 result 파일에서 다시 읽는다. 요청이 보내는
 * 것은 request/세션 신원뿐이고, `terminalStatus`가 있는데 `succeeded`가 아니며 배포
 * 완료(`writeSafe`)도 아니면 실패다. 그 밖에는 실패 통지를 하지 않는다.
 *
 * 성공 Wake와 같은 request를 쓰지만 claim 파일 이름이 다르다(`<sessionId>.failure.json`).
 * 성공·실패 claim이 서로를 `already-claimed`로 막지 않게 하려는 것이다.
 */
export function claimUpdateFailureNotice(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
  sessionBusy: boolean;
}): UpdateFailureNoticeDecision {
  const request = normalizeRequest(input.requestId);
  if (!request) throw new Error("invalid update request identity");
  // clientId는 skip 기록 파일 이름이 된다. 성공 Wake는 등록된 클라이언트만 오지만 이 경로는
  // 요청 본문 값을 그대로 받으므로, 경로를 벗어나는 이름을 쓰기 전에 여기서 거부한다.
  if (!CLIENT_ID_PATTERN.test(input.clientId)) throw new Error("invalid update client identity");
  const wakeDirectory = join(request.maintenanceDirectory, "wake");
  const resumedSessionId = input.sessionId?.trim().toLowerCase() || null;
  const skip = (reason: UpdateFailureNoticeSkipReason): UpdateFailureNoticeDecision => {
    writeJsonAtomic(join(wakeDirectory, `${input.clientId}.failure-skipped.json`), {
      schemaVersion: 1,
      requestId: input.requestId,
      stageHash: input.stageHash,
      clientId: input.clientId,
      resumedSessionId,
      initiatorSessionId: request.initiatorSessionId,
      initiatorSessionSource: request.initiatorSessionSource,
      reason,
      observedAtUtc: new Date().toISOString(),
    });
    return { notice: false, reason };
  };

  const result = readJson(request.resultPath);
  const terminalStatus = result && typeof result.status === "string" ? result.status : null;
  if (terminalStatus === null) return skip("no-terminal-result");
  const command = normalizeCommand(request);
  const deployment = command && command.stageHash === input.stageHash.toLowerCase()
    ? normalizeDeploymentCompletion(request, command)
    : null;
  if (terminalStatus === "succeeded" || deployment?.writeSafe === true) return skip("deployment-succeeded");
  if (!request.initiatorSessionId) return skip("no-initiator");
  // 성공 Wake와 같이 복귀 탭의 세션과 무관하게 주도 세션에 알린다. sessionBusy는 주도 세션 기준이다.
  if (input.sessionBusy) return skip("user-already-active");

  const terminalError = typeof result?.error === "string" ? result.error : null;
  mkdirSync(wakeDirectory, { recursive: true });
  try {
    const handle = openSync(join(wakeDirectory, `${request.initiatorSessionId}.failure.json`), "wx");
    try {
      writeSync(handle, `${JSON.stringify({
        schemaVersion: 1,
        requestId: input.requestId,
        stageHash: input.stageHash,
        clientId: input.clientId,
        sessionId: request.initiatorSessionId,
        terminalStatus,
        terminalError,
        claimedAtUtc: new Date().toISOString(),
      }, null, 2)}\n`);
    } finally {
      closeSync(handle);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return skip("already-claimed");
    throw error;
  }
  return {
    notice: true,
    requestId: input.requestId,
    stageHash: input.stageHash,
    sessionId: request.initiatorSessionId,
    terminalError,
  };
}

/**
 * 발화에 실패한 실패 통지 claim을 반납한다.
 *
 * 성공 Wake의 `releaseUpdateWakeClaim`과 같은 이유다 — claim은 발화 전에 찍히므로, 발화가
 * 터지면 아무도 알리지 못한 채 그 자리만 점유된다. 실패한 쪽이 claim을 지워 다음 관측이
 * 다시 시도할 수 있게 하고, 왜 실패했는지는 `<sessionId>.failure-error.json`에 남긴다.
 * 기록 쓰기가 실패해도 반납은 시도하고, 기록 오류는 호출부로 올린다.
 */
export function releaseUpdateFailureNoticeClaim(input: {
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string;
  stage: "resume" | "prompt";
  error: unknown;
}): void {
  const request = normalizeRequest(input.requestId);
  if (!request) return;
  const wakeDirectory = join(request.maintenanceDirectory, "wake");
  try {
    writeJsonAtomic(join(wakeDirectory, `${input.sessionId}.failure-error.json`), {
      schemaVersion: 1,
      requestId: input.requestId,
      stageHash: input.stageHash,
      clientId: input.clientId,
      sessionId: input.sessionId,
      stage: input.stage,
      error: input.error instanceof Error
        ? { name: input.error.name, message: input.error.message, stack: input.error.stack ?? null }
        : { name: "unknown", message: String(input.error), stack: null },
      failedAtUtc: new Date().toISOString(),
    });
  } finally {
    try {
      rmSync(join(wakeDirectory, `${input.sessionId}.failure.json`), { force: true });
    } catch {
      // 다음 배포의 requestId는 다르므로 남은 claim이 영구 차단을 만들지는 않는다.
    }
  }
}

export function getUpdateMutationBlock(): {
  requestId: string;
  stageHash: string;
  phase: UpdateMaintenancePhase;
} | null {
  const deployment = getActiveDeployment();
  return deployment ? {
    requestId: deployment.request.requestId,
    stageHash: deployment.command.stageHash,
    phase: deployment.command.phase,
  } : null;
}

export function recordRuntimeActivity(runningSessionIds: string[]): void {
  const uniqueIds = [...new Set(runningSessionIds.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))].sort();
  writeJsonAtomic(join(externalUpdateRoot(), "runtime-activity", `${process.pid}.json`), {
    schemaVersion: 2,
    processId: process.pid,
    processStartedAtUtc: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    updatedAtUtc: new Date().toISOString(),
    runningSessionIds: uniqueIds,
  });
}

export function listUpdateClients(now = Date.now()): { active: ClientReceipt[]; recent: ClientReceipt[] } {
  const directory = join(externalUpdateRoot(), "clients");
  if (!existsSync(directory)) return { active: [], recent: [] };
  const active: ClientReceipt[] = [];
  const recent: ClientReceipt[] = [];
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(".json")) continue;
    const receipt = normalizeClientReceipt(readJson(join(directory, name)));
    if (!receipt) continue;
    const age = now - Date.parse(receipt.lastSeenAtUtc);
    if (!Number.isFinite(age) || age < 0 || age > RECENT_CLIENT_MS) continue;
    recent.push(receipt);
    if (age <= ACTIVE_CLIENT_MS) active.push(receipt);
  }
  return { active, recent };
}

export function getDeployedServiceIdentity(): {
  ready: boolean;
  requestId: string | null;
  stageHash: string | null;
  transactionId: string | null;
} {
  const requestId = process.env.CUELO_DEPLOY_REQUEST_ID?.trim() || null;
  const stageHash = process.env.CUELO_DEPLOY_STAGE_HASH?.trim().toLowerCase() || null;
  const markerPath = process.env.CUELO_DEPLOY_MARKER_PATH?.trim() || null;
  if (!requestId || !stageHash || !markerPath || !REQUEST_ID_PATTERN.test(requestId) || !SHA256_PATTERN.test(stageHash)) {
    return { ready: false, requestId, stageHash, transactionId: null };
  }
  const marker = readJson(resolve(markerPath));
  const transactionId = marker && typeof marker.transactionId === "string" ? marker.transactionId : null;
  const ready = marker?.schemaVersion === 1
    && marker.requestId === requestId
    && String(marker.stageHash ?? "").toLowerCase() === stageHash
    && typeof transactionId === "string"
    && transactionId.length > 0;
  return { ready, requestId, stageHash, transactionId };
}

export function getUpdateStatus(requestId?: string, stageHash?: string): JsonRecord {
  const service = getDeployedServiceIdentity();
  const request = requestId && REQUEST_ID_PATTERN.test(requestId) ? normalizeRequest(requestId) : null;
  const command = request ? normalizeCommand(request) : null;
  const result = request ? readJson(request.resultPath) : null;
  const deployment = request && command ? normalizeDeploymentCompletion(request, command) : null;
  const cleanup = request && command ? normalizeCleanupProgress(request, command) : null;
  const requestedHash = stageHash?.toLowerCase() || null;
  const mutationBlocked = getUpdateMutationBlock() !== null;
  return {
    schemaVersion: 2,
    phase: service.ready && service.requestId === requestId && service.stageHash === requestedHash
      ? "SERVICE_READY"
      : (command?.phase ?? "IDLE"),
    service,
    mutationBlocked,
    deploymentCompleted: deployment?.completed === true,
    writeSafe: deployment?.writeSafe === true,
    cleanup,
    terminalStatus: result && typeof result.status === "string" ? result.status : null,
    terminalError: result && typeof result.error === "string" ? result.error : null,
  };
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const UPDATE_CLIENT_ACTIVE_MS = ACTIVE_CLIENT_MS;
