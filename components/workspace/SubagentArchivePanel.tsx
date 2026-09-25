"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SubagentSnapshot, ToolResultMessage } from "@/lib/types";
import { MessageView } from "@/components/MessageView";
import {
  createHanseSubagentClient,
  mergeSubagentRecords,
  resolveSubagentModelMeta,
  resolveSubagentRole,
  resolveSubagentTaskPresentation,
  type HanseSubagentClient,
  type MergedSubagentRecord,
  type SubagentArchiveRecord,
} from "@/lib/hanse-subagent-client";
import {
  isActiveSubagentStatus,
  SUBAGENT_POLL_INTERVAL_MS,
  transcriptError,
  useSubagentTranscripts,
  type SubagentTranscriptState,
} from "@/hooks/useSubagentTranscripts";

export interface SubagentArchivePanelProps {
  /** Header label, supplied by the deck so it matches the view switcher's locale. */
  title: string;
  sessionId: string | null;
  sessionPath: string | null;
  sessionCwd?: string;
  liveSubagents: readonly SubagentSnapshot[];
  client?: HanseSubagentClient;
  visible?: boolean;
  onClose?: () => void;
  onReturnFocus?: () => void;
}

type LoadState<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T }
  | { kind: "empty"; data: T }
  | { kind: "unreachable"; message: string }
  | { kind: "error"; message: string };

/** 아직 아무것도 읽지 못한 자식의 상태. 지도에 항목이 없을 때 쓴다. */
const LOADING_TRANSCRIPT: SubagentTranscriptState = { kind: "loading" };

function formatDuration(durationMs = 0): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분${seconds % 60 ? ` ${seconds % 60}초` : ""}`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function formatRelative(timestamp = 0): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 10_000) return "방금 전";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1000)}초 전`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}분 전`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}시간 전`;
  return `${Math.floor(elapsed / 86_400_000)}일 전`;
}

function statusColor(snapshot: SubagentSnapshot): string {
  if (snapshot.status === "failed") return "var(--danger)";
  if (snapshot.status === "aborted" || snapshot.progress?.retryState) return "var(--warning)";
  if (isActiveSubagentStatus(snapshot.status)) return "var(--accent)";
  return "var(--success)";
}

function identityLabel(record: MergedSubagentRecord): string {
  if (record.identity === "live-archive") return "실시간 + 디스크";
  if (record.identity === "live") return "실시간";
  return "디스크 기록";
}

const ROLE_SOURCE_LABEL: Record<SubagentSnapshot["agentSource"], string> = {
  bundled: "기본 제공",
  user: "사용자 정의",
  project: "프로젝트 정의",
};

function subagentTimestamp(snapshot: SubagentSnapshot): number {
  return snapshot.lastUpdate || snapshot.progress?.durationMs || 0;
}

function mergeLiveSnapshots(
  provided: readonly SubagentSnapshot[],
  polled: readonly SubagentSnapshot[],
): SubagentSnapshot[] {
  const byId = new Map<string, SubagentSnapshot>();
  const order: string[] = [];
  for (const snapshot of [...provided, ...polled]) {
    const current = byId.get(snapshot.id);
    if (!current) {
      order.push(snapshot.id);
      byId.set(snapshot.id, snapshot);
      continue;
    }
    const [newer, older] =
      subagentTimestamp(snapshot) >= subagentTimestamp(current)
        ? [snapshot, current]
        : [current, snapshot];
    byId.set(snapshot.id, {
      ...newer,
      // Direct follow-up progress can be newer while omitting the original assignment.
      assignment: newer.assignment ?? older.assignment,
      description: newer.description ?? older.description,
    });
  }
  return order.flatMap((id) => {
    const snapshot = byId.get(id);
    return snapshot ? [snapshot] : [];
  });
}

function panelButtonStyle(): React.CSSProperties {
  return {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 30,
    padding: 0,
    border: "1px solid var(--border)",
    borderRadius: 6,
    background: "var(--bg)",
    color: "var(--text-muted)",
    cursor: "pointer",
  };
}

