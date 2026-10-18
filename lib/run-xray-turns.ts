/**
 * Run X-Ray "모델이 본 것" — run 하나를 모델 요청 단위로 다시 맞춘 읽기 전용 보기.
 *
 * 세션 JSONL에 실제로 남은 것만 쓴다. 요청마다 보낸 시스템 프롬프트 본문과 도구 스키마,
 * `context` 훅이 바꾼 메시지는 기록에 없으므로 이 보기는 근사치다. 시스템 프롬프트는
 * 지문(`system-prompt-digest`)과 기억 회상 블록(`memory_recall`), 요청별 켜진 도구 이름
 * (`requestControls.tools.active`)만 기록돼 있다.
 *
 * - 부모 transcript의 run 경계는 stats.db `user_messages`와 같은 사용자 항목 id다(파일 순서).
 * - 자식 transcript는 부모 run 창의 시각 `[windowStart, windowEnd)`로 자른다.
 * - 미리보기·전체 글·인자는 모두 `maskSecrets`를 거친다.
 */

import { readFileSync, statSync } from "node:fs";
import type { Model } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
  formatSessionDumpText,
  type SessionDumpToolInfo,
} from "@oh-my-pi/pi-coding-agent/session/session-dump-format";
import { RunXrayError, classifyToolError, type RunTranscriptLocation } from "./run-xray";
import {
  RUN_PRELUDE_MAX_CHARS,
  RUN_TURN_ARGS_PREVIEW_CHARS,
  RUN_TURN_ENTRY_MAX_CHARS,
  RUN_TURN_PAGE_MAX,
  RUN_TURN_PREVIEW_CHARS,
  type RunPrelude,
  type RunPreludeDigest,
  type RunTurn,
  type RunTurnCounts,
  type RunTurnEntryText,
  type RunTurnEvent,
  type RunTurnsPage,
  type RunTurnToolCall,
  type RunTurnToolStatus,
} from "./run-xray-types";
import { maskSecrets } from "./session-recall";

/**
 * 코어가 모델 문맥에서 빼는 custom 메시지 종류. `autolearn-saved`는 CUELO 코어 패치
 * (`session/messages.ts` convertToLlm), 나머지는 `session/session-context.ts`가 뺀다.
 */
const NOT_SENT_CUSTOM_TYPES: Record<string, true> = {
  "autolearn-saved": true,
  "prewalk-plan": true,
  "vibe-mode-context": true,
};

const DIGEST_LINE = '{"type":"custom","customType":"system-prompt-digest"';
const MEMORY_LINE = '{"type":"custom","customType":"memory_recall"';
const MESSAGE_ID_PREFIX = '{"type":"message","id":"';
/** 접두사가 맞지 않는 줄의 대체 판정. 키 순서·공백이 달라도 같은 줄로 본다. */
const MESSAGE_TYPE_RE = /"type"\s*:\s*"message"/;
const PRELUDE_TYPE_RE = /"customType"\s*:\s*"(?:system-prompt-digest|memory_recall)"/;

/** 이 보기가 읽는 JSONL 항목 필드. 나머지 필드는 무시한다. */
interface StoredRecord {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  customType?: unknown;
  content?: unknown;
  display?: unknown;
  data?: unknown;
  summary?: unknown;
  tokensBefore?: unknown;
  tokensAfter?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  injectedRules?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    customType?: unknown;
    display?: unknown;
    model?: unknown;
    stopReason?: unknown;
    timestamp?: unknown;
    usage?: unknown;
    requestControls?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
    details?: unknown;
  };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 문자열이거나 `{type:"text"}` 블록 배열인 content의 글. 이미지 블록은 세지 않는다. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function maskedPreview(text: string, limit: number): string {
  return maskSecrets(text).text.slice(0, limit);
}

/**
 * 라우트로 나가는 값의 모든 문자열(객체 키 포함)을 가린다. customType·개발자 태그·도구 이름·
 * 모델 이름도 기록에서 온 문자열이라 토큰이 섞일 수 있다.
 */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskSecrets(value).text as T;
  if (Array.isArray(value)) return value.map((item: unknown) => maskDeep(item)) as T;
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[maskSecrets(key).text] = maskDeep(item);
  return out as T;
}

