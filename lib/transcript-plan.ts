import { countToolCallBlocks, getAssistantErrorMessage, splitAssistantBlockRuns, type DisplayOptions } from "./message-display";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, CustomMessage } from "./types";

export interface ProcessEntry {
  idx: number;
  /** Set when only part of a message folds, so the renderer overrides its content. */
  blocks?: AssistantContentBlock[];
}

export type TranscriptRenderItem =
  | { kind: "message"; idx: number }
  | {
      kind: "process";
      anchorIdx: number;
      idx: number;
      groupIndex: number;
      entries: ProcessEntry[];
      messageCount: number;
      toolCallCount: number;
      turnHasAnswer: boolean;
    }
  | {
      kind: "answer";
      anchorIdx: number;
      idx: number;
      runIndex: number;
      blocks: AssistantContentBlock[];
      /** Process blocks since the previous answer; feeds the written-file summary. */
      precedingBlocks: AssistantContentBlock[];
    };

/**
 * The conversation itself: user turns and assistant answer runs. Process items
 * are never part of it, so consumers do not have to re-check for them.
 */
export type ConversationRenderItem = Extract<
  TranscriptRenderItem,
  { kind: "message" } | { kind: "answer" }
>;

export interface TranscriptPlanOptions {
  sessionBusy?: boolean;
  isStreaming?: boolean;
  /** omp's `hideThinkingBlock`: a hidden thinking block is not an entry either. */
  hideThinking?: boolean;
}

// A user message normally anchors a turn (user prompt → process → answer). When
// compaction fires mid-turn, omp drops the original user prompt and inserts a
// compaction summary (role "custom", customType "compaction") in its place; the
// agent then keeps producing tool calls and answers with no user message left to
// anchor them. Treat a compaction summary as an anchor too, otherwise every
// post-compaction message renders standalone and never folds.
export function isGroupAnchor(message: AgentMessage): boolean {
  if (message.role === "user") return true;
  return message.role === "custom" && (message as CustomMessage).customType === "compaction";
}

function hasAssistantMessage(messages: AgentMessage[], from: number, to: number): boolean {
  for (let idx = from; idx < to; idx++) {
    if (messages[idx]?.role === "assistant") return true;
  }
  return false;
}

// Assistant prose is the conclusion the reader came for, so every answer run
// renders standalone in transcript order while tool calls, thinking and
// process-only messages fold. A turn that concludes twice therefore shows both
// conclusions; folding by "last answer wins" used to hide the earlier one.
function planTurn(messages: AgentMessage[], anchorIdx: number, endIdx: number, options: DisplayOptions): TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let entries: ProcessEntry[] = [];
  let toolCallCount = 0;
  let precedingBlocks: AssistantContentBlock[] = [];
  let runIndex = 0;
  let groupIndex = 0;

  const flushProcess = (): void => {
    if (entries.length === 0) return;
    items.push({
      kind: "process",
      anchorIdx,
      idx: entries[0].idx,
      groupIndex: groupIndex++,
      entries,
      messageCount: entries.length,
      toolCallCount,
      turnHasAnswer: false,
    });
    entries = [];
    toolCallCount = 0;
  };

  const pushAnswer = (idx: number, blocks: AssistantContentBlock[]): void => {
    flushProcess();
    items.push({ kind: "answer", anchorIdx, idx, runIndex: runIndex++, blocks, precedingBlocks });
    precedingBlocks = [];
  };

  for (let idx = anchorIdx + 1; idx < endIdx; idx++) {
    const message = messages[idx];
    if (message.role !== "assistant") {
      // The conversation is the user's turns and the agent's answers; every
      // other settled message - compaction notices and the shell commands the
      // user ran - is work log. A `toolResult` is not its own item: the
      // renderer shows it with the `toolCall` block it answers. User messages
      // never reach here because each one anchors its own turn.
      if (message.role !== "toolResult") entries.push({ idx });
      continue;
    }

    const assistant = message as AssistantMessage;
    const runs = splitAssistantBlockRuns(assistant, options);
    const answerRuns = runs.reduce((count, run) => (run.kind === "answer" ? count + 1 : count), 0);
    for (const run of runs) {
      if (run.kind === "answer") {
        pushAnswer(idx, run.blocks);
        continue;
      }
      // A message that also answers keeps its usage footer on the answer bubble,
      // so only its process blocks fold and the entry carries them explicitly.
      entries.push(answerRuns > 0 ? { idx, blocks: run.blocks } : { idx });
      toolCallCount += countToolCallBlocks(run.blocks);
      for (const block of run.blocks) precedingBlocks.push(block);
    }
    // A provider error is the outcome of the turn even with no answer content.
    if (answerRuns === 0 && getAssistantErrorMessage(assistant, options)) pushAnswer(idx, []);
  }
  flushProcess();

  const turnHasAnswer = items.some((item) => item.kind === "answer");
  for (const item of items) {
    if (item.kind === "process") item.turnHasAnswer = turnHasAnswer;
  }
  return items;
}

