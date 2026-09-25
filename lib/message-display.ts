import type { AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

export interface DisplayOptions {
  isStreaming?: boolean;
  /** omp's `hideThinkingBlock` setting: drop thinking blocks entirely. */
  hideThinking?: boolean;
}

/**
 * Projects one assistant message onto a subset of its own blocks. Both the
 * transcript and the process panel render partial runs of the same message, so
 * the projection lives here rather than in either surface. `omitUsage` keeps a
 * per-message token footer from being repeated on every run.
 */
export function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  return next;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

/** True for blocks the transcript must not render at all. */
export function isHiddenAssistantBlock(block: AssistantContentBlock, options: DisplayOptions = {}): boolean {
  if (options.hideThinking && block.type === "thinking") return true;
  return isEmptyThinkingBlock(block, options);
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => !isHiddenAssistantBlock(block, options));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

export type AssistantBlockRunKind = "answer" | "process";

export interface AssistantBlockRun {
  kind: AssistantBlockRunKind;
  blocks: AssistantContentBlock[];
}

/**
 * Assistant prose is answer content wherever it sits in the message; tool calls
 * and thinking are process. Runs keep transcript order, so a message that
 * narrates, calls a tool and then concludes exposes both prose runs instead of
 * only the trailing one.
 */
export function splitAssistantBlockRuns(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantBlockRun[] {
  const runs: AssistantBlockRun[] = [];
  for (const block of getDisplayableAssistantBlocks(message, options)) {
    const kind: AssistantBlockRunKind = block.type === "image"
      || (block.type === "text" && block.text.trim().length > 0)
      ? "answer"
      : "process";
    const current = runs[runs.length - 1];
    if (current?.kind === kind) current.blocks.push(block);
    else runs.push({ kind, blocks: [block] });
  }
  return runs;
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}
