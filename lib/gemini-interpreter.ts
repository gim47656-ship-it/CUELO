import { interpreterInstructions } from "./translator-live";
import type { InterpreterContext } from "./translator-context";
import type { TranslatorLanguage } from "./translator-languages";
import type { LivePace } from "./live-types";

/**
 * Gemini 통역 세션의 설정(모델·지시·전사·응답 형식). Google Cloud 중계(`lib/cloud-interpreter.ts`)가
 * Vertex에 보내는 setup의 바탕이다.
 *
 * - 지시는 Codex 통역과 같은 `interpreterInstructions`(분위기·성별·나이·속도·앞선 대화)를 그대로 쓴다.
 * - 도구·위임이 없다. 설정에 `tools`를 넣지 않는다.
 */

/** The general Live model: bidirectional interpreting with system instructions (checked live 2026-10-25). */
export const GEMINI_INTERPRETER_MODEL = "gemini-3.8-live";

/** The whole Live setup of an interpreter call. The browser never sends its own. */
export function geminiInterpreterSetup(
  mine: TranslatorLanguage,
  theirs: TranslatorLanguage,
  context: InterpreterContext,
  pace: LivePace,
) {
  return {
    model: `models/${GEMINI_INTERPRETER_MODEL}`,
    generationConfig: { responseModalities: ["AUDIO"] },
    systemInstruction: { parts: [{ text: interpreterInstructions(mine, theirs, context, pace) }] },
    inputAudioTranscription: { languageCodes: [mine.tag, theirs.tag] },
    outputAudioTranscription: { languageCodes: [mine.tag, theirs.tag] },
    // Long calls: drop the oldest context instead of ending the session at the audio limit.
    contextWindowCompression: { slidingWindow: {} },
  };
}
