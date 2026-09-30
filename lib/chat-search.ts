import type { ConversationRenderItem } from "./transcript-plan";
import type { AgentMessage } from "./types";

/**
 * The in-chat search index. The chat renders only a window of the conversation,
 * so text outside it is searched from the message data; inside the window the
 * rendered DOM is the source of truth (see ChatSearchBar). One entry per
 * conversation item, lower-cased once.
 */

function blocksText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text" || !("text" in block)) continue;
    if (typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/** What the conversation shows for one item: the prompt, the answer run or the command result. */
export function conversationItemText(item: ConversationRenderItem, messages: readonly AgentMessage[]): string {
  if (item.kind === "answer") return blocksText(item.blocks);
  const message = messages[item.idx];
  if (!message || !("content" in message)) return "";
  return blocksText(message.content);
}

export function buildChatSearchIndex(items: readonly ConversationRenderItem[], messages: readonly AgentMessage[]): string[] {
  return items.map((item) => conversationItemText(item, messages).toLowerCase());
}

/** Non-overlapping occurrences of an already lower-cased needle. */
export function countOccurrences(lowerHaystack: string, lowerNeedle: string): number {
  if (!lowerNeedle) return 0;
  let count = 0;
  for (let at = lowerHaystack.indexOf(lowerNeedle); at !== -1; at = lowerHaystack.indexOf(lowerNeedle, at + lowerNeedle.length)) {
    count += 1;
  }
  return count;
}

/** A hit's place in the conversation: the item and its k-th occurrence there. */
export interface ChatSearchKey {
  item: number;
  k: number;
}

/**
 * Hits in conversation order. Items inside the rendered window contribute the
 * occurrences found in their DOM (`renderedCounts`); every other item
 * contributes the occurrences in its data.
 */
export function listChatSearchHits(
  index: readonly string[],
  lowerNeedle: string,
  renderedCounts: ReadonlyMap<number, number>,
  renderedStart: number,
  renderedEnd: number,
): ChatSearchKey[] {
  const hits: ChatSearchKey[] = [];
  if (!lowerNeedle) return hits;
  for (let item = 0; item < index.length; item++) {
    const rendered = item >= renderedStart && item < renderedEnd;
    const count = rendered ? (renderedCounts.get(item) ?? 0) : countOccurrences(index[item], lowerNeedle);
    for (let k = 0; k < count; k++) hits.push({ item, k });
  }
  return hits;
}

/**
 * Where the active hit lands after the hit list changed. The same place is kept
 * when it still exists; when the item now has fewer occurrences (markdown
 * rendering differs from the raw text) the nearest one in that item is used,
 * and only a vanished item falls back to the first hit.
 */
export function resolveActiveHit(hits: readonly ChatSearchKey[], key: ChatSearchKey | null): number {
  if (hits.length === 0) return -1;
  if (!key) return 0;
  let lastInItem = -1;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (hit.item !== key.item) continue;
    if (hit.k === key.k) return i;
    lastInItem = i;
  }
  return lastInItem === -1 ? 0 : lastInItem;
}
