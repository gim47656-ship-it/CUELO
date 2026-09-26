"use client";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  BashExecutionMessage,
  BlockingExtensionUiRequest,
  ExtensionUiRequest,
  SessionInfo,
  SessionTreeNode,
  SubagentSnapshot,
  ToolResultMessage,
  UserMessage,
} from "@/lib/types";
import { normalizeCustomPanelLines, parseAnsiLine } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, splitAssistantBlockRuns, withAssistantBlocks, type DisplayOptions } from "@/lib/message-display";
import { buildTranscriptRenderPlan, isGroupAnchor, partitionTranscriptPlan } from "@/lib/transcript-plan";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { selectCurrentTodo } from "@/lib/todo-state";
import { MessageView } from "./MessageView";
import { InlineTurnThreads, InlineUtterancesProvider } from "./workspace/InlineUtteranceThread";
import { useInlineUtterances } from "@/hooks/useInlineUtterances";
import { resolveAccountFace, useAccountFace } from "@/hooks/useAccountFaces";
import { MAIN_PRESETS, loadSessionAccount } from "@/lib/hanse-resource-client";
import {
  buildInlineTurns,
  collectCharacterSummons,
  collectPeerSends,
  collectTaskToolCallIds,
  type InlineUtteranceContext,
} from "@/lib/inline-utterance";
import type { ProcessLogData } from "./workspace/ProcessLogPanel";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { ExtensionStatusBar } from "./ExtensionStatusBar";
import { TodoStrip } from "./TodoStrip";
import { OmpWordmark } from "./OmpWordmark";
import { useI18n } from "@/hooks/useI18n";
import {
  useAgentSession,
  type AgentCompletionResult,
  type AgentPhase,
  type ExtensionResponseState,
  type NoticeItem,
  type SessionData,
} from "@/hooks/useAgentSession";
import { useSyncedDisplaySettings } from "@/hooks/useDisplaySettings";
import { formatTokenCount } from "@/lib/format-tokens";
import { useDragDrop } from "@/hooks/useDragDrop";
import type { GoalStatusInfo, SessionStatsInfo } from "@/lib/omp-types";
import {
  captureScrollDistance,
  getNextVisibleCount,
  getVisibleRenderWindow,
  restoreScrollTop,
  VISIBLE_PAGE_SIZE,
} from "@/lib/chat-lazy-load";
import { parseDocumentPrompt } from "@/lib/document-attachments";
import {
  captureCueAnchor,
  cueForOutcome,
  cueTagForDialog,
  newConsultReplyEntryIds,
  resolveCueAnchor,
  type CueAnchorCapture,
  type CueAnchorIntent,
  type CuePresentation,
  type CueTag,
} from "@/lib/completion-audio";
import { CueBubble } from "./CueBubble";

interface Props {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  initialSessionData?: SessionData | null;
  transitioning?: boolean;
  onAgentEnd?: (completion: AgentCompletionResult) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string) => void;
  onSubagentsChange?: (subagents: SubagentSnapshot[]) => void;
  /** Publishes the work log behind the transcript, including the run in flight. */
  onProcessLogChange?: (data: ProcessLogData | null) => void;
  /** Replaces only the scrollable transcript; the composer remains mounted and visible. */
  transcriptReplacement?: ReactNode;
  /** Registers a stable focus action without exposing ChatInput internals. */
  onComposerFocusChange?: (focus: (() => void) | null) => void;
  onSessionBusyChange?: (busy: boolean) => void;
  /** True only while every active tool call is the blocking top-level `wait`. */
  onWaitingChange?: (waiting: boolean) => void;
  /** True while a blocking extension dialog is waiting on the user. Mirrors `onSessionBusyChange`. */
  onAttentionChange?: (needed: boolean) => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  /** 캐릭터 큐를 재생하고 화면에 띄울 스티커·대사를 돌려준다. 음소거여도 대사는 온다.
   *  `isCurrent`가 false를 돌려주면 그 사이 트리거가 낡은 것이라 소리를 내지 않는다. */
  playCueSound?: (alias?: string | null, tag?: CueTag | null, isCurrent?: () => boolean) => Promise<CuePresentation>;
  /** 이 캐릭터의 스티커·음성을 미리 받는다. 턴이 끝난 뒤 받으면 폰에서 늦게 뜬다. */
  preloadCueSound?: (alias: string | null | undefined) => Promise<void>;
  unlockAudio?: () => void;
}

function phaseLabel(phase: AgentPhase, t: (key: string, params?: Record<string, string | number>) => string): string | null {
  if (phase?.kind === "running_tools") {
    const names = phase.tools.map((t) => t.name);
    if (names.length === 0) return t("chat.runningTool");
    if (names.length === 1) return t("chat.runningNamedTool", { name: names[0] });
    if (names.length <= 3) return t("chat.runningTools", { names: names.join(", ") });
    return t("chat.runningToolsMore", { names: names.slice(0, 2).join(", "), count: names.length - 2 });
  }
  if (phase?.kind === "waiting_model") return t("chat.waitingModel");
  if (phase?.kind === "running_command") return t("chat.runningCommand");
  return null;
}

const CHAT_COLUMN_PADDING = 16;

/** 큐를 부른 순간 — 어느 세션의 몇 번째 턴이었나. 소리·표시 직전에 아직 그대로인지 본다. */
interface CueTrigger {
  sessionId: string;
  turn: number;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  const rawText = typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
  const text = (parseDocumentPrompt(rawText)?.message ?? rawText).trim();
  return text.length > 0 ? text : null;
}



interface HistoricalTranscriptProps {
  messages: AgentMessage[];
  entryIds: string[];
  toolResultsMap: Map<string, ToolResultMessage>;
  modelNames: Record<string, string>;
  messageCwd?: string;
  onOpenFile?: Props["onOpenFile"];
  sessionBusy: boolean;
  isNew: boolean;
  isStreaming: boolean;
  /** omp's render-affecting settings, so grouping matches what MessageView draws. */
  displayOptions: DisplayOptions;
  handleFork: (entryId: string) => void;
  forkingEntryId: string | null;
  handleNavigate: (entryId: string) => void;
  handleEditContent: (message: UserMessage) => void;
  sessionId?: string;
  visibleCount: number;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Hands the settled work log behind this conversation to the process view. */
  onProcessLogChange: (data: ProcessLogData) => void;
  /** 턴마다 박힌 캐릭터 스티커. 그 턴의 마지막 메시지(entryId) 뒤에 붙는다. */
  cues: readonly LiveCue[];
  /** 새로 뜬 스티커를 보이는 자리로 끌어올지. 사용자가 위로 스크롤해 따라가기를 멈췄으면 끌지 않는다. */
  cueFollowRef: { readonly current: boolean };
}

/** 대화에 박힌 캐릭터 알림 하나. 메신저 이모티콘처럼 그 턴 뒤에 남는다. */
interface AnchoredCue {
  id: number;
  anchorEntryId: string;
  sticker: string | null;
  text: string | null;
  tag: CueTag;
}

/**
 * 화면에 뜬 큐. 붙을 메시지가 아직 기록 id를 받지 못했으면 `anchorEntryId`가 null이고,
 * 그동안은 트리거 순간의 라이브 위치(`liveIndex`)에 뜬다. 그 메시지가 기록된 것을 확인한
 * 뒤에야(`intent`) id로 확정해 저장한다 — 직전 턴이나 다음 턴 끝에 잘못 박히지 않도록.
 */
interface LiveCue extends Omit<AnchoredCue, "anchorEntryId"> {
  anchorEntryId: string | null;
  sessionId: string;
  liveIndex?: number;
  intent?: CueAnchorIntent;
}

