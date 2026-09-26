"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, useReducer } from "react";
import type {
  AgentMessage,
  BlockingExtensionUiRequest,
  CustomMessage,
  ExtensionStatusItem,
  ExtensionUiRequest,
  ExtensionWidgetItem,
  SessionInfo,
  SessionTreeNode,
  SubagentSnapshot,
} from "@/lib/types";
import { isBlockingExtensionUiRequest } from "@/lib/browser-notifications";
import { normalizeToolCalls } from "@/lib/normalize";
import { stripAnsi } from "@/lib/ansi";
import { AgentCommandError, isPromptRejectedError, sendAgentCommand } from "@/lib/agent-client";
import { getToolNamesForPreset, type ToolEntry } from "@/lib/tool-presets";
import type { ContextUsage, GoalStatusInfo, RestoredQueuedMessage, SessionStatsInfo, SlashCommandInfo } from "@/lib/omp-types";
import type { ModelRoleAssignment } from "@/lib/api-types";
import {
  composeDocumentPrompt,
  type AttachedDocument,
} from "@/lib/document-attachments";
import { mergeRestoredQueuedMessages } from "@/lib/draft-store";
import { UPDATE_WAKE_EVENT } from "@/lib/update-maintenance-client";
import { type TodoPhase } from "@/lib/todo-state";
import type { MainPresetSelection } from "@/lib/hanse-resource-client";
import {
  COMMAND_OUTPUT_CUSTOM_TYPE,
  isLocalCommandEntryId,
  LOCAL_COMMAND_ENTRY_PREFIX,
  withLocalCommandOutputs,
  type LocalCommandOutput,
} from "@/lib/transcript-plan";

export interface SessionData {
  sessionId: string;
  filePath: string;
  totalActiveMs: number;
  tree: SessionTreeNode[];
  leafId: string | null;
  contextUsage?: ContextUsage;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
    thinkingLevel: string;
    configuredThinkingLevel?: string;
    model: { provider: string; modelId: string } | null;
  };
}

interface StreamingState {
  isStreaming: boolean;
  streamingMessage: Partial<AgentMessage> | null;
}

type StreamAction =
  | { type: "start" }
  | { type: "update"; message: Partial<AgentMessage> }
  | { type: "end" }
  | { type: "reset" };

function streamReducer(state: StreamingState, action: StreamAction): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "update":
      return { isStreaming: true, streamingMessage: action.message };
    case "end":
    case "reset":
      return { isStreaming: false, streamingMessage: null };
    default:
      return state;
  }
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

interface CompactCommandResult {
  tokensBefore?: number;
  estimatedTokensAfter?: number;
}

interface LastAssistantTextResponse {
  text?: string;
}

type AgentStateResponse = {
  contextUsage?: { percent: number | null; contextWindow: number; tokens: number | null } | null;
  systemPrompt?: string;
  thinkingLevel?: string;
  configuredThinkingLevel?: string;
  isStreaming?: boolean;
  isPromptRunning?: boolean;
  isBashRunning?: boolean;
  isCompacting?: boolean;
  isHandoffRunning?: boolean;
  extensionStatuses?: ExtensionStatusItem[];
  extensionWidgets?: ExtensionWidgetItem[];
  queuedMessages?: { steering?: string[]; followUp?: string[] } | null;
  subagents?: SubagentSnapshot[];
  /** The harness tracker's own todo list - the state the todo tool records are written from. */
  todoPhases?: TodoPhase[] | null;
  goal?: GoalStatusInfo | null;
};

interface GoalCommandResponse {
  message?: string;
  error?: string;
  prompt?: string;
  status?: GoalStatusInfo | null;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

function normalizeQueuedMessages(q?: { steering?: string[]; followUp?: string[] } | null): QueuedMessages {
  return { steering: q?.steering ?? [], followUp: q?.followUp ?? [] };
}

/**
 * Whether two tracker lists say the same thing, so a re-reported list of identical tasks (a state
 * snapshot of an unchanged todo, or a `todo_changed` for a phase the reader is not looking at)
 * never re-renders the transcript around the strip.
 */
function sameTodoPhases(left: TodoPhase[], right: TodoPhase[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (!a || !b || a.name !== b.name || a.tasks.length !== b.tasks.length) return false;
    for (let t = 0; t < a.tasks.length; t += 1) {
      const x = a.tasks[t];
      const y = b.tasks[t];
      if (!x || !y || x.content !== y.content || x.status !== y.status || x.blocker !== y.blocker) return false;
    }
  }
  return true;
}
// State refreshes contain only live SDK entries; merge terminal frames into a bounded history.
const MAX_SUBAGENT_HISTORY = 128;

function mergeSubagentSnapshots(current: SubagentSnapshot[], incoming: SubagentSnapshot[]): SubagentSnapshot[] {
  const byId = new Map(current.map((subagent) => [subagent.id, subagent]));
  for (const subagent of incoming) byId.set(subagent.id, subagent);
  const snapshots = [...byId.values()];
  const active = snapshots
    .filter((subagent) => subagent.status === "pending" || subagent.status === "running")
    .sort((left, right) => left.index - right.index || left.id.localeCompare(right.id));
  const finished = snapshots
    .filter((subagent) => subagent.status !== "pending" && subagent.status !== "running")
    .sort((left, right) => right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id));
  return [...active, ...finished].slice(0, MAX_SUBAGENT_HISTORY);
}

type ExtensionUiDialogRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "ask" | "plan_review" }
>;
type ExtensionUiCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

/**
 * Whether the answer to an extension request is in flight or failed to reach
 * the agent. The request stays on screen in both cases; a failure is
 * retryable.
 */
export type ExtensionResponseState = {
  id: string;
  status: "sending" | "failed";
  error?: string;
};
export type NoticeType = "info" | "success" | "warning" | "error";

export type NoticeItem = {
  id: string;
  message: string;
  type: NoticeType;
  exiting?: boolean;
};

type NoticeState = {
  visible: NoticeItem[];
  pending: NoticeItem[];
};

type NoticeAction =
  | { type: "add"; notice: NoticeItem }
  | { type: "mark_oldest_exiting" }
  | { type: "remove"; id: string };

export type AgentPhase =
  | { kind: "waiting_model" }
  | { kind: "running_command" }
  | { kind: "running_tools"; tools: { id: string; name: string; args: unknown }[] }
  | null;

export interface CompactResultInfo {
  reason: "manual" | "threshold" | "overflow" | "auto" | string;
  tokensBefore: number;
  estimatedTokensAfter: number;
}


export type BuiltinSlashCommandResult =
  | { handled: false }
  | { handled: true; message?: string; error?: string; prompt?: string; action?: "openSessionStats" };

/** 끝난 assistant 메시지 하나가 알려 주는 턴 결과. */
function completionOutcomeFor(message: { stopReason?: string; errorMessage?: string }): AgentCompletionOutcome {
  if (message.stopReason === "aborted") return "aborted";
  if (message.stopReason === "error" || message.errorMessage) return "failed";
  return message.stopReason ? "completed" : "unknown";
}

export type AgentCompletionOutcome = "completed" | "failed" | "aborted" | "unknown";

export interface AgentCompletionResult {
  outcome: AgentCompletionOutcome;
  sessionId: string | null;
  provider?: string;
  credentialId?: number;
}

export interface UseAgentSessionOptions {
  session: SessionInfo | null;
  newSessionCwd: string | null;
  initialData?: SessionData | null;
  transitioning?: boolean;
  onAgentEnd?: (completion: AgentCompletionResult) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest) => void;
  onSessionCreated?: (session: SessionInfo) => void;
  onSessionForked?: (newSessionId: string) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSessionStatsPanelOpen?: () => void;
  setToolPreset?: (preset: "none" | "default" | "full") => void;
}

export type ThinkingLevelOption = "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const PROGRAMMATIC_SCROLL_IGNORE_MS = 700;
const USER_SCROLL_INTENT_MS = 1200;
const AUTO_FOLLOW_BOTTOM_THRESHOLD_PX = 72;
const PROMPT_SETTLE_INITIAL_DELAY_MS = 800;
const PROMPT_SETTLE_POLL_MS = 600;
const PROMPT_SETTLE_MAX_MS = 20_000;
const EVENT_STREAM_IDLE_GRACE_MS = 30_000;
const AGENT_STATE_RECONCILE_MS = 15_000;
const CONTEXT_USAGE_REFRESH_MS = 1000;
const BASH_STATE_RECONCILE_MS = 1_000;
const EVENT_STREAM_CONNECT_TIMEOUT_MS = 5_000;
const MAX_NOTICES = 5;
const NOTICE_VISIBLE_MS = 5000;
const NOTICE_EXIT_ANIMATION_MS = 180;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " ", "Space", "Spacebar"]);

type EventStreamConnectionStatus = "connected" | "timeout" | "closed";

type EventStreamConnectionResult = {
  status: EventStreamConnectionStatus;
  source: EventSource;
};

type EventStreamConnectionAttempt = {
  source: EventSource;
  promise: Promise<EventStreamConnectionResult>;
  pending: boolean;
};

class EventStreamConnectionError extends Error {
  constructor(public readonly status: Exclude<EventStreamConnectionStatus, "connected">) {
    super(status === "timeout"
      ? "Timed out connecting to the agent event stream. Please try again."
      : "Failed to connect to the agent event stream. Please try again.");
    this.name = "EventStreamConnectionError";
  }
}

function createNoticeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function markOldestNoticeExiting(notices: NoticeItem[]): NoticeItem[] {
  const index = notices.findIndex((notice) => !notice.exiting);
  if (index === -1) return notices;
  return notices.map((notice, i) => (
    i === index ? { ...notice, exiting: true } : notice
  ));
}

function fillPendingNotices(visible: NoticeItem[], pending: NoticeItem[]): NoticeState {
  let nextVisible = visible;
  let nextPending = pending;
  while (nextPending.length > 0 && nextVisible.length < MAX_NOTICES) {
    const [next, ...rest] = nextPending;
    nextVisible = [...nextVisible, next];
    nextPending = rest;
  }
  if (nextPending.length > 0 && !nextVisible.some((notice) => notice.exiting)) {
    nextVisible = markOldestNoticeExiting(nextVisible);
  }
  return { visible: nextVisible, pending: nextPending };
}

function noticeReducer(state: NoticeState, action: NoticeAction): NoticeState {
  switch (action.type) {
    case "add": {
      if (state.visible.some((notice) => notice.exiting) || state.visible.length >= MAX_NOTICES) {
        return {
          visible: state.visible.some((notice) => notice.exiting)
            ? state.visible
            : markOldestNoticeExiting(state.visible),
          pending: [...state.pending, action.notice],
        };
      }
      return { ...state, visible: [...state.visible, action.notice] };
    }
    case "mark_oldest_exiting":
      return { ...state, visible: markOldestNoticeExiting(state.visible) };
    case "remove": {
      const visible = state.visible.filter((notice) => notice.id !== action.id);
      return fillPendingNotices(visible, state.pending);
    }
    default:
      return state;
  }
}

function extractMessageText(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object"
        && (block as { type?: string }).type === "text"
        && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "")
    .filter(Boolean)
    .join("\n");
}

function imageSignature(block: unknown): string {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return "";
  const source = (block as { source?: unknown }).source;
  if (source && typeof source === "object") {
    const src = source as { type?: unknown; media_type?: unknown; data?: unknown; url?: unknown };
    return [
      src.type === "url" ? "url" : "base64",
      typeof src.media_type === "string" ? src.media_type : "",
      typeof src.data === "string" ? src.data : "",
      typeof src.url === "string" ? src.url : "",
    ].join(":");
  }
  const flat = block as { data?: unknown; mimeType?: unknown };
  return [
    "base64",
    typeof flat.mimeType === "string" ? flat.mimeType : "",
    typeof flat.data === "string" ? flat.data : "",
    "",
  ].join(":");
}

function userMessageKey(message: Partial<AgentMessage>): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return JSON.stringify({ text: content, images: [] });
  if (!Array.isArray(content)) return JSON.stringify({ text: "", images: [] });
  return JSON.stringify({
    text: extractMessageText(message),
    images: content.map(imageSignature).filter(Boolean),
  });
}
interface SessionSnapshotPayload {
  sessionId: string;
  entryId: string;
  context: {
    messages: AgentMessage[];
    entryIds: string[];
  };
}

function snapshotMessageKey(message: AgentMessage): string {
  if (message.role === "user") return `user:${userMessageKey(message)}`;
  if (message.role === "bashExecution") {
    return JSON.stringify({
      role: message.role,
      command: message.command,
      output: message.output,
      exitCode: message.exitCode,
      cancelled: message.cancelled,
      truncated: message.truncated,
      fullOutputPath: message.fullOutputPath,
      excludeFromContext: message.excludeFromContext,
    });
  }
  const record = message as AgentMessage & {
    model?: string;
    provider?: string;
    customType?: string;
  };
  return JSON.stringify({
    role: message.role,
    content: message.content,
    model: record.model,
    provider: record.provider,
    customType: record.customType,
  });
}

/**
 * 영속 transcript snapshot을 현재 화면에 합친다. entryId가 같은 재연결 frame과 다른
 * 세션 frame은 버리고, 아직 서버 snapshot에 들어가지 않은 낙관적 입력만 꼬리에 보존한다.
 */
