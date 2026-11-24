/**
 * A2UI answer cards: the wire format between the agent and the CUELO web chat.
 *
 * The agent writes A2UI v1.0 agent-to-renderer messages in a fenced code block
 * with the language `a2ui` inside an ordinary answer. A card action comes back
 * to the agent as a user message whose body is a fenced `a2ui-action` block.
 * Outside the web chat both stay plain code blocks, so this module only reads
 * text and never touches the A2UI runtime.
 */

import { z } from "zod";

export const A2UI_LANG = "a2ui";
export const A2UI_ACTION_LANG = "a2ui-action";

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

/**
 * Top-level fenced blocks whose info string's first word is `lang`, in order.
 * Follows the CommonMark fence rules react-markdown applies: up to three spaces
 * of indentation, a closing fence of the same character at least as long, and
 * an unclosed fence running to the end of the text. The value matches what the
 * markdown renderer hands its `code` component (lines joined, no final newline).
 * Fences nested in block quotes or lists are not collected; they render as code.
 */
export function extractFencedBlocks(markdown: string, lang: string): string[] {
  if (!markdown.includes(lang)) return [];
  const lines = markdown.split(/\r?\n/);
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, info] = open;
    if (fence[0] === "`" && info.includes("`")) continue;
    const fenceChar = fence[0];
    const closer = new RegExp(`^ {0,3}${fenceChar === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    const body: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      if (closer.test(lines[j])) break;
      body.push(stripIndent(lines[j], indent.length));
    }
    if (info.trim().split(/\s+/)[0]?.toLowerCase() === lang) blocks.push(body.join("\n"));
    i = j;
  }
  return blocks;
}

function stripIndent(line: string, width: number): string {
  let n = 0;
  while (n < width && line[n] === " ") n += 1;
  return line.slice(n);
}

/** One agent-to-renderer message: an object keyed by its message kind (`createSurface`, …). */
const MessageObject = z.record(z.unknown());
const MessageList = z.union([
  z.array(MessageObject).nonempty(),
  z.object({ messages: z.array(MessageObject).nonempty() }).transform((value) => value.messages),
  MessageObject.transform((value) => [value]),
]);
const SurfaceRef = z.object({ surfaceId: z.string().min(1) }).passthrough();

export type A2uiParseResult =
  | { ok: true; messages: Record<string, unknown>[] }
  | { ok: false; reason: "empty" | "json" | "shape" };

/**
 * Agent-to-renderer messages from one `a2ui` block: a JSON array, a single
 * message object, `{ "messages": [...] }`, or JSONL (one message per line).
 */
export function parseA2uiBlock(code: string): A2uiParseResult {
  const text = code.trim();
  if (!text) return { ok: false, reason: "empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return { ok: false, reason: "json" };
    const items: unknown[] = [];
    for (const line of lines) {
      try {
        items.push(JSON.parse(line));
      } catch {
        return { ok: false, reason: "json" };
      }
    }
    parsed = items;
  }
  const list = MessageList.safeParse(parsed);
  return list.success ? { ok: true, messages: list.data } : { ok: false, reason: "shape" };
}

/** The surface ids each kind of message in a block touches, in order, without duplicates. */
export interface A2uiBlockTargets {
  created: string[];
  updated: string[];
  deleted: string[];
}

export function blockTargets(messages: readonly Record<string, unknown>[]): A2uiBlockTargets {
  const targets: A2uiBlockTargets = { created: [], updated: [], deleted: [] };
  const lists: Record<string, string[]> = {
    createSurface: targets.created,
    updateComponents: targets.updated,
    updateDataModel: targets.updated,
    deleteSurface: targets.deleted,
  };
  for (const message of messages) {
    for (const [key, list] of Object.entries(lists)) {
      const ref = SurfaceRef.safeParse(message[key]);
      if (ref.success && !list.includes(ref.data.surfaceId)) list.push(ref.data.surfaceId);
    }
  }
  return targets;
}

const ActionEnvelope = z.object({
  version: z.literal("1.0"),
  action: z.object({
    name: z.string(),
    surfaceId: z.string(),
    sourceComponentId: z.string(),
    timestamp: z.string(),
    context: z.record(z.unknown()),
  }).passthrough(),
  metadata: z.object({
    a2uiClientDataModel: z.object({ version: z.literal("1.0"), surfaces: z.record(z.unknown()) }),
  }).optional(),
});

/**
 * A renderer-to-agent action as CUELO sends it: the A2UI v1.0 `action` message,
 * plus the surface data model for surfaces created with `sendDataModel: true`
 * (A2A `a2uiClientDataModel` metadata shape).
 */
export type A2uiActionEnvelope = z.infer<typeof ActionEnvelope>;

export function buildActionEnvelope(
  action: { name: string; surfaceId: string; sourceComponentId: string; timestamp: string; context: Record<string, unknown> },
  dataModel?: unknown,
): A2uiActionEnvelope {
  const envelope: A2uiActionEnvelope = {
    version: "1.0",
    action: {
      name: action.name,
      surfaceId: action.surfaceId,
      sourceComponentId: action.sourceComponentId,
      timestamp: action.timestamp,
      context: action.context ?? {},
    },
  };
  if (dataModel !== undefined) {
    envelope.metadata = { a2uiClientDataModel: { version: "1.0", surfaces: { [action.surfaceId]: dataModel } } };
  }
  return envelope;
}

/** The user message a card action sends: one plain line, then the action JSON in an `a2ui-action` fence. */
export function formatActionMessage(envelope: A2uiActionEnvelope): string {
  const json = JSON.stringify(envelope);
  return `카드 동작: ${envelope.action.name} (${envelope.action.surfaceId})\n\n\`\`\`${A2UI_ACTION_LANG}\n${json}\n\`\`\``;
}


