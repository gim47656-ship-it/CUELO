/**
 * 기억 추적 — 세션 JSONL 하나에서 요청마다 기억을 어떻게 찾았고 어느 지도 문서로 갔는지를 다시 맞춘
 * 읽기 전용 보기. 기억 DB는 열지 않고 세션 기록에 남은 것만 읽는다.
 *
 * 요청 경계는 실제 사용자 메시지(role user, synthetic 아님, attribution agent 아님)다. 코어는
 * `memory_recall`·`mnemopi-recall`을 그 요청의 사용자 메시지보다 먼저 쓰므로, 회상 항목은 모아 두었다가
 * 다음 사용자 메시지에 붙인다. 그 사이에 assistant·toolResult 메시지가 오면 진행 중인 요청의 회상이다.
 */

import { isRecord } from "@oh-my-pi/pi-utils";
import { maskDeep } from "./run-xray-turns";
import { maskSecrets } from "./session-recall";
import type {
  MemoryTrace,
  MemoryTraceDocCandidate,
  MemoryTraceDocReadStep,
  MemoryTraceEdge,
  MemoryTraceEdgeKind,
  MemoryTraceExplicitRecallStep,
  MemoryTraceJevBucket,
  MemoryTraceJevStep,
  MemoryTraceMemoryRef,
  MemoryTraceNode,
  MemoryTraceNodeKind,
  MemoryTraceRecallStep,
  MemoryTraceRequest,
  MemoryTraceSavedStep,
  MemoryTraceStep,
} from "./memory-trace-types";
import { docNodeId, fileNodeId, memoryNodeId, requestNodeId, savedNodeId } from "./memory-trace-types";

const MEMORY_PREVIEW_CHARS = 200;
const REQUEST_PREVIEW_CHARS = 160;
const SAVED_PREVIEW_CHARS = 200;
const QUERY_PREVIEW_CHARS = 160;
const DOCMAP_FIELD_CHARS = 240;
const MEMORY_ID_RE = /^[0-9a-f]{16}$/;

const CUSTOM_PREFIX = '{"type":"custom"';
const MESSAGE_PREFIX = '{"type":"message"';
const SESSION_PREFIX = '{"type":"session"';
/** 이 보기가 읽는 custom·custom_message 종류. 나머지 custom 줄은 파싱하지 않는다. */
const WANTED_CUSTOM_RE = /"customType"\s*:\s*"(memory_recall|mnemopi-recall|jev-runtime-advisory|docmap-route|autolearn-saved)"/;
const ROLE_RE = /"role"\s*:\s*"(\w+)"/;
const TOOL_CALL_ID_RE = /"toolCallId"\s*:\s*"([^"]+)"/;
const TRACED_TOOL_RE = /"name"\s*:\s*"(?:read|write|recall|reflect|learn|retain)"/;

interface Line {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  customType?: unknown;
  content?: unknown;
  data?: unknown;
  cwd?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    synthetic?: unknown;
    attribution?: unknown;
    toolCallId?: unknown;
    isError?: unknown;
  };
}

function parse(line: string): Line | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? (value as Line) : null;
  } catch {
    return null;
  }
}

