"use client";

import { useState } from "react";
import { ActionButton } from "@seed-design/react";
import { useI18n } from "@/hooks/useI18n";
import { withAssistantBlocks } from "@/lib/message-display";
import type { ProcessTurnGroup } from "@/lib/transcript-plan";
import type { AgentMessage, AssistantMessage, ToolResultMessage } from "@/lib/types";
import { MessageView } from "../MessageView";

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

export function ProcessLogPanel({ title, data, onOpenFile }: ProcessLogPanelProps) {
  const { t } = useI18n();
  const groups = data?.groups ?? [];
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());

  return (
    <section className="process-log" aria-label={title}>
      <header className="process-log-header">
        <h2>{title}</h2>
        <span className="process-log-count">
          {groups.length > 0 ? `${groups.length} ${t(groups.length === 1 ? "process.turn" : "process.turns")}` : ""}
        </span>
      </header>
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
  );
}
