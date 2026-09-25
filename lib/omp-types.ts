import type {
  AgentSessionEvent,
  SessionManager,
  Settings,
  SlashCommandInfo as OmpSlashCommandInfo,
  Theme,
} from "@oh-my-pi/pi-coding-agent";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "./types";
import type { TodoPhase } from "./todo-state";
import type { AuthStorage, OAuthAccountSummary } from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";


export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

export interface OmpImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface RestoredQueuedMessage {
  text: string;
  images?: OmpImageContent[];
}

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill" | "custom" | "mcp_prompt" | "file";

export interface SlashCommandInfo {
  name: string;
  aliases?: string[];
  description?: string;
  input?: { hint: string };
  subcommands?: Array<{ name: string; description?: string; usage?: string }>;
  source: SlashCommandSource;
  location?: "user" | "project" | "path";
  path?: string;
}

export interface ModelLike {
  id: string;
  provider: string;
}

export interface ToolInfo {
  name: string;
  description: string;
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
  /** Estimated active time across all entries in the session file. */
  totalActiveMs?: number;
}

/** Where a slash command came from, in the shape the browser consumes. */
export type SlashCommandOrigin = Pick<OmpSlashCommandInfo, "location" | "path">;

interface PromptTemplateLike {
  name: string;
  description?: string;
  source?: string;
}

interface SkillLike {
  name: string;
  description?: string;
  source?: string;
  filePath?: string;
}

interface ExtensionRunnerLike {
  getRegisteredCommands(reserved?: ReadonlySet<string>): Array<{
    name: string;
    description?: string;
  }>;
  getExtensionPaths?(): string[];
  /** 해당 이벤트에 핸들러가 있는지. 없으면 이벤트를 만들지 않는다. */
  hasHandlers?(eventType: string): boolean;
  /**
   * SDK가 지원하는 `input` 이벤트 전달. 대화형 입력 컨트롤러와 같은 계약이다:
   * `handled`면 입력을 확장이 가져갔고, `text`/`images`가 오면 변환된 입력을 쓴다.
   */
  emitInput?(
    text: string,
    images: OmpImageContent[] | undefined,
    source: "interactive" | "rpc" | "extension",
  ): Promise<ExtensionInputResultLike | undefined>;
  emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
}

/** `emitInput` 반환. 확장이 입력을 가져갔는지(handled)와 변환된 입력을 담는다. */
export interface ExtensionInputResultLike {
  handled?: boolean;
  text?: string;
  images?: OmpImageContent[];
}

type DialogOptionsLike = {
  signal?: AbortSignal;
  timeout?: number;
};

type WidgetOptionsLike = {
  placement?: "aboveEditor" | "belowEditor";
};

export interface ExtensionUiContextLike {
  readonly timeoutStartsOnPresentation?: boolean;
  askDialog?(questions: ExtensionAskDialogQuestion[], opts?: DialogOptionsLike): Promise<ExtensionAskDialogResult | undefined>;
  select(title: string, options: string[], opts?: DialogOptionsLike): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptionsLike): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | ((...args: never[]) => unknown) | undefined, options?: WidgetOptionsLike): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T = unknown>(...args: unknown[]): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  getEditorText(): string;
  addAutocompleteProvider(): void;
  setEditorComponent(): void;
  getEditorComponent(): undefined;
  readonly theme: Theme;
  getAllThemes(): unknown[];
  getTheme(name: string): undefined;
  setTheme(theme: unknown): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

/**
 * 현재 모델 provider의 저장 OAuth 계정 목록과 이 세션이 실제로 쓰는 자리. 코어의
 * `listCurrentProviderOAuthAccounts()`가 돌려주는 모양이며, 자리(`position`)는 저장 순서다.
 */
export interface SessionOAuthAccountList {
  provider: string;
  accounts: OAuthAccountSummary[];
}

/**
 * Structural view of omp's `AgentSession`, narrowed to what CUELO drives.
 *
 * Keeping this structural (rather than importing the class) means an SDK bump
 * that widens an unrelated signature does not ripple through the app; only the
 * members listed here are contractual.
 */
