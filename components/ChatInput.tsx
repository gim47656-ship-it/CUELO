"use client";

import React, { useRef, useState, useCallback, useEffect, useImperativeHandle, useMemo, forwardRef, KeyboardEvent } from "react";
import { ActionButton } from "@seed-design/react";
import type { BuiltinSlashCommandResult, CompactResultInfo, QueuedMessages } from "@/hooks/useAgentSession";
import { SoundToggle } from "./SoundToggle";
import { LiveVoiceButton } from "./LiveVoiceButton";
import { Gpt6HandleBadge } from "./Gpt6HandleBadge";
import type { ModelRoleAssignment, SkillsResponse } from "@/lib/api-types";
import type { SlashCommandInfo } from "@/lib/omp-types";
import type { TextContent, UserMessage } from "@/lib/types";
import {
  clearDraft,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
  rekeyDraft as rekeyStoredDraft,
  setDraft,
  type ChatDraftDocument,
  type ChatDraftImage,
} from "@/lib/draft-store";
import {
  MAX_ATTACHED_IMAGE_BYTES,
  MAX_ATTACHED_IMAGES,
  isBase64ImageWithinLimits,
} from "@/lib/image-attachments";
import {
  DOCUMENT_MIME_BY_KIND,
  DocumentAttachmentError,
  MAX_ATTACHED_DOCUMENT_BYTES,
  MAX_ATTACHED_DOCUMENT_TEXT_CHARS,
  MAX_ATTACHED_DOCUMENTS,
  MAX_ATTACHED_PDF_PAGES,
  MAX_TOTAL_ATTACHED_DOCUMENT_BYTES,
  MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS,
  classifyAttachmentFiles,
  extractAttachedDocument,
  formatAttachmentSize,
  getClipboardFiles,
  getSupportedDocumentKind,
  normalizeAttachedDocuments,
  parseDocumentPrompt,
  type AttachedDocument,
} from "@/lib/document-attachments";
import {
  buildEntriesFromFiles, buildAtInsertText, extractAtQuery, filterFileEntries,
  type AtQueryMatch, type FileIndexEntry,
} from "@/lib/file-fuzzy";
import { FolderIcon, getFileIcon } from "./FileIcons";
import { formatTokenCount } from "@/lib/format-tokens";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePopupPlacement } from "@/hooks/usePopupPlacement";
import { computePopupPlacement, preferredPopupHeight, POPUP_GAP_PX, type PopupSide } from "@/lib/popup-placement";
import { useI18n } from "@/hooks/useI18n";
import { PRESET_DEFAULT, PRESET_FULL } from "@/lib/tool-presets";
import {
  MAIN_PRESETS,
  avatarSrcForSeed,
  mainPresetSelection,
  type MainPresetSelection,
} from "@/lib/hanse-resource-client";

export interface AttachedImage {
  data: string;   // base64, no prefix
  mimeType: string;
  previewUrl: string; // object URL for display
}

export function prepareQueuedSubmission(
  message: string,
  images: AttachedImage[],
  documents: AttachedDocument[],
  isExtractingDocument: boolean,
) {
  if (isExtractingDocument || (!message && images.length === 0 && documents.length === 0)) return null;
  return {
    message,
    images: images.length ? images : undefined,
    documents: documents.length ? documents : undefined,
  };
}

export async function dispatchSlashSubmission(
  message: string,
  commands: SlashCommandInfo[] | undefined,
  onBuiltinCommand: Props["onBuiltinCommand"],
  sendPrompt: (message: string) => void,
  showError: (message: string) => void,
  hasAttachments: boolean,
  loadCommands?: Props["onLoadSlashCommands"],
): Promise<boolean> {
  const name = message.slice(1).split(/\s/, 1)[0];
  try {
    const discovered = commands?.length ? commands : await loadCommands?.() ?? [];
    const command = [...BUILTIN_SLASH_COMMANDS, ...discovered]
      .find((entry) => entry.name === name || ("aliases" in entry && entry.aliases?.includes(name)));
    if (hasAttachments && (!command || command.source === "builtin")) {
      showError(`/${name} cannot run with attachments. Remove them and retry.`);
      return false;
    }
    const result = await onBuiltinCommand?.(message);
    if (result?.handled) {
      if (result.error) return false;
      if (result.prompt) sendPrompt(result.prompt);
      return true;
    }
    if (command && command.source !== "builtin") {
      sendPrompt(message);
      return true;
    }
    showError(`/${name} is not available in this web session.`);
    return false;
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
    return false;
  }
}

interface ComposerDocument extends AttachedDocument {
  id: number;
  status: "extracting" | "ready";
}

interface ModelOption {
  provider: string;
  modelId: string;
  name: string;
}

interface Props {
  onSend: (message: string, images?: AttachedImage[], documents?: AttachedDocument[]) => void;
  onAbort: () => void;
  onSteer?: (message: string, images?: AttachedImage[], documents?: AttachedDocument[]) => void;
  onFollowUp?: (message: string, images?: AttachedImage[], documents?: AttachedDocument[]) => void;
  onPromptWithStreamingBehavior?: (message: string, behavior: "steer" | "followUp", images?: AttachedImage[], documents?: AttachedDocument[]) => void;
  isStreaming: boolean;
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string }[];
  modelError?: string | null;
  /** Diagnostics from resolving `enabledModels`, e.g. a pattern that matched nothing. */
  modelScopeWarnings?: string[];
  onModelChange?: (provider: string, modelId: string) => void;
  /**
   * Main 프리셋 하나를 이 대화에 적용한다 — 모델·계정·thinking auto를 한 동작으로 보낸다.
   * 적용은 기존 선택 경로로만 가고, 실패하면 이전 선택이 유지된다. 성공했을 때만 `true`를
   * 돌려주며, 화면 표시는 그 값이 아니라 아래 `mainPresetActiveAlias`가 정한다.
   */
  onMainPresetChange?: (preset: MainPresetSelection) => Promise<boolean>;
  /**
   * 지금 대화에 실제로 적용된 프리셋 자리. 세션은 모델 + 런타임이 답한 계정 자리 + Auto 설정,
   * 새 대화는 그 대화에 대기 중인 선택에서 계산해 넘긴다 — 화면에서 계정 자리를 추측하지 않는다.
   */
  mainPresetActiveAlias?: string | null;
  /** omp's model roles (default/smol/slow/plan/commit/…) with their assignments. */
  modelRoles?: ModelRoleAssignment[];
  onRoleModelChange?: (role: string) => void;
  modelSwitching?: boolean;
  onCompact?: () => void;
  onAbortCompaction?: () => void;
  isCompacting?: boolean;
  compactError?: string | null;
  compactResult?: CompactResultInfo | null;
  toolPreset?: "none" | "default" | "full";
  onToolPresetChange?: (preset: "none" | "default" | "full") => void;
  thinkingLevel?: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  effectiveThinkingLevel?: string;
  onThinkingLevelChange?: (level: "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max") => void;
  availableThinkingLevels?: string[] | null;
  thinkingLevelMap?: Record<string, string | null> | null;
  retryInfo?: { attempt: number; maxAttempts: number; errorMessage?: string } | null;
  queuedMessages?: QueuedMessages | null;
  inputHistory?: string[];
  onRecallQueue?: () => void;
  slashCommands?: SlashCommandInfo[];
  slashCommandsLoading?: boolean;
  onLoadSlashCommands?: () => Promise<SlashCommandInfo[]> | SlashCommandInfo[];
  onBuiltinCommand?: (message: string) => Promise<BuiltinSlashCommandResult>;
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  onAudioUnlock?: () => void;
  draftKey?: string;
  /** Session working directory — enables the @ file autocomplete menu */
  cwd?: string | null;
  /** Session this composer writes to — enables the live voice call. */
  sessionId?: string;
  /** Creates the session for an unsent conversation so a call can start from it. */
  onEnsureSession?: () => Promise<string | null>;
  /** Reloads the chat after a finalized live voice turn is durably stored. */
  onLiveTranscriptPersisted?: (sessionId: string) => void | Promise<void>;
}

export interface ChatInputHandle {
  insertText: (text: string) => void;
  insertIfEmpty: (text: string) => void;
  replaceMessage: (message: UserMessage) => void;
  addAttachments: (files: File[]) => void;
  rekeyDraft: (previousKey: string, nextKey: string) => void;
  restoreSubmission: (
    text: string,
    images?: ChatDraftImage[],
    documents?: ChatDraftDocument[],
    targetDraftKey?: string,
  ) => void;
}

const TOOL_PRESETS = ["off", "default", "full"] as const;
const TOOL_PRESET_MAP: Record<"off" | "default" | "full", "none" | "default" | "full"> = { off: "none", default: "default", full: "full" };
const DEFAULT_TOOL_LABEL = PRESET_DEFAULT.join(" · ");
const FULL_TOOL_ADDITIONS = PRESET_FULL.filter((name) => !PRESET_DEFAULT.includes(name)).join(" · ");
const COMPOSITION_END_ENTER_GRACE_MS = 100;

/** Offset a composer popup from the input on the side placement chose. */
function popupOffset(side: PopupSide): React.CSSProperties {
  return side === "above"
    ? { bottom: `calc(100% + ${POPUP_GAP_PX}px)` }
    : { top: `calc(100% + ${POPUP_GAP_PX}px)` };
}

const MODEL_FILTER_THRESHOLD = 8;
const MODEL_DROPDOWN_MAX_HEIGHT_PX = 460;
const MODEL_OPTION_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
let nextDocumentAttachmentId = 0;
const DOCUMENT_KIND_LABEL: Record<AttachedDocument["mimeType"], string> = {
  "text/markdown": "Markdown",
  "text/plain": "Text",
  "application/pdf": "PDF",
};

function compareModelOptions(a: ModelOption, b: ModelOption): number {
  return MODEL_OPTION_COLLATOR.compare(a.name || a.modelId, b.name || b.modelId)
    || MODEL_OPTION_COLLATOR.compare(a.provider, b.provider)
    || MODEL_OPTION_COLLATOR.compare(a.modelId, b.modelId);
}

export function filterModelOptions(options: ModelOption[], query: string): ModelOption[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return options;

  return options.filter((option) => (
    `${option.name} ${option.modelId}`
      .toLocaleLowerCase()
      .includes(normalizedQuery)
  ));
}

const THINKING_LEVELS = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const THINKING_LEVEL_DESC_KEYS: Record<typeof THINKING_LEVELS[number], string> = {
  auto: "chat.thinkingAuto", off: "chat.thinkingOff", minimal: "chat.thinkingMinimal", low: "chat.thinkingLow",
  medium: "chat.thinkingMedium", high: "chat.thinkingHigh", xhigh: "chat.thinkingXhigh", max: "chat.thinkingMax",
};

/**
 * 마지막으로 고른 Main 프리셋 자리. 화면 표시용으로만 브라우저에 남기며 전역 설정이나
 * 다른 세션의 선택을 바꾸지 않는다.
 */

type LocalBuiltinSlashCommand = {
  name: string;
  descriptionKey: string;
  source: "builtin";
};

type SlashCommandPaletteItem = SlashCommandInfo | LocalBuiltinSlashCommand;

type SlashCommandSource = SlashCommandPaletteItem["source"];

const BUILTIN_SLASH_COMMANDS: LocalBuiltinSlashCommand[] = [
  { name: "compact", descriptionKey: "chat.commandCompact", source: "builtin" },
  { name: "reload", descriptionKey: "chat.commandReload", source: "builtin" },
  { name: "name", descriptionKey: "chat.commandName", source: "builtin" },
  { name: "session", descriptionKey: "chat.commandSession", source: "builtin" },
  { name: "copy", descriptionKey: "chat.commandCopy", source: "builtin" },
];

const SLASH_SOURCES: SlashCommandSource[] = ["builtin", "extension", "custom", "mcp_prompt", "prompt", "file", "skill"];

const SLASH_SOURCE_GROUP_LABEL_KEYS: Record<SlashCommandSource, string> = {
  builtin: "chat.builtIn",
  extension: "chat.extensions",
  custom: "chat.customCommands",
  mcp_prompt: "chat.mcpPrompts",
  prompt: "chat.prompts",
  file: "chat.fileCommands",
  skill: "chat.skills",
};

const SLASH_SOURCE_ORDER: Record<SlashCommandSource, number> = {
  builtin: 0,
  extension: 1,
  custom: 2,
  mcp_prompt: 3,
  prompt: 4,
  file: 5,
  skill: 6,
};

function slashMatchRank(command: SlashCommandPaletteItem, query: string, t: (key: string) => string): number {
  const name = command.name.toLowerCase();
  const description = getSlashDescription(command, t).toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return 4;
}

function getSlashDescription(command: SlashCommandPaletteItem, t: (key: string) => string): string {
  return "descriptionKey" in command ? t(command.descriptionKey) : command.description ?? "";
}

// Skill slash commands are named "skill:<skillName>"; look the skill up in the
// dormancy map fetched from /api/skills. Unknown skills are treated as active.
function isDormantSkillCommand(command: SlashCommandPaletteItem, dormancy: Record<string, boolean>): boolean {
  if (command.source !== "skill" || !command.name.startsWith("skill:")) return false;
  return dormancy[command.name.slice("skill:".length)] === true;
}