export function mergeSessionSnapshotEvent(
  event: AgentEvent,
  sessionId: string | null,
  knownEntryId: string | null,
  currentMessages: readonly AgentMessage[],
  currentEntryIds: readonly string[],
): { entryId: string; messages: AgentMessage[]; entryIds: string[] } | null {
  if (event.type !== "session_snapshot") return null;
  const payload = event as AgentEvent & Partial<SessionSnapshotPayload>;
  if (
    typeof payload.sessionId !== "string"
    || payload.sessionId !== sessionId
    || typeof payload.entryId !== "string"
    || payload.entryId === ""
    || payload.entryId === knownEntryId
    || !payload.context
    || !Array.isArray(payload.context.messages)
    || !Array.isArray(payload.context.entryIds)
    || payload.context.messages.length !== payload.context.entryIds.length
  ) return null;

  const canonicalMessages = payload.context.messages;
  const remainingCanonical = new Map<string, number>();
  for (const message of canonicalMessages) {
    const key = snapshotMessageKey(message);
    remainingCanonical.set(key, (remainingCanonical.get(key) ?? 0) + 1);
  }
  const trackedCount = Math.min(currentMessages.length, currentEntryIds.length);
  for (const message of currentMessages.slice(0, trackedCount)) {
    const key = snapshotMessageKey(message);
    const remaining = remainingCanonical.get(key) ?? 0;
    if (remaining > 0) remainingCanonical.set(key, remaining - 1);
  }
  const optimisticTail = currentMessages.slice(trackedCount).filter((message) => {
    const key = snapshotMessageKey(message);
    const remaining = remainingCanonical.get(key) ?? 0;
    if (remaining === 0) return true;
    remainingCanonical.set(key, remaining - 1);
    return false;
  });
  return {
    entryId: payload.entryId,
    messages: [...canonicalMessages, ...optimisticTail],
    entryIds: [...payload.context.entryIds],
  };
}



function readCompactResult(result: unknown, reason: string): CompactResultInfo | null {
  if (!result || typeof result !== "object") return null;
  const r = result as CompactCommandResult;
  if (typeof r.tokensBefore !== "number" || typeof r.estimatedTokensAfter !== "number") return null;
  return { reason, tokensBefore: r.tokensBefore, estimatedTokensAfter: r.estimatedTokensAfter };
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (content: string) => void;
  addAttachments: (files: File[]) => void;
  restoreSubmission: (
    text: string,
    images?: Array<{ data: string; mimeType: string }>,
    documents?: AttachedDocument[],
    targetDraftKey?: string,
  ) => void;
}

export interface AttachedImage {
  data: string;
  mimeType: string;
  previewUrl: string;
}

function toDraftImages(images?: AttachedImage[]): Array<{ data: string; mimeType: string }> | undefined {
  return images?.map(({ data, mimeType }) => ({ data, mimeType }));
}

type SelectedModel = { provider: string; modelId: string };
type ModelEntry = { id: string; name: string; provider: string };
type ModelsResponse = {
  models: Record<string, string>;
  modelList?: ModelEntry[];
  defaultModel?: SelectedModel | null;
  thinkingLevels?: Record<string, string[]>;
  thinkingLevelMaps?: Record<string, Record<string, string | null>>;
  thinkingLevelPins?: Record<string, string>;
  roles?: ModelRoleAssignment[];
  modelError?: string;
  modelScopeWarnings?: string[];
};

type SlashCommandsResponse = {
  commands?: SlashCommandInfo[];
};

