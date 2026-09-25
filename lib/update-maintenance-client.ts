"use client";

import { persistDraftsForReload } from "./draft-store";

const CLIENT_ID_KEY = "ompweb-update-client-id";
const RESUME_INTENT_KEY = "ompweb-update-resume-intent-v2";
const RETURN_KEY = "ompweb-update-return-v1";

/**
 * 업데이트 복귀 확인 결과, 서버에서 이 세션의 run이 시작됐거나 이미 돌고 있음을 알리는 window
 * 이벤트(`detail.sessionId`). 유휴 화면은 서버에서 시작된 run을 스스로 알 수 없으므로 채팅 훅이
 * 이것을 받아 그 run에 붙는다.
 */
export const UPDATE_WAKE_EVENT = "ompweb:update-wake";

export interface UpdateResumeIntent {
  schemaVersion: 2;
  requestId: string;
  stageHash: string;
  clientId: string;
  sessionId: string | null;
  resumeUrl: string;
}

/**
 * 복귀한 탭이 "방금 끝난 업데이트"를 계속 가리키기 위한 기록. resume 의도와 달리
 * 복귀 뒤에도 남아야 cleanup 진행/완료/실패를 같은 request 기준으로 읽을 수 있다.
 */
export interface UpdateReturnRecord {
  schemaVersion: 1;
  requestId: string;
  stageHash: string;
  dismissed: boolean;
}

/** 배포 뒤에도 계속 바뀌는 cleanup receipt의 실측값. 없는 값은 만들지 않는다. */
export interface UpdateCleanupSnapshot {
  status: "running" | "succeeded" | "failed" | "skipped" | "pending-approval";
  currentTarget: string | null;
  completedCount: number;
  totalCount: number;
  removedCount: number;
  keptCount: number;
  elapsedSeconds: number;
  failureCount: number;
}

export interface UpdateReturnStatus {
  requestId: string;
  stageHash: string;
  deploymentCompleted: boolean;
  writeSafe: boolean;
  terminalStatus: string | null;
  cleanup: UpdateCleanupSnapshot | null;
}

/** 성공·건너뜀처럼 더 읽을 것이 없는 줄이 남아 있는 시간. */
export const SETTLED_CLEANUP_AUTO_HIDE_MS = 8_000;
/** 정리 실패는 읽을 시간이 더 필요하므로 오래 두되 영구 잔류시키지는 않는다. */
export const FAILED_CLEANUP_AUTO_HIDE_MS = 30_000;

/** 상단 업데이트 상태 줄의 표시 내용과 사라지는 조건. */
export interface UpdateCleanupBanner {
  tone: "neutral" | "positive" | "warning";
  title: string;
  detail: string;
  /** 사용자가 직접 닫을 수 있는지. 정리 진행 중에는 닫지 않는다. */
  dismissible: boolean;
  /** 이 시간이 지나면 스스로 닫힌다. `null`이면 상태가 바뀔 때까지 유지한다. */
  autoHideMs: number | null;
}

/**
 * 정리 상태별로 상태 줄이 스스로 사라지기까지의 시간. 진행 중이거나 아직 receipt를
 * 못 읽은 동안에는 사라지지 않는다.
 */
export function updateCleanupAutoHideMs(status: UpdateCleanupSnapshot["status"] | null): number | null {
  if (status === null || status === "running") return null;
  return status === "failed" ? FAILED_CLEANUP_AUTO_HIDE_MS : SETTLED_CLEANUP_AUTO_HIDE_MS;
}

interface HeartbeatResponse {
  schemaVersion: number;
  phase: "IDLE" | "DRAINING" | "QUIESCENT" | "CUTOVER";
  /** 서버 프로세스 식별값. 이전 heartbeat와 다르면 서버가 재시작된 것이다. */
  serverBootId?: string;
  requestId?: string;
  stageHash?: string;
  update?: UpdateReturnStatus;
}

function randomClientId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID().replaceAll("-", "");
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function getUpdateClientId(): string {
  const existing = sessionStorage.getItem(CLIENT_ID_KEY);
  if (existing && /^[A-Za-z0-9_-]{16,128}$/.test(existing)) return existing;
  const created = randomClientId();
  sessionStorage.setItem(CLIENT_ID_KEY, created);
  return created;
}