/** 라우트 오류 응답 문구. 예외 메시지에 경로·인자가 섞일 수 있어 가린다. */
export function maskedErrorMessage(error: unknown): string {
  return maskSecrets(error instanceof Error ? error.message : String(error)).text;
}

function newEvent(
  record: StoredRecord,
  kind: RunTurnEvent["kind"],
  source: string,
  text: string,
  extra: Partial<RunTurnEvent> = {},
): RunTurnEvent {
  return {
    entryId: typeof record.id === "string" ? record.id : "",
    kind,
    source,
    at: isoTime(record.timestamp) ?? 0,
    preview: maskedPreview(text, RUN_TURN_PREVIEW_CHARS),
    chars: text.length,
    hiddenFromChat: false,
    sentToModel: true,
    ...extra,
  };
}

interface ToolResultRecord {
  entryId: string;
  at: number | null;
  isError: boolean;
  synthetic: boolean;
  text: string;
}

export interface BuiltRunTurns {
  turns: RunTurn[];
  trailing: RunTurnEvent[];
  counts: RunTurnCounts;
  /** 창 안에서 기록된 시스템 프롬프트 지문. */
  digests: RunPreludeDigest[];
  /** 창 안 마지막 요청에 켜진 도구. */
  lastActiveTools: string[] | null;
  /** 창 안 마지막 기억 회상 블록. */
  memoryRecall: StoredRecord | null;
}

/**
 * 창 안 기록(파일 순서)을 모델 요청 단위로 묶는다. 요청 사이에 기록된 항목은 다음 요청의
 * `before`에 들어간다. 모델은 그 요청에서 처음 그 항목을 본다. 마지막 요청 뒤의 항목은
 * `trailing`이다.
 */
