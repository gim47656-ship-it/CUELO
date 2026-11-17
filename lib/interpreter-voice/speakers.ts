import { guessTranslatorLanguage, type TranslatorLanguage } from "../translator-languages";
export type SpeakerSide = "me" | "them";
export interface VoiceMatch { side: SpeakerSide; score: number }
// Cosine similarities, not probabilities. A clear one-second window is required to switch voices.
export const SPEAKER_MIN_SCORE = 0.45;
export const SPEAKER_MIN_MARGIN = 0.12;
export function confidentSide(matches: readonly VoiceMatch[], seconds: number): SpeakerSide | undefined {
  if (seconds < 1 || !matches.length) return undefined;
  const ranked = [...matches].sort((a, b) => b.score - a.score);
  return ranked[0].score >= SPEAKER_MIN_SCORE && (!ranked[1] || ranked[0].score - ranked[1].score >= SPEAKER_MIN_MARGIN) ? ranked[0].side : undefined;
}
export function languageSide(text: string, mine: TranslatorLanguage, theirs: TranslatorLanguage): SpeakerSide | undefined {
  const language = guessTranslatorLanguage(text, mine, theirs);
  return language ? language.code === mine.code ? "me" : "them" : undefined;
}

/** Interpolate a score crossover, then subtract half the one-second embedding window. */
export function speakerBoundary(previous: { endMs: number; matches: readonly VoiceMatch[] } | undefined,
  current: { endMs: number; matches: readonly VoiceMatch[] }, before: SpeakerSide | undefined, after: SpeakerSide): number {
  if (!previous || !before || before === after) return current.endMs - 500;
  const difference = (matches: readonly VoiceMatch[]) => {
    if (matches.length === 1) return (matches[0].side === before ? 1 : -1) * (matches[0].score - SPEAKER_MIN_SCORE);
    return (matches.find((match) => match.side === before)?.score ?? 0) - (matches.find((match) => match.side === after)?.score ?? 0);
  };
  const oldDifference = difference(previous.matches), newDifference = difference(current.matches);
  const crossover = oldDifference >= 0 && newDifference < 0
    ? previous.endMs + (current.endMs - previous.endMs) * oldDifference / (oldDifference - newDifference)
    : current.endMs;
  return crossover - 500;
}

/** With one confirmed profile, clearly different voices belong to the other participant. */
export function singleVoiceSide(matches: readonly VoiceMatch[], seconds: number): SpeakerSide | undefined {
  if (matches.length !== 1 || seconds < 1) return undefined;
  if (matches[0].score <= 0.3) return matches[0].side === "me" ? "them" : "me";
  return undefined;
}
