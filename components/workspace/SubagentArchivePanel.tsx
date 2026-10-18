"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  type LiveTranscriptView,
  type SubagentTranscriptState,
} from "@/hooks/useSubagentTranscripts";
import { useI18n } from "@/hooks/useI18n";
import type { CheckState, TurnSummary } from "@/lib/answer-status/turn-summary";
import { useAnswerStatusText } from "@/components/answer-status/i18n";
import type { MakerSelection } from "@/components/answer-status/AnswerStatusContext";
import { MakerStatusPair, summarizeMakerRun } from "@/components/answer-status/DispatchCard";
import {
  SubagentLiveEta,
  SubagentPhaseSteps,
  todoText,
  useSubagentProgress,
  type SubagentProgressView,
} from "@/components/answer-status/SubagentProgress";
import { TurnWrittenFiles } from "@/components/TurnWrittenFiles";
import { PanelHeader } from "./PanelHeader";

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
  /** 덱에 열린 Maker. `onSelectionChange`와 함께 주면 선택을 셸이 든다. 없으면 패널이 스스로 든다. */
  selection?: MakerSelection | null;
  onSelectionChange?: (selection: MakerSelection | null) => void;
  /** 발주 카드에서 연 상세에서 뒤로 갈 때. 셸이 그 카드 행으로 초점을 돌려보낸다. */
  onReturnToOrigin?: (origin: string) => void;
  /** 상세의 변경 파일을 미리보기로 연다. */
  onOpenFile?: (filePath: string) => void;
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

const REFRESH_ICON = (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M13 5V2m0 0h-3m3 0-2.1 2.1A5.5 5.5 0 1 0 13.3 9" /></svg>
);

const EMPTY_LIVE_ENTRIES: readonly LiveTranscriptView[] = [];

/** 상세 위쪽의 결과 칸: 그 실행이 쓴 파일과 실행한 검사, 판정 사유. 실시간 기록에서만 셀 수 있다. */
function MakerOutcome({ state, summary, reason, onOpenFile }: {
  state: SubagentTranscriptState;
  summary: TurnSummary | null;
  reason: string | null;
  onOpenFile?: (filePath: string) => void;
}) {
  const { st } = useAnswerStatusText();
  const { t } = useI18n();
  const archived = state.kind === "ready-archive" || (state.kind === "empty" && state.source === "archive");
  if (!summary && !archived) return null;
  const files = summary?.files ?? [];
  const checks = summary?.checks ?? [];
  return (
    <div className="maker-detail-outcome">
      {reason && (
        <p className="maker-detail-reason"><span>{st("detail.reason")}</span> {reason}</p>
      )}
      <section>
        <h3 className="maker-detail-heading">{st("summary.heading.files")}</h3>
        {archived
          ? <p className="maker-detail-empty">{t("makerDetail.archiveUnobserved")}</p>
          : files.length > 0
            ? <TurnWrittenFiles files={files} onOpenFile={onOpenFile} />
            : <p className="maker-detail-empty">{t("makerDetail.noFiles")}</p>}
      </section>
      <section>
        <h3 className="maker-detail-heading">{st("summary.heading.checks")}</h3>
        {archived
          ? <p className="maker-detail-empty">{t("makerDetail.archiveUnobserved")}</p>
          : checks.length > 0
            ? (
              <ul className="answer-summary-list">
                {checks.map((check) => (
                  <li key={check.toolCallId} className="answer-check" data-state={check.state}>
                    <code className="answer-check-command" title={check.command}>{check.command}</code>
                    <span className="answer-check-result">
                      {t(CHECK_STATE_LABEL[check.state])}
                      {check.exitCode !== null ? ` · ${st("summary.check.exit", { code: check.exitCode })}` : null}
                    </span>
                  </li>
                ))}
              </ul>
            )
            : <p className="maker-detail-empty">{t("makerDetail.noChecks")}</p>}
      </section>
    </div>
  );
}