function time(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** 자르기 전에 가린다. 먼저 자르면 잘린 토큰 조각이 패턴에 걸리지 않고 그대로 나간다. */
function clip(text: string, limit: number): string {
  const flat = maskSecrets(text).text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/** `read` 경로 끝의 줄 선택자(`:1-75`, `:15:raw`, `:8,56`)를 떼어 낸다. URL 스킴의 콜론은 건드리지 않는다. */
export function splitReadSelector(raw: string): { path: string; selector: string | null } {
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(raw)?.[0] ?? "";
  const rest = raw.slice(scheme.length);
  const match = /(?::(?:raw|img|conflicts|-?\d[\d,+\-]*))+$/.exec(rest);
  if (!match || match.index === 0) return { path: raw, selector: null };
  return { path: scheme + rest.slice(0, match.index), selector: match[0].slice(1) };
}

/** 문서 지도가 가리키는 문서인지: 인수인계·지도·작업 기록·README·AGENTS와 rule/skill 문서. */
export function isDocMapPath(path: string): boolean {
  if (path.startsWith("rule://") || path.startsWith("skill://")) return true;
  if (/(?:^|\/)doc\/history\//.test(path)) return true;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base === "HANDOFF.md" || base === "README.md" || base === "AGENTS.md";
}

function relativeTo(cwd: string | null, path: string): string {
  if (!cwd || !path.startsWith("/")) return path.replace(/^\.\//, "");
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
}

/** JEV 기억 대조 안내. 판정 줄 이름은 고정하지 않고 `- 이름: id, id` 꼴을 모두 읽는다. */
export function parseJevAdvisory(text: string): Omit<MemoryTraceJevStep, "kind" | "entryId" | "at"> | null {
  if (!text.startsWith("[JevRuntime:memory-application]")) return null;
  const buckets: MemoryTraceJevBucket[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("- ")) continue;
    const match = /^- (.+?):\s*([0-9a-f]{16}(?:\s*,\s*[0-9a-f]{16})*)\s*$/.exec(line);
    if (!match) continue;
    const label = match[1].trim();
    buckets.push({
      label,
      shortLabel: label.replace(/\s*\([^()]*\)\s*$/, "").trim() || label,
      ids: match[2].split(",").map((id) => id.trim()),
    });
  }
  const unknown = /판정 불명\s*(\d+)\s*개/.exec(text);
  const unrelated = /무관\s*(\d+)\s*개/.exec(text);
  return {
    buckets,
    unknownCount: unknown ? Number(unknown[1]) : null,
    unrelatedCount: unrelated ? Number(unrelated[1]) : null,
  };
}

/** `[문서 지도 후보]` 안내의 번호 매긴 후보와 그 아래 들여 쓴 지도·SCOPE·구간 줄. */
export function parseDocmapRoute(text: string): Omit<MemoryTraceDocCandidate, "opened">[] {
  if (!text.startsWith("[문서 지도 후보]")) return [];
  const candidates: Omit<MemoryTraceDocCandidate, "opened">[] = [];
  let current: Omit<MemoryTraceDocCandidate, "opened"> | null = null;
  for (const line of text.split("\n")) {
    const head = /^\d+\.\s+(\S+)(?:\s+\(STATUS:\s*([^)]*)\))?/.exec(line);
    if (head) {
      current = { path: head[1], status: head[2]?.trim() || null, map: null, scope: null, section: null };
      candidates.push(current);
      continue;
    }
    if (!current) continue;
    const field = /^\s+(지도|SCOPE|구간):\s*(.*)$/.exec(line);
    if (!field) continue;
    const value = clip(field[2], DOCMAP_FIELD_CHARS);
    if (field[1] === "지도") current.map = value;
    else if (field[1] === "SCOPE") current.scope = value;
    else current.section = value;
  }
  return candidates;
}

/** `[edit-lessons] <경로>에 묶인 기억 N건` 개발자 메시지. */
export function parseEditLessons(text: string): { file: string; memories: MemoryTraceMemoryRef[] } | null {
  const head = /^\[edit-lessons\]\s+(.+?)에 묶인 기억\s*\d+\s*건/.exec(text);
  if (!head) return null;
  const memories: MemoryTraceMemoryRef[] = [];
  for (const line of text.split("\n")) {
    const item = /^- (.*)\(id: ([0-9a-f]{16})(?:,\s*([^)]*))?\)\s*$/.exec(line);
    if (!item) continue;
    memories.push({ id: item[2], preview: clip(item[1], MEMORY_PREVIEW_CHARS), ...(item[3] ? { date: item[3].trim() } : {}) });
  }
  return { file: head[1].trim(), memories };
}

/** 회상 도구 결과의 `- 글 … (id: <16hex>)` 항목. 글이 여러 줄이어도 다음 항목 전까지를 한 기억으로 본다. */
export function parseRecallResult(text: string): MemoryTraceMemoryRef[] {
  const memories: MemoryTraceMemoryRef[] = [];
  const seen = new Set<string>();
  const re = /(?:^|\n)- ([\s\S]*?)\(id: ([0-9a-f]{16})[^)]*\)/g;
  for (let match = re.exec(text); match; match = re.exec(text)) {
    if (seen.has(match[2])) continue;
    seen.add(match[2]);
    memories.push({ id: match[2], preview: clip(match[1].replace(/^\[[^\]]*\]\s*/, ""), MEMORY_PREVIEW_CHARS) });
  }
  return memories;
}

