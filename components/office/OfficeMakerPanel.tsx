"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MessageView } from "@/components/MessageView";
import { archiveTranscriptEntries, isActiveSubagentStatus, useSubagentTranscripts, type LiveTranscriptView, type SubagentTranscriptState } from "@/hooks/useSubagentTranscripts";
import { createHanseSubagentClient, type HanseSubagentClient } from "@/lib/hanse-subagent-client";
import { observeMakerAccount, type OfficeMainParticipant, type OfficeMakerAccount, type OfficeMakerParticipant } from "@/lib/office/office-roster";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import type { AgentMessage, ToolResultMessage } from "@/lib/types";
import { getFileName } from "@/lib/file-paths";
import { OfficeFace, useParticipantPresentation } from "./OfficeFloor";
import { useOfficeText } from "./i18n";
import styles from "./office.module.css";

type OfficeTab = "transcript" | "files";

const NO_ENTRIES: readonly LiveTranscriptView[] = [];
const LOADING: SubagentTranscriptState = { kind: "loading" };

export interface OfficeMakerPanelProps {
  participant: OfficeMakerParticipant;
  sessionId: string | null;
  cwd?: string;
  /** 입력창이 실제로 보내는 곳(Main). 이 패널은 받는 사람을 바꾸지 않는다. */
  recipient: OfficeMainParticipant;
  onBackToMain: () => void;
  onOpenFile: (filePath: string) => void;
  /** 이 기록에서 본 계정 근거를 자리 배정에 돌려준다. 대응을 위해 따로 읽지 않는다. */
  onAccountObserved: (makerId: string, account: OfficeMakerAccount) => void;
  client?: HanseSubagentClient;
}

/**
 * 오피스에서 고른 Maker 의 대화 기록과 쓴 파일. 대화창의 기록 자리만 대신하고(입력창은 그대로
 * Main 대화에 남는다), 기록 읽기는 서브에이전트 패널과 같은 `useSubagentTranscripts` 하나가 맡는다.
 * 쓴 파일은 결과가 도착한 write·edit 호출만 센다 — 본문에 적힌 경로는 근거가 아니다.
 */
