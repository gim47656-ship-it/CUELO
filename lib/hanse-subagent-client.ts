import type { AgentMessage, SubagentSnapshot } from "@/lib/types";

export const SUBAGENT_ARCHIVE_BASE = "/api/sidecars/subagent";

export interface SubagentArchiveRecord {
  name: string;
  bytes: number;
  modified: number;
  messages: number | null;
  firstTask: string;
  /** Explicit TASK_TITLE parsed from the first assignment; absent for legacy records. */
  taskTitle?: string;
  /** Model recorded by the child's last `model_change` entry; null when the
   *  file was never scanned or holds no such entry. Never inferred. */
  model?: string | null;
  modelIsFallback?: boolean | null;
  /** Effective level from the last `thinking_level_change` entry. The entry's
   *  `configured` field is the requested value and is deliberately ignored. */
  thinkingLevel?: string | null;
  /** 종료 상태는 기록된 사실만 복원한다: 마지막 실행 세대의 assistant stopReason 이
   *  error 면 failed, abnormal exit·abort 면 aborted, 정상 exit·성공 yield 면 completed.
   *  어느 근거도 없으면(스캔 한도 초과·중간 기록만 남은 파일) null — 추정하지 않는다. */
  status?: "completed" | "failed" | "aborted" | null;
  stopReason?: string | null;
  errorMessage?: string | null;
}

export interface SubagentArchiveResponse {
  sessionId: string;
  dir: string;
  found: boolean;
  subagents: SubagentArchiveRecord[];
  listTruncated?: boolean;
}

export interface SubagentArchiveTranscriptEntry {
  role: string;
  kind: "message" | "custom";
  text: string;
  at: number | null;
  /** assistant 레코드의 발화 복원용 본문 - text 블록과 yield 보고 문자열만 남긴다. */
  message?: {
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | { type: "toolCall"; toolCallId: string; toolName: string; input: Record<string, unknown> }
    >;
    model: string;
    provider: string;
    credentialId?: number;
    stopReason?: string;
    errorMessage?: string;
  };
  /** `irc:incoming` 레코드의 발신자와 본문. 수신 경계 복원에 쓴다.
   *  `truncated`가 true면 본문이 잘렸으므로 부모 send와 본문 매칭에 쓰지 않는다. */
  irc?: { from: string; message: string; truncated?: boolean };
}

export interface SubagentArchiveTranscriptResponse {
  sessionId: string;
  name: string;
  bytes: number;
  truncated: boolean;
  entries: SubagentArchiveTranscriptEntry[];
}

export interface LiveSubagentSnapshotResponse {
  runtime: "running" | "detached";
  subagents: SubagentSnapshot[];
}

export interface LiveSubagentTranscriptEntry {
  id?: string;
  type?: string;
  message?: AgentMessage;
  /** `custom_message` 레코드의 종류. `irc:incoming` 수신 경계를 가리는 데 쓴다. */
  customType?: string;
  /** `irc:incoming`은 details.from/details.message에 발신자와 본문을 싣는다. */
  details?: unknown;
}

export interface LiveSubagentTranscriptResponse {
  fromByte: number;
  nextByte: number;
  reset: boolean;
  entries: LiveSubagentTranscriptEntry[];
}

export type SubagentIdentityState = "live-archive" | "live" | "archive";

export interface MergedSubagentRecord {
  key: string;
  identity: SubagentIdentityState;
  /**
   * How the archive file was tied to the live snapshot. `session-file` is the
   * run's own JSONL path, so its recorded model/effort belong to this run;
   * `name` only matched the agent id, which an earlier run of the same agent
   * shares, so nothing in it is evidence about this run.
   */
  archiveMatch?: "session-file" | "name";
  live?: SubagentSnapshot;
  archive?: SubagentArchiveRecord;
}

export type SubagentRole =
  | { kind: "known"; agent: string; source: SubagentSnapshot["agentSource"]; label: string }
  | { kind: "unknown" };

/**
 * 실시간 스냅샷의 agent 메타로만 역할을 판정하고 표시 라벨로 정규화한다.
 * 대문자화는 CSS가 담당하며, 카드 이름·task·아카이브 파일명에서 추론하지 않는다.
 */