export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  readonly modelRegistry: {
    find: (provider: string, modelId: string) => ModelLike | undefined;
    getAll: () => ModelLike[];
    getAvailable: () => ModelLike[];
    refresh: (strategy?: string) => Promise<unknown>;
    /**
     * Provider-scoped discovery — the SDK registry's `hasProvider` /
     * `refreshProvider`. Contractual because the missing-model recovery in
     * `lib/omp-runtime.ts` calls both on the session's own registry: a lookup
     * miss repairs the one provider that is missing instead of the full offline
     * reload, which cannot fetch and so cannot repair it.
     */
    hasProvider: (providerId: string) => boolean;
    refreshProvider: (providerId: string, strategy?: string) => Promise<void>;
    getProviderBaseUrl?: (provider: string) => string | undefined;
    /**
     * 계정 선호(pin)와 목록만 쓴다. 코어의 CLI 계정 selector와 프로필 character-voice가 쓰는
     * 것과 같은 AuthStorage 네임스페이스이며, 실행 계정 선택 정책(재시도·한도 폴백)은 코어가
     * 그대로 소유한다.
     */
    authStorage?: Pick<AuthStorage, "health" | "reload" | "oauth" | "sessions">;
  };
  readonly sessionManager: SessionManager;
  readonly settings: Settings;
  readonly agent: {
    state?: { systemPrompt?: string | string[]; thinkingLevel?: string };
    appendMessage(message: AgentMessage): void;
  };
  readonly extensionRunner: ExtensionRunnerLike | undefined;
  readonly promptTemplates: readonly PromptTemplateLike[];
  readonly skills: readonly SkillLike[];

  readonly bindExtensions?: unknown;
  listCurrentProviderOAuthAccounts?(): Promise<SessionOAuthAccountList | undefined>;
  reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
  refreshSkills?(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: {
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
    userInitiated?: boolean;
  }): Promise<boolean>;
  /**
   * Inject a message the user did not type, optionally running a turn for it.
   * The live voice surface delivers every Codex delegation this way, so the
   * requested work lands in the session transcript the user is already
   * watching instead of a side channel.
   */
  sendCustomMessage(
    message: { customType: string; content: string; display?: boolean; attribution?: "agent" | "user" },
    options?: { triggerTurn?: boolean },
  ): Promise<boolean>;
  abort(options?: { reason?: string }): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: { excludeFromContext?: boolean }): Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>;
  abortBash(): void;
  readonly isBashRunning: boolean;
  setModel(model: ModelLike, role?: string, options?: { selector?: string; thinkingLevel?: string; persist?: boolean }): Promise<{ switched: boolean }>;
  resolveRoleModel(role: string): ModelLike | undefined;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  branch(entryId: string): Promise<{ cancelled: boolean }>;
  /**
   * Generate a handoff document with a oneshot LLM call and commit it as this
   * session's compaction entry. omp 18 made this in-place: the session keeps
   * its id and file, and the document becomes the summary that recent history
   * is kept against. Resolves to `undefined` when the handoff is cancelled.
   */
  handoff(customInstructions?: string): Promise<{ document: string; savedPath?: string } | undefined>;
  setThinkingLevel(level: string | undefined, persist?: boolean): void;
  configuredThinkingLevel(): string | undefined;
  compact(customInstructions?: string): Promise<unknown>;
  getSessionStats(): Omit<SessionStatsInfo, "sessionName">;
  getLastAssistantText(): string | undefined;
  /**
   * The session tracker's own todo list - what every `todo` tool record is written from, and the
   * only place a change made outside the tool (a `/todo` edit, `set_todos`, a subagent completion
   * the harness reconciles) is visible. An empty list is the tracker saying there is no todo, not
   * "unknown"; `get_state` hands the client exactly this so a strip is never left showing a list
   * the tracker has already dropped.
   */
  getTodoPhases(): TodoPhase[];
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: OmpImageContent[]): Promise<void>;
  followUp(text: string, images?: OmpImageContent[]): Promise<void>;
  readonly queuedMessageCount: number;
  getQueuedMessages(): { steering: readonly string[]; followUp: readonly string[] };
  clearQueue(): { steering: RestoredQueuedMessage[]; followUp: RestoredQueuedMessage[] };
  getAllToolNames(): string[];
  getToolByName(name: string): { name: string; description?: string } | undefined;
  getActiveToolNames(): string[];
  getEnabledToolNames(): string[];
  setActiveToolsByName(names: string[]): Promise<void>;
  abortCompaction(): void;
  getPlanModeState?(): {
    enabled: boolean;
    planFilePath: string;
    workflow?: "parallel" | "sequential";
    reentry?: boolean;
  } | undefined;
  setPlanModeState?(state: {
    enabled: boolean;
    planFilePath: string;
    workflow?: "parallel" | "sequential";
    reentry?: boolean;
  } | undefined): void;
  setPlanProposalHandler?(handler: ((title: string) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }>) | null): void;
  preparePlanForReview?(title: string): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: { planFilePath?: string; title?: string; planExists?: boolean };
  }>;
  setPlanReferencePath?(path: string): void;
  getContextUsage(): { tokens: number; contextWindow: number; percent: number } | undefined;
  dispose?(options?: { keepAlive?: boolean }): Promise<void>;

  // Goal mode. omp drives these from the TUI only, so CUELO reproduces that
  // half itself (see lib/goal-mode.ts) on top of the same GoalRuntime.
  readonly goalRuntime: GoalRuntimeLike;
  getGoalModeState?(): GoalModeState | undefined;
  setGoalModeState?(state: GoalModeState | undefined): void;
  sendGoalModeContext(options?: { deliverAs?: "steer" | "followUp" | "nextTurn" }): Promise<void>;
  promptCustomMessage(
    message: { customType: string; content: string; display?: boolean; attribution?: "user" | "agent" },
    options?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void>;
}

/** The subset of omp's `GoalRuntime` CUELO drives. */
export interface GoalRuntimeLike {
  createGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState>;
  replaceGoal(input: { objective: string; tokenBudget?: number }): Promise<GoalModeState>;
  resumeGoal(): Promise<GoalModeState>;
  pauseGoal(): Promise<GoalModeState | undefined>;
  dropGoal(): Promise<Goal | undefined>;
  onThreadResumed(options?: { preserveActiveGoal?: boolean }): Promise<GoalModeState | undefined>;
  onBudgetMutated(newBudget: number | undefined): Promise<GoalModeState | undefined>;
  buildContinuationPrompt(): string | undefined;
  clearAccounting(): void;
}

/** What `GoalModeController` needs from a session; `AgentSessionLike` satisfies it. */
export type GoalModeSession = Pick<
  AgentSessionLike,
  | "isStreaming"
  | "sessionManager"
  | "settings"
  | "goalRuntime"
  | "getGoalModeState"
  | "setGoalModeState"
  | "sendGoalModeContext"
  | "getEnabledToolNames"
  | "setActiveToolsByName"
  | "getPlanModeState"
>;

/** Goal state as the browser sees it. */
export interface GoalStatusInfo {
  objective: string;
  status: string;
  enabled: boolean;
  tokensUsed: number;
  tokenBudget?: number;
  timeUsedSeconds: number;
}
