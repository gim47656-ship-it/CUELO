import type { ProcessTurnGroup } from "./transcript-plan";
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
 * The lessons and skills a turn stored through its own `learn`/`manage_skill`
 * calls. The separate auto-learn capture announces what it saves with an
 * `autolearn-saved` message; a save the agent makes inside the turn has no such
 * notice and would stay folded in the work log. Only a call whose result arrived
 * without an error counts, the same rule the capture notice uses. The same save
 * repeated in one turn is listed once.
 */
export function extractTurnSavedLessons(
  blocks: readonly AssistantContentBlock[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): SavedLesson[] {
  const saved: SavedLesson[] = [];
  const seen = new Set<string>();
  // Keyed by what was stored, not by the truncated preview, so two lessons
  // sharing their first characters both stay.
  const add = (key: string, lesson: SavedLesson): void => {
    if (seen.has(key)) return;
    seen.add(key);
    saved.push(lesson);
  };
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
        add(JSON.stringify(lesson), lesson);
      }
      continue;
    }
    const memory = text(input.memory);
    const rawSkill = input.skill as { action?: unknown; name?: unknown } | undefined;
    const skill = rawSkill ? { action: text(rawSkill.action), name: text(rawSkill.name) } : undefined;
    add(JSON.stringify({ kind: "lesson", memory, skill }), {
      kind: "lesson",
      memory: memory.length > MEMORY_PREVIEW_LIMIT ? `${memory.slice(0, MEMORY_PREVIEW_LIMIT)}…` : memory,
      ...(skill ? { skill } : {}),
    });
  }
  return saved;
}

/**
 * Direct saves per turn, keyed by the turn's anchor index. The whole process
 * group is read, not an answer's preceding blocks, so a save made after the
 * turn's last answer still counts.
 */
export function collectTurnSavedLessons(
  groups: readonly ProcessTurnGroup[],
  messages: readonly AgentMessage[],
  toolResults: Map<string, ToolResultMessage> | undefined,
): Map<number, SavedLesson[]> {
  const blocksByTurn = new Map<number, AssistantContentBlock[]>();
  for (const group of groups) {
    let blocks = blocksByTurn.get(group.anchorIdx);
    if (!blocks) {
      blocks = [];
      blocksByTurn.set(group.anchorIdx, blocks);
    }
    for (const entry of group.entries) {
      const message = messages[entry.idx];
      if (message?.role !== "assistant") continue;
      for (const block of entry.blocks ?? (message as AssistantMessage).content ?? []) blocks.push(block);
    }
  }
  const saved = new Map<number, SavedLesson[]>();
  for (const [anchorIdx, blocks] of blocksByTurn) {
    const lessons = extractTurnSavedLessons(blocks, toolResults);
    if (lessons.length > 0) saved.set(anchorIdx, lessons);
  }
  return saved;
}