export function resolveSubagentRole(record: MergedSubagentRecord): SubagentRole {
  const live = record.live;
  const agent = (live?.agent || live?.progress?.agent || "").trim();
  const label = agent.toLowerCase().split(/[-_.:/\s]+/).filter(Boolean).join(" ");
  if (!label) return { kind: "unknown" };
  return { kind: "known", agent, source: live?.agentSource ?? "bundled", label };
}

export interface SubagentTaskPresentation {
  title: string;
  stage: string | null;
  explicitTitle: boolean;
}

const TASK_GUARD_FIELD_LINE =
  /^[\t ]*(?:WORK_CLASS|PURPOSE|BLOCKS_PRIMARY|PRIMARY_DELIVERABLE|OWNED_PATHS|FINDING_ID)[\t ]*:[^\r\n]*$/i;

/** TASK_GUARD 내부의 우연한 문자열은 무시하고 공유 메타데이터 한 줄만 읽는다. */
export function readExplicitTaskTitle(task: string | undefined): string | null {
  if (!task) return null;
  const marker = /^\s*TASK_GUARD\s*:\s*$/im.exec(task);
  let body = task;
  if (marker) {
    let cursor = marker.index + marker[0].length;
    if (task[cursor] === "\r") cursor += 1;
    if (task[cursor] === "\n") cursor += 1;
    let blockEnd = cursor;
    while (cursor < task.length) {
      const newline = task.indexOf("\n", cursor);
      const physicalEnd = newline === -1 ? task.length : newline;
      const contentEnd = physicalEnd > cursor && task[physicalEnd - 1] === "\r"
        ? physicalEnd - 1
        : physicalEnd;
      if (!TASK_GUARD_FIELD_LINE.test(task.slice(cursor, contentEnd))) break;
      blockEnd = contentEnd;
      cursor = newline === -1 ? task.length : newline + 1;
    }
    const lead = marker[0].length - marker[0].trimStart().length;
    body = `${task.slice(0, marker.index + lead)}${task.slice(blockEnd)}`;
  }
  const values = [...body.matchAll(/^\s*TASK_TITLE\s*:\s*(.*?)\s*$/gim)]
    .map((match) => match[1] ?? "");
  if (
    values.length !== 1 ||
    !values[0] ||
    values[0] !== values[0].trim() ||
    !/[가-힣]/u.test(values[0])
  ) return null;
  return values[0];
}

/**
 * 카드의 stable 업무 정체성과 실행 중 단계를 분리한다. follow-up hub DM은
 * progress.task를 바꿀 수 있지만 최초 assignment의 TASK_TITLE을 덮지 않는다.
 */
export function resolveSubagentTaskPresentation(record: MergedSubagentRecord): SubagentTaskPresentation {
  const live = record.live;
  const sameRunArchive = record.archive &&
    (record.identity === "archive" || record.archiveMatch === "session-file")
    ? record.archive
    : undefined;
  const explicitTitle = [
    live?.assignment,
    live?.progress?.assignment,
    live?.task,
  ].map(readExplicitTaskTitle).find((value): value is string => value !== null)
    ?? (sameRunArchive?.taskTitle?.trim() || null);
  const intent = live?.progress?.lastIntent?.trim() || "";
  const tool = live?.progress?.currentTool?.trim() || "";
  const stage = intent && tool ? `${intent} · ${tool}` : intent || (tool ? `${tool} 실행 중` : null);
  return {
    title: explicitTitle ?? "담당 업무 미확인",
    stage,
    explicitTitle: explicitTitle !== null,
  };
}

export interface SubagentModelMeta {
  /** Full recorded model id, e.g. `anthropic/claude-opus-5`. null = unobserved. */
  model: string | null;
  /** Display-only tail of the id; the full string stays in `model`. */
  modelShort: string | null;
  modelIsFallback: boolean;
  /** Effective thinking level. null = unobserved; never the requested value. */
  effort: string | null;
}

