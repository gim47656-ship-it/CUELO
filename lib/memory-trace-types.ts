/**
 * 기억 추적 응답의 모양과 그래프 노드 id. 서버 모듈을 끌어오지 않아 화면 쪽도 그대로 가져다 쓴다.
 */
export type MemoryTraceStepKind = "recall" | "jev" | "docmap" | "edit-lesson" | "explicit-recall" | "doc-read" | "saved";

export interface MemoryTraceMemoryRef {
  id: string;
  /** 기억 글 앞부분. 이 세션 기록 어디에도 글이 없으면 빈 문자열이다. */
  preview: string;
  date?: string;
}

interface StepBase {
  /** 이 단계를 낳은 기록 항목 id. 도구 호출이면 그 assistant 항목이다. */
  entryId: string;
  at: number;
}

export interface MemoryTraceRecallStep extends StepBase {
  kind: "recall";
  memories: MemoryTraceMemoryRef[];
}

export interface MemoryTraceJevBucket {
  /** 기록에 적힌 판정 이름 그대로(괄호 설명 포함). */
  label: string;
  /** 괄호 설명을 뺀 짧은 이름. */
  shortLabel: string;
  ids: string[];
}

export interface MemoryTraceJevStep extends StepBase {
  kind: "jev";
  buckets: MemoryTraceJevBucket[];
  unknownCount: number | null;
  unrelatedCount: number | null;
}

export interface MemoryTraceDocCandidate {
  path: string;
  status: string | null;
  map: string | null;
  scope: string | null;
  section: string | null;
  /** 같은 요청 안에서 이 경로를 read로 열었는지. */
  opened: boolean;
}

export interface MemoryTraceDocmapStep extends StepBase {
  kind: "docmap";
  candidates: MemoryTraceDocCandidate[];
}

export interface MemoryTraceEditLessonStep extends StepBase {
  kind: "edit-lesson";
  file: string;
  memories: MemoryTraceMemoryRef[];
}

export interface MemoryTraceExplicitRecallStep extends StepBase {
  kind: "explicit-recall";
  /** `xd://recall`, `xd://reflect`, `memory://<id>`, 또는 도구 이름(recall·reflect). */
  target: string;
  query: string | null;
  memories: MemoryTraceMemoryRef[];
}

export interface MemoryTraceDocReadStep extends StepBase {
  kind: "doc-read";
  path: string;
  selector: string | null;
  /** 같은 요청의 지도 후보에 있던 경로인지. */
  candidate: boolean;
}

export interface MemoryTraceSavedStep extends StepBase {
  kind: "saved";
  source: "autolearn" | "learn" | "retain";
  text: string;
}

export type MemoryTraceStep =
  | MemoryTraceRecallStep
  | MemoryTraceJevStep
  | MemoryTraceDocmapStep
  | MemoryTraceEditLessonStep
  | MemoryTraceExplicitRecallStep
  | MemoryTraceDocReadStep
  | MemoryTraceSavedStep;

export interface MemoryTraceRequest {
  entryId: string;
  at: number;
  preview: string;
  steps: MemoryTraceStep[];
}

export type MemoryTraceNodeKind = "memory" | "doc" | "file" | "request";
export type MemoryTraceEdgeKind = "recalled" | "explicit" | "lesson" | "edited" | "candidate" | "opened" | "saved";

export interface MemoryTraceNode {
  id: string;
  kind: MemoryTraceNodeKind;
  label: string;
  /** 마우스를 올렸을 때 보일 전체 글(경로·기억 앞부분). */
  title: string;
}

export interface MemoryTraceEdge {
  from: string;
  to: string;
  kind: MemoryTraceEdgeKind;
}

export interface MemoryTrace {
  sessionId: string;
  requests: MemoryTraceRequest[];
  nodes: MemoryTraceNode[];
  edges: MemoryTraceEdge[];
}

/** 그래프 노드 id. 서버가 만들고 화면이 흐름 칸과 노드를 잇는 데 같은 규칙을 쓴다. */
export function requestNodeId(entryId: string): string {
  return `request:${entryId}`;
}
export function memoryNodeId(id: string): string {
  return `memory:${id}`;
}
export function docNodeId(path: string): string {
  return `doc:${path}`;
}
export function fileNodeId(path: string): string {
  return `file:${path}`;
}
export function savedNodeId(entryId: string, index: number): string {
  return `saved:${entryId}:${index}`;
}
