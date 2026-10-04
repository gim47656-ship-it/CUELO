import type { TodoPhase } from "./todo-state";

// Types mirrored from pi-mono coding-agent session-manager

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content omitted from the initial response and loaded on demand. */
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  /**
   * 이 답을 실제로 만들어 낸 로컬 credential. 런타임이 어느 계정이 요청을 처리했는지
   * 알 때만 기록되므로 선택 필드다 — 이 필드가 없는 것이 곧 「모름」이고, 0·-1·null 같은
   * 대체값은 쓰지 않는다. 이 필드가 생기기 전에 기록된 항목은 그대로 읽혀야 한다.
   */
  credentialId?: number;
  stopReason?: string;
  errorMessage?: string;
  /** provider가 찍는 요청 시작 시각(ms). 생성이 끝난 시각이 아니다. */
  timestamp?: number;
  /** 코어가 message_end에 찍는 로컬 생성 종료 시각(ms). 이 필드가 생기기 전 기록에는 없다. */
  completedAt?: number;
  /**
   * 음성 통화 답변에서 실제로 말한 캐릭터. 답을 만든 모델은 `provider`·`model`(Codex Live)
   * 그대로이고, 말풍선의 얼굴·이름만 이 화자를 따른다. `mode: "native"`는 캐릭터 음성 대신
   * Codex 기본 음성으로 말한 경우다. 이 필드가 생기기 전 통화 기록에는 없다.
   */
  liveSpeaker?: { alias: string; mode: "character" | "native" };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  isError?: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface CustomMessage {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage;
export interface ExtensionAskDialogOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface ExtensionAskDialogQuestion {
  id: string;
  question: string;
  header?: string;
  options: ExtensionAskDialogOption[];
  multi?: boolean;
  recommended?: number;
}

export interface ExtensionAskDialogResultItem {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
  note?: string;
  /** The deadline passed with no answer and the recommendation was picked; not a user choice. */
  timedOut?: boolean;
}

export type ExtensionAskDialogResult =
  | { kind: "submit"; results: ExtensionAskDialogResultItem[] }
  | { kind: "chat" };

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "unknown";

export interface SubagentProgress {
  index: number;
  id: string;
  agent: string;
  status: SubagentStatus;
  task: string;
  assignment?: string;
  description?: string;
  lastIntent?: string;
  currentTool?: string;
  currentToolArgs?: string;
  currentToolStartMs?: number;
  recentTools: Array<{ tool: string; args: string; endMs: number }>;
  recentOutput: string[];
  toolCount: number;
  requests: number;
  tokens: number;
  contextTokens?: number;
  contextWindow?: number;
  cost: number;
  durationMs: number;
  resolvedModel?: string;
  resolvedModelIsFallback?: boolean;
  retryState?: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    errorMessage: string;
    startedAtMs: number;
  };
  retryFailure?: {
    attempt: number;
    errorMessage: string;
  };
}

export interface SubagentSnapshot {
  id: string;
  index: number;
  agent: string;
  agentSource: "bundled" | "user" | "project";
  description?: string;
  status: SubagentStatus;
  task?: string;
  assignment?: string;
  sessionFile?: string;
  lastUpdate: number;
  progress?: SubagentProgress;
  parentToolCallId?: string;
}


export type ExtensionUiRequest =
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
      expiresAt?: number;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "ask";
      questions: ExtensionAskDialogQuestion[];
      timeout?: number;
      expiresAt?: number;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "plan_review";
      title: string;
      planFilePath: string;
      planContent: string;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
      expiresAt?: number;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
      expiresAt?: number;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
      expiresAt?: number;
      closed?: boolean;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      lines: string[];
      closed?: boolean;
    };

export type BlockingExtensionUiRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "custom" }
>;

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export interface BranchPreview {
  role?: "user" | "assistant";
  text: string;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
  branchPreview?: BranchPreview;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string; // set if this session was forked from another
  /** Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** Branch name when cwd is a linked git worktree (not the main checkout) */
  worktreeBranch?: string;
  /** True while the runtime session exists only in memory and its JSONL file
   *  has not been created yet. Disk-backed actions must wait until this clears. */
  transient?: boolean;
}

/**
 * 최신 compaction이 화면 transcript에서 가린 구간(선택한 leaf의 가지만)에 남은 작업 기록.
 * 렌더하지 않는다 — 발주 원장·dock·발주 카드·todo 계산에만 화면 messages 앞에 이어 붙인다.
 */
export interface CompactedWork {
  /**
   * 가려진 구간의 축약 기록, root부터. user 경계 마커(본문 없음), `task` 호출(TASK_TITLE 한 줄로 축약),
   * 그 spawn 결과, 성공한 `routing_verdict`·`wait` 결과, `async-result`의 `<task-result>` 태그뿐이다.
   */
  messages: AgentMessage[];
  /** 가려진 구간의 마지막 durable todo(omp tracker가 가지에서 되살리는 규칙). 없으면 null. */
  todoPhases: TodoPhase[] | null;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  configuredThinkingLevel: string;
  /** 「Auto, 최대 X」 상한. 현재 가지의 마지막 CUELO 상한 기록이며 없거나 해제면 `null`. */
  thinkingCeiling: string | null;
  model: { provider: string; modelId: string } | null;
  /** 최신 compaction이 아무것도 가리지 않았으면 null. */
  compactedWork: CompactedWork | null;
}