/**
 * 실제로 기록된 모델·추론 강도만 돌려준다. 세 값(model·fallback·effort)은 모두
 * 같은 실행 세대에서만 읽는다: 실시간 스냅샷의 `progress.resolvedModel` 이
 * 그 런의 확정값이고, 아카이브는 그 런의 sessionFile 로 일치한 경우(또는
 * 아카이브 단독 레코드)에만 같은 세대다. 이름만 겹친 다른 런의 아카이브는
 * 근거가 아니므로 미관측으로 둔다. 역할 이름·전역 설정·요청값(configured)에서
 * 추정하지 않는다.
 */
export function resolveSubagentModelMeta(record: MergedSubagentRecord): SubagentModelMeta {
  const progress = record.live?.progress;
  const liveModel = typeof progress?.resolvedModel === "string" ? progress.resolvedModel.trim() : "";
  const sameRunArchive = record.archive && (record.identity === "archive" || record.archiveMatch === "session-file")
    ? record.archive
    : undefined;
  // Live snapshots carry no thinking level, so effort is only observed when
  // this run's own archive file was read.
  const archiveEffort = typeof sameRunArchive?.thinkingLevel === "string" ? sameRunArchive.thinkingLevel.trim() : "";
  if (liveModel) {
    return {
      model: liveModel,
      modelShort: liveModel.split("/").pop() || liveModel,
      modelIsFallback: progress?.resolvedModelIsFallback === true,
      effort: archiveEffort || null,
    };
  }
  const archiveModel = typeof sameRunArchive?.model === "string" ? sameRunArchive.model.trim() : "";
  return {
    model: archiveModel || null,
    modelShort: archiveModel ? (archiveModel.split("/").pop() || archiveModel) : null,
    modelIsFallback: Boolean(archiveModel) && sameRunArchive?.modelIsFallback === true,
    effort: archiveEffort || null,
  };
}

export type SubagentClientErrorKind =
  | "live-unreachable"
  | "sidecar-unreachable"
  | "http"
  | "invalid-response";

export class SubagentClientError extends Error {
  constructor(
    public readonly kind: SubagentClientErrorKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "SubagentClientError";
  }
}

export type SubagentFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HanseSubagentClient {
  getLiveSnapshots(sessionId: string, signal?: AbortSignal): Promise<LiveSubagentSnapshotResponse>;
  getLiveTranscript(
    sessionId: string,
    subagentId: string,
    fromByte: number,
    signal?: AbortSignal,
  ): Promise<LiveSubagentTranscriptResponse>;
  getArchive(sessionId: string, signal?: AbortSignal): Promise<SubagentArchiveResponse>;
  getArchiveTranscript(
    sessionId: string,
    name: string,
    limit?: number,
    signal?: AbortSignal,
  ): Promise<SubagentArchiveTranscriptResponse>;
}

/**
 * Archive candidates for a live snapshot, strongest evidence first: the run's
 * own session file, then the agent id which earlier runs also carry.
 */
function archiveCandidatesForLive(snapshot: SubagentSnapshot): Array<{ name: string; match: "session-file" | "name" }> {
  const candidates: Array<{ name: string; match: "session-file" | "name" }> = [];
  if (snapshot.sessionFile) {
    const basename = snapshot.sessionFile.split(/[\\/]/).pop()?.replace(/\.jsonl$/i, "");
    if (basename) candidates.push({ name: basename, match: "session-file" });
  }
  if (!candidates.some((candidate) => candidate.name === snapshot.id)) {
    candidates.push({ name: snapshot.id, match: "name" });
  }
  return candidates;
}

export function mergeSubagentRecords(
  live: readonly SubagentSnapshot[],
  archive: readonly SubagentArchiveRecord[],
): MergedSubagentRecord[] {
  const archiveByName = new Map(archive.map((record) => [record.name, record]));
  const usedArchiveNames = new Set<string>();
  const merged: MergedSubagentRecord[] = live.map((snapshot) => {
    const matched = archiveCandidatesForLive(snapshot)
      .find((candidate) => archiveByName.has(candidate.name) && !usedArchiveNames.has(candidate.name));
    const archived = matched ? archiveByName.get(matched.name) : undefined;
    if (archived) usedArchiveNames.add(archived.name);
    return {
      key: `live:${snapshot.id}`,
      identity: archived ? "live-archive" : "live",
      live: snapshot,
      ...(archived && matched ? { archive: archived, archiveMatch: matched.match } : {}),
    };
  });

  for (const archived of archive) {
    if (usedArchiveNames.has(archived.name)) continue;
    merged.push({
      key: `archive:${archived.name}`,
      identity: "archive",
      archive: archived,
    });
  }
  return merged;
}