export function buildRunTurns(records: readonly StoredRecord[]): BuiltRunTurns {
  const turns: RunTurn[] = [];
  const callsById = new Map<string, { call: RunTurnToolCall; command: string | null }>();
  const starts = new Map<string, number>();
  const results = new Map<string, ToolResultRecord>();
  const digests: RunPreludeDigest[] = [];
  let pending: RunTurnEvent[] = [];
  let previousActive: string[] | null = null;
  let memoryRecall: StoredRecord | null = null;

  for (const record of records) {
    const type = record.type;
    if (type === "message" && isRecord(record.message)) {
      const message = record.message;
      const role = message.role;
      if (role === "assistant") {
        const content = Array.isArray(message.content) ? message.content : [];
        const toolCalls: RunTurnToolCall[] = [];
        let textChars = 0;
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (block.type === "text" && typeof block.text === "string") textChars += block.text.length;
          if (block.type !== "toolCall" || typeof block.id !== "string") continue;
          const args = isRecord(block.arguments) ? block.arguments : {};
          const argsJson = JSON.stringify(args);
          const call: RunTurnToolCall = {
            toolCallId: block.id,
            name: typeof block.name === "string" ? block.name : "?",
            argsPreview: maskedPreview(argsJson, RUN_TURN_ARGS_PREVIEW_CHARS),
            argsChars: argsJson.length,
            startedAt: null,
            durationMs: null,
            resultChars: null,
            resultEntryId: null,
            status: "missing",
          };
          toolCalls.push(call);
          callsById.set(block.id, { call, command: typeof args.command === "string" ? args.command : null });
        }
        const controls = isRecord(message.requestControls) ? message.requestControls : null;
        const toolsInfo = controls && isRecord(controls.tools) ? controls.tools : null;
        const active = toolsInfo && Array.isArray(toolsInfo.active)
          ? toolsInfo.active.filter((name): name is string => typeof name === "string")
          : null;
        const effortInfo = controls && isRecord(controls.effort) ? controls.effort : null;
        const usage = isRecord(message.usage) ? message.usage : null;
        const cost = usage && isRecord(usage.cost) ? usage.cost : null;
        const requestStart = finiteNumber(message.timestamp);
        const recordedAt = isoTime(record.timestamp);
        const previous = previousActive;
        turns.push({
          index: turns.length + 1,
          entryId: typeof record.id === "string" ? record.id : "",
          at: requestStart ?? recordedAt ?? 0,
          durationMs: requestStart !== null && recordedAt !== null && recordedAt >= requestStart
            ? recordedAt - requestStart
            : null,
          model: typeof message.model === "string" ? message.model : null,
          stopReason: typeof message.stopReason === "string" ? message.stopReason : null,
          effort: effortInfo && typeof effortInfo.topLevel === "string" ? effortInfo.topLevel : null,
          usage: usage
            ? {
                input: finiteNumber(usage.input) ?? 0,
                output: finiteNumber(usage.output) ?? 0,
                cacheRead: finiteNumber(usage.cacheRead) ?? 0,
                cacheWrite: finiteNumber(usage.cacheWrite) ?? 0,
                totalTokens: finiteNumber(usage.totalTokens) ?? 0,
                costUsd: (cost && finiteNumber(cost.total)) ?? 0,
              }
            : null,
          activeTools: active ? active.length : null,
          toolsAdded: active && previous ? active.filter((name) => !previous.includes(name)) : [],
          toolsRemoved: active && previous ? previous.filter((name) => !active.includes(name)) : [],
          textChars,
          before: pending,
          toolCalls,
        });
        pending = [];
        if (active) previousActive = active;
      } else if (role === "toolResult" && typeof message.toolCallId === "string") {
        results.set(message.toolCallId, {
          entryId: typeof record.id === "string" ? record.id : "",
          at: finiteNumber(message.timestamp) ?? isoTime(record.timestamp),
          isError: message.isError === true,
          synthetic: isRecord(message.details) && message.details.__synthetic === true,
          text: contentText(message.content),
        });
      } else if (role === "user") {
        pending.push(newEvent(record, "user", "user", contentText(message.content)));
      } else if (role === "developer") {
        const text = contentText(message.content);
        const tag = /^\[([^\]\s]{1,48})\]/.exec(text)?.[1];
        pending.push(newEvent(record, "developer", tag ?? "developer", text));
      } else if (role === "custom") {
        const customType = typeof message.customType === "string" ? message.customType : "custom";
        pending.push(newEvent(record, "injection", customType, contentText(message.content), {
          hiddenFromChat: message.display === false,
          sentToModel: !NOT_SENT_CUSTOM_TYPES[customType],
        }));
      }
    } else if (type === "custom_message") {
      const customType = typeof record.customType === "string" ? record.customType : "custom";
      pending.push(newEvent(record, "injection", customType, contentText(record.content), {
        hiddenFromChat: record.display === false,
        sentToModel: !NOT_SENT_CUSTOM_TYPES[customType],
      }));
    } else if (type === "custom") {
      const data = record.data;
      if (record.customType === "tool_execution_start" && isRecord(data) && typeof data.toolCallId === "string") {
        const startedAt = isoTime(data.startedAt) ?? isoTime(record.timestamp);
        if (startedAt !== null) starts.set(data.toolCallId, startedAt);
      } else if (record.customType === "system-prompt-digest" && typeof data === "string") {
        digests.push({ entryId: typeof record.id === "string" ? record.id : "", at: isoTime(record.timestamp) ?? 0, digest: data });
        pending.push(newEvent(record, "prompt", "system-prompt-digest", data));
      } else if (record.customType === "memory_recall" && isRecord(data)) {
        memoryRecall = record;
        pending.push(newEvent(record, "memory", "memory_recall", typeof data.text === "string" ? data.text : ""));
      } else if (record.customType === "mnemopi-recall" && isRecord(data) && Array.isArray(data.ids)) {
        pending.push(newEvent(record, "memory", "mnemopi-recall", "", { memoryIds: data.ids.length }));
      }
    } else if (type === "compaction") {
      pending.push(newEvent(record, "compaction", "compaction", typeof record.summary === "string" ? record.summary : "", {
        tokensBefore: finiteNumber(record.tokensBefore),
        tokensAfter: finiteNumber(record.tokensAfter),
      }));
    } else if (type === "branch_summary") {
      pending.push(newEvent(record, "injection", "branch_summary", typeof record.summary === "string" ? record.summary : ""));
    } else if (type === "model_change") {
      pending.push(newEvent(record, "model", "model_change", typeof record.model === "string" ? record.model : ""));
    } else if (type === "thinking_level_change") {
      pending.push(newEvent(record, "effort", "thinking_level_change", typeof record.thinkingLevel === "string" ? record.thinkingLevel : ""));
    } else if (type === "ttsr_injection" && Array.isArray(record.injectedRules)) {
      pending.push(newEvent(record, "rules", "ttsr_injection", record.injectedRules.filter((rule) => typeof rule === "string").join(", ")));
    }
  }

  let toolFailures = 0;
  for (const [id, { call, command }] of callsById) {
    const start = starts.get(id);
    if (start !== undefined) call.startedAt = start;
    const result = results.get(id);
    if (!result) continue;
    call.resultEntryId = result.entryId;
    call.resultChars = result.text.length;
    if (start !== undefined && result.at !== null && result.at >= start) call.durationMs = result.at - start;
    let status: RunTurnToolStatus = "ok";
    if (result.isError) {
      status = result.synthetic ? "cancelled" : classifyToolError(call.name, command, result.text);
    }
    call.status = status;
    if (status === "failed") toolFailures += 1;
  }

  const bySource: Record<string, number> = {};
  let injections = 0;
  let toolCallCount = 0;
  const countEvents = (events: readonly RunTurnEvent[]) => {
    for (const event of events) {
      if (event.kind !== "injection" && event.kind !== "developer") continue;
      injections += 1;
      bySource[event.source] = (bySource[event.source] ?? 0) + 1;
    }
  };
  for (const turn of turns) {
    countEvents(turn.before);
    toolCallCount += turn.toolCalls.length;
  }
  countEvents(pending);

  return {
    turns,
    trailing: pending,
    counts: { turns: turns.length, injections, bySource, toolCalls: toolCallCount, toolFailures },
    digests,
    lastActiveTools: previousActive,
    memoryRecall,
  };
}

