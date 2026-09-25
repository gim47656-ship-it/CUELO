import { cfgEnabledModels } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
  applyResolvedSystemPromptInputs,
  createAgentSession,
  type CreateAgentSessionOptions,
  discoverSessionExtensionPaths,
  getAgentDir,
  initTheme,
  SessionManager,
  Theme,
} from "@oh-my-pi/pi-coding-agent";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import { executeAcpBuiltinSlashCommand, type AcpBuiltinSlashCommandResult } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { BUILTIN_SLASH_COMMAND_DEFS } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { discoverCustomToolPaths } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import {
  readRpcSubagentTranscript,
  RpcSubagentRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@oh-my-pi/pi-tui";
import { randomUUID } from "crypto";
import { appendFileSync, existsSync, realpathSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { validateAgentImages } from "./image-attachments";
import { getDocumentPromptUserMessage } from "./document-attachments";
import { invalidateModelsCache } from "./models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "./model-scope";
import { cacheSessionPath, invalidateSessionListCache } from "./session-reader";
import { untrustedProjectSessionOptions } from "./project-trust";
import { resolveSessionSystemPrompts } from "./session-system-prompt";
import { readConfiguredModelRoleRefs, readDefaultModelRole } from "./model-roles";
import { findModelWithRecovery, getOmpRuntime, getSettingsForCwd, recoverMissingModelRefs } from "./omp-runtime";
import { describeMissingModel } from "./model-discovery-recovery";
import { PRESET_FULL } from "./tool-presets";
import type { SlashCommandInfo } from "./omp-types";
import { recordRuntimeActivity } from "./update-maintenance";
import { GoalModeController } from "./goal-mode";
import type {
  AgentSessionLike,
  ExtensionInputResultLike,
  ExtensionUiContextLike,
  OmpImageContent,
  SessionOAuthAccountList,
  ToolInfo,
} from "./omp-types";
import type {
  ExtensionAskDialogResult,
  ExtensionUiRequest,
  ExtensionUiResponse,
  ExtensionWidgetItem,
  SessionContext,
  SessionInfo,
  SessionMessageEntry,
  SubagentSnapshot,
} from "./types";
import { createHeadlessCustomUiTui, DEFAULT_CUSTOM_UI_COLUMNS } from "./custom-ui-terminal";

/**
 * 서버가 받은 사용자 스티어링을 한 줄씩 남긴다. 세션 기록(steering:true)과 대조해
 * 모델 대화에 기록되지 않은 스티어링(전달 누락)을 측정하기 위한 것이다.
 * 본문은 남기지 않고 길이만 남긴다. 기록 실패는 스티어링 전달을 막지 않는다.
 */
function recordSteeringReceived(sessionId: string | undefined, via: "steer" | "prompt", text: unknown): void {
  try {
    appendFileSync(
      join(getAgentDir(), "steering-received.jsonl"),
      `${JSON.stringify({ ts: Date.now(), sessionId: sessionId ?? null, via, length: typeof text === "string" ? text.length : 0 })}\n`,
    );
  } catch {
    // 측정용 기록이다. 실패해도 전달 경로에는 영향이 없어야 한다.
  }
}

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * genuine 사용자 요청 판별식. SDK `input` 이벤트(요청 단위 상태 — 예: command-guard의
 * task budget — 를 이 요청에서 리셋하는 유일한 지원 경로)를 발화할지 정한다.
 *
 * - `internalPrompt`: 하네스가 보내는 내부 지시문. 사용자 요청이 아니다.
 * - `streamingBehavior`: 실행 중인 턴에 큐잉되는 steer/follow_up 입력. 제품 의미의 독립
 *   사용자 prompt가 아니라 이미 진행 중인 요청의 연속이므로 새 예산·새 경계를 만들지 않는다.
 */
function isGenuineUserRequest(internalPrompt: boolean, streamingBehavior: string | undefined): boolean {
  return !internalPrompt && streamingBehavior === undefined;
}

type EventListener = (event: AgentEvent) => void;
export interface MessageUpdateCoalescer {
  push(event: AgentEvent): void;
  flush(): void;
  close(): void;
}

export interface SessionSnapshotEvent extends AgentEvent {
  type: "session_snapshot";
  sessionId: string;
  entryId: string;
  context: SessionContext;
}

export interface EventSubscriptionOptions {
  /** 열린 대화가 이 listener를 소유하는 동안 유휴 wrapper를 유지한다. */
  keepAlive?: boolean;
}

const MESSAGE_UPDATE_FRAME_MS = 33;

export function createMessageUpdateCoalescer(emit: EventListener): MessageUpdateCoalescer {
  let pendingUpdate: AgentEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (closed || !pendingUpdate) return;
    const event = pendingUpdate;
    pendingUpdate = null;
    emit(event);
  };

  const push = (event: AgentEvent) => {
    if (closed) return;
    if (event.type === "message_update") {
      pendingUpdate = event;
      if (!timer) {
        timer = setTimeout(() => {
          timer = undefined;
          flush();
        }, MESSAGE_UPDATE_FRAME_MS);
      }
      return;
    }
    flush();
    emit(event);
  };

  const close = () => {
    closed = true;
    pendingUpdate = null;
    clearTimeout(timer);
    timer = undefined;
  };

  return { push, flush, close };
}


type PendingUiResponse = {
  resolve: (response: ExtensionUiResponse) => void;
  cancel: () => void;
};

type CustomUiComponent = {
  render: (width: number) => string[];
  handleInput?: (data: string) => void;
  dispose?: () => void;
  invalidate?: () => void;
};

type ActiveCustomUi = {
  component: CustomUiComponent;
  width: number;
  resolve: (value: unknown) => void;
  settled: boolean;
};

type ExtensionUiRequestBody = Record<string, unknown> & {
  method: ExtensionUiRequest["method"];
  timeout?: number;
  expiresAt?: number;
};

type ExtensionBindingOptions = {
  forceEmptySystemPrompt?: boolean;
};

const RUNNING_STATE_EVENT_TYPES = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "auto_compaction_start",
  "auto_compaction_end",
  "compaction_start",
  "compaction_end",
]);

const IDLE_RESET_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "auto_compaction_end",
  "compaction_end",
]);

const MAX_SUBAGENT_HISTORY = 128;

const HANDOFF_ALLOWED_COMMAND_TYPES: Record<string, true> = {
  abort: true,
  extension_ui_input: true,
  extension_ui_response: true,
  get_commands: true,
  get_last_assistant_text: true,
  get_session_stats: true,
  get_state: true,
  get_subagent_messages: true,
  get_subagents: true,
  get_tools: true,
};

// 삭제를 위해 닫힘이 예약된 세션에서 새로 시작하면 안 되는 명령. 곧 지워질
// 기록에 쓰거나, 시작해도 결과를 돌려받지 못하는 작업들이다. 조회·중단·
// 확장 UI 응답은 종료 경로가 그대로 쓰므로 막지 않는다.
const CLOSING_REJECTED_COMMAND_TYPES: Record<string, true> = {
  bash: true,
  compact: true,
  follow_up: true,
  fork: true,
  handoff: true,
  prompt: true,
  steer: true,
};

// 모델·thinking 상태를 바꾸는 명령. Main 프리셋 transaction은 이 셋을 한 동작으로 수행하므로,
// 그 사이에 끼어든 다른 mutation은 복원이 그 성공을 덮지 않도록 이 세션 안에서만 거절한다.
// 조회·중단·steer·follow_up·확장 응답은 그대로 통과한다.
const MODEL_MUTATION_COMMAND_TYPES: Record<string, true> = {
  set_model: true,
  set_role_model: true,
  set_thinking_level: true,
};

type ForkBranchEntry = {
  id?: string;
  type?: string;
  message?: { role?: string };
};

export function resolveForkEntryId(
  entries: readonly ForkBranchEntry[],
  requestedEntryId?: unknown,
): string | undefined {
  if (typeof requestedEntryId === "string" && requestedEntryId.length > 0) return requestedEntryId;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type === "message" && entry.message?.role === "user" && entry.id) return entry.id;
  }
  return undefined;
}

export interface RpcSessionStartOptions {
  toolNames?: string[];
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ConfiguredThinkingLevel;
  /**
   * 저장 OAuth 계정을 stable storage position으로 지정한다. 세션이 등록·기동되기 전에
   * pin이 걸리므로 첫 명령이 provider에 닿을 때부터 그 계정이 쓰인다.
   */
  accountOauthPosition?: number;
}

type ProviderOAuthAccount = SessionOAuthAccountList["accounts"][number];