async function decodeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new SubagentClientError("invalid-response", "응답 JSON을 해석할 수 없습니다.", response.status);
  }
}

function errorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = body.error;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

function validArchiveRecord(value: unknown): value is SubagentArchiveRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<SubagentArchiveRecord>;
  return typeof record.name === "string"
    && typeof record.bytes === "number"
    && typeof record.modified === "number"
    && (record.messages === null || typeof record.messages === "number")
    && (record.taskTitle === undefined || typeof record.taskTitle === "string")
    && typeof record.firstTask === "string";
}

function validArchiveTranscriptEntry(value: unknown): value is SubagentArchiveTranscriptEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<SubagentArchiveTranscriptEntry>;
  return typeof entry.role === "string"
    && (entry.kind === "message" || entry.kind === "custom")
    && typeof entry.text === "string"
    && (entry.at === null || typeof entry.at === "number");
}

function validLiveSnapshot(value: unknown): value is SubagentSnapshot {
  if (!value || typeof value !== "object") return false;
  if (!(("id" in value) && typeof value.id === "string")
    || !(("index" in value) && typeof value.index === "number")
    || !(("agent" in value) && typeof value.agent === "string")
    || !(("agentSource" in value)
      && (value.agentSource === "bundled" || value.agentSource === "user" || value.agentSource === "project"))
    || !(("status" in value)
      && (value.status === "pending"
        || value.status === "running"
        || value.status === "completed"
        || value.status === "failed"
        || value.status === "aborted"
        || value.status === "unknown"))
    || !(("lastUpdate" in value) && typeof value.lastUpdate === "number")) {
    return false;
  }
  return true;
}

function validLiveTranscriptEntry(value: unknown): value is LiveSubagentTranscriptEntry {
  if (!value || typeof value !== "object") return false;
  if ("id" in value && value.id !== undefined && typeof value.id !== "string") return false;
  if ("type" in value && value.type !== undefined && typeof value.type !== "string") return false;
  return !("message" in value)
    || value.message === undefined
    || (value.message !== null && typeof value.message === "object");
}