export function buildTranscriptRenderPlan(
  messages: AgentMessage[],
  options: TranscriptPlanOptions = {},
): TranscriptRenderItem[] {
  let lastAnchorIdx = -1;
  for (let idx = messages.length - 1; idx >= 0; idx--) {
    if (isGroupAnchor(messages[idx])) { lastAnchorIdx = idx; break; }
  }

  const plan: TranscriptRenderItem[] = [];
  for (let idx = 0; idx < messages.length;) {
    if (!isGroupAnchor(messages[idx])) {
      plan.push({ kind: "message", idx });
      idx += 1;
      continue;
    }

    const anchorIdx = idx;
    let endIdx = anchorIdx + 1;
    while (endIdx < messages.length && !isGroupAnchor(messages[endIdx])) endIdx += 1;

    // The live tail streams into place, so it stays flat until the turn settles.
    const isLiveTail = Boolean(options.sessionBusy || options.isStreaming)
      && endIdx === messages.length
      && anchorIdx === lastAnchorIdx;
    if (isLiveTail || !hasAssistantMessage(messages, anchorIdx + 1, endIdx)) {
      for (let renderIdx = anchorIdx; renderIdx < endIdx; renderIdx++) plan.push({ kind: "message", idx: renderIdx });
      idx = endIdx;
      continue;
    }

    plan.push({ kind: "message", idx: anchorIdx });
    for (const item of planTurn(messages, anchorIdx, endIdx, { hideThinking: options.hideThinking })) plan.push(item);
    idx = endIdx;
  }
  return plan;
}

export interface ProcessTurnGroup {
  /** Index of the user message that opened the turn; -1 before the first one. */
  anchorIdx: number;
  entries: ProcessEntry[];
  messageCount: number;
  toolCallCount: number;
}

export interface PartitionedTranscript {
  /** User turns and assistant answer runs only - no process items at all. */
  main: ConversationRenderItem[];
  /** Everything else, grouped by turn, in transcript order. */
  process: ProcessTurnGroup[];
}

/**
 * Splits a render plan into the conversation the reader asked for and the work
 * log behind it. Routing is structural - message role, assistant block kind and
 * the plan's own item kind - never a scan of the text, so a JSON or code answer
 * the agent actually wrote stays in `main`. Nothing is dropped: every plan item
 * lands in exactly one side.
 */
export function partitionTranscriptPlan(
  messages: AgentMessage[],
  plan: TranscriptRenderItem[],
  options: DisplayOptions = {},
): PartitionedTranscript {
  const main: ConversationRenderItem[] = [];
  const process: ProcessTurnGroup[] = [];
  let anchorIdx = -1;
  let group: ProcessTurnGroup | null = null;

  const groupFor = (turnIdx: number): ProcessTurnGroup => {
    if (!group || group.anchorIdx !== turnIdx) {
      group = { anchorIdx: turnIdx, entries: [], messageCount: 0, toolCallCount: 0 };
      process.push(group);
    }
    return group;
  };

  const addEntries = (turnIdx: number, entries: ProcessEntry[], toolCalls: number): void => {
    if (entries.length === 0) return;
    const target = groupFor(turnIdx);
    for (const entry of entries) target.entries.push(entry);
    target.messageCount += entries.length;
    target.toolCallCount += toolCalls;
  };

  for (const item of plan) {
    if (item.kind === "answer") {
      main.push(item);
      continue;
    }
    if (item.kind === "process") {
      addEntries(item.anchorIdx, item.entries, item.toolCallCount);
      continue;
    }

    const message = messages[item.idx];
    if (!message) continue;
    if (message.role === "user") {
      anchorIdx = item.idx;
      main.push(item);
      continue;
    }
    if (message.role !== "assistant") {
      // Compaction notices and shell command output are work log: the
      // conversation is the user's turns and the agent's answers. A
      // `toolResult` is rendered with the `toolCall` it answers, so it is never
      // an entry of its own here either.
      if (message.role !== "toolResult") addEntries(anchorIdx, [{ idx: item.idx }], 0);
      continue;
    }

    // The live tail is still flat, so classify its runs the same way a settled
    // turn is classified instead of leaking tool calls into the conversation.
    const assistant = message as AssistantMessage;
    const runs = splitAssistantBlockRuns(assistant, options);
    let runIndex = 0;
    let answered = false;
    for (const run of runs) {
      if (run.kind === "answer") {
        main.push({ kind: "answer", anchorIdx, idx: item.idx, runIndex: runIndex++, blocks: run.blocks, precedingBlocks: [] });
        answered = true;
        continue;
      }
      addEntries(anchorIdx, [{ idx: item.idx, blocks: run.blocks }], countToolCallBlocks(run.blocks));
    }
    // A provider error is the outcome of the turn; it must stay visible.
    if (!answered && getAssistantErrorMessage(assistant, options)) {
      main.push({ kind: "answer", anchorIdx, idx: item.idx, runIndex, blocks: [], precedingBlocks: [] });
    }
  }

  return { main, process };
}