const CUE_STORE_LIMIT = 200;
function cueStoreKey(sessionId: string): string {
  return `omp-cues:${sessionId}`;
}
function readStoredCues(sessionId: string | undefined): LiveCue[] {
  if (!sessionId || typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(cueStoreKey(sessionId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    // 스티커가 PNG에서 WebP로 바뀌기 전에 저장된 경로는 새 파일로 옮겨 붙인다.
    return raw
      .filter((c) => c && typeof c.anchorEntryId === "string")
      .map((c) => ({
        ...(typeof c.sticker === "string" ? { ...c, sticker: c.sticker.replace(/^(\/stickers\/.+)\.png$/, "$1.webp") } : c),
        sessionId,
      }));
  } catch {
    return [];
  }
}
/** 자리가 확정된 이 세션의 큐만 남긴다. 기다리는 큐는 새로고침하면 사라지는 편이 틀린 자리보다 낫다. */
function writeStoredCues(sessionId: string, cues: readonly LiveCue[]): void {
  const stored: AnchoredCue[] = [];
  for (const cue of cues) {
    if (cue.sessionId !== sessionId || cue.anchorEntryId === null) continue;
    stored.push({ id: cue.id, anchorEntryId: cue.anchorEntryId, sticker: cue.sticker, text: cue.text, tag: cue.tag });
  }
  try {
    window.localStorage.setItem(cueStoreKey(sessionId), JSON.stringify(stored.slice(-CUE_STORE_LIMIT)));
  } catch {
    // 저장 공간이 없으면 이 탭에서만 보인다.
  }
}

// Keep cumulative streaming snapshots outside this boundary so React can skip
// historical projection and JSX construction while only the live bubble changes.
const HistoricalTranscript = memo(function HistoricalTranscript({
  messages, entryIds, toolResultsMap, modelNames, messageCwd, onOpenFile,
  sessionBusy, isNew, isStreaming, displayOptions, handleFork, forkingEntryId, handleNavigate,
  handleEditContent, sessionId, visibleCount, sentinelRef, t,
  onProcessLogChange, cues, cueFollowRef,
}: HistoricalTranscriptProps) {
  // The transcript carries the conversation; thinking, tool calls and process
  // notices are handed to the process view instead of folding inline.
  const { main, process } = useMemo(
    () => partitionTranscriptPlan(
      messages,
      buildTranscriptRenderPlan(messages, { sessionBusy, isStreaming, hideThinking: displayOptions.hideThinking }),
      displayOptions,
    ),
    [messages, sessionBusy, isStreaming, displayOptions],
  );
  useEffect(() => {
    onProcessLogChange({
      groups: process,
      messages,
      entryIds,
      toolResults: toolResultsMap,
      modelNames,
      cwd: messageCwd,
      sessionId,
    });
  }, [onProcessLogChange, process, messages, entryIds, toolResultsMap, modelNames, messageCwd, sessionId]);

  // Window the lightweight ordered items, not an already-built JSX transcript.
  const { startIndex, hasMore } = getVisibleRenderWindow(main.length, visibleCount);
  const renderMessage = (idx: number, options: { keyPrefix?: string; messageOverride?: AgentMessage; showTimestamp?: boolean; writtenFiles?: WrittenFile[] } = {}): ReactNode => {
    const msg = options.messageOverride ?? messages[idx];
    const prevAssistantEntryId =
      msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
        ? entryIds[idx - 1]
        : undefined;
    const keyPrefix = options.keyPrefix ?? "message";
    let showTimestamp = false;
    if (msg.role === "assistant") {
      showTimestamp = true;
      for (let j = idx + 1; j < messages.length; j++) {
        const r = messages[j].role;
        if (r === "user") break;
        if (r === "assistant") { showTimestamp = false; break; }
      }
      // The streaming bubble owns the live timestamp.
      if (showTimestamp && isStreaming && idx === messages.length - 1) {
        showTimestamp = false;
      }
    }
    if (options.showTimestamp !== undefined) showTimestamp = options.showTimestamp;
    return (
      <MessageView
        key={`${keyPrefix}-view-${idx}`}
        message={msg}
        toolResults={toolResultsMap}
        modelNames={modelNames}
        cwd={messageCwd}
        onOpenFile={onOpenFile}
        entryId={entryIds[idx]}
        onFork={sessionBusy || isNew || (idx === 0 && msg.role === "user") ? undefined : handleFork}
        forking={forkingEntryId === entryIds[idx]}
        onNavigate={sessionBusy ? undefined : handleNavigate}
        prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
        onEditContent={handleEditContent}
        showTimestamp={showTimestamp}
        prevTimestamp={idx > 0 ? (messages[idx - 1] as AgentMessage & { timestamp?: number }).timestamp : undefined}
        sessionId={sessionId}
        writtenFiles={options.writtenFiles}
      />
    );
  };

  return (
    <>
      {hasMore && (
        <div ref={sentinelRef} className="py-3 text-center text-xs text-text-muted">
          {t("chat.loadEarlier", { count: startIndex })}
        </div>
      )}
      {main.slice(startIndex).map((item, offset) => {
        // 이 턴의 발화는 그 턴의 마지막 항목 뒤에 붙는다. 어느 항목이 턴의 끝인지는
        // 작업 로그가 턴을 묶는 자리(anchorIdx)와 같은 규칙이라 두 화면이 어긋나지 않는다.
        const turnIndex = item.kind === "message" ? item.idx : item.anchorIdx;
        const next = main[startIndex + offset + 1];
        const nextTurn = next ? (next.kind === "message" ? next.idx : next.anchorIdx) : null;
        // 이 항목부터 다음 항목 직전까지의 메시지에 묶인 스티커를 이 항목 뒤에 붙인다.
        const upper = next ? next.idx : Number.POSITIVE_INFINITY;
        const itemCues = cues.filter((cue) => {
          // 기다리는 큐는 트리거 순간의 라이브 위치에 뜬다. 같은 항목 안에 머물러 확정돼도 다시 붙지 않는다.
          const at = cue.anchorEntryId !== null
            ? entryIds.indexOf(cue.anchorEntryId)
            : Math.min(cue.liveIndex ?? -1, messages.length - 1);
          return at >= item.idx && at < upper;
        });
        const cueNodes = itemCues.map((cue) => (
          <CueBubble key={`cue-${cue.id}`} sticker={cue.sticker} text={cue.text} tag={cue.tag} followRef={cueFollowRef} />
        ));
        const thread = nextTurn === turnIndex ? null : (
          <InlineTurnThreads
            turnIndex={turnIndex}
            turnEntryId={entryIds[turnIndex]}
            sessionId={sessionId}
            cwd={messageCwd}
            onOpenFile={onOpenFile}
          />
        );
        if (item.kind === "message") {
          return (
            <Fragment key={`message-${item.idx}`}>
              {renderMessage(item.idx)}
              {thread}
              {cueNodes}
            </Fragment>
          );
        }
        // Each tool call is its own assistant entry, so the write/edit summaries
        // of this answer's own segment ride along with it.
        const writtenFiles = extractTurnWrittenFiles(item.precedingBlocks, toolResultsMap, messageCwd);
        return (
          <Fragment key={`answer-${item.idx}-${item.runIndex}`}>
            {renderMessage(item.idx, {
              keyPrefix: `answer-${item.runIndex}`,
              messageOverride: withAssistantBlocks(messages[item.idx] as AssistantMessage, item.blocks),
              writtenFiles,
            })}
            {thread}
            {cueNodes}
          </Fragment>
        );
      })}
    </>
  );
});

export function ChatWindow({ session, newSessionCwd, initialSessionData, transitioning = false, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onSubagentsChange, onProcessLogChange, onOpenFile, transcriptReplacement, onComposerFocusChange, onSessionBusyChange, onWaitingChange, onAttentionChange, soundEnabled = true, onSoundToggle, playCueSound = async () => ({ sticker: null, text: null }), preloadCueSound, unlockAudio }: Props) {
  const { t } = useI18n();

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playCueSoundRef = useRef(playCueSound);
  playCueSoundRef.current = playCueSound;
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const preloadCueSoundRef = useRef(preloadCueSound);
  preloadCueSoundRef.current = preloadCueSound;
  // 턴 종료 때 서버에 다시 물어 알아낸 캐릭터. 같은 세션의 다음 턴은 다시 묻지 않는다.
  const resolvedAliasRef = useRef<{ sessionId: string; provider: string; alias: string } | null>(null);

  // 캐릭터 큐가 화면에 내는 것 — 스티커와 그 대사. 메신저 이모티콘처럼 그 턴의 메시지 뒤에
  // 박혀 남는다. 지우지 않고 쌓으며, 자리가 확정된 큐는 새로고침해도 세션별로 다시 붙는다.
  const [cues, setCues] = useState<LiveCue[]>([]);
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const cueIdRef = useRef(0);
  // 트리거 순간 화면의 메시지·기록 id와 세션. useAgentSession보다 먼저 선언돼야 하므로 아래에서 채운다.
  const cueMessagesRef = useRef<readonly AgentMessage[]>([]);
  const cueEntryIdsRef = useRef<readonly string[]>([]);
  const agentSessionIdRef = useRef<{ readonly current: string | null } | null>(null);
  // 턴 번호. 실행이 시작될 때와 끝날 때 오른다 — 끝난 턴의 늦은 큐와 다음 턴의 큐를 가른다.
  const cueTurnRef = useRef(0);
  // 착수(`working`)는 한 턴에 한 번이고, 같은 턴에 사용자를 부르는 알림이 먼저 났으면 생략한다.
  const workingCueTurnRef = useRef(-1);
  const priorityCueTurnRef = useRef(-1);

  const currentCueTrigger = useCallback((): CueTrigger | null => {
    const sessionId = agentSessionIdRef.current?.current;
    return sessionId ? { sessionId, turn: cueTurnRef.current } : null;
  }, []);
  const isCueTriggerCurrent = useCallback(
    (trigger: CueTrigger) => agentSessionIdRef.current?.current === trigger.sessionId && cueTurnRef.current === trigger.turn,
    [],
  );

  const showCue = useCallback((presentation: CuePresentation, tag: CueTag, trigger: CueTrigger, capture: CueAnchorCapture) => {
    if (!presentation.sticker && !presentation.text) return;
    cueIdRef.current = Math.max(cueIdRef.current + 1, Date.now());
    const base = { id: cueIdRef.current, sticker: presentation.sticker, text: presentation.text, tag, sessionId: trigger.sessionId };
    const cue: LiveCue = capture.kind === "entry"
      ? { ...base, anchorEntryId: capture.entryId }
      : { ...base, anchorEntryId: null, liveIndex: capture.liveIndex, intent: capture.intent };
    setCues((current) => {
      const next = [...current, cue];
      if (cue.anchorEntryId !== null) writeStoredCues(trigger.sessionId, next);
      return next;
    });
  }, []);

  // 음소거는 재생만 막는다. 소리를 끈 사용자야말로 화면에서 읽어야 하므로 큐 자체는 낸다.
  // `tag`가 null이면 무슨 일인지 단정하지 못한 중립음이라 화면에 띄울 것도 없다.
  const playCue = useCallback((alias: string | null, tag: CueTag | null, trigger: CueTrigger, capture: CueAnchorCapture | null) => {
    // 착수 큐는 같은 턴에 사용자를 부르는 알림이 이미 났으면 낡은 것이다. 캐릭터를 늦게 알아낸
    // 착수 큐가 재생 중인 승인·선택 음성을 끊거나 그 뒤에 「시작」을 붙이지 않도록, 소리를 내기
    // 전과 재개·디코딩 뒤 모두 같은 검사를 한다.
    const isCurrent = () => isCueTriggerCurrent(trigger)
      && !(tag === "working" && priorityCueTurnRef.current === trigger.turn);
    if (!isCurrent()) return;
    void playCueSoundRef.current(alias, tag, isCurrent)
      .then((presentation) => {
        if (tag === null || capture === null || !isCurrent()) return;
        showCue(presentation, tag, trigger, capture);
      })
      .catch(() => {});
  }, [isCueTriggerCurrent, showCue]);

  /**
   * 큐를 낼 캐릭터. 메시지의 계정·세션 pin·예약 provider로 바로 모르면 세션이 살아 있는 지금
   * 서버에 한 번 더 묻는다 — 이전부터 있던 세션은 화면을 열 때 idle이라 pin을 못 받은 채로 남는다.
   */
  const resolveCueAlias = useCallback(async (sessionId: string, provider: string | undefined, credentialId: number | undefined): Promise<string | null> => {
    const face = resolveAccountFace(sessionId, provider, credentialId);
    if (face || !provider) return face?.alias ?? null;
    const known = resolvedAliasRef.current;
    if (known && known.sessionId === sessionId && known.provider === provider) return known.alias;
    try {
      const { data } = await loadSessionAccount(sessionId);
      const resolvedCredentialId = data?.state === "resolved" && data.provider === provider ? data.credentialId : undefined;
      const alias = resolveAccountFace(sessionId, provider, resolvedCredentialId)?.alias ?? null;
      if (alias) {
        resolvedAliasRef.current = { sessionId, provider, alias };
        void preloadCueSoundRef.current?.(alias);
      }
      return alias;
    } catch {
      return null;
    }
  }, []);

  /** 지금 화면의 마지막 메시지 뒤를 자리로 잡고, 캐릭터를 정한 뒤 큐를 낸다. */
  const requestCue = useCallback((tag: CueTag | null, trigger: CueTrigger, provider: string | undefined, credentialId: number | undefined, source: string) => {
    const capture = captureCueAnchor(cueMessagesRef.current, cueEntryIdsRef.current);
    void resolveCueAlias(trigger.sessionId, provider, credentialId).then((alias) => {
      // TEMP(2026-09-26): MIO 턴에 YUKI 착수 스티커가 뜨는 원인 추적용. 원인을 찾으면 지운다.
      console.info(`[cue] tag=${tag} alias=${alias} provider=${provider} credentialId=${credentialId} source=${source} session=${trigger.sessionId} turn=${trigger.turn}`);
      playCue(alias, tag, trigger, capture);
    });
  }, [playCue, resolveCueAlias]);

  // 턴 종료는 이벤트 처리 중에 불려 화면이 아직 마지막 메시지를 받기 전일 수 있다. 여기서는
  // 트리거만 잡아 두고, 다음 커밋에서 그 메시지까지 본 뒤 자리를 정한다.
  const [completionTick, setCompletionTick] = useState(0);
  const pendingCompletionsRef = useRef<{ completion: AgentCompletionResult; trigger: CueTrigger | null }[]>([]);
  const wrappedOnAgentEnd = useCallback((completion: AgentCompletionResult) => {
    // 턴이 끝났다. 이 턴에서 아직 디코딩 중인 착수·승인 큐는 이제 낡은 것이다.
    cueTurnRef.current += 1;
    // 중단(`aborted`)은 사용자가 방금 자기 손으로 멈춘 것이라 되돌려줄 정보가 없다 — 알리지 않는다.
    if (cueForOutcome(completion.outcome) !== null) {
      const sessionId = completion.sessionId;
      pendingCompletionsRef.current.push({ completion, trigger: sessionId ? { sessionId, turn: cueTurnRef.current } : null });
      setCompletionTick((tick) => tick + 1);
    }
    onAgentEnd?.(completion);
  }, [onAgentEnd]);
  useEffect(() => {
    for (const { completion, trigger } of pendingCompletionsRef.current.splice(0)) {
      const outcomeCue = cueForOutcome(completion.outcome);
      const tag = outcomeCue === "neutral" ? null : outcomeCue;
      if (trigger) requestCue(tag, trigger, completion.provider, completion.credentialId, "completion");
      else void playCueSoundRef.current(null, tag).catch(() => {});
    }
  }, [completionTick, requestCue]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    chatInputRef?.current?.replaceMessage(message);
  }, [chatInputRef]);

  const {
    loading, error, messages, entryIds, streamState,
    agentRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, toolPreset, thinkingLevel,
    effectiveThinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, subagents, todoPhases: reportedTodoPhases,
    notices, extensionDialog, extensionResponse, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection,
    agentPhase,
    isNew,
    autoFollowPaused, resumeAutoFollow,
    goalStatus,
    sessionIdRef, messagesEndRef, scrollContainerRef,
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleRoleModelChange,
    handleMainPresetChange,
    newSessionAccount,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, ensureNewSession, refreshLiveTranscript,
  } = useAgentSession({
    session, newSessionCwd, initialData: initialSessionData, transitioning, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, chatInputRef, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  });
  // 지금 대화가 어느 Main 프리셋 자리인지. 세션에서는 모델 + 런타임이 답한 실제 계정 자리 +
  // Auto 설정을 함께 보고, 새 대화에서는 이 대화에 대기 중인 선택만 본다 — 브라우저 전역
  // 기억이나 「유일한 활성 계정」 추측으로 계정 자리를 메우지 않는다.
  const sessionAccountFace = useAccountFace(session?.id, displayModelValue?.provider, undefined);
  // 세션 캐릭터가 정해지면 그 캐릭터의 스티커·음성을 미리 받아 둔다. 턴이 끝난 뒤 받으면 늦다.
  const sessionCueAlias = sessionAccountFace?.alias;
  useEffect(() => {
    if (sessionCueAlias) void preloadCueSoundRef.current?.(sessionCueAlias);
  }, [sessionCueAlias]);
  const mainPresetActiveAlias = useMemo(() => {
    if (thinkingLevel !== "auto" || !displayModelValue) return null;
    const accountPosition = isNew
      ? newSessionAccount
      : MAIN_PRESETS.find((entry) => entry.alias === sessionAccountFace?.alias)?.oauthPosition;
    return MAIN_PRESETS.find(
      (entry) =>
        entry.provider === displayModelValue.provider
        && entry.model === displayModelValue.modelId
        && (entry.oauthPosition === undefined || entry.oauthPosition === accountPosition),
    )?.alias ?? null;
  }, [displayModelValue, isNew, newSessionAccount, sessionAccountFace, thinkingLevel]);

  const sessionBusy = agentRunning || bashRunning;
  const cueSessionId = session?.id;
  cueMessagesRef.current = messages;
  cueEntryIdsRef.current = entryIds;
  agentSessionIdRef.current = sessionIdRef;
  const cueFollowRef = useRef(true);
  cueFollowRef.current = !autoFollowPaused;
  // 실행이 새로 시작되면 새 턴이다.
  const cueRunningRef = useRef(false);
  useEffect(() => {
    if (agentRunning && !cueRunningRef.current) cueTurnRef.current += 1;
    cueRunningRef.current = agentRunning;
  }, [agentRunning]);
  // 세션을 바꾸면 이 창은 내려간다(AppShell이 key로 새로 띄운다). 소리는 앱 전체가 함께 쓰므로,
  // 내려간 창에서 아직 디코딩 중인 큐가 다른 세션 화면 위로 늦게 말하지 않게 트리거를 낡게 만든다.
  useEffect(() => () => {
    cueTurnRef.current += 1;
  }, []);
  // 세션이 바뀌면 그 세션에 박혀 있던 스티커를 다시 불러온다. 다음 턴이 시작돼도 지우지 않는다.
  // 새 대화의 첫 턴처럼 세션이 화면에 알려지기 전에 뜬 큐는 자리를 기다리는 채로 이어 둔다.
  useEffect(() => {
    setCues((current) => [
      ...readStoredCues(cueSessionId),
      ...current.filter((cue) => cue.anchorEntryId === null && cue.sessionId === cueSessionId),
    ]);
  }, [cueSessionId]);
  // 기다리는 큐의 메시지가 기록된 것을 확인하면 그 id로 확정해 저장한다. 기준 항목이 사라졌으면
  // (브랜치 이동·압축) 붙일 근거가 없으니 버린다.
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId || !cuesRef.current.some((cue) => cue.anchorEntryId === null && cue.sessionId === sessionId)) return;
    setCues((current) => {
      let changed = false;
      const next: LiveCue[] = [];
      for (const cue of current) {
        if (cue.anchorEntryId !== null || !cue.intent || cue.sessionId !== sessionId) {
          next.push(cue);
          continue;
        }
        const resolved = resolveCueAnchor(cue.intent, messages, entryIds);
        if (resolved === null) {
          next.push(cue);
          continue;
        }
        changed = true;
        if (resolved.kind === "drop") continue;
        // 한 메시지 뒤의 착수 큐는 하나다 — 실행 중 새로고침으로 다시 붙은 턴이 두 번 「시작」하지 않게.
        const duplicateWorking = cue.tag === "working"
          && [...current, ...next].some((other) => other.tag === "working" && other.anchorEntryId === resolved.entryId);
        if (duplicateWorking) continue;
        next.push({ id: cue.id, anchorEntryId: resolved.entryId, sticker: cue.sticker, text: cue.text, tag: cue.tag, sessionId: cue.sessionId });
      }
      if (!changed) return current;
      writeStoredCues(sessionId, next);
      return next;
    });
  }, [messages, entryIds, sessionIdRef]);
  // 6PRO 상담 답변은 에이전트 턴이 아니라 턴 종료 알림이 없다. 같은 기록이 뒤로 자라며 새 답변이
  // 붙은 순간에만 SHION이 알린다 — 처음 불러온 기록·브랜치 이동의 지난 답변은 다시 알리지 않는다.
  const consultBaselineRef = useRef<{ sessionId: string; entryIds: readonly string[] } | null>(null);
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    const previous = consultBaselineRef.current;
    consultBaselineRef.current = sessionId ? { sessionId, entryIds } : null;
    if (!sessionId || !previous || previous.sessionId !== sessionId) return;
    const fresh = newConsultReplyEntryIds(previous.entryIds, entryIds, messages);
    const trigger = currentCueTrigger();
    if (fresh.length === 0 || !trigger) return;
    const alias = resolveAccountFace(sessionId, "web6", undefined)?.alias ?? null;
    for (const entryId of fresh) {
      if (cuesRef.current.some((cue) => cue.anchorEntryId === entryId)) continue;
      playCue(alias, "done", trigger, { kind: "entry", entryId });
    }
  }, [entryIds, messages, sessionIdRef, currentCueTrigger, playCue]);
  const dependencyWaiting = agentRunning
    && agentPhase?.kind === "running_tools"
    && agentPhase.tools.length > 0
    && agentPhase.tools.every((tool) => tool.name === "wait");
  const transitionBusy = loading || transitioning;
  // omp's render-affecting settings (hideThinkingBlock). Synced here once for
  // the whole transcript; MessageView reads the shared store directly.
  const { hideThinkingBlock } = useSyncedDisplaySettings(newSessionCwd ?? session?.cwd ?? null);
  const displayOptions = useMemo<DisplayOptions>(() => ({ hideThinking: hideThinkingBlock }), [hideThinkingBlock]);

  useEffect(() => {
    if (!extensionDialog || soundedExtensionDialogIdRef.current === extensionDialog.id) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    const trigger = currentCueTrigger();
    if (!trigger) return;
    // 사용자가 지금 할 행동으로 나눈다 — 선택지를 내밀면 고르는 일, 그 밖의 확인·입력은 답하는 일.
    priorityCueTurnRef.current = trigger.turn;
    requestCue(cueTagForDialog(extensionDialog.method), trigger, displayModelValue?.provider, undefined, "dialog:session-model");
  }, [extensionDialog, displayModelValue?.provider, currentCueTrigger, requestCue]);

  // Register the abort handler for the global Esc shortcut
  useEffect(() => {
    registerAbortHandler(sessionBusy ? handleAbort : null);
    return () => registerAbortHandler(null);
  }, [sessionBusy, handleAbort]);
  useEffect(() => {
    onSessionBusyChange?.(sessionBusy);
  }, [onSessionBusyChange, sessionBusy]);
  useEffect(() => () => onSessionBusyChange?.(false), [onSessionBusyChange]);
  useEffect(() => {
    onWaitingChange?.(dependencyWaiting);
  }, [dependencyWaiting, onWaitingChange]);
  useEffect(() => () => onWaitingChange?.(false), [onWaitingChange]);
  useEffect(() => {
    onAttentionChange?.(extensionDialog !== null);
  }, [onAttentionChange, extensionDialog]);
  useEffect(() => () => onAttentionChange?.(false), [onAttentionChange]);

  // --- Lazy-load historical messages ---
  // Only render the last N messages initially. When the user scrolls to the
  // top, load another page while keeping the scroll position stable.
  const [visibleCount, setVisibleCount] = useState(VISIBLE_PAGE_SIZE);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);

  // IntersectionObserver on the sentinel div at the top of the message list.
  // When it becomes visible, load the next page of older messages.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Save distance from top before prepending to restore scroll later
          prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
          setVisibleCount((prev) => getNextVisibleCount(prev));
        }
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [visibleCount, messages.length, scrollContainerRef]);

  // After visibleCount increases (more messages prepended), restore the
  // scroll position so the viewport doesn't jump.
  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [visibleCount, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);
  useEffect(() => {
    onSubagentsChange?.(subagents);
  }, [onSubagentsChange, subagents]);
  useEffect(() => () => { onSubagentsChange?.([]); }, [onSubagentsChange]);


  const onDrop = useCallback((files: File[]) => {
    if (sessionBusy) return;
    chatInputRef?.current?.addAttachments(files);
  }, [sessionBusy, chatInputRef]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [messages]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  // The composer's goal line reads this session's own todo, so a switched-to session shows its
  // own list and a session without one shows nothing. The tracker's list, when a state refresh has
  // reported one, covers the changes no tool record carries - see selectCurrentTodo.
  const todoPhases = useMemo(
    () => selectCurrentTodo(messages, toolResultsMap, reportedTodoPhases),
    [messages, toolResultsMap, reportedTodoPhases],
  );

  // --- 대화창에 끼어드는 다른 화자 ---
  // 턴과 자식을 잇는 열쇠는 `task` 도구 호출 id 다. 일반 child와 캐릭터 호출은 command guard가
  // task brief 맨 앞에 넣은 마커로만 가른다. 스트리밍 메시지는 토큰마다 새 객체라 id 집합과
  // 마커 집합이 그대로면 턴 목록도 그대로 두어 발화 스레드의 불필요한 재렌더를 막는다.
  const streamingTaskKey = useMemo(
    () => collectTaskToolCallIds(streamState.streamingMessage).join("|"),
    [streamState.streamingMessage],
  );
  // 요청 전체를 직렬화한 키다 — id만으로는 같은 호출의 배치 항목이 갈리는지 알 수 없다.
  const streamingCharacterSummonKey = useMemo(
    () => JSON.stringify(collectCharacterSummons(streamState.streamingMessage)),
    [streamState.streamingMessage],
  );
  // 스트리밍 중인 send는 아직 toolResult가 없어 발신자를 모른다 — 수신 경계와 잇는 것은
  // 결과가 도착해 from이 확정된 뒤다. 여기서는 자리만 마련해 둔다.
  const streamingPeerSendKey = useMemo(
    () => JSON.stringify(collectPeerSends(streamState.streamingMessage)),
    [streamState.streamingMessage],
  );
  const inlineTurns = useMemo(
    () => buildInlineTurns(
      messages,
      entryIds,
      streamingTaskKey.length > 0 ? streamingTaskKey.split("|") : [],
      JSON.parse(streamingCharacterSummonKey),
      JSON.parse(streamingPeerSendKey),
    ),
    [messages, entryIds, streamingTaskKey, streamingCharacterSummonKey, streamingPeerSendKey],
  );
  const inlineSessionId = session?.id ?? sessionIdRef.current ?? undefined;
  const inlineContext = useMemo<InlineUtteranceContext>(() => ({
    sessionId: inlineSessionId,
    sessionProvider: displayModelValue?.provider,
    turns: inlineTurns,
    messages,
    subagents,
  }), [inlineSessionId, displayModelValue?.provider, inlineTurns, messages, subagents]);
  const inlineUtterances = useInlineUtterances(inlineContext);

  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy;
  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;
  const composerRootRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const focusComposer = useCallback(() => {
    composerRootRef.current
      ?.querySelector<HTMLTextAreaElement>("textarea")
      ?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    onComposerFocusChange?.(focusComposer);
    return () => onComposerFocusChange?.(null);
  }, [focusComposer, onComposerFocusChange]);
  useLayoutEffect(() => {
    const dock = composerDockRef.current;
    const shell = dock?.closest<HTMLElement>(".workspace-shell");
    if (!dock || !shell) return;
    const syncDockHeight = () => {
      const height = Math.ceil(dock.getBoundingClientRect().height);
      if (height > 0) shell.style.setProperty("--omp-dock-h", `${height}px`);
    };
    syncDockHeight();
    const observer = new ResizeObserver(syncDockHeight);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [loading]);



  const chatInputElement = (
    <div ref={composerRootRef} data-chat-composer="" style={{ display: "contents" }}>
      <ChatInput
        ref={chatInputRef}
        sessionId={session?.id ?? sessionIdRef.current ?? undefined}
        onEnsureSession={isNew && newSessionCwd ? ensureNewSession : undefined}
        onLiveTranscriptPersisted={refreshLiveTranscript}
        onSend={handleSend}
        onAbort={handleAbort}
        onSteer={agentRunning ? handleSteer : undefined}
        onFollowUp={agentRunning ? handleFollowUp : undefined}
        onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehavior : undefined}
        isStreaming={sessionBusy}
        model={displayModelValue}
        isAutoModelSelection={isAutoModelSelection}
        modelNames={modelNames}
        modelList={modelList}
        modelError={modelError}
        modelScopeWarnings={modelScopeWarnings}
        onModelChange={handleModelChange}
        onMainPresetChange={session || isNew ? handleMainPresetChange : undefined}
        mainPresetActiveAlias={mainPresetActiveAlias}
        modelRoles={modelRoles}
        onRoleModelChange={handleRoleModelChange}
        modelSwitching={modelSwitching}
        onCompact={session || isNew ? handleCompact : undefined}
        onAbortCompaction={handleAbortCompaction}
        isCompacting={isCompacting}
        compactError={compactError}
        compactResult={compactResult}
        toolPreset={toolPreset}
        onToolPresetChange={session || isNew ? handleToolPresetChange : undefined}
        thinkingLevel={thinkingLevel}
        effectiveThinkingLevel={effectiveThinkingLevel}
        onThinkingLevelChange={session || isNew ? handleThinkingLevelChange : undefined}
        availableThinkingLevels={availableThinkingLevels}
        thinkingLevelMap={currentThinkingLevelMap}
        retryInfo={retryInfo}
        queuedMessages={queuedMessages}
        inputHistory={inputHistory}
        onRecallQueue={handleRecallQueue}
        slashCommands={slashCommands}
        slashCommandsLoading={slashCommandsLoading}
        onLoadSlashCommands={loadSlashCommands}
        onBuiltinCommand={handleBuiltinSlashCommand}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        onAudioUnlock={unlockAudio}
        draftKey={session?.id ?? (newSessionCwd ? `new:${newSessionCwd}` : undefined)}
        cwd={session?.cwd ?? newSessionCwd}
      />
    </div>
  );

  // The live tail is one flat message: only its answer runs belong in the
  // conversation. Its thinking and tool calls belong to the process view, and
  // they are published there while the run streams - not only once it settles.
  const streamingMessage = streamState.streamingMessage;
  const liveRuns = useMemo(
    () => (streamingMessage
      ? splitAssistantBlockRuns(streamingMessage as AssistantMessage, { isStreaming: true })
      : []),
    [streamingMessage],
  );
  const liveAnswerBlocks = useMemo<AssistantContentBlock[]>(
    () => liveRuns.filter((run) => run.kind === "answer").flatMap((run) => run.blocks),
    [liveRuns],
  );
  const liveProcessRuns = useMemo<AssistantContentBlock[][]>(
    () => liveRuns.filter((run) => run.kind !== "answer").map((run) => run.blocks),
    [liveRuns],
  );
  // 실행이 실제로 무언가 하기 시작한 순간 — 답의 글이 흐르거나 도구 호출이 뜬 때 — 한 번만
  // 착수를 알린다. 재렌더·도구마다 다시 부르지 않고, 새 활동 없이 타이머로 반복하지도 않는다.
  const streamingAssistant = streamingMessage?.role === "assistant" ? streamingMessage as AssistantMessage : null;
  const progressStarted = agentRunning && (
    agentPhase?.kind === "running_tools"
    || (streamingAssistant?.content ?? []).some((block) => (block.type === "text" && /\S/.test(block.text)) || block.type === "toolCall")
  );
  const progressProvider = streamingAssistant?.provider ?? displayModelValue?.provider;
  const progressCredentialId = streamingAssistant?.credentialId;
  // TEMP(2026-09-26): 착수 큐 provider 가 어디서 왔는지. 위 `[cue]` 진단과 함께 지운다.
  const progressSource = streamingAssistant?.provider
    ? `stream:${streamingAssistant.provider}/${streamingAssistant.model}`
    : `session-model:${displayModelValue?.provider}/${displayModelValue?.modelId}`;
  useEffect(() => {
    if (!progressStarted) return;
    const trigger = currentCueTrigger();
    if (!trigger || workingCueTurnRef.current === trigger.turn || priorityCueTurnRef.current === trigger.turn) return;
    workingCueTurnRef.current = trigger.turn;
    requestCue("working", trigger, progressProvider, progressCredentialId, progressSource);
  }, [progressStarted, progressProvider, progressCredentialId, progressSource, currentCueTrigger, requestCue]);
  const [settledLog, setSettledLog] = useState<ProcessLogData | null>(null);
  const publishProcessLog = useCallback((data: ProcessLogData) => {
    setSettledLog(data);
  }, []);
  // The shell command in flight is work log too, exactly like the settled
  // bashExecution message it turns into.
  const pendingBashMessage = useMemo<BashExecutionMessage | null>(
    () => (pendingBash
      ? {
          role: "bashExecution",
          command: pendingBash.command,
          output: "",
          excludeFromContext: pendingBash.excludeFromContext,
        } as BashExecutionMessage
      : null),
    [pendingBash],
  );
  // The phase / running-command line is live run state, so it belongs with the
  // work log rather than as an extra line under the conversation.
  const liveStatus = useMemo(() => {
    const parts = [
      agentRunning && !streamingMessage && agentPhase ? phaseLabel(agentPhase, t) : null,
      bashRunning && !pendingBash ? t("chat.runningCommand") : null,
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? parts.join(" · ") : null;
  }, [agentRunning, streamingMessage, agentPhase, bashRunning, pendingBash, t]);
  // The panel reads the settled work log plus the work in flight, so live
  // thinking, tool calls, shell output and run state stay observable.
  useEffect(() => {
    if (!settledLog) {
      onProcessLogChange?.(null);
      return;
    }
    const liveMessages: AgentMessage[] = [];
    const entries: { idx: number; blocks?: AssistantContentBlock[] }[] = [];
    let toolCallCount = 0;
    if (streamingMessage && liveProcessRuns.length > 0) {
      const idx = settledLog.messages.length + liveMessages.length;
      liveMessages.push(streamingMessage as AssistantMessage);
      for (const blocks of liveProcessRuns) {
        entries.push({ idx, blocks });
        toolCallCount += countToolCallBlocks(blocks);
      }
    }
    if (pendingBashMessage) {
      entries.push({ idx: settledLog.messages.length + liveMessages.length });
      liveMessages.push(pendingBashMessage);
    }
    if (entries.length === 0) {
      onProcessLogChange?.(liveStatus ? { ...settledLog, status: liveStatus } : settledLog);
      return;
    }
    let anchorIdx = -1;
    for (let idx = settledLog.messages.length - 1; idx >= 0; idx--) {
      if (isGroupAnchor(settledLog.messages[idx])) { anchorIdx = idx; break; }
    }
    const groups = settledLog.groups.slice();
    const open = groups.length > 0 ? groups[groups.length - 1] : undefined;
    // The work in flight continues the turn the settled log already opened.
    if (open && open.anchorIdx === anchorIdx) {
      groups[groups.length - 1] = {
        ...open,
        entries: [...open.entries, ...entries],
        messageCount: open.messageCount + entries.length,
        toolCallCount: open.toolCallCount + toolCallCount,
      };
    } else {
      groups.push({ anchorIdx, entries, messageCount: entries.length, toolCallCount });
    }
    onProcessLogChange?.({
      ...settledLog,
      groups,
      messages: [...settledLog.messages, ...liveMessages],
      status: liveStatus,
    });
  }, [settledLog, liveProcessRuns, streamingMessage, pendingBashMessage, liveStatus, onProcessLogChange]);
  // A session that unmounts leaves no work log behind in the panel.
  useEffect(() => () => onProcessLogChange?.(null), [onProcessLogChange]);

  const aboveEditorWidgets = extensionWidgets.filter((widget) => widget.placement !== "belowEditor");
  const belowEditorWidgets = extensionWidgets.filter((widget) => widget.placement === "belowEditor");


  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="chat-window relative flex h-full min-w-0 flex-col overflow-hidden"
      aria-busy={transitionBusy}
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {transitionBusy ? (
        <div className="absolute inset-0 z-40 cursor-wait">
          <div className="absolute right-3 top-3 border border-border bg-bg-panel px-3 py-2 text-sm text-text-muted shadow-sm" role="status">
            {t("chat.loadingSession")}
          </div>
        </div>
      ) : null}
      {isDragOver && !sessionBusy && (
        <div
          className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center"
          style={{ background: "var(--accent-soft)", border: "2px dashed var(--accent-line)" }}
        >
          <span
            className="px-3 py-1 text-sm font-medium"
            style={{
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-surface)",
              color: "var(--text)",
            }}
          >
            {t("chat.attachFile")}
          </span>
        </div>
      )}

      {extensionCustomUi && (
        <ExtensionCustomPanel
          request={extensionCustomUi}
          onInput={sendExtensionCustomInput}
        />
      )}

      {isEmptyNew && !transcriptReplacement ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-[820px]">
            <div
              className="mb-3"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                marginLeft: 16,
                marginRight: 52,
                fontFamily: "var(--font-mono)",
              }}
            >
              <div style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
                <OmpWordmark />
              </div>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  web <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0"}</span>
                </span>
                <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  omp <span style={{ color: "var(--text)" }}>v{process.env.NEXT_PUBLIC_OMP_VERSION ?? "0.0.0"}</span>
                </span>
              </div>
            </div>
            <NoticeShelf notices={notices} align="right" />
          </div>
        </div>
      ) : (
      <>
      {transcriptReplacement && (
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {transcriptReplacement}
        </div>
      )}
      <div
        className="relative min-w-0 flex-1 overflow-hidden"
        aria-hidden={Boolean(transcriptReplacement)}
        style={{ display: transcriptReplacement ? "none" : "flex" }}
      >
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 0,
            right: 0,
            zIndex: 40,
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
            pointerEvents: "none",
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <NoticeShelf notices={notices} floating align="right" />
          </div>
        </div>
        <div ref={scrollContainerRef} className="chat-session-scroll min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]">
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ width: "100%", minWidth: 0, maxWidth: 820, margin: "0 auto" }}>
              <ExtensionWidgets widgets={aboveEditorWidgets} />

            <InlineUtterancesProvider utterances={inlineUtterances}>
              <HistoricalTranscript
                messages={messages}
                entryIds={entryIds}
                toolResultsMap={toolResultsMap}
                modelNames={modelNames}
                messageCwd={messageCwd}
                onOpenFile={onOpenFile}
                sessionBusy={sessionBusy}
                isNew={isNew}
                isStreaming={streamState.isStreaming}
                displayOptions={displayOptions}
                handleFork={handleFork}
                forkingEntryId={forkingEntryId}
                handleNavigate={handleNavigate}
                handleEditContent={handleEditContent}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                visibleCount={visibleCount}
                sentinelRef={sentinelRef}
                t={t}
                cues={cues}
                cueFollowRef={cueFollowRef}
                onProcessLogChange={publishProcessLog}
              />
            </InlineUtterancesProvider>
            {streamState.isStreaming && streamState.streamingMessage && liveAnswerBlocks.length > 0 && (
              <MessageView
                message={withAssistantBlocks(streamState.streamingMessage as AssistantMessage, liveAnswerBlocks)}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                isStreaming
                modelNames={modelNames}
                cwd={messageCwd}
                onOpenFile={onOpenFile}
              />
            )}

            <div ref={messagesEndRef} />
            </div>
          </div>
        </div>
        {sessionBusy && autoFollowPaused && (
          <button
            type="button"
            onClick={resumeAutoFollow}
            aria-label={t("chat.jumpToBottom")}
            title={t("chat.jumpToBottom")}
            style={{
              position: "absolute",
              bottom: 16,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 40,
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "6px 12px",
              borderRadius: 999,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              fontSize: 11,
              fontFamily: "var(--font-mono)",
              cursor: "pointer",
              boxShadow: "0 2px 10px rgba(0,0,0,0.28)",
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14" />
              <path d="m19 12-7 7-7-7" />
            </svg>
            {t("chat.jumpToBottom")}
          </button>
        )}
      </div>

      </>
      )}
      <div ref={composerDockRef} className="relative chat-composer-dock">
        {extensionDialog && (
          <div style={{ padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              <ExtensionDialog
                request={extensionDialog}
                onRespond={respondToExtensionUi}
                delivery={extensionResponse}
              />
            </div>
          </div>
        )}
        <div
          style={{
            padding: `0 ${CHAT_COLUMN_PADDING}px`,
          }}
        >
          <div style={{ maxWidth: 820, margin: "0 auto" }}>
            <GoalBar goal={goalStatus} t={t} />
            <ExtensionWidgets widgets={belowEditorWidgets} />
            {todoPhases && <TodoStrip phases={todoPhases} />}
          </div>
        </div>
        {chatInputElement}
        <ExtensionStatusBar statuses={extensionStatuses} />
      </div>
    </div>
  );
}