export function createHanseSubagentClient(
  fetchImpl: SubagentFetch = (input, init) => fetch(input, init),
  archiveBase = SUBAGENT_ARCHIVE_BASE,
): HanseSubagentClient {
  const request = async (
    input: RequestInfo | URL,
    init: RequestInit,
    unreachableKind: "live-unreachable" | "sidecar-unreachable",
  ): Promise<{ response: Response; body: unknown }> => {
    let response: Response;
    try {
      response = await fetchImpl(input, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const message = unreachableKind === "sidecar-unreachable"
        ? "Subagent 기록 사이드카(30144)에 연결할 수 없습니다."
        : "실시간 Subagent 상태에 연결할 수 없습니다.";
      throw new SubagentClientError(unreachableKind, message);
    }
    const body = await decodeJson(response);
    if (!response.ok) {
      throw new SubagentClientError("http", errorMessage(body, `HTTP ${response.status}`), response.status);
    }
    return { response, body };
  };

  return {
    async getLiveSnapshots(sessionId, signal) {
      const { body } = await request(
        `/api/agent/${encodeURIComponent(sessionId)}`,
        { method: "GET", signal },
        "live-unreachable",
      );
      if (!body || typeof body !== "object") {
        throw new SubagentClientError("invalid-response", "실시간 Subagent 응답이 올바르지 않습니다.");
      }
      const envelope = body as {
        running?: unknown;
        state?: { subagents?: unknown };
        error?: unknown;
      };
      if (typeof envelope.error === "string" && envelope.error) {
        throw new SubagentClientError("http", envelope.error);
      }
      if (envelope.running !== true) return { runtime: "detached", subagents: [] };
      const snapshots = envelope.state?.subagents;
      if (snapshots !== undefined
        && (!Array.isArray(snapshots) || !snapshots.every(validLiveSnapshot))) {
        throw new SubagentClientError("invalid-response", "실시간 Subagent 목록이 올바르지 않습니다.");
      }
      return { runtime: "running", subagents: snapshots ?? [] };
    },

    async getLiveTranscript(sessionId, subagentId, fromByte, signal) {
      const { body } = await request(
        `/api/agent/${encodeURIComponent(sessionId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "get_subagent_messages", subagentId, fromByte }),
          signal,
        },
        "live-unreachable",
      );
      if (!body || typeof body !== "object") {
        throw new SubagentClientError("invalid-response", "실시간 Subagent 기록 응답이 올바르지 않습니다.");
      }
      const envelope = body as { success?: unknown; data?: unknown; error?: unknown };
      if (typeof envelope.error === "string" && envelope.error) {
        throw new SubagentClientError("http", envelope.error);
      }
      if (envelope.success !== true || !envelope.data || typeof envelope.data !== "object") {
        throw new SubagentClientError("invalid-response", "실시간 Subagent 기록 응답이 올바르지 않습니다.");
      }
      const data = envelope.data as Partial<LiveSubagentTranscriptResponse>;
      if (!Array.isArray(data.entries)
        || !data.entries.every(validLiveTranscriptEntry)
        || typeof data.fromByte !== "number"
        || typeof data.nextByte !== "number"
        || typeof data.reset !== "boolean") {
        throw new SubagentClientError("invalid-response", "실시간 Subagent 기록 응답이 올바르지 않습니다.");
      }
      return {
        fromByte: data.fromByte,
        nextByte: data.nextByte,
        reset: data.reset,
        entries: data.entries,
      };
    },

    async getArchive(sessionId, signal) {
      const url = `${archiveBase}/archive?session=${encodeURIComponent(sessionId)}`;
      const { body } = await request(url, { method: "GET", signal }, "sidecar-unreachable");
      if (!body || typeof body !== "object") {
        throw new SubagentClientError("invalid-response", "Subagent 기록 목록 응답이 올바르지 않습니다.");
      }
      const data = body as Partial<SubagentArchiveResponse>;
      if (typeof data.sessionId !== "string"
        || typeof data.dir !== "string"
        || typeof data.found !== "boolean"
        || !Array.isArray(data.subagents)
        || !data.subagents.every(validArchiveRecord)) {
        throw new SubagentClientError("invalid-response", "Subagent 기록 목록 응답이 올바르지 않습니다.");
      }
      return {
        sessionId: data.sessionId,
        dir: data.dir,
        found: data.found,
        subagents: data.subagents,
        ...(data.listTruncated === true ? { listTruncated: true } : {}),
      };
    },

    async getArchiveTranscript(sessionId, name, limit = 400, signal) {
      const url = `${archiveBase}/transcript?session=${encodeURIComponent(sessionId)}`
        + `&name=${encodeURIComponent(name)}&limit=${encodeURIComponent(String(limit))}`;
      const { body } = await request(url, { method: "GET", signal }, "sidecar-unreachable");
      if (!body || typeof body !== "object") {
        throw new SubagentClientError("invalid-response", "Subagent 디스크 기록 응답이 올바르지 않습니다.");
      }
      const data = body as Partial<SubagentArchiveTranscriptResponse>;
      if (typeof data.sessionId !== "string"
        || typeof data.name !== "string"
        || typeof data.bytes !== "number"
        || typeof data.truncated !== "boolean"
        || !Array.isArray(data.entries)
        || !data.entries.every(validArchiveTranscriptEntry)) {
        throw new SubagentClientError("invalid-response", "Subagent 디스크 기록 응답이 올바르지 않습니다.");
      }
      return {
        sessionId: data.sessionId,
        name: data.name,
        bytes: data.bytes,
        truncated: data.truncated,
        entries: data.entries,
      };
    },
  };
}