/** 한 쪽을 자른다. `injectedOnly`면 주입·개발자 메시지가 앞에 있는 요청만 남긴다. */
export function pageRunTurns(
  built: BuiltRunTurns,
  meta: { runId: string; role: string; roles: string[] },
  offset: number,
  limit: number,
  injectedOnly: boolean,
): RunTurnsPage {
  const filtered = injectedOnly
    ? built.turns.filter((turn) => turn.before.some((event) => event.kind === "injection" || event.kind === "developer"))
    : built.turns;
  const start = Math.max(0, Math.floor(offset));
  const size = Math.min(Math.max(Math.floor(limit), 1), RUN_TURN_PAGE_MAX);
  const turns = filtered.slice(start, start + size);
  return maskDeep<RunTurnsPage>({
    ...meta,
    injectedOnly,
    total: filtered.length,
    offset: start,
    turns,
    trailing: start + size >= filtered.length ? built.trailing : [],
    counts: built.counts,
  });
}

// ---------------------------------------------------------------------------
// transcript 읽기 (창 단위 캐시)
// ---------------------------------------------------------------------------

/** 부모는 run 시작 항목 id로, 자식은 부모 run 창의 시각으로 자른다. */
export type TranscriptWindow =
  | { kind: "entries"; startEntryId: string; boundaryIds: ReadonlySet<string> }
  | { kind: "time"; start: number; end: number | null };

interface RunWindowData {
  built: BuiltRunTurns;
  /** 창 안 항목 id → 기록. 전체 글 조회는 이 창 안에서만 한다. */
  byId: Map<string, StoredRecord>;
  /** 창 시작 전 마지막 지문·기억 회상(시스템 프롬프트는 run 사이에 이어진다). */
  priorDigest: RunPreludeDigest | null;
  priorMemory: StoredRecord | null;
}