/** 결과를 기다리는 호출. 지도 문서 읽기와 learn·retain은 결과가 성공을 알릴 때만 남긴다. */
type PendingCall =
  | { kind: "explicit"; step: MemoryTraceExplicitRecallStep }
  | { kind: "read"; step: MemoryTraceDocReadStep }
  | { kind: "learn"; step: MemoryTraceSavedStep }
  | { kind: "retain"; steps: (MemoryTraceSavedStep | null)[] };

/** learn 결과가 기억 저장을 알리는지. 코어는 저장 뒤 스킬 처리만 실패해도 이 문장으로 시작한다. */
const LEARN_STORED_RE = /^Lesson stored\b/;
/** retain 전체 성공(mnemopi). hindsight의 `queued`는 아직 저장된 것이 아니다. */
const RETAIN_STORED_RE = /^\d+ (?:memory|memories) stored\.$/;
/**
 * retain 중간 실패: 앞에서 저장해 둔 항목 번호를 결과가 직접 밝힌다. 코어 문장은
 * `Mnemopi did not store item N of M: <원인>. Stored before the failure and kept: item k (id …), … .[ Later items were not attempted.]`
 * 이고 목록은 끝에 붙는다. 원인 안에서 같은 문장을 인용해도 끝에 오지 않으면 읽지 않는다.
 */
const RETAIN_PARTIAL_RE = /^Mnemopi did not store item (\d+) of \d+: [\s\S]* Stored before the failure and kept: ((?:item \d+ \(id [^)]+\), )*item \d+ \(id [^)]+\))\.(?: Later items were not attempted\.)?$/;