export function buildSlashCommandLayout(
  commands: SlashCommandPaletteItem[],
  dormancy: Record<string, boolean>,
) {
  let index = 0;
  const groups = SLASH_SOURCES
    .map((source) => {
      const sourceCommands = commands.filter((command) => command.source === source);
      const orderedCommands = source === "skill"
        ? [
            ...sourceCommands.filter((command) => !isDormantSkillCommand(command, dormancy)),
            ...sourceCommands.filter((command) => isDormantSkillCommand(command, dormancy)),
          ]
        : sourceCommands;
      return {
        source,
        items: orderedCommands.map((command) => ({ command, index: index++ })),
      };
    })
    .filter((group) => group.items.length > 0);

  return {
    commands: groups.flatMap((group) => group.items.map(({ command }) => command)),
    groups,
  };
}

function imageToDraftImage(image: AttachedImage): ChatDraftImage {
  return { data: image.data, mimeType: image.mimeType };
}

function draftImageToAttachedImage(image: ChatDraftImage): AttachedImage {
  return {
    ...image,
    previewUrl: `data:${image.mimeType};base64,${image.data}`,
  };
}

function draftImagesToAttachedImages(images: ChatDraftImage[] | undefined): AttachedImage[] {
  return (images ?? [])
    .filter(isBase64ImageWithinLimits)
    .slice(0, MAX_ATTACHED_IMAGES)
    .map(draftImageToAttachedImage);
}
function draftDocumentsToComposerDocuments(documents: ChatDraftDocument[] | undefined): ComposerDocument[] {
  return normalizeAttachedDocuments(documents).map((document) => ({
    ...document,
    id: ++nextDocumentAttachmentId,
    status: "ready",
  }));
}


export function canRestoreUserMessage(
  value: string,
  attachedImageCount: number,
  pendingImageCount: number,
  attachedDocumentCount = 0,
): boolean {
  return !value.trim()
    && attachedImageCount === 0
    && pendingImageCount === 0
    && attachedDocumentCount === 0;
}

export function getUserMessageText(message: UserMessage): string {
  const text = typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
  return parseDocumentPrompt(text)?.message ?? text;
}

export function getUserMessageDraftDocuments(message: UserMessage): ChatDraftDocument[] {
  const text = typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block): block is TextContent => block.type === "text")
        .map((block) => block.text)
        .join("\n");
  return parseDocumentPrompt(text)?.documents ?? [];
}

export function getUserMessageDraftImages(message: UserMessage): ChatDraftImage[] {
  if (typeof message.content === "string") return [];
  return message.content.flatMap((block) => {
    if (block.type !== "image") return [];

    // Support both the current nested image format and older flat pi-ai entries.
    const flat = block as unknown as { data?: unknown; mimeType?: unknown };
    const data = block.source?.type === "base64" ? block.source.data : flat.data;
    const mimeType = block.source?.type === "base64" ? block.source.media_type : flat.mimeType;
    if (typeof data !== "string" || typeof mimeType !== "string") return [];

    const image = { data, mimeType };
    return isBase64ImageWithinLimits(image) ? [image] : [];
  });
}

function revokeImagePreview(image: AttachedImage): void {
  if (image.previewUrl.startsWith("blob:")) {
    URL.revokeObjectURL(image.previewUrl);
  }
}

function QueuedMessageRow({ kind, text }: { kind: "steer" | "follow-up"; text: string }) {
  const parsed = parseDocumentPrompt(text);
  const displayText = parsed
    ? [parsed.message, parsed.documents.map((document) => document.name).join(", ")].filter(Boolean).join(" · ")
    : text;
  return (
    <div
      title={displayText}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "3px 10px",
        fontSize: 12,
        color: "var(--text-muted)",
        minWidth: 0,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          padding: "1px 7px",
          borderRadius: "var(--seed-radius-full)",
          border: `1px solid ${kind === "steer" ? "color-mix(in srgb, var(--accent) 45%, transparent)" : "var(--border)"}`,
          color: kind === "steer" ? "var(--accent)" : "var(--text-dim)",
        }}
      >
        {kind}
      </span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayText}</span>
    </div>
  );
}

function ModelNoticeBanner({ tone, title, body }: { tone: "error" | "warning"; title: string; body: string }) {
  const role = tone === "error" ? "danger" : "warning";
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        maxHeight: 120,
        marginBottom: 8,
        padding: "7px 10px",
        overflowY: "auto",
        border: `1px solid var(--${role}-line)`,
        borderRadius: "var(--radius-control)",
        background: `var(--${role}-soft)`,
        color: `var(--${role})`,
        fontSize: 11,
        lineHeight: 1.45,
      }}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        style={{ flexShrink: 0, marginTop: 1 }}
        aria-hidden="true"
      >
        <path d="M10.3 2.9 1.8 17a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 2.9a2 2 0 0 0-3.4 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</div>
      </div>
    </div>
  );
}

export function ModelErrorBanner({ error }: { error?: string | null }) {
  if (!error) return null;
  return <ModelNoticeBanner tone="error" title="Model error" body={error} />;
}

/** Surfaces `enabledModels` patterns that matched nothing, so a typo is visible (#307). */
export function ModelScopeWarningBanner({ warnings }: { warnings?: string[] }) {
  if (!warnings || warnings.length === 0) return null;
  return (
    <ModelNoticeBanner
      tone="warning"
      title={warnings.length > 1 ? "Model scope warnings" : "Model scope warning"}
      body={warnings.join("\n")}
    />
  );
}