function parseLine(line: string): StoredRecord | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? (parsed as StoredRecord) : null;
  } catch {
    return null;
  }
}

/**
 * 메시지 줄의 id. 코어는 `{"type":"message","id":"…"`로 쓰므로 접두사로 먼저 본다. 키 순서가
 * 다른 줄도 경계를 놓치지 않도록, 접두사가 없지만 메시지일 수 있는 줄은 파싱해서 확인한다.
 */
function messageLineId(line: string): string | null {
  if (line.startsWith(MESSAGE_ID_PREFIX)) {
    const end = line.indexOf('"', MESSAGE_ID_PREFIX.length);
    return end > MESSAGE_ID_PREFIX.length ? line.slice(MESSAGE_ID_PREFIX.length, end) : null;
  }
  if (!MESSAGE_TYPE_RE.test(line)) return null;
  const record = parseLine(line);
  return record?.type === "message" && typeof record.id === "string" ? record.id : null;
}

/** 창 앞의 지문·기억 회상 줄 후보. 접두사가 빠른 길이고, 키 순서가 다른 줄은 customType으로 찾는다. */
function isPreludeLine(line: string): boolean {
  return line.startsWith(DIGEST_LINE) || line.startsWith(MEMORY_LINE) || PRELUDE_TYPE_RE.test(line);
}

/**
 * 파일에서 창 안 기록만 파싱한다. 부모 창 밖의 줄은 지문·기억 회상 줄만 접두사로 골라
 * 파싱하므로, 긴 세션에서도 다른 run의 도구 결과를 읽지 않는다.
 */
export function readRunWindow(raw: string, window: TranscriptWindow): RunWindowData {
  const inside: StoredRecord[] = [];
  let priorDigest: RunPreludeDigest | null = null;
  let priorMemory: StoredRecord | null = null;
  let phase: "before" | "inside" | "after" = "before";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    if (window.kind === "entries") {
      const id = messageLineId(line);
      if (phase === "before" && id === window.startEntryId) phase = "inside";
      else if (phase === "inside" && id !== null && window.boundaryIds.has(id)) phase = "after";
      if (phase === "after") break;
      if (phase === "before") {
        if (isPreludeLine(line)) {
          const record = parseLine(line);
          if (record?.type !== "custom") continue;
          if (record.customType === "memory_recall") priorMemory = record;
          else if (record.customType === "system-prompt-digest" && typeof record.data === "string") {
            priorDigest = { entryId: String(record.id ?? ""), at: isoTime(record.timestamp) ?? 0, digest: record.data };
          }
        }
        continue;
      }
      const record = parseLine(line);
      if (record) inside.push(record);
      continue;
    }
    const record = parseLine(line);
    if (!record) continue;
    const at = isoTime(record.timestamp);
    if (at === null) continue;
    if (window.end !== null && at >= window.end) break;
    if (at >= window.start) {
      inside.push(record);
    } else if (record.type === "custom" && record.customType === "memory_recall") {
      priorMemory = record;
    } else if (record.type === "custom" && record.customType === "system-prompt-digest" && typeof record.data === "string") {
      priorDigest = { entryId: String(record.id ?? ""), at, digest: record.data };
    }
  }
  const byId = new Map<string, StoredRecord>();
  for (const record of inside) {
    if (typeof record.id === "string") byId.set(record.id, record);
  }
  return { built: buildRunTurns(inside), byId, priorDigest, priorMemory };
}

/**
 * 역할 id를 transcript 파일과 창으로 바꾼다. `main`은 부모 transcript를 run 시작 항목 id로,
 * 자식은 그 run에 요청을 남긴 자식 transcript를 run 창 시각으로 자른다. 모르는 역할은 404다.
 */
