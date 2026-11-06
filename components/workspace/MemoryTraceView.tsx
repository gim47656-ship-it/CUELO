"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { ActionButton, Badge, SegmentedControl } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import {
  docNodeId,
  fileNodeId,
  memoryNodeId,
  requestNodeId,
  savedNodeId,
  type MemoryTrace,
  type MemoryTraceEdge,
  type MemoryTraceMemoryRef,
  type MemoryTraceNode,
  type MemoryTraceRequest,
} from "@/lib/memory-trace-types";
import { PanelHeader } from "./PanelHeader";
import styles from "./MemoryTraceView.module.css";

const SCOPE_KEY = "cuelo-memory-trace-scope";
/** 세션마다 고른 요청. 덱이 다시 그려져도 유지하고, 탭을 닫으면 잊는다. 기본값은 최신 요청이다. */
const SELECTED_KEY = "cuelo-memory-trace-request:";

/** requestId=…, stageHash=… 같은 긴 16진 토큰을 빼서 목록과 제목이 문장으로 읽히게 한다. 원문은 title에 남긴다. */
function readablePreview(text: string): string {
  return text
    .replace(/\b[\w.-]+=[0-9a-f]{12,}\b/gi, "")
    .replace(/\b[0-9a-f]{16,}\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** 기억 글의 마크다운 표시(백틱, **, __, 줄머리 #·-·*·번호, [글](주소))를 빼고 글만 남긴다. */
function plainText(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/(^|\n)[ \t]*(?:#{1,6}|[-*+]|\d+[.)])[ \t]+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

type NoticeKind = "harness" | "resume";
const NOTICE_PREFIX = /^\[(하네스 통지|자동 재개)\]\s*/;

/** 하네스가 사용자 메시지로 넣은 알림("[하네스 통지] …", "[자동 재개] …")은 앞 꼬리표를 떼고 종류만 돌려준다. */
function splitNotice(text: string): { notice: NoticeKind | null; text: string } {
  const match = NOTICE_PREFIX.exec(text);
  if (!match) return { notice: null, text };
  return { notice: match[1] === "자동 재개" ? "resume" : "harness", text: text.slice(match[0].length) };
}

/** 기억 노드 제목("<id> · <글>")에서 글 쪽만 마크다운을 뺀다. id는 공백 없는 첫 토큰이다. */
function plainTitle(title: string): string {
  const match = /^(\S+) · ([\s\S]*)$/.exec(title);
  return match ? `${match[1]} · ${plainText(match[2])}` : plainText(title);
}

function readSelected(sessionId: string): string | null {
  try {
    return window.sessionStorage.getItem(SELECTED_KEY + sessionId);
  } catch {
    return null;
  }
}

const REFRESH_ICON = (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5v3h-3" />
  </svg>
);

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; trace: MemoryTrace };

type Stage = "recall" | "jev" | "docmap" | "docs" | "lessons" | "saved";
const STAGES: readonly Stage[] = ["recall", "jev", "docmap", "docs", "lessons", "saved"];
const STAGE_KEY: Record<Stage, string> = {
  recall: "memoryTrace.stageRecall",
  jev: "memoryTrace.stageJev",
  docmap: "memoryTrace.stageDocmap",
  docs: "memoryTrace.stageDocs",
  lessons: "memoryTrace.stageLessons",
  saved: "memoryTrace.stageSaved",
};

type GraphScope = "request" | "session";

interface DocRead {
  path: string;
  selectors: string[];
  candidate: boolean;
}

/** 한 요청의 단계를 흐름 칸별로 묶은 것. 칸의 수와 상세가 같은 값을 쓴다. */
interface RequestFlow {
  index: number;
  request: MemoryTraceRequest;
  recalled: MemoryTraceMemoryRef[];
  explicit: { target: string; query: string | null; memories: MemoryTraceMemoryRef[] }[];
  verdicts: Map<string, { short: string; label: string }>;
  jev: { buckets: { label: string; shortLabel: string; ids: string[] }[]; unknown: number | null; unrelated: number | null }[];
  candidates: { path: string; status: string | null; map: string | null; scope: string | null; opened: boolean }[];
  docs: DocRead[];
  lessons: { file: string; memories: MemoryTraceMemoryRef[] }[];
  saved: { nodeId: string; source: "autolearn" | "learn" | "retain"; text: string }[];
  counts: Record<Stage, number>;
  happened: Record<Stage, boolean>;
}

function buildFlow(request: MemoryTraceRequest, index: number): RequestFlow {
  const flow: RequestFlow = {
    index,
    request,
    recalled: [],
    explicit: [],
    verdicts: new Map(),
    jev: [],
    candidates: [],
    docs: [],
    lessons: [],
    saved: [],
    counts: { recall: 0, jev: 0, docmap: 0, docs: 0, lessons: 0, saved: 0 },
    happened: { recall: false, jev: false, docmap: false, docs: false, lessons: false, saved: false },
  };
  const docs = new Map<string, DocRead>();
  const recallIds = new Set<string>();
  request.steps.forEach((step, stepIndex) => {
    switch (step.kind) {
      case "recall":
        for (const memory of step.memories) {
          if (recallIds.has(memory.id)) continue;
          recallIds.add(memory.id);
          flow.recalled.push(memory);
        }
        break;
      case "explicit-recall":
        flow.explicit.push({ target: step.target, query: step.query, memories: step.memories });
        for (const memory of step.memories) recallIds.add(memory.id);
        break;
      case "jev":
        flow.jev.push({ buckets: step.buckets, unknown: step.unknownCount, unrelated: step.unrelatedCount });
        for (const bucket of step.buckets) {
          for (const id of bucket.ids) flow.verdicts.set(id, { short: bucket.shortLabel, label: bucket.label });
        }
        break;
      case "docmap":
        for (const candidate of step.candidates) {
          if (!flow.candidates.some((item) => item.path === candidate.path)) flow.candidates.push(candidate);
        }
        break;
      case "doc-read": {
        const existing = docs.get(step.path);
        if (existing) {
          if (step.selector && !existing.selectors.includes(step.selector)) existing.selectors.push(step.selector);
        } else {
          docs.set(step.path, { path: step.path, selectors: step.selector ? [step.selector] : [], candidate: step.candidate });
        }
        break;
      }
      case "edit-lesson":
        flow.lessons.push({ file: step.file, memories: step.memories });
        break;
      case "saved":
        flow.saved.push({ nodeId: savedNodeId(step.entryId, stepIndex), source: step.source, text: step.text });
        break;
    }
  });
  flow.docs = [...docs.values()];
  flow.counts = {
    recall: recallIds.size,
    jev: flow.jev.reduce((sum, item) => sum + item.buckets.reduce((inner, bucket) => inner + bucket.ids.length, 0), 0),
    docmap: flow.candidates.length,
    docs: flow.docs.length,
    lessons: flow.lessons.reduce((sum, item) => sum + item.memories.length, 0),
    saved: flow.saved.length,
  };
  // 칸이 찼는지는 수가 아니라 그 단계가 있었는지로 본다. 결과 없는 회상·전부 무관인 JEV 대조도 보여야 한다.
  flow.happened = {
    recall: flow.recalled.length > 0 || flow.explicit.length > 0,
    jev: flow.jev.length > 0,
    docmap: flow.candidates.length > 0,
    docs: flow.docs.length > 0,
    lessons: flow.lessons.length > 0,
    saved: flow.saved.length > 0,
  };
  return flow;
}

/** 노드가 흐름의 어느 칸에 있는지. 그래프에서 고르면 그 칸을 펼친다. */
function stageOfNode(flow: RequestFlow, nodeId: string): Stage | null {
  const memoryIn = (memories: readonly MemoryTraceMemoryRef[]) => memories.some((memory) => memoryNodeId(memory.id) === nodeId);
  if (memoryIn(flow.recalled) || flow.explicit.some((item) => memoryIn(item.memories))) return "recall";
  // 열고 편집한 경로는 그래프에서 문서 노드 하나로 합쳐지므로 문서 id로도 교훈 칸을 찾는다.
  if (flow.lessons.some((item) => fileNodeId(item.file) === nodeId || docNodeId(item.file) === nodeId || memoryIn(item.memories))) return "lessons";
  if (flow.docs.some((doc) => docNodeId(doc.path) === nodeId)) return "docs";
  if (flow.candidates.some((item) => docNodeId(item.path) === nodeId)) return "docmap";
  if (flow.saved.some((item) => item.nodeId === nodeId)) return "saved";
  if ([...flow.verdicts.keys()].some((id) => memoryNodeId(id) === nodeId)) return "jev";
  return null;
}

function readScope(): GraphScope {
  try {
    return window.localStorage.getItem(SCOPE_KEY) === "session" ? "session" : "request";
  } catch {
    return "request";
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown };
    if (typeof body.error === "string" && body.error) return body.error;
  } catch {
    // Not JSON: fall back to the status line.
  }
  return `HTTP ${response.status}`;
}

export interface MemoryTraceViewProps {
  title: string;
  /** Only the visible view fetches; the trace loads again each time the view opens. */
  visible: boolean;
  sessionId: string | null;
}

export function MemoryTraceView({ title, visible, sessionId }: MemoryTraceViewProps) {
  const { t, locale } = useI18n();
  const [state, setState] = useState<LoadState>({ kind: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [focusNode, setFocusNode] = useState<string | null>(null);
  const [scope, setScope] = useState<GraphScope>("request");
  const loadSeq = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [listMore, setListMore] = useState(false);
  const updateListMore = useCallback(() => {
    const list = listRef.current;
    setListMore(Boolean(list && list.scrollTop + list.clientHeight < list.scrollHeight - 2));
  }, []);

  useEffect(() => {
    setScope(readScope());
  }, []);

  // 세션이 바뀌거나 보기가 다시 마운트되면 그 세션에서 마지막으로 고른 요청을 되살린다.
  useEffect(() => {
    setSelectedId(sessionId ? readSelected(sessionId) : null);
    setFocusNode(null);
  }, [sessionId]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    controllerRef.current?.abort();
    if (!sessionId) {
      setState({ kind: "idle" });
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => (current.kind === "ready" && current.trace.sessionId === sessionId ? current : { kind: "loading" }));
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/memory-trace`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(await errorText(response));
      const trace = await response.json() as MemoryTrace;
      if (seq === loadSeq.current) setState({ kind: "ready", trace });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (seq === loadSeq.current) setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [sessionId]);

  // 숨기거나 내리면 읽던 요청을 끊는다(본문 읽기도 같은 신호로 멈춘다). 다시 열면 처음부터 읽는다.
  useEffect(() => {
    if (!visible) return;
    void load();
    const controllers = controllerRef;
    return () => controllers.current?.abort();
  }, [visible, load]);

  const trace = state.kind === "ready" && state.trace.sessionId === sessionId ? state.trace : null;
  const flows = useMemo(() => (trace ? trace.requests.map((request, index) => buildFlow(request, index + 1)) : []), [trace]);
  const traced = useMemo(() => flows.filter((flow) => flow.request.steps.length > 0), [flows]);
  const newestFirst = useMemo(() => [...traced].reverse(), [traced]);
  const selected = traced.find((flow) => flow.request.entryId === selectedId) ?? newestFirst[0] ?? null;

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    updateListMore();
    const observer = new ResizeObserver(updateListMore);
    observer.observe(list);
    return () => observer.disconnect();
  }, [updateListMore, newestFirst]);

  // 요청이 바뀌면 처음 채워진 칸을 펼친다.
  useEffect(() => {
    if (!selected) return;
    setStage((current) => (current && selected.happened[current] ? current : STAGES.find((item) => selected.happened[item]) ?? "recall"));
  }, [selected]);

  useEffect(() => {
    if (!focusNode) return;
    const id = CSS.escape(focusNode);
    const target = detailRef.current?.querySelector<HTMLElement>(`[data-node="${id}"], [data-alt-node="${id}"]`);
    target?.scrollIntoView({ block: "nearest" });
  }, [focusNode, stage, selected]);

  const changeScope = (next: GraphScope) => {
    setScope(next);
    try {
      window.localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // Storage off: the choice just does not survive a reload.
    }
  };

  const chooseRequest = (entryId: string) => {
    setSelectedId(entryId);
    if (!sessionId) return;
    try {
      window.sessionStorage.setItem(SELECTED_KEY + sessionId, entryId);
    } catch {
      // Storage off: the choice lasts until the view remounts.
    }
  };

  const selectNode = (node: GraphNode) => {
    if (node.kind === "request") {
      chooseRequest(node.id.slice("request:".length));
      setFocusNode(null);
      return;
    }
    // 열고 편집한 노드는 교훈을 받은 요청을 먼저 찾는다(고른 요청은 열기만 했을 수 있다).
    const wanted = (flow: RequestFlow) => (node.edited ? stageOfNode(flow, node.id) === "lessons" : stageOfNode(flow, node.id) !== null);
    const owner = (selected && wanted(selected) ? selected : newestFirst.find(wanted))
      ?? (selected && stageOfNode(selected, node.id) ? selected : newestFirst.find((flow) => stageOfNode(flow, node.id) !== null))
      ?? null;
    if (!owner) return;
    chooseRequest(owner.request.entryId);
    setStage(stageOfNode(owner, node.id));
    setFocusNode(node.id);
  };

  const timeFormat = useMemo(() => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }), [locale]);

  let body: ReactNode;
  if (!sessionId) {
    body = <p className={styles.message}>{t("memoryTrace.noSession")}</p>;
  } else if (state.kind === "error") {
    body = (
      <div className={styles.message} role="alert">
        <p className={styles.errorText}>{t("memoryTrace.error", { error: state.message })}</p>
        <ActionButton variant="neutralOutline" size="small" onClick={() => void load()}>{t("memoryTrace.retry")}</ActionButton>
      </div>
    );
  } else if (!trace) {
    body = <p className={styles.message} role="status">{t("memoryTrace.loading")}</p>;
  } else if (traced.length === 0) {
    body = <p className={styles.message}>{t("memoryTrace.empty")}</p>;
  } else {
    body = (
      <>
        <section className={styles.requests} aria-label={t("memoryTrace.requestsLabel")}>
          <h3 className={styles.sectionTitle}>
            {t("memoryTrace.requestsLabel")}
            <span className={styles.sectionCount}>{traced.length}</span>
          </h3>
          {/* 넘치면 아래가 흐려져 더 있다는 것을 보여 준다. 끝까지 내리면 사라진다. */}
          <div className={styles.requestScroller} data-more={listMore ? "true" : undefined}>
          <ul className={styles.requestList} ref={listRef} onScroll={updateListMore}>
            {newestFirst.map((flow) => {
              const active = flow === selected;
              return (
                <li key={flow.request.entryId}>
                  <button
                    type="button"
                    className={styles.requestRow}
                    aria-current={active ? "true" : undefined}
                    onClick={() => { chooseRequest(flow.request.entryId); setFocusNode(null); }}
                    title={flow.request.preview}
                  >
                    <span className={styles.requestIndex}>#{flow.index}</span>
                    <span className={styles.requestTime}>{flow.request.at ? timeFormat.format(flow.request.at) : ""}</span>
                    <RequestText preview={flow.request.preview} className={styles.requestPreview} />
                    <span className={styles.miniRail} aria-hidden="true">
                      {STAGES.map((item) => <span key={item} data-on={flow.happened[item] ? "true" : "false"} />)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          </div>
        </section>
        {selected && (
          <section className={styles.flow} aria-label={t("memoryTrace.flowLabel")}>
            <h3 className={styles.sectionTitle}>
              <span className={styles.titleText}>{t("memoryTrace.requestHeading", { index: selected.index })}</span>
              <RequestText preview={selected.request.preview} className={styles.flowPreview} />
            </h3>
            <ol className={styles.rail}>
              {STAGES.map((item, position) => {
                const count = selected.counts[item];
                const open = stage === item;
                return (
                  <li key={item} className={styles.station} data-filled={selected.happened[item] ? "true" : "false"} data-open={open ? "true" : undefined}>
                    <button
                      type="button"
                      className={styles.stationButton}
                      aria-expanded={open}
                      aria-controls="memory-trace-detail"
                      onClick={() => { setStage(item); setFocusNode(null); }}
                    >
                      <span className={styles.stationStep} aria-hidden="true">{position + 1}</span>
                      <span className={styles.stationCount}>{count}</span>
                      <span className={styles.stationLabel}>{t(STAGE_KEY[item])}</span>
                      {item === "docmap" && selected.candidates.length > 0 && (
                        <span className={styles.stationNote}>
                          {t("memoryTrace.openedSummary", {
                            opened: selected.candidates.filter((candidate) => candidate.opened).length,
                            skipped: selected.candidates.filter((candidate) => !candidate.opened).length,
                          })}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
            <div id="memory-trace-detail" className={styles.detail} ref={detailRef} role="region" aria-label={stage ? t(STAGE_KEY[stage]) : undefined}>
              {stage && <StageDetail flow={selected} stage={stage} focusNode={focusNode} />}
            </div>
          </section>
        )}
        {trace && selected && (
          <TraceGraph
            trace={trace}
            selected={selected}
            scope={scope}
            onScopeChange={changeScope}
            focusNode={focusNode}
            onSelectNode={selectNode}
          />
        )}
      </>
    );
  }

  return (
    <section className={styles.view} aria-label={title}>
      <PanelHeader
        title={title}
        subtitle={trace ? t("memoryTrace.requests", { count: traced.length }) : undefined}
        actions={sessionId ? [{ id: "refresh", label: t("memoryTrace.refresh"), icon: REFRESH_ICON, onClick: () => void load(), disabled: state.kind === "loading" }] : []}
      />
      <div className={styles.body} aria-busy={state.kind === "loading" ? "true" : undefined}>{body}</div>
    </section>
  );
}

function MemoryRow({ memory, verdict, focused }: { memory: MemoryTraceMemoryRef; verdict?: { short: string; label: string }; focused: boolean }) {
  const { t } = useI18n();
  return (
    <li className={styles.item} data-node={memoryNodeId(memory.id)} data-focused={focused ? "true" : undefined}>
      <div className={styles.itemHead}>
        <code className={styles.memoryId}>{memory.id}</code>
        {memory.date && <span className={styles.itemMeta}>{memory.date}</span>}
        {verdict && <Badge size="medium" variant="weak" tone="neutral" title={verdict.label}>{verdict.short}</Badge>}
      </div>
      <p className={styles.itemText} data-empty={memory.preview ? undefined : "true"}>{memory.preview ? plainText(memory.preview) : t("memoryTrace.noMemoryText")}</p>
    </li>
  );
}

/** 요청 글. 하네스 알림은 꼬리표 대신 작은 칩으로 보여 사용자 요청과 구별한다. 원문은 title에 남긴다. */
function RequestText({ preview, className }: { preview: string; className: string }) {
  const { t } = useI18n();
  const { notice, text } = splitNotice(preview);
  const readable = readablePreview(text);
  return (
    <span className={className} title={preview}>
      {notice && <span className={styles.noticeChip}>{t(notice === "harness" ? "memoryTrace.noticeHarness" : "memoryTrace.noticeResume")}</span>}
      {readable || (notice ? "" : t("memoryTrace.noPreview"))}
    </span>
  );
}

function PathText({ path }: { path: string }) {
  return <span className={styles.path} title={path} dir="rtl"><bdi dir="ltr">{path}</bdi></span>;
}

function StageDetail({ flow, stage, focusNode }: { flow: RequestFlow; stage: Stage; focusNode: string | null }) {
  const { t } = useI18n();
  if (!flow.happened[stage]) return <p className={styles.stageEmpty}>{t("memoryTrace.stageEmpty")}</p>;
  switch (stage) {
    case "recall":
      return (
        <>
          {flow.recalled.length > 0 && (
            <div className={styles.group}>
              <h4 className={styles.groupTitle}>{t("memoryTrace.autoRecall")}</h4>
              <ul className={styles.items}>
                {flow.recalled.map((memory) => (
                  <MemoryRow key={memory.id} memory={memory} verdict={flow.verdicts.get(memory.id)} focused={focusNode === memoryNodeId(memory.id)} />
                ))}
              </ul>
            </div>
          )}
          {flow.explicit.map((item, index) => (
            <div className={styles.group} key={`${item.target}-${index}`}>
              <h4 className={styles.groupTitle}>
                {t("memoryTrace.explicitRecall")}
                <code className={styles.groupCode}>{item.target}</code>
              </h4>
              {item.query && <p className={styles.query}>{t("memoryTrace.query")} · {item.query}</p>}
              {item.memories.length === 0 ? (
                <p className={styles.itemMeta}>{t("memoryTrace.noResults")}</p>
              ) : (
                <ul className={styles.items}>
                  {item.memories.map((memory) => (
                    <MemoryRow key={memory.id} memory={memory} verdict={flow.verdicts.get(memory.id)} focused={focusNode === memoryNodeId(memory.id)} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </>
      );
    case "jev":
      return (
        <>
          {flow.jev.map((check, index) => (
            <div className={styles.group} key={index}>
              {check.buckets.map((bucket) => (
                <div key={bucket.label} className={styles.bucket}>
                  <h4 className={styles.groupTitle} title={bucket.label}>
                    {bucket.shortLabel}
                    <span className={styles.sectionCount}>{bucket.ids.length}</span>
                  </h4>
                  <ul className={styles.idList}>
                    {bucket.ids.map((id) => (
                      <li key={id} data-node={memoryNodeId(id)} data-focused={focusNode === memoryNodeId(id) ? "true" : undefined}>
                        <code className={styles.memoryId}>{id}</code>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className={styles.itemMeta}>
                {check.unknown !== null && t("memoryTrace.jevUnknown", { count: check.unknown })}
                {check.unknown !== null && check.unrelated !== null && " · "}
                {check.unrelated !== null && t("memoryTrace.jevUnrelated", { count: check.unrelated })}
              </p>
            </div>
          ))}
        </>
      );
    case "docmap":
      return (
        <ul className={styles.items}>
          {flow.candidates.map((candidate) => (
            <li key={candidate.path} className={styles.item} data-node={docNodeId(candidate.path)} data-focused={focusNode === docNodeId(candidate.path) ? "true" : undefined} data-skipped={candidate.opened ? undefined : "true"}>
              <div className={styles.itemHead}>
                <PathText path={candidate.path} />
                <Badge size="medium" variant={candidate.opened ? "solid" : "weak"} tone={candidate.opened ? "positive" : "neutral"}>
                  {candidate.opened ? t("memoryTrace.opened") : t("memoryTrace.candidateOnly")}
                </Badge>
              </div>
              {(candidate.status || candidate.map) && (
                <p className={styles.itemText}>
                  {candidate.status && <span className={styles.itemMeta}>STATUS {candidate.status}</span>}
                  {candidate.status && candidate.map && " · "}
                  {candidate.map}
                </p>
              )}
            </li>
          ))}
        </ul>
      );
    case "docs":
      return (
        <ul className={styles.items}>
          {flow.docs.map((doc) => (
            <li key={doc.path} className={styles.item} data-node={docNodeId(doc.path)} data-focused={focusNode === docNodeId(doc.path) ? "true" : undefined}>
              <div className={styles.itemHead}>
                <PathText path={doc.path} />
                {doc.candidate && <Badge size="medium" variant="weak" tone="informative">{t("memoryTrace.fromMap")}</Badge>}
              </div>
              {doc.selectors.length > 0 && <p className={styles.itemMeta}>{t("memoryTrace.lines", { lines: doc.selectors.join(", ") })}</p>}
            </li>
          ))}
        </ul>
      );
    case "lessons":
      return (
        <>
          {flow.lessons.map((lesson, index) => (
            <div className={styles.group} key={`${lesson.file}-${index}`} data-node={fileNodeId(lesson.file)} data-alt-node={docNodeId(lesson.file)} data-focused={focusNode === fileNodeId(lesson.file) || focusNode === docNodeId(lesson.file) ? "true" : undefined}>
              <h4 className={styles.groupTitle}>
                {t("memoryTrace.lessonFor")}
                <PathText path={lesson.file} />
              </h4>
              <ul className={styles.items}>
                {lesson.memories.map((memory) => (
                  <MemoryRow key={memory.id} memory={memory} focused={focusNode === memoryNodeId(memory.id)} />
                ))}
              </ul>
            </div>
          ))}
        </>
      );
    case "saved":
      return (
        <ul className={styles.items}>
          {flow.saved.map((item) => (
            <li key={item.nodeId} className={styles.item} data-node={item.nodeId} data-focused={focusNode === item.nodeId ? "true" : undefined}>
              <div className={styles.itemHead}>
                <Badge size="medium" variant="weak" tone="neutral">{item.source === "autolearn" ? t("memoryTrace.savedAuto") : item.source}</Badge>
              </div>
              <p className={styles.itemText}>{plainText(item.text)}</p>
            </li>
          ))}
        </ul>
      );
  }
}

// ---------------------------------------------------------------------------
// 연결 그래프: 기억 | 요청 | 문서·파일 세 열. 같은 입력이면 늘 같은 자리에 그린다.
// ---------------------------------------------------------------------------

const HEAD = 30;
/** Inner padding: label boxes and focus rings never touch the frame edge. */
const PAD = 16;
const REQUEST_W = 40;
const NODE_R = 5;
const LABEL_GAP = 6;
const LINE_H = 14;
/** Two label lines fit in the smallest row; rows stretch up to ROW_MAX to fill the panel. */
const ROW_MIN = 36;
const ROW_MAX = 60;
const GRAPH_MIN_H = 280;

type Verdict = "apply" | "excepted" | "conflict" | "unconfirmed" | "unlisted";
const VERDICTS: readonly Verdict[] = ["apply", "excepted", "conflict", "unconfirmed", "unlisted"];
const VERDICT_KEY: Record<Verdict, string> = {
  apply: "memoryTrace.verdictApply",
  excepted: "memoryTrace.verdictExcepted",
  conflict: "memoryTrace.verdictConflict",
  unconfirmed: "memoryTrace.verdictUnconfirmed",
  unlisted: "memoryTrace.verdictUnlisted",
};

/** JEV 판정 줄 이름(jev-runtime renderMemoryApplication)을 고리 색 갈래로 나눈다. */
function verdictOf(label: string): Verdict {
  if (label.includes("충돌")) return "conflict";
  if (label.includes("불충족") || label.includes("예외")) return "excepted";
  if (label.startsWith("적용")) return "apply";
  return "unconfirmed";
}

/** 그래프 노드. 같은 경로를 열고 편집했으면 문서 노드 하나에 edited를 붙여 두 역할을 함께 싣는다. */
type GraphNode = MemoryTraceNode & { edited?: boolean };

interface Placed {
  node: GraphNode;
  x: number;
  y: number;
  column: 0 | 1 | 2;
}

/** 대략적인 글 폭(px, 12px 글꼴). 한글·한자는 넓게, 나머지는 좁게 센다. */
function charWidth(char: string): number {
  return /[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(char) ? 12 : 6.8;
}

/** 라벨을 최대 두 줄로 나눈다. 넘치면 마지막 줄 끝을 …로 줄인다(전체 글은 title과 설명 줄에 있다). */
function wrapLabel(text: string, maxPx: number, maxLines = 2): string[] {
  if (maxPx < 24) return [];
  const lines: string[] = [];
  let line = "";
  let width = 0;
  // 앞뒤 공백을 지워 줄 첫 칸이 공백이 되지 않게 한다(첫 칸 공백은 끊을 자리로 쓰지 않는다).
  for (const char of text.trim()) {
    const w = charWidth(char);
    if (width + w > maxPx) {
      if (lines.length === maxLines - 1) {
        lines.push(`${line.slice(0, -1).trimEnd()}…`);
        return lines;
      }
      // 띄어쓰기에서만 줄을 바꾼다(날짜·경로 같은 토큰을 가르지 않는다). 띄어쓰기 없는 긴 토큰만 자른다.
      const cut = line.lastIndexOf(" ");
      const keep = cut > 0 ? line.slice(0, cut) : line;
      lines.push(keep);
      line = line.slice(keep.length).trimStart();
      width = [...line].reduce((sum, item) => sum + charWidth(item), 0);
    }
    line += char;
    width += w;
  }
  if (line) lines.push(line);
  return lines;
}

/** 경로는 한 줄로 두고 앞쪽을 줄여 파일 이름을 남긴다("…Config/HANDOFF.md"). 전체 경로는 title과 설명 줄에 있다. */
function fitPath(path: string, maxPx: number): string {
  const chars = [...path];
  const total = chars.reduce((sum, char) => sum + charWidth(char), 0);
  if (total <= maxPx) return path;
  let width = charWidth("…");
  let start = chars.length;
  while (start > 0 && width + charWidth(chars[start - 1]) <= maxPx) {
    start -= 1;
    width += charWidth(chars[start]);
  }
  return `…${chars.slice(start).join("")}`;
}

function layoutGraph(nodes: readonly GraphNode[], edges: readonly MemoryTraceEdge[], width: number, fillHeight: number, requestOrder: ReadonlyMap<string, number>) {
  const requests = nodes.filter((node) => node.kind === "request")
    .sort((a, b) => (requestOrder.get(b.id) ?? 0) - (requestOrder.get(a.id) ?? 0));
  const rank = new Map(requests.map((node, index) => [node.id, index]));
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    (neighbours.get(edge.from) ?? neighbours.set(edge.from, []).get(edge.from)!).push(edge.to);
    (neighbours.get(edge.to) ?? neighbours.set(edge.to, []).get(edge.to)!).push(edge.from);
  }
  // 이웃 요청 순위의 평균으로 정렬해 선이 덜 엇갈리게 한다. 파일에 묶인 기억은 그 파일의 요청을 본다.
  const weight = (id: string): number => {
    const ranks: number[] = [];
    for (const other of neighbours.get(id) ?? []) {
      const direct = rank.get(other);
      if (direct !== undefined) ranks.push(direct);
      else for (const hop of neighbours.get(other) ?? []) { const r = rank.get(hop); if (r !== undefined) ranks.push(r); }
    }
    return ranks.length > 0 ? ranks.reduce((sum, value) => sum + value, 0) / ranks.length : Number.MAX_SAFE_INTEGER;
  };
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const sortByWeight = (list: GraphNode[]) => list
    .map((node) => ({ node, w: weight(node.id) }))
    .sort((a, b) => a.w - b.w || (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0))
    .map((item) => item.node);
  const memories = sortByWeight(nodes.filter((node) => node.kind === "memory"));
  const right = [...sortByWeight(nodes.filter((node) => node.kind === "doc")), ...sortByWeight(nodes.filter((node) => node.kind === "file"))];
  const columns: GraphNode[][] = [memories, requests, right];
  const rows = Math.max(1, ...columns.map((column) => column.length));
  const rowH = Math.min(ROW_MAX, Math.max(ROW_MIN, (fillHeight - HEAD - PAD) / rows));
  const height = Math.ceil(HEAD + rows * rowH + PAD);
  // 가운데 요청 열 양옆에 선이 지나갈 틈을 두고, 남는 폭은 기억(긴 문장) 쪽에 조금 더 준다.
  const gap = Math.min(160, Math.max(28, Math.round(width * 0.1)));
  const labels = Math.max(0, width - 2 * PAD - 2 * (NODE_R + LABEL_GAP) - REQUEST_W - 2 * gap);
  const leftLabel = Math.round(labels * 0.56);
  const rightLabel = labels - leftLabel;
  const x0 = PAD + leftLabel + LABEL_GAP + NODE_R;
  const x1 = x0 + gap + REQUEST_W / 2;
  const xs = [x0, x1, x1 + REQUEST_W / 2 + gap];
  const placed = new Map<string, Placed>();
  // 가장 긴 열이 위에서부터 차고, 짧은 열은 그 블록 가운데에 둔다. 남는 높이를 띠로 남기지 않는다.
  columns.forEach((column, columnIndex) => {
    const offset = HEAD + ((rows - column.length) * rowH) / 2 + rowH / 2;
    column.forEach((node, index) => {
      placed.set(node.id, { node, x: xs[columnIndex], y: Math.round(offset + index * rowH), column: columnIndex as 0 | 1 | 2 });
    });
  });
  return { placed, height, xs, neighbours, rowH, leftLabel, rightLabel };
}

function NodeMark({ kind }: { kind: MemoryTraceNode["kind"] }) {
  switch (kind) {
    case "memory":
      return <circle r={NODE_R} />;
    case "doc":
      return <rect x={-NODE_R} y={-NODE_R} width={NODE_R * 2} height={NODE_R * 2} rx={1.5} />;
    case "file":
      return <rect x={-NODE_R} y={-NODE_R} width={NODE_R * 2} height={NODE_R * 2} transform="rotate(45)" rx={1} />;
    case "request":
      return <rect x={-REQUEST_W / 2} y={-9} width={REQUEST_W} height={18} rx={9} />;
  }
}

function TraceGraph({ trace, selected, scope, onScopeChange, focusNode, onSelectNode }: {
  trace: MemoryTrace;
  selected: RequestFlow;
  scope: GraphScope;
  onScopeChange: (scope: GraphScope) => void;
  focusNode: string | null;
  onSelectNode: (node: GraphNode) => void;
}) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [fillHeight, setFillHeight] = useState(GRAPH_MIN_H);
  const [active, setActive] = useState<string | null>(null);

  // 그래프는 패널 아래 남은 높이를 채운다. 높이는 위쪽 내용과 스크롤 영역 크기로만 정해서 SVG 높이와 서로 물리지 않는다.
  const measureFill = useCallback(() => {
    const frame = frameRef.current;
    const scroller = frame?.closest<HTMLElement>(`.${styles.body}`);
    if (!frame || !scroller) return;
    const top = frame.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
    const bottom = Number.parseFloat(getComputedStyle(scroller).paddingBlockEnd) || 0;
    const next = Math.max(GRAPH_MIN_H, Math.floor(scroller.clientHeight - top - bottom - 2));
    setFillHeight((current) => (Math.abs(current - next) > 1 ? next : current));
  }, []);

  useLayoutEffect(measureFill);

  useEffect(() => {
    const frame = frameRef.current;
    const scroller = frame?.closest<HTMLElement>(`.${styles.body}`);
    if (!frame) return;
    const observer = new ResizeObserver(() => {
      setWidth(Math.round(frame.getBoundingClientRect().width) - 2);
      measureFill();
    });
    observer.observe(frame);
    if (scroller) observer.observe(scroller);
    return () => observer.disconnect();
  }, [measureFill]);

  const requestOrder = useMemo(() => new Map(trace.requests.map((request, index) => [requestNodeId(request.entryId), index + 1])), [trace]);

  // 같은 경로를 열고(doc) 편집 전 교훈을 받았으면(file) 노드 하나로 합치고 두 역할의 선을 모두 그 노드에 잇는다.
  const merged = useMemo(() => {
    const docByPath = new Map(trace.nodes.filter((node) => node.kind === "doc").map((node) => [node.title, node.id]));
    const alias = new Map<string, string>();
    for (const node of trace.nodes) {
      const doc = node.kind === "file" ? docByPath.get(node.title) : undefined;
      if (doc) alias.set(node.id, doc);
    }
    const edited = new Set(alias.values());
    const nodes: GraphNode[] = trace.nodes
      .filter((node) => !alias.has(node.id))
      .map((node) => (edited.has(node.id) ? { ...node, edited: true } : node));
    const edges = trace.edges.map((edge) => ({ ...edge, from: alias.get(edge.from) ?? edge.from, to: alias.get(edge.to) ?? edge.to }));
    return { nodes, edges, alias };
  }, [trace]);

  const { nodes, edges } = useMemo(() => {
    if (scope === "session") {
      const linked = new Set(merged.edges.flatMap((edge) => [edge.from, edge.to]));
      return { nodes: merged.nodes.filter((node) => linked.has(node.id)), edges: merged.edges };
    }
    const root = requestNodeId(selected.request.entryId);
    const keep = new Set([root]);
    const direct = merged.edges.filter((edge) => edge.from === root);
    for (const edge of direct) keep.add(edge.to);
    // 파일 노드는 세션 전체에서 하나라, 이 요청이 그 파일에서 받은 교훈만 남긴다.
    const fileId = (file: string) => merged.alias.get(fileNodeId(file)) ?? fileNodeId(file);
    const lessonPairs = new Set(selected.lessons.flatMap((lesson) => lesson.memories.map((memory) => `${fileId(lesson.file)}\u0000${memoryNodeId(memory.id)}`)));
    const lessons = merged.edges.filter((edge) => edge.kind === "lesson" && lessonPairs.has(`${edge.from}\u0000${edge.to}`));
    for (const edge of lessons) keep.add(edge.to);
    return { nodes: merged.nodes.filter((node) => keep.has(node.id)), edges: [...direct, ...lessons] };
  }, [merged, scope, selected]);

  const layout = useMemo(() => (width > 0 ? layoutGraph(nodes, edges, width, fillHeight, requestOrder) : null), [nodes, edges, width, fillHeight, requestOrder]);

  // 고른 요청에 JEV가 돌았으면 그 요청에 온 기억마다 판정 고리를 단다. 목록에 없는 기억은 무관·불명(JEV는 수만 남긴다).
  const verdicts = useMemo(() => {
    const map = new Map<string, Verdict>();
    if (!selected.happened.jev) return map;
    for (const memory of selected.recalled) map.set(memoryNodeId(memory.id), "unlisted");
    for (const [id, verdict] of selected.verdicts) map.set(memoryNodeId(id), verdictOf(verdict.label));
    return map;
  }, [selected]);
  const shownVerdicts = useMemo(() => {
    const present = new Set(nodes.flatMap((node) => verdicts.get(node.id) ?? []));
    return VERDICTS.filter((verdict) => present.has(verdict));
  }, [nodes, verdicts]);

  const highlight = active ?? focusNode;
  const lit = useMemo(() => {
    if (!highlight || !layout) return null;
    return new Set([highlight, ...(layout.neighbours.get(highlight) ?? [])]);
  }, [highlight, layout]);
  // 이 요청 범위에서는 모든 노드가 고른 요청에 이어져 있어 흐리게 하지 않는다.
  // 세션 전체에서는 고른(또는 가리킨) 노드에 이어지지 않은 것만 흐리게 한다.
  const context = useMemo(() => {
    if (scope === "request" || !layout) return null;
    const centre = highlight ?? requestNodeId(selected.request.entryId);
    const keep = new Set([centre]);
    for (const near of layout.neighbours.get(centre) ?? []) {
      keep.add(near);
      // 문서·파일을 거쳐 이어진 교훈 기억도 함께 남긴다(다른 요청은 남기지 않는다).
      if (near.startsWith("file:") || near.startsWith("doc:")) {
        for (const lesson of layout.neighbours.get(near) ?? []) if (lesson.startsWith("memory:")) keep.add(lesson);
      }
    }
    return keep;
  }, [scope, layout, highlight, selected]);

  const kindLabel: Record<MemoryTraceNode["kind"], string> = {
    request: t("memoryTrace.legendRequest"),
    memory: t("memoryTrace.legendMemory"),
    doc: t("memoryTrace.legendDoc"),
    file: t("memoryTrace.legendFile"),
  };

  /** 노드 종류 이름. 열고 편집한 경로는 두 역할을 함께 적는다. */
  const nodeKind = (node: GraphNode) => (node.edited ? `${kindLabel.doc} · ${kindLabel.file}` : kindLabel[node.kind]);

  // 같은 두 노드 사이 선 종류 목록(왼쪽 노드|오른쪽 노드). 겹치는 선을 벌리는 데 쓴다.
  const lanes = useMemo(() => {
    const map = new Map<string, MemoryTraceEdge["kind"][]>();
    if (!layout) return map;
    for (const edge of edges) {
      const from = layout.placed.get(edge.from);
      const to = layout.placed.get(edge.to);
      if (!from || !to) continue;
      const key = from.x <= to.x ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`;
      (map.get(key) ?? map.set(key, []).get(key)!).push(edge.kind);
    }
    return map;
  }, [edges, layout]);
  const arrowId = `memory-trace-arrow-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const onNodeKey = (event: ReactKeyboardEvent<SVGGElement>, node: GraphNode) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelectNode(node);
    }
  };

  const captionNode = highlight && layout ? layout.placed.get(highlight)?.node ?? null : null;
  const captionVerdict = captionNode ? verdicts.get(captionNode.id) : undefined;

  return (
    <section className={styles.graph} aria-label={t("memoryTrace.graphLabel")}>
      <div className={styles.graphHead}>
        <h3 className={styles.sectionTitle}>{t("memoryTrace.graphLabel")}</h3>
        <SegmentedControl.Root
          className={styles.scopeSwitch}
          aria-label={t("memoryTrace.graphScope")}
          value={scope}
          onValueChange={(value) => onScopeChange(value as GraphScope)}
        >
          {(["request", "session"] as const).map((value) => (
            <SegmentedControl.Item key={value} value={value}>
              <SegmentedControl.ItemHiddenInput />
              {value === "request" ? t("memoryTrace.scopeRequest") : t("memoryTrace.scopeSession")}
            </SegmentedControl.Item>
          ))}
          <SegmentedControl.Indicator />
        </SegmentedControl.Root>
      </div>
      <ul className={styles.legend}>
        {(["request", "memory", "doc", "file"] as const).map((kind) => (
          <li key={kind} data-kind={kind}>
            <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><g className={styles.legendMark}>{kind === "request" ? <rect x={-6} y={-4} width={12} height={8} rx={4} /> : <NodeMark kind={kind} />}</g></svg>
            {kindLabel[kind]}
          </li>
        ))}
        {(["recalled", "opened", "lesson", "candidate"] as const).map((kind) => (
          <li key={kind} data-kind={`edge-${kind}`}>
            <svg width="20" height="8" aria-hidden="true"><line x1="1" y1="4" x2="19" y2="4" /></svg>
            {t(kind === "recalled" ? "memoryTrace.edgeRecalled" : kind === "opened" ? "memoryTrace.opened" : kind === "lesson" ? "memoryTrace.edgeLesson" : "memoryTrace.candidateOnly")}
          </li>
        ))}
        {nodes.some((node) => node.edited) && (
          <li data-kind="edited">
            <svg width="14" height="14" viewBox="-7 -7 14 14" aria-hidden="true"><g className={styles.legendMark}><NodeMark kind="doc" /></g></svg>
            {t("memoryTrace.legendDocEdited")}
          </li>
        )}
      </ul>
      {shownVerdicts.length > 0 && (
        <ul className={styles.legend} aria-label={t("memoryTrace.verdictLegend")}>
          <li className={styles.legendTitle}>{t("memoryTrace.verdictLegend")}</li>
          {shownVerdicts.map((verdict) => (
            <li key={verdict} data-verdict={verdict}>
              <svg width="16" height="16" viewBox="-8 -8 16 16" aria-hidden="true">
                <circle className={styles.ring} r={NODE_R + 2.5} />
                <circle className={styles.legendMemory} r={NODE_R - 1} />
              </svg>
              {t(VERDICT_KEY[verdict])}
            </li>
          ))}
        </ul>
      )}
      <p className={styles.graphCaption} aria-live="polite">
        {captionNode ? (
          <>
            <span className={styles.captionKind}>
              {captionNode.kind === "request" ? `#${requestOrder.get(captionNode.id) ?? ""}` : nodeKind(captionNode)}
              {captionVerdict ? ` · ${t(VERDICT_KEY[captionVerdict])}` : ""}
            </span>
            {captionNode.kind === "request" ? readablePreview(captionNode.title) : captionNode.kind === "memory" ? plainTitle(captionNode.title) : captionNode.title}
          </>
        ) : t("memoryTrace.graphHint")}
      </p>
      <div className={styles.graphFrame} ref={frameRef}>
        {nodes.length <= 1 ? (
          <p className={styles.stageEmpty}>{t("memoryTrace.graphEmpty")}</p>
        ) : layout && (
          <svg
            className={styles.graphSvg}
            width={width}
            height={layout.height}
            viewBox={`0 0 ${width} ${layout.height}`}
            role="group"
            aria-label={t("memoryTrace.graphLabel")}
            onPointerLeave={() => setActive(null)}
          >
            <defs>
              <marker id={arrowId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path className={styles.arrow} d="M0,0.5 L8,4 L0,7.5 z" />
              </marker>
            </defs>
            <g className={styles.columnHeads} aria-hidden="true">
              <text x={layout.xs[0]} y={16} textAnchor="end">{kindLabel.memory}</text>
              <text x={layout.xs[1]} y={16} textAnchor="middle">{kindLabel.request}</text>
              <text x={layout.xs[2]} y={16} textAnchor="start">{kindLabel.doc} · {kindLabel.file}</text>
            </g>
            <g className={styles.edges} aria-hidden="true">
              {edges.map((edge) => {
                const from = layout.placed.get(edge.from);
                const to = layout.placed.get(edge.to);
                if (!from || !to) return null;
                const [a, b] = from.x <= to.x ? [from, to] : [to, from];
                // 같은 두 노드 사이에 선이 둘이면(연 문서이자 편집 파일) 위아래로 살짝 벌려 두 종류가 다 보이게 한다.
                const pair = lanes.get(`${a.node.id}|${b.node.id}`) ?? [edge.kind];
                const shift = (pair.indexOf(edge.kind) - (pair.length - 1) / 2) * 4;
                const ay = a.y + shift;
                const by = b.y + shift;
                const ax = a.column === 1 ? a.x + (a.x < b.x ? REQUEST_W / 2 : -REQUEST_W / 2) : a.x + NODE_R;
                const lesson = a.column === 0 && b.column === 2;
                // 교훈 선은 화살표가 파일 노드 앞에서 끝나도록 조금 일찍 멈춘다.
                const bx = b.column === 1 ? b.x - REQUEST_W / 2 : b.x - NODE_R - (lesson ? 3 : 0);
                const mid = (ax + bx) / 2;
                // 교훈 선(기억 → 편집 파일)은 요청 열을 건너가므로, 기억 열 바로 옆에서 파일 줄로 꺾은 뒤 곧게 간다.
                // 가운데나 요청 열 가까이에서 휘면 요청 알약으로 들어가는 선처럼 보인다.
                const turn = lesson ? ax + Math.max(12, (layout.xs[1] - REQUEST_W / 2 - ax) * 0.4) : null;
                // 파일 줄에 요청 알약이 있으면 알약 아래(맨 아래 줄이면 위) 줄 사이로 비켜 지난 뒤 파일로 돌아온다.
                const blocked = lesson && [...layout.placed.values()].some((item) => item.column === 1 && Math.abs(item.y - by) < 12);
                const laneY = by + (by + layout.rowH / 2 > layout.height - PAD ? -1 : 1) * (layout.rowH / 2);
                const pastX = layout.xs[1] + REQUEST_W / 2 + 8;
                const d = turn === null
                  ? `M${ax},${ay} C${mid},${ay} ${mid},${by} ${bx},${by}`
                  : blocked
                    ? `M${ax},${ay} C${(ax + turn) / 2},${ay} ${(ax + turn) / 2},${laneY} ${turn},${laneY} L${pastX},${laneY} C${(pastX + bx) / 2},${laneY} ${(pastX + bx) / 2},${by} ${bx},${by}`
                    : `M${ax},${ay} C${(ax + turn) / 2},${ay} ${(ax + turn) / 2},${by} ${turn},${by} L${bx},${by}`;
                const on = highlight !== null && (edge.from === highlight || edge.to === highlight);
                const dim = context !== null && !(context.has(edge.from) && context.has(edge.to));
                return (
                  <path
                    key={`${edge.from}|${edge.to}|${edge.kind}`}
                    d={d}
                    data-kind={edge.kind}
                    data-on={on ? "true" : undefined}
                    data-dim={dim && !on ? "true" : undefined}
                    markerEnd={lesson ? `url(#${arrowId})` : undefined}
                  />
                );
              })}
            </g>
            <g className={styles.nodes}>
              {[...layout.placed.values()].map(({ node, x, y, column }) => {
                const degree = layout.neighbours.get(node.id)?.length ?? 0;
                const space = column === 0 ? layout.leftLabel : layout.rightLabel;
                const lines = node.kind === "request"
                  ? [`#${requestOrder.get(node.id) ?? ""}`]
                  : node.kind === "memory" ? wrapLabel(plainText(node.label), space) : [fitPath(node.title, space)];
                const verdict = verdicts.get(node.id);
                const hitH = layout.rowH - 4;
                const textX = column === 0 ? -NODE_R - LABEL_GAP : column === 2 ? NODE_R + LABEL_GAP : 0;
                return (
                  <g
                    key={node.id}
                    className={styles.node}
                    data-kind={node.kind}
                    data-on={lit?.has(node.id) ? "true" : undefined}
                    data-dim={context && !context.has(node.id) ? "true" : undefined}
                    data-current={node.id === requestNodeId(selected.request.entryId) ? "true" : undefined}
                    data-verdict={verdict}
                    data-edited={node.edited ? "true" : undefined}
                    transform={`translate(${x},${y})`}
                    tabIndex={0}
                    role="button"
                    aria-label={t("memoryTrace.nodeLabel", { kind: nodeKind(node), label: node.kind === "memory" ? plainTitle(node.title) : node.title, count: degree })}
                    onPointerEnter={() => setActive(node.id)}
                    onFocus={() => setActive(node.id)}
                    onBlur={() => setActive(null)}
                    onClick={() => onSelectNode(node)}
                    onKeyDown={(event) => onNodeKey(event, node)}
                  >
                    <title>{node.kind === "request" ? readablePreview(node.title) : node.kind === "memory" ? plainTitle(node.title) : node.title}</title>
                    <rect
                      className={styles.hit}
                      x={column === 0 ? -NODE_R - LABEL_GAP - space - 4 : column === 1 ? -REQUEST_W / 2 - 4 : -NODE_R - 4}
                      y={-hitH / 2}
                      width={column === 1 ? REQUEST_W + 8 : space + NODE_R * 2 + LABEL_GAP + 8}
                      height={hitH}
                    />
                    {verdict && <circle className={styles.ring} r={NODE_R + 3} />}
                    <g className={styles.mark}><NodeMark kind={node.kind} /></g>
                    <text
                      className={styles.nodeText}
                      x={textX}
                      y={4 - ((lines.length - 1) * LINE_H) / 2}
                      textAnchor={column === 0 ? "end" : column === 2 ? "start" : "middle"}
                    >
                      {lines.map((line, index) => (
                        <tspan key={index} x={textX} dy={index === 0 ? 0 : LINE_H}>{line}</tspan>
                      ))}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
        )}
      </div>
    </section>
  );
}