export function OfficeMakerPanel({
  participant,
  sessionId,
  cwd,
  recipient,
  onBackToMain,
  onOpenFile,
  onAccountObserved,
  client,
}: OfficeMakerPanelProps) {
  const { ot } = useOfficeText();
  const present = useParticipantPresentation();
  const presentation = present(participant);
  const resolvedClient = useMemo(() => client ?? createHanseSubagentClient(), [client]);
  const { snapshot } = participant;
  const targets = useMemo(
    () => [{ key: participant.key, liveId: snapshot.id, status: snapshot.status }],
    [participant.key, snapshot.id, snapshot.status],
  );
  const read = useSubagentTranscripts(targets, {
    sessionId: sessionId ?? "",
    client: resolvedClient,
    enabled: Boolean(sessionId),
  }).get(participant.key);
  const state = read?.state ?? LOADING;
  const archived = state.kind === "ready-archive";
  const liveEntries = read?.entries ?? NO_ENTRIES;
  const entries = useMemo(
    () => (state.kind === "ready-live" ? state.entries : state.kind === "ready-archive" ? archiveTranscriptEntries(state.entries) : liveEntries),
    [liveEntries, state],
  );

  const messages = useMemo(
    () => entries.flatMap((entry): AgentMessage[] => ("message" in entry ? [entry.message] : [])),
    [entries],
  );
  const toolResults = useMemo(() => {
    const results = new Map<string, ToolResultMessage>();
    for (const message of messages) if (message.role === "toolResult") results.set(message.toolCallId, message);
    return results;
  }, [messages]);
  const writtenFiles = useMemo(() => {
    const seen = new Set<string>();
    const files: WrittenFile[] = [];
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const file of extractTurnWrittenFiles(message.content, toolResults, cwd)) {
        if (seen.has(file.filePath)) continue;
        seen.add(file.filePath);
        files.push(file);
      }
    }
    return files;
  }, [cwd, messages, toolResults]);

  const hasAssistant = messages.some((message) => message.role === "assistant");
  useEffect(() => {
    if (hasAssistant) onAccountObserved(snapshot.id, observeMakerAccount(snapshot, messages));
  }, [hasAssistant, messages, onAccountObserved, snapshot]);

  const [tab, setTab] = useState<OfficeTab>("transcript");
  const tabsId = useId();
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (tab !== "transcript") return;
    const frame = requestAnimationFrame(() => {
      const transcript = transcriptRef.current;
      if (transcript) transcript.scrollTop = transcript.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length, tab]);

  const tabs: readonly OfficeTab[] = ["transcript", "files"];
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + 1) % tabs.length];
    setTab(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  };

  const step = isActiveSubagentStatus(participant.status) ? snapshot.progress?.lastIntent?.trim() || null : null;
  const roleLabel = participant.agent ? `${ot("office.maker")} · ${participant.agent}` : ot("office.maker");

  return (
    <section className={styles.maker} aria-label={ot("office.makerRecord", { name: participant.name })}>
      <header className={styles.makerHeader}>
        <OfficeFace seat={participant.seat} size={32} />
        <div className={styles.makerIdentity}>
          <h2 className={styles.makerName}>{participant.name}</h2>
          <p className={styles.makerMeta}>
            <span>{roleLabel}</span>
            <span className={styles.mono}>{participant.model ?? ot("office.modelUnknown")}</span>
          </p>
        </div>
        <span className={styles.status} data-tone={presentation.tone}>
          <span className={styles.dot} aria-hidden="true" />
          {presentation.status}
        </span>
      </header>
      {(step || participant.status === "completed") && (
        <p className={styles.makerNote}>
          {step ? `${ot("office.currentStep")} · ${step}` : ot("office.notAccepted")}
        </p>
      )}
      <div className={styles.tabs} role="tablist" aria-label={participant.name}>
        {tabs.map((value) => (
          <button
            key={value}
            id={`${tabsId}-${value}-tab`}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={tab === value}
            aria-controls={`${tabsId}-${value}-panel`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={onTabKeyDown}
          >
            {value === "transcript" ? ot("office.tabTranscript") : ot("office.tabFiles", { count: archived ? "?" : writtenFiles.length })}
          </button>
        ))}
      </div>
      <div
        ref={transcriptRef}
        id={`${tabsId}-${tab}-panel`}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${tab}-tab`}
        className={styles.makerBody}
      >
        {tab === "transcript" ? (
          <>
            {state.kind === "loading" && <p role="status" className={styles.bodyNote}>{ot("office.loading")}</p>}
            {state.kind === "unreachable" && <p role="status" className={styles.bodyNote}>{state.message}</p>}
            {state.kind === "error" && <p role="alert" className={styles.bodyNote} data-tone="failed">{state.message}</p>}
            {state.kind === "empty" && <p role="status" className={styles.bodyNote}>{state.note ?? ot("office.transcriptEmpty")}</p>}
            {archived && <p role="status" className={styles.bodyNote}>{state.note ?? ot("office.archiveNote")}</p>}
            {state.kind === "ready-live" && messages.map((message, index) => (
              <MessageView
                key={`${index}:${message.timestamp ?? 0}`}
                message={message}
                toolResults={toolResults}
                cwd={cwd}
                onOpenFile={onOpenFile}
                showTimestamp
                prevTimestamp={messages[index - 1]?.timestamp}
              />
            ))}
            {archived && state.entries.map((entry, index) => (
              <div key={`${entry.at ?? 0}:${index}`} className={styles.archiveEntry}>
                <span className={styles.archiveRole}>{entry.role} · {entry.kind}</span>
                {entry.text || ot("office.transcriptEmpty")}
              </div>
            ))}
          </>
        ) : archived ? (
          <p className={styles.bodyNote}>{ot("office.filesArchive")}</p>
        ) : writtenFiles.length === 0 ? (
          <p className={styles.bodyNote}>{ot("office.filesEmpty")}</p>
        ) : (
          <ul className={styles.files}>
            {writtenFiles.map((file) => (
              <li key={file.filePath}>
                <button type="button" className={styles.file} onClick={() => onOpenFile(file.filePath)} title={file.filePath}>
                  <span className={styles.fileName}>{getFileName(file.filePath)}</span>
                  <span className={styles.filePath}>{file.filePath}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <footer className={styles.makerFooter}>
        <p className={styles.composerNote}>{ot("office.composerNote", { name: present(recipient).name })}</p>
        <button type="button" className={styles.backButton} onClick={onBackToMain}>{ot("office.backToMain")}</button>
      </footer>
    </section>
  );
}