/** 결과가 성공으로 확인한 저장 항목 번호(0부터). */
function retainStored(text: string, isError: boolean, count: number): number[] {
  if (!isError && RETAIN_STORED_RE.test(text)) return Array.from({ length: count }, (_, index) => index);
  const partial = RETAIN_PARTIAL_RE.exec(text);
  if (!partial) return [];
  // 저장된 항목은 실패한 항목보다 앞에만 있다.
  const failed = Number(partial[1]) - 1;
  return [...partial[2].matchAll(/item (\d+) \(id /g)].map((match) => Number(match[1]) - 1).filter((index) => index >= 0 && index < failed && index < count);
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

/** 줄을 하나씩 받아 추적을 만든다. 라우트는 파일을 줄 단위로 흘려 넣고 테스트는 배열을 넣는다. */
export class MemoryTraceBuilder {
  private readonly requests: MemoryTraceRequest[] = [];
  private pending: MemoryTraceRecallStep | null = null;
  private current: MemoryTraceRequest | null = null;
  private cwd: string | null = null;
  private readonly calls = new Map<string, PendingCall>();
  /** 결과가 아직 성공을 확인하지 않은 단계. 끝에서 요청 단계에서 뺀다(실패·취소·결과 없음). */
  private readonly unconfirmed = new Set<MemoryTraceStep>();
  /** 세션 어디서든 글이 보인 기억. `mnemopi-recall`처럼 id만 남은 회상의 앞부분을 채운다. */
  private readonly previews = new Map<string, string>();
  /** 진행 중인 요청의 지도 후보 경로. 이름 규칙 밖의 후보를 읽어도 연 문서로 남긴다. */
  private readonly candidatePaths = new Set<string>();

  constructor(private readonly sessionId: string) {}

  push(line: string): void {
    if (line.startsWith(CUSTOM_PREFIX)) {
      if (!WANTED_CUSTOM_RE.test(line)) return;
      const record = parse(line);
      if (record) this.custom(record);
      return;
    }
    if (line.startsWith(MESSAGE_PREFIX)) {
      this.message(line);
      return;
    }
    if (line.startsWith(SESSION_PREFIX) && this.cwd === null) {
      const record = parse(line);
      if (record && typeof record.cwd === "string") this.cwd = record.cwd;
      return;
    }
    // 키 순서가 다른 줄: 비싼 파싱은 관심 있는 종류일 때만.
    if (WANTED_CUSTOM_RE.test(line)) {
      const record = parse(line);
      if (record && (record.type === "custom" || record.type === "custom_message")) this.custom(record);
    } else if (/"type"\s*:\s*"message"/.test(line.slice(0, 200))) {
      this.message(line);
    }
  }

  finish(): MemoryTrace {
    // 끝에 남은 회상은 아직 오지 않은 다음 요청의 것이다(사이에 assistant·toolResult가 없었다). 앞 요청에 붙이지 않는다.
    for (const request of this.requests) {
      // 지도 문서 읽기·learn·retain은 결과가 성공을 확인한 것만 연 문서·새로 저장으로 남긴다.
      if (this.unconfirmed.size > 0) request.steps = request.steps.filter((step) => !this.unconfirmed.has(step));
      this.finishRequest(request);
    }
    const { nodes, edges } = this.graph();
    return maskDeep({ sessionId: this.sessionId, requests: this.requests, nodes, edges });
  }

  private custom(record: Line): void {
    const entryId = typeof record.id === "string" ? record.id : "";
    const at = time(record.timestamp);
    const data = isRecord(record.data) ? record.data : null;
    switch (record.customType) {
      case "memory_recall": {
        const list = data && Array.isArray(data.memories) ? data.memories : [];
        const memories: MemoryTraceMemoryRef[] = [];
        for (const item of list) {
          if (!isRecord(item) || typeof item.id !== "string") continue;
          const preview = typeof item.text === "string" ? clip(item.text, MEMORY_PREVIEW_CHARS) : "";
          memories.push({ id: item.id, preview });
        }
        this.addRecall(entryId, at, memories);
        return;
      }
      case "mnemopi-recall": {
        const ids = data && Array.isArray(data.ids) ? data.ids.filter((id): id is string => typeof id === "string") : [];
        this.addRecall(entryId, at, ids.map((id) => ({ id, preview: "" })));
        return;
      }
      case "jev-runtime-advisory": {
        const parsed = parseJevAdvisory(contentText(record.content));
        if (parsed) this.add({ kind: "jev", entryId, at, ...parsed });
        return;
      }
      case "docmap-route": {
        const candidates = parseDocmapRoute(contentText(record.content));
        if (candidates.length > 0) {
          const normalized = candidates.map((item) => ({ ...item, path: relativeTo(this.cwd, item.path), opened: false }));
          for (const item of normalized) this.candidatePaths.add(item.path);
          this.add({ kind: "docmap", entryId, at, candidates: normalized });
        }
        return;
      }
      case "autolearn-saved": {
        const text = contentText(record.content);
        const lines = text.split("\n").filter((line) => line.startsWith("- "));
        for (const line of lines.length > 0 ? lines : [text]) {
          this.add({ kind: "saved", entryId, at, source: "autolearn", text: clip(line.replace(/^- (?:교훈:\s*)?/, ""), SAVED_PREVIEW_CHARS) });
        }
        return;
      }
    }
  }

  private message(line: string): void {
    // 코어는 role·toolCallId를 content 앞에 쓴다. 앞부분에서 못 찾은 줄(키 순서가 다른 줄)만 통째로 파싱한다.
    const head = line.slice(0, 600);
    let record: Line | null | undefined;
    let role = ROLE_RE.exec(head)?.[1];
    if (!role) {
      record = parse(line);
      role = typeof record?.message?.role === "string" ? record.message.role : undefined;
    }
    if (role === "toolResult") {
      this.flushPending();
      if (this.calls.size === 0) return;
      let callId = TOOL_CALL_ID_RE.exec(head)?.[1];
      if (!callId) {
        record ??= parse(line);
        callId = typeof record?.message?.toolCallId === "string" ? record.message.toolCallId : undefined;
      }
      const call = callId ? this.calls.get(callId) : undefined;
      if (!call || !callId) return;
      this.calls.delete(callId);
      record ??= parse(line);
      const message = record?.message;
      // 읽을 수 없는 결과 줄은 성공을 확인하지 못한 것이다.
      if (!message) return;
      const isError = message.isError === true;
      const text = contentText(message.content);
      if (call.kind === "read") {
        if (!isError) this.unconfirmed.delete(call.step);
      } else if (call.kind === "learn") {
        if (LEARN_STORED_RE.test(text.trimStart())) this.unconfirmed.delete(call.step);
      } else if (call.kind === "retain") {
        for (const index of retainStored(text.trim(), isError, call.steps.length)) {
          const step = call.steps[index];
          if (step) this.unconfirmed.delete(step);
        }
      } else {
        const memories = parseRecallResult(text);
        for (const memory of memories) this.remember(memory);
        if (call.step.memories.length === 0) call.step.memories = memories;
      }
      return;
    }
    if (role === "assistant") {
      this.flushPending();
      if (!line.includes('"toolCall"') || !TRACED_TOOL_RE.test(line)) return;
      record ??= parse(line);
      if (record) this.assistant(record);
      return;
    }
    if (role !== "user" && role !== "developer") return;
    record ??= parse(line);
    const message = record?.message;
    if (!record || !message) return;
    const entryId = typeof record.id === "string" ? record.id : "";
    const at = time(record.timestamp);
    if (role === "user" && message.synthetic !== true && message.attribution !== "agent") {
      const request: MemoryTraceRequest = { entryId, at, preview: clip(contentText(message.content), REQUEST_PREVIEW_CHARS), steps: [] };
      this.requests.push(request);
      this.current = request;
      this.candidatePaths.clear();
      if (this.pending) {
        request.steps.push(this.pending);
        this.pending = null;
      }
      return;
    }
    const lessons = parseEditLessons(contentText(message.content));
    if (lessons) {
      for (const memory of lessons.memories) this.remember(memory);
      this.add({ kind: "edit-lesson", entryId, at, file: relativeTo(this.cwd, lessons.file), memories: lessons.memories });
    }
  }

  private assistant(record: Line): void {
    const content = record.message?.content;
    if (!Array.isArray(content)) return;
    const entryId = typeof record.id === "string" ? record.id : "";
    const at = time(record.timestamp);
    for (const block of content) {
      if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
      const args = isRecord(block.arguments) ? block.arguments : {};
      const callId = typeof block.id === "string" ? block.id : null;
      const name = block.name;
      const rawPath = typeof args.path === "string" ? args.path : null;
      if ((name === "write" || name === "read") && (rawPath === "xd://recall" || rawPath === "xd://reflect")) {
        this.explicit(entryId, at, callId, rawPath, queryOf(args.content));
      } else if (name === "recall" || name === "reflect") {
        this.explicit(entryId, at, callId, name, firstString(args, ["query", "question", "q"]));
      } else if (name === "read" && rawPath?.startsWith("memory://")) {
        const id = rawPath.slice("memory://".length).replace(/[/?#].*$/, "");
        const memories = MEMORY_ID_RE.test(id) ? [{ id, preview: "" }] : [];
        this.add({ kind: "explicit-recall", entryId, at, target: rawPath, query: null, memories });
      } else if (name === "read" && rawPath) {
        const { path, selector } = splitReadSelector(rawPath);
        const relative = relativeTo(this.cwd, path);
        // 지도 후보로 받은 경로는 이름 규칙에 없어도 연 문서로 센다.
        if (isDocMapPath(relative) || this.candidatePaths.has(relative)) {
          const step: MemoryTraceDocReadStep = { kind: "doc-read", entryId, at, path: relative, selector, candidate: false };
          this.pend(callId, [step], { kind: "read", step });
        }
      } else if (name === "learn") {
        const text = firstString(args, ["memory", "content", "text", "fact"]);
        if (!text) continue;
        const step: MemoryTraceSavedStep = { kind: "saved", entryId, at, source: name, text: clip(text, SAVED_PREVIEW_CHARS) };
        this.pend(callId, [step], { kind: "learn", step });
      } else if (name === "retain") {
        // 코어 retain은 `items[].content`를 받는다. 항목 번호가 결과의 부분 저장 번호와 맞아야 하므로 빈 항목도 자리를 지킨다.
        const items = Array.isArray(args.items) ? args.items : null;
        const texts = items
          ? items.map((item) => (isRecord(item) && typeof item.content === "string" && item.content.trim() ? item.content : null))
          : [firstString(args, ["memory", "content", "text", "fact"])];
        const steps = texts.map((text): MemoryTraceSavedStep | null => (text ? { kind: "saved", entryId, at, source: name, text: clip(text, SAVED_PREVIEW_CHARS) } : null));
        const present = steps.filter((step): step is MemoryTraceSavedStep => step !== null);
        if (present.length > 0) this.pend(callId, present, { kind: "retain", steps });
      }
    }
  }

  /** 결과로 성공이 확인돼야 남는 단계. 순서를 지키려고 지금 넣고, 확인되지 않으면 끝에서 뺀다. */
  private pend(callId: string | null, steps: MemoryTraceStep[], call: PendingCall): void {
    if (!this.current) return;
    for (const step of steps) {
      this.current.steps.push(step);
      this.unconfirmed.add(step);
    }
    if (callId) this.calls.set(callId, call);
  }

  private explicit(entryId: string, at: number, callId: string | null, target: string, query: string | null): void {
    const step: MemoryTraceExplicitRecallStep = { kind: "explicit-recall", entryId, at, target, query: query ? clip(query, QUERY_PREVIEW_CHARS) : null, memories: [] };
    const request = this.add(step);
    if (request && callId) this.calls.set(callId, { kind: "explicit", step });
  }

  private addRecall(entryId: string, at: number, memories: MemoryTraceMemoryRef[]): void {
    for (const memory of memories) this.remember(memory);
    // 같은 회상이 `memory_recall`(글)과 `mnemopi-recall`(id)로 두 번 남는다. 요청 하나의 회상은 한 단계로 합친다.
    const target = this.pending ?? null;
    if (target) {
      mergeMemories(target.memories, memories);
      return;
    }
    this.pending = { kind: "recall", entryId, at, memories: [...memories] };
  }

  /** 모아 둔 회상을 진행 중인 요청에 붙인다. 요청이 아직 없으면 다음 사용자 메시지를 기다린다. */
  private flushPending(): void {
    if (!this.pending || !this.current) return;
    const existing = this.current.steps.find((step): step is MemoryTraceRecallStep => step.kind === "recall");
    if (existing) mergeMemories(existing.memories, this.pending.memories);
    else this.current.steps.push(this.pending);
    this.pending = null;
  }

  private add(step: MemoryTraceStep): MemoryTraceRequest | null {
    if (!this.current) return null;
    this.current.steps.push(step);
    return this.current;
  }

  private remember(memory: MemoryTraceMemoryRef): void {
    if (memory.preview && !this.previews.has(memory.id)) this.previews.set(memory.id, memory.preview);
  }

  private finishRequest(request: MemoryTraceRequest): void {
    const opened = new Set<string>();
    const candidates = new Set<string>();
    for (const step of request.steps) {
      if (step.kind === "doc-read") opened.add(step.path);
      if (step.kind === "docmap") for (const candidate of step.candidates) candidates.add(candidate.path);
      if ("memories" in step) {
        for (const memory of step.memories) if (!memory.preview) memory.preview = this.previews.get(memory.id) ?? "";
      }
    }
    for (const step of request.steps) {
      if (step.kind === "docmap") for (const candidate of step.candidates) candidate.opened = opened.has(candidate.path);
      if (step.kind === "doc-read") step.candidate = candidates.has(step.path);
    }
  }

  private graph(): { nodes: MemoryTraceNode[]; edges: MemoryTraceEdge[] } {
    const nodes = new Map<string, MemoryTraceNode>();
    const edges = new Map<string, MemoryTraceEdge>();
    const node = (id: string, kind: MemoryTraceNodeKind, label: string, title: string) => {
      if (!nodes.has(id)) nodes.set(id, { id, kind, label, title });
      return id;
    };
    const edge = (from: string, to: string, kind: MemoryTraceEdgeKind) => {
      const key = `${from}\u0000${to}\u0000${kind}`;
      if (!edges.has(key)) edges.set(key, { from, to, kind });
    };
    const memoryNode = (memory: MemoryTraceMemoryRef) => {
      const preview = memory.preview || this.previews.get(memory.id) || "";
      // 그래프가 폭에 맞춰 두 줄까지 자르므로 라벨은 넉넉히 넘긴다.
      return node(memoryNodeId(memory.id), "memory", preview ? clip(preview, 160) : memory.id, preview ? `${memory.id} · ${preview}` : memory.id);
    };
    const docNode = (path: string) => node(docNodeId(path), "doc", shortPath(path), path);
    for (const request of this.requests) {
      const req = node(requestNodeId(request.entryId), "request", request.preview ? clip(request.preview, 40) : request.entryId, request.preview || request.entryId);
      request.steps.forEach((step, index) => {
        switch (step.kind) {
          case "recall":
            for (const memory of step.memories) edge(req, memoryNode(memory), "recalled");
            break;
          case "explicit-recall":
            for (const memory of step.memories) edge(req, memoryNode(memory), "explicit");
            break;
          case "edit-lesson": {
            const file = node(fileNodeId(step.file), "file", shortPath(step.file), step.file);
            edge(req, file, "edited");
            for (const memory of step.memories) edge(file, memoryNode(memory), "lesson");
            break;
          }
          case "docmap":
            for (const candidate of step.candidates) edge(req, docNode(candidate.path), candidate.opened ? "opened" : "candidate");
            break;
          case "doc-read":
            edge(req, docNode(step.path), "opened");
            break;
          case "saved":
            edge(req, node(savedNodeId(step.entryId, index), "memory", clip(step.text, 40), step.text), "saved");
            break;
          case "jev":
            break;
        }
      });
    }
    // 같은 요청·문서에 후보 줄과 열어 봄 줄이 둘 다 있으면 열어 봄만 남긴다.
    for (const [key, item] of edges) {
      if (item.kind === "candidate" && edges.has(`${item.from}\u0000${item.to}\u0000opened`)) edges.delete(key);
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }
}

function mergeMemories(into: MemoryTraceMemoryRef[], add: readonly MemoryTraceMemoryRef[]): void {
  for (const memory of add) {
    const existing = into.find((item) => item.id === memory.id);
    if (!existing) into.push({ ...memory });
    else if (!existing.preview && memory.preview) existing.preview = memory.preview;
  }
}

function queryOf(content: unknown): string | null {
  if (typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) return firstString(parsed, ["query", "question", "q"]) ?? content;
  } catch {
    // 평문 질의.
  }
  return content;
}

/** 그래프 라벨용 짧은 경로: 상위 폴더 하나와 파일 이름. HANDOFF.md·main.md처럼 흔한 이름도 구별된다. */
function shortPath(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/") || path;
}

/** 줄 배열에서 바로 만든다(테스트·작은 입력용). */
export function buildMemoryTrace(sessionId: string, lines: Iterable<string>): MemoryTrace {
  const builder = new MemoryTraceBuilder(sessionId);
  for (const line of lines) if (line) builder.push(line);
  return builder.finish();
}