function SubagentDetail({
  sessionId,
  sessionCwd,
  record,
  client,
  visible,
  onBack,
}: {
  sessionId: string;
  sessionCwd?: string;
  record: MergedSubagentRecord;
  client: HanseSubagentClient;
  visible: boolean;
  onBack: () => void;
}) {
  // 기록 읽기는 대화창과 같은 훅 하나가 맡는다. 패널은 대상 하나만 넘긴다.
  const targets = useMemo(() => [{
    key: record.key,
    liveId: record.live?.id,
    status: record.live?.status,
    archiveName: record.archive?.name,
  }], [record.key, record.live?.id, record.live?.status, record.archive?.name]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const state = useSubagentTranscripts(targets, { sessionId, client, enabled: visible }).get(record.key)?.state
    ?? LOADING_TRANSCRIPT;

  useEffect(() => {
    if (!visible || (state.kind !== "ready-live" && state.kind !== "ready-archive")) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [state, visible]);

  const liveEntries = state.kind === "ready-live" ? state.entries : [];
  const toolResults = useMemo(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const entry of liveEntries) {
      // irc 수신 경계는 메시지가 아니라 발화 위치를 가르는 표식이라 렌더하지 않는다.
      if (!("message" in entry)) continue;
      if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
    }
    return results;
  }, [liveEntries]);

  const title = record.live?.id || record.archive?.name || "Subagent";
  return (
    <div role="dialog" aria-label={`${title} 기록`} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 42, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
        <button type="button" onClick={onBack} aria-label="Subagent 목록으로 돌아가기" title="목록" style={panelButtonStyle()}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m10.5 3-5 5 5 5" /></svg>
        </button>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11.5, fontWeight: 700 }}>{title}</div>
          <div style={{ marginTop: 2, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{identityLabel(record)}</div>
        </div>
        {record.live && <span style={{ color: statusColor(record.live), fontFamily: "var(--font-mono)", fontSize: 9.5 }}>{record.live.status}</span>}
      </div>

      <div ref={transcriptRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 18px" }}>
        {state.kind === "loading" && <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5 }}>기록 불러오는 중…</div>}
        {state.kind === "ready-live" && state.entries.flatMap((entry, index) => {
          if (!("message" in entry)) return [];
          const prev = state.entries[index - 1];
          return [(
            <MessageView
              key={entry.id}
              message={entry.message}
              toolResults={toolResults}
              cwd={sessionCwd}
              showTimestamp
              prevTimestamp={prev && "message" in prev ? prev.message.timestamp : undefined}
            />
          )];
        })}
        {state.kind === "ready-archive" && (
          <>
            {state.note && <div role="status" style={{ marginBottom: 8, color: "var(--text-muted)", fontSize: 9.5, lineHeight: 1.5 }}>{state.note}</div>}
            {state.truncated && <div role="status" style={{ marginBottom: 8, color: "var(--warning)", fontSize: 9.5 }}>최근 400개 기록만 표시합니다.</div>}
            {state.entries.map((entry, index) => (
              <div key={`${entry.at ?? 0}:${index}`} style={{ margin: "0 0 7px", padding: "8px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 11, lineHeight: 1.55 }}>
                <div style={{ marginBottom: 5, color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 8.5, letterSpacing: "0.04em" }}>{entry.role} · {entry.kind}</div>
                {entry.text || "(내용 없음)"}
              </div>
            ))}
          </>
        )}
        {state.kind === "empty" && <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5, lineHeight: 1.6 }}>{state.note && <><span>{state.note}</span><br /></>}대화 내용이 없습니다.</div>}
        {state.kind === "unreachable" && <div role="status" style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.5 }}>{state.message}</div>}
        {state.kind === "error" && <div role="alert" style={{ padding: 10, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--danger)", fontSize: 10.5, lineHeight: 1.5 }}>{state.message}</div>}
      </div>
    </div>
  );
}

