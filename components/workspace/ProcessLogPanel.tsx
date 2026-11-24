"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionButton } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import { isRecoveredAssistantError, withAssistantBlocks } from "@/lib/message-display";
import type { ProcessTurnGroup } from "@/lib/transcript-plan";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";
import { MessageView } from "../MessageView";
import { ToolCallFocusContext, ToolCallRevealContext, type ToolCallFocus } from "../tool-call-reveal";
import { PanelHeader } from "./PanelHeader";
import styles from "./ProcessLogPanel.module.css";

/**
 * Everything the work log needs to render the process items the transcript
 * handed over. It is the same message data the transcript already holds - the
 * panel never fetches or re-derives a session.
 */
export interface ProcessLogData {
  groups: readonly ProcessTurnGroup[];
  messages: readonly AgentMessage[];
  entryIds: readonly string[];
  toolResults: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  cwd?: string;
  sessionId?: string;
  /** Live run state (agent phase, running command) while the turn is in flight. */
  status?: string | null;
}

export interface ProcessLogPanelProps {
  title: string;
  data: ProcessLogData | null;
  onOpenFile?: (filePath: string) => void;
  /** 채팅의 bash 카드가 보낸 이동 요청. nonce가 바뀔 때마다 그 실행을 펼치고 보이게 하고 잠시 강조한다. */
  focusRequest?: { toolCallId: string; nonce: number } | null;
}

type OutputWrapMode = "wrap" | "scroll";

const OUTPUT_WRAP_STORAGE_KEY = "omp-web:process-log-wrap";
/** 찾아온 실행을 강조해 두는 시간. */
const REVEAL_HIGHLIGHT_MS = 1600;

const outputWrapListeners = new Set<() => void>();
/** 저장소에 쓰지 못할 때도 이 창에서는 고른 값이 유지되게 한다. 다른 창이 저장소를 바꾸면 비운다. */
let selectedOutputWrap: OutputWrapMode | null = null;

function readOutputWrap(): OutputWrapMode {
  if (selectedOutputWrap) return selectedOutputWrap;
  try {
    return window.localStorage.getItem(OUTPUT_WRAP_STORAGE_KEY) === "scroll" ? "scroll" : "wrap";
  } catch {
    return "wrap";
  }
}

function subscribeOutputWrap(onChange: () => void): () => void {
  outputWrapListeners.add(onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== OUTPUT_WRAP_STORAGE_KEY) return;
    selectedOutputWrap = null;
    onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    outputWrapListeners.delete(onChange);
    window.removeEventListener("storage", onStorage);
  };
}

function writeOutputWrap(mode: OutputWrapMode): void {
  try {
    window.localStorage.setItem(OUTPUT_WRAP_STORAGE_KEY, mode);
    selectedOutputWrap = null;
  } catch {
    // 저장소를 못 쓰면 이 창에서만 고른 값을 쥐고 있는다. 다시 열면 기본값으로 돌아간다.
    selectedOutputWrap = mode;
  }
  outputWrapListeners.forEach((listener) => listener());
}

/** 그 실행 카드가 든 턴의 anchorIdx. 기록에 없으면 null. bash 직접 실행은 MessageView와 같은 합성 id를 쓴다. */
export function findProcessTurnAnchor(
  groups: readonly ProcessTurnGroup[],
  messages: readonly AgentMessage[],
  toolCallId: string,
): number | null {
  for (const group of groups) {
    for (const entry of group.entries) {
      const message = messages[entry.idx];
      if (!message) continue;
      if (message.role === "assistant") {
        const blocks = entry.blocks ?? (message as AssistantMessage).content;
        if (blocks.some((block) => block.type === "toolCall" && block.toolCallId === toolCallId)) return group.anchorIdx;
      } else if (message.role === "bashExecution" && `bash-${message.timestamp ?? ""}` === toolCallId) {
        return group.anchorIdx;
      }
    }
  }
  return null;
}

function promptSnippet(message: AgentMessage | undefined): string | null {
  if (!message || message.role !== "user") return null;
  const raw = typeof message.content === "string"
    ? message.content
    : message.content.filter((block) => block.type === "text").map((block) => block.text).join(" ");
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return null;
  return text.length > 72 ? `${text.slice(0, 72)}…` : text;
}