const CHECK_STATE_LABEL: Record<CheckState, "makerDetail.checkPassed" | "makerDetail.checkFailed" | "makerDetail.checkUnobserved"> = {
  passed: "makerDetail.checkPassed",
  failed: "makerDetail.checkFailed",
  unobserved: "makerDetail.checkUnobserved",
};

function SubagentDetail({
  sessionId,
  sessionCwd,
  record,
  selection,
  client,
  visible,
  onBack,
  onOpenFile,
}: {
  sessionId: string;
  sessionCwd?: string;
  /** null이면 이 선택과 정확히 맞는 실행 기록이 없다(이름이 같은 다른 실행으로 대신하지 않는다). */
  record: MergedSubagentRecord | null;
  selection: MakerSelection;
  client: HanseSubagentClient;
  visible: boolean;
  onBack: () => void;
  onOpenFile?: (filePath: string) => void;
}) {
  const { st } = useAnswerStatusText();
  const { t } = useI18n();
  // 기록 읽기는 대화창과 같은 훅 하나가 맡는다. 패널은 대상 하나만 넘긴다.
  const recordKey = record?.key;
  const liveId = record?.live?.id;
  const liveStatus = record?.live?.status;
  const archiveName = record?.archive?.name;
  const targets = useMemo(
    () => (recordKey ? [{ key: recordKey, liveId, status: liveStatus, archiveName }] : []),
    [recordKey, liveId, liveStatus, archiveName],
  );
  const transcriptRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const reads = useSubagentTranscripts(targets, { sessionId, client, enabled: visible && targets.length > 0 });
  const state = (recordKey ? reads.get(recordKey)?.state : undefined) ?? LOADING_TRANSCRIPT;

  // 상세가 열리면 제목으로 초점을 옮긴다. 뒤로 가기는 바로 앞(Shift+Tab)에 있다.
  useEffect(() => {
    if (visible) titleRef.current?.focus({ preventScroll: true });
  }, [selection.key, visible]);

  useEffect(() => {
    if (!visible || (state.kind !== "ready-live" && state.kind !== "ready-archive")) return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [state, visible]);

  const liveEntries = state.kind === "ready-live" ? state.entries : EMPTY_LIVE_ENTRIES;
  const toolResults = useMemo(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const entry of liveEntries) {
      // irc 수신 경계는 메시지가 아니라 발화 위치를 가르는 표식이라 렌더하지 않는다.
      if (!("message" in entry)) continue;
      if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
    }
    return results;
  }, [liveEntries]);
  const summary = useMemo(
    () => (state.kind === "ready-live" ? summarizeMakerRun(state.entries, sessionCwd) : null),
    [state, sessionCwd],
  );

  const name = record?.live?.id || record?.archive?.name || "Subagent";
  const title = record ? resolveSubagentTaskPresentation(record).title : name;
  const status = selection.status;
  return (
    <div role="region" aria-label={t("makerDetail.region", { title: name })} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0 }}>
      <PanelHeader
        back={{ label: t("subagents.back"), onClick: onBack }}
        title={title}
        titleTooltip={record ? `${title}\n${name} · ${identityLabel(record)}` : undefined}
        titleRef={titleRef}
        subtitle={record ? `${name} · ${identityLabel(record)}` : undefined}
        state={status
          ? <MakerStatusPair maker={status} st={st} />
          : record?.live && <span style={{ color: statusColor(record.live), fontFamily: "var(--font-mono)", fontSize: 11 }}>{record.live.status}</span>}
      />
      {!record && (
        <div role="status" className="maker-detail-empty" style={{ padding: 24, textAlign: "center" }}>{t("makerDetail.unavailable")}</div>
      )}
      {record && <MakerOutcome state={state} summary={summary} reason={status?.verdict?.reason ?? null} onOpenFile={onOpenFile} />}

      {record && <div ref={transcriptRef} style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "10px 12px 18px" }}>
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
      </div>}
    </div>
  );
}