export function resolveRunRoleTranscript(
  location: RunTranscriptLocation,
  role: string,
): { file: string; window: TranscriptWindow; roles: string[] } {
  const roles = ["main", ...location.childFiles.keys()];
  if (role === "main") {
    return {
      file: location.parentFile,
      window: { kind: "entries", startEntryId: location.detail.entryId, boundaryIds: location.runEntryIds },
      roles,
    };
  }
  const file = location.childFiles.get(role);
  if (!file) throw new RunXrayError("이 run에 그 역할의 기록이 없습니다.", 404);
  return { file, window: { kind: "time", start: location.windowStart, end: location.windowEnd }, roles };
}

/**
 * 창 캐시 상한. 항목 무게는 원본 파일 크기로 어림하고 합이 64 MB를 넘으면 오래된 것부터 버린다.
 * 가장 최근 항목 하나는 상한보다 커도 남긴다.
 */
const WINDOW_CACHE_MAX_ENTRIES = 4;
const WINDOW_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 키는 파일+창이다. 같은 창의 옛 버전(파일 크기·수정 시각)은 새 버전이 덮어쓴다. */
const windowCache = new Map<string, { version: string; bytes: number; data: RunWindowData }>();

function windowCacheKey(file: string, window: TranscriptWindow): string {
  // 경계 집합은 stats에서 오므로 파일이 그대로여도 새 run 경계가 생기면 창이 줄어든다.
  return window.kind === "entries"
    ? `${file}\0e:${window.startEntryId}:${[...window.boundaryIds].sort().join(",")}`
    : `${file}\0t:${window.start}:${window.end ?? ""}`;
}

/** 파일이 바뀌면(크기·수정 시각) 다시 읽는다. 진행 중인 run은 쪽을 넘길 때마다 새로 만든다. */
export function loadRunWindow(file: string, window: TranscriptWindow): RunWindowData {
  const stat = statSync(file);
  const key = windowCacheKey(file, window);
  const version = `${stat.mtimeMs}:${stat.size}`;
  const hit = windowCache.get(key);
  windowCache.delete(key);
  if (hit?.version === version) {
    windowCache.set(key, hit);
    return hit.data;
  }
  const data = readRunWindow(readFileSync(file, "utf8"), window);
  // 상한보다 큰 파일의 창은 캐시하지 않는다. 남은 항목은 개수와 바이트 상한을 함께 지킨다.
  if (stat.size > WINDOW_CACHE_MAX_BYTES) return data;
  windowCache.set(key, { version, bytes: stat.size, data });
  let total = 0;
  for (const entry of windowCache.values()) total += entry.bytes;
  for (const [oldestKey, oldest] of windowCache) {
    if (windowCache.size <= WINDOW_CACHE_MAX_ENTRIES && total <= WINDOW_CACHE_MAX_BYTES) break;
    windowCache.delete(oldestKey);
    total -= oldest.bytes;
  }
  return data;
}

function capped(text: string, limit: number): { text: string; chars: number; truncated: boolean } {
  const masked = maskSecrets(text).text;
  return { text: masked.slice(0, limit), chars: text.length, truncated: masked.length > limit };
}

/**
 * 창 안 항목 하나의 전체 글. `toolCallId`가 있으면 그 assistant 항목의 도구 인자다.
 * 창 밖 항목이나 글이 없는 종류는 `null`이다.
 */
export function runEntryText(data: RunWindowData, entryId: string, toolCallId: string | null): RunTurnEntryText | null {
  // 기억 회상 블록은 세션 첫 요청에 한 번 기록되고 이후 run의 시스템 프롬프트에도 그대로 실린다.
  const record = data.byId.get(entryId) ?? (data.priorMemory?.id === entryId ? data.priorMemory : undefined);
  if (!record) return null;
  let text: string | null = null;
  const message = isRecord(record.message) ? record.message : null;
  if (toolCallId !== null) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) return null;
    const block = message.content.find(
      (item): item is Record<string, unknown> => isRecord(item) && item.type === "toolCall" && item.id === toolCallId,
    );
    if (!block) return null;
    text = JSON.stringify(block.arguments ?? {}, null, 2);
  } else if (message) {
    text = contentText(message.content);
  } else if (record.type === "custom_message") {
    text = contentText(record.content);
  } else if (record.type === "compaction" || record.type === "branch_summary") {
    text = typeof record.summary === "string" ? record.summary : "";
  } else if (record.type === "custom" && record.customType === "memory_recall" && isRecord(record.data)) {
    text = typeof record.data.text === "string" ? record.data.text : "";
  }
  if (text === null) return null;
  return maskDeep<RunTurnEntryText>({ entryId, ...capped(text, RUN_TURN_ENTRY_MAX_CHARS) });
}