function SubagentRow({ record, onSelect }: { record: MergedSubagentRecord; onSelect: () => void }) {
  const snapshot = record.live;
  const archived = record.archive;
  const presentation = resolveSubagentTaskPresentation(record);
  const name = snapshot?.id || archived?.name || "Subagent";
  const source = identityLabel(record);
  const role = resolveSubagentRole(record);
  // 기록된 값만 표시한다. 미관측은 추정하지 않고 그대로 미확인이라고 쓴다.
  const meta = resolveSubagentModelMeta(record);
  const modelLabel = meta.modelShort ?? "모델 미확인";
  const effortLabel = meta.effort ?? "추론 미확인";
  const roleLabel = role.kind === "known" ? role.label : "역할 미확인";
  return (
    <button
      type="button"
      role="listitem"
      onClick={onSelect}
      data-identity={record.identity}
      title={`${name}\n${meta.model ?? "모델 미확인"} · ${effortLabel}\n${presentation.title}${presentation.stage ? `\n현재 단계: ${presentation.stage}` : ""}`}
      aria-label={`${roleLabel} ${name}, 업무 ${presentation.title}${presentation.stage ? `, 현재 단계 ${presentation.stage}` : ""}, ${snapshot ? snapshot.status : (archived?.status ?? "미확인")}, 모델 ${meta.model ?? "미확인"}, 추론 ${effortLabel}`}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "4px 8px", width: "100%", marginBottom: 8, padding: 12, border: "1px solid var(--seed-color-stroke-neutral-weak)", borderRadius: "var(--seed-radius-r2)", background: "var(--seed-color-bg-layer-default)", color: "var(--seed-color-fg-neutral)", cursor: "pointer", textAlign: "left" }}
    >
      {/* 1행: 역할 + 이 실행이 맡은 일, 그리고 상태. */}
      <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {role.kind === "known"
          ? (
            <span
              className="subagent-role"
              data-role-kind="known"
              data-role={role.agent}
              title={`${role.agent} · ${ROLE_SOURCE_LABEL[role.source]}`}
            >
              <span className="sr-only">역할 </span>{role.label}
            </span>
          )
          : (
            <span className="subagent-role" data-role-kind="unknown" title="역할 정보가 없는 기록입니다.">역할 미확인</span>
          )}
        <span className="subagent-task-line" style={{ minWidth: 0 }}>{presentation.title}</span>
      </span>
      {snapshot
        ? <span style={{ color: statusColor(snapshot), fontSize: "var(--seed-font-size-t2-static)", fontVariantNumeric: "tabular-nums" }}>{snapshot.status}</span>
        : archived
          ? (
            <span style={{ color: archived.status === "failed" ? "var(--danger)" : archived.status === "aborted" ? "var(--warning)" : "var(--seed-color-fg-neutral-subtle)", fontSize: "var(--seed-font-size-t2-static)", fontVariantNumeric: "tabular-nums" }}>
              {archived.status ?? "미확인"}
            </span>
          )
          : <span aria-hidden="true" />}
      {presentation.stage && (
        <span
          className="subagent-stage-line"
          title={`현재 단계: ${presentation.stage}`}
          style={{ gridColumn: "1 / -1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--seed-color-fg-neutral-subtle)", fontSize: "var(--seed-font-size-t2-static)" }}
        >
          <span style={{ fontWeight: 600 }}>현재 단계</span>
          {" · "}
          {presentation.stage}
        </span>
      )}
      {/* 3행: 같은 실행의 실제 모델과 유효 추론 강도. */}
      <span
        className="subagent-model-line"
        data-observed={meta.model ? (meta.effort ? "both" : "model") : (meta.effort ? "effort" : "none")}
        aria-hidden="true"
        style={{ gridColumn: "1 / -1" }}
      >
        {modelLabel}
        {meta.modelIsFallback && <span className="subagent-effort"> (대체 모델)</span>}
        <span className="subagent-effort"> · {effortLabel}</span>
      </span>
      {/* 하위 detail: 기술적 식별자와 기록 출처. */}
      <span style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: "4px 8px", minWidth: 0, color: "var(--seed-color-fg-neutral-subtle)", fontFamily: "var(--font-mono)", fontSize: "var(--seed-font-size-t1-static)" }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <span>{source}</span>
      </span>
      <span style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: "4px 10px", color: "var(--seed-color-fg-neutral-subtle)", fontFamily: "var(--font-mono)", fontSize: "var(--seed-font-size-t1-static)", fontVariantNumeric: "tabular-nums" }}>
        {snapshot?.progress && <><span>도구 {snapshot.progress.toolCount}</span><span>{snapshot.progress.tokens.toLocaleString()} Token</span><span>{formatDuration(snapshot.progress.durationMs)}</span></>}
        {archived && <><span>{archived.messages === null ? "메시지 수 미확인" : `메시지 ${archived.messages}`}</span><span>{(archived.bytes / 1024).toFixed(archived.bytes < 10_240 ? 1 : 0)} KB</span><span>{formatRelative(archived.modified)}</span></>}
      </span>
    </button>
  );
}

