import { guessTranslatorLanguage, type TranslatorLanguage } from "../translator-languages";
import type { InterpreterTextEvent } from "../translator-context";

export const VOICE_LANGUAGE_LETTERS = 12;
const letters = (text: string) => text.match(/\p{L}/gu)?.length ?? 0;

/** Reject known opposite-language script, not ambiguous names/numbers or shared short Latin/Han text. */
export function wrongVoiceLanguage(text: string, source: TranslatorLanguage, target: TranslatorLanguage): boolean {
  const pair = [source.code, target.code];
  if (pair.includes("ja") && pair.includes("zh") && !/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u.test(text)) return false;
  if (pair.includes("en") && pair.includes("vi") && letters(text) < VOICE_LANGUAGE_LETTERS && /^[\x00-\x7f]*$/u.test(text)) return false;
  return guessTranslatorLanguage(text, source, target)?.code === source.code;
}

/** Hold only the initial language decision; a rejected attempt never becomes a committed final. */
export async function* guardVoiceTranslation(attempt: (retry: boolean) => AsyncGenerator<InterpreterTextEvent>, source: TranslatorLanguage, target: TranslatorLanguage): AsyncGenerator<InterpreterTextEvent> {
  let published = false;
  for (const retry of [false, true]) {
    const suppressDeltas = published;
    let buffer = "", accepted = false, rejected = false;
    for await (const event of attempt(retry)) {
      if (event.type === "delta") {
        buffer += event.text;
        if (!accepted && letters(buffer) >= VOICE_LANGUAGE_LETTERS) {
          if (wrongVoiceLanguage(buffer, source, target)) { rejected = true; break; }
          accepted = true;
          if (!suppressDeltas) { published = true; yield { type: "delta", text: buffer }; }
        } else if (accepted) {
          if (wrongVoiceLanguage(buffer, source, target)) { rejected = true; break; }
          if (!suppressDeltas) yield event;
        }
      } else if (event.type === "done") {
        if (wrongVoiceLanguage(event.text, source, target)) { rejected = true; break; }
        if (!accepted && !suppressDeltas) { published = true; yield { type: "delta", text: event.text }; }
        yield event;
        return;
      } else {
        yield event;
        if (event.type === "error") return;
      }
    }
    if (!rejected) throw new Error("Incomplete voice translation");
  }
  throw new Error("Voice translation has the wrong target language");
}