export function readUpdateResumeIntent(): UpdateResumeIntent | null {
  const raw = sessionStorage.getItem(RESUME_INTENT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UpdateResumeIntent>;
    if (
      value.schemaVersion !== 2
      || typeof value.requestId !== "string"
      || !/^[0-9a-f]{32}$/.test(value.requestId)
      || typeof value.stageHash !== "string"
      || !/^[0-9a-f]{64}$/.test(value.stageHash)
      || typeof value.clientId !== "string"
      || typeof value.resumeUrl !== "string"
      || (value.sessionId !== null && typeof value.sessionId !== "string")
    ) return null;
    return value as UpdateResumeIntent;
  } catch {
    return null;
  }
}

export function clearUpdateResumeIntent(): void {
  sessionStorage.removeItem(RESUME_INTENT_KEY);
}

export function readUpdateReturn(): UpdateReturnRecord | null {
  const raw = sessionStorage.getItem(RETURN_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<UpdateReturnRecord>;
    if (
      value.schemaVersion !== 1
      || typeof value.requestId !== "string"
      || !/^[0-9a-f]{32}$/.test(value.requestId)
      || typeof value.stageHash !== "string"
      || !/^[0-9a-f]{64}$/.test(value.stageHash)
      || typeof value.dismissed !== "boolean"
    ) return null;
    return value as UpdateReturnRecord;
  } catch {
    return null;
  }
}

export function recordUpdateReturn(input: { requestId: string; stageHash: string }): UpdateReturnRecord {
  const existing = readUpdateReturn();
  // 같은 request로 다시 복귀했으면 사용자가 이미 닫은 알림을 되살리지 않는다.
  if (existing && existing.requestId === input.requestId && existing.stageHash === input.stageHash) return existing;
  const record: UpdateReturnRecord = {
    schemaVersion: 1,
    requestId: input.requestId,
    stageHash: input.stageHash,
    dismissed: false,
  };
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(record));
  } catch {
    // 저장이 막혀도 이번 탭의 상태 표시는 메모리 상태로 계속된다.
  }
  return record;
}

/**
 * 복귀 화면의 업데이트 상태 한 줄. 배포 성공과 임시 산출물 정리를 분리해 읽고,
 * cleanup receipt에 실제로 적힌 값(완료수/전체·경과·현재 대상·보존 건수)만 쓴다.
 * 정리 실패는 업데이트 실패가 아니므로 tone을 critical로 올리지 않는다. 정리가 끝난
 * 상태는 실패를 포함해 사용자가 닫을 수 있고 `autoHideMs` 뒤 스스로 사라진다.
 * 실패 증거 자체는 배포 receipt에 남으므로 줄이 사라져도 유실되지 않는다.
 */
export function describeUpdateCleanup(cleanup: UpdateCleanupSnapshot | null): UpdateCleanupBanner {
  if (!cleanup) {
    return {
      tone: "neutral",
      title: "업데이트 완료",
      detail: "임시 산출물 정리 상태를 확인하고 있습니다.",
      dismissible: true,
      autoHideMs: null,
    };
  }
  const counts = `${cleanup.completedCount}/${cleanup.totalCount} 완료`;
  const elapsed = `${Math.round(cleanup.elapsedSeconds)}초 경과`;
  if (cleanup.status === "running") {
    return {
      tone: "neutral",
      title: "업데이트 완료 · 산출물 정리 중",
      detail: `${counts} · ${elapsed} · 현재 ${cleanup.currentTarget ?? "대상 선택 중"}`,
      dismissible: false,
      autoHideMs: null,
    };
  }
  if (cleanup.status === "failed") {
    return {
      tone: "warning",
      title: "업데이트 완료 · 산출물 정리 실패",
      detail: `${counts} · ${elapsed} · 보존 ${cleanup.keptCount}건 · 실패 ${cleanup.failureCount}건. 업데이트 자체는 성공했고 실패 증거는 보존했습니다.`,
      dismissible: true,
      autoHideMs: updateCleanupAutoHideMs(cleanup.status),
    };
  }
  if (cleanup.status === "pending-approval") {
    return {
      tone: "neutral",
      title: "업데이트 완료 · 산출물 정리 승인 대기",
      detail: `${counts} · ${elapsed} · 보존 ${cleanup.keptCount}건. 삭제는 승인 후 실행합니다.`,
      dismissible: true,
      autoHideMs: updateCleanupAutoHideMs(cleanup.status),
    };
  }
  if (cleanup.status === "skipped") {
    return {
      tone: "neutral",
      title: "업데이트 완료 · 산출물 정리 건너뜀",
      detail: `${counts} · ${elapsed}`,
      dismissible: true,
      autoHideMs: updateCleanupAutoHideMs(cleanup.status),
    };
  }
  return {
    tone: "positive",
    title: "업데이트 완료 · 산출물 정리 완료",
    detail: `${counts} · ${elapsed}`,
    dismissible: true,
    autoHideMs: updateCleanupAutoHideMs(cleanup.status),
  };
}

