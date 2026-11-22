import type { VoiceUtterance } from "@/lib/interpreter-voice/session";
import type { TranslatorLanguage } from "@/lib/translator-languages";
import type { TranscriptLog, TranscriptSegment } from "./transcript-log";

/** Each original and translation keeps its id across partial, final and speaker correction. */
export function upsertVoiceUtterance(log: TranscriptLog, utterance: VoiceUtterance, connection: string,
  pair: { mine: TranslatorLanguage; theirs: TranslatorLanguage }, startedAt: number, outputLanguage?: TranslatorLanguage): TranscriptLog {
  const key = `${connection}:${utterance.id}`;
  const source = utterance.side === "me" ? pair.mine : utterance.side === "them" ? pair.theirs : undefined;
  const target = outputLanguage ?? (utterance.side === "me" ? pair.theirs : utterance.side === "them" ? pair.mine : undefined);
  const segments = [...log.segments];
  let nextId = log.nextId;
  const update = (role: "user" | "assistant", text: string, final: boolean, language: TranslatorLanguage | undefined) => {
    const index = segments.findIndex((segment) => segment.utterance === key && segment.role === role);
    if (!text.trim() && index === -1) return;
    const segment: TranscriptSegment = { id: index === -1 ? nextId++ : segments[index].id, role, text, final,
      ...pair, call: log.call, at: startedAt + utterance.startMs + (role === "assistant" ? 0.01 : 0),
      utterance: key, side: utterance.side, language, translationError: utterance.translationError };
    if (index === -1) segments.push(segment); else segments[index] = segment;
  };
  update("user", utterance.text, utterance.closed, source);
  update("assistant", utterance.translation, utterance.final, target);
  segments.sort((a, b) => a.at - b.at || a.id - b.id);
  return { ...log, segments, nextId };
}
