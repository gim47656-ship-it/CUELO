import { isImagePath } from "./file-types";
import type { AssistantContentBlock, AssistantMessage, ImageContent, ThinkingContent, ToolCallContent, ToolResultMessage } from "./types";

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

/**
 * 도구 호출별로 모델 생성 종료(`completedAt`)부터 결과 도착까지 걸린 초. 모델 추론 시간은 빠지지만
 * 도구가 실제로 시작한 시각은 기록되지 않으므로 순수 실행 시간과 같지는 않다.
 * 생성 종료 시각이 없거나 실행 전에 건너뛴 호출(`details.executed === false`)은 비운다.
 */
export function toolCallDurations(
  message: AssistantMessage,
  toolResults: ReadonlyMap<string, ToolResultMessage> | undefined,
): Map<string, number> {
  const map = new Map<string, number>();
  const generationEnd = message.completedAt;
  if (!toolResults || !generationEnd) return map;
  for (const [callId, result] of toolResults) {
    if (!result.timestamp) continue;
    if ((result.details as { executed?: unknown } | undefined)?.executed === false) continue;
    const secs = Math.round((result.timestamp - generationEnd) / 1000);
    if (secs > 0) map.set(callId, secs);
  }
  return map;
}

/** 도구 결과 이미지를 개수·바이트로 내주는 라우트(`app/api/tool-image/route.ts`). */
export const TOOL_IMAGE_ROUTE = "/api/tool-image";

/**
 * 대화창에 도구 결과 이미지를 끼우는 자리. image 모양이라 answer 로 분류되고, 화면이 answer
 * 블록을 메시지에 투영하는 길(`withAssistantBlocks`)을 그대로 지난다. 그림 자체는 담지 않는다 —
 * 초기 기록은 도구 결과 base64 를 빼고 오므로, 렌더러가 세션 id 와 이 `toolCallId` 로 라우트에
 * 개수와 바이트를 묻는다.
 */
export interface ToolImageBlock extends ImageContent {
  toolImage: { toolCallId: string };
}

export function isToolImageBlock(block: AssistantContentBlock): block is ToolImageBlock {
  return block.type === "image" && "toolImage" in block;
}

export function toolImageBlock(toolCallId: string): ToolImageBlock {
  return { type: "image", source: { type: "url", url: "" }, toolImage: { toolCallId } };
}

export function toolImageUrl(sessionId: string, toolCallId: string, index?: number): string {
  const query = new URLSearchParams({ sessionId, toolCallId });
  if (index !== undefined) query.set("index", String(index));
  return `${TOOL_IMAGE_ROUTE}?${query}`;
}

/**
 * 이 도구 호출의 결과가 이미지를 담았을 수 있는가 — 생성한 그림(`generate_image`, xd:// 장치
 * 호출 포함)이나 확인한 그림(이미지 파일 `read`)이다. 초기 기록에서는 base64 가 빠져 결과만으로
 * 알 수 없으므로 호출 구조로 고르고, 실제 개수는 라우트가 센다(0 이면 아무것도 그리지 않는다).
 */
export function mayCarryToolImages(call: ToolCallContent, result: ToolResultMessage | undefined): boolean {
  if (!result || result.isError) return false;
  if (result.content?.some((block) => block.type === "image")) return true;
  const input = call.input ?? {};
  if (call.toolName === "generate_image") return true;
  if (call.toolName === "write") return input.path === "xd://generate_image";
  return call.toolName === "read" && typeof input.path === "string" && isImagePath(input.path);
}

/**
 * 한 턴 안에서 도구 결과 이미지를 모아 다음 답에 넘긴다. 이미지는 그것을 만든 호출 뒤의 첫
 * 답 앞에 붙고, 뒤에 답이 없으면 턴 끝에 이미지만 있는 답으로 남는다 — 정착한 턴과 아직 흐르는
 * 끝 턴이 같은 규칙을 쓴다.
 */
export function createToolImageCollector(messages: readonly { role: string }[]) {
  const results = new Map<string, ToolResultMessage>();
  for (const message of messages) {
    if (message.role === "toolResult") {
      const result = message as ToolResultMessage;
      results.set(result.toolCallId, result);
    }
  }
  let pending: ToolImageBlock[] = [];
  let pendingIdx = -1;
  return {
    /** process 블록에서 이미지를 낼 호출을 찾는다. `idx` 는 그 호출이 든 메시지다. */
    collect(idx: number, blocks: readonly AssistantContentBlock[]): void {
      for (const block of blocks) {
        if (block.type !== "toolCall" || !mayCarryToolImages(block, results.get(block.toolCallId))) continue;
        pending.push(toolImageBlock(block.toolCallId));
        pendingIdx = idx;
      }
    },
    /** 모은 이미지를 답 블록 앞에 붙인다. */
    attach(blocks: AssistantContentBlock[]): AssistantContentBlock[] {
      if (pending.length === 0) return blocks;
      const attached = [...pending, ...blocks];
      pending = [];
      return attached;
    },
    /** 답을 만나지 못한 이미지. 없으면 `null`, 있으면 그 이미지와 마지막 호출이 든 메시지. */
    takeRemaining(): { idx: number; blocks: ToolImageBlock[] } | null {
      if (pending.length === 0) return null;
      const remaining = { idx: pendingIdx, blocks: pending };
      pending = [];
      return remaining;
    },
  };
}

/** 세션·호출별 이미지 개수. 한 도구 결과의 이미지는 바뀌지 않으므로 다시 그릴 때 다시 묻지 않는다. */
const toolImageCounts = new Map<string, number>();
const pendingToolImageCounts = new Map<string, Promise<number>>();

export function knownToolImageCount(sessionId: string, toolCallId: string): number | undefined {
  return toolImageCounts.get(`${sessionId}\n${toolCallId}`);
}

/** 라우트에 개수를 묻는다. 실패는 기억하지 않고 0 으로 본다 — 다음에 그릴 때 다시 묻는다. */
export function loadToolImageCount(sessionId: string, toolCallId: string): Promise<number> {
  const key = `${sessionId}\n${toolCallId}`;
  const known = toolImageCounts.get(key);
  if (known !== undefined) return Promise.resolve(known);
  const pending = pendingToolImageCounts.get(key);
  if (pending) return pending;
  const request = fetch(toolImageUrl(sessionId, toolCallId), { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) return 0;
      const body = await response.json() as { count?: unknown };
      const count = Number.isSafeInteger(body.count) && (body.count as number) >= 0 ? body.count as number : 0;
      toolImageCounts.set(key, count);
      return count;
    })
    .catch(() => 0)
    .finally(() => pendingToolImageCounts.delete(key));
  pendingToolImageCounts.set(key, request);
  return request;
}
