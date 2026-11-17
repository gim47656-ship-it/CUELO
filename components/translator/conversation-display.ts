import type { DisplayLine } from "@/lib/translator-draft";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import { conversationOrder, segmentLanguage, segmentSpeaker, speakerOf, type TranscriptSegment } from "./transcript-log";
import type { TypedTurn } from "./TypedInterpreter";

export type ConversationLine = DisplayLine<TranscriptSegment>;
export const lineLanguage = (line: ConversationLine) => line.language ?? segmentLanguage(line.segment);
export const lineSpeaker = (line: ConversationLine) => line.language ? speakerOf(line.segment, line.language) : segmentSpeaker(line.segment);
export interface BubbleText { key: string; text: string; language?: TranslatorLanguage; fallbackLanguage?: TranslatorLanguage; final: boolean; reading?: string; loadReading?: boolean }
export interface ConversationTurn {
  key: string;
  at: number;
  side: "me" | "them";
  originals: BubbleText[];
  translations: BubbleText[];
  voiceLines: ConversationLine[];
  typed?: TypedTurn;
  pending?: boolean;
  /** The first bubble after the other person spoke (or the first bubble at all): it carries the speaker label. */
  speakerStart?: boolean;
}

/**
 * One bubble per utterance: an original and an interpretation that sit next to each other, never two of either.
 * A second original or interpretation from the same person opens the next bubble, so consecutive utterances
 * read as alternating original/interpretation pairs instead of all interpretations above all originals.
 * Legacy providers do not pair them; explicit voice utterance IDs keep known pairs together.
 */
export function conversationTurns(lines: readonly ConversationLine[], typed: readonly TypedTurn[], mine: TranslatorLanguage, provisional: TypedTurn | null = null): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const typedTurns = provisional ? [...typed, provisional] : typed;
  for (const line of conversationOrder(lines, (item) => item.segment.role, lineSpeaker)) {
    const side = lineSpeaker(line) ?? "them";
    const translation = line.segment.role === "assistant";
    const paired = line.segment.utterance ? turns.find((item) => item.voiceLines.some((previous) => previous.segment.utterance === line.segment.utterance)) : undefined;
    let turn = paired ?? turns.at(-1);
    const previousAt = turn?.at;
    const startsAfterTyped = previousAt !== undefined && !translation && typedTurns.some((item) => item.at > previousAt && item.at <= line.segment.at);
    const full = turn !== undefined && (translation ? turn.translations : turn.originals).length > 0;
    if (!turn || (!paired && (turn.side !== side || startsAfterTyped || full))) {
      // A draft standing in for an interpretation has no time of its own; it follows the bubble before it.
      const at = Number.isFinite(line.segment.at) ? line.segment.at : (previousAt ?? 0);
      turn = { key: `voice-${line.key}`, at, side, originals: [], translations: [], voiceLines: [] };
      turns.push(turn);
    }
    turn.voiceLines.push(line);
    const text = { key: line.key, text: line.segment.text, language: lineLanguage(line), fallbackLanguage: line.segment.theirs, final: line.segment.final && !line.draft, loadReading: true };
    (translation ? turn.translations : turn.originals).push(text);
  }
  for (const turn of typedTurns) {
    turns.push({ key: `typed-${turn.id}`, at: turn.at, side: turn.source.code === mine.code ? "me" : "them", typed: turn,
      originals: [{ key: `original-${turn.id}`, text: turn.original, language: turn.source, final: true }],
      translations: turn.translation ? [{ key: `translation-${turn.id}`, text: turn.translation, language: turn.target, reading: turn.reading, final: turn !== provisional }] : [],
      voiceLines: [], pending: turn === provisional });
  }
  turns.sort((a, b) => a.at - b.at);
  turns.forEach((turn, index) => { turn.speakerStart = index === 0 || turns[index - 1].side !== turn.side; });
  return turns;
}