/**
 * Goal mode runs a continuation loop between turns, so the operator needs to
 * see that it is on and how much budget is left without asking for it.
 */
function GoalBar({ goal, t }: { goal: GoalStatusInfo | null; t: (key: string, params?: Record<string, string | number>) => string }) {
  if (!goal) return null;
  const paused = !goal.enabled;
  const budget = goal.tokenBudget !== undefined
    ? t("chat.goalBudgetLeft", { left: formatTokenCount(Math.max(0, goal.tokenBudget - goal.tokensUsed)) })
    : t("chat.goalTokensUsed", { used: formatTokenCount(goal.tokensUsed) });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginBottom: 8,
        padding: "5px 10px",
        border: "1px solid var(--border)",
        borderRadius: 7,
        background: "var(--bg-panel)",
        color: "var(--text-muted)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        opacity: paused ? 0.7 : 1,
      }}
    >
      <span style={{ color: paused ? "var(--text-dim)" : "var(--accent)", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", flexShrink: 0 }}>
        {t("chat.goalLabel")}
      </span>
      <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>
        {goal.objective}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>
        {paused ? t("chat.goalPaused") : goal.status}
      </span>
      <span style={{ flexShrink: 0, color: "var(--text-dim)" }}>{budget}</span>
    </div>
  );
}