/** 이 세션에서 `provider`의 저장 OAuth 계정 목록. 화면이 읽는 것과 같은 목록이다. */
async function readProviderAccounts(
  session: AgentSessionLike,
  provider: string,
): Promise<{ ok: true; accounts: ProviderOAuthAccount[] } | { ok: false; reason: string }> {
  const authStorage = session.modelRegistry.authStorage;
  if (!authStorage?.oauth) {
    return { ok: false, reason: "이 세션은 OAuth 계정 목록을 읽을 수 없습니다." };
  }
  try {
    await authStorage.reload?.();
    return { ok: true, accounts: authStorage.oauth.accounts(provider, session.sessionId) };
  } catch (error) {
    return {
      ok: false,
      reason: `계정 목록을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 계정 자리를 바꾸기 전에 되돌릴 상태를 잡는다. 이전 모델의 provider와 바꿀 provider가 다를
 * 수 있으므로 **바꿀 provider**의 선호를 따로 잡는다 — provider가 다르면 이전 provider의
 * 선호는 손대지 않은 채 남으므로 되돌릴 것도 없다.
 */
export interface ProviderAccountSnapshot {
  provider: string;
  credentialId: number | undefined;
}

/** 스냅샷 조회 결과. 조회 실패를 "되돌릴 것 없음"으로 뭉개지 않는다. */
type ProviderAccountSnapshotResult =
  | { ok: true; snapshot: ProviderAccountSnapshot }
  | { ok: false; reason: string };

export async function snapshotProviderAccount(
  session: AgentSessionLike,
  provider: string,
): Promise<ProviderAccountSnapshotResult> {
  const listing = await readProviderAccounts(session, provider);
  if (!listing.ok) return { ok: false, reason: listing.reason };
  return { ok: true, snapshot: { provider, credentialId: listing.accounts.find((account) => account.active)?.credentialId } };
}

/** 스냅샷 상태로 되돌린다. 이전 선호가 없었으면 pin을 풀어 다음 요청이 다시 고르게 한다. */
export async function restoreProviderAccount(
  session: AgentSessionLike,
  snapshot: ProviderAccountSnapshot | undefined,
): Promise<boolean> {
  if (!snapshot) return false;
  const authStorage = session.modelRegistry.authStorage;
  if (!authStorage) return false;
  try {
    if (snapshot.credentialId !== undefined) {
      return authStorage.sessions?.pin(snapshot.provider, session.sessionId, snapshot.credentialId) ?? false;
    }
    return authStorage.sessions?.release(snapshot.provider, session.sessionId) ?? false;
  } catch {
    return false;
  }
}

/**
 * 자리 번호로 지정한 저장 OAuth 계정을 세션의 선호 계정으로 설정하고, 그 자리가 실제로
 * 설정됐는지 같은 목록을 다시 읽어 확인한다. 자리 이름은 roster의 `oauth-position`이고 pin은
 * durable credential id를 받으므로 화면이 읽는 것과 같은 목록에서 자리를 해석한다. 그 자리가
 * 없거나 설정되지 않으면 실패로 끝내고 다른 계정으로 대체하지 않는다.
 *
 * 이 확인이 보증하는 것은 **세션에 설정된 선호**뿐이다. 코어의 정상 재시도·사용량 한도
 * 폴백은 선호를 쓸 수 없을 때 다른 계정으로 넘어갈 수 있고, 그 정책은 여기서 바꾸지 않는다.
 */
export async function pinProviderAccount(
  session: AgentSessionLike,
  provider: string,
  oauthPosition: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!Number.isSafeInteger(oauthPosition) || oauthPosition < 0) {
    return { ok: false, reason: `OAuth 저장 위치 ${String(oauthPosition)}가 올바르지 않습니다.` };
  }
  if (!session.modelRegistry.authStorage?.sessions) {
    return { ok: false, reason: "이 세션은 OAuth 계정 pin을 지원하지 않습니다." };
  }
  const listing = await readProviderAccounts(session, provider);
  if (!listing.ok) return { ok: false, reason: listing.reason };
  if (listing.accounts.length === 0) return { ok: false, reason: "저장된 OAuth 계정이 없습니다." };
  const account = listing.accounts.find(
    (candidate, index) => (Number.isInteger(candidate.position) ? candidate.position : index) === oauthPosition,
  );
  if (!account) {
    return { ok: false, reason: `${provider} OAuth 저장 위치 ${oauthPosition}의 계정이 없습니다.` };
  }
  let pinned = false;
  try {
    pinned = session.modelRegistry.authStorage.sessions.pin(provider, session.sessionId, account.credentialId);
  } catch {
    pinned = false;
  }
  if (!pinned) {
    return {
      ok: false,
      reason: `${provider} OAuth 저장 위치 ${oauthPosition} 계정을 이 세션의 선호 계정으로 설정하지 못했습니다.`,
    };
  }
  const applied = await readProviderAccounts(session, provider);
  const appliedAccount = applied.ok
    ? applied.accounts.find(
        (candidate, index) => (Number.isInteger(candidate.position) ? candidate.position : index) === oauthPosition,
      )
    : undefined;
  if (appliedAccount?.active !== true) {
    return {
      ok: false,
      reason: `${provider} OAuth 저장 위치 ${oauthPosition}이 이 세션의 선호 계정으로 설정되지 않았습니다.`,
    };
  }
  return { ok: true };
}

/**
 * 프리셋 transaction이 실패했을 때 세 단계를 스냅샷으로 되돌린다. 각 복원의 **실제 결과**를
 * 그대로 돌려주므로 호출자는 되돌아간 것과 안 된 것을 구분해 보고할 수 있다.
 *
 * configured thinking은 모델 복원이 다시 clamp할 수 있으므로 모델 뒤에 되돌리고 값을 확인한다.
 */
async function rollbackModelTransaction(
  session: AgentSessionLike,
  snapshot: {
    previousModel: AgentSessionLike["model"];
    previousRole: string | undefined;
    previousThinking: string | undefined;
    account: ProviderAccountSnapshot | undefined;
  },
): Promise<{ model: boolean; account: boolean; thinking: boolean }> {
  const model = await restoreModel(session, snapshot.previousModel, snapshot.previousRole);
  const account = snapshot.account === undefined
    ? true
    : await restoreProviderAccount(session, snapshot.account);
  let thinking = true;
  if (snapshot.previousThinking !== undefined && session.configuredThinkingLevel() !== snapshot.previousThinking) {
    try {
      session.setThinkingLevel(snapshot.previousThinking);
    } catch {
      // 아래에서 실제 값으로 판정한다.
    }
    thinking = session.configuredThinkingLevel() === snapshot.previousThinking;
  }
  return { model, account, thinking };
}

/** 복원 결과를 그대로 말로 옮긴다. 실패한 항목이 있으면 성공을 주장하지 않는다. */
function describeRollback(result: { model: boolean; account: boolean; thinking: boolean }): string {
  const failed: string[] = [];
  if (!result.model) failed.push("모델");
  if (!result.account) failed.push("계정 선호");
  if (!result.thinking) failed.push("thinking 강도");
  return failed.length === 0
    ? "모델·계정·강도를 되돌렸습니다."
    : `${failed.join("·")} 복원에 실패했습니다 — 이전 상태로 돌아가지 않았습니다.`;
}

/** 이 세션에 기록된 마지막 model_change의 role. 되돌릴 때 그 role 기록도 함께 되돌린다. */
function lastModelChangeRole(session: AgentSessionLike): string | undefined {
  try {
    const branch: unknown = session.sessionManager.getBranch();
    if (!Array.isArray(branch)) return undefined;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index] as { type?: unknown; role?: unknown } | undefined;
      if (entry?.type === "model_change") return typeof entry.role === "string" ? entry.role : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 방금 바꾼 모델을 스냅샷으로 되돌린다. 아직 그대로면 복원할 것이 없다. */
async function restoreModel(
  session: AgentSessionLike,
  previousModel: AgentSessionLike["model"],
  previousRole: string | undefined,
): Promise<boolean> {
  if (!previousModel) return false;
  const current = session.model;
  if (current?.provider === previousModel.provider && current?.id === previousModel.id) return true;
  try {
    await session.setModel(previousModel, previousRole);
    return true;
  } catch {
    return false;
  }
}

const CODING_TOOL_NAMES: Record<string, true> = Object.fromEntries(
  PRESET_FULL.map((name) => [name, true]),
);

// Extensions require a complete Theme, while the web UI applies its own styling.
class PlainTextTheme extends Theme {
  constructor() {
    super(
      { thinkingXhigh: "" } as ConstructorParameters<typeof Theme>[0],
      {} as ConstructorParameters<typeof Theme>[1],
      "truecolor",
      "unicode",
      {},
    );
  }

  override fg(...[, text]: Parameters<Theme["fg"]>): string { return text; }
  override bg(...[, text]: Parameters<Theme["bg"]>): string { return text; }
  override bold(text: string): string { return text; }
  override italic(text: string): string { return text; }
  override underline(text: string): string { return text; }
  override inverse(text: string): string { return text; }
  override strikethrough(text: string): string { return text; }
  override getFgAnsi(): string { return ""; }
  override getBgAnsi(): string { return ""; }
  override getThinkingBorderColor(): (text: string) => string {
    return (text) => text;
  }
  override getBashModeBorderColor(): (text: string) => string { return (text) => text; }
}

const PLAIN_TEXT_THEME = new PlainTextTheme();
const CUSTOM_UI_KEYBINDINGS = new TuiKeybindingsManager(TUI_KEYBINDINGS);

function withExtensionTools(session: AgentSessionLike, toolNames: string[]): string[] {
  if (toolNames.length === 0) return [];

  const extensionToolNames = session
    .getAllToolNames()
    .filter((name) => CODING_TOOL_NAMES[name] !== true);

  return [...new Set([...toolNames, ...extensionToolNames])];
}

/** Tool descriptors for the browser's tool picker. */
function listTools(session: AgentSessionLike): ToolInfo[] {
  return session.getAllToolNames().map((name) => ({
    name,
    description: session.getToolByName(name)?.description ?? "",
  }));
}

type AvailableCommandsSession = Parameters<typeof buildAvailableSlashCommands>[0];

function appendSlashCommand(
  commands: SlashCommandInfo[],
  seenNames: Set<string>,
  command: SlashCommandInfo,
): void {
  const name = command.name.trim();
  if (!name || seenNames.has(name)) return;
  seenNames.add(name);
  commands.push({ ...command, name });
}

/**
 * Browser-native builtins with no shared SDK handler; advertised with their
 * canonical registry metadata. `/goal` is a mode command omp implements as a
 * TUI-only handler, so it never reaches ACP discovery; CUELO drives the same
 * GoalRuntime itself (lib/goal-mode.ts) and advertises it here.
 */
export const BROWSER_NATIVE_SLASH_COMMANDS = ["fork", "goal"] as const;

/**
 * Browser-native commands take precedence over same-named SDK commands. Shared text/ACP builtins
 * and every discovered extension/custom/MCP/file/skill command otherwise come from SDK discovery.
 * Browser-native /fork is added explicitly because it has no shared SDK handler yet. /handoff
 * gained one in omp 18, so it now arrives through discovery like every other shared builtin.
 * /goal is listed here for its own reason: omp implements it as a TUI-only mode handler, so ACP
 * discovery never returns it even though the canonical registry does define it.
 */
export async function getAvailableSlashCommands(session: AgentSessionLike): Promise<SlashCommandInfo[]> {
  const commands: SlashCommandInfo[] = [];
  const seenNames = new Set<string>();

  for (const name of BROWSER_NATIVE_SLASH_COMMANDS) {
    const builtin = BUILTIN_SLASH_COMMAND_DEFS.find((def) => def.name === name);
    if (!builtin) continue;
    const hint = builtin.inlineHint;
    appendSlashCommand(commands, seenNames, {
      name: builtin.name,
      aliases: builtin.aliases,
      description: builtin.description,
      source: "builtin",
      ...(hint ? { input: { hint } } : {}),
      ...(builtin.subcommands ? { subcommands: builtin.subcommands } : {}),
    });
  }

  const discovered = await buildAvailableSlashCommands(session as unknown as AvailableCommandsSession);
  for (const command of discovered) {
    appendSlashCommand(commands, seenNames, command);
  }

  // Prompt templates are a separate SDK resource from custom commands and
  // file-based commands, so retain them explicitly in the browser contract.
  for (const template of session.promptTemplates) {
    appendSlashCommand(commands, seenNames, {
      name: template.name,
      description: template.description,
      source: "prompt",
      ...(template.source ? { path: template.source } : {}),
    });
  }

  return commands;
}

// ============================================================================
// AgentSessionWrapper
// Wraps AgentSession with the same interface the rest of the app expects
// ============================================================================

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private pendingUiResponses = new Map<string, PendingUiResponse>();
  private keepAliveListeners = new Set<EventListener>();
  private pendingUiRequests = new Map<string, AgentEvent>();
  private activeCustomUis = new Map<string, ActiveCustomUi>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  /** 진행 중인 모델 mutation 수. 평범한 변경끼리는 겹칠 수 있으므로 개수로 센다. */
  private modelMutations = 0;
  /**
   * Main 프리셋 transaction이 이 세션의 모델·계정·thinking을 소유하는 동안 true. 그 동안에는
   * 다른 모델 변경과 프롬프트까지 거절해, 실패 복원이 다른 성공을 덮거나 진행 중인 턴이 바뀐
   * 모델과 겹치지 않게 한다.
   */
  private presetMutation = false;
  // Set while the handoff RPC is in flight so state polls and the running-set
  // stay honest during the long oneshot generation + session transition.
  private handoffRunning = false;
  private extensionsBound = false;
  private extensionBindingPromise: Promise<void> | null = null;
  private extensionBindingError: unknown = null;
  private forceEmptySystemPrompt = false;
  private unsubscribe: (() => void) | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onDestroyCallback: (() => void) | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private readonly subagents: RpcSubagentRegistry;
  // The SDK registry removes terminal entries after emitting their lifecycle frame.
  // Keep a bounded per-session copy so state requests can still expose history.
  private readonly subagentHistory = new Map<string, SubagentSnapshot>();
  private goalModeController: GoalModeController | null = null;
  private _alive = true;
  // 삭제 경로가 건 닫힘 예약. 세션 파일을 건드리기 전에 세워지고, 이후
  // 도착한 새 작업 명령은 거부된다.
  private closing = false;

  constructor(
    public readonly inner: AgentSessionLike,
    eventBus: ConstructorParameters<typeof RpcSubagentRegistry>[0],
  ) {
    this.subagents = new RpcSubagentRegistry(eventBus, (frame) => {
      const event = frame as unknown as AgentEvent;
      this.rememberSubagentFrame(event);
      this.emit(event);
      this.resetIdleTimer();
      notifyRunningChange();
    });
    this.subagents.setSubscriptionLevel("progress");
  }

  private rememberSubagentSnapshot(snapshot: SubagentSnapshot): void {
    this.subagentHistory.set(snapshot.id, snapshot);
    if (this.subagentHistory.size <= MAX_SUBAGENT_HISTORY) return;
    const removable = [...this.subagentHistory.values()]
      .filter((entry) => entry.status !== "pending" && entry.status !== "running")
      .sort((left, right) => left.lastUpdate - right.lastUpdate);
    while (this.subagentHistory.size > MAX_SUBAGENT_HISTORY && removable.length > 0) {
      const oldest = removable.shift();
      if (oldest) this.subagentHistory.delete(oldest.id);
    }
  }

  private rememberSubagentFrame(event: AgentEvent): void {
    if (event.type === "subagent_progress") {
      const payload = event.payload as { progress?: { id?: string } } | undefined;
      const id = payload?.progress?.id;
      if (!id) return;
      const live = this.subagents.getSubagents().find((entry) => entry.id === id);
      if (live) this.rememberSubagentSnapshot(live as unknown as SubagentSnapshot);
      return;
    }
    if (event.type !== "subagent_lifecycle") return;
    const payload = event.payload as {
      id?: string;
      index?: number;
      agent?: string;
      agentSource?: "bundled" | "user" | "project";
      description?: string;
      status?: "started" | "completed" | "failed" | "aborted";
      sessionFile?: string;
      parentToolCallId?: string;
    } | undefined;
    if (!payload?.id || !payload.status) return;
    const live = this.subagents.getSubagents().find((entry) => entry.id === payload.id);
    if (payload.status === "started") {
      if (live) this.rememberSubagentSnapshot(live as unknown as SubagentSnapshot);
      return;
    }
    const previous = (live as unknown as SubagentSnapshot | undefined) ?? this.subagentHistory.get(payload.id);
    const terminalStatus: SubagentSnapshot["status"] = payload.status === "failed"
      ? "failed"
      : payload.status === "aborted"
        ? "aborted"
        : "completed";
    this.rememberSubagentSnapshot({
      id: payload.id,
      index: payload.index ?? previous?.index ?? 0,
      agent: payload.agent ?? previous?.agent ?? payload.id,
      agentSource: payload.agentSource ?? previous?.agentSource ?? "bundled",
      description: payload.description ?? previous?.description,
      status: terminalStatus,
      task: previous?.task,
      assignment: previous?.assignment,
      sessionFile: payload.sessionFile ?? previous?.sessionFile,
      lastUpdate: Date.now(),
      parentToolCallId: payload.parentToolCallId ?? previous?.parentToolCallId,
      progress: previous?.progress
        ? { ...previous.progress, status: terminalStatus }
        : undefined,
    });
  }

  private getSubagentSnapshots(): SubagentSnapshot[] {
    for (const live of this.subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      this.rememberSubagentSnapshot(snapshot);
    }
    const snapshots = new Map(this.subagentHistory);
    for (const live of this.subagents.getSubagents()) {
      const snapshot = live as unknown as SubagentSnapshot;
      snapshots.set(snapshot.id, snapshot);
    }
    return [...snapshots.values()].sort((left, right) => {
      const leftActive = left.status === "pending" || left.status === "running";
      const rightActive = right.status === "pending" || right.status === "running";
      if (leftActive !== rightActive) return leftActive ? -1 : 1;
      if (leftActive) return left.index - right.index || left.id.localeCompare(right.id);
      return right.lastUpdate - left.lastUpdate || left.id.localeCompare(right.id);
    });
  }

  get sessionId(): string {
    return this.inner.sessionId;
  }

  get sessionFile(): string {
    return this.inner.sessionFile ?? "";
  }

  get cwd(): string {
    return this.inner.sessionManager.getCwd();
  }

  isAlive(): boolean {
    return this._alive;
  }

  isRunning(): boolean {
    return this._alive && (
      this.promptRunning
      || this.handoffRunning
      || this.inner.isStreaming
      || this.inner.isCompacting
      || this.inner.isBashRunning
      || this.subagents.getSubagents().length > 0
    );
  }

  /**
   * 삭제 직전의 닫힘 예약. 실행 여부 판정과 예약 표시가 같은 동기 구간에서
   * 끝나므로, 그 사이에 다른 요청이 끼어들어 새 프롬프트를 시작할 수 없다.
   * `onlyWhenIdle`이면 예약 시점에 실행 중인 세션은 예약하지 않고 false를 돌려준다.
   * 이미 종료된 세션은 더 잃을 작업이 없으므로 true다.
   */
  beginClose({ onlyWhenIdle = false }: { onlyWhenIdle?: boolean } = {}): boolean {
    if (!this._alive) return true;
    if (onlyWhenIdle && !this.closing && this.isRunning()) return false;
    this.closing = true;
    return true;
  }

  /**
   * 삭제가 실패해 세션을 계속 쓸 때 예약을 되돌린다. 이미 종료가 시작됐다면
   * 되돌릴 것이 없으므로 그대로 둔다(멈춘 채 남는 래퍼를 만들지 않는다).
   */
  cancelClose(): void {
    if (!this._alive || this.shutdownPromise) return;
    this.closing = false;
  }

  bindToolUiContext(setter: (uiContext: ExtensionUiContextLike, hasUI: boolean) => void): void {
    setter(this.createExtensionUiContext(), true);
  }


  start(): void {
    this.syncPlanModeFromSession();
    void this.goalMode.restore().catch((error) => {
      console.error(
        "[cuelo] failed to restore goal mode:",
        error instanceof Error ? error.message : error,
      );
    });
    this.unsubscribe = this.inner.subscribe((event: AgentEvent) => {
      if (event.type === "agent_end") {
        invalidateSessionListCache();
      }
      if (IDLE_RESET_EVENT_TYPES.has(event.type)) this.resetIdleTimer();
      this.emit(event);
      if (RUNNING_STATE_EVENT_TYPES.has(event.type)) notifyRunningChange();
      void this.goalMode.handleSessionEvent(event).catch((error) => {
        console.error(
          "[cuelo] goal mode failed to handle a session event:",
          error instanceof Error ? error.message : error,
        );
      });
    });
    this.resetIdleTimer();
    notifyRunningChange();
  }

  setForceEmptySystemPrompt(force: boolean): void {
    this.forceEmptySystemPrompt = force;
    this.applyForcedEmptySystemPrompt();
  }

  beginExtensionBinding(options: ExtensionBindingOptions = {}): void {
    void this.ensureExtensionsBound(options).catch((err) => {
      console.error("[cuelo] failed to dispatch session_start to extensions:", err instanceof Error ? err.message : err);
    });
  }

  async waitUntilReady(): Promise<void> {
    await this.waitForExtensionsBound();
  }

  private ensureExtensionsBound(options: ExtensionBindingOptions = {}): Promise<void> {
    if (options.forceEmptySystemPrompt) this.forceEmptySystemPrompt = true;
    if (this.extensionsBound) {
      this.applyForcedEmptySystemPrompt();
      return Promise.resolve();
    }
    if (this.extensionBindingPromise) return this.extensionBindingPromise;

    this.extensionBindingError = null;
    this.extensionBindingPromise = (async () => {
      if (!this._alive) return;
      // omp wires extensions the same way for every non-interactive host; reuse
      // its shared initializer so CUELO sessions expose exactly the action set
      // `omp --mode rpc` does, then layer our browser-backed UI context on top.
      await initializeExtensions(this.inner as never, {
        uiContext: this.createExtensionUiContext() as never,
        reportSendError: (action, error) => this.emit({
          type: "extension_error",
          extensionPath: action,
          event: "send",
          error: error.message,
        }),
        reportRuntimeError: (error) => this.emit({
          type: "extension_error",
          extensionPath: error.extensionPath,
          event: error.event,
          error: error.error,
        }),
        onShutdown: () => this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          notifyType: "warning",
          message: "Extension requested shutdown, but shutdown is not supported in CUELO.",
        } as ExtensionUiRequest as AgentEvent),
      });
      this.extensionsBound = true;
      this.applyForcedEmptySystemPrompt();
      console.log(`[cuelo] session_start dispatched to extensions for session ${this.inner.sessionId}`);
    })().catch((err) => {
      this.extensionBindingError = err;
      throw err;
    });

    return this.extensionBindingPromise;
  }

  private async waitForExtensionsBound(): Promise<void> {
    try {
      if (this.extensionBindingPromise) await this.extensionBindingPromise;
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }
    if (this.extensionBindingError) {
      throw this.extensionBindingError instanceof Error
        ? this.extensionBindingError
        : new Error(String(this.extensionBindingError));
    }
  }

  private shouldWaitForExtensions(type: string): boolean {
    return type === "prompt"
      || type === "steer"
      || type === "follow_up"
      || type === "handoff"
      || type === "get_commands"
      || type === "execute_slash_command"
      || type === "goal";
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      this.resetIdleTimer();
      notifyRunningChange();
    }
  }

  private async shutdownAfterCommittedFork(newSessionId: string): Promise<void> {
    try {
      await this.shutdown();
    } catch (error) {
      // The forked session is already persisted. Cleanup failures must not
      // hide its id from the browser and strand the committed transition.
      console.error(
        `[cuelo] fork created session ${newSessionId}, but wrapper shutdown failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  private applyForcedEmptySystemPrompt(): void {
    if (this.forceEmptySystemPrompt && this.inner.agent.state) {
      this.inner.agent.state.systemPrompt = [];
    }
  }
  /**
   * Goal mode lives server-side so an active goal keeps working through the
   * continuation loop whether or not a browser tab is watching.
   */
  private get goalMode(): GoalModeController {
    if (!this.goalModeController) {
      this.goalModeController = new GoalModeController(this.inner, {
        isBusy: () => this.promptRunning
          || this.handoffRunning
          || this.inner.isStreaming
          || this.inner.isCompacting
          || this.inner.isBashRunning,
        runContinuation: (prompt) => this.runGoalContinuation(prompt),
        onStatusChange: (status) => this.emit({ type: "goal_status", status }),
      });
    }
    return this.goalModeController;
  }

  /**
   * Send one goal continuation turn. It is a hidden custom message rather than
   * a prompt so it does not appear as something the operator typed, but the
   * browser must still see the session go busy, exactly as for a real prompt.
   */
  private async runGoalContinuation(prompt: string): Promise<void> {
    this.promptRunning = true;
    notifyRunningChange();
    try {
      await this.inner.promptCustomMessage({
        customType: "goal-continuation",
        content: prompt,
        display: false,
        attribution: "user",
      });
    } catch (error) {
      this.emit({
        type: "prompt_error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.promptRunning = false;
      this.resetIdleTimer();
      this.emit({ type: "prompt_done" });
      notifyRunningChange();
    }
  }

  private syncPlanModeFromSession(): void {
    let state = this.inner.getPlanModeState?.();
    if (!state) {
      const entries = this.inner.sessionManager.getEntries() as Array<{
        type?: string;
        mode?: string;
        data?: Record<string, unknown>;
      }>;
      let persistedMode: (typeof entries)[number] | undefined;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.type !== "mode_change") continue;
        persistedMode = entries[index];
        break;
      }
      const planFilePath = persistedMode?.data?.planFilePath;
      if (persistedMode?.mode === "plan" && typeof planFilePath === "string" && planFilePath.length > 0) {
        state = {
          enabled: true,
          planFilePath,
          workflow: persistedMode.data?.workflow === "sequential" ? "sequential" : "parallel",
          reentry: true,
        };
        this.inner.setPlanModeState?.(state);
      }
    }

    if (state?.enabled) {
      this.inner.setPlanProposalHandler?.((title) => this.handlePlanProposal(title));
    }
  }

  private async handlePlanProposal(title: string): Promise<{
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }> {
    const state = this.inner.getPlanModeState?.();
    if (!state?.enabled || !this.inner.preparePlanForReview) {
      throw new Error("Plan mode is not active.");
    }

    const review = await this.inner.preparePlanForReview(title);
    const planFilePath = review.details?.planFilePath;
    const resolvedTitle = review.details?.title;
    if (!planFilePath || !resolvedTitle) {
      throw new Error("The proposed plan could not be resolved.");
    }

    const planContent = await readPlanFile(planFilePath, {
      cwd: this.cwd,
      localProtocolOptions: {
        getArtifactsDir: () => this.inner.sessionManager.getArtifactsDir(),
        getSessionId: () => this.inner.sessionManager.getSessionId(),
      },
    });
    if (!planContent?.trim()) {
      throw new Error(`Plan file not found at ${planFilePath}`);
    }

    const responseValue = await this.requestExtensionUi(
      { method: "plan_review", title: resolvedTitle, planFilePath, planContent },
      JSON.stringify({ action: "refine" }),
      (response) => "value" in response ? response.value : JSON.stringify({ action: "refine" }),
    );
    let choice: { action?: unknown; feedback?: unknown } = {};
    try {
      choice = JSON.parse(responseValue) as { action?: unknown; feedback?: unknown };
    } catch {
      // Treat malformed or stale browser responses as a request to keep planning.
    }

    const details = { planFilePath, title: resolvedTitle, planExists: true };
    if (choice.action === "approve") {
      this.inner.setPlanReferencePath?.(planFilePath);
      this.inner.setPlanProposalHandler?.(null);
      this.inner.setPlanModeState?.(undefined);
      this.inner.sessionManager.appendModeChange("none");
      return {
        content: [{
          type: "text",
          text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
        }],
        details,
      };
    }

    if (state.planFilePath !== planFilePath) {
      this.inner.setPlanModeState?.({ ...state, planFilePath });
      this.inner.sessionManager.appendModeChange("plan", { planFilePath });
    }
    const feedback = typeof choice.feedback === "string" ? choice.feedback.trim() : "";
    return {
      content: [{
        type: "text",
        text: [
          "Plan refinement requested.",
          feedback ? `User feedback:\n${feedback}` : "",
          `Update the plan file, then write ${resolvedTitle} to xd://propose again when ready.`,
        ].filter(Boolean).join("\n\n"),
      }],
      details,
    };
  }

  /**
   * 세션 파일에 이미 기록된 정본 snapshot을 같은 세션 SSE listener에 알린다.
   * 저장보다 먼저 emit하지 않으며, 재연결 복구는 영속 transcript의 초기 snapshot이 맡는다.
   */
  publishSessionSnapshot(entryId: string, context: SessionContext): void {
    this.emit({
      type: "session_snapshot",
      sessionId: this.sessionId,
      entryId,
      context,
    } satisfies SessionSnapshotEvent);
  }


  private emit(event: AgentEvent): void {
    for (const l of this.listeners) l(event);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.keepAliveListeners.size > 0 || this.isRunning()) {
        this.resetIdleTimer();
        return;
      }
      void this.shutdown().catch((error) => {
        console.error("[pi-web] failed to shut down idle session:", error instanceof Error ? error.message : error);
      });
    }, 10 * 60 * 1000);
  }

  private persistBashOnlySession(): void {
    const manager = this.inner.sessionManager;
    const sessionFile = manager.getSessionFile();
    if (!sessionFile || existsSync(sessionFile)) return;

    const header = manager.getHeader();
    if (!header) return;

    const content = [header, ...manager.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
    writeFileSync(sessionFile, content, { encoding: "utf8", flag: "wx" });

    // omp normally delays the first flush until an assistant message exists.
    // A leading shell command has no assistant message, so mark this SDK
    // manager as flushed after writing its own generated entries.
    (manager as unknown as { flushed: boolean }).flushed = true;
    cacheSessionPath(this.inner.sessionId, sessionFile);
  }

  onEvent(listener: EventListener, options: EventSubscriptionOptions = {}): () => void {
    this.listeners.push(listener);
    if (options.keepAlive) {
      this.keepAliveListeners.add(listener);
      this.resetIdleTimer();
    }
    for (const event of this.pendingUiRequests.values()) listener(event);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      const releasedKeepAlive = this.keepAliveListeners.delete(listener);
      if (releasedKeepAlive && this.keepAliveListeners.size === 0 && this._alive) {
        this.resetIdleTimer();
      }
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * 하네스가 보내는 내부 지시문 전송. RPC 입력은 이 자리를 채울 수 없으므로 내부
   * 지시문이 genuine 사용자 요청으로 계상될 수 없고, 내부 지시문이 자기 자신을 새
   * 요청으로 다시 발화시키는 재귀도 막힌다.
   *
   * native task guard(`agent/extensions/command-guard`)의 요청 단위 budget은
   * `session_start`(세션 초기화 때 1회)와 extension `input` 이벤트에서만 리셋된다.
   * `input`은 genuine 입력 경계(`emitGenuineUserInput`)에서만 전달되므로, 이 경로로
   * 들어온 내부 turn은 별도의 사용자 요청 예산을 새로 받지 않는다.
   */
  async sendInternalPrompt(message: string): Promise<unknown> {
    return this.send({ type: "prompt", message }, true);
  }

  /**
   * genuine 사용자 입력을 SDK의 `input` 이벤트로 전달한다. 요청 단위 상태(예:
   * command-guard의 task budget)를 이 요청에서 리셋하는 지원 경로이고, 대화형 입력
   * 컨트롤러와 같은 계약을 따른다: `handled`면 확장이 입력을 가져갔으므로 null을
   * 돌려주고 호출자는 모델 턴을 열지 않는다. `text`/`images`가 오면 그것이 이번
   * 입력이다. 내부 지시문은 이 함수를 지나지 않는다.
   */
  private async emitGenuineUserInput(
    text: string,
    images: OmpImageContent[] | undefined,
  ): Promise<{ text: string; images: OmpImageContent[] | undefined } | null> {
    const runner = this.inner.extensionRunner;
    if (!runner?.hasHandlers?.("input")) return { text, images };
    const result: ExtensionInputResultLike | undefined = await runner.emitInput?.(text, images, "rpc");
    if (!result) return { text, images };
    if (result.handled === true) {
      console.log(`[cuelo] input event consumed by an extension for session ${this.inner.sessionId}`);
      return null;
    }
    return {
      text: result.text !== undefined ? result.text.trim() : text,
      images: result.images !== undefined ? result.images : images,
    };
  }

  /**
   * RPC 명령 실행. `internalPrompt`은 하네스가 넣는 내부 지시문 표시로, RPC 입력은
   * 이 인자를 채울 수 없다. 따라서 내부 지시문이 genuine 사용자 요청 경계를 새로
   * 열 수 없다.
   */
  async send(command: Record<string, unknown>, internalPrompt = false): Promise<unknown> {
    this.resetIdleTimer();
    const type = command.type as string;
    if (this.shouldWaitForExtensions(type)) await this.waitForExtensionsBound();
    // 확장 바인딩을 기다리는 동안 삭제가 예약될 수 있으므로 그 await 뒤에서 판정한다.
    // 여기를 통과한 prompt는 동기적으로 promptRunning을 세우므로, 반대로 예약이
    // 먼저 잡혔다면 이 명령이 작업을 시작하는 일은 없다.
    if (this.closing && CLOSING_REJECTED_COMMAND_TYPES[type] === true) {
      throw new Error("Session is closing");
    }
    if (this.handoffRunning && HANDOFF_ALLOWED_COMMAND_TYPES[type] !== true) {
      throw new Error("Cannot modify the session while a handoff is in progress");
    }
    // 프리셋 transaction은 모델·계정·thinking을 한 동작으로 바꾼다. 그 사이(또는 그 앞)에
    // 다른 model/thinking 변경이 끼어들면 복원이 그 성공을 덮을 수 있으므로, 프리셋이 낀
    // 겹침만 이 세션 안에서 거절한다. 평범한 모델 변경끼리는 기존처럼 겹쳐도 된다.
    const presetRequest = type === "set_model"
      && (command.thinkingLevel !== undefined || command.oauthPosition !== undefined);
    if (MODEL_MUTATION_COMMAND_TYPES[type] === true && (this.presetMutation || (presetRequest && this.modelMutations > 0))) {
      throw new Error("Cannot change the model while another model change is in progress");
    }
    // 프리셋 transaction 동안의 프롬프트만 막는다. continuation 같은 내부 프롬프트와
    // steer·follow_up·abort는 진행 중인 턴의 semantics를 그대로 유지한다.
    if (type === "prompt" && !internalPrompt && this.presetMutation) {
      throw new Error("Cannot send a prompt while a Main preset is being applied");
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      this.syncPlanModeFromSession();
    }

    if (type === "prompt" || type === "steer" || type === "follow_up") {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    switch (type) {
      case "prompt": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot send a prompt while a shell command is running");
        }
        // A turn the operator asked for means the next continuation is wanted,
        // and supersedes one already scheduled.
        this.goalMode.onUserPrompt();
        // Fire and forget — events come via subscribe
        let promptMessage = command.message as string;
        let promptImages = command.images as OmpImageContent[] | undefined;
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        // genuine 사용자 요청일 때만 SDK `input` 이벤트(요청 단위 guard 리셋)를 발화한다.
        // 내부 지시문과 실행 중 턴에 큐잉되는 steer/follow_up 입력은 새 요청이 아니다.
        if (isGenuineUserRequest(internalPrompt, streamingBehavior)) {
          // 요청 경계를 세우기 전에 SDK의 `input` 이벤트를 실제로 전달한다. 요청 단위
          // 상태(예: command-guard의 task budget)를 이 요청에서 리셋하는 유일한 지원
          // 경로이고, 대화형 호스트와 같은 계약(변환/handled)을 그대로 따른다.
          const applied = await this.emitGenuineUserInput(promptMessage, promptImages);
          if (applied === null) return null;
          promptMessage = applied.text;
          promptImages = applied.images;
          if (!promptMessage && !promptImages?.length) return null;
        }
        this.promptRunning = true;
        notifyRunningChange();
        this.inner.prompt(promptMessage, {
          ...(promptImages?.length ? { images: promptImages } : {}),
          ...(streamingBehavior ? { streamingBehavior } : {}),
          userInitiated: true,
        }).then(() => {
          this.promptRunning = false;
          this.resetIdleTimer();
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        }).catch((error) => {
          this.promptRunning = false;
          this.resetIdleTimer();
          invalidateSessionListCache();
          this.emit({
            type: "prompt_error",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
          if (!streamingBehavior) this.emit({ type: "prompt_done" });
          notifyRunningChange();
        });
        return null;
      }

      case "abort":
        this.goalMode.onAbort();
        await this.withFinalRunningNotification(() => this.inner.abort());
        return null;

      case "get_state": {
        const model = this.inner.model;
        const contextUsage = this.inner.getContextUsage();
        return {
          sessionId: this.inner.sessionId,
          sessionFile: this.inner.sessionFile ?? "",
          isStreaming: this.inner.isStreaming,
          isPromptRunning: this.promptRunning,
          isBashRunning: this.inner.isBashRunning,
          isCompacting: this.inner.isCompacting,
          isHandoffRunning: this.handoffRunning,
          autoCompactionEnabled: this.inner.autoCompactionEnabled,
          autoRetryEnabled: this.inner.autoRetryEnabled,
          model: model ? { id: model.id, provider: model.provider } : undefined,
          messageCount: 0,
          pendingMessageCount: this.inner.queuedMessageCount,
          queuedMessages: {
            steering: [...this.inner.getQueuedMessages().steering],
            followUp: [...this.inner.getQueuedMessages().followUp],
          },
          contextUsage: contextUsage
            ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow, tokens: contextUsage.tokens }
            : null,
          systemPrompt: [this.inner.agent.state?.systemPrompt ?? ""].flat().join("\n"),
          thinkingLevel: this.inner.agent.state?.thinkingLevel ?? "off",
          configuredThinkingLevel: this.inner.configuredThinkingLevel() ?? "off",
          extensionStatuses: this.getExtensionStatuses(),
          extensionWidgets: this.getExtensionWidgets(),
          subagents: this.getSubagentSnapshots(),
          // The tracker's own list, not a transcript reading: a todo change the harness makes
          // outside the todo tool carries no tool record and no other event mentions it, so this
          // snapshot (bootstrap/reconnect) plus the `todo_changed` event is what keeps a client
          // strip on the same list the terminal HUD shows. An empty list is authoritative.
          todoPhases: this.inner.getTodoPhases(),
          goal: this.goalMode.getStatus(),
        };
      }
      case "get_subagents":
        return { subagents: this.getSubagentSnapshots() };

      case "get_subagent_messages": {
        const selector = command as {
          subagentId?: string;
          sessionFile?: string;
          fromByte?: number;
        };
        const transcriptFile = this.subagents.resolveSessionFile(selector);
        return readRpcSubagentTranscript(transcriptFile, selector.fromByte);
      }


      case "set_model": {
        const { provider, modelId, role, oauthPosition, thinkingLevel } = command as {
          provider: string;
          modelId: string;
          role?: string;
          oauthPosition?: number;
          thinkingLevel?: string;
        };
        // 프리셋 transaction은 모델·계정·thinking을 한 동작으로 바꾸므로, 이 동안 다른
        // model/thinking/prompt mutation은 send()에서 거부된다. 실패 복원이 다른 명령의
        // 성공을 덮지 않게 하는 세션 안 보호다.
        const presetTransaction = thinkingLevel !== undefined || oauthPosition !== undefined;
        this.modelMutations += 1;
        if (presetTransaction) this.presetMutation = true;
        try {
          // modelRegistry.find() takes (provider, modelId) as two arguments — passing a
          // pre-joined "provider/modelId" selector leaves modelId undefined and throws
          // inside the SDK before we ever get a chance to report "model not found".
          // A direct model change is an explicit user request, so it may bypass
          // the background spacing window. Provider-scoped in-flight discovery
          // remains shared, preventing concurrent clicks from multiplying fetches.
          const lookup = await findModelWithRecovery(this.inner.modelRegistry, provider, modelId, {
            forceDiscovery: true,
          });
          if (lookup.miss) throw new Error(describeMissingModel(lookup.miss));
          const model = lookup.model;
          // 되돌릴 상태는 **변경 전에** 잡는다: 전환 전 모델과 그 role 기록, 설정된 thinking,
          // 그리고 바꿀 provider의 기존 선호 계정. 모델 변경·계정 설정·thinking 적용은 이
          // 명령 하나의 동작이므로, 어느 단계든 실패하면 이 스냅샷으로 복원한 뒤 오류로 끝난다.
          const previousModel = this.inner.model;
          // 되돌릴 수 있는 단계가 하나라도 있을 때만 스냅샷을 읽는다 — 평범한 모델 변경에
          // thinking·branch 조회를 얹지 않는다.
          const mayRollback = oauthPosition !== undefined || thinkingLevel !== undefined;
          const previousRole = mayRollback ? lastModelChangeRole(this.inner) : undefined;
          const previousThinking = thinkingLevel !== undefined ? this.inner.configuredThinkingLevel() : undefined;
          // 계정을 되돌릴 수 있어야 계정을 바꾼다 — 스냅샷을 못 읽으면 아무것도 바꾸지 않고
          // 실패한다(변경 뒤에 되돌릴 근거가 없는 상태를 만들지 않는다).
          let accountSnapshot: ProviderAccountSnapshot | undefined;
          if (oauthPosition !== undefined) {
            const snapshot = await snapshotProviderAccount(this.inner, model.provider);
            if (!snapshot.ok) throw new Error(`${snapshot.reason} 계정 변경을 시작하지 않았습니다.`);
            accountSnapshot = snapshot.snapshot;
          }
          // omp records the role a model change came from, so the transcript and
          // the `/model` carousel agree on which role is currently driving.
          await this.inner.setModel(model, role);
          // 계정 지정은 모델 변경과 한 동작이다. 자리가 없거나 설정되지 않으면 방금 바꾼 모델을
          // 되돌려 기존 모델·선호를 유지하고 오류로 끝낸다 — 다른 계정으로 대체하지 않는다.
          if (oauthPosition !== undefined) {
            const pinned = await pinProviderAccount(this.inner, model.provider, oauthPosition);
            if (!pinned.ok) {
              // pin이 이미 선호를 바꿨을 수 있으므로 모델만이 아니라 계정도 함께 되돌린다.
              const restored = await rollbackModelTransaction(this.inner, {
                previousModel, previousRole, previousThinking, account: accountSnapshot,
              });
              throw new Error(`${pinned.reason} ${describeRollback(restored)}`);
            }
          }
          // thinking auto도 같은 동작의 한 단계다. 적용이 실패하면 모델·계정·강도를 모두
          // 스냅샷으로 되돌린다 — 실패를 삼키고 성공으로 보고하지 않는다.
          if (thinkingLevel !== undefined) {
            try {
              this.inner.setThinkingLevel(thinkingLevel);
            } catch (error) {
              const reason = `thinking level ${thinkingLevel} 적용에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`;
              const restored = await rollbackModelTransaction(this.inner, {
                previousModel, previousRole, previousThinking, account: accountSnapshot,
              });
              throw new Error(`${reason} ${describeRollback(restored)}`);
            }
          }
          invalidateModelsCache();
          invalidateSessionListCache();
          return { id: model.id, provider: model.provider, ...(role ? { role } : {}) };
        } finally {
          if (presetTransaction) this.presetMutation = false;
          this.modelMutations -= 1;
        }
      }

      case "set_role_model": {
        const role = command.role as string;
        this.modelMutations += 1;
        try {
          // The role's model is resolved against the shared registry, so a model that
          // is missing from this process's catalog must be repaired before the lookup
          // fails: child spawns resolve their model the same way.
          await recoverMissingModelRefs(this.inner.modelRegistry, readConfiguredModelRoleRefs(this.inner.settings));
          const model = this.inner.resolveRoleModel(role);
          if (!model) throw new Error(`No model configured for role "${role}"`);
          await this.inner.setModel(model, role);
          invalidateModelsCache();
          invalidateSessionListCache();
          return { id: model.id, provider: model.provider, role };
        } finally {
          this.modelMutations -= 1;
        }
      }

      case "fork": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const sessionManager = this.inner.sessionManager;
        const entryId = resolveForkEntryId(
          sessionManager.getBranch() as ForkBranchEntry[],
          command.entryId,
        );
        if (!entryId) throw new Error("No user message to fork from yet");
        const currentSessionFile = this.inner.sessionFile;

        if (!currentSessionFile) return { cancelled: true };

        const entry = sessionManager.getEntry(entryId);
        if (!entry) throw new Error("Invalid entry ID for forking");

        const sessionDir = sessionManager.getSessionDir();
        let newSessionFile: string;

        if (!entry.parentId) {
          // Fork before the first message: create an empty session linked to this one
          const newManager = SessionManager.create(sessionManager.getCwd(), sessionDir);
          await newManager.newSession({ parentSession: currentSessionFile });
          await newManager.ensureOnDisk();
          newSessionFile = newManager.getSessionFile() as string;
        } else {
          // Fork after some history: copy path up to (but not including) the fork point
          const sourceManager = await SessionManager.open(currentSessionFile, sessionDir);
          const forkedPath = sourceManager.createBranchedSession(entry.parentId);
          if (!forkedPath) throw new Error("Failed to create forked session");
          newSessionFile = forkedPath;
        }

        const newSessionId = (await SessionManager.open(newSessionFile, sessionDir)).getSessionId();
        cacheSessionPath(newSessionId, newSessionFile);
        invalidateSessionListCache();
        await this.shutdownAfterCommittedFork(newSessionId);
        return { cancelled: false, newSessionId };
      }

      case "handoff": {
        // omp 18 made handoff in-place: it summarizes the conversation into a
        // handoff document and commits that as this session's compaction entry
        // instead of minting a replacement session. It still rewrites history
        // behind a oneshot model call, so it must not run while a prompt is
        // streaming or any other work owns the session.
        if (this.handoffRunning || this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot hand off while the session is busy");
        }
        const customInstructions = command.customInstructions as string | undefined;
        this.handoffRunning = true;
        notifyRunningChange();
        try {
          // No result means the handoff was cancelled; the session is untouched.
          const result = await this.inner.handoff(customInstructions);
          if (!result) return { cancelled: true };
          // The session id and file are unchanged, so only the cached listing
          // (modified time, token counts) has gone stale.
          invalidateSessionListCache();
          return { cancelled: false };
        } finally {
          this.handoffRunning = false;
          notifyRunningChange();
        }
      }

      case "navigate_tree": {
        if (this.inner.isBashRunning) {
          throw new Error("Cannot navigate while a shell command is running");
        }
        const result = await this.inner.navigateTree(command.targetId as string, {});
        return { cancelled: result.cancelled };
      }

      case "set_thinking_level": {
        const level = command.level as string;
        this.modelMutations += 1;
        try {
          this.inner.setThinkingLevel(level);
          // setThinkingLevel clamps xhigh→high for models where supportsXhigh()===false.
          // If the model has DeepSeek thinking compat (reasoningEffortMap maps xhigh→max),
          // force the state back so the compat layer can use it correctly.
          if (level === "xhigh" && (this.inner.model as { compat?: { thinkingFormat?: string } } | null)?.compat?.thinkingFormat === "deepseek" && this.inner.agent?.state) {
            this.inner.agent.state.thinkingLevel = "xhigh";
          }
          invalidateSessionListCache();
          return null;
        } finally {
          this.modelMutations -= 1;
        }
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(() =>
            this.inner.compact(command.customInstructions as string | undefined)
          );
        } finally {
          invalidateSessionListCache();
        }
      }

      case "set_session_name": {
        const name = (command.name as string | undefined)?.trim();
        if (!name) throw new Error("Session name cannot be empty");
        await this.inner.sessionManager.setSessionName(name, "user");
        invalidateSessionListCache();
        return null;
      }

      case "get_session_stats": {
        return {
          ...this.inner.getSessionStats(),
          sessionName: this.inner.sessionManager.getSessionName(),
        };
      }

      case "get_last_assistant_text": {
        return { text: this.inner.getLastAssistantText() ?? "" };
      }

      case "set_auto_compaction": {
        this.inner.setAutoCompactionEnabled(command.enabled as boolean);
        return null;
      }

      case "clear_queue": {
        // Full clear only: omp has no single-item dequeue, and clear+requeue
        // races against the agent loop pulling messages mid-flight.
        return this.inner.clearQueue();
      }

      case "steer": {
        const steerImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        recordSteeringReceived(this.sessionId, "steer", command.message);
        await this.inner.steer(command.message as string, steerImages?.length ? steerImages : undefined);
        return null;
      }

      case "follow_up": {
        const followImages = command.images as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
        await this.inner.followUp(command.message as string, followImages?.length ? followImages : undefined);
        return null;
      }

      case "get_tools": {
        const active = new Set<string>(this.inner.getActiveToolNames());
        return listTools(this.inner).map((t) => ({
          name: t.name,
          description: t.description,
          active: active.has(t.name),
        }));
      }

      case "get_commands": {
        return { commands: await getAvailableSlashCommands(this.inner) };
      }

      case "goal": {
        return await this.goalMode.handleCommand((command.args as string | undefined) ?? "");
      }

      case "execute_slash_command": {
        const output: string[] = [];
        const result: AcpBuiltinSlashCommandResult = await executeAcpBuiltinSlashCommand(command.message as string, {
          session: this.inner as never,
          sessionManager: this.inner.sessionManager,
          settings: this.inner.settings,
          cwd: this.cwd,
          output: (text) => {
            output.push(text);
          },
          refreshCommands: () => {},
          reloadPlugins: async () => {
            await this.waitForExtensionsBound();
            this.extensionStatuses.clear();
            this.extensionWidgets.clear();
            await this.inner.reload();
            await this.inner.refreshSkills?.();
            this.applyForcedEmptySystemPrompt();
            invalidateModelsCache();
          },
        });
        if (result === false) return { handled: false, output };
        return {
          handled: true,
          output,
          ...("prompt" in result ? { prompt: result.prompt } : {}),
        };
      }


      case "set_tools": {
        const toolNames = command.toolNames as string[];
        this.setForceEmptySystemPrompt(toolNames.length === 0);
        await this.inner.setActiveToolsByName(
          this.goalMode.reconcileToolNames(withExtensionTools(this.inner, toolNames)),
        );
        this.applyForcedEmptySystemPrompt();
        return null;
      }

      case "reload": {
        await this.waitForExtensionsBound();
        this.extensionStatuses.clear();
        this.extensionWidgets.clear();
        await this.inner.reload();
        await this.inner.refreshSkills?.();
        this.applyForcedEmptySystemPrompt();
        invalidateModelsCache();
        return { success: true };
      }

      case "abort_compaction": {
        this.inner.abortCompaction();
        return null;
      }

      case "extension_ui_response": {
        this.resolveExtensionUiResponse(command as ExtensionUiResponse);
        return null;
      }

      case "extension_ui_input": {
        this.handleExtensionUiInput(command.id as string, command.data as string);
        return null;
      }

      case "set_auto_retry": {
        this.inner.setAutoRetryEnabled(command.enabled as boolean);
        return null;
      }

      case "bash": {
        if (this.promptRunning || this.inner.isStreaming || this.inner.isCompacting || this.inner.isBashRunning) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        const execution = this.inner.executeBash(
          command.command as string,
          undefined,
          { excludeFromContext: command.excludeFromContext as boolean | undefined },
        );
        notifyRunningChange();
        try {
          const result = await execution;
          this.persistBashOnlySession();
          return result;
        } finally {
          this.resetIdleTimer();
          invalidateSessionListCache();
          notifyRunningChange();
        }
      }

      case "abort_bash": {
        this.inner.abortBash();
        return null;
      }

      default:
        throw new Error(`Unsupported command: ${type}`);
    }
  }

  destroy(): void {
    if (!this._alive) return;
    this._alive = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.inner.isBashRunning) this.inner.abortBash();
    this.unsubscribe?.();
    this.goalModeController?.dispose();
    this.subagents.dispose();
    this.subagentHistory.clear();
    this.keepAliveListeners.clear();
    for (const pending of this.pendingUiResponses.values()) pending.cancel();
    for (const id of Array.from(this.activeCustomUis.keys())) this.closeCustomUi(id, undefined);
    this.pendingUiResponses.clear();
    this.pendingUiRequests.clear();
    try {
      void this.inner.dispose?.();
    } finally {
      try {
        this.onDestroyCallback?.();
      } finally {
        notifyRunningChange();
      }
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this._alive) return;

    this.shutdownPromise = (async () => {
      try {
        try {
          await this.waitForExtensionsBound();
        } catch (error) {
          console.error(
            "[pi-web] extension binding failed before session shutdown:",
            error instanceof Error ? error.message : error,
          );
        }
        await this.inner.extensionRunner?.emit?.({ type: "session_shutdown", reason: "quit" });
      } finally {
        this.destroy();
      }
    })();
    return this.shutdownPromise;
  }

  private resolveExtensionUiResponse(response: ExtensionUiResponse): void {
    const pending = this.pendingUiResponses.get(response.id);
    if (!pending) return;
    pending.resolve(response);
  }

  private getExtensionStatuses(): Array<{ key: string; text: string }> {
    return Array.from(this.extensionStatuses, ([key, text]) => ({ key, text }));
  }

  private getExtensionWidgets(): ExtensionWidgetItem[] {
    return Array.from(this.extensionWidgets.values());
  }

  private getCustomUiWidth(options: unknown): number {
    if (!options || typeof options !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const overlayOptions = (options as { overlayOptions?: unknown }).overlayOptions;
    const resolved = typeof overlayOptions === "function" ? overlayOptions() : overlayOptions;
    if (!resolved || typeof resolved !== "object") return DEFAULT_CUSTOM_UI_COLUMNS;
    const width = (resolved as { width?: unknown }).width;
    return typeof width === "number" && Number.isFinite(width)
      ? Math.max(40, Math.min(140, Math.round(width)))
      : 92;
  }

  private emitCustomUiRender(id: string, custom: ActiveCustomUi): void {
    let lines: string[];
    try {
      lines = custom.component.render(custom.width);
    } catch (error) {
      lines = [`Extension custom UI render failed: ${error instanceof Error ? error.message : String(error)}`];
    }
    const event = {
      type: "extension_ui_request",
      id,
      method: "custom",
      lines,
    } as ExtensionUiRequest as AgentEvent;
    this.pendingUiRequests.set(id, event);
    this.emit(event);
  }

  private closeCustomUi(id: string, value: unknown): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || custom.settled) return;
    custom.settled = true;
    this.activeCustomUis.delete(id);
    this.pendingUiRequests.delete(id);
    try {
      custom.component.dispose?.();
    } catch {
      // Ignore dispose errors from extension UI components.
    }
    this.emit({
      type: "extension_ui_request",
      id,
      method: "custom",
      lines: [],
      closed: true,
    } as ExtensionUiRequest as AgentEvent);
    custom.resolve(value);
  }

  private handleExtensionUiInput(id: string, data: string): void {
    const custom = this.activeCustomUis.get(id);
    if (!custom || typeof data !== "string") return;
    try {
      custom.component.handleInput?.(data);
      if (this.activeCustomUis.has(id)) this.emitCustomUiRender(id, custom);
    } catch (error) {
      this.closeCustomUi(id, undefined);
      this.emit({
        type: "extension_error",
        extensionPath: `custom-ui:${id}`,
        event: "custom_ui_input",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestExtensionCustomUi<T>(
    factory: unknown,
    options?: unknown,
  ): Promise<T> {
    if (typeof factory !== "function") return Promise.resolve(undefined as T);

    const id = randomUUID();
    const width = this.getCustomUiWidth(options);

    return new Promise<T>((resolve) => {
      let completed = false;
      const tui = createHeadlessCustomUiTui(
        () => {
          const custom = this.activeCustomUis.get(id);
          if (custom) this.emitCustomUiRender(id, custom);
        },
        width,
      );
      const finish = (value: T) => {
        if (completed) return;
        completed = true;
        resolve(value);
      };
      const done = (value: T) => {
        if (this.activeCustomUis.has(id)) {
          this.closeCustomUi(id, value);
        } else {
          finish(value);
        }
      };

      Promise.resolve()
        .then(() => factory(tui, PLAIN_TEXT_THEME, CUSTOM_UI_KEYBINDINGS, done))
        .then((component) => {
          if (completed) {
            try {
              (component as CustomUiComponent | undefined)?.dispose?.();
            } catch {
              // Ignore dispose errors from a component completed before mounting.
            }
            return;
          }
          if (!component || typeof component !== "object" || typeof (component as CustomUiComponent).render !== "function") {
            finish(undefined as T);
            return;
          }
          const custom: ActiveCustomUi = {
            component: component as CustomUiComponent,
            width,
            resolve: (value) => finish(value as T),
            settled: false,
          };
          this.activeCustomUis.set(id, custom);
          this.emitCustomUiRender(id, custom);
        })
        .catch((error) => {
          if (completed) return;
          this.emit({
            type: "extension_error",
            extensionPath: `custom-ui:${id}`,
            event: "custom_ui",
            error: error instanceof Error ? error.message : String(error),
          });
          finish(undefined as T);
        });
    });
  }

  private requestExtensionUi<T>(
    request: ExtensionUiRequestBody,
    defaultValue: T,
    parseResponse: (response: ExtensionUiResponse) => T,
    timeout?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.resolve(defaultValue);

    const id = randomUUID();
    const fullRequest = {
      type: "extension_ui_request",
      id,
      ...request,
      ...(timeout ? { timeout, expiresAt: Date.now() + timeout } : {}),
    };

    return new Promise((resolve) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onAbort);
        this.pendingUiRequests.delete(id);
        this.pendingUiResponses.delete(id);
      };
      const settle = (value: T, notifyClosed = false) => {
        cleanup();
        if (notifyClosed) this.emit({ ...fullRequest, closed: true } as AgentEvent);
        resolve(value);
      };
      const onAbort = () => settle(defaultValue, true);

      if (timeout) timeoutId = setTimeout(() => settle(defaultValue), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });

      this.pendingUiRequests.set(id, fullRequest as AgentEvent);
      this.pendingUiResponses.set(id, {
        resolve: (response) => settle(parseResponse(response)),
        cancel: () => settle(defaultValue),
      });
      this.emit(fullRequest as AgentEvent);
    });
  }

  private createExtensionUiContext(): ExtensionUiContextLike {
    return {
      timeoutStartsOnPresentation: false,
      askDialog: (questions, opts) => this.requestExtensionUi(
        { method: "ask", questions, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => {
          if (!("value" in response)) return undefined;
          try {
            return JSON.parse(response.value) as ExtensionAskDialogResult;
          } catch {
            return undefined;
          }
        },
        opts?.timeout,
        opts?.signal,
      ),
      select: (title, options, opts) => this.requestExtensionUi(
        { method: "select", title, options, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      confirm: (title, message, opts) => this.requestExtensionUi(
        { method: "confirm", title, message, ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        false,
        (response) => "confirmed" in response ? response.confirmed : false,
        opts?.timeout,
        opts?.signal,
      ),
      input: (title, placeholder, opts) => this.requestExtensionUi(
        { method: "input", title, ...(placeholder !== undefined ? { placeholder } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      editor: (title, prefill, opts) => this.requestExtensionUi(
        { method: "editor", title, ...(prefill !== undefined ? { prefill } : {}), ...(opts?.timeout ? { timeout: opts.timeout } : {}) },
        undefined,
        (response) => "value" in response ? response.value : undefined,
        opts?.timeout,
        opts?.signal,
      ),
      notify: (message, type) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "notify",
          message,
          notifyType: type,
        } as ExtensionUiRequest as AgentEvent);
      },
      onTerminalInput: () => () => {},
      setStatus: (key, text) => {
        if (text === undefined) this.extensionStatuses.delete(key);
        else this.extensionStatuses.set(key, text);
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setStatus",
          statusKey: key,
          statusText: text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setWidget: (key, content, options) => {
        if (content !== undefined && !Array.isArray(content)) return;
        if (content === undefined) {
          this.extensionWidgets.delete(key);
        } else {
          this.extensionWidgets.set(key, {
            key,
            lines: content,
            placement: options?.placement ?? "aboveEditor",
          });
        }
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setWidget",
          widgetKey: key,
          widgetLines: content,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest as AgentEvent);
      },
      setFooter: () => {},
      setHeader: () => {},
      setTitle: (title) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "setTitle",
          title,
        } as ExtensionUiRequest as AgentEvent);
      },
      custom: <T = unknown>(factory: unknown, options?: unknown) => this.requestExtensionCustomUi<T>(factory, options),
      pasteToEditor: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      setEditorText: (text) => {
        this.emit({
          type: "extension_ui_request",
          id: randomUUID(),
          method: "set_editor_text",
          text,
        } as ExtensionUiRequest as AgentEvent);
      },
      getEditorText: () => "",
      addAutocompleteProvider: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      get theme() { return PLAIN_TEXT_THEME; },
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is not supported in CUELO extension UI yet" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }
}

// ============================================================================
// Session registry
// ============================================================================

declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompStartingSessionCwds: Map<string, number> | undefined;
  var __ompRunningListeners: Set<(ids: string[]) => void> | undefined;
  // 삭제가 진행 중인 세션 id. 프로세스 메모리에만 존재하고 삭제가 끝나거나
  // 실패하면 즉시 비워진다(영속 tombstone이 아니다).
  var __ompClosingSessionIds: Set<string> | undefined;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => globalThis.__ompSessions?.forEach((s) => s.destroy());
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

function getClosingSessionIds(): Set<string> {
  if (!globalThis.__ompClosingSessionIds) globalThis.__ompClosingSessionIds = new Set();
  return globalThis.__ompClosingSessionIds;
}

/**
 * 보호된 세션 삭제의 시작점. 살아 있는 래퍼에는 닫힘을 예약해 새 명령을 막고,
 * 동시에 같은 id의 재기동(startRpcSession)도 막는다. 삭제 중에 이미 시작 중이던
 * 기동은 등록 직전에 다시 검사되어 취소되므로, 삭제된 파일 위에 세션이 남지 않는다.
 *
 * 예약은 한 번에 한 주인만 가진다. 이미 다른 삭제가 이 id를 잡고 있으면
 * reserved:false다. 그러지 않으면 먼저 끝난 쪽의 release가 아직 파일을 지우는
 * 중인 다른 삭제의 보호를 걷어내 버린다.
 * `onlyWhenIdle`이면 실행 중인 세션도 예약하지 않고 reserved:false를 돌려준다.
 * release는 성공·실패 어느 쪽이든 삭제가 끝난 뒤 반드시 호출하며, 자기 예약만
 * 푼다(중복 호출은 무시).
 */
export function beginGuardedSessionDeletion(
  sessionId: string,
  { onlyWhenIdle = false }: { onlyWhenIdle?: boolean } = {},
): { reserved: boolean; release: () => void } {
  const closing = getClosingSessionIds();
  if (closing.has(sessionId)) return { reserved: false, release: () => {} };

  const session = getRegistry().get(sessionId);
  const running = session
    ? !session.beginClose({ onlyWhenIdle })
    : onlyWhenIdle && getRunningRpcSessionIds().includes(sessionId);
  if (running) return { reserved: false, release: () => {} };

  closing.add(sessionId);
  let released = false;
  return {
    reserved: true,
    release: () => {
      if (released) return;
      released = true;
      closing.delete(sessionId);
      session?.cancelClose();
    },
  };
}

function normalizeRpcCwd(cwd: string): string {
  const resolvedCwd = resolve(cwd);
  try {
    return realpathSync(resolvedCwd);
  } catch {
    return resolvedCwd;
  }
}

function getStartingSessionCwds(): Map<string, number> {
  if (!globalThis.__ompStartingSessionCwds) globalThis.__ompStartingSessionCwds = new Map();
  return globalThis.__ompStartingSessionCwds;
}

function trackStartingSession(cwd: string): () => void {
  const startingCwds = getStartingSessionCwds();
  const key = normalizeRpcCwd(cwd);
  startingCwds.set(key, (startingCwds.get(key) ?? 0) + 1);
  return () => {
    const remaining = (startingCwds.get(key) ?? 1) - 1;
    if (remaining > 0) startingCwds.set(key, remaining);
    else startingCwds.delete(key);
  };
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

function runtimeMessageText(entry: SessionMessageEntry): string {
  if (entry.message.role === "bashExecution") return "";
  const content = entry.message.content;
  const text = typeof content === "string"
    ? content
    : content
      .map((block) => block.type === "text" ? block.text : "")
      .filter(Boolean)
      .join(" ");
  return getDocumentPromptUserMessage(text);
}

function runtimeMessageActivityMs(entry: SessionMessageEntry): number | undefined {
  if (entry.message.role !== "user" && entry.message.role !== "assistant") return undefined;
  if (typeof entry.message.timestamp === "number") return entry.message.timestamp;
  const timestamp = new Date(entry.timestamp).getTime();
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

/**
 * Return live sessions that should be visible in the session list. Pi delays
 * the first JSONL flush until an assistant message exists, so an accepted new
 * prompt must temporarily be described from its in-memory SessionManager.
 */
export function getRpcSessionInfos(): SessionInfo[] {
  const sessions: SessionInfo[] = [];
  for (const session of getRegistry().values()) {
    if (!session.isAlive()) continue;

    const manager = session.inner.sessionManager;
    const header = manager.getHeader();
    const entries = manager.getEntries() as unknown as Array<
      { type: string; timestamp: string } | SessionMessageEntry
    >;
    const messages = entries.filter((entry): entry is SessionMessageEntry => entry.type === "message");
    const firstUserMessage = messages.find((entry) => entry.message.role === "user");
    const sessionFile = manager.getSessionFile() ?? session.sessionFile;
    const persisted = Boolean(sessionFile && existsSync(sessionFile));

    // An ensure_session call creates an idle, empty runtime while the composer
    // loads commands. Do not leak it into history before a prompt is accepted.
    if (!persisted && (!session.isRunning() || !firstUserMessage)) continue;

    const created = header?.timestamp
      ?? entries[0]?.timestamp
      ?? new Date().toISOString();
    const headerTimestamp = new Date(created).getTime();
    let lastActivityMs = Number.isNaN(headerTimestamp) ? Date.now() : headerTimestamp;
    for (const message of messages) {
      const activityMs = runtimeMessageActivityMs(message);
      if (activityMs !== undefined) lastActivityMs = Math.max(lastActivityMs, activityMs);
    }

    sessions.push({
      path: sessionFile ?? "",
      id: header?.id ?? session.sessionId,
      cwd: header?.cwd ?? session.cwd,
      name: manager.getSessionName(),
      created,
      modified: new Date(lastActivityMs).toISOString(),
      messageCount: messages.length,
      firstMessage: firstUserMessage ? runtimeMessageText(firstUserMessage) || "(no messages)" : "(no messages)",
      transient: !persisted,
    });
  }
  return sessions;
}

export function hasBusyRpcSessionForCwd(cwd: string): boolean {
  const targetCwd = normalizeRpcCwd(cwd);
  if (getStartingSessionCwds().has(targetCwd)) return true;
  return Array.from(getRegistry().values()).some(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd && session.isRunning(),
  );
}

export async function destroyRpcSessionsForCwd(cwd: string): Promise<number> {
  const targetCwd = normalizeRpcCwd(cwd);
  const sessions = Array.from(getRegistry().values()).filter(
    (session) => normalizeRpcCwd(session.cwd) === targetCwd,
  );
  await Promise.all(sessions.map((session) => session.shutdown()));
  return sessions.length;
}

export function getRunningRpcSessionIds(): string[] {
  const ids = new Set<string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) ids.add(session.sessionId || sessionId);
  }
  return [...ids];
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(ids: string[]) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes. Returns an unsubscribe function. */
export function subscribeRunningSessions(listener: (ids: string[]) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

let lastRunningSnapshot = "";

/**
 * Recompute the running-session-id set and, if it changed since the last
 * notification, broadcast it to subscribers.
 */
export function notifyRunningChange(): void {
  const ids = getRunningRpcSessionIds();
  recordRuntimeActivity(ids);
  const listeners = getRunningListeners();
  if (listeners.size === 0) {
    // A future subscriber receives its own initial snapshot. Clear this one so
    // its first state transition cannot match stale state from an old listener.
    lastRunningSnapshot = "";
    return;
  }
  const snapshot = JSON.stringify([...ids].sort());
  if (snapshot === lastRunningSnapshot) return;
  lastRunningSnapshot = snapshot;
  for (const listener of listeners) {
    try { listener(ids); } catch { /* ignore listener errors */ }
  }
}

/**
 * Get or create an AgentSession for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * New sessions resolve enabledModels before construction so the initial model,
 * thinking pin, and SDK scopedModels share one settings snapshot.
 * Pass options.toolNames to pre-configure active tools (empty = all disabled).
 */
export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string | undefined,
  options: RpcSessionStartOptions = {},
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  const { toolNames, initialModel, thinkingLevel, accountOauthPosition } = options;
  const registry = getRegistry();
  const locks = getLocks();

  // 삭제가 진행 중인 세션은 다시 띄우지 않는다. 곧 지워질 파일 위에 세션이
  // 생기면 그 세션에서 한 작업이 그대로 사라진다.
  if (getClosingSessionIds().has(sessionId)) {
    throw new Error("Session is closing");
  }

  const existing = registry.get(sessionId);
  if (existing?.isAlive()) return { session: existing, realSessionId: sessionId };

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // Some extensions access the SDK's global theme even outside the terminal UI.
    await initTheme(false);
    const agentDir = getAgentDir();
    const sessionManager = sessionFile
      ? await SessionManager.open(sessionFile, undefined)
      : (() => {
        if (!cwd) throw new Error("cwd is required for a new session");
        return SessionManager.create(cwd, undefined);
      })();
    const sessionCwd = sessionManager.getCwd();
    const finishStartingSession = trackStartingSession(sessionCwd);

    try {
      const runtime = await getOmpRuntime();
      const settings = await getSettingsForCwd(sessionCwd);

      // Determine which tools to pass based on requested toolNames.
      let toolsOption: string[] | undefined;
      if (toolNames !== undefined) {
        // toolNames === [] -> "all off" (an empty allow-list disables every tool).
        // Otherwise DO NOT pass a builtin-only allow-list: passing CODING_TOOL_NAMES
        // set allowedToolNames to coding builtins only, which filtered every
        // extension/package-provided tool (e.g. subagents, web access) out of the
        // tool registry — so they were unavailable in CUELO sessions even though the
        // `omp` CLI keeps them. Leaving the allow-list unset lets the SDK register all
        // tools (and activate extension tools); we narrow the ACTIVE set below.
        toolsOption = toolNames.length === 0 ? [] : undefined;
      }

      // Gate untrusted project code so opening a repository in a browser tab does
      // not run its `.omp/extensions`, `.omp/tools`, or `.mcp.json` servers (see
      // lib/project-trust.ts). Discovery still runs — only project-local entries
      // are dropped, so user-level extensions keep working.
      const [extensionPaths, customToolPaths] = await Promise.all([
        discoverSessionExtensionPaths({}, sessionCwd, settings),
        discoverCustomToolPaths([], sessionCwd),
      ]);
      const untrusted = untrustedProjectSessionOptions(sessionCwd, agentDir, { extensionPaths, customToolPaths });

      // `SYSTEM.md` / `APPEND_SYSTEM.md`, resolved against this session's cwd the
      // way the CLI resolves them against its own (lib/session-system-prompt.ts).
      const systemPrompts = await resolveSessionSystemPrompts(sessionCwd);

      const { modelRegistry } = runtime;
      // Every configured role and the explicitly requested model execute through
      // this shared registry — child spawns resolve their model inside the core
      // against it — so repair any of them the process-wide startup discovery left
      // out before this session can resolve one. A registry that has them all pays
      // nothing; only a missing provider fetches, once per window.
      await recoverMissingModelRefs(modelRegistry, [
        ...readConfiguredModelRoleRefs(settings),
        ...(initialModel ? [initialModel] : []),
      ]);
      const scope = await resolveVisibleModels(modelRegistry, cfgEnabledModels.get(settings), settings);
      const defaultRole = readDefaultModelRole(settings);
      // 역할 selector의 effort(`default: anthropic/claude-opus-5:xhigh`)가 새 세션 초기
      // thinking level의 정본이다. 호출자가 모델이나 level을 직접 넘겼으면 그쪽이 이기고,
      // 대화가 이미 있는 세션은 transcript의 thinking_level_change를 따른다. 여기서 싣지
      // 않으면 세션은 설정 기본값(예: auto)으로 열려 역할 selector의 xhigh가 사라진다.
      const roleThinkingLevel = initialModel ? undefined : defaultRole?.thinkingLevel;
      const selectedThinkingLevel = thinkingLevel ?? roleThinkingLevel;
      const hasExistingMessages = sessionManager.buildSessionContext().messages.length > 0;
      const initial = hasExistingMessages
        ? { scopedModels: [...scope.scopedModels], model: undefined, thinkingLevel: undefined }
        : selectInitialModelScope(scope, {
          ...(initialModel ? { requestedModel: initialModel } : {}),
          ...(defaultRole ? { defaultModel: defaultRole } : {}),
          ...(selectedThinkingLevel ? { thinkingLevel: selectedThinkingLevel } : {}),
        });
      const sessionOptions: CreateAgentSessionOptions = {
        cwd: sessionCwd,
        agentDir,
        settings,
        sessionManager,
        modelRegistry,
        hasUI: true,
        ...(initial.model ? { model: initial.model } : {}),
        ...(initial.thinkingLevel ? { thinkingLevel: initial.thinkingLevel } : {}),
        ...(initial.scopedModels.length > 0 ? { scopedModels: initial.scopedModels } : {}),
        ...(toolsOption !== undefined ? { toolNames: toolsOption, restrictToolNames: true } : {}),
        ...(untrusted ?? {}),
      };
      // omp's own applier, so a prompt file goes through the same templates the
      // CLI renders it with instead of overwriting the whole system prompt.
      applyResolvedSystemPromptInputs(sessionOptions, systemPrompts.systemPrompt, systemPrompts.appendPrompt);
      const { session: inner, eventBus, setToolUIContext } = await createAgentSession(sessionOptions);

      const session = inner as unknown as AgentSessionLike;

      // If specific tool names were requested (non-empty), set the active tools to the
      // requested builtin coding tools PLUS all extension/package tools, so installed
      // extensions stay usable in CUELO just like in the `omp` CLI.
      if (toolNames && toolNames.length > 0) {
        await session.setActiveToolsByName(withExtensionTools(session, toolNames));
      }

      const wrapper = new AgentSessionWrapper(session, eventBus);
      wrapper.bindToolUiContext(
        setToolUIContext as unknown as (uiContext: ExtensionUiContextLike, hasUI: boolean) => void,
      );
      // 계정 지정은 세션 등록·기동 전에 끝난다. 실패하면 이 세션을 올리지 않고 요청을
      // 실패시킨다 — 첫 명령이 provider에 닿기 전에 정해지고, 다른 계정으로 대체하지 않는다.
      if (accountOauthPosition !== undefined) {
        // pin 대상 provider는 지금 이 세션이 실제로 쓸 모델의 provider다 — 요청이 모델을
        // 지정하지 않았으면 기본 모델이 정해져 있고, 그 provider의 목록에서 자리를 해석한다.
        const pinProvider = session.model?.provider;
        if (!pinProvider) {
          wrapper.destroy();
          throw new Error("이 세션의 provider를 알 수 없어 OAuth 계정을 지정하지 못했습니다.");
        }
        const pinned = await pinProviderAccount(session, pinProvider, accountOauthPosition);
        if (!pinned.ok) {
          wrapper.destroy();
          throw new Error(pinned.reason);
        }
      }
      // When all tools are disabled, clear the system prompt entirely.
      // omp's buildSystemPrompt always produces a non-empty prompt even with no
      // tools; keep this forced after extension discovery and reloads as well.
      if (toolNames?.length === 0) {
        wrapper.setForceEmptySystemPrompt(true);
      }

      const realSessionId = inner.sessionId as string;
      // 기동은 파일 I/O를 여러 번 기다리므로, 그 사이에 삭제가 예약됐을 수 있다.
      // 레지스트리에 넣기 직전(동기 구간)에 다시 확인해 삭제 대상 위에 세션이
      // 남지 않게 한다.
      const closing = getClosingSessionIds();
      if (closing.has(sessionId) || closing.has(realSessionId)) {
        wrapper.destroy();
        throw new Error("Session is closing");
      }
      wrapper.start();

      const realSessionFile = inner.sessionFile as string | undefined;
      if (realSessionFile) cacheSessionPath(realSessionId, realSessionFile);

      wrapper.onDestroy(() => registry.delete(realSessionId));
      registry.set(realSessionId, wrapper);
      wrapper.beginExtensionBinding({ forceEmptySystemPrompt: toolNames?.length === 0 });

      return { session: wrapper, realSessionId };
    } finally {
      finishStartingSession();
    }
  })().finally(() => {
    locks.delete(sessionId);
  });

  locks.set(sessionId, starting);
  return starting;
}