// ---------------------------------------------------------------------------
// 시스템 프롬프트·도구 (기록된 것 + 지금 다시 만든 것)
// ---------------------------------------------------------------------------

/** 지금 열려 있는 세션에서 꺼낸 프롬프트 재료. 라우트가 세션 레지스트리에서 채운다. */
export interface LivePromptSource {
  systemPrompt: readonly string[];
  tools: readonly SessionDumpToolInfo[];
  model: { provider: string; id: string } | null;
  thinkingLevel: string | null;
  inlineToolDescriptors: boolean;
}

/**
 * omp 코어 `systemPromptDigest`(`session/session-tools.ts`)와 같은 계산: 블록 수를 seed로
 * 블록마다 wyhash를 잇는다. Bun 밖에서는 `null`이다.
 */
export function systemPromptDigest(blocks: readonly string[]): string | null {
  if (typeof Bun === "undefined") return null;
  let hash = BigInt(blocks.length);
  for (const block of blocks) hash = BigInt(Bun.hash.wyhash(block, hash));
  return hash.toString(16);
}

export function buildRunPrelude(
  data: RunWindowData,
  meta: { runId: string; role: string },
  live: LivePromptSource | null,
  /** `false`면 다시 그리지 않고 가능 여부만 알린다. 본문이 수백 KB라 요청할 때만 그린다. */
  render: boolean,
): RunPrelude {
  const digests = [...(data.priorDigest ? [data.priorDigest] : []), ...data.built.digests];
  const memoryRecord = data.built.memoryRecall ?? data.priorMemory;
  const memoryText = memoryRecord && isRecord(memoryRecord.data) && typeof memoryRecord.data.text === "string"
    ? memoryRecord.data.text
    : null;
  const recorded: RunPrelude["recorded"] = {
    digests,
    activeTools: data.built.lastActiveTools,
    memoryRecall: memoryRecord && memoryText !== null
      ? { entryId: String(memoryRecord.id ?? ""), preview: maskedPreview(memoryText, RUN_TURN_PREVIEW_CHARS), chars: memoryText.length }
      : null,
  };
  if (!live) return maskDeep<RunPrelude>({ ...meta, recorded, rebuilt: { status: "not-loaded" } });
  if (!render) return maskDeep<RunPrelude>({ ...meta, recorded, rebuilt: { status: "available" } });
  // `/dump`과 같은 렌더러로 머리말(시스템 프롬프트·설정·도구 목록)만 그린다. 대화 기록은 위 요청 목록이 맡는다.
  const rendered = formatSessionDumpText({
    messages: [],
    systemPrompt: live.systemPrompt,
    model: live.model as Model | null,
    thinkingLevel: live.thinkingLevel,
    tools: live.tools,
    inlineToolDescriptors: live.inlineToolDescriptors,
  });
  const digest = systemPromptDigest(live.systemPrompt);
  const lastRecorded = digests.at(-1)?.digest ?? null;
  return maskDeep<RunPrelude>({
    ...meta,
    recorded,
    rebuilt: {
      status: "rebuilt",
      ...capped(rendered, RUN_PRELUDE_MAX_CHARS),
      model: live.model ? `${live.model.provider}/${live.model.id}` : null,
      thinkingLevel: live.thinkingLevel,
      digest,
      matchesRecorded: digest !== null && lastRecorded !== null ? digest === lastRecorded : null,
    },
  });
}