/** The action carried by an `a2ui-action` block, or null when the block is not one. */
export function parseActionBlock(code: string): A2uiActionEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(code.trim());
  } catch {
    return null;
  }
  const envelope = ActionEnvelope.safeParse(parsed);
  return envelope.success ? envelope.data : null;
}

/**
 * The action a user message carries when the whole message is exactly what a
 * card action sends (one plain line, then the action fence), else null. Any
 * other text keeps the message an ordinary one, shown and replayed as written.
 */
export function parseActionMessage(text: string): { envelope: A2uiActionEnvelope; code: string } | null {
  const blocks = extractFencedBlocks(text, A2UI_ACTION_LANG);
  if (blocks.length !== 1) return null;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const line = normalized.split("\n", 1)[0];
  if (normalized !== `${line}\n\n\`\`\`${A2UI_ACTION_LANG}\n${blocks[0]}\n\`\`\``) return null;
  const envelope = parseActionBlock(blocks[0]);
  return envelope ? { envelope, code: blocks[0] } : null;
}

/**
 * One `a2ui` (agent) or `a2ui-action` (sent user action) block in transcript
 * order, keyed by its position: the message index, the content part index
 * (assistant text parts only) and the block's ordinal within that part.
 */
export interface A2uiSourceBlock {
  kind: "agent" | "action";
  messageIndex: number;
  partIndex: number;
  ordinal: number;
  code: string;
}

interface TextPart { type: string; text?: unknown }
interface TranscriptMessage { role: string; content?: unknown }

/** Every A2UI block of a transcript, in the order the chat renders them. */
export function collectA2uiBlocks(messages: readonly TranscriptMessage[]): A2uiSourceBlock[] {
  const blocks: A2uiSourceBlock[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      (message.content as TextPart[]).forEach((part, partIndex) => {
        if (part?.type !== "text" || typeof part.text !== "string") return;
        extractFencedBlocks(part.text, A2UI_LANG).forEach((code, ordinal) => {
          blocks.push({ kind: "agent", messageIndex, partIndex, ordinal, code });
        });
      });
    } else if (message.role === "user") {
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as TextPart[]).filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text as string).join("\n")
          : "";
      // Only a message that is exactly one card action replays; a quoted action in prose does not.
      const action = parseActionMessage(text);
      if (action) blocks.push({ kind: "action", messageIndex, partIndex: 0, ordinal: 0, code: action.code });
    }
  });
  return blocks;
}

/**
 * How many leading blocks two sequences share by kind and text. The chat keeps
 * its processor when the applied sequence is still a prefix of the new one
 * (new messages arrived, or a reload produced new objects with the same text)
 * and rebuilds it otherwise (session switch, edit, compaction).
 */
export function sharedPrefixLength(
  applied: readonly { kind: string; code: string }[],
  next: readonly { kind: string; code: string }[],
): number {
  const limit = Math.min(applied.length, next.length);
  let i = 0;
  while (i < limit && applied[i].kind === next[i].kind && applied[i].code === next[i].code) i += 1;
  return i;
}

/** Media the browser may load from an agent-written address: inline `data:image/*` only. */
export function isInlineImageUrl(url: unknown): url is string {
  return typeof url === "string" && /^data:image\/(png|jpe?g|gif|webp|avif|svg\+xml);/i.test(url.trim());
}

/** Links the user may open by clicking: absolute http(s) only. */
export function safeExternalUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}