/** 정리가 끝난 알림을 닫는다. 닫힘은 그 request에만 적용된다. */
export function dismissUpdateReturn(requestId: string): UpdateReturnRecord | null {
  const existing = readUpdateReturn();
  if (!existing || existing.requestId !== requestId) return existing;
  const record: UpdateReturnRecord = { ...existing, dismissed: true };
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(record));
  } catch {
    // 닫힘을 저장하지 못해도 이번 화면에서는 닫힌 상태로 유지한다.
  }
  return record;
}

export async function heartbeatUpdateClient(input: {
  sessionId: string | null;
  resumeUrl: string;
  preservationError?: string | null;
  /** 복귀 화면이 계속 읽어야 하는 직전 업데이트. 없으면 서버는 상태를 싣지 않는다. */
  update?: { requestId: string; stageHash: string } | null;
}): Promise<HeartbeatResponse> {
  const response = await fetch("/api/update-maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify({
      action: "heartbeat",
      clientId: getUpdateClientId(),
      sessionId: input.sessionId,
      resumeUrl: input.resumeUrl,
      preservationError: input.preservationError ?? null,
      ...(input.update ? { requestId: input.update.requestId, stageHash: input.update.stageHash } : {}),
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`maintenance heartbeat HTTP ${response.status}`);
  return await response.json() as HeartbeatResponse;
}

export function enterUpdateMaintenance(input: {
  requestId: string;
  stageHash: string;
  sessionId: string | null;
  resumeUrl: string;
}): { entered: true } | { entered: false; error: string } {
  const drafts = persistDraftsForReload();
  if (!drafts.ok) return { entered: false, error: drafts.error };
  const intent: UpdateResumeIntent = {
    schemaVersion: 2,
    requestId: input.requestId,
    stageHash: input.stageHash,
    clientId: getUpdateClientId(),
    sessionId: input.sessionId,
    resumeUrl: input.resumeUrl,
  };
  try {
    sessionStorage.setItem(RESUME_INTENT_KEY, JSON.stringify(intent));
  } catch (error) {
    return { entered: false, error: error instanceof Error ? error.message : String(error) };
  }
  const query = new URLSearchParams({
    mode: "wait",
    requestId: intent.requestId,
    stageHash: intent.stageHash,
    clientId: intent.clientId,
  });
  window.location.replace(`/api/update-maintenance?${query}`);
  return { entered: true };
}

export async function confirmUpdateResume(intent: UpdateResumeIntent): Promise<void> {
  if (intent.sessionId) {
    const detail = await fetch(`/api/sessions/${encodeURIComponent(intent.sessionId)}?deferThinking=1&deferMedia=1`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!detail.ok) throw new Error(`session resume HTTP ${detail.status}`);
    const body = await detail.json() as { sessionId?: string };
    if (body.sessionId !== intent.sessionId) throw new Error("resumed session identity mismatch");
  }
  const response = await fetch("/api/update-maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
    body: JSON.stringify({
      action: "resume-confirm",
      requestId: intent.requestId,
      stageHash: intent.stageHash,
      clientId: intent.clientId,
      sessionId: intent.sessionId,
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`resume confirm HTTP ${response.status}`);
  // 본문을 못 읽어도 복귀 확인은 끝났다. 기록은 그대로 남기고 알릴 것만 없다.
  const body = await response.json().catch(() => null) as { wake?: { wake?: unknown; reason?: unknown } } | null;
  recordUpdateReturn({ requestId: intent.requestId, stageHash: intent.stageHash });
  clearUpdateResumeIntent();
  // 서버는 Wake prompt를 실행 중으로 세운 뒤(`wake:true`), 먼저 claim한 탭의 발화 준비가 끝난 뒤
  // (`already-claimed`), 또는 세션이 이미 실행 중일 때(`user-already-active`)만 이렇게 답한다.
  // 그러니 지금 한 번 확인하면 그 run을 놓치지 않는다. 새 prompt는 보내지 않는다.
  const wake = body?.wake;
  if (
    intent.sessionId
    && (wake?.wake === true || wake?.reason === "already-claimed" || wake?.reason === "user-already-active")
  ) {
    window.dispatchEvent(new CustomEvent(UPDATE_WAKE_EVENT, { detail: { sessionId: intent.sessionId } }));
  }
}