function ExtensionWidgets({ widgets }: { widgets: Array<{ key: string; lines: string[] }> }) {
  if (widgets.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 10 }}>
      {widgets.map((widget) => (
        <div
          key={widget.key}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--bg-panel)",
            overflow: "hidden",
          }}
        >
          <div style={{ padding: "5px 9px", borderBottom: "1px solid var(--border)", color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
            {widget.key}
          </div>
          <pre style={{ margin: 0, padding: "8px 9px", color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "var(--font-mono)" }}>
            {widget.lines.join("\n")}
          </pre>
        </div>
      ))}
    </div>
  );
}

function NoticeShelf({ notices, floating = false, align = "left" }: { notices: NoticeItem[]; floating?: boolean; align?: "left" | "right" }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: align === "right" ? "flex-end" : "stretch",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "var(--danger)"
          : notice.type === "warning"
            ? "var(--warning)"
            : notice.type === "success"
              ? "var(--success)"
              : "var(--accent)";
        return (
          <div
            key={notice.id}
            className="notice-shelf-item"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 60,
              height: 60,
              maxHeight: 60,
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: "var(--seed-radius-r3)",
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating ? "var(--seed-shadow-s3)" : "var(--seed-shadow-s2)",
              fontSize: 18,
              lineHeight: 1.45,
              transformOrigin: "top center",
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out both",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
              }}
            />
            <span style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" | "plan_review" }