export function SubagentArchivePanel({
  title,
  sessionId,
  sessionPath,
  sessionCwd,
  liveSubagents,
  client,
  visible = true,
  onClose,
  onReturnFocus,
}: SubagentArchivePanelProps) {
  const resolvedClient = useMemo(() => client ?? createHanseSubagentClient(), [client]);
  const [polledLive, setPolledLive] = useState<SubagentSnapshot[]>([]);
  const [liveState, setLiveState] = useState<LoadState<SubagentSnapshot[]>>({ kind: "loading" });
  const [archiveState, setArchiveState] = useState<LoadState<SubagentArchiveRecord[]>>({ kind: "loading" });
  const [archiveTruncated, setArchiveTruncated] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    setPolledLive([]);
    setLiveState({ kind: "loading" });
    setArchiveState({ kind: "loading" });
    setArchiveTruncated(false);
    setSelectedKey(null);
  }, [sessionId]);

  useEffect(() => {
    if (!visible || !sessionId) return;
    let disposed = false;
    let inFlight = false;
    let controller: AbortController | null = null;

    const refresh = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      controller = new AbortController();
      const [liveResult, archiveResult] = await Promise.allSettled([
        resolvedClient.getLiveSnapshots(sessionId, controller.signal),
        resolvedClient.getArchive(sessionId, controller.signal),
      ]);
      if (disposed || controller.signal.aborted) return;

      if (liveResult.status === "fulfilled") {
        setPolledLive(liveResult.value.subagents);
        setLiveState(liveResult.value.subagents.length > 0
          ? { kind: "ready", data: liveResult.value.subagents }
          : { kind: "empty", data: [] });
      } else {
        const failure = transcriptError(liveResult.reason);
        setLiveState(failure.kind === "unreachable"
          ? { kind: "unreachable", message: failure.message }
          : { kind: "error", message: failure.message });
      }

      if (archiveResult.status === "fulfilled") {
        setArchiveTruncated(archiveResult.value.listTruncated === true);
        setArchiveState(archiveResult.value.subagents.length > 0
          ? { kind: "ready", data: archiveResult.value.subagents }
          : { kind: "empty", data: [] });
      } else {
        const failure = transcriptError(archiveResult.reason);
        setArchiveState(failure.kind === "unreachable"
          ? { kind: "unreachable", message: failure.message }
          : { kind: "error", message: failure.message });
      }
      inFlight = false;
    };

    void refresh();
    const timer = setInterval(() => void refresh(), SUBAGENT_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshVersion, resolvedClient, sessionId, visible]);

  const effectiveLive = useMemo(() => mergeLiveSnapshots(liveSubagents, polledLive), [liveSubagents, polledLive]);
  const archive = archiveState.kind === "ready" || archiveState.kind === "empty" ? archiveState.data : [];
  const records = useMemo(() => mergeSubagentRecords(effectiveLive, archive), [archive, effectiveLive]);
  const selected = selectedKey ? records.find((record) => record.key === selectedKey) ?? null : null;

  useEffect(() => {
    if (selectedKey && !selected) setSelectedKey(null);
  }, [selected, selectedKey]);

  const closePanel = () => {
    onClose?.();
    onReturnFocus?.();
  };

  if (selected && sessionId) {
    return (
      <SubagentDetail
        sessionId={sessionId}
        sessionCwd={sessionCwd}
        record={selected}
        client={resolvedClient}
        visible={visible}
        onBack={() => setSelectedKey(null)}
      />
    );
  }

  const initialLoading = records.length === 0 && liveState.kind === "loading" && archiveState.kind === "loading";
  const empty = records.length === 0
    && (liveState.kind === "empty" || liveSubagents.length === 0)
    && archiveState.kind === "empty";

  return (
    <section aria-label="Subagent 기록" data-state={initialLoading ? "loading" : empty ? "empty" : "ready"} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--bg-panel)", color: "var(--text)" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 42, padding: "6px 10px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 10, fontWeight: 750, letterSpacing: "0.08em", textTransform: "uppercase" }}>{title}</div>
          <div title={sessionPath ?? undefined} style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{sessionId?.slice(0, 8) || "세션 없음"}</div>
        </div>
        <button type="button" onClick={() => setRefreshVersion((version) => version + 1)} aria-label="Subagent 기록 새로고침" title="새로고침" style={panelButtonStyle()}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 5V2m0 0h-3m3 0-2.1 2.1A5.5 5.5 0 1 0 13.3 9" /></svg>
        </button>
        {onClose && <button type="button" onClick={closePanel} aria-label="Subagent 기록 닫기" title="닫기" style={panelButtonStyle()}><svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg></button>}
      </header>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "9px 10px 16px" }}>
        {!sessionId ? (
          <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5 }}>세션을 선택한 뒤 다시 시도하세요.</div>
        ) : initialLoading ? (
          <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5 }}>Subagent 기록 불러오는 중…</div>
        ) : empty ? (
          <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5, lineHeight: 1.6 }}>이 세션은 아직 Subagent를 실행한 적이 없습니다.</div>
        ) : (
          <div role="list" aria-label="Subagent 실시간 및 디스크 기록">
            {records.map((record) => <SubagentRow key={record.key} record={record} onSelect={() => setSelectedKey(record.key)} />)}
          </div>
        )}

        {!initialLoading && liveState.kind === "loading" && <div role="status" style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 9.5 }}>실시간 상태 불러오는 중…</div>}
        {!initialLoading && archiveState.kind === "loading" && <div role="status" style={{ marginTop: 8, color: "var(--text-muted)", fontSize: 9.5 }}>디스크 기록 불러오는 중…</div>}
        {liveState.kind === "unreachable" && <div role="status" style={{ marginTop: 8, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", fontSize: 9.5 }}>{liveState.message}</div>}
        {liveState.kind === "error" && <div role="alert" style={{ marginTop: 8, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--danger)", fontSize: 9.5 }}>{liveState.message}</div>}
        {archiveState.kind === "unreachable" && <div role="status" style={{ marginTop: 8, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--text-muted)", fontSize: 9.5 }}>{archiveState.message}</div>}
        {archiveState.kind === "error" && <div role="alert" style={{ marginTop: 8, padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg)", color: "var(--danger)", fontSize: 9.5 }}>{archiveState.message}</div>}
        {archiveTruncated && <div role="status" style={{ marginTop: 8, color: "var(--warning)", fontSize: 9.5 }}>최근 디스크 기록 60개만 표시합니다.</div>}
      </div>
    </section>
  );
}
