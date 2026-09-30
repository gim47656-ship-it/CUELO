import type { ConversationRenderItem, ProcessTurnGroup } from "./transcript-plan";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, ToolResultMessage } from "./types";

export type SavedLesson =
  | { kind: "lesson"; memory: string; skill?: { action: string; name: string } }
  | { kind: "skill"; action: string; name: string };

const MEMORY_PREVIEW_LIMIT = 160;
// `manage_skill` also deletes; only these actions store something.
const SKILL_SAVE_ACTIONS: Record<string, true> = { create: true, update: true };

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * Visits each save the blocks made through `learn`/`manage_skill`, keyed by
 * what was stored (not by the truncated preview, so two lessons sharing their
 * first characters stay apart). Only a call whose result arrived without an
 * error counts, the same rule the auto-learn capture notice uses.
 */
function visitSaves(
  blocks: readonly AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
  visit: (key: string, lesson: SavedLesson) => void,
): void {
  for (const block of blocks) {
    if (block.type !== "toolCall") continue;
    if (block.toolName !== "learn" && block.toolName !== "manage_skill") continue;
    const result = toolResults?.get(block.toolCallId);
    if (!result || result.isError) continue;
    const input = block.input ?? {};
    if (block.toolName === "manage_skill") {
      const action = text(input.action);
      if (SKILL_SAVE_ACTIONS[action] === true) {
        const lesson: SavedLesson = { kind: "skill", action, name: text(input.name) };
        visit(JSON.stringify(lesson), lesson);
      }
      continue;
    }
    const memory = text(input.memory);
    const rawSkill = input.skill as { action?: unknown; name?: unknown } | undefined;
    const skill = rawSkill ? { action: text(rawSkill.action), name: text(rawSkill.name) } : undefined;
    visit(JSON.stringify({ kind: "lesson", memory, skill }), {
      kind: "lesson",
      memory: memory.length > MEMORY_PREVIEW_LIMIT ? `${memory.slice(0, MEMORY_PREVIEW_LIMIT)}…` : memory,
      ...(skill ? { skill } : {}),
    });
  }
}

/**
 * The lessons and skills a turn stored through its own `learn`/`manage_skill`
 * calls. The separate auto-learn capture announces what it saves with an
 * `autolearn-saved` message; a save the agent makes inside the turn has no such
 * notice and would stay folded in the work log. The same save repeated is
 * listed once.
 */
export function extractTurnSavedLessons(
  blocks: readonly AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): SavedLesson[] {
  const saved: SavedLesson[] = [];
  const seen = new Set<string>();
  visitSaves(blocks, toolResults, (key, lesson) => {
    if (seen.has(key)) return;
    seen.add(key);
    saved.push(lesson);
  });
  return saved;
}

/**
 * Direct saves keyed by the conversation item (index in `main`) the card
 * follows. A save inside a message that also answers shows after that answer;
 * a save in folded work shows where that work sits, after the conversation
 * item before it. The card therefore stays put while later answers of the same
 * turn arrive, and a save made after the turn's last answer still shows. A save
 * repeated within one turn is listed once, at its first place.
 */
export function collectSavedLessonPlacements(
  main: readonly ConversationRenderItem[],
  groups: readonly ProcessTurnGroup[],
  messages: readonly AgentMessage[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): Map<number, SavedLesson[]> {
  const lastAnswerByMessage = new Map<number, number>();
  main.forEach((item, position) => {
    if (item.kind === "answer") lastAnswerByMessage.set(item.idx, position);
  });
  const placements = new Map<number, SavedLesson[]>();
  const seenByTurn = new Map<number, Set<string>>();
  for (const group of groups) {
    let seen = seenByTurn.get(group.anchorIdx);
    if (!seen) {
      seen = new Set();
      seenByTurn.set(group.anchorIdx, seen);
    }
    for (const entry of group.entries) {
      const message = messages[entry.idx];
      if (message?.role !== "assistant") continue;
      // Only a partly folded message has an answer of its own to follow.
      const answer = entry.blocks ? lastAnswerByMessage.get(entry.idx) : undefined;
      const position = Math.max(0, answer ?? entry.afterMainIndex ?? -1);
      const turnSeen = seen;
      visitSaves(entry.blocks ?? (message as AssistantMessage).content ?? [], toolResults, (key, lesson) => {
        if (turnSeen.has(key)) return;
        turnSeen.add(key);
        const list = placements.get(position);
        if (list) list.push(lesson);
        else placements.set(position, [lesson]);
      });
    }
  }
  return placements;
}