>;

/**
 * The agent's request for a response sits next to the composer, in the same
 * column as the conversation, rather than covering the chat: the transcript
 * stays readable while the reader answers. It is a non-modal dialog - focus is
 * not trapped and the composer remains reachable - so `aria-modal` is false,
 * and Escape cancels from anywhere inside the surface for every request kind
 * whose approved behaviour has a cancel - that is all of them except plan
 * review, which must be answered explicitly.
 */
const RESPONSE_SURFACE_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ResponseSurface({
  focusKey,
  label,
  labelledBy,
  maxBlockSize = "min(56dvh, 620px)",
  onCancel,
  delivery,
  children,
}: {
  /** Changing it re-runs initial focus, so a new request is reachable at once. */
  focusKey: string;
  label?: string;
  labelledBy?: string;
  maxBlockSize?: string;
  /**
   * Only for request kinds whose approved behaviour has an Escape cancel; the
   * others (plan review) must not gain one.
   */
  onCancel?: () => void;
  /** Set while this request's answer is in flight or after it failed. */
  delivery?: ExtensionResponseState | null;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // What the keyboard owes back is whatever had focus before this request appeared, and that has to
  // be read while rendering: an `autoFocus`ed field inside the surface (input, editor) takes focus
  // in the commit that follows, so by the time effects run `document.activeElement` is already ours
  // and the element we would restore is the one about to be unmounted.
  const restoreRef = useRef<{ key: string; element: HTMLElement | null }>({ key: "", element: null });
  if (restoreRef.current.key !== focusKey) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    restoreRef.current = {
      key: focusKey,
      element: active instanceof HTMLElement && !surfaceRef.current?.contains(active) ? active : null,
    };
  }
  // The surface is non-modal by design - it sits in the conversation column, so
  // Tab still reaches the composer and no focus trap is installed. What it does
  // owe the keyboard is a first stop on mount and the caller's focus back when
  // the request is answered or withdrawn.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface && !surface.contains(document.activeElement)) {
      const first = surface.querySelector<HTMLElement>(RESPONSE_SURFACE_FOCUSABLE);
      (first ?? surface).focus();
    }
    const previous = restoreRef.current.element;
    return () => {
      if (!previous?.isConnected) return;
      // The surface is non-modal, so while an answer is in flight the user may have moved on to
      // another control. Focus is only owed back when the focus that is disappearing is this
      // surface's own, or when the document is left with none.
      const active = document.activeElement;
      if (active === null || active === document.body || surface?.contains(active)) previous.focus();
    };
  }, [focusKey]);

  return (
    <div
      ref={surfaceRef}
      role="dialog"
      aria-modal="false"
      aria-label={label}
      aria-labelledby={labelledBy}
      className="chat-response-surface"
      tabIndex={-1}
      onKeyDown={onCancel
        ? (event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          onCancel();
        }
        : undefined}
      aria-busy={delivery?.status === "sending" ? true : undefined}
      style={{ maxBlockSize }}
    >
      {delivery ? (
        <p
          className="chat-response-delivery"
          role={delivery.status === "failed" ? "alert" : "status"}
          data-state={delivery.status}
        >
          {delivery.status === "sending" ? t("chat.responseSending") : `${t("chat.responseFailed")}${delivery.error ? ` (${delivery.error})` : ""}`}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function ExtensionDialog({
  request,
  onRespond,
  delivery,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
  /** Non-null while this request's answer is in flight or after it failed. */
  delivery?: ExtensionResponseState | null;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [selectedOptions, setSelectedOptions] = useState<Record<string, number[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [planFeedback, setPlanFeedback] = useState("");

  useEffect(() => {
    setValue(request.method === "editor" ? request.prefill ?? "" : "");
    setPlanFeedback("");
    setCustomAnswers({});
    if (request.method !== "ask") {
      setSelectedOptions({});
      return;
    }
    const recommended: Record<string, number[]> = {};
    for (const question of request.questions) {
      recommended[question.id] = question.recommended !== undefined
        && question.options[question.recommended] !== undefined
        ? [question.recommended]
        : [];
    }
    setSelectedOptions(recommended);
  }, [request]);

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };
  if (request.method === "ask") {
    const canSubmit = request.questions.every((question) =>
      (selectedOptions[question.id]?.length ?? 0) > 0
      || (customAnswers[question.id]?.trim().length ?? 0) > 0);
    const toggleOption = (questionId: string, optionIndex: number, multi: boolean) => {
      setSelectedOptions((current) => {
        const selected = current[questionId] ?? [];
        const next = multi
          ? selected.includes(optionIndex)
            ? selected.filter((index) => index !== optionIndex)
            : [...selected, optionIndex]
          : [optionIndex];
        return { ...current, [questionId]: next };
      });
    };
    const submitAnswers = () => {
      if (!canSubmit) return;
      onRespond(request, {
        value: JSON.stringify({
          kind: "submit",
          results: request.questions.map((question) => {
            const customInput = customAnswers[question.id]?.trim();
            return {
              id: question.id,
              question: question.question,
              options: question.options.map((option) => option.label),
              multi: question.multi ?? false,
              selectedOptions: (selectedOptions[question.id] ?? [])
                .map((index) => question.options[index]?.label)
                .filter((option): option is string => option !== undefined),
              ...(customInput ? { customInput } : {}),
            };
          }),
        }),
      });
    };

    return (
      <ResponseSurface
        focusKey={request.id}
        label={t("chat.agentQuestion")}
        onCancel={() => onRespond(request, { cancelled: true })}
        delivery={delivery}
      >
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "var(--text)", fontSize: "var(--seed-font-size-t4-static)", fontWeight: 600 }}>{t("chat.agentQuestion")}</div>
              <div style={{ marginTop: 2, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)" }}>{t("chat.agentQuestionHint")}</div>
            </div>
          </div>

          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 16 }}>
            <div style={{ display: "grid", gap: 20 }}>
              {request.questions.map((question, questionIndex) => {
                const selected = selectedOptions[question.id] ?? [];
                return (
                  <section
                    key={question.id}
                    style={{
                      paddingTop: questionIndex === 0 ? 0 : 20,
                      borderTop: questionIndex === 0 ? "none" : "1px solid var(--hairline)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                      {question.header && (
                        <span style={{ color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontWeight: 600 }}>
                          {question.header}
                        </span>
                      )}
                      {request.questions.length > 1 && (
                        <span style={{ marginLeft: "auto", color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontVariantNumeric: "tabular-nums" }}>
                          {questionIndex + 1}/{request.questions.length}
                        </span>
                      )}
                    </div>
                    <div style={{ marginBottom: 10, color: "var(--text)", fontSize: "var(--seed-font-size-t4-static)", fontWeight: 600, lineHeight: 1.5 }}>
                      {question.question}
                    </div>
                    <div
                      role={question.multi ? "group" : "radiogroup"}
                      aria-label={question.question}
                      style={{ display: "grid", gap: 4 }}
                    >
                      {question.options.map((option, optionIndex) => {
                        const checked = selected.includes(optionIndex);
                        const recommended = question.recommended === optionIndex;
                        return (
                          <button
                            key={`${question.id}:${optionIndex}`}
                            type="button"
                            role={question.multi ? "checkbox" : "radio"}
                            aria-checked={checked}
                            onClick={() => toggleOption(question.id, optionIndex, question.multi ?? false)}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "18px minmax(0, 1fr) auto",
                              alignItems: "start",
                              gap: 9,
                              width: "100%",
                              minHeight: 40,
                              padding: "9px 10px",
                              border: `1px solid ${checked ? "var(--border-strong)" : "transparent"}`,
                              borderRadius: "var(--radius-control)",
                              background: checked ? "var(--bg-selected)" : "transparent",
                              color: "var(--text)",
                              cursor: "pointer",
                              textAlign: "left",
                            }}
                          >
                            <span
                              aria-hidden="true"
                              style={{
                                display: "grid",
                                placeItems: "center",
                                width: 16,
                                height: 16,
                                marginTop: 1,
                                border: `1px solid ${checked ? "var(--text)" : "var(--text-dim)"}`,
                                borderRadius: question.multi ? "var(--radius-control)" : "50%",
                                background: checked ? "var(--seed-color-fg-neutral)" : "transparent",
                                color: "var(--seed-color-fg-neutral-inverted)",
                                fontSize: "var(--seed-font-size-t2-static)",
                                lineHeight: 1,
                              }}
                            >
                              {checked && (question.multi ? (
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <polyline points="2 5.2 4.1 7.2 8 2.8" />
                                </svg>
                              ) : (
                                <span style={{ width: 5, height: 5, borderRadius: "50%", background: "currentColor" }} />
                              ))}
                            </span>
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: "block", fontSize: "var(--seed-font-size-t4-static)", fontWeight: checked ? 600 : 500 }}>{option.label}</span>
                              {option.description && (
                                <span style={{ display: "block", marginTop: 3, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.45 }}>
                                  {option.description}
                                </span>
                              )}
                              {checked && option.preview && (
                                <span style={{ display: "block", marginTop: 8, padding: "7px 8px", borderLeft: "2px solid var(--border-strong)", background: "var(--bg-subtle)", color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                                  {option.preview}
                                </span>
                              )}
                            </span>
                            {recommended && (
                              <span style={{ color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontWeight: 600 }}>
                                {t("chat.recommended")}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <input
                      value={customAnswers[question.id] ?? ""}
                      onChange={(event) => setCustomAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") submitAnswers();
                      }}
                      placeholder={t("chat.customAnswer")}
                      aria-label={t("chat.customAnswer")}
                      style={{
                        width: "100%",
                        height: 36,
                        marginTop: 9,
                        padding: "0 10px",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-control)",
                        // The shared :focus-visible ring is this app's only focus
                        // indication; an inline `outline: none` here would erase
                        // the cue for the one field in the question form.
                        background: "var(--bg)",
                        color: "var(--text)",
                        fontFamily: "var(--seed-font-family)",
                        fontSize: "var(--seed-font-size-t4-static)",
                      }}
                    />
                  </section>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              onClick={() => onRespond(request, { cancelled: true })}
              style={{ minHeight: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
            >
              {t("chat.cancel")}
            </button>
            <button
              type="button"
              onClick={() => onRespond(request, { value: JSON.stringify({ kind: "chat" }) })}
              style={{ minHeight: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer" }}
            >
              {t("chat.chatAboutThis")}
            </button>
            <button
              type="button"
              disabled={!canSubmit || delivery?.status === "sending"}
              onClick={submitAnswers}
              style={{
                minHeight: 36,
                padding: "0 14px",
                border: "1px solid transparent",
                borderRadius: "var(--radius-control)",
                background: canSubmit && delivery?.status !== "sending" ? "var(--seed-color-bg-neutral-inverted)" : "var(--seed-color-bg-disabled)",
                color: canSubmit && delivery?.status !== "sending" ? "var(--seed-color-fg-neutral-inverted)" : "var(--seed-color-fg-disabled)",
                cursor: canSubmit && delivery?.status !== "sending" ? "pointer" : "not-allowed",
                fontWeight: 600,
              }}
            >
              {delivery?.status === "sending" ? t("chat.responseSending") : t("chat.submitAnswer")}
            </button>
          </div>
        </div>
      </ResponseSurface>
    );
  }

  if (request.method === "plan_review") {
    return (
      <ResponseSurface
        focusKey={request.id}
        labelledBy={`plan-review-${request.id}`}
        maxBlockSize="min(64dvh, 760px)"
        delivery={delivery}
      >
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontWeight: 600 }}>
              {t("chat.planApproval")}
            </div>
            <div id={`plan-review-${request.id}`} style={{ marginTop: 4, color: "var(--text)", fontSize: "var(--seed-font-size-t5-static)", fontWeight: 600 }}>
              {request.title}
            </div>
            <div style={{ marginTop: 5, color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "var(--seed-font-size-t2-static)", overflowWrap: "anywhere" }}>
              {request.planFilePath}
            </div>
          </div>

          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: "18px 20px" }}>
            <MarkdownBody>{request.planContent}</MarkdownBody>
          </div>

          <div style={{ padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
            <textarea
              value={planFeedback}
              onChange={(event) => setPlanFeedback(event.target.value)}
              placeholder={t("chat.planFeedback")}
              aria-label={t("chat.planFeedback")}
              style={{
                width: "100%",
                minHeight: 64,
                maxHeight: 150,
                padding: "9px 10px",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-control)",
                outline: "none",
                resize: "vertical",
                background: "var(--bg)",
                color: "var(--text)",
                fontFamily: "var(--seed-font-family)",
                fontSize: "var(--seed-font-size-t4-static)",
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, marginTop: 9 }}>
              <button
                type="button"
                onClick={() => onRespond(request, {
                  value: JSON.stringify({ action: "refine", feedback: planFeedback.trim() }),
                })}
                style={{ minHeight: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer" }}
              >
                {t("chat.refinePlan")}
              </button>
              <button
                type="button"
                onClick={() => onRespond(request, { value: JSON.stringify({ action: "approve" }) })}
                style={{ minHeight: 36, padding: "0 14px", border: "1px solid transparent", borderRadius: "var(--radius-control)", background: "var(--seed-color-bg-neutral-inverted)", color: "var(--seed-color-fg-neutral-inverted)", cursor: "pointer", fontWeight: 600 }}
              >
                {t("chat.approvePlan")}
              </button>
            </div>
          </div>
        </div>
      </ResponseSurface>
    );
  }


  return (
    <ResponseSurface
      focusKey={request.id}
      labelledBy={`extension-request-${request.id}`}
      // confirm/select/input/editor all cancel on Escape, and the surface owns
      // that one handler so a focused control no longer decides it.
      onCancel={() => onRespond(request, { cancelled: true })}
      delivery={delivery}
    >
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div id={`extension-request-${request.id}`} style={{ color: "var(--text)", fontSize: "var(--seed-font-size-t4-static)", fontWeight: 600 }}>{request.title}</div>
          <div style={{ marginTop: 3, color: "var(--text-muted)", fontSize: "var(--seed-font-size-t2-static)", fontFamily: "var(--font-mono)" }}>{t("chat.extensionRequest")}</div>
        </div>

        <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: 14 }}>
          {request.method === "confirm" && (
            <div style={{ color: "var(--text-muted)", fontSize: "var(--seed-font-size-t3-static)", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{request.message}</div>
          )}
          {request.method === "select" && (
            <div style={{ display: "grid", gap: 8 }}>
              {request.options.map((option) => (
                <button
                  key={option}
                  onClick={() => onRespond(request, { value: option })}
                  style={{
                    width: "100%",
                    minHeight: 40,
                    padding: "9px 10px",
                    borderRadius: "var(--radius-control)",
                    border: "1px solid var(--border)",
                    background: "transparent",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: "var(--seed-font-size-t4-static)",
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                outline: "none",
                fontSize: "var(--seed-font-size-t4-static)",
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: "var(--radius-control)",
                border: "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: "var(--seed-font-size-t3-static)",
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "flex-end", gap: 8, padding: "12px 14px", borderTop: "1px solid var(--border)" }}>
          <button
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              minHeight: 36,
              padding: "0 12px",
              borderRadius: "var(--radius-control)",
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                minHeight: 36,
                padding: "0 14px",
                borderRadius: "var(--radius-control)",
                border: "1px solid transparent",
                background: "var(--seed-color-bg-neutral-inverted)",
                color: "var(--seed-color-fg-neutral-inverted)",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                minHeight: 36,
                padding: "0 14px",
                borderRadius: "var(--radius-control)",
                border: "1px solid transparent",
                background: "var(--seed-color-bg-neutral-inverted)",
                color: "var(--seed-color-fg-neutral-inverted)",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {t("chat.submit")}
            </button>
          ) : null}
        </div>
      </div>
    </ResponseSurface>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function renderAnsiLine(line: string, keyPrefix: string): ReactNode[] {
  return parseAnsiLine(line).map((segment, index) => (
    Object.keys(segment.style).length > 0
      ? <span key={`${keyPrefix}-${index}`} style={segment.style}>{segment.text}</span>
      : segment.text
  ));
}

function ExtensionCustomPanel({
  request,
  onInput,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const displayLines = normalizeCustomPanelLines(request.lines);

  useEffect(() => {
    inputRef.current?.focus();
  }, [request.id]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "var(--seed-color-bg-overlay-muted)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, calc(100vh - 40px))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          background: "var(--bg)",
          boxShadow: "var(--seed-shadow-s3)",
          overflow: "hidden",
          outline: "none",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <button
            onClick={() => onInput(request, "\x03")}
            style={{
              padding: "5px 9px",
              borderRadius: 6,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
             {t("chat.close")}
          </button>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            maxHeight: "calc(min(760px, 100vh - 40px) - 48px)",
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          {(displayLines.length ? displayLines : [""]).map((line, index, allLines) => (
            <Fragment key={index}>
              {renderAnsiLine(line, `line-${index}`)}
              {index < allLines.length - 1 ? "\n" : null}
            </Fragment>
          ))}
        </pre>
      </div>
    </div>
  );
}
