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
}

/** Keep canonical voice adjacency, splitting a new original only at an intervening typed turn. */
export function conversationTurns(lines: readonly ConversationLine[], typed: readonly TypedTurn[], mine: TranslatorLanguage, provisional: TypedTurn | null = null): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const typedTurns = provisional ? [...typed, provisional] : typed;
  for (const line of conversationOrder(lines, (item) => item.segment.role, lineSpeaker)) {
    const side = lineSpeaker(line) ?? "them";
    let turn = turns.at(-1);
    const previousAt = turn?.at;
    const startsAfterTyped = previousAt !== undefined && line.segment.role === "user" && typedTurns.some((item) => item.at > previousAt && item.at <= line.segment.at);
    if (!turn || turn.side !== side || startsAfterTyped) {
      turn = { key: `voice-${line.key}`, at: line.segment.at, side, originals: [], translations: [], voiceLines: [] };
      turns.push(turn);
    }
    turn.voiceLines.push(line);
    const text = { key: line.key, text: line.segment.text, language: lineLanguage(line), fallbackLanguage: line.segment.theirs, final: line.segment.final && !line.draft, loadReading: true };
    (line.segment.role === "assistant" ? turn.translations : turn.originals).push(text);
  }
  for (const turn of typedTurns) {
    turns.push({ key: `typed-${turn.id}`, at: turn.at, side: turn.source.code === mine.code ? "me" : "them", typed: turn,
      originals: [{ key: `original-${turn.id}`, text: turn.original, language: turn.source, final: true }],
      translations: turn.translation ? [{ key: `translation-${turn.id}`, text: turn.translation, language: turn.target, reading: turn.reading, final: turn !== provisional }] : [],
      voiceLines: [], pending: turn === provisional });
  }
  return turns.sort((a, b) => a.at - b.at);
}