export function ProcessLogPanel({ title, data, onOpenFile, focusRequest }: ProcessLogPanelProps) {
  const { t } = useI18n();
  const groups = data?.groups ?? [];
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const outputWrap = useSyncExternalStore(subscribeOutputWrap, readOutputWrap, () => "wrap" as const);
  const rootRef = useRef<HTMLElement>(null);
  const [handledNonce, setHandledNonce] = useState<number | null>(null);
  const [activeFocus, setActiveFocus] = useState<ToolCallFocus | null>(null);

  // 새 이동 요청은 그리기 중에 받는다: 접힌 턴을 펴고 대상 카드를 같은 그리기에서 펼치게 한다.
  // 그 실행이 아직 기록에 없으면(기록이 채팅보다 늦게 오는 경우) 요청을 남겨 두고 들어오는 대로 처리한다.
  const pendingAnchor = focusRequest && focusRequest.nonce !== handledNonce && data
    ? findProcessTurnAnchor(groups, data.messages, focusRequest.toolCallId)
    : null;
  if (focusRequest && pendingAnchor !== null) {
    setHandledNonce(focusRequest.nonce);
    setActiveFocus(focusRequest);
    if (collapsed.has(pendingAnchor)) {
      setCollapsed((current) => {
        const next = new Set(current);
        next.delete(pendingAnchor);
        return next;
      });
    }
  }

  useEffect(() => {
    if (!activeFocus) return;
    const card = rootRef.current?.querySelector<HTMLElement>(`[data-tool-call-id="${CSS.escape(activeFocus.toolCallId)}"]`);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // 출력을 펼친 카드가 목록 높이보다 크면 가운데 맞춤이 머리줄을 위로 밀어내므로 머리줄을 맨 위에 둔다.
    const viewport = card?.closest<HTMLElement>(".process-log-body");
    const block = card && viewport && card.offsetHeight > viewport.clientHeight ? "start" : "center";
    card?.scrollIntoView({ block, behavior: reduceMotion ? "auto" : "smooth" });
    const timer = window.setTimeout(() => {
      setActiveFocus((current) => (current === activeFocus ? null : current));
    }, REVEAL_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [activeFocus]);

  return (
    <ToolCallRevealContext.Provider value={null}>
    <ToolCallFocusContext.Provider value={activeFocus}>
    <section ref={rootRef} className={`process-log ${styles.root}`} aria-label={title} data-output-wrap={outputWrap}>
      {/* 탭이 이미 이 보기의 이름이므로 머리줄에는 턴 수만 둔다. */}
      <PanelHeader
        title={`${groups.length} ${t(groups.length === 1 ? "process.turn" : "process.turns")}`}
        viewSwitch={{
          label: t("processLog.outputWrap"),
          value: outputWrap,
          options: [
            { value: "wrap", label: t("processLog.wrapLines") },
            { value: "scroll", label: t("processLog.scrollLines") },
          ],
          onChange: writeOutputWrap,
        }}
      />
      <div className="process-log-body">
        {data?.status ? (
          <p className="process-log-status" role="status">
            <span className="process-log-status-pulse" aria-hidden="true" />
            {data.status}
          </p>
        ) : null}
        {groups.length === 0 ? (
          <p className="process-log-empty">{t("process.empty")}</p>
        ) : groups.map((group, groupIndex) => {
          const isCollapsed = collapsed.has(group.anchorIdx);
          const snippet = promptSnippet(data?.messages[group.anchorIdx]);
          const parts = [`${group.messageCount} ${t(group.messageCount === 1 ? "chat.message" : "chat.messages")}`];
          if (group.toolCallCount > 0) {
            parts.push(`${group.toolCallCount} ${t(group.toolCallCount === 1 ? "chat.toolCall" : "chat.toolCalls")}`);
          }
          return (
            <article key={`turn-${group.anchorIdx}-${groupIndex}`} className="process-log-turn" data-process-turn={group.anchorIdx}>
              <ActionButton
                className="process-log-turn-toggle"
                variant="ghost"
                size="small"
                layout="withText"
                aria-expanded={!isCollapsed}
                onClick={() => setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(group.anchorIdx)) next.delete(group.anchorIdx);
                  else next.add(group.anchorIdx);
                  return next;
                })}
                title={isCollapsed ? t("chat.expandProcess") : t("chat.collapseProcess")}
              >
                <span className="process-log-turn-title">
                  {snippet ?? t("chat.processDetails")}
                </span>
                <span className="process-log-turn-meta">{parts.join(" · ")}</span>
              </ActionButton>
              {!isCollapsed && (
                <div className="process-log-entries">
                  {group.entries.map((entry, entryIndex) => {
                    const message = data?.messages[entry.idx];
                    if (!message) return null;
                    return (
                      <MessageView
                        key={`process-${group.anchorIdx}-${entryIndex}`}
                        message={entry.blocks
                          ? withAssistantBlocks(message as AssistantMessage, entry.blocks, { omitUsage: true })
                          : message}
                        toolResults={data?.toolResults}
                        modelNames={data?.modelNames}
                        cwd={data?.cwd}
                        onOpenFile={onOpenFile}
                        entryId={data?.entryIds[entry.idx]}
                        sessionId={data?.sessionId}
                        showTimestamp={false}
                        recoveredError={isRecoveredAssistantError(data?.messages ?? [], entry.idx)}
                      />
                    );
                  })}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
    </ToolCallFocusContext.Provider>
    </ToolCallRevealContext.Provider>
  );
}