export function useAgentSession(opts: UseAgentSessionOptions) {
  const {
    session, newSessionCwd, initialData, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked,
    modelsRefreshKey, onBranchDataChange, onSystemPromptChange, onSessionStatsPanelOpen,
  } = opts;

  const isNew = session === null && newSessionCwd !== null;
  const seededData = initialData && initialData.sessionId === session?.id ? initialData : null;

  const [data, setData] = useState<SessionData | null>(seededData);
  const [loading, setLoading] = useState(!isNew && !seededData);
  const [error, setError] = useState<string | null>(null);
  const [activeLeafId, setActiveLeafId] = useState<string | null>(seededData?.leafId ?? null);
  const [messages, setMessages] = useState<AgentMessage[]>(seededData?.context.messages ?? []);
  const [entryIds, setEntryIds] = useState<string[]>(seededData?.context.entryIds ?? []);
  const [streamState, dispatch] = useReducer(streamReducer, { isStreaming: false, streamingMessage: null });
  const [agentRunning, setAgentRunning] = useState(false);
  const [bashRunning, setBashRunning] = useState(false);
  const [pendingBash, setPendingBash] = useState<{ command: string; excludeFromContext: boolean } | null>(null);
  const [modelNames, setModelNames] = useState<Record<string, string>>({});
  const [modelList, setModelList] = useState<ModelEntry[]>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelScopeWarnings, setModelScopeWarnings] = useState<string[]>([]);
  const [modelThinkingLevels, setModelThinkingLevels] = useState<Record<string, string[]>>({});
  const [modelThinkingLevelMaps, setModelThinkingLevelMaps] = useState<Record<string, Record<string, string | null>>>({});
  const [modelRoles, setModelRoles] = useState<ModelRoleAssignment[]>([]);
  const [newSessionModel, setNewSessionModel] = useState<SelectedModel | null>(null);
  /** 새 대화에 대기 중인 계정 자리. 프리셋이 고른 값이며 화면 표시가 이 값을 본다. */
  const [newSessionAccount, setNewSessionAccount] = useState<number | null>(null);
  const [newSessionDefaultModel, setNewSessionDefaultModel] = useState<SelectedModel | null>(null);
  const [toolPreset, setToolPreset] = useState<"none" | "default" | "full">("default");
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevelOption>(() => {
    const seededLevel = seededData?.context.thinkingLevel;
    return seededLevel && seededLevel !== "off" ? seededLevel as ThinkingLevelOption : "auto";
  });
  const [effectiveThinkingLevel, setEffectiveThinkingLevel] = useState<string | undefined>();
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxAttempts: number; errorMessage?: string } | null>(null);
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(seededData?.contextUsage ?? null);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [forkingEntryId, setForkingEntryId] = useState<string | null>(null);
  const [currentModelOverride, setCurrentModelOverride] = useState<{ provider: string; modelId: string } | null>(null);
  const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactError, setCompactError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<CompactResultInfo | null>(null);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>(null);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [slashCommandsLoading, setSlashCommandsLoading] = useState(false);
  const [noticeState, dispatchNotice] = useReducer(noticeReducer, { visible: [], pending: [] });
  const [sessionStatsOverride, setSessionStatsOverride] = useState<SessionStatsInfo | null>(null);
  const [extensionDialog, setExtensionDialog] = useState<ExtensionUiDialogRequest | null>(null);
  /** Delivery state of the reader's answer to `extensionDialog`. */
  const [extensionResponse, setExtensionResponse] = useState<ExtensionResponseState | null>(null);
  const extensionResponseRef = useRef<ExtensionResponseState | null>(null);
  const [extensionCustomUi, setExtensionCustomUi] = useState<ExtensionUiCustomRequest | null>(null);
  const [extensionStatuses, setExtensionStatuses] = useState<ExtensionStatusItem[]>([]);
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidgetItem[]>([]);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessages>({ steering: [], followUp: [] });
  const [subagents, setSubagents] = useState<SubagentSnapshot[]>([]);
  const [todoSnapshot, setTodoSnapshot] = useState<{ sid: string; phases: TodoPhase[] } | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const eventSourceSessionIdRef = useRef<string | null>(null);
  const eventConnectionAttemptRef = useRef<EventStreamConnectionAttempt | null>(null);
  const sessionSnapshotSourceRef = useRef<EventSource | null>(null);
  const eventStreamGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventStreamGraceGenerationRef = useRef(0);
  const eventStreamGraceActiveRef = useRef(false);
  const sessionIdRef = useRef<string | null>(session?.id ?? null);
  // 현재 화면에 적용한 영속 transcript leaf. 같은 초기/reconnect snapshot을 한 번만 쓴다.
  const sessionSnapshotEntryIdRef = useRef<string | null>(seededData?.leafId ?? null);
  const messagesRef = useRef<AgentMessage[]>(messages);
  const entryIdsRef = useRef<string[]>(entryIds);
  messagesRef.current = messages;
  entryIdsRef.current = entryIds;
  // 이 탭에서 실행한 슬래시 명령 결과. 서버 transcript에 없으므로 transcript를 다시 받을 때마다
  // 같은 자리에 다시 끼운다. 한 세션의 결과만 들고, 세션이 바뀌면 비운다.
  const localCommandOutputsRef = useRef<{ sessionId: string | null; outputs: LocalCommandOutput[]; seq: number }>({
    sessionId: session?.id ?? null,
    outputs: [],
    seq: 0,
  });
  const agentRunningRef = useRef(false);
  const sdkAgentActiveRef = useRef(false);
  const rpcPromptPendingRef = useRef(false);
  const notifiedPromptRunIdRef = useRef(-1);
  const completionOutcomeRef = useRef<AgentCompletionOutcome>("unknown");
  const completionAssistantRef = useRef<{ provider: string; credentialId?: number } | null>(null);
  const bashRunningRef = useRef(false);
  const bashRecoveryIdRef = useRef(0);
  const handleAgentEventRef = useRef<((event: AgentEvent) => void) | null>(null);
  // A run the server starts after the main stream's idle grace closed it (a background result
  // or an extension-injected follow-up) reaches this view only through the entries stream.
  const serverRunStartRef = useRef<((sid: string) => void) | null>(null);
  const serverRunAdoptRef = useRef<Promise<void> | null>(null);
  const initialScrollDoneRef = useRef(false);
  const completionScrollAllowedRef = useRef(true);
  const [autoFollowPaused, setAutoFollowPaused] = useState(false);
  const [goalStatus, setGoalStatus] = useState<GoalStatusInfo | null>(null);
  const executeBashRef = useRef<(command: string, excludeFromContext: boolean) => Promise<void> | undefined>(undefined);
  const userScrollIntentUntilRef = useRef(0);
  const ignoreProgrammaticScrollUntilRef = useRef(0);
  // Forward reference: handleSend/executeBash are declared above setAutoFollow.
  const setAutoFollowRef = useRef<(following: boolean) => void>(() => {});
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const ensuringNewSessionRef = useRef<Promise<string | null> | null>(null);
  const newSessionPromotedRef = useRef(false);
  const newSessionModelOverrideRef = useRef<SelectedModel | null>(null);
  const newSessionAccountRef = useRef<number | null>(null);
  const thinkingLevelOverrideRef = useRef<ThinkingLevelOption | null>(null);
  // Freeze programmatic scrolling while an outgoing session-switch is pending
  // so the still-live transcript stops moving under the transition overlay.
  const transitioningRef = useRef(false);
  transitioningRef.current = opts.transitioning ?? false;
  // Right after a switch commits, positioning must be instant; a smooth crawl
  // reads as the transition itself wobbling.
  const mountedAtRef = useRef(Date.now());
  const promptRunIdRef = useRef(0);
  const contextUsageRequestIdRef = useRef(0);
  const optimisticUserMessageKeyRef = useRef<string | null>(null);
  const modelSwitchPendingRef = useRef(false);
  const liveTranscriptRefreshTailRef = useRef<Promise<void>>(Promise.resolve());

  const setToolPresetState = opts.setToolPreset ?? setToolPreset;

  const currentModel = currentModelOverride ?? data?.context.model ?? pendingModel ?? null;
  const displayModel = isNew ? (newSessionModel ?? newSessionDefaultModel) : currentModel;

  const sessionStats = useMemo(() => {
    if (sessionStatsOverride) {
      return { ...sessionStatsOverride, totalActiveMs: data?.totalActiveMs };
    }
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
    let cost = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolResults = 0;
    let toolCalls = 0;
    for (const msg of messages) {
      if (msg.role === "user") userMessages += 1;
      if (msg.role === "toolResult") toolResults += 1;
      if (msg.role !== "assistant") continue;
      assistantMessages += 1;
      const u = (msg as import("@/lib/types").AssistantMessage).usage;
      toolCalls += (msg as import("@/lib/types").AssistantMessage).content.filter((c) => c.type === "toolCall").length;
      if (!u) continue;
      tokens.input += u.input ?? 0;
      tokens.output += u.output ?? 0;
      tokens.cacheRead += u.cacheRead ?? 0;
      tokens.cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost?.total ?? 0;
    }
    tokens.total = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    if (tokens.total === 0 && messages.length === 0) return null;
    return {
      sessionFile: data?.filePath || undefined,
      sessionId: sessionIdRef.current ?? session?.id ?? "",
      sessionName: session?.name,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: messages.length,
      tokens,
      cost,
      totalActiveMs: data?.totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    } satisfies SessionStatsInfo;
  }, [messages, sessionStatsOverride, contextUsage, data?.filePath, data?.totalActiveMs, session?.id, session?.name]);

  // The tracker's own list for the open session. Two sources feed it: the `todo_changed` event the
  // harness emits on every tracker change (the live path - it is the only carrier for a change no
  // tool record makes), and the `get_state` snapshot this hook already reads at session open, on
  // reconnect, at turn end, and through the recovery net. A fetch carries no ordering information,
  // so the one that was in flight when a newer event landed is dropped rather than allowed to
  // overwrite it.
  const todoSeqRef = useRef(0);

  const applyTodoChange = useCallback((sid: string | null, phases: AgentStateResponse["todoPhases"]) => {
    if (!sid || sessionIdRef.current !== sid) return;
    if (!Array.isArray(phases)) return;
    const next = phases as TodoPhase[];
    todoSeqRef.current += 1;
    setTodoSnapshot((current) =>
      current?.sid === sid && sameTodoPhases(current.phases, next) ? current : { sid, phases: next },
    );
  }, []);

  const applyTodoSnapshot = useCallback((
    sid: string,
    phases: AgentStateResponse["todoPhases"],
    token: number,
  ) => {
    if (sessionIdRef.current !== sid) return;
    if (todoSeqRef.current !== token) return;
    if (!Array.isArray(phases)) return;
    const next = phases as TodoPhase[];
    setTodoSnapshot((current) =>
      current?.sid === sid && sameTodoPhases(current.phases, next) ? current : { sid, phases: next },
    );
  }, []);

  const updateMessages = useCallback((
    update: AgentMessage[] | ((current: AgentMessage[]) => AgentMessage[]),
  ) => {
    const next = typeof update === "function" ? update(messagesRef.current) : update;
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const updateEntryIds = useCallback((next: string[]) => {
    entryIdsRef.current = next;
    setEntryIds(next);
  }, []);

  const loadSession = useCallback(async (sid: string, showLoading = false, includeState = false, prefetchedData?: SessionData | null) => {
    let messagesLoaded = false;
    try {
      if (showLoading) setLoading(true);
      let d = prefetchedData ?? null;
      if (!d) {
        const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
        const res = await fetch(`/api/sessions/${encodeURIComponent(sid)}?${params}`);
        if (res.status === 404) {
          if (showLoading) {
            setData(null);
            setActiveLeafId(null);
            updateMessages([]);
            setError(null);
          }
          return null;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        d = await res.json() as SessionData;
      }
      if (sessionIdRef.current !== sid) return null;
      setData(d);
      setActiveLeafId(d.leafId);
      sessionSnapshotEntryIdRef.current = d.leafId ?? null;
      const transcript = withLocalCommandOutputs(
        d.context.messages,
        d.context.entryIds ?? [],
        localCommandOutputsRef.current.sessionId === sid ? localCommandOutputsRef.current.outputs : [],
      );
      updateMessages(transcript.messages);
      updateEntryIds(transcript.entryIds);
      setContextUsage(d.contextUsage ?? null);
      setCurrentModelOverride((current) => modelSwitchPendingRef.current ? current : null);
      setError(null);
      setThinkingLevel((d.context.configuredThinkingLevel ?? d.context.thinkingLevel ?? "off") as ThinkingLevelOption);
      setEffectiveThinkingLevel(d.context.thinkingLevel);

      messagesLoaded = true;
      if (showLoading) setLoading(false);
      if (!includeState) return null;

      try {
        const stateToken = todoSeqRef.current;
        const stateRes = await fetch(`/api/sessions/${encodeURIComponent(sid)}/state`);
        if (!stateRes.ok) throw new Error(`HTTP ${stateRes.status}`);
        const agentState = await stateRes.json() as { running: boolean; state?: AgentStateResponse };
        if (sessionIdRef.current !== sid) return null;

        const liveState = agentState.state;
        if (liveState) {
          if (liveState.contextUsage !== undefined) setContextUsage(liveState.contextUsage ?? null);
          if (liveState.systemPrompt !== undefined) setSystemPrompt(liveState.systemPrompt ?? null);
          if (liveState.thinkingLevel !== undefined) {
            setThinkingLevel((liveState.configuredThinkingLevel ?? liveState.thinkingLevel) as ThinkingLevelOption);
            setEffectiveThinkingLevel(liveState.thinkingLevel);
          }
          if (liveState.extensionStatuses !== undefined) setExtensionStatuses(liveState.extensionStatuses ?? []);
          if (liveState.extensionWidgets !== undefined) setExtensionWidgets(liveState.extensionWidgets ?? []);
          if (liveState.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(liveState.queuedMessages));
          if (liveState.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, liveState.subagents ?? []));
          applyTodoSnapshot(sid, liveState.todoPhases, stateToken);
        } else if (!agentState.running) {
          setQueuedMessages({ steering: [], followUp: [] });
        }
        return agentState;
      } catch (e) {
        console.error("Failed to load agent state:", e);
        return null;
      }
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      if (showLoading && !messagesLoaded) setLoading(false);
    }
  }, [applyTodoSnapshot, updateEntryIds, updateMessages]);

  /**
   * Final live turns arrive only after their session append is flushed. Keep
   * refreshes ordered so an older user-turn fetch cannot overwrite a newer
   * assistant-turn snapshot when both finish close together.
   */
  const refreshLiveTranscript = useCallback((sid: string): Promise<void> => {
    const refresh = liveTranscriptRefreshTailRef.current.then(async () => {
      if (sessionIdRef.current !== sid) return;
      await loadSession(sid);
    });
    liveTranscriptRefreshTailRef.current = refresh.catch(() => {});
    return refresh;
  }, [loadSession]);

  const loadContext = useCallback(async (sid: string, leafId: string | null) => {
    try {
      const params = new URLSearchParams({ deferThinking: "1", deferMedia: "1" });
      if (leafId) params.set("leafId", leafId);
      const url = `/api/sessions/${encodeURIComponent(sid)}/context?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json() as {
        context: { messages: AgentMessage[]; entryIds: string[] };
        contextUsage?: ContextUsage;
      };
      sessionSnapshotEntryIdRef.current = leafId;
      const transcript = withLocalCommandOutputs(
        d.context.messages,
        d.context.entryIds ?? [],
        localCommandOutputsRef.current.sessionId === sid ? localCommandOutputsRef.current.outputs : [],
      );
      updateMessages(transcript.messages);
      updateEntryIds(transcript.entryIds);
      setContextUsage(d.contextUsage ?? null);
    } catch (e) {
      console.error("Failed to load context:", e);
    }
  }, [updateEntryIds, updateMessages]);

  const loadTools = useCallback(async (sid: string) => {
    try {
      const tools = await sendAgentCommand<ToolEntry[]>(sid, { type: "get_tools" });
      if (tools) {
        const { getPresetFromTools } = await import("@/lib/tool-presets");
        setToolPresetState(getPresetFromTools(tools));
      }
    } catch (e) {
      console.error("Failed to load tools:", e);
    }
  }, [setToolPresetState]);

  const promoteNewSession = useCallback((messageCount = 0, firstMessage = "(no messages)") => {
    const sid = sessionIdRef.current;
    if (!isNew || !newSessionCwd || !sid || newSessionPromotedRef.current) return;
    newSessionPromotedRef.current = true;
    onSessionCreated?.({
      id: sid,
      path: "",
      cwd: newSessionCwd,
      name: undefined,
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount,
      firstMessage,
      transient: true,
    });
  }, [isNew, newSessionCwd, onSessionCreated]);

  const ensureNewSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!isNew || !newSessionCwd) return sessionIdRef.current;
    if (ensuringNewSessionRef.current) return ensuringNewSessionRef.current;

    const promise = (async () => {
      // Only send explicit user overrides. The server resolves the current
      // enabledModels scope atomically with AgentSession construction.
      const selectedModel = newSessionModelOverrideRef.current;
      const selectedThinkingLevel = thinkingLevelOverrideRef.current;
      const selectedAccount = newSessionAccountRef.current;
      if (selectedModel) setPendingModel(selectedModel);
      const toolNames = getToolNamesForPreset(toolPreset);
      const res = await fetch("/api/agent/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd: newSessionCwd,
          type: "ensure_session",
          toolNames,
          ...(selectedModel ? { provider: selectedModel.provider, modelId: selectedModel.modelId } : {}),
          ...(selectedThinkingLevel
            ? { thinkingLevel: selectedThinkingLevel }
            : {}),
          ...(selectedModel && selectedAccount !== null ? { oauthPosition: selectedAccount } : {}),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json() as {
        sessionId: string;
        model?: SelectedModel | null;
        thinkingLevel?: ThinkingLevelOption;
        configuredThinkingLevel?: ThinkingLevelOption;
      };
      const realId = result.sessionId;
      sessionIdRef.current = realId;
      if (result.model && newSessionModelOverrideRef.current === selectedModel) {
        setPendingModel(result.model);
        if (!selectedModel) setNewSessionDefaultModel(result.model);
      }
      if (
        result.thinkingLevel
        && thinkingLevelOverrideRef.current === selectedThinkingLevel
      ) {
        setThinkingLevel(result.configuredThinkingLevel ?? result.thinkingLevel);
        setEffectiveThinkingLevel(result.thinkingLevel);
      }
      return realId;
    })();

    ensuringNewSessionRef.current = promise;
    try {
      return await promise;
    } finally {
      ensuringNewSessionRef.current = null;
    }
  }, [isNew, newSessionCwd, toolPreset]);

  const loadSlashCommands = useCallback(async () => {
    const sid = sessionIdRef.current ?? await ensureNewSession();
    if (!sid) {
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    }
    setSlashCommandsLoading(true);
    try {
      const data = await sendAgentCommand<SlashCommandsResponse>(sid, { type: "get_commands" });
      const commands = data?.commands ?? [];
      setSlashCommands(commands);
      return commands;
    } catch (e) {
      console.error("Failed to load slash commands:", e);
      setSlashCommands([]);
      return [] as SlashCommandInfo[];
    } finally {
      setSlashCommandsLoading(false);
    }
  }, [ensureNewSession]);

  const cancelEventStreamGrace = useCallback(() => {
    eventStreamGraceGenerationRef.current += 1;
    eventStreamGraceActiveRef.current = false;
    if (eventStreamGraceTimerRef.current) {
      clearTimeout(eventStreamGraceTimerRef.current);
      eventStreamGraceTimerRef.current = null;
    }
  }, []);

  const closeEvents = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    eventSourceSessionIdRef.current = null;
    eventConnectionAttemptRef.current = null;
  }, []);

  const closeSessionSnapshots = useCallback(() => {
    sessionSnapshotSourceRef.current?.close();
    sessionSnapshotSourceRef.current = null;
  }, []);

  const connectSessionSnapshots = useCallback((sid: string) => {
    closeSessionSnapshots();
    const source = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events?entries=1`);
    sessionSnapshotSourceRef.current = source;
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as AgentEvent;
        if (event.type === "session_snapshot") handleAgentEventRef.current?.(event);
        else if (event.type === "agent_start") serverRunStartRef.current?.(sid);
      } catch {
        // EventSource reconnect와 다음 persisted snapshot이 복구를 맡는다.
      }
    };
  }, [closeSessionSnapshots]);

  const connectEvents = useCallback((sid: string): Promise<EventStreamConnectionResult> => {
    closeEvents();
    const es = new EventSource(`/api/agent/${encodeURIComponent(sid)}/events`);
    eventSourceRef.current = es;
    eventSourceSessionIdRef.current = sid;

    const promise = new Promise<EventStreamConnectionResult>((resolve) => {
      let settled = false;
      const settle = (status: EventStreamConnectionStatus) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (eventConnectionAttemptRef.current?.source === es) {
          eventConnectionAttemptRef.current.pending = false;
        }
        resolve({ status, source: es });
      };
      const timeout = setTimeout(() => settle("timeout"), EVENT_STREAM_CONNECT_TIMEOUT_MS);

      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as AgentEvent;
          if (event.type === "update_maintenance") {
            window.dispatchEvent(new CustomEvent("ompweb:update-maintenance", { detail: event }));
          }
          if (event.type === "connected") settle("connected");
          handleAgentEventRef.current?.(event);
        } catch {
          // ignore
        }
      };
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) {
          // Fatal error (404/500/content-type mismatch): browser won't
          // auto-reconnect. Settle the Promise and manually reconnect for
          // already-running sessions or an active idle grace window.
          settle("closed");
          if (eventSourceRef.current === es && (agentRunningRef.current || eventStreamGraceActiveRef.current)) {
            eventSourceRef.current = null;
            eventSourceSessionIdRef.current = null;
            eventConnectionAttemptRef.current = null;
            const reconnectGeneration = eventStreamGraceGenerationRef.current;
            setTimeout(() => {
              if (
                reconnectGeneration === eventStreamGraceGenerationRef.current
                && !eventSourceRef.current
                && (agentRunningRef.current || eventStreamGraceActiveRef.current)
              ) {
                void connectEvents(sid);
              }
            }, 1000);
          }
        }
        // Recoverable errors (CONNECTING): let EventSource auto-reconnect.
        // The timeout above resolves only to let callers decide whether this
        // connection must be ready before they continue.
      };
    });
    eventConnectionAttemptRef.current = { source: es, promise, pending: true };
    return promise;
  }, [closeEvents]);

  const ensureEventsConnected = useCallback(async (sid: string) => {
    const current = eventSourceRef.current;
    if (current && eventSourceSessionIdRef.current === sid) {
      if (current.readyState === EventSource.OPEN) return;
      const attempt = eventConnectionAttemptRef.current;
      if (attempt?.source === current && attempt.pending) {
        await attempt.promise;
        if (eventSourceRef.current === current && current.readyState === EventSource.OPEN) return;
      }
    }

    const result = await connectEvents(sid);
    if (result.status === "connected" || result.source.readyState === EventSource.OPEN) return;
    if (eventSourceRef.current === result.source) eventSourceRef.current = null;
    if (eventSourceSessionIdRef.current === sid) eventSourceSessionIdRef.current = null;
    if (eventConnectionAttemptRef.current?.source === result.source) eventConnectionAttemptRef.current = null;
    result.source.close();
    throw new EventStreamConnectionError(result.status);
  }, [connectEvents]);

  const respondToExtensionUi = useCallback(async (
    request: ExtensionUiDialogRequest,
    response: { value: string } | { confirmed: boolean } | { cancelled: true },
  ) => {
    // The agent is waiting on this request, so the surface stays until the
    // server accepts the response. Clearing it first loses the only way to
    // answer when the POST fails.
    const inFlight = extensionResponseRef.current;
    if (inFlight?.id === request.id && inFlight.status === "sending") return;
    const sid = sessionIdRef.current;
    const publish = (state: ExtensionResponseState | null) => {
      extensionResponseRef.current = state;
      setExtensionResponse(state);
    };
    if (!sid) {
      publish({ id: request.id, status: "failed", error: "no session" });
      return;
    }
    publish({ id: request.id, status: "sending" });
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_response",
        id: request.id,
        ...response,
      });
    } catch (e) {
      publish({ id: request.id, status: "failed", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    publish(null);
    setExtensionDialog((current) => current?.id === request.id ? null : current);
  }, []);

  const sendExtensionCustomInput = useCallback(async (request: ExtensionUiCustomRequest, data: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, {
        type: "extension_ui_input",
        id: request.id,
        data,
      });
    } catch (e) {
      console.error("Failed to send extension custom UI input:", e);
    }
  }, []);

  const addNotice = useCallback((notice: { id?: string; message: string; type?: NoticeType }) => {
    const message = notice.message.trim();
    if (!message) return;
    dispatchNotice({
      type: "add",
      notice: {
        id: notice.id ?? createNoticeId(),
        message,
        type: notice.type ?? "info",
      },
    });
  }, []);
  const appendCommandOutput = useCallback((text: string) => {
    const content = stripAnsi(text).trim();
    const message: CustomMessage = {
      role: "custom",
      customType: COMMAND_OUTPUT_CUSTOM_TYPE,
      content,
      display: true,
      timestamp: Date.now(),
    };
    const store = localCommandOutputsRef.current;
    const sid = sessionIdRef.current;
    if (store.sessionId !== sid) {
      store.sessionId = sid;
      store.outputs = [];
    }
    // 결과가 나온 시점의 마지막 기록 entry. 그 entry가 없는 branch로는 결과가 따라가지 않는다.
    const tracked = entryIdsRef.current.slice(0, messagesRef.current.length);
    let baseEntryId: string | null = null;
    for (let idx = tracked.length - 1; idx >= 0; idx--) {
      if (isLocalCommandEntryId(tracked[idx])) continue;
      baseEntryId = tracked[idx];
      break;
    }
    store.seq += 1;
    store.outputs.push({ entryId: `${LOCAL_COMMAND_ENTRY_PREFIX}${store.seq}`, baseEntryId, message });
    updateMessages((previous) => [...previous, message]);
  }, [updateMessages]);

  const handleExtensionUiRequest = useCallback((request: ExtensionUiRequest) => {
    if (request.method !== "custom" && "closed" in request && request.closed) {
      setExtensionDialog((current) => current?.id === request.id ? null : current);
      if (extensionResponseRef.current?.id === request.id) {
        extensionResponseRef.current = null;
        setExtensionResponse(null);
      }
      return;
    }

    if (isBlockingExtensionUiRequest(request)) onAttentionNeeded?.(request);

    switch (request.method) {
      case "select":
      case "confirm":
      case "input":
      case "editor":
      case "ask":
      case "plan_review":
        setExtensionDialog(request);
        break;
      case "notify": {
        addNotice({
          id: request.id,
          message: request.message,
          type: request.notifyType ?? "info",
        });
        break;
      }
      case "setStatus":
        setExtensionStatuses((prev) => {
          const rest = prev.filter((item) => item.key !== request.statusKey);
          return request.statusText !== undefined
            ? [...rest, { key: request.statusKey, text: request.statusText }]
            : rest;
        });
        break;
      case "setWidget":
        setExtensionWidgets((prev) => {
          const rest = prev.filter((item) => item.key !== request.widgetKey);
          return request.widgetLines
            ? [...rest, {
                key: request.widgetKey,
                lines: request.widgetLines,
                placement: request.widgetPlacement ?? "aboveEditor",
              }]
            : rest;
        });
        break;
      case "setTitle":
        if (request.title) document.title = request.title;
        break;
      case "set_editor_text":
        opts.chatInputRef?.current?.insertText(request.text);
        break;
      case "custom":
        setExtensionCustomUi((current) => {
          if (request.closed) return current?.id === request.id ? null : current;
          return request;
        });
        break;
    }
  }, [addNotice, onAttentionNeeded, opts.chatInputRef]);

  const settleUiStage = useCallback(() => {
    const wasRunning = agentRunningRef.current;
    agentRunningRef.current = false;
    setAgentRunning(false);
    setAgentPhase(null);
    setRetryInfo(null);
    dispatch({ type: "end" });
    return wasRunning;
  }, []);

  const readCompletionResult = useCallback((): AgentCompletionResult => {
    let outcome = completionOutcomeRef.current;
    let assistant = completionAssistantRef.current;
    // 마지막 응답의 message_end를 못 받은 턴(스트림 재연결·스냅샷 병합·재개 발화)은 여기서 "unknown"이라
    // 캐릭터 큐 대신 중립음만 났다. 화면에 이미 반영된 마지막 응답이 끝을 알고 있으면 그것으로 판정한다.
    if (outcome === "unknown") {
      const last = messagesRef.current[messagesRef.current.length - 1];
      if (last?.role === "assistant" && last.stopReason) {
        outcome = completionOutcomeFor(last);
        assistant ??= {
          provider: last.provider,
          ...(last.credentialId !== undefined ? { credentialId: last.credentialId } : {}),
        };
      }
    }
    return {
      outcome,
      sessionId: sessionIdRef.current,
      ...(assistant ? {
        provider: assistant.provider,
        ...(assistant.credentialId !== undefined ? { credentialId: assistant.credentialId } : {}),
      } : {}),
    };
  }, []);

  const notifyAgentEnd = useCallback(() => {
    onAgentEnd?.(readCompletionResult());
  }, [onAgentEnd, readCompletionResult]);

  const notifyPromptStage = useCallback((runId: number) => {
    if (notifiedPromptRunIdRef.current === runId) return false;
    notifiedPromptRunIdRef.current = runId;
    notifyAgentEnd();
    return true;
  }, [notifyAgentEnd]);

  const scheduleEventStreamClose = useCallback((sid: string) => {
    cancelEventStreamGrace();
    eventStreamGraceActiveRef.current = true;
    const generation = eventStreamGraceGenerationRef.current;

    const checkServerIdle = async () => {
      if (
        generation !== eventStreamGraceGenerationRef.current
        || sessionIdRef.current !== sid
        || !eventStreamGraceActiveRef.current
      ) return;

      try {
        const stateToken = todoSeqRef.current;
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;

        const state = data.state;
        setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
        applyTodoSnapshot(sid, state?.todoPhases, stateToken);
        const promptActive = Boolean(
          data.running
          && state
          && (state.isStreaming || state.isPromptRunning || state.isHandoffRunning)
        );
        if (promptActive) {
          eventStreamGraceActiveRef.current = false;
          eventStreamGraceTimerRef.current = null;
          sdkAgentActiveRef.current = Boolean(state?.isStreaming);
          rpcPromptPendingRef.current = Boolean(state?.isPromptRunning);
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase(state?.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
          return;
        }

        if (data.running && state?.isCompacting) {
          setIsCompacting(true);
          eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
          return;
        }
        if (data.running && (state?.subagents?.length ?? 0) > 0) {
          eventStreamGraceTimerRef.current = setTimeout(
            () => void checkServerIdle(),
            CONTEXT_USAGE_REFRESH_MS,
          );
          return;
        }


        eventStreamGraceActiveRef.current = false;
        eventStreamGraceTimerRef.current = null;
        closeEvents();
      } catch {
        // Keep the stream alive while state cannot be verified.
        if (
          generation !== eventStreamGraceGenerationRef.current
          || sessionIdRef.current !== sid
          || !eventStreamGraceActiveRef.current
        ) return;
        eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), PROMPT_SETTLE_POLL_MS);
      }
    };

    eventStreamGraceTimerRef.current = setTimeout(() => void checkServerIdle(), EVENT_STREAM_IDLE_GRACE_MS);
  }, [applyTodoSnapshot, cancelEventStreamGrace, closeEvents]);

  const finishPromptWithoutStream = useCallback(async (sid: string | null = sessionIdRef.current, runId = promptRunIdRef.current) => {
    // Bail out before loadSession too: a stale finish for a previous run
    // must not overwrite the messages of the run currently streaming.
    if (promptRunIdRef.current !== runId) return;
    try {
      if (sid) await loadSession(sid);
    } finally {
      if (promptRunIdRef.current !== runId) return;
      const promptWasPending = rpcPromptPendingRef.current;
      const agentWasActive = sdkAgentActiveRef.current;
      rpcPromptPendingRef.current = false;
      sdkAgentActiveRef.current = false;
      optimisticUserMessageKeyRef.current = null;
      const wasRunning = settleUiStage();
      if (promptWasPending) {
        notifyPromptStage(runId);
      } else if (agentWasActive && wasRunning) {
        notifyAgentEnd();
      }
      if (sid) scheduleEventStreamClose(sid);
    }
  }, [loadSession, notifyAgentEnd, notifyPromptStage, scheduleEventStreamClose, settleUiStage]);

  const waitForPromptSettlement = useCallback(async (sid: string, runId?: number) => {
    await delay(PROMPT_SETTLE_INITIAL_DELAY_MS);
    const startedAt = Date.now();

    while (agentRunningRef.current && Date.now() - startedAt < PROMPT_SETTLE_MAX_MS) {
      if (runId !== undefined && promptRunIdRef.current !== runId) return;
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (res.ok) {
          const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
          const state = data.state;
          if (!data.running || !state || (!state.isStreaming && !state.isPromptRunning)) {
            await finishPromptWithoutStream(sid, runId);
            return;
          }
        }
      } catch {
        // SSE remains the primary completion path.
      }
      await delay(PROMPT_SETTLE_POLL_MS);
    }
  }, [finishPromptWithoutStream]);

  const waitForBashSettlement = useCallback(async (sid: string) => {
    const recoveryId = bashRecoveryIdRef.current + 1;
    bashRecoveryIdRef.current = recoveryId;

    while (
      bashRunningRef.current
      && bashRecoveryIdRef.current === recoveryId
      && sessionIdRef.current === sid
    ) {
      await delay(BASH_STATE_RECONCILE_MS);
      try {
        const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
        if (!res.ok) continue;
        const data = await res.json() as { state?: AgentStateResponse };
        if (data.state?.isBashRunning) continue;

        await loadSession(sid);
        if (bashRecoveryIdRef.current !== recoveryId || sessionIdRef.current !== sid) return;
        bashRunningRef.current = false;
        setBashRunning(false);
        setPendingBash(null);
        return;
      } catch {
        // Keep polling while the page is mounted; network recovery is transparent.
      }
    }
  }, [loadSession]);

  // Reconcile client streaming state with the server. When SSE events are
  // missed (network drop, mobile tab backgrounded, half-open connection),
  // agent_end never arrives and the UI stays in streaming state forever.
  // If the server reports idle while we still think it's running, finish
  // through the same settlement path used by non-streaming prompts.
  const reconcileAgentState = useCallback(async (sid: string) => {
    if (!agentRunningRef.current) return;
    const runId = promptRunIdRef.current;
    try {
      const stateToken = todoSeqRef.current;
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { running?: boolean; state?: AgentStateResponse };
      // A slow response can straddle a run boundary (previous run finished
      // and the user already started the next one while this request was in
      // flight) — everything in it is stale, drop it.
      if (promptRunIdRef.current !== runId) return;
      const state = data.state;
      // Mirror compaction state unconditionally: a missed compaction_end
      // would otherwise leave the "Stop compaction" UI stuck. No state
      // (wrapper destroyed) means nothing is compacting.
      setIsCompacting(state?.isCompacting ?? false);
      setQueuedMessages(normalizeQueuedMessages(state?.queuedMessages));
      if (state?.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
      setSubagents((current) => mergeSubagentSnapshots(current, state?.subagents ?? []));
      applyTodoSnapshot(sid, state?.todoPhases, stateToken);
      const busy = data.running && state
        && (state.isStreaming || state.isPromptRunning || state.isCompacting || state.isHandoffRunning);
      if (busy || !agentRunningRef.current) return;
      if (state) {
        if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
        if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
        if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
      }
      await finishPromptWithoutStream(sid, runId);
    } catch {
      // Network still down — the next poll / visibility / online tick retries.
    }
  }, [applyTodoSnapshot, finishPromptWithoutStream]);
  /**
   * 이 화면 밖에서 이미 시작된 run에 다시 붙는다. 업데이트 자동 Wake처럼 서버만 아는 run은
   * 유휴 화면에 아무 신호도 주지 않는다 — 초기 snapshot은 한 번뿐이고 주 스트림은 화면이
   * 이미 running이라고 믿을 때만 붙는다. 그래서 복귀·재접속 신호에서 여기로 따라잡는다.
   * 붙었으면 true다.
   */
  const adoptRunningSession = useCallback(async (sid: string): Promise<boolean> => {
    const agentState = await loadSession(sid, false, true);
    const state = agentState?.state;
    if (
      !agentState?.running || !state
      || sessionIdRef.current !== sid
      || agentRunningRef.current
      || !(state.isStreaming || state.isPromptRunning || state.isHandoffRunning)
    ) return false;
    sdkAgentActiveRef.current = Boolean(state.isStreaming);
    rpcPromptPendingRef.current = Boolean(state.isPromptRunning);
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
    dispatch({ type: "start" });
    void connectEvents(sid);
    if (!state.isStreaming && state.isPromptRunning) void waitForPromptSettlement(sid);
    return true;
  }, [connectEvents, loadSession, waitForPromptSettlement]);
  const refreshContextUsage = useCallback(async (sid: string, runId = promptRunIdRef.current) => {
    const requestId = contextUsageRequestIdRef.current + 1;
    contextUsageRequestIdRef.current = requestId;
    try {
      const res = await fetch(`/api/agent/${encodeURIComponent(sid)}`);
      if (!res.ok) return;
      const data = await res.json() as { state?: AgentStateResponse };
      if (
        requestId !== contextUsageRequestIdRef.current
        || sessionIdRef.current !== sid
        || promptRunIdRef.current !== runId
      ) return;
      if (data.state?.contextUsage !== undefined) setContextUsage(data.state.contextUsage ?? null);
    } catch {
      // The next refresh retries; state reconciliation owns error recovery.
    }
  }, []);

  // Context usage changes after each model/tool turn, not only when the prompt
  // settles. Poll the lightweight state endpoint while the session is active
  // so the meter follows those changes even if an SSE event is missed.
  useEffect(() => {
    if (!agentRunning && !isCompacting) return;
    const refresh = () => {
      const sid = sessionIdRef.current;
      if (sid) void refreshContextUsage(sid);
    };
    refresh();
    const interval = setInterval(refresh, CONTEXT_USAGE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [agentRunning, isCompacting, refreshContextUsage]);


  // Recovery net for missed SSE events: while the agent is running, verify
  // against the server periodically and whenever the tab returns to the
  // foreground or the network comes back.
  useEffect(() => {
    if (!agentRunning) return;
    const reconcile = () => {
      // Read the ref on every tick: for brand-new sessions the id is
      // assigned only after ensure_session returns.
      const sid = sessionIdRef.current;
      if (sid) void reconcileAgentState(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") reconcile();
    };
    const interval = setInterval(reconcile, AGENT_STATE_RECONCILE_MS);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", reconcile);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", reconcile);
    };
  }, [agentRunning, reconcileAgentState]);


  // 유휴 화면은 서버에서 시작된 run을 스스로 알 수 없다. 탭이 다시 보이거나 네트워크가
  // 돌아올 때, 그리고 업데이트 복귀 확인이 이 세션의 run을 알릴 때 한 번만 확인해 그 run에
  // 다시 붙는다 — 상시 폴링은 두지 않는다.
  useEffect(() => {
    if (agentRunning) return;
    const catchUp = () => {
      const sid = sessionIdRef.current;
      if (sid && !agentRunningRef.current) void adoptRunningSession(sid);
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") catchUp();
    };
    // 복귀 확인 응답은 그 run이 실행 중으로 세워진 뒤(또는 발화 준비가 실패로 끝난 뒤)에만 온다.
    // 그런데도 idle이면 run은 이미 끝났고, 붙기 전에 읽은 transcript는 끝나기 전 것일 수 있으므로
    // 한 번 더 읽는다.
    const onUpdateWake = (event: Event) => {
      const sid = sessionIdRef.current;
      const target = (event as CustomEvent<{ sessionId?: unknown }>).detail?.sessionId;
      if (!sid || target !== sid || agentRunningRef.current) return;
      void adoptRunningSession(sid).then((attached) => {
        if (!attached && sessionIdRef.current === sid && !agentRunningRef.current) void loadSession(sid);
      });
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", catchUp);
    window.addEventListener(UPDATE_WAKE_EVENT, onUpdateWake);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", catchUp);
      window.removeEventListener(UPDATE_WAKE_EVENT, onUpdateWake);
    };
  }, [agentRunning, adoptRunningSession, loadSession]);
  // The main stream handles every run it is open for: this view's own prompts (they mark the
  // view running before sending) and runs inside the idle grace. Past the grace only the entries
  // stream still hears the server, so its run start re-attaches here the way F5 would: adopt a
  // run that is still going, or read the transcript of one that already finished.
  serverRunStartRef.current = (sid) => {
    if (
      sessionIdRef.current !== sid
      || agentRunningRef.current
      || eventSourceRef.current
      || serverRunAdoptRef.current
    ) return;
    const adopting = adoptRunningSession(sid)
      .then(async (attached) => {
        if (!attached && sessionIdRef.current === sid && !agentRunningRef.current) await loadSession(sid);
      })
      .catch(() => {})
      .finally(() => {
        if (serverRunAdoptRef.current === adopting) serverRunAdoptRef.current = null;
      });
    serverRunAdoptRef.current = adopting;
  };


  useEffect(() => {
    agentRunningRef.current = agentRunning;
  }, [agentRunning]);

  const handleAgentEvent = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case "session_snapshot": {
        const merged = mergeSessionSnapshotEvent(
          event,
          sessionIdRef.current,
          sessionSnapshotEntryIdRef.current,
          messagesRef.current,
          entryIdsRef.current,
        );
        if (!merged) break;
        sessionSnapshotEntryIdRef.current = merged.entryId;
        const transcript = withLocalCommandOutputs(
          merged.messages,
          merged.entryIds,
          localCommandOutputsRef.current.sessionId === sessionIdRef.current ? localCommandOutputsRef.current.outputs : [],
        );
        updateMessages(transcript.messages);
        updateEntryIds(transcript.entryIds);
        break;
      }
      case "agent_start": {
        const startingNewRun = !agentRunningRef.current;
        cancelEventStreamGrace();
        if (startingNewRun) {
          completionOutcomeRef.current = "unknown";
          completionAssistantRef.current = null;
        }
        sdkAgentActiveRef.current = true;
        agentRunningRef.current = true;
        setAgentRunning(true);
        setAgentPhase({ kind: "waiting_model" });
        dispatch({ type: "start" });
        break;
      }
      case "agent_end":
        // One logical prompt can emit multiple agent_end events before retrying,
        // compacting, or continuing messages queued by extension handlers.
        // Keep the stream open until prompt_done/agent_settled and the idle grace.
        if (!agentRunningRef.current) break;
        setAgentPhase(null);
        setRetryInfo(null);
        dispatch({ type: "end" });
        if (sessionIdRef.current) {
          loadSession(sessionIdRef.current);
          const stateToken = todoSeqRef.current;
          fetch(`/api/agent/${encodeURIComponent(sessionIdRef.current)}`)
            .then((r) => r.json())
            .then((d: { state?: AgentStateResponse }) => {
              if (d.state?.contextUsage !== undefined) setContextUsage(d.state.contextUsage ?? null);
              if (d.state?.systemPrompt !== undefined) setSystemPrompt(d.state.systemPrompt ?? null);
              if (d.state?.extensionStatuses !== undefined) setExtensionStatuses(d.state.extensionStatuses ?? []);
              if (d.state?.extensionWidgets !== undefined) setExtensionWidgets(d.state.extensionWidgets ?? []);
              if (d.state?.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, d.state?.subagents ?? []));
              if (sessionIdRef.current) applyTodoSnapshot(sessionIdRef.current, d.state?.todoPhases, stateToken);
              if (d.state?.goal !== undefined) setGoalStatus(d.state.goal ?? null);
              // Aborted turns can leave messages queued in pi (delivered with the
              // next turn); dead wrapper (no state) means the queue is gone.
              setQueuedMessages(normalizeQueuedMessages(d.state?.queuedMessages));
            })
            .catch(() => {});
        }
        break;
      case "goal_status":
        setGoalStatus((event.status as GoalStatusInfo | null | undefined) ?? null);
        break;
      case "agent_settled": {
        const agentWasActive = sdkAgentActiveRef.current;
        sdkAgentActiveRef.current = false;
        if (!agentWasActive || rpcPromptPendingRef.current) break;

        const sid = sessionIdRef.current;
        const wasRunning = settleUiStage();
        setIsCompacting(false);
        if (sid) {
          void loadSession(sid);
          scheduleEventStreamClose(sid);
        }
        if (wasRunning) notifyAgentEnd();
        break;
      }
      case "prompt_done":
        {
          const runId = promptRunIdRef.current;
          const promptWasPending = rpcPromptPendingRef.current;
          rpcPromptPendingRef.current = false;
          optimisticUserMessageKeyRef.current = null;
          const firstNotification = notifyPromptStage(runId);
          if (!promptWasPending && !firstNotification) break;

          const sid = sessionIdRef.current;
          if (sid) void loadSession(sid);
          // An extension-injected agent may already have started before the
          // command's prompt_done. Keep that active stage visible and let its
          // agent_settled event perform the next completion transition.
          if (!sdkAgentActiveRef.current) {
            settleUiStage();
            if (sid) scheduleEventStreamClose(sid);
          }
        }
        break;
      case "prompt_error":
        completionOutcomeRef.current = "failed";
        addNotice({ type: "error", message: (event.errorMessage as string | undefined) ?? "Command failed" });
        break;
      case "extension_error":
        completionOutcomeRef.current = "failed";
        addNotice({
          type: "error",
          message: (event.error as string | undefined) ?? "Extension command failed",
        });
        break;
      case "message_start":
      case "message_update": {
        // Ignore streaming events arriving after this run already finished
        // (e.g. SSE data buffered while the tab was frozen, flushed after
        // reconcile) — they would resurrect a ghost streaming bubble.
        if (!agentRunningRef.current) break;
        const msg = event.message as Partial<AgentMessage> | undefined;
        // The live bubble projection only consumes assistant block arrays;
        // custom/user/toolResult messages carry legitimate string-or-array
        // shapes that throw in splitAssistantBlockRuns.
        if (msg?.role !== "assistant") {
          break;
        }
        if (msg) {
          dispatch({ type: "update", message: normalizeToolCalls(msg as AgentMessage) });
        }
        setAgentPhase(null);
        break;
      }
      case "message_end": {
        // Same late-event guard: after reconcile finished this run,
        // loadSession already loaded this message from the session file —
        // appending it again would duplicate it.
        if (!agentRunningRef.current) break;
        const completed = event.message as AgentMessage | undefined;
        if (completed?.role === "assistant") {
          completionAssistantRef.current = {
            provider: completed.provider,
            ...(completed.credentialId !== undefined ? { credentialId: completed.credentialId } : {}),
          };
          completionOutcomeRef.current = completionOutcomeFor(completed);
        }
        if (completed && completed.role === "user") {
          // Delivered steering/follow-up messages surface here as user
          // messages. The run's initial prompt also emits one, but handleSend
          // already appended it optimistically. Consume only the still-adjacent
          // optimistic bubble; later same-text queue deliveries must render.
          const delivered = normalizeToolCalls(completed);
          const deliveredKey = userMessageKey(delivered);
          const optimisticKey = optimisticUserMessageKeyRef.current;
          optimisticUserMessageKeyRef.current = null;
          updateMessages((prev) => {
            const last = prev[prev.length - 1];
            if (optimisticKey && last?.role === "user" && userMessageKey(last) === optimisticKey) {
              return optimisticKey === deliveredKey
                ? prev
                : [...prev.slice(0, -1), delivered];
            }
            return [...prev, delivered];
          });
        } else if (completed) {
          updateMessages((prev) => [...prev, normalizeToolCalls(completed)]);
        }
        const sid = sessionIdRef.current;
        if (sid) void refreshContextUsage(sid);
        dispatch({ type: "reset" });
        setAgentPhase({ kind: "waiting_model" });
        break;
      }
      case "todo_changed": {
        // The harness reports every tracker change here, including the ones no tool call makes
        // (a `/todo` edit, `set_todos`, the completion a finished subagent triggers) - the live
        // path for this strip, with the transcript kept only as the fallback.
        applyTodoChange(sessionIdRef.current, event.phases as TodoPhase[] | undefined);
        break;
      }
      case "tool_execution_start": {
        const id = event.toolCallId as string;
        const name = event.toolName as string;
        const args = event.args as unknown;
        setAgentPhase((prev) => {
          const tools = prev?.kind === "running_tools" ? [...prev.tools] : [];
          if (!tools.some((t) => t.id === id)) tools.push({ id, name, args });
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "tool_execution_end": {
        const id = event.toolCallId as string;
        setAgentPhase((prev) => {
          if (prev?.kind !== "running_tools") return prev;
          const tools = prev.tools.filter((t) => t.id !== id);
          if (tools.length === 0) return { kind: "waiting_model" };
          return { kind: "running_tools", tools };
        });
        break;
      }
      case "subagent_lifecycle": {
        const payload = event.payload as {
          id?: string;
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          description?: string;
          status?: "started" | "completed" | "failed" | "aborted";
          sessionFile?: string;
          parentToolCallId?: string;
        } | undefined;
        if (!payload?.id) break;
        if (payload.status !== "started") {
          const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
            ? "failed"
            : payload.status === "aborted"
              ? "aborted"
              : "completed";
          setSubagents((current) => {
            const previous = current.find((subagent) => subagent.id === payload.id);
            const finished: SubagentSnapshot = {
              id: payload.id!,
              index: payload.index ?? previous?.index ?? 0,
              agent: payload.agent ?? previous?.agent ?? payload.id!,
              agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
              description: payload.description ?? previous?.description,
              status: terminalStatus,
              task: previous?.task,
              assignment: previous?.assignment,
              sessionFile: payload.sessionFile ?? previous?.sessionFile,
              parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
              lastUpdate: Date.now(),
              progress: previous?.progress ? { ...previous.progress, status: terminalStatus } : undefined,
            };
            return mergeSubagentSnapshots(current, [finished]);
          });
          break;
        }
        const started: SubagentSnapshot = {
          id: payload.id,
          index: payload.index ?? 0,
          agent: payload.agent ?? payload.id,
          agentSource: payload.agentSource ?? "bundled",
          description: payload.description,
          status: "running",
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [started]));
        break;
      }
      case "subagent_progress": {
        const payload = event.payload as {
          index?: number;
          agent?: string;
          agentSource?: SubagentSnapshot["agentSource"];
          task?: string;
          assignment?: string;
          sessionFile?: string;
          parentToolCallId?: string;
          progress?: SubagentSnapshot["progress"];
        } | undefined;
        if (!payload?.progress) break;
        const progress = payload.progress;
        const snapshot: SubagentSnapshot = {
          id: progress.id,
          index: payload.index ?? progress.index,
          agent: payload.agent ?? progress.agent,
          agentSource: payload.agentSource ?? "bundled",
          description: progress.description,
          status: progress.status,
          task: payload.task ?? progress.task,
          assignment: payload.assignment ?? progress.assignment,
          sessionFile: payload.sessionFile,
          parentToolCallId: payload.parentToolCallId,
          lastUpdate: Date.now(),
          progress,
        };
        setSubagents((previous) => mergeSubagentSnapshots(previous, [snapshot]));
        break;
      }
      case "queue_update":
        setQueuedMessages({
          steering: [...((event.steering as string[] | undefined) ?? [])],
          followUp: [...((event.followUp as string[] | undefined) ?? [])],
        });
        break;
      case "auto_retry_start":
        setRetryInfo({ attempt: event.attempt as number, maxAttempts: event.maxAttempts as number, errorMessage: event.errorMessage as string | undefined });
        break;
      case "auto_retry_end":
        setRetryInfo(null);
        break;
      case "auto_compaction_start":
      case "compaction_start":
        setIsCompacting(true);
        setCompactError(null);
        setCompactResult(null);
        break;
      case "auto_compaction_end":
      case "compaction_end":
        setIsCompacting(false);
        if (event.errorMessage) {
          setCompactError(event.errorMessage as string);
          setCompactResult(null);
        } else if (!event.aborted) {
          setCompactResult(readCompactResult(event.result, (event.reason as string | undefined) ?? "auto"));
          const sid = sessionIdRef.current;
          if (sid) {
            void loadSession(sid);
            void refreshContextUsage(sid);
          }
        }
        break;
      case "extension_ui_request":
        handleExtensionUiRequest(event as ExtensionUiRequest);
        break;
    }
  }, [addNotice, applyTodoChange, applyTodoSnapshot, cancelEventStreamGrace, handleExtensionUiRequest, loadSession, notifyAgentEnd, notifyPromptStage, refreshContextUsage, scheduleEventStreamClose, settleUiStage, updateEntryIds, updateMessages]);
  handleAgentEventRef.current = handleAgentEvent;

  const handleSend = useCallback(async (
    message: string,
    images?: AttachedImage[],
    documents?: AttachedDocument[],
  ) => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage && !images?.length && !documents?.length) return;
    // 프리셋/모델 전환이 진행 중이면 전송하지 않는다 — 새 대화의 생성 body가 바뀌는 중간
    // 선택을 실어 보내지 않게 한다(진행 중인 전환은 끝나면 다시 누를 수 있다).
    if (agentRunningRef.current || bashRunningRef.current || modelSwitchPendingRef.current) return;
    const promptMessage = composeDocumentPrompt(message, documents ?? []);
    const isSlashCommandPrompt = !images?.length && !documents?.length && trimmedMessage.startsWith("/");

    const isBashCommand = !images?.length && !documents?.length && trimmedMessage.startsWith("!");
    if (isBashCommand) {
      const isExcluded = trimmedMessage.startsWith("!!");
      const bashCmd = (isExcluded ? trimmedMessage.slice(2) : trimmedMessage.slice(1)).trim();
      if (!bashCmd) return;
      await executeBashRef.current?.(bashCmd, isExcluded);
      return;
    }

    completionOutcomeRef.current = "unknown";
    completionAssistantRef.current = null;
    const promptRunId = promptRunIdRef.current + 1;
    cancelEventStreamGrace();
    rpcPromptPendingRef.current = true;

    const imageBlocks = images?.map((img) => ({ type: "image" as const, source: { type: "base64" as const, media_type: img.mimeType, data: img.data } }));
    const userMsg: AgentMessage = {
      role: "user",
      content: imageBlocks?.length
        ? [...(promptMessage.trim() ? [{ type: "text" as const, text: promptMessage }] : []), ...imageBlocks]
        : promptMessage,
      timestamp: Date.now(),
    };
    updateMessages((prev) => [...prev, userMsg]);
    optimisticUserMessageKeyRef.current = userMessageKey(userMsg);
    promptRunIdRef.current = promptRunId;
    agentRunningRef.current = true;
    setAgentRunning(true);
    setAgentPhase(isSlashCommandPrompt ? { kind: "running_command" } : { kind: "waiting_model" });
    dispatch({ type: "start" });
    setAutoFollowRef.current(true);

    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    let sentSessionId: string | null = null;
    let promptRequestStarted = false;

    try {
      if (isNew && newSessionCwd) {
        const selectedModel = newSessionModel;
        const existingSid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        const sid = existingSid ?? await ensureNewSession();

        if (sid) {
          sentSessionId = sid;
          if (selectedModel) {
            setPendingModel(selectedModel);
            if (existingSid) {
              await sendAgentCommand(sid, { type: "set_model", provider: selectedModel.provider, modelId: selectedModel.modelId });
            }
          }
          await ensureEventsConnected(sid);
          promptRequestStarted = true;
          await sendAgentCommand(sid, {
            type: "prompt",
            message: promptMessage,
            ...(piImages?.length ? { images: piImages } : {}),
          });
          promoteNewSession(1, message);
        }
      } else if (session) {
        sentSessionId = session.id;
        await ensureEventsConnected(session.id);
        promptRequestStarted = true;
        await sendAgentCommand(session.id, {
          type: "prompt",
          message: promptMessage,
          ...(piImages?.length ? { images: piImages } : {}),
        });
      }
      if (isSlashCommandPrompt && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
      }
    } catch (e) {
      console.error("Failed to send message:", e);
      const maintenanceRejected = e instanceof AgentCommandError
        && e.code === "update_draining"
        && e.accepted === false;
      const definitivelyRejected = !promptRequestStarted || isPromptRejectedError(e) || maintenanceRejected;
      // A transport/proxy failure after dispatch is ambiguous: the server may
      // have accepted the prompt before the response was lost. Keep SSE alive
      // until server state confirms the run is idle.
      if (!definitivelyRejected && sentSessionId) {
        void waitForPromptSettlement(sentSessionId, promptRunId);
        return;
      }
      rpcPromptPendingRef.current = false;
      agentRunningRef.current = false;
      closeEvents();
      const optimisticKey = optimisticUserMessageKeyRef.current;
      if (optimisticKey) {
        updateMessages((prev) => {
          const last = prev[prev.length - 1];
          return last?.role === "user" && userMessageKey(last) === optimisticKey
            ? prev.slice(0, -1)
            : prev;
        });
      }
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      // The prompt never reached the agent, so restore the user's text and
      // attachments into the input instead of losing them. restoreSubmission
      // avoids clobbering anything typed since.
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
        session?.id ?? sentSessionId ?? undefined,
      );
      optimisticUserMessageKeyRef.current = null;
      setAgentRunning(false);
      setAgentPhase(null);
      dispatch({ type: "end" });
    }
  }, [isNew, newSessionCwd, newSessionModel, session, ensureNewSession, ensureEventsConnected, promoteNewSession, waitForPromptSettlement, addNotice, cancelEventStreamGrace, closeEvents, opts.chatInputRef, updateMessages]);

  const executeBash = useCallback(async (command: string, excludeFromContext: boolean) => {
    if (agentRunningRef.current || bashRunningRef.current) return;
    const inputText = `${excludeFromContext ? "!!" : "!"}${command}`;
    bashRunningRef.current = true;
    setAutoFollowRef.current(true);
    setPendingBash({ command, excludeFromContext });
    setBashRunning(true);
    try {
      const sid = sessionIdRef.current ?? session?.id ?? await ensureNewSession();
      if (!sid) throw new Error("Unable to create a session for the shell command");
      await sendAgentCommand(sid, {
        type: "bash",
        command,
        excludeFromContext,
      });
      await loadSession(sid);
      promoteNewSession(1, inputText);
    } catch (e) {
      console.error("Failed to execute shell command:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.insertIfEmpty(inputText);
    } finally {
      bashRunningRef.current = false;
      setPendingBash(null);
      setBashRunning(false);
    }
  }, [addNotice, ensureNewSession, loadSession, opts.chatInputRef, promoteNewSession, session]);
  executeBashRef.current = executeBash;

  const handleAbort = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    if (bashRunningRef.current) {
      try {
        await sendAgentCommand(sid, { type: "abort_bash" });
      } catch (e) {
        console.error("Failed to abort bash:", e);
      }
      return;
    }
    try {
      await sendAgentCommand(sid, { type: "abort" });
      completionOutcomeRef.current = "aborted";
    } catch (e) {
      console.error("Failed to abort:", e);
    }
  }, []);

  /**
   * Fork a new session from an explicit transcript entry, or from the latest
   * persisted user entry when invoked through `/fork`.
   */
  const handleFork = useCallback(async (
    entryId?: string,
  ): Promise<{ forked: boolean; error?: string }> => {
    if (bashRunningRef.current) return { forked: false, error: "Cannot fork while a shell command is running" };
    const sid = sessionIdRef.current;
    if (!sid) return { forked: false, error: "No active session to fork" };
    setForkingEntryId(entryId ?? null);
    try {
      const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string }>(sid, {
        type: "fork",
        ...(entryId ? { entryId } : {}),
      });
      const { cancelled, newSessionId } = result ?? {};
      if (!cancelled && newSessionId) {
        onSessionForked?.(newSessionId);
        return { forked: true };
      }
      return { forked: false, error: "Fork was cancelled" };
    } catch (e) {
      console.error("Fork failed:", e);
      return { forked: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      setForkingEntryId(null);
    }
  }, [onSessionForked]);

  const handleNavigate = useCallback(async (entryId: string) => {
    if (bashRunningRef.current) return;
    const sid = sessionIdRef.current;
    if (!sid) return;
    sendAgentCommand(sid, { type: "navigate_tree", targetId: entryId }).catch(() => {});
    setActiveLeafId(entryId);
    await loadContext(sid, entryId);
  }, [loadContext]);

  const handleLeafChange = useCallback(async (leafId: string | null) => {
    if (bashRunningRef.current) return;
    setActiveLeafId(leafId);
    const sid = sessionIdRef.current;
    if (!sid) return;
    await loadContext(sid, leafId);
    if (leafId) {
      sendAgentCommand(sid, { type: "navigate_tree", targetId: leafId }).catch(() => {});
    }
  }, [loadContext]);

  const handleModelChange = useCallback(async (provider: string, modelId: string) => {
    if (isNew) {
      const selectedModel = { provider, modelId };
      newSessionModelOverrideRef.current = selectedModel;
      // 계정 자리는 프리셋이 정한 값이다. 모델을 직접 고르면 그 선택은 더 이상 유효하지 않다.
      newSessionAccountRef.current = null;
      setNewSessionAccount(null);
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
      const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
      if (!sid) return;
      try {
        await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      } catch (e) {
        console.error("Failed to set model:", e);
      }
      return;
    }
    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return;
    const target = { provider, modelId };
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await sendAgentCommand(sid, { type: "set_model", provider, modelId });
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      modelSwitchPendingRef.current = false;
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set model:", e);
      modelSwitchPendingRef.current = false;
      setCurrentModelOverride(previousOverride);
      addNotice({
        type: "error",
        message: `Failed to switch model: ${e instanceof Error ? e.message : String(e)}`,
      });
      // A failed response can still follow a server-side write (for example, a
      // dropped connection), so let the session file settle the displayed model.
      await loadSession(sid);
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [addNotice, currentModelOverride, isNew, loadSession, setNewSessionModel]);

  /**
   * Apply one Main preset to this conversation — model, account, and thinking Auto as a
   * single action.
   *
   * The model and account travel through the existing selection paths only: a new
   * conversation carries them into the creation body (`/api/agent/new`), a live one
   * sends `set_model`. The server pins the account before the first provider request and
   * rolls the model back when the pin fails, so a failed preset keeps the previous
   * model, account affinity, and Auto selection instead of reporting success.
   */
  const handleMainPresetChange = useCallback(async (preset: MainPresetSelection): Promise<boolean> => {
    // 모델·계정·Auto를 **한 명령**으로 보낸다. 서버가 세 단계를 한 동작으로 수행하고, 어느
    // 단계든 실패하면 스냅샷으로 복원한 뒤 오류를 던지므로 여기서는 성공 여부만 본다 —
    // 성공으로 보고한 선택만 화면에 표시된다.
    const target = { provider: preset.provider, modelId: preset.modelId };
    const account = preset.oauthPosition;
    const modelCommand = {
      type: "set_model",
      provider: preset.provider,
      modelId: preset.modelId,
      thinkingLevel: "auto",
      ...(account !== undefined ? { oauthPosition: account } : {}),
    };
    const failure = (e: unknown) =>
      `${preset.alias} preset was not applied: ${e instanceof Error ? e.message : String(e)}`;

    if (isNew) {
      // 세션 생성이 진행 중이거나 앞선 선택이 아직 끝나지 않았으면 겹쳐 보내지 않는다.
      if (modelSwitchPendingRef.current) return false;
      modelSwitchPendingRef.current = true;
      setModelSwitching(true);
      // 지금까지의 override를 잡아 두고, 실패하면 그대로 되돌린다 — 실패한 프리셋이 다음
      // 전송에 실려 가지 않게 한다.
      const previousModelOverride = newSessionModelOverrideRef.current;
      const previousAccount = newSessionAccountRef.current;
      const previousThinkingOverride = thinkingLevelOverrideRef.current;
      const rollback = () => {
        newSessionModelOverrideRef.current = previousModelOverride;
        newSessionAccountRef.current = previousAccount;
        thinkingLevelOverrideRef.current = previousThinkingOverride;
      };
      try {
        // 전송·세션 생성이 이 값을 읽으므로 ref는 지금 세운다. 화면 상태는 적용이 확인된
        // 뒤에만 바꾼다 — 서버가 거절한 선택을 적용된 것처럼 체크하지 않는다.
        newSessionModelOverrideRef.current = target;
        newSessionAccountRef.current = account ?? null;
        thinkingLevelOverrideRef.current = "auto";

        const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
        if (sid) await sendAgentCommand(sid, modelCommand);
        // 여기까지 왔으면 선택이 적용됐다. 세션이 아직 없으면 첫 전송이 이 값으로 만든다.
        setNewSessionModel(target);
        setNewSessionAccount(account ?? null);
        setPendingModel(target);
        setThinkingLevel("auto");
        setEffectiveThinkingLevel(undefined);
        if (sid) await loadSession(sid);
        return true;
      } catch (e) {
        console.error("Failed to apply Main preset:", e);
        rollback();
        addNotice({ type: "error", message: failure(e) });
        const sid = sessionIdRef.current;
        if (sid) await loadSession(sid);
        return false;
      } finally {
        modelSwitchPendingRef.current = false;
        setModelSwitching(false);
      }
    }

    const sid = sessionIdRef.current;
    if (!sid || modelSwitchPendingRef.current) return false;
    const previousOverride = currentModelOverride;
    modelSwitchPendingRef.current = true;
    setCurrentModelOverride(target);
    setModelSwitching(true);
    try {
      await sendAgentCommand(sid, modelCommand);
      // Pi persists model_change synchronously. Reload the canonical session so
      // the model, thinking level, and active leaf all advance together.
      await loadSession(sid);
      return true;
    } catch (e) {
      console.error("Failed to apply Main preset:", e);
      setCurrentModelOverride(previousOverride);
      addNotice({ type: "error", message: failure(e) });
      // A failed response can still follow a server-side write, so let the session file
      // settle the displayed model.
      await loadSession(sid);
      return false;
    } finally {
      modelSwitchPendingRef.current = false;
      setModelSwitching(false);
    }
  }, [
    addNotice, currentModelOverride, effectiveThinkingLevel, isNew, loadSession,
    setNewSessionModel, thinkingLevel,
  ]);

  /**
   * Switch the session onto the model configured for one of omp's roles.
   *
   * The role is sent along, not just the model, so the transcript records which
   * role drove the change — the same thing `/model` does in the TUI, and what
   * lets omp resolve retry fallbacks for that role later.
   */
  const handleRoleModelChange = useCallback(async (role: string) => {
    const assignment = modelRoles.find((candidate) => candidate.role === role);
    const resolved = assignment?.resolved;
    if (!resolved) return;

    if (isNew) {
      const selectedModel = { provider: resolved.provider, modelId: resolved.modelId };
      const selectedThinkingLevel = resolved.thinkingLevel as ThinkingLevelOption | undefined;
      // A role selector can pin a level (`provider/model:high`). Preserve that
      // pin for deferred creation so the initial AgentSession receives it.
      thinkingLevelOverrideRef.current = selectedThinkingLevel ?? null;
      setThinkingLevel(selectedThinkingLevel ?? "auto");
      setEffectiveThinkingLevel(undefined);
      newSessionModelOverrideRef.current = selectedModel;
      newSessionAccountRef.current = null;
      setNewSessionAccount(null);
      setNewSessionModel(selectedModel);
      setPendingModel(selectedModel);
    }
    const sid = sessionIdRef.current ?? (isNew ? await ensuringNewSessionRef.current : null);
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_role_model", role });
      if (!isNew) setCurrentModelOverride({ provider: resolved.provider, modelId: resolved.modelId });
    } catch (e) {
      console.error("Failed to set role model:", e);
    }
  }, [isNew, modelRoles, setNewSessionModel]);

  const handleCompact = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid || isCompacting) return;
    setIsCompacting(true);
    setCompactError(null);
    setCompactResult(null);
    try {
      const result = await sendAgentCommand<CompactCommandResult>(sid, { type: "compact" });
      setCompactResult(readCompactResult(result, "manual"));
      await loadSession(sid, true);
    } catch (e) {
      setCompactError(e instanceof Error ? e.message : String(e));
      setCompactResult(null);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, loadSession]);

  const loadModels = useCallback(async (signal?: AbortSignal) => {
    const modelCwd = newSessionCwd ?? session?.cwd ?? "";
    const modelsUrl = modelCwd ? `/api/models?cwd=${encodeURIComponent(modelCwd)}` : "/api/models";
    const res = await fetch(modelsUrl, signal ? { signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json() as ModelsResponse;
    setModelNames(d.models);
    setModelError(d.modelError ?? null);
    setModelScopeWarnings(d.modelScopeWarnings ?? []);
    setModelThinkingLevels(d.thinkingLevels ?? {});
    setModelThinkingLevelMaps(d.thinkingLevelMaps ?? {});
    setModelRoles(d.roles ?? []);
    const nextModelList = d.modelList ?? [];
    setModelList(nextModelList);
    if (isNew && !sessionIdRef.current) {
      const match = d.defaultModel
        ? nextModelList.find((m) => m.id === d.defaultModel?.modelId && m.provider === d.defaultModel?.provider)
        : undefined;
      const displayModel = match ?? nextModelList[0];
      setNewSessionDefaultModel(displayModel ? { provider: displayModel.provider, modelId: displayModel.id } : null);
      // An `enabledModels` pattern may pin a thinking level (`anthropic/*:high`).
      // Like pi, apply it to the model a new session starts with.
      const pinned = displayModel && d.thinkingLevelPins?.[`${displayModel.provider}/${displayModel.id}`];
      if (thinkingLevelOverrideRef.current === null) {
        setThinkingLevel((pinned as ThinkingLevelOption | undefined) ?? "auto");
      }
    }
  }, [isNew, newSessionCwd, session?.cwd]);

  const handleBuiltinSlashCommand = useCallback(async (text: string): Promise<BuiltinSlashCommandResult> => {
    if (!text.startsWith("/")) return { handled: false };
    const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
    if (!match) return { handled: false };

    const [, commandName, rawArgs = ""] = match;
    const args = rawArgs.trim();
    const sid = sessionIdRef.current ?? await ensureNewSession();
    const complete = (result: BuiltinSlashCommandResult): BuiltinSlashCommandResult => {
      if (!result.handled) return result;
      if (result.error) {
        addNotice({ type: "error", message: result.error });
      } else if (result.action !== "openSessionStats") {
        addNotice({ type: "success", message: result.message ?? "Command completed" });
      }
      return result;
    };

    try {
      switch (commandName) {
        case "compact": {
          if (!sid || isCompacting) return complete({ handled: true, error: "No active session to compact" });
          setIsCompacting(true);
          setCompactError(null);
          setCompactResult(null);
          const result = await sendAgentCommand<CompactCommandResult>(sid, {
            type: "compact",
            ...(args ? { customInstructions: args } : {}),
          });
          setCompactResult(readCompactResult(result, "manual"));
          if (await loadSession(sid, true)) promoteNewSession();
          return complete({ handled: true, message: "Compacted context" });
        }

        case "reload": {
          if (!sid) return complete({ handled: true, error: "No active session to reload" });
          await sendAgentCommand(sid, { type: "reload" });
          await Promise.all([
            loadSession(sid, false, true),
            loadTools(sid),
            loadSlashCommands(),
            loadModels(),
          ]);
          return complete({ handled: true, message: "Reloaded session resources" });
        }

        case "name": {
          if (!sid) return complete({ handled: true, error: "No active session to name" });
          if (!args) return complete({ handled: true, error: "Usage: /name <name>" });
          await sendAgentCommand(sid, { type: "set_session_name", name: args });
          if (await loadSession(sid)) promoteNewSession();
          return complete({ handled: true, message: `Session renamed to ${args}` });
        }

        case "session": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const stats = await sendAgentCommand<SessionStatsInfo>(sid, { type: "get_session_stats" });
          if (stats) {
            setSessionStatsOverride(stats);
          }
          onSessionStatsPanelOpen?.();
          return complete({ handled: true, action: "openSessionStats" });
        }

        case "copy": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const data = await sendAgentCommand<LastAssistantTextResponse>(sid, { type: "get_last_assistant_text" });
          const textToCopy = data?.text ?? "";
          if (!textToCopy) return complete({ handled: true, error: "No assistant message to copy" });
          await navigator.clipboard.writeText(textToCopy);
          return complete({ handled: true, message: "Copied last assistant message" });
        }

        case "fork": {
          if (!sid) return complete({ handled: true, error: "No active session to fork" });
          const result = await handleFork();
          if (!result.forked) {
            return complete({ handled: true, error: result.error ?? "Fork failed" });
          }
          return complete({ handled: true, message: "Forked a new session" });
        }

        case "goal": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<GoalCommandResponse>(sid, { type: "goal", args });
          setGoalStatus(result?.status ?? null);
          if (result?.error) return complete({ handled: true, error: result.error });
          // `/goal show` output belongs in the transcript, not a toast that
          // disappears before it can be read.
          if (result?.message && result.message.includes("\n")) {
            appendCommandOutput(result.message);
            if (result.prompt) return { handled: true, prompt: result.prompt };
            return { handled: true };
          }
          if (result?.prompt) {
            if (result.message) addNotice({ type: "success", message: result.message });
            return { handled: true, prompt: result.prompt };
          }
          return complete({ handled: true, message: result?.message ?? "Command completed" });
        }

        case "handoff": {
          if (!sid) return complete({ handled: true, error: "No active session" });
          if (agentRunningRef.current || bashRunningRef.current) {
            return complete({ handled: true, error: "Cannot hand off while the session is busy" });
          }
          // Handoff generation is a long oneshot LLM call; keep the composer
          // busy through it with the existing agent-running state so a prompt
          // cannot race the compaction entry it commits.
          agentRunningRef.current = true;
          setAgentRunning(true);
          setAgentPhase({ kind: "running_command" });
          try {
            await ensureEventsConnected(sid);
            const result = await sendAgentCommand<{ cancelled?: boolean }>(sid, {
              type: "handoff",
              ...(args ? { customInstructions: args } : {}),
            });
            if (!result || result.cancelled) {
              return complete({ handled: true, error: "Handoff cancelled" });
            }
            // omp 18 hands off in place, so the session keeps its id and gains
            // a handoff compaction entry: reload this transcript rather than
            // navigating to a replacement session.
            if (await loadSession(sid, true)) promoteNewSession();
            return complete({ handled: true, message: "컨텍스트를 현재 세션에 압축했습니다" });
          } finally {
            agentRunningRef.current = false;
            setAgentRunning(false);
            setAgentPhase(null);
            if (sessionIdRef.current === sid) scheduleEventStreamClose(sid);
          }
        }

        default: {
          if (!sid) return complete({ handled: true, error: "No active session" });
          const result = await sendAgentCommand<{
            handled: boolean;
            output?: string[];
            prompt?: string;
          }>(sid, {
            type: "execute_slash_command",
            message: text,
          });
          if (!result?.handled) return { handled: false };
          const output = result.output?.filter((line) => line.trim()).join("\n\n") ?? "";
          if (output) appendCommandOutput(output);
          if (result.prompt) return { handled: true, prompt: result.prompt };
          if (output) return { handled: true };
          return complete({ handled: true, message: "Command completed" });
        }
      }
    } catch (e) {
      return complete({ handled: true, error: e instanceof Error ? e.message : String(e) });
    } finally {
      if (commandName === "compact") setIsCompacting(false);
    }
  }, [addNotice, appendCommandOutput, ensureEventsConnected, ensureNewSession, handleFork, isCompacting, loadModels, loadSession, loadSlashCommands, loadTools, promoteNewSession, onSessionStatsPanelOpen, scheduleEventStreamClose]);

  // Queued (undelivered) messages live in the queue panel only; the chat gets
  // the real user message when pi delivers it (user message_end event). An
  // optimistic chat bubble here would duplicate the queue panel and turn into
  // a ghost message if the queue is recalled.
  const handleSteer = useCallback(async (
    message: string,
    images?: AttachedImage[],
    documents?: AttachedDocument[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      addNotice({ type: "error", message: "The session is not ready yet, so the message was returned to the composer." });
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
      );
      return;
    }
    const promptMessage = composeDocumentPrompt(message, documents ?? []);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "steer",
        message: promptMessage,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to steer:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
        sid,
      );
    }
  }, [addNotice, opts.chatInputRef]);

  const handlePromptWithStreamingBehavior = useCallback(async (
    message: string,
    behavior: "steer" | "followUp",
    images?: AttachedImage[],
    documents?: AttachedDocument[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      addNotice({ type: "error", message: "The session is not ready yet, so the message was returned to the composer." });
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
      );
      return;
    }
    const promptMessage = composeDocumentPrompt(message, documents ?? []);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "prompt",
        message: promptMessage,
        streamingBehavior: behavior,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to queue prompt:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
        sid,
      );
    }
  }, [addNotice, opts.chatInputRef]);

  const handleFollowUp = useCallback(async (
    message: string,
    images?: AttachedImage[],
    documents?: AttachedDocument[],
  ) => {
    const sid = sessionIdRef.current;
    if (!sid) {
      addNotice({ type: "error", message: "The session is not ready yet, so the message was returned to the composer." });
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
      );
      return;
    }
    const promptMessage = composeDocumentPrompt(message, documents ?? []);
    const piImages = images?.map((img) => ({ type: "image" as const, data: img.data, mimeType: img.mimeType }));
    try {
      await sendAgentCommand(sid, {
        type: "follow_up",
        message: promptMessage,
        ...(piImages?.length ? { images: piImages } : {}),
      });
    } catch (e) {
      console.error("Failed to follow up:", e);
      addNotice({ type: "error", message: e instanceof Error ? e.message : String(e) });
      opts.chatInputRef?.current?.restoreSubmission?.(
        message,
        toDraftImages(images),
        documents,
        sid,
      );
    }
  }, [addNotice, opts.chatInputRef]);

  const handleAbortCompaction = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "abort_compaction" });
    } catch (e) {
      console.error("Failed to abort compaction:", e);
    }
  }, []);

  const handleRecallQueue = useCallback(async () => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    try {
      const result = await sendAgentCommand<{
        steering?: RestoredQueuedMessage[];
        followUp?: RestoredQueuedMessage[];
      }>(sid, { type: "clear_queue" });
      // clearQueue also emits an empty queue_update, but that only reaches us
      // while SSE is connected — clear locally so idle recalls update the UI.
      setQueuedMessages({ steering: [], followUp: [] });
      const recalled = mergeRestoredQueuedMessages([
        ...(result?.steering ?? []),
        ...(result?.followUp ?? []),
      ]);
      opts.chatInputRef?.current?.restoreSubmission?.(
        recalled.text,
        recalled.images.length ? recalled.images : undefined,
        undefined,
        sid,
      );
    } catch (e) {
      console.error("Failed to recall queued messages:", e);
      addNotice({ type: "error", message: "Failed to recall queued messages" });
    }
  }, [opts.chatInputRef, addNotice]);

  const handleThinkingLevelChange = useCallback(async (level: ThinkingLevelOption) => {
    setThinkingLevel(level);
    if (isNew && !sessionIdRef.current) {
      thinkingLevelOverrideRef.current = level;
    }
    setEffectiveThinkingLevel(undefined);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_thinking_level", level });
      await loadSession(sid);
    } catch (e) {
      console.error("Failed to set thinking level:", e);
      addNotice({ type: "error", message: "Failed to set thinking level" });
      await loadSession(sid);
    }
  }, [isNew, loadSession, addNotice]);

  const handleToolPresetChange = useCallback(async (preset: "none" | "default" | "full") => {
    const toolNames = getToolNamesForPreset(preset);
    setToolPresetState(preset);
    const sid = sessionIdRef.current ?? await ensuringNewSessionRef.current;
    if (!sid) return;
    try {
      await sendAgentCommand(sid, { type: "set_tools", toolNames });
    } catch (e) {
      console.error("Failed to set tools:", e);
    }
  }, [setToolPresetState]);

  // Single writer for the follow flag so the ref (read by the scroll effects)
  // and the state (read by the jump-to-bottom button) never drift apart.
  const setAutoFollow = useCallback((following: boolean) => {
    completionScrollAllowedRef.current = following;
    setAutoFollowPaused((paused) => (paused === !following ? paused : !following));
  }, []);
  setAutoFollowRef.current = setAutoFollow;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const resumeAutoFollow = useCallback(() => {
    // Clear any lingering intent window so the smooth scroll we are about to
    // start is not mistaken for the user scrolling away again.
    userScrollIntentUntilRef.current = 0;
    setAutoFollow(true);
    scrollToBottom("smooth");
  }, [scrollToBottom, setAutoFollow]);

  const markUserScrollIntent = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent) {
      if (!SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable='true']")) return;
    }
    userScrollIntentUntilRef.current = Date.now() + USER_SCROLL_INTENT_MS;
  }, []);

  const handleScrollPositionChange = useCallback(() => {
    if (!agentRunningRef.current && !bashRunningRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    // The auto-follow effect refreshes the programmatic-scroll window on every
    // streaming chunk, so during a stream it is always open. Honour a scroll
    // the user actually drove (wheel/touch/pointer/keys) regardless of it,
    // otherwise following could never be paused mid-turn.
    const userDriven = Date.now() <= userScrollIntentUntilRef.current;
    if (!userDriven && Date.now() < ignoreProgrammaticScrollUntilRef.current) return;
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    if (distanceFromBottom <= AUTO_FOLLOW_BOTTOM_THRESHOLD_PX) {
      setAutoFollow(true);
      return;
    }
    if (userDriven) {
      setAutoFollow(false);
    }
  }, [setAutoFollow]);

  // Load session on mount
  useEffect(() => {
    sessionIdRef.current = session?.id ?? null;
    if (localCommandOutputsRef.current.sessionId !== sessionIdRef.current) {
      localCommandOutputsRef.current = { sessionId: sessionIdRef.current, outputs: [], seq: 0 };
    }
    if (session) {
      loadSession(session.id, !seededData, true, seededData).then((agentState) => {
        if (sessionIdRef.current !== session.id) return;
        connectSessionSnapshots(session.id);
        if (agentState?.running) {
          loadTools(session.id);
          if (
            agentState.state?.isStreaming
            || agentState.state?.isPromptRunning
            || agentState.state?.isHandoffRunning
          ) {
            sdkAgentActiveRef.current = Boolean(agentState.state.isStreaming);
            rpcPromptPendingRef.current = Boolean(agentState.state.isPromptRunning);
            agentRunningRef.current = true;
            setAgentRunning(true);
            setAgentPhase(agentState.state.isStreaming ? { kind: "waiting_model" } : { kind: "running_command" });
            dispatch({ type: "start" });
            void connectEvents(session.id);
            if (!agentState.state.isStreaming && agentState.state.isPromptRunning) {
              void waitForPromptSettlement(session.id);
            }
          }
          if (agentState.state?.isBashRunning) {
            bashRunningRef.current = true;
            setBashRunning(true);
            void waitForBashSettlement(session.id);
          }
          if ((agentState.state?.subagents?.length ?? 0) > 0) {
            void connectEvents(session.id);
          }
        }
        const state = agentState?.state;
        if (state) {
          if (state.isCompacting !== undefined) setIsCompacting(state.isCompacting);
          if (state.contextUsage !== undefined) setContextUsage(state.contextUsage ?? null);
          if (state.systemPrompt !== undefined) setSystemPrompt(state.systemPrompt ?? null);
          if (state.thinkingLevel !== undefined) {
            setThinkingLevel((state.configuredThinkingLevel ?? state.thinkingLevel) as ThinkingLevelOption);
            setEffectiveThinkingLevel(state.thinkingLevel);
          }
          if (state.extensionStatuses !== undefined) setExtensionStatuses(state.extensionStatuses ?? []);
          if (state.extensionWidgets !== undefined) setExtensionWidgets(state.extensionWidgets ?? []);
          if (state.queuedMessages !== undefined) setQueuedMessages(normalizeQueuedMessages(state.queuedMessages));
          if (state.subagents !== undefined) setSubagents((current) => mergeSubagentSnapshots(current, state.subagents ?? []));
          if (state.goal !== undefined) setGoalStatus(state.goal ?? null);
        }
      });
    }
    return () => {
      bashRecoveryIdRef.current += 1;
      cancelEventStreamGrace();
      closeEvents();
      closeSessionSnapshots();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  useEffect(() => {
    onSystemPromptChange?.(systemPrompt);
  }, [systemPrompt, onSystemPromptChange]);

  useEffect(() => {
    if (!onBranchDataChange) return;
    onBranchDataChange(data?.tree ?? [], activeLeafId, handleLeafChange);
  }, [data?.tree, activeLeafId, handleLeafChange, onBranchDataChange]);

  useEffect(() => {
    window.addEventListener("keydown", markUserScrollIntent);
    return () => {
      window.removeEventListener("keydown", markUserScrollIntent);
    };
  }, [markUserScrollIntent]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener("pointerdown", markUserScrollIntent, { passive: true });
    container.addEventListener("wheel", markUserScrollIntent, { passive: true });
    container.addEventListener("touchstart", markUserScrollIntent, { passive: true });
    container.addEventListener("scroll", handleScrollPositionChange, { passive: true });
    return () => {
      container.removeEventListener("pointerdown", markUserScrollIntent);
      container.removeEventListener("wheel", markUserScrollIntent);
      container.removeEventListener("touchstart", markUserScrollIntent);
      container.removeEventListener("scroll", handleScrollPositionChange);
    };
  }, [messages.length, loading, handleScrollPositionChange, markUserScrollIntent]);

  useEffect(() => {
    if (transitioningRef.current) return;
    if ((!agentRunning && !bashRunning) || !completionScrollAllowedRef.current) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    const frame = requestAnimationFrame(() => {
      ignoreProgrammaticScrollUntilRef.current = Date.now() + PROGRAMMATIC_SCROLL_IGNORE_MS;
      container.scrollTo({ top: container.scrollHeight, behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [agentRunning, bashRunning, messages.length, streamState.streamingMessage, agentPhase, pendingBash, opts.transitioning]);

  useLayoutEffect(() => {
    if (messages.length === 0) return;
    if (!initialScrollDoneRef.current) {
      initialScrollDoneRef.current = true;
      scrollToBottom("instant");
      return;
    }
    if (transitioningRef.current) return;
    if (completionScrollAllowedRef.current) {
      const recentMount = Date.now() - mountedAtRef.current < 1500;
      scrollToBottom(agentRunningRef.current || bashRunningRef.current || recentMount ? "instant" : "smooth");
    }
  }, [messages.length, agentRunning, bashRunning, scrollToBottom, opts.transitioning]);

  // Load model list
  useEffect(() => {
    const controller = new AbortController();
    loadModels(controller.signal).catch((e) => {
      if (e instanceof DOMException && e.name === "AbortError") return;
    });
    return () => controller.abort();
  }, [loadModels, modelsRefreshKey]);

  useEffect(() => {
    if (!compactResult) return;
    const t = setTimeout(() => setCompactResult(null), 6000);
    return () => clearTimeout(t);
  }, [compactResult]);

  useEffect(() => {
    if (noticeState.visible.length === 0) return;
    const exiting = noticeState.visible.find((notice) => notice.exiting);
    if (exiting) {
      const t = setTimeout(() => {
        dispatchNotice({ type: "remove", id: exiting.id });
      }, NOTICE_EXIT_ANIMATION_MS);
      return () => clearTimeout(t);
    }
    const oldest = noticeState.visible[0];
    if (!oldest) return;
    const t = setTimeout(() => {
      dispatchNotice({ type: "mark_oldest_exiting" });
    }, NOTICE_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [noticeState.visible]);

  useEffect(() => {
    setSessionStatsOverride(null);
  }, [messages.length, contextUsage?.tokens, contextUsage?.percent, contextUsage?.contextWindow]);

  return {
    // State
    data, loading, error, activeLeafId, messages, entryIds, streamState,
    agentRunning, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, modelRoles, newSessionModel, toolPreset, thinkingLevel,
    effectiveThinkingLevel,
    retryInfo, contextUsage, systemPrompt, forkingEntryId,
    isCompacting, compactError, compactResult, currentModel, displayModel, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages, subagents,
    // The tracker's own list for the open session, when a state refresh has reported one. It can
    // carry changes no tool record does; the transcript remains the fallback and the newer answer
    // whenever a todo record is what changed last.
    todoPhases: todoSnapshot && todoSnapshot.sid === sessionIdRef.current ? todoSnapshot.phases : null,
    notices: noticeState.visible, extensionDialog, extensionResponse, extensionCustomUi, extensionStatuses, extensionWidgets, respondToExtensionUi, sendExtensionCustomInput,
    isAutoModelSelection: isNew && newSessionModel === null,
    agentPhase,
    isNew,
    autoFollowPaused, resumeAutoFollow,
    goalStatus,
    // Refs
    sessionIdRef, eventSourceRef, messagesEndRef, scrollContainerRef,
    // Actions
    handleSend, handleAbort, handleFork, handleNavigate, handleModelChange, handleRoleModelChange,
    handleMainPresetChange,
    newSessionAccount,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadTools, loadSlashCommands, ensureNewSession, refreshLiveTranscript, setActiveLeafId, setData, setMessages,
    dispatch, setAgentRunning, setForkingEntryId,
    bashRunning, pendingBash,
    // Subscriptions
    handleAgentEventRef,
  };
}