export const ChatInput = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSend, onAbort, onSteer, onFollowUp, isStreaming, model, isAutoModelSelection, modelNames, modelList, modelError, modelScopeWarnings, onModelChange,
  onMainPresetChange,
  mainPresetActiveAlias,
  modelRoles, onRoleModelChange, modelSwitching,
  onCompact, onAbortCompaction, isCompacting, compactError, compactResult, toolPreset, onToolPresetChange,
  thinkingLevel, effectiveThinkingLevel, onThinkingLevelChange, availableThinkingLevels, thinkingLevelMap,
  retryInfo, queuedMessages, inputHistory = [], onRecallQueue,
  slashCommands, slashCommandsLoading, onLoadSlashCommands,
  onBuiltinCommand,
  soundEnabled, onSoundToggle, onAudioUnlock,
  onPromptWithStreamingBehavior,
  draftKey,
  cwd,
  sessionId,
  onEnsureSession,
  onLiveTranscriptPersisted,
}: Props, ref) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [value, setValue] = useState(() => (draftKey ? getDraft(draftKey)?.value ?? "" : ""));
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [modelDropdownRect, setModelDropdownRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [presetDropdownOpen, setPresetDropdownOpen] = useState(false);
  const [presetDropdownRect, setPresetDropdownRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const [toolDropdownOpen, setToolDropdownOpen] = useState(false);
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(() => (
    draftKey ? draftImagesToAttachedImages(getDraft(draftKey)?.images) : []
  ));
  const [attachedDocuments, setAttachedDocuments] = useState<ComposerDocument[]>(() => (
    draftKey ? draftDocumentsToComposerDocuments(getDraft(draftKey)?.documents) : []
  ));
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const readyDocuments = useMemo(
    () => attachedDocuments.filter((document) => document.status === "ready"),
    [attachedDocuments],
  );
  const isExtractingDocument = attachedDocuments.some((document) => document.status === "extracting");
  const commandValue = value.trimStart();
  const bashMode = attachedImages.length === 0 && attachedDocuments.length === 0 && commandValue.startsWith("!");
  const bashExcluded = bashMode && commandValue.startsWith("!!");
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashActiveIndex, setSlashActiveIndex] = useState(0);
  const [atQuery, setAtQuery] = useState<AtQueryMatch | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atActiveIndex, setAtActiveIndex] = useState(0);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyActiveIndex, setHistoryActiveIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ cwd: string; entries: FileIndexEntry[]; truncated: boolean } | null>(null);
  const [fileIndexLoading, setFileIndexLoading] = useState(false);
  const [atServerResult, setAtServerResult] = useState<{ cwd: string; query: string; matches: FileIndexEntry[] } | null>(null);
  const [skillDormancyState, setSkillDormancyState] = useState<{
    cwd: string;
    values: Record<string, boolean>;
  } | null>(null);
  const skillDormancy = cwd && skillDormancyState?.cwd === cwd
    ? skillDormancyState.values
    : {};

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownPanelRef = useRef<HTMLDivElement>(null);
  const presetDropdownRef = useRef<HTMLDivElement>(null);
  const presetDropdownPanelRef = useRef<HTMLDivElement>(null);
  const toolDropdownRef = useRef<HTMLDivElement>(null);
  const thinkingDropdownRef = useRef<HTMLDivElement>(null);
  const controlsMenuRef = useRef<HTMLDivElement>(null);
  const historyMenuRef = useRef<HTMLDivElement>(null);
  const composerAnchorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);
  const lastCompositionEndAtRef = useRef(0);
  const slashCommandsRequestedRef = useRef(false);
  const slashItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const atItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const historyItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const fileIndexMetaRef = useRef<{ cwd: string; fetchedAt: number } | null>(null);
  const fileIndexFetchingRef = useRef<string | null>(null);
  const draftKeyRef = useRef(draftKey);
  const valueRef = useRef(value);
  const attachedImagesRef = useRef(attachedImages);
  const pendingImageCountRef = useRef(0);
  const attachedDocumentsRef = useRef(attachedDocuments);
  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  attachedDocumentsRef.current = attachedDocuments;


  useImperativeHandle(ref, () => ({
    insertIfEmpty(text: string) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (current.trim()) return;
      const next = text;
      valueRef.current = next;
      setValue(next);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    replaceMessage(message: UserMessage) {
      const ta = textareaRef.current;
      const current = ta ? ta.value : value;
      if (!canRestoreUserMessage(
        current,
        attachedImagesRef.current.length,
        pendingImageCountRef.current,
        attachedDocumentsRef.current.length,
      )) return;

      const restoredText = getUserMessageText(message);
      const restoredImages = draftImagesToAttachedImages(getUserMessageDraftImages(message));
      const restoredDocuments = draftDocumentsToComposerDocuments(getUserMessageDraftDocuments(message));
      valueRef.current = restoredText;
      attachedImagesRef.current = restoredImages;
      attachedDocumentsRef.current = restoredDocuments;
      setValue(restoredText);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      setAttachedImages((prev) => {
        prev.forEach(revokeImagePreview);
        return restoredImages;
      });
      setAttachedDocuments(restoredDocuments);
      requestAnimationFrame(() => {
        if (!ta) return;
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    rekeyDraft(previousKey: string, nextKey: string) {
      if (previousKey === nextKey) return;
      if (draftKeyRef.current !== previousKey) {
        rekeyStoredDraft(previousKey, nextKey);
        return;
      }

      const currentDraft = {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        documents: attachedDocumentsRef.current
          .filter((document) => document.status === "ready")
          .map(({ name, mimeType, size, text }) => ({ name, mimeType, size, text })),
      };
      const moved = rekeyStoredDraft(previousKey, nextKey, currentDraft)
        ?? { value: "", images: [], documents: [] };
      const unchanged = moved.value === currentDraft.value
        && moved.images.length === currentDraft.images.length
        && moved.images.every((image, index) => (
          image.data === currentDraft.images[index]?.data
          && image.mimeType === currentDraft.images[index]?.mimeType
        ))
        && moved.documents.length === currentDraft.documents.length
        && moved.documents.every((document, index) => (
          document.name === currentDraft.documents[index]?.name
          && document.mimeType === currentDraft.documents[index]?.mimeType
          && document.size === currentDraft.documents[index]?.size
          && document.text === currentDraft.documents[index]?.text
        ));
      draftKeyRef.current = nextKey;
      if (unchanged) return;
      const movedImages = draftImagesToAttachedImages(moved.images);
      const movedDocuments = draftDocumentsToComposerDocuments(moved.documents);

      const movedValue = moved.value;
      valueRef.current = movedValue;
      attachedImagesRef.current = movedImages;
      attachedDocumentsRef.current = movedDocuments;
      setValue(movedValue);
      setAttachedImages((current) => {
        current.forEach(revokeImagePreview);
        return movedImages;
      });
      setAttachedDocuments(movedDocuments);
      setAtQuery(null);
      setHistoryMenuOpen(false);
    },
    restoreSubmission(
      text: string,
      images?: ChatDraftImage[],
      documents?: ChatDraftDocument[],
      targetDraftKey?: string,
    ) {
      if (!text.trim() && !images?.length && !documents?.length) return;

      // clearInput is queued before the submission handler runs. Compose with
      // that queued state so a fast rejection cannot observe stale DOM text and
      // then get overwritten by the clear.
      const currentDraftKey = draftKeyRef.current;
      const destinationDraftKey = targetDraftKey ?? currentDraftKey;
      const targetsCurrentComposer = destinationDraftKey === currentDraftKey;
      const storedDraft = !targetsCurrentComposer && destinationDraftKey
        ? getDraft(destinationDraftKey)
        : null;
      const currentText = targetsCurrentComposer ? valueRef.current : (storedDraft?.value ?? "");
      const mergedDraft = mergeRestoredSubmissionDraft(
        text,
        images,
        currentText,
        targetsCurrentComposer
          ? attachedImagesRef.current.map(imageToDraftImage)
          : (storedDraft?.images ?? []),
        documents,
        targetsCurrentComposer
          ? attachedDocumentsRef.current
              .filter((document) => document.status === "ready")
              .map(({ name, mimeType, size, text }) => ({ name, mimeType, size, text }))
          : (storedDraft?.documents ?? []),
      );
      const restoredDraft = mergedDraft;
      // The first optimistic message switches ChatWindow out of its empty-state
      // layout and remounts this component. Persist synchronously so recovery is
      // not lost if this instance is the one being unmounted.
      if (destinationDraftKey) setDraft(destinationDraftKey, restoredDraft);
      if (!targetsCurrentComposer) return;
      const restoredImages = images?.length
        ? [
            ...draftImagesToAttachedImages(images).slice(
              0,
              Math.max(0, MAX_ATTACHED_IMAGES - attachedImagesRef.current.length),
            ),
            ...attachedImagesRef.current,
          ].slice(0, MAX_ATTACHED_IMAGES)
        : attachedImagesRef.current;
      const restoredDocuments = draftDocumentsToComposerDocuments(restoredDraft.documents);
      // Session promotion can rekey this composer before React flushes the
      // functional updates below, so update the imperative snapshot first.
      valueRef.current = restoredDraft.value;
      attachedImagesRef.current = restoredImages;
      attachedDocumentsRef.current = restoredDocuments;
      setValue(restoredDraft.value);
      setAtQuery(null);
      setHistoryMenuOpen(false);
      if (images?.length) {
        setAttachedImages((current) => {
          const available = Math.max(0, MAX_ATTACHED_IMAGES - current.length);
          const restored = draftImagesToAttachedImages(images)
            .slice(0, available);
          const next = restored.length > 0 ? [...restored, ...current] : current;
          attachedImagesRef.current = next;
          return next;
        });
      }
      setAttachedDocuments(restoredDocuments);
      requestAnimationFrame(() => {
        const ta = textareaRef.current;
        if (!ta) return;
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    insertText(text: string) {
      const ta = textareaRef.current;
      if (!ta) {
        setValue((v) => v + (v ? " " : "") + text);
        return;
      }
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const sep = before.length > 0 && !before.endsWith(" ") ? " " : "";
      const newVal = before + sep + text + after;
      valueRef.current = newVal;
      setValue(newVal);
      setAtQuery(null);
      requestAnimationFrame(() => {
        if (!ta) return;
        const pos = start + sep.length + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
      });
    },
    addAttachments(files: File[]) {
      void processAttachmentFiles(files);
    },
  }));

  const processImageFiles = useCallback(async (files: File[]) => {
    const remaining = Math.max(
      0,
      MAX_ATTACHED_IMAGES - attachedImagesRef.current.length - pendingImageCountRef.current,
    );
    const oversized = files.filter((f) => f.size > MAX_ATTACHED_IMAGE_BYTES);
    if (oversized.length > 0) {
      setAttachmentError(t("chat.attachImageTooLarge", {
        name: oversized.map((file) => file.name).join(", "),
        limit: formatAttachmentSize(MAX_ATTACHED_IMAGE_BYTES),
      }));
    }
    const withinSize = files.filter((f) => f.size <= MAX_ATTACHED_IMAGE_BYTES);
    const imageFiles = withinSize.slice(0, remaining);
    if (imageFiles.length < withinSize.length) {
      setAttachmentError(t("chat.attachImageLimit", { count: MAX_ATTACHED_IMAGES }));
    }
    if (!imageFiles.length) return;
    pendingImageCountRef.current += imageFiles.length;
    try {
      const newImages = await Promise.all(
        imageFiles.map(
          (file) =>
            new Promise<AttachedImage>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                // result is "data:<mime>;base64,<data>"
                const base64 = result.split(",")[1];
                resolve({ data: base64, mimeType: file.type, previewUrl: URL.createObjectURL(file) });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file);
            })
        )
      );
      setAttachedImages((prev) => {
        const accepted = newImages.slice(0, Math.max(0, MAX_ATTACHED_IMAGES - prev.length));
        newImages.slice(accepted.length).forEach(revokeImagePreview);
        const next = [...prev, ...accepted];
        attachedImagesRef.current = next;
        return next;
      });
    } finally {
      pendingImageCountRef.current -= imageFiles.length;
    }
  }, [t]);

  const processDocumentFiles = useCallback(async (files: File[]) => {
    for (const file of files) {
      const kind = getSupportedDocumentKind(file);
      if (!kind) continue;
      if (attachedDocumentsRef.current.length >= MAX_ATTACHED_DOCUMENTS) {
        setAttachmentError(t("chat.attachLimit", { count: MAX_ATTACHED_DOCUMENTS }));
        continue;
      }
      if (file.size > MAX_ATTACHED_DOCUMENT_BYTES) {
        setAttachmentError(t("chat.attachTooLarge", {
          name: file.name,
          limit: formatAttachmentSize(MAX_ATTACHED_DOCUMENT_BYTES),
        }));
        continue;
      }
      const currentBytes = attachedDocumentsRef.current.reduce((total, document) => total + document.size, 0);
      if (currentBytes + file.size > MAX_TOTAL_ATTACHED_DOCUMENT_BYTES) {
        setAttachmentError(t("chat.attachTotalTooLarge", {
          limit: formatAttachmentSize(MAX_TOTAL_ATTACHED_DOCUMENT_BYTES),
        }));
        continue;
      }

      const pending: ComposerDocument = {
        id: ++nextDocumentAttachmentId,
        name: file.name,
        mimeType: DOCUMENT_MIME_BY_KIND[kind],
        size: file.size,
        text: "",
        status: "extracting",
      };
      const withPending = [...attachedDocumentsRef.current, pending];
      attachedDocumentsRef.current = withPending;
      setAttachedDocuments(withPending);

      try {
        const extracted = await extractAttachedDocument(file);
        const currentTextChars = attachedDocumentsRef.current.reduce(
          (total, document) => total + (document.id === pending.id ? 0 : document.text.length),
          0,
        );
        if (currentTextChars + extracted.text.length > MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS) {
          throw new DocumentAttachmentError(
            "text_too_large",
            `Total extracted text exceeds ${MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS} characters`,
          );
        }
        const next = attachedDocumentsRef.current.map((document) => (
          document.id === pending.id
            ? { ...extracted, id: document.id, status: "ready" as const }
            : document
        ));
        attachedDocumentsRef.current = next;
        setAttachedDocuments(next);
      } catch (error) {
        const stillAttached = attachedDocumentsRef.current.some((document) => document.id === pending.id);
        const next = attachedDocumentsRef.current.filter((document) => document.id !== pending.id);
        attachedDocumentsRef.current = next;
        setAttachedDocuments(next);
        if (!stillAttached) continue;
        if (error instanceof DocumentAttachmentError) {
          if (error.code === "text_too_large") {
            setAttachmentError(t("chat.attachTextTooLarge", {
              name: file.name,
              limit: MAX_ATTACHED_DOCUMENT_TEXT_CHARS.toLocaleString(),
            }));
          } else if (error.code === "too_many_pages") {
            setAttachmentError(t("chat.attachTooManyPages", {
              name: file.name,
              limit: MAX_ATTACHED_PDF_PAGES,
            }));
          } else if (error.code === "no_extractable_text") {
            setAttachmentError(t("chat.attachNoPdfText", { name: file.name }));
          } else if (error.code === "password_protected") {
            setAttachmentError(t("chat.attachPasswordProtected", { name: file.name }));
          } else {
            setAttachmentError(t("chat.attachExtractFailed", { name: file.name }));
          }
        } else {
          setAttachmentError(t("chat.attachExtractFailed", { name: file.name }));
        }
      }
    }
  }, [t]);

  const processAttachmentFiles = useCallback(async (files: File[]) => {
    setAttachmentError(null);
    const { images, documents, unsupported } = classifyAttachmentFiles(files);
    if (unsupported.length > 0) {
      setAttachmentError(t("chat.attachUnsupported", {
        names: unsupported.map((file) => file.name).join(", "),
      }));
    }
    await Promise.all([
      processImageFiles(images),
      processDocumentFiles(documents),
    ]);
  }, [processDocumentFiles, processImageFiles, t]);

  const removeImage = useCallback((index: number) => {
    setAttachedImages((prev) => {
      const next = [...prev];
      const [removed] = next.splice(index, 1);
      if (removed) revokeImagePreview(removed);
      attachedImagesRef.current = next;
      return next;
    });
  }, []);

  const removeDocument = useCallback((id: number) => {
    const next = attachedDocumentsRef.current.filter((document) => document.id !== id);
    attachedDocumentsRef.current = next;
    setAttachedDocuments(next);
  }, []);

  const clearImages = useCallback(() => {
    attachedImagesRef.current = [];
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return [];
    });
  }, []);

  const clearDocuments = useCallback(() => {
    attachedDocumentsRef.current = [];
    setAttachedDocuments([]);
  }, []);

  const clearInput = useCallback(() => {
    valueRef.current = "";
    setValue("");
    setAtQuery(null);
    setHistoryMenuOpen(false);
    if (draftKey) clearDraft(draftKey);
    if (draftKeyRef.current && draftKeyRef.current !== draftKey) clearDraft(draftKeyRef.current);
    clearImages();
    clearDocuments();
    setAttachmentError(null);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [clearDocuments, clearImages, draftKey]);

  useEffect(() => {
    if (!draftKey || draftKeyRef.current !== draftKey) return;
    setDraft(draftKey, {
      value,
      images: attachedImages.map(imageToDraftImage),
      documents: readyDocuments.map(({ name, mimeType, size, text }) => ({ name, mimeType, size, text })),
    });
  }, [attachedImages, draftKey, readyDocuments, value]);

  useEffect(() => {
    const previousDraftKey = draftKeyRef.current;
    if (previousDraftKey === draftKey) return;

    if (previousDraftKey) {
      setDraft(previousDraftKey, {
        value: valueRef.current,
        images: attachedImagesRef.current.map(imageToDraftImage),
        documents: attachedDocumentsRef.current
          .filter((document) => document.status === "ready")
          .map(({ name, mimeType, size, text }) => ({ name, mimeType, size, text })),
      });
    }

    const draft = draftKey ? getDraft(draftKey) : null;
    draftKeyRef.current = draftKey;
    const nextValue = draft?.value ?? "";
    const nextImages = draftImagesToAttachedImages(draft?.images);
    const nextDocuments = draftDocumentsToComposerDocuments(draft?.documents);
    valueRef.current = nextValue;
    attachedImagesRef.current = nextImages;
    attachedDocumentsRef.current = nextDocuments;
    setValue(nextValue);
    setAtQuery(null);
    setHistoryMenuOpen(false);
    setAttachedImages((prev) => {
      prev.forEach(revokeImagePreview);
      return nextImages;
    });
    setAttachedDocuments(nextDocuments);
  }, [draftKey]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    if (value) ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    return () => {
      attachedImagesRef.current.forEach(revokeImagePreview);
    };
  }, []);

  const handleSend = useCallback(async () => {
    const rawMessage = value.trim();
    const commandMessage = commandValue.trim();
    const msg = commandMessage.startsWith("/") || commandMessage.startsWith("!")
      ? commandMessage
      : rawMessage;
    if (!msg && !attachedImages.length && !readyDocuments.length) return;
    if (isStreaming || isExtractingDocument) return;
    onAudioUnlock?.();
    if (msg.startsWith("/")) {
      const handled = await dispatchSlashSubmission(
        msg,
        slashCommands,
        onBuiltinCommand,
        (prompt) => onSend(prompt, attachedImages.length ? attachedImages : undefined, readyDocuments.length ? readyDocuments : undefined),
        setAttachmentError,
        Boolean(attachedImages.length || readyDocuments.length),
        onLoadSlashCommands,
      );
      if (handled) clearInput();
      return;
    }
    clearInput();
    onSend(
      msg,
      attachedImages.length ? attachedImages : undefined,
      readyDocuments.length ? readyDocuments : undefined,
    );
  }, [
    value,
    commandValue,
    attachedImages,
    readyDocuments,
    isExtractingDocument,
    isStreaming,
    onBuiltinCommand,
    slashCommands,
    onLoadSlashCommands,
    onSend,
    clearInput,
    onAudioUnlock,
  ]);

  const slashQuery = commandValue.startsWith("/") && !/\s/.test(commandValue.slice(1))
    ? commandValue.slice(1).toLowerCase()
    : null;

  const filteredSlashCommands = (() => {
    if (slashQuery === null) return [];
    const commands = [...(isStreaming ? [] : BUILTIN_SLASH_COMMANDS), ...(slashCommands ?? [])];
    const seenNames = new Set<string>();
    return [...commands]
      .filter((command) => {
        const name = command.name.toLowerCase();
        const description = getSlashDescription(command, t).toLowerCase();
        return name.includes(slashQuery) || description.includes(slashQuery);
      })
      .sort((a, b) => {
        const rankDelta = slashMatchRank(a, slashQuery, t) - slashMatchRank(b, slashQuery, t);
        if (rankDelta !== 0) return rankDelta;
        return SLASH_SOURCE_ORDER[a.source] - SLASH_SOURCE_ORDER[b.source]
          || MODEL_OPTION_COLLATOR.compare(a.name, b.name);
      })
      .filter((command) => {
        const normalizedName = command.name.toLowerCase();
        if (seenNames.has(normalizedName)) return false;
        seenNames.add(normalizedName);
        return true;
      });
  })();

  const {
    commands: displayedSlashCommands,
    groups: groupedSlashCommands,
  } = buildSlashCommandLayout(filteredSlashCommands, skillDormancy);

  const slashCommandCountLabel = filteredSlashCommands.length === 1
    ? t(slashQuery ? "chat.match" : "chat.command")
    : t(slashQuery ? "chat.matches" : "chat.commands", { count: filteredSlashCommands.length });
  const hasInputText = Boolean(value.trim());
  const canSend = !isExtractingDocument
    && (hasInputText || attachedImages.length > 0 || readyDocuments.length > 0);
  const canQueueStreamingMessage = canSend;

  // ── @ file autocomplete ──────────────────────────────────────────────────
  // Recomputed from the text before the caret on every change/caret move.
  // Disabled entirely when there is no cwd (new session without a directory).
  const updateAtQuery = useCallback((text: string, cursor: number | null) => {
    if (!cwd) {
      setAtQuery(null);
      return;
    }
    const pos = cursor ?? text.length;
    setAtQuery(extractAtQuery(text.slice(0, pos)));
  }, [cwd]);

  const atQueryText = atQuery?.query ?? null;
  const atLocalMatches: FileIndexEntry[] = React.useMemo(() => (
    atQueryText !== null && fileIndex && fileIndex.cwd === cwd
      ? filterFileEntries(fileIndex.entries, atQueryText)
      : []
  ), [atQueryText, fileIndex, cwd]);

  // When the client index is truncated (repo larger than the index cap),
  // local filtering cannot see deep files, so queries are also ranked
  // server-side against the full listing. Local matches render immediately
  // and are replaced when the (debounced) server result for the current
  // query arrives; stale responses are ignored via the query/cwd tag.
  const needsServerSearch = Boolean(atQueryText && fileIndex?.truncated && fileIndex.cwd === cwd);
  useEffect(() => {
    if (!needsServerSearch || !cwd || !atQueryText) return;
    const fetchCwd = cwd;
    const query = atQueryText;
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}&q=${encodeURIComponent(query)}`)
        .then((res) => {
          if (!res.ok) throw new Error(`file search failed: ${res.status}`);
          return res.json() as Promise<{ matches?: FileIndexEntry[] }>;
        })
        .then((data) => setAtServerResult({ cwd: fetchCwd, query, matches: data.matches ?? [] }))
        .catch(() => {
          // Keep showing local matches; the next keystroke retries.
        });
    }, 150);
    return () => clearTimeout(timer);
  }, [needsServerSearch, atQueryText, cwd]);

  const serverResultInUse = needsServerSearch
    && atServerResult !== null
    && atServerResult.cwd === cwd
    && atServerResult.query === atQueryText;
  const atMatches: FileIndexEntry[] = serverResultInUse ? atServerResult.matches : atLocalMatches;

  // Open/reset the menu whenever the @token appears or changes (mirrors the
  // slash menu: Escape closes it, the next keystroke re-opens it).
  const atTokenKey = atQuery === null ? null : `${atQuery.start}:${atQuery.quoted ? 1 : 0}:${atQuery.query}`;
  useEffect(() => {
    if (atTokenKey === null) {
      setAtMenuOpen(false);
      setAtActiveIndex(0);
      return;
    }
    setAtMenuOpen(true);
    setAtActiveIndex(0);
  }, [atTokenKey]);

  // Fetch the file index when the menu opens. The server caches per cwd for
  // ~10s, so re-opening refreshes cheaply; while typing nothing refetches.
  const atTokenActive = atQuery !== null;

  // The composer is not always near the bottom of the window — a fresh session
  // centres it — so these popups pick their side and height from the space
  // actually left around it instead of always opening upwards at a fixed vh.
  const historyPlacement = usePopupPlacement(composerAnchorRef, historyMenuOpen, { viewportFraction: 0.44, cap: 360 });
  const slashPlacement = usePopupPlacement(composerAnchorRef, slashMenuOpen, { viewportFraction: 0.56, cap: 460 });
  const atPlacement = usePopupPlacement(composerAnchorRef, atMenuOpen, { viewportFraction: 0.48, cap: 400 });
  useEffect(() => {
    if (!atTokenActive || !cwd) return;
    const meta = fileIndexMetaRef.current;
    if (meta && meta.cwd === cwd && Date.now() - meta.fetchedAt < 10_000) return;
    if (fileIndexFetchingRef.current === cwd) return;
    fileIndexFetchingRef.current = cwd;
    const fetchCwd = cwd;
    setFileIndexLoading(true);
    fetch(`/api/file-index?cwd=${encodeURIComponent(fetchCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`file index failed: ${res.status}`);
        return res.json() as Promise<{ files?: string[]; truncated?: boolean }>;
      })
      .then((data) => {
        setFileIndex({ cwd: fetchCwd, entries: buildEntriesFromFiles(data.files ?? []), truncated: !!data.truncated });
        fileIndexMetaRef.current = { cwd: fetchCwd, fetchedAt: Date.now() };
      })
      .catch(() => {
        // Leave any previous index in place; next open retries.
        fileIndexMetaRef.current = null;
      })
      .finally(() => {
        fileIndexFetchingRef.current = null;
        setFileIndexLoading(false);
      });
  }, [atTokenActive, cwd]);

  const applyAtCompletion = useCallback((entry: FileIndexEntry) => {
    if (!atQuery) return;
    const ta = textareaRef.current;
    const cursor = ta?.selectionStart ?? value.length;
    const before = value.slice(0, atQuery.start);
    let after = value.slice(cursor);
    // Completing inside a quoted token (@"my dir/… with the caret before the
    // closing quote): the replacement carries its own closing quote, so drop
    // the old one right after the caret (mirrors the TUI's applyCompletion).
    if (atQuery.quoted && after.startsWith('"')) {
      after = after.slice(1);
    }
    const insert = buildAtInsertText(entry.path, entry.isDir, atQuery.quoted);
    const newValue = before + insert.text + after;
    const newPos = before.length + insert.cursorOffset;
    setValue(newValue);
    // setValue alone does not fire onChange — re-derive the token here. Files
    // end with a space (token closes, menu hides); directories end with "/"
    // before the caret (token stays open for drill-down into the directory).
    setAtQuery(extractAtQuery(newValue.slice(0, newPos)));
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(newPos, newPos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  }, [atQuery, value]);

  useEffect(() => {
    if (atActiveIndex >= atMatches.length) {
      setAtActiveIndex(Math.max(0, atMatches.length - 1));
    }
  }, [atMatches.length, atActiveIndex]);

  useEffect(() => {
    atItemRefs.current.length = atMatches.length;
  }, [atMatches.length]);

  useEffect(() => {
    if (!atMenuOpen) return;
    atItemRefs.current[atActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [atActiveIndex, atMenuOpen]);

  useEffect(() => {
    if (historyActiveIndex >= inputHistory.length) {
      setHistoryActiveIndex(Math.max(0, inputHistory.length - 1));
    }
  }, [inputHistory.length, historyActiveIndex]);

  useEffect(() => {
    historyItemRefs.current.length = inputHistory.length;
  }, [inputHistory.length]);

  useEffect(() => {
    if (!historyMenuOpen) return;
    historyItemRefs.current[historyActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [historyActiveIndex, historyMenuOpen]);

  const applyHistoryInput = useCallback((text: string) => {
    const nextValue = text;
    valueRef.current = nextValue;
    setValue(nextValue);
    setHistoryMenuOpen(false);
    setHistoryActiveIndex(0);
    setAtQuery(null);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const applySlashCommand = useCallback((command: SlashCommandPaletteItem) => {
    const nextValue = `/${command.name} `;
    valueRef.current = nextValue;
    setValue(nextValue);
    setSlashMenuOpen(false);
    setSlashActiveIndex(0);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(nextValue.length, nextValue.length);
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
  }, []);

  const sendQueued = useCallback(async (mode: "steer" | "followup") => {
    const rawMessage = value.trim();
    const commandMessage = commandValue.trim();
    const msg = commandMessage.startsWith("/") || commandMessage.startsWith("!")
      ? commandMessage
      : rawMessage;
    const submission = prepareQueuedSubmission(msg, attachedImages, readyDocuments, isExtractingDocument);
    if (!submission) return;
    onAudioUnlock?.();
    const streamingBehavior = mode === "steer" ? "steer" : "followUp";
    if (msg.startsWith("/")) {
      const handled = await dispatchSlashSubmission(
        msg,
        slashCommands,
        onBuiltinCommand,
        (prompt) => {
          if (!onPromptWithStreamingBehavior) throw new Error("Cannot queue this command while the session is busy.");
          onPromptWithStreamingBehavior(prompt, streamingBehavior, submission.images, submission.documents);
        },
        setAttachmentError,
        Boolean(submission.images?.length || submission.documents?.length),
        onLoadSlashCommands,
      );
      if (handled) clearInput();
      return;
    }
    clearInput();
    if (mode === "steer" && onSteer) {
      onSteer(submission.message, submission.images, submission.documents);
    } else if (mode === "followup" && onFollowUp) {
      onFollowUp(submission.message, submission.images, submission.documents);
    }
  }, [
    value,
    commandValue,
    attachedImages,
    readyDocuments,
    isExtractingDocument,
    slashCommands,
    onLoadSlashCommands,
    onBuiltinCommand,
    onPromptWithStreamingBehavior,
    onSteer,
    onFollowUp,
    clearInput,
    onAudioUnlock,
  ]);

  const getNextSlashIndex = useCallback((direction: "up" | "down" | "left" | "right") => {
    const lastIndex = displayedSlashCommands.length - 1;
    if (lastIndex < 0) return 0;

    if (direction === "left") return Math.max(0, slashActiveIndex - 1);
    if (direction === "right") return Math.min(lastIndex, slashActiveIndex + 1);

    const currentNode = slashItemRefs.current[slashActiveIndex];
    if (!currentNode) {
      return direction === "down"
        ? Math.min(lastIndex, slashActiveIndex + 1)
        : Math.max(0, slashActiveIndex - 1);
    }

    const currentRect = currentNode.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    let bestIndex = -1;
    let bestScore = Number.POSITIVE_INFINITY;

    for (let index = 0; index <= lastIndex; index += 1) {
      if (index === slashActiveIndex) continue;
      const node = slashItemRefs.current[index];
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      const candidateY = rect.top + rect.height / 2;
      const verticalDelta = candidateY - currentY;
      if (direction === "down" ? verticalDelta <= 4 : verticalDelta >= -4) continue;

      const candidateX = rect.left + rect.width / 2;
      const score = Math.abs(verticalDelta) * 1000 + Math.abs(candidateX - currentX);
      if (score < bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }

    if (bestIndex >= 0) return bestIndex;
    return direction === "down"
      ? Math.min(lastIndex, slashActiveIndex + 1)
      : Math.max(0, slashActiveIndex - 1);
  }, [displayedSlashCommands.length, slashActiveIndex]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const nativeEvent = e.nativeEvent;
      const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
      const isComposing =
        isComposingRef.current ||
        nativeEvent.isComposing ||
        nativeEvent.keyCode === 229;

      if (e.key === "Enter" && !e.shiftKey && (isComposing || recentlyComposed)) {
        if (recentlyComposed) e.preventDefault();
        return;
      }

      if (historyMenuOpen && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.min(Math.max(0, inputHistory.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setHistoryActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setHistoryMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && inputHistory[historyActiveIndex]) {
          e.preventDefault();
          applyHistoryInput(inputHistory[historyActiveIndex]);
          return;
        }
      }

      if (slashMenuOpen && slashQuery !== null) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("down"));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("up"));
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("right"));
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          setSlashActiveIndex(getNextSlashIndex("left"));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setSlashMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && displayedSlashCommands[slashActiveIndex]) {
          e.preventDefault();
          applySlashCommand(displayedSlashCommands[slashActiveIndex]);
          return;
        }
      }

      // @ file menu — skip while composing so IME candidate navigation
      // (arrows/Enter/Tab) is never intercepted.
      if (atMenuOpen && atQuery !== null && !isComposing) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.min(Math.max(0, atMatches.length - 1), i + 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setAtActiveIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setAtMenuOpen(false);
          return;
        }
        if ((e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) && atMatches[atActiveIndex]) {
          e.preventDefault();
          applyAtCompletion(atMatches[atActiveIndex]);
          return;
        }
      }

      if (e.key === "ArrowUp" && !isComposing && !isStreaming && inputHistory.length > 0 && value.trim().length === 0) {
        e.preventDefault();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setHistoryActiveIndex(inputHistory.length - 1);
        setHistoryMenuOpen(true);
        return;
      }

      // Esc stops the agent when no slash/@/history menu or IME composition is active.
      if (e.key === "Escape" && !isComposing && isStreaming && onAbort) {
        e.preventDefault();
        onAbort();
        return;
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (isStreaming && (onSteer || onFollowUp)) {
          // Default Enter sends as steer if available, else followup
          sendQueued(onSteer ? "steer" : "followup");
        } else {
          handleSend();
        }
      }
    },
    [isStreaming, onSteer, onFollowUp, onAbort, slashMenuOpen, slashQuery, displayedSlashCommands, slashActiveIndex, applySlashCommand, sendQueued, handleSend, getNextSlashIndex, atMenuOpen, atQuery, atMatches, atActiveIndex, applyAtCompletion, historyMenuOpen, inputHistory, historyActiveIndex, applyHistoryInput, value]
  );

  const handleInput = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  // Explorer에서 복사한 파일은 clipboardData.files/items로 들어온다. 파일이 하나라도
  // 있으면 기본 텍스트 붙여넣기 대신 첨부 경로로 보내고, 지원하지 않는 형식은
  // processAttachmentFiles가 이름과 함께 오류로 알린다(조용히 버리지 않는다).
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const files = getClipboardFiles(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void processAttachmentFiles(files);
  }, [processAttachmentFiles]);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashMenuOpen(false);
      setSlashActiveIndex(0);
      slashCommandsRequestedRef.current = false;
      return;
    }
    setSlashMenuOpen(true);
    setSlashActiveIndex(0);
    if (!slashCommandsRequestedRef.current && onLoadSlashCommands) {
      slashCommandsRequestedRef.current = true;
      Promise.resolve(onLoadSlashCommands()).catch(() => {
        slashCommandsRequestedRef.current = false;
      });
    }
  }, [slashQuery, onLoadSlashCommands]);

  // Lazy-load skill dormancy (disable-model-invocation) each time the slash
  // palette opens, so toggles made in the skills panel are reflected on the
  // next open. Failures degrade silently to the unannotated palette.
  useEffect(() => {
    if (!slashMenuOpen || !cwd) return;
    const requestCwd = cwd;
    let cancelled = false;
    setSkillDormancyState({ cwd: requestCwd, values: {} });
    fetch(`/api/skills?cwd=${encodeURIComponent(requestCwd)}`)
      .then((res) => {
        if (!res.ok) throw new Error(`skills fetch failed: ${res.status}`);
        return res.json() as Promise<Partial<SkillsResponse>>;
      })
      .then((data) => {
        if (cancelled) return;
        const dormancy: Record<string, boolean> = {};
        for (const skill of data.skills ?? []) dormancy[skill.name] = skill.disableModelInvocation;
        setSkillDormancyState({ cwd: requestCwd, values: dormancy });
      })
      .catch(() => {
        if (!cancelled) setSkillDormancyState({ cwd: requestCwd, values: {} });
      });
    return () => {
      cancelled = true;
    };
  }, [slashMenuOpen, cwd]);

  useEffect(() => {
    if (slashActiveIndex >= displayedSlashCommands.length) {
      setSlashActiveIndex(Math.max(0, displayedSlashCommands.length - 1));
    }
  }, [displayedSlashCommands.length, slashActiveIndex]);

  useEffect(() => {
    slashItemRefs.current.length = displayedSlashCommands.length;
  }, [displayedSlashCommands.length]);

  useEffect(() => {
    if (!slashMenuOpen) return;
    slashItemRefs.current[slashActiveIndex]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [slashActiveIndex, slashMenuOpen]);

  // Build model options: prefer modelList (has provider info), fallback to modelNames
  const modelOptions: ModelOption[] = (() => {
    if (modelList && modelList.length > 0) {
      return modelList.map((m) => ({ provider: m.provider, modelId: m.id, name: m.name })).sort(compareModelOptions);
    }
    return Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    })).sort(compareModelOptions);
  })();
  const filteredModelOptions = filterModelOptions(modelOptions, modelFilter);
  const showModelFilter = modelOptions.length > MODEL_FILTER_THRESHOLD;

  // Group options by provider, preserving insertion order
  const modelsByProvider: { provider: string; options: ModelOption[] }[] = [];
  for (const opt of filteredModelOptions) {
    const group = modelsByProvider.find((g) => g.provider === opt.provider);
    if (group) group.options.push(opt);
    else modelsByProvider.push({ provider: opt.provider, options: [opt] });
  }

  // omp's roles, in omp's own order, minus the ones it hides from its selector
  // and the ones with nothing configured to switch to.
  const roleRows = (modelRoles ?? []).filter((role) => !role.hidden && role.resolved);
  const activeRole = model
    ? roleRows.find((role) => role.resolved?.provider === model.provider && role.resolved?.modelId === model.modelId)
    : undefined;

  const displayModelName = model
    ? (modelOptions.find((o) => o.modelId === model.modelId && o.provider === model.provider)?.name ?? model.modelId)
    : null;
  const currentName = displayModelName;

  const compactSavedTokens = compactResult
    ? Math.max(0, compactResult.tokensBefore - compactResult.estimatedTokensAfter)
    : 0;
  const compactResultText = compactResult
    ? `${compactResult.reason && compactResult.reason !== "manual" ? `${compactResult.reason[0].toUpperCase()}${compactResult.reason.slice(1)} ` : t("chat.compacted")} ${formatTokenCount(compactResult.tokensBefore)} -> ${formatTokenCount(compactResult.estimatedTokensAfter)} tokens (${t("chat.tokensSaved", { saved: formatTokenCount(compactSavedTokens) })})`
    : null;
  const thinkingDisplayLabel = (() => {
    const lvl = thinkingLevel ?? "auto";
    if (lvl === "auto") {
      const effective = effectiveThinkingLevel && (thinkingLevelMap?.[effectiveThinkingLevel] ?? effectiveThinkingLevel);
      return effective ? `auto (${effective})` : "auto";
    }
    if (!thinkingLevelMap) return lvl;
    return thinkingLevelMap[lvl] ?? lvl;
  })();
  const toolPresetLabel = Object.entries(TOOL_PRESET_MAP).find(([, v]) => v === (toolPreset ?? "default"))?.[0] ?? "default";

  // 지금 자리 표시는 세션·새 대화가 실제로 고른 값에서만 나온다. 브라우저 전역 기억으로
  // 계정 자리를 메우지 않는다 — 같은 모델의 다른 계정(RIN·MIO)을 다른 세션에 잘못 표시한다.
  const activePresetAlias = mainPresetActiveAlias ?? null;

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
        modelDropdownPanelRef.current && !modelDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
        setModelFilter("");
      }
      if (presetDropdownRef.current && !presetDropdownRef.current.contains(e.target as Node) &&
        presetDropdownPanelRef.current && !presetDropdownPanelRef.current.contains(e.target as Node)
      ) {
        setPresetDropdownOpen(false);
      }
      if (toolDropdownRef.current && !toolDropdownRef.current.contains(e.target as Node)) {
        setToolDropdownOpen(false);
      }
      if (thinkingDropdownRef.current && !thinkingDropdownRef.current.contains(e.target as Node)) {
        setThinkingDropdownOpen(false);
      }
      if (controlsMenuRef.current && !controlsMenuRef.current.contains(e.target as Node)) {
        setControlsMenuOpen(false);
      }
      if (historyMenuRef.current && !historyMenuRef.current.contains(e.target as Node) && !textareaRef.current?.contains(e.target as Node)) {
        setHistoryMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!isMobile) setControlsMenuOpen(false);
  }, [isMobile]);



  return (
    <div
      className="chat-composer"
      style={{
        flexShrink: 0,
        background: "transparent",
        padding: "0 16px 8px",
      }}
    >
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.md,.markdown,.pdf,.txt,.csv,.tsv,.json,.log,text/markdown,text/plain,text/csv,application/json,application/pdf"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void processAttachmentFiles(files);
          e.target.value = "";
        }}
      />
      <div style={{ maxWidth: 820, margin: "0 auto" }}>
        <ModelErrorBanner error={modelError} />
        <ModelScopeWarningBanner warnings={modelScopeWarnings} />
        {/* Queued steering / follow-up messages (delivered by omp on upcoming turns) */}
        {((queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0)) > 0 && (
          <div style={{
            marginBottom: 8,
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-control)",
            background: "var(--bg-panel)",
            padding: "5px 0",
          }}>
            <div style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "2px 8px 4px 10px",
            }}>
              <span style={{
                fontSize: 10,
                fontFamily: "var(--font-mono)",
                color: "var(--text-dim)",
                textTransform: "uppercase",
                letterSpacing: 0.4,
              }}>
                {t("chat.queued", { count: (queuedMessages?.steering.length ?? 0) + (queuedMessages?.followUp.length ?? 0) })}
              </span>
              {onRecallQueue && (
                <button
                  onClick={onRecallQueue}
                   title={t("chat.recallTitle")}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "4px 12px",
                    fontSize: 12,
                    color: "var(--text)",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-control)",
                    cursor: "pointer",
                    transition: "background 0.12s, border-color 0.12s",
                    whiteSpace: "nowrap",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 45%, var(--border))";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.borderColor = "var(--border)";
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 14 4 9 9 4" />
                    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
                  </svg>
                   {t("chat.recall")}
                </button>
              )}
            </div>
            {queuedMessages?.steering.map((text, i) => (
              <QueuedMessageRow key={`steer-${i}`} kind="steer" text={text} />
            ))}
            {queuedMessages?.followUp.map((text, i) => (
              <QueuedMessageRow key={`followup-${i}`} kind="follow-up" text={text} />
            ))}
          </div>
        )}
        {/* Retry banner */}
        {retryInfo && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "var(--warning-soft)", border: "1px solid var(--warning-line)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "var(--warning)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
              <path d="M3 3v5h5" />
            </svg>
             {t("chat.retrying", { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })}{retryInfo.errorMessage && <span style={{ opacity: 0.7, marginLeft: 4 }}>— {retryInfo.errorMessage}</span>}
          </div>
        )}
        {compactResultText && (
          <div style={{
            marginBottom: 8, padding: "5px 10px",
            background: "var(--success-soft)", border: "1px solid var(--success-line)",
            borderRadius: "var(--radius-control)", fontSize: 12, color: "var(--success)",
            display: "flex", alignItems: "center", gap: 6,
          }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {compactResultText}
          </div>
        )}
        {compactError && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              padding: "7px 10px",
              background: "var(--danger-soft)",
              border: "1px solid var(--danger-line)",
              borderRadius: "var(--radius-control)",
              color: "var(--danger)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {compactError}
          </div>
        )}
        {attachmentError && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 8,
              padding: "7px 10px",
              background: "var(--danger-soft)",
              border: "1px solid var(--danger-line)",
              borderRadius: "var(--radius-control)",
              color: "var(--danger)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{attachmentError}</span>
            <button
              type="button"
              onClick={() => setAttachmentError(null)}
              aria-label={t("i18n.close")}
              title={t("i18n.close")}
              style={{
                flexShrink: 0,
                width: 24,
                height: 24,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                border: "none",
                background: "transparent",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="10" y2="10" />
                <line x1="10" y1="2" x2="2" y2="10" />
              </svg>
            </button>
          </div>
        )}
        {(attachedImages.length > 0 || attachedDocuments.length > 0) && (
          <div
            role="list"
            aria-label={t("chat.attachments")}
            style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, flexWrap: "wrap" }}
          >
            {attachedImages.map((img, i) => (
              <div role="listitem" key={`image-${i}`} style={{ position: "relative", flexShrink: 0 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.previewUrl}
                  alt=""
                  style={{ width: 56, height: 56, objectFit: "cover", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", display: "block" }}
                />
                <button
                  type="button"
                  aria-label={t("chat.removeImage", { index: i + 1 })}
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -4, right: -4,
                    width: 16, height: 16, borderRadius: "50%",
                    background: "var(--bg-panel)", border: "1px solid var(--border)",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    cursor: "pointer", padding: 0, color: "var(--text-muted)",
                  }}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="1" y1="1" x2="7" y2="7" /><line x1="7" y1="1" x2="1" y2="7" />
                  </svg>
                </button>
              </div>
            ))}
            {attachedDocuments.map((document) => (
              <div
                className="composer-chip"
                role="listitem"
                aria-busy={document.status === "extracting" || undefined}
                key={document.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 7,
                  minWidth: 0,
                  maxWidth: 320,
                  height: 32,
                  padding: "0 7px 0 9px",
                }}
              >
                {document.status === "extracting" ? (
                  <span
                    aria-hidden="true"
                    style={{
                      width: 13,
                      height: 13,
                      flexShrink: 0,
                      border: "1.5px solid var(--border-strong)",
                      borderTopColor: "var(--accent)",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }}
                  />
                ) : getFileIcon(document.name, 14)}
                <span style={{ minWidth: 0, display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
                  <span title={document.name} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 12 }}>
                    {document.name}
                  </span>
                  <span style={{ color: "var(--text-dim)", fontSize: 10 }}>
                    {DOCUMENT_KIND_LABEL[document.mimeType]} · {formatAttachmentSize(document.size)}
                    {document.status === "extracting" ? ` · ${t("chat.attachExtracting")}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => removeDocument(document.id)}
                  aria-label={t("chat.removeAttachment", { name: document.name })}
                  title={t("chat.removeAttachment", { name: document.name })}
                  style={{
                    width: 24,
                    height: 24,
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                    <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
                    <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Main input */}
        <div ref={composerAnchorRef} style={{ position: "relative", minWidth: 0 }}>
          {historyMenuOpen && inputHistory.length > 0 && (
            <div
              ref={historyMenuRef}
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                ...popupOffset(historyPlacement.side),
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-surface)",
                boxShadow: "var(--seed-shadow-s3)",
                overflow: "hidden",
                maxHeight: historyPlacement.maxHeight,
              }}
            >
              <div
                title="Input history"
                style={{
                  height: 30,
                  padding: "0 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  color: "var(--text-dim)",
                }}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M3 12a9 9 0 1 0 3-6.7" />
                  <path d="M3 4v5h5" />
                  <path d="M12 7v5l3 2" />
                </svg>
              </div>
              <div style={{ maxHeight: Math.max(0, historyPlacement.maxHeight - 31), overflowY: "auto", padding: 4 }}>
                {inputHistory.map((item, index) => {
                  const active = index === historyActiveIndex;
                  return (
                    <button
                      key={`${index}:${item}`}
                      ref={(node) => {
                        historyItemRefs.current[index] = node;
                      }}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyHistoryInput(item);
                      }}
                      onMouseEnter={() => setHistoryActiveIndex(index)}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: 8,
                        padding: "7px 8px",
                        border: "none",
                        borderRadius: "var(--radius-control)",
                        background: active ? "var(--bg-selected)" : "none",
                        color: "var(--text)",
                        cursor: "pointer",
                        textAlign: "left",
                        fontSize: 12.5,
                        lineHeight: 1.45,
                      }}
                    >
                      <span style={{ flexShrink: 0, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)", paddingTop: 1 }}>
                        {index + 1}
                      </span>
                      <span style={{ minWidth: 0, display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2, overflow: "hidden", overflowWrap: "anywhere" }}>
                        {item}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {slashMenuOpen && slashQuery !== null && (
            <div
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                ...popupOffset(slashPlacement.side),
                zIndex: 120,
                background: "var(--bg)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-surface)",
                boxShadow: "var(--seed-shadow-s3)",
                overflow: "hidden",
                maxHeight: slashPlacement.maxHeight,
              }}
            >
              <div
                style={{
                  padding: "8px 10px",
                  borderBottom: "1px solid var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 8,
                  fontSize: 11,
                  color: "var(--text-dim)",
                }}
              >
                 <span>{slashCommandsLoading ? t("chat.loadingCommands") : t("chat.slashCommands", { label: slashCommandCountLabel })}</span>
                 <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
              </div>
              <div style={{ maxHeight: Math.max(0, slashPlacement.maxHeight - 34), overflowY: "auto", padding: 10 }}>
                {!slashCommandsLoading && filteredSlashCommands.length === 0 ? (
                  <div style={{ padding: "2px 2px 4px", fontSize: 12, color: "var(--text-dim)" }}>
                     {t("chat.noCommands")}
                  </div>
                ) : (
                  groupedSlashCommands.map((group) => (
                    <section key={group.source} style={{ marginBottom: 12 }}>
                      <div
                        style={{
                          position: "sticky",
                          top: -10,
                          zIndex: 1,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 8,
                          padding: "4px 0 6px",
                          background: "var(--bg)",
                          color: "var(--text-dim)",
                          fontSize: 10,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                           <span>{t(SLASH_SOURCE_GROUP_LABEL_KEYS[group.source])}</span>
                        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 500 }}>{group.items.length}</span>
                      </div>
                      <div
                        style={{
                          display: "grid",
                          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
                          gap: 8,
                        }}
                      >
                        {group.items.map(({ command, index }) => {
                          const active = index === slashActiveIndex;
                          const dormant = isDormantSkillCommand(command, skillDormancy);
                          return (
                            <button
                              key={`${command.source}:${command.name}`}
                              ref={(node) => {
                                slashItemRefs.current[index] = node;
                              }}
                              type="button"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                applySlashCommand(command);
                              }}
                              onMouseEnter={() => setSlashActiveIndex(index)}
                              style={{
                                width: "100%",
                                minWidth: 0,
                                minHeight: 58,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                                justifyContent: "center",
                                padding: "9px 10px",
                                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                                borderRadius: "var(--radius-control)",
                                background: active ? "var(--bg-selected)" : "var(--bg-panel)",
                                color: "var(--text)",
                                cursor: "pointer",
                                textAlign: "left",
                                boxShadow: active ? "0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent)" : "none",
                              }}
                            >
                              <span style={{
                                fontSize: 13,
                                fontFamily: "var(--font-mono)",
                                overflowWrap: "anywhere",
                                wordBreak: "break-word",
                                color: dormant ? "var(--text-dim)" : undefined,
                              }}>
                                /{command.name}
                                {dormant && (
                                  <span style={{
                                    marginLeft: 6,
                                    padding: "0 4px",
                                    border: "1px solid var(--border)",
                                    borderRadius: 3,
                                    fontSize: 9,
                                    color: "var(--text-dim)",
                                    whiteSpace: "nowrap",
                                  }}>
                                    {t("chat.dormant")}
                                  </span>
                                )}
                              </span>
                              {getSlashDescription(command, t) && (
                                <span style={{
                                  display: "-webkit-box",
                                  WebkitBoxOrient: "vertical",
                                  WebkitLineClamp: 2,
                                  overflow: "hidden",
                                  fontSize: 11,
                                  lineHeight: 1.35,
                                  color: "var(--text-dim)",
                                }}>
                                   {getSlashDescription(command, t)}
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                )}
              </div>
            </div>
          )}
          {atMenuOpen && atQuery !== null && (() => {
            const indexLoading = fileIndexLoading && (!fileIndex || fileIndex.cwd !== cwd);
             const matchCountLabel = atMatches.length === 1 ? t("chat.match") : t("chat.matches", { count: atMatches.length });
            // With a truncated index, local results are provisional — the
            // debounced server search over the full listing replaces them.
            const truncatedHint = fileIndex?.truncated && !serverResultInUse
               ? (atQuery.query ? t("chat.searchingAll") : t("chat.indexTruncated"))
              : "";
            return (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  ...popupOffset(atPlacement.side),
                  zIndex: 120,
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-surface)",
                  boxShadow: "var(--seed-shadow-s3)",
                  overflow: "hidden",
                  maxHeight: atPlacement.maxHeight,
                }}
              >
                <div
                  style={{
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    color: "var(--text-dim)",
                  }}
                >
                  <span>
                    {indexLoading
                       ? t("chat.loadingFiles")
                       : t("chat.files", { label: matchCountLabel, hint: truncatedHint })}
                  </span>
                   <span style={{ fontFamily: "var(--font-mono)" }}>{t("chat.tabEnter")}</span>
                </div>
                <div style={{ maxHeight: Math.max(0, atPlacement.maxHeight - 34), overflowY: "auto", padding: 4 }}>
                  {!indexLoading && atMatches.length === 0 ? (
                    <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>
                       {needsServerSearch && !serverResultInUse ? t("chat.searching") : t("chat.noMatchingFiles")}
                    </div>
                  ) : (
                    atMatches.map((entry, index) => {
                      const active = index === atActiveIndex;
                      const name = entry.path.split("/").pop() ?? entry.path;
                      const dirPrefix = entry.path.slice(0, entry.path.length - name.length);
                      return (
                        <button
                          key={`${entry.isDir ? "d" : "f"}:${entry.path}`}
                          ref={(node) => {
                            atItemRefs.current[index] = node;
                          }}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            applyAtCompletion(entry);
                          }}
                          onMouseEnter={() => setAtActiveIndex(index)}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            padding: "6px 8px",
                            border: "none",
                            borderRadius: "var(--radius-control)",
                            background: active ? "var(--bg-selected)" : "none",
                            color: "var(--text)",
                            cursor: "pointer",
                            textAlign: "left",
                            fontSize: 12.5,
                            fontFamily: "var(--font-mono)",
                          }}
                        >
                          <span style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>
                            {entry.isDir ? <FolderIcon size={14} /> : getFileIcon(name, 14)}
                          </span>
                          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {dirPrefix && <span style={{ color: "var(--text-dim)" }}>{dirPrefix}</span>}
                            {name}
                            {entry.isDir && <span style={{ color: "var(--text-dim)" }}>/</span>}
                          </span>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })()}
          <div
            className={`chat-composer-field${bashMode ? " is-bash" : ""}${isStreaming ? " is-streaming" : ""}`}
            style={{
              minWidth: 0,
              display: "flex",
              gap: 8,
              alignItems: "center",
              background: "var(--bg)",
              border: `1px solid ${bashMode ? "var(--tool-bg)" : isStreaming && (onSteer || onFollowUp)
                ? "var(--warning-line)"
                : "var(--border)"}`,
              borderRadius: "var(--seed-radius-r3)",
              padding: "10px 10px 10px 14px",
              boxShadow: "var(--seed-shadow-s1)",
              transition: "border-color 0.15s, background 0.15s, box-shadow 0.15s",
            } as React.CSSProperties}
          >
          <textarea
            className="chat-composer-textarea"
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              valueRef.current = e.target.value;
              setValue(e.target.value);
              setHistoryMenuOpen(false);
              updateAtQuery(e.target.value, e.target.selectionStart);
            }}
            onSelect={(e) => {
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={() => {
              isComposingRef.current = true;
            }}
            onCompositionEnd={(e) => {
              isComposingRef.current = false;
              lastCompositionEndAtRef.current = Date.now();
              const el = e.currentTarget;
              updateAtQuery(el.value, el.selectionStart);
            }}
            onInput={handleInput}
            onPaste={handlePaste}
            placeholder={
              isStreaming && (onSteer || onFollowUp)
                ? t("chat.steerPlaceholder")
                : isStreaming ? t("chat.agentPlaceholder")
                : t("chat.messagePlaceholder")
            }
            rows={1}
            style={{
              flex: 1,
              minWidth: 0,
              width: "100%",
              background: "none",
              border: "none",
              outline: "none",
              resize: "none",
              color: "var(--text)",
              fontSize: 14,
              lineHeight: 1.6,
              fontFamily: "inherit",
              minHeight: 24,
              maxHeight: 200,
              overflow: "auto",
            }}
          />

          {isStreaming ? (
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0, alignSelf: "flex-end" }}>
              {onSteer && (
                <button
                  className="composer-stream-action is-warning"
                  onClick={() => sendQueued("steer")}
                  disabled={!canQueueStreamingMessage}
                  title={isExtractingDocument
                    ? t("chat.attachExtractingWait")
                    : t("chat.steerTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "var(--warning-soft)" : "none",
                    border: "1px solid var(--warning-line)",
                    borderRadius: "var(--radius-control)",
                    color: canQueueStreamingMessage ? "var(--warning)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 1 L9 5 L5 9" /><line x1="1" y1="5" x2="9" y2="5" />
                  </svg>
                  {t("chat.steer")}
                </button>
              )}
              {onFollowUp && (
                <button
                  className="composer-stream-action is-followup"
                  onClick={() => sendQueued("followup")}
                  disabled={!canQueueStreamingMessage}
                  title={isExtractingDocument
                    ? t("chat.attachExtractingWait")
                    : t("chat.followUpTitle")}
                  style={{
                    display: "flex", alignItems: "center", gap: 5,
                    padding: "7px 12px",
                    background: canQueueStreamingMessage ? "var(--accent-soft)" : "none",
                    border: "1px solid var(--accent-line)",
                    borderRadius: "var(--radius-control)",
                    color: canQueueStreamingMessage ? "var(--accent-hover)" : "var(--text-dim)",
                    cursor: canQueueStreamingMessage ? "pointer" : "not-allowed",
                    fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em",
                    transition: "background 0.12s",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="5" y1="1" x2="5" y2="6" /><polyline points="2.5 3.5 5 1 7.5 3.5" />
                    <line x1="2" y1="9" x2="8" y2="9" />
                  </svg>
                  {t("chat.followUp")}
                </button>
              )}
            </div>
          ) : (
            <button
              className="chat-composer-send"
              onClick={handleSend}
              disabled={!canSend}
              aria-busy={isExtractingDocument || undefined}
              title={isExtractingDocument ? t("chat.attachExtractingWait") : undefined}
              style={{
                flexShrink: 0,
                alignSelf: "flex-end",
                display: "flex", alignItems: "center", gap: 6,
                padding: "7px 14px",
                background: canSend ? "var(--accent-soft)" : "var(--bg-raised)",
                border: "none",
                borderRadius: "var(--radius-control)",
                color: canSend ? "var(--accent-hover)" : "var(--text-dim)",
                cursor: canSend ? "pointer" : "not-allowed",
                fontSize: 13,
                fontWeight: 600,
                letterSpacing: "-0.01em",
                transition: "background 0.15s, color 0.15s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="2" y1="7" x2="11" y2="7" />
                <polyline points="7.5 3 12 7 7.5 11" />
              </svg>
              {t("chat.send")}
            </button>
          )}
          </div>
        </div>


        {/* Bash mode status label */}
        {bashMode && (
          <div className="text-xs px-2 py-1" style={{ color: bashExcluded ? "var(--text-muted)" : "var(--accent)", marginTop: 4 }}>
             {t("chat.shell")} · {bashExcluded ? t("chat.outputLocal") : t("chat.outputModel")}
          </div>
        )}


        {/* Bottom bar: attachment + model | run options + stop + voice.
            The context usage indicator lives once in the workspace header.
            좁은 폭에서는 왼쪽 묶음이 줄어들어 한 줄에 들어간다. 더 좁아 최소 표적
            크기로도 못 담을 때만 오른쪽 묶음이 둘째 줄로 내려간다(globals.css). */}
        <div className="composer-action-bar" style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}>

          {/* LEFT: attach + model selector (idle) or steer/followup toggle (streaming) */}
          {/* 모바일에서는 basis 0으로 둔다. basis가 auto면 flex-wrap이 줄어들기 전의
              최대 폭으로 줄바꿈을 결정해 버려, 들어갈 수 있는데도 두 줄이 된다. */}
          <div style={{ flex: isMobile ? "1 1 0%" : "0 0 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 2 }}>
            <button
              type="button"
              className={`composer-icon-button${attachedImages.length || attachedDocuments.length ? " is-active" : ""}`}
              onClick={() => fileInputRef.current?.click()}
              title={t("chat.attachFile")}
              aria-label={t("chat.attachFile")}
              style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 32, height: 32, padding: 0,
                background: "none", border: "none",
                borderRadius: "var(--radius-control)",
                color: attachedImages.length || attachedDocuments.length ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer",
                opacity: 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = attachedImages.length || attachedDocuments.length ? "var(--accent)" : "var(--text)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "none";
                e.currentTarget.style.color = attachedImages.length || attachedDocuments.length ? "var(--accent)" : "var(--text-muted)";
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
            {/* Model selector — visible always, disabled while the session or switch is busy */}
            {(modelOptions.length > 0 || currentName || modelError) && onModelChange && (
                <div ref={dropdownRef} style={{ position: "relative", flex: isMobile ? "1 1 0%" : undefined, minWidth: 0 }}>
                  <button
                    className={`composer-chip${modelDropdownOpen ? " is-active" : ""}`}
                    onClick={(e) => {
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      setModelDropdownRect({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width });
                      setModelDropdownOpen((open) => {
                        if (open) setModelFilter("");
                        return !open;
                      });
                    }}
                    disabled={isStreaming || modelSwitching}
                    aria-busy={modelSwitching || undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      justifyContent: isMobile ? "flex-start" : undefined,
                      padding: isMobile ? "8px 10px" : "8px 12px",
                      height: 32,
                      width: isMobile ? "100%" : undefined,
                      maxWidth: isMobile ? "100%" : 220,
                      overflow: "hidden",
                      background: modelDropdownOpen ? "var(--bg-hover)" : "none",
                      border: "none",
                      borderRadius: "var(--radius-control)",
                      color: "var(--text-muted)",
                      cursor: isStreaming || modelSwitching ? "not-allowed" : "pointer",
                      fontSize: 12,
                      opacity: isStreaming ? 0.5 : 1,
                      transition: "background 0.12s, color 0.12s",
                    }}
                    onMouseEnter={(e) => {
                      if (isStreaming || modelSwitching) return;
                      e.currentTarget.style.background = "var(--bg-hover)";
                      e.currentTarget.style.color = "var(--text)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = modelDropdownOpen ? "var(--bg-hover)" : "none";
                      e.currentTarget.style.color = "var(--text-muted)";
                    }}
                    title={modelSwitching ? "Switching model" : modelOptions.length > 0 ? "Change model" : "No available models"}
                  >
                    {modelSwitching ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite", flexShrink: 0 }} aria-hidden="true">
                        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      </svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="4" y="4" width="16" height="16" rx="2" />
                        <rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                    )}
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {currentName ?? (modelOptions.length > 0 ? "Select model" : "No models")}
                    </span>
                  </button>
                  {modelDropdownOpen && modelDropdownRect && (() => {
                    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                    // Opening upwards is the norm, but the composer is centred
                    // in a fresh session: fall back to below when the space
                    // above cannot hold the list.
                    const { side, maxHeight: maxH } = computePopupPlacement(
                      modelDropdownRect.top,
                      modelDropdownRect.bottom,
                      viewportHeight,
                      preferredPopupHeight(viewportHeight, 0.6, MODEL_DROPDOWN_MAX_HEIGHT_PX),
                      { gap: 6, prefer: "above" },
                    );
                    const sidePos: React.CSSProperties = side === "above"
                      ? { bottom: viewportHeight - modelDropdownRect.top + 6 }
                      : { top: modelDropdownRect.bottom + 6 };
                    // On mobile, pin to a small left margin and cap width to the
                    // viewport so long model names never push the panel off-screen.
                    const panelPos: React.CSSProperties = isMobile
                      ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                      : { left: modelDropdownRect.left, width: "max-content", minWidth: modelDropdownRect.width };
                    return (
                      <div ref={modelDropdownPanelRef} style={{
                      position: "fixed",
                      ...sidePos,
                      ...panelPos,
                      zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                      borderRadius: "var(--radius-surface)", boxShadow: "var(--seed-shadow-s2)",
                      overflow: "hidden", maxHeight: maxH, display: "flex", flexDirection: "column",
                      }}>
                      {showModelFilter && (
                        <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
                          <input
                            value={modelFilter}
                            onChange={(e) => setModelFilter(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Escape") {
                                setModelFilter("");
                                setModelDropdownOpen(false);
                              }
                            }}
                            placeholder={t("chat.filterModels")}
                            aria-label={t("chat.filterModels")}
                            autoFocus
                            autoComplete="off"
                            spellCheck={false}
                            style={{
                              width: "100%",
                              minWidth: isMobile ? 0 : 220,
                              fontSize: 11,
                              fontFamily: "var(--font-mono)",
                              padding: "5px 8px",
                              border: "1px solid var(--border)",
                              borderRadius: 5,
                              outline: "none",
                              background: "var(--bg)",
                              color: "var(--text)",
                              boxSizing: "border-box",
                            }}
                          />
                        </div>
                      )}
                      <div style={{ minHeight: 0, overflowY: "auto" }}>
                        {/* omp assigns a model per scope of work; offer those first
                            so picking "Fast" or "Architect" stays one click, and
                            record the role so the transcript matches `/model`. */}
                        {roleRows.length > 0 && !modelFilter.trim() && onRoleModelChange && (
                          <div>
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                            }}>
                              {t("chat.modelRoles")}
                            </div>
                            {roleRows.map((role) => {
                              const isActive = activeRole?.role === role.role;
                              const resolvedName = role.resolved?.name ?? role.resolved?.modelId ?? "";
                              return (
                                <button
                                  key={role.role}
                                  onClick={() => {
                                    setModelDropdownOpen(false);
                                    setModelFilter("");
                                    onRoleModelChange(role.role);
                                  }}
                                  title={role.selector ?? resolvedName}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 8,
                                    width: "100%", padding: "7px 12px",
                                    background: isActive ? "var(--bg-selected)" : "none",
                                    border: "none",
                                    color: isActive ? "var(--text)" : "var(--text-muted)",
                                    cursor: "pointer", fontSize: 12, textAlign: "left",
                                    whiteSpace: "nowrap",
                                  }}
                                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                                >
                                  {isActive
                                    ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                    : <span style={{ width: 10, flexShrink: 0 }} />}
                                  <span style={{
                                    flexShrink: 0,
                                    minWidth: 58,
                                    padding: "1px 6px",
                                    borderRadius: 4,
                                    border: "1px solid var(--border)",
                                    background: "var(--bg-subtle)",
                                    color: isActive ? "var(--accent)" : "var(--text-dim)",
                                    fontFamily: "var(--font-mono)",
                                    fontSize: 9.5,
                                    fontWeight: 700,
                                    letterSpacing: "0.06em",
                                    textAlign: "center",
                                  }}>
                                    {role.tag ?? role.role.toUpperCase()}
                                  </span>
                                  <span style={{ fontWeight: isActive ? 600 : 500 }}>{role.name}</span>
                                  <span style={{
                                    marginLeft: "auto",
                                    paddingLeft: 12,
                                    color: "var(--text-dim)",
                                    fontSize: 11,
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                  }}>
                                    {resolvedName}
                                    {role.resolved?.thinkingLevel ? ` · ${role.resolved.thinkingLevel}` : ""}
                                  </span>
                                </button>
                              );
                            })}
                            <div style={{
                              padding: "6px 12px 4px",
                              fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                              textTransform: "uppercase", letterSpacing: "0.07em",
                              borderTop: "1px solid var(--border)",
                            }}>
                              {t("chat.allModels")}
                            </div>
                          </div>
                        )}
                        {modelsByProvider.length === 0 ? (
                          <div style={{ padding: "8px 12px", color: "var(--text-dim)", fontSize: 12, whiteSpace: "nowrap" }}>
                            {modelFilter.trim() ? t("chat.noMatchingModels") : "No available models"}
                          </div>
                        ) : modelsByProvider.map((group, gi) => (
                          <div key={group.provider}>
                            {(modelsByProvider.length > 1) && (
                              <div style={{
                                padding: "6px 12px 4px",
                                fontSize: 10, fontWeight: 600, color: "var(--text-dim)",
                                textTransform: "uppercase", letterSpacing: "0.07em",
                                borderTop: gi > 0 ? "1px solid var(--border)" : "none",
                              }}>
                                {group.provider}
                              </div>
                            )}
                            {group.options.map((opt) => {
                              const isActive = opt.modelId === model?.modelId && opt.provider === model?.provider;
                              return (
                                <button
                                  key={`${opt.provider}:${opt.modelId}`}
                                  onClick={() => {
                                    setModelDropdownOpen(false);
                                    setModelFilter("");
                                    if (!isActive || isAutoModelSelection) onModelChange(opt.provider, opt.modelId);
                                  }}
                                  style={{
                                    display: "flex", alignItems: "center", gap: 8,
                                    width: "100%", padding: "7px 12px",
                                    background: isActive ? "var(--bg-selected)" : "none",
                                    border: "none",
                                    color: isActive ? "var(--text)" : "var(--text-muted)",
                                    cursor: "pointer", fontSize: 12, textAlign: "left",
                                    fontWeight: isActive ? 600 : 400,
                                    whiteSpace: "nowrap",
                                  }}
                                  onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                                  onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                                >
                                  {isActive
                                    ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                    : <span style={{ width: 10, flexShrink: 0 }} />}
                                  {opt.name}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                    );
                  })()}
                </div>
            )}
            {/* Main 프리셋 — 모델 chip 바로 오른쪽에서 roster의 Main 후보를 한 번에 적용한다.
                라벨을 접은 모바일에서는 첨부·음성과 같은 정사각 아이콘 버튼이 된다. */}
            {onMainPresetChange && MAIN_PRESETS.length > 0 && (
              <div ref={presetDropdownRef} style={{ position: "relative", flexShrink: isMobile ? 1 : 0, minWidth: 0 }}>
                <button
                  className={`${isMobile ? "composer-icon-button" : "composer-chip"}${presetDropdownOpen ? " is-active" : ""}`}
                  onClick={(e) => {
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setPresetDropdownRect({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width });
                    setModelDropdownOpen(false);
                    setModelFilter("");
                    setPresetDropdownOpen((open) => !open);
                  }}
                  disabled={isStreaming || modelSwitching}
                  aria-haspopup="menu"
                  aria-expanded={presetDropdownOpen}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape" || !presetDropdownOpen) return;
                    e.stopPropagation();
                    setPresetDropdownOpen(false);
                  }}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    maxWidth: "100%",
                    padding: "4px 8px",
                    background: presetDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: isStreaming || modelSwitching ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming || modelSwitching) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = presetDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                  title={t("chat.mainPreset")}
                  aria-label={t("chat.mainPreset")}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                    <path d="M12 3l2.2 5.1 5.6.5-4.2 3.7 1.2 5.5L12 15l-4.8 2.8 1.2-5.5L4.2 8.6l5.6-.5z" />
                  </svg>
                  {/* 좁은 폭에서는 라벨을 접는다. 한 줄에 다 넣으면 "M…"까지 줄어 뜻이
                      없어지고, 그 폭은 지금 쓰는 모델 이름이 가져가는 편이 낫다.
                      이름은 title/aria-label에 그대로 남는다. */}
                  {isMobile ? null : (
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {t("chat.mainPreset")}
                    </span>
                  )}
                </button>
                {presetDropdownOpen && presetDropdownRect && (() => {
                  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
                  const { side, maxHeight: maxH } = computePopupPlacement(
                    presetDropdownRect.top,
                    presetDropdownRect.bottom,
                    viewportHeight,
                    preferredPopupHeight(viewportHeight, 0.6, MODEL_DROPDOWN_MAX_HEIGHT_PX),
                    { gap: 6, prefer: "above" },
                  );
                  const sidePos: React.CSSProperties = side === "above"
                    ? { bottom: viewportHeight - presetDropdownRect.top + 6 }
                    : { top: presetDropdownRect.bottom + 6 };
                  const panelPos: React.CSSProperties = isMobile
                    ? { left: 8, right: 8, maxWidth: "calc(100vw - 16px)" }
                    : { left: presetDropdownRect.left, width: "max-content", minWidth: presetDropdownRect.width };
                  return (
                    <div
                      ref={presetDropdownPanelRef}
                      role="menu"
                      aria-label={t("chat.mainPreset")}
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        setPresetDropdownOpen(false);
                        presetDropdownRef.current?.querySelector("button")?.focus();
                      }}
                      style={{
                        position: "fixed",
                        ...sidePos,
                        ...panelPos,
                        zIndex: 500, background: "var(--bg)", border: "1px solid var(--border)",
                        borderRadius: "var(--radius-surface)", boxShadow: "var(--seed-shadow-s2)",
                        overflow: "hidden", maxHeight: maxH, display: "flex", flexDirection: "column",
                      }}
                    >
                      <div style={{ minHeight: 0, overflowY: "auto" }}>
                        {MAIN_PRESETS.map((entry) => {
                          const isActive = entry.alias === activePresetAlias;
                          return (
                            <button
                              key={entry.alias}
                              role="menuitemradio"
                              aria-checked={isActive}
                              onClick={() => {
                                setPresetDropdownOpen(false);
                                // 적용이 성공했는지는 훅이 정한다 — 여기서 미리 기억하거나
                                // 체크하지 않는다.
                                void onMainPresetChange(mainPresetSelection(entry));
                              }}
                              title={`${entry.provider}/${entry.model}`}
                              style={{
                                display: "flex", alignItems: "center", gap: 8,
                                width: "100%", padding: "7px 12px",
                                background: isActive ? "var(--bg-selected)" : "none",
                                border: "none",
                                color: isActive ? "var(--text)" : "var(--text-muted)",
                                cursor: "pointer", fontSize: 12, textAlign: "left",
                                fontWeight: isActive ? 600 : 400,
                                whiteSpace: "nowrap",
                              }}
                              onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                              onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                            >
                              {isActive
                                ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                                : <span style={{ width: 10, flexShrink: 0 }} />}
                              <img className="account-avatar" src={avatarSrcForSeed(entry.seed)} width={20} height={20} alt="" aria-hidden="true" draggable={false} />
                              <span>{entry.alias}</span>
                              <span style={{
                                marginLeft: "auto",
                                paddingLeft: 12,
                                color: "var(--text-dim)",
                                fontSize: 11,
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                              }}>
                                {entry.provider}/{entry.model}
                                {entry.oauthPosition !== undefined ? ` · OAuth ${entry.oauthPosition}` : ""}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
            {/* 이 세션이 6 Pro 연결번호에 묶였을 때만 보이는 표시(모델 칩과 같은 줄). */}
            <Gpt6HandleBadge sessionId={sessionId} />
          </div>

          {/* RIGHT: one collapsed run-options group, then the always-reachable
              stop and voice controls. */}
          <div ref={controlsMenuRef} style={{
            flex: "0 0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            position: "relative",
            marginLeft: "auto",
            gap: isMobile ? 4 : 2,
          }}>
            {/* 좁은 폭에서는 아이콘 버튼으로 바꾼다. 이 버튼이 글자 폭을 계속 차지하면
                액션 줄이 한 줄에 들어가지 못해 모델 이름 쪽이 먼저 잘려 나간다.
                이름은 title/aria-label에 그대로 남고 동작도 같다. */}
            {isMobile ? (
              <button
                type="button"
                className={`composer-icon-button${controlsMenuOpen ? " is-active" : ""}`}
                title={t("chat.moreControls")}
                aria-label={t("chat.moreControls")}
                aria-expanded={controlsMenuOpen}
                onClick={() => {
                  setModelDropdownOpen(false);
                  setModelFilter("");
                  setControlsMenuOpen((open) => !open);
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                  <line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="17" x2="20" y2="17" />
                  <circle cx="10" cy="7" r="2.2" /><circle cx="16" cy="17" r="2.2" />
                </svg>
              </button>
            ) : (
              <ActionButton
                type="button"
                variant="neutralWeak"
                size="small"
                layout="withText"
                title={controlsMenuOpen ? undefined : t("chat.moreControls")}
                aria-label={t("chat.moreControls")}
                aria-expanded={controlsMenuOpen}
                onClick={() => {
                  setModelDropdownOpen(false);
                  setModelFilter("");
                  setControlsMenuOpen((open) => !open);
                }}
              >
                {t("chat.moreControls")}
              </ActionButton>
            )}
            <div
              role="group"
              aria-label={t("chat.moreControls")}
              style={{
                display: controlsMenuOpen ? "flex" : "none",
                alignItems: "center",
                gap: 1,
                position: "absolute",
                right: 0,
                bottom: "100%",
                marginBottom: "var(--seed-dimension-x1)",
                zIndex: 60,
                padding: 1,
                width: "max-content",
                maxWidth: "calc(100vw - 32px)",
                flexWrap: "wrap",
                justifyContent: "flex-end",
                border: "1px solid var(--seed-color-stroke-neutral-muted)",
                borderRadius: "var(--seed-radius-r2)",
                background: "var(--seed-color-bg-layer-floating)",
                boxShadow: "var(--seed-shadow-s2)",
              }}
            >
            {!isStreaming && onThinkingLevelChange && (
              <div ref={thinkingDropdownRef} style={{ position: "relative" }}>
                <button
                  className={`composer-chip${thinkingDropdownOpen ? " is-active" : ""}`}
                  onClick={() => !isStreaming && setThinkingDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                   title={t("chat.changeReasoning", { level: thinkingDisplayLabel })}
                   aria-label={t("chat.changeReasoningLabel")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: thinkingDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = thinkingDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9.5 2A5.5 5.5 0 0 0 4 7.5c0 1.7.78 3.21 2 4.21V14a1 1 0 0 0 1 1h5a1 1 0 0 0 1-1v-2.29c1.22-1 2-2.51 2-4.21A5.5 5.5 0 0 0 9.5 2z" />
                    <line x1="7" y1="18" x2="12" y2="18" />
                    <line x1="8" y1="21" x2="11" y2="21" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{thinkingDisplayLabel}</span>
                </button>
                {thinkingDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-surface)", boxShadow: "var(--seed-shadow-s2)",
                    overflow: "hidden", minWidth: 180,
                  }}>
                    {THINKING_LEVELS.filter((lvl) => {
                      if (!availableThinkingLevels) return true;
                      if (lvl === "auto") return true;
                      return availableThinkingLevels.includes(lvl);
                    }).map((lvl) => {
                      const isActive = (thinkingLevel ?? "auto") === lvl;
                       const desc = t(THINKING_LEVEL_DESC_KEYS[lvl]);
                      const mappedVal = (lvl !== "auto" && thinkingLevelMap) ? thinkingLevelMap[lvl] : undefined;
                      const displayLabel = (mappedVal != null && mappedVal !== lvl) ? mappedVal : lvl;
                      const showOriginal = mappedVal != null && mappedVal !== lvl;
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setThinkingDropdownOpen(false); onThinkingLevelChange(lvl); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>
                            {displayLabel}
                            {showOriginal && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", marginLeft: 5 }}>({lvl})</span>}
                          </span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {!isStreaming && onToolPresetChange && (
              <div ref={toolDropdownRef} style={{ position: "relative" }}>
                <button
                  className={`composer-chip${toolDropdownOpen ? " is-active" : ""}`}
                  onClick={() => !isStreaming && setToolDropdownOpen((v) => !v)}
                  disabled={isStreaming}
                   title={t("chat.changeToolPreset") + `: ${toolPresetLabel}`}
                   aria-label={t("chat.changeToolPreset")}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: toolDropdownOpen ? "var(--bg-hover)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: "var(--text-muted)",
                    cursor: isStreaming ? "not-allowed" : "pointer",
                    fontSize: 12,
                    opacity: isStreaming ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming) return;
                    e.currentTarget.style.background = "var(--bg-hover)";
                    e.currentTarget.style.color = "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = toolDropdownOpen ? "var(--bg-hover)" : "none";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                  <span style={{ whiteSpace: "nowrap" }}>{toolPresetLabel}</span>
                </button>
                {toolDropdownOpen && (
                  <div style={{
                    position: "absolute", bottom: "calc(100% + 6px)", right: 0,
                    zIndex: 100, background: "var(--bg)", border: "1px solid var(--border)",
                    borderRadius: "var(--radius-surface)", boxShadow: "var(--seed-shadow-s2)",
                    overflow: "hidden", minWidth: 120,
                  }}>
                    {TOOL_PRESETS.map((lvl) => {
                      const preset = TOOL_PRESET_MAP[lvl];
                      const isActive = (toolPreset ?? "default") === preset;
                      const desc = lvl === "off"
                        ? t("chat.noTools")
                        : lvl === "default"
                          ? t("chat.builtInTools", { tools: DEFAULT_TOOL_LABEL })
                          : t("chat.allBuiltInTools", {
                            tools: `${DEFAULT_TOOL_LABEL} + ${FULL_TOOL_ADDITIONS}`,
                          });
                      return (
                        <button
                          key={lvl}
                          onClick={() => { setToolDropdownOpen(false); if (!isActive) onToolPresetChange(preset); }}
                          style={{
                            display: "flex", alignItems: "center", gap: 8,
                            width: "100%", padding: "7px 12px",
                            background: isActive ? "var(--bg-selected)" : "none",
                            border: "none",
                            color: isActive ? "var(--text)" : "var(--text-muted)",
                            cursor: "pointer", fontSize: 12, textAlign: "left",
                            fontWeight: isActive ? 600 : 400,
                            whiteSpace: "nowrap",
                          }}
                          onMouseEnter={(e) => { if (!isActive) e.currentTarget.style.background = "var(--bg-hover)"; }}
                          onMouseLeave={(e) => { if (!isActive) e.currentTarget.style.background = "none"; }}
                        >
                          {isActive
                            ? <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                            : <span style={{ width: 10, flexShrink: 0 }} />}
                          <span style={{ flex: 1 }}>{lvl}</span>
                          <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 8 }}>{desc}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {!isStreaming && onCompact && (
              <div>
                <button
                  className={`composer-chip${isCompacting ? " is-active is-danger" : ""}`}
                  onClick={isCompacting ? onAbortCompaction : onCompact}
                  disabled={isStreaming && !isCompacting}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
                    padding: "8px 12px",
                    height: 32,
                    background: isCompacting ? "var(--danger-soft)" : "none",
                    border: "none",
                    borderRadius: "var(--radius-control)",
                    color: isCompacting ? "var(--danger)" : "var(--text-muted)",
                    cursor: (isStreaming && !isCompacting) ? "not-allowed" : "pointer",
                    fontSize: 12, opacity: (isStreaming && !isCompacting) ? 0.5 : 1,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    if (isStreaming && !isCompacting) return;
                    e.currentTarget.style.background = isCompacting ? "var(--danger-soft)" : "var(--bg-hover)";
                    e.currentTarget.style.color = isCompacting ? "var(--danger)" : "var(--text)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = isCompacting ? "var(--danger-soft)" : "none";
                    e.currentTarget.style.color = isCompacting ? "var(--danger)" : "var(--text-muted)";
                  }}
                   title={isCompacting ? t("chat.stopCompaction") : t("chat.compactContext")}
                   aria-label={isCompacting ? t("chat.stopCompaction") : t("chat.compactContext")}
                >
                  {isCompacting ? (
                    <><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="2" y="2" width="6" height="6" rx="1" fill="currentColor" /></svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compacting")}</span></>
                  ) : (
                    <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" />
                      <line x1="10" y1="14" x2="3" y2="21" /><line x1="21" y1="3" x2="14" y2="10" />
                    </svg><span style={{ whiteSpace: "nowrap" }}>{t("chat.compact")}</span></>
                  )}
                </button>
              </div>
            )}
            {controlsMenuOpen && (
              <button
                className="composer-icon-button is-active"
                type="button"
                 title={t("chat.collapseControls")}
                 aria-label={t("chat.collapseControls")}
                aria-expanded={true}
                onClick={() => {
                  setToolDropdownOpen(false);
                  setThinkingDropdownOpen(false);
                  setControlsMenuOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 36,
                  height: 32,
                  padding: 0,
                  marginLeft: 0,
                  background: "var(--bg-hover)",
                  border: "none",
                  borderLeft: "1px solid color-mix(in srgb, var(--border) 72%, transparent)",
                  borderRadius: "0 9px 9px 0",
                  color: "var(--text)",
                  cursor: "pointer",
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "var(--bg-selected)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "var(--bg-hover)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
            </div>

            {isStreaming && (
              <button
                className="composer-chip is-danger is-active"
                onClick={onAbort}
                 title={t("chat.stopAgent")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 14px",
                  height: 32,
                  background: "var(--danger-soft)",
                  border: "1px solid var(--danger-line)",
                  borderRadius: "var(--radius-control)",
                  color: "var(--danger)",
                  cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  whiteSpace: "nowrap", letterSpacing: "-0.01em",
                  transition: "background 0.12s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "var(--danger-soft)"; }}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                  <rect x="1.5" y="1.5" width="7" height="7" rx="1.5" fill="currentColor" />
                </svg>
                 {t("chat.stop")}
              </button>
            )}

            <LiveVoiceButton
              sessionId={sessionId}
              onEnsureSession={onEnsureSession}
              onTranscriptPersisted={onLiveTranscriptPersisted}
            />

            {onSoundToggle !== undefined && (
              <SoundToggle soundEnabled={soundEnabled ?? true} onToggle={onSoundToggle} />
            )}
          </div>

        </div>
      </div>
    </div>
  );
});