function SubagentRow({ record, view, onSelect }: { record: MergedSubagentRecord; view?: SubagentProgressView; onSelect: () => void }) {
  const { st } = useAnswerStatusText();
  const etaId = useId();
  const snapshot = record.live;
  const archived = record.archive;
  const presentation = resolveSubagentTaskPresentation(record);
  // 끝난 실행의 스냅샷은 마지막 의도·도구를 그대로 들고 있다. 그건 지금 단계가 아니다.
  const active = Boolean(snapshot && isActiveSubagentStatus(snapshot.status));
  const stage = active ? presentation.stage : null;
  const live = active && view ? view : null;
  const phaseLabel = live?.phase ? st("phase.current", { phase: st(`phase.${live.phase}`) }) : "";
  const todoLabel = live?.todo ? todoText(st, live.todo) : "";
  const name = snapshot?.id || archived?.name || "Subagent";
  const source = identityLabel(record);
  const role = resolveSubagentRole(record);
  // 기록된 값만 표시한다. 미관측은 추정하지 않고 그대로 미확인이라고 쓴다.
  const meta = resolveSubagentModelMeta(record);
  const modelLabel = meta.modelShort ?? "모델 미확인";
  const effortLabel = meta.effort ?? "추론 미확인";
  const roleLabel = role.kind === "known" ? role.label : "역할 미확인";
  return (
    <div role="listitem">
    <button
      type="button"
      onClick={onSelect}
      data-identity={record.identity}
      data-subagent-key={record.key}
      title={`${name}\n${meta.model ?? "모델 미확인"} · ${effortLabel}\n${presentation.title}${stage ? `\n현재 단계: ${stage}` : ""}${phaseLabel ? `\n${phaseLabel}` : ""}${todoLabel ? `\n${todoLabel}` : ""}`}
      aria-label={`${roleLabel} ${name}, 업무 ${presentation.title}${stage ? `, 현재 단계 ${stage}` : ""}${phaseLabel ? `, ${phaseLabel}` : ""}${todoLabel ? `, ${todoLabel}` : ""}, ${snapshot ? snapshot.status : (archived?.status ?? "미확인")}, 모델 ${meta.model ?? "미확인"}, 추론 ${effortLabel}`}
      aria-describedby={live && snapshot ? etaId : undefined}
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
      {stage && (
        <span
          className="subagent-stage-line"
          title={`현재 단계: ${stage}`}
          style={{ gridColumn: "1 / -1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--seed-color-fg-neutral-subtle)", fontSize: "var(--seed-font-size-t2-static)" }}
        >
          <span style={{ fontWeight: 600 }}>현재 단계</span>
          {" · "}
          {stage}
        </span>
      )}
      {/* 실행 중일 때만: 도구 흐름으로 읽은 단계(todo는 있으면 덧붙임)와, 흐르는 경과·남은 시간. */}
      {live?.phase && (
        <span
          className="subagent-phase-line"
          style={{ gridColumn: "1 / -1", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--seed-font-size-t2-static)", fontVariantNumeric: "tabular-nums" }}
        >
          <SubagentPhaseSteps phase={live.phase} />
          {todoLabel && <span style={{ color: "var(--seed-color-fg-neutral-subtle)" }} title={todoLabel}>{` · ${todoLabel}`}</span>}
        </span>
      )}
      {live && snapshot && (
        <span
          className="subagent-eta-line"
          style={{ gridColumn: "1 / -1", minWidth: 0, color: "var(--seed-color-fg-neutral)", fontSize: "var(--seed-font-size-t2-static)", fontVariantNumeric: "tabular-nums" }}
        >
          <SubagentLiveEta snapshot={snapshot} view={live} id={etaId} />
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
    </div>
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
  selection: controlledSelection,
  onSelectionChange,
  onReturnToOrigin,
  onOpenFile,
}: SubagentArchivePanelProps) {
  const { t } = useI18n();
  const resolvedClient = useMemo(() => client ?? createHanseSubagentClient(), [client]);
  const [polledLive, setPolledLive] = useState<SubagentSnapshot[]>([]);
  const [liveState, setLiveState] = useState<LoadState<SubagentSnapshot[]>>({ kind: "loading" });
  const [archiveState, setArchiveState] = useState<LoadState<SubagentArchiveRecord[]>>({ kind: "loading" });
  const [archiveTruncated, setArchiveTruncated] = useState(false);
  // 셸이 선택을 들면(발주 카드에서 바로 열기) 그 값을 따르고, 아니면 패널이 스스로 든다.
  const [ownSelection, setOwnSelection] = useState<MakerSelection | null>(null);
  const selection = onSelectionChange ? controlledSelection ?? null : ownSelection;
  const select = onSelectionChange ?? setOwnSelection;
  const [refreshVersion, setRefreshVersion] = useState(0);
  const listRef = useRef<HTMLElement>(null);
  // 목록에서 연 상세에서 돌아오면 그 행 버튼으로 초점을 돌려준다.
  const returnRowRef = useRef<string | null>(null);

  useEffect(() => {
    setPolledLive([]);
    setLiveState({ kind: "loading" });
    setArchiveState({ kind: "loading" });
    setArchiveTruncated(false);
    setOwnSelection(null);
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
  const found = selection ? records.find((record) => record.key === selection.key) ?? null : null;
  // 발주 카드에서 연 선택은 그 task 호출이 띄운 실행일 때만 보인다. 이름이 같은 다른 실행으로 바꿔 보이지 않는다.
  const selected = found && selection?.toolCallId && found.live?.parentToolCallId !== selection.toolCallId ? null : found;
  const progressViews = useSubagentProgress({ sessionId, snapshots: effectiveLive, client: resolvedClient, enabled: visible && !selection });

  useEffect(() => {
    const key = returnRowRef.current;
    if (selection || !key) return;
    returnRowRef.current = null;
    const row = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-subagent-key]") ?? [])]
      .find((element) => element.dataset.subagentKey === key);
    row?.focus({ preventScroll: false });
  });

  const closePanel = () => {
    onClose?.();
    onReturnFocus?.();
  };

  if (selection && sessionId) {
    return (
      <SubagentDetail
        sessionId={sessionId}
        sessionCwd={sessionCwd}
        record={selected}
        selection={selection}
        client={resolvedClient}
        visible={visible}
        onOpenFile={onOpenFile}
        onBack={() => {
          select(null);
          if (selection.origin && onReturnToOrigin) onReturnToOrigin(selection.origin);
          else returnRowRef.current = selection.key;
        }}
      />
    );
  }

  const initialLoading = records.length === 0 && liveState.kind === "loading" && archiveState.kind === "loading";
  const empty = records.length === 0
    && (liveState.kind === "empty" || liveSubagents.length === 0)
    && archiveState.kind === "empty";

  return (
    <section ref={listRef} aria-label="Subagent 기록" data-state={initialLoading ? "loading" : empty ? "empty" : "ready"} style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", minWidth: 0, minHeight: 0, overflow: "hidden", background: "var(--bg-panel)", color: "var(--text)" }}>
      <PanelHeader
        title={title}
        titleTooltip={sessionPath ?? undefined}
        subtitle={initialLoading || !sessionId ? undefined : t("panel.subagentsCount", { count: records.length })}
        actions={[{ id: "refresh", label: t("panel.refresh"), icon: REFRESH_ICON, onClick: () => setRefreshVersion((version) => version + 1) }]}
        close={onClose ? { label: t("panel.close"), onClick: closePanel } : undefined}
      />

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "9px 10px 16px" }}>
        {!sessionId ? (
          <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5 }}>세션을 선택한 뒤 다시 시도하세요.</div>
        ) : initialLoading ? (
          <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5 }}>Subagent 기록 불러오는 중…</div>
        ) : empty ? (
          <div role="status" style={{ padding: 24, color: "var(--text-muted)", textAlign: "center", fontSize: 10.5, lineHeight: 1.6 }}>이 세션은 아직 Subagent를 실행한 적이 없습니다.</div>
        ) : (
          <div role="list" aria-label="Subagent 실시간 및 디스크 기록">
            {records.map((record) => <SubagentRow key={record.key} record={record} view={record.live ? progressViews.get(record.live.id) : undefined} onSelect={() => select({ key: record.key })} />)}
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
