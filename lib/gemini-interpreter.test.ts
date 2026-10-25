import { describe, expect, test } from "bun:test";
import { GEMINI_INTERPRETER_MODEL, geminiInterpreterSetup } from "./gemini-interpreter";
import { interpreterInstructions } from "./translator-live";
import { parseInterpreterContext } from "./translator-context";
import { findTranslatorLanguage } from "./translator-languages";

const ko = findTranslatorLanguage("ko")!;
const zh = findTranslatorLanguage("zh")!;
const context = parseInterpreterContext({
  profile: { mood: "polite", gender: "female", age: "30s" },
  history: [{ role: "user", text: "두 그릇 주세요" }, { role: "assistant", text: "请给我两碗。" }],
});

describe("interpreter setup", () => {
  test("audio-only, no tools, the shared prompt, and transcription in the pair's languages", () => {
    const setup = geminiInterpreterSetup(ko, zh, context, "slow");
    expect(setup.model).toBe(`models/${GEMINI_INTERPRETER_MODEL}`);
    expect(setup.generationConfig).toEqual({ responseModalities: ["AUDIO"] });
    expect("tools" in setup).toBe(false);
    expect(setup.inputAudioTranscription).toEqual({ languageCodes: ["ko-KR", "zh-CN"] });
    expect(setup.outputAudioTranscription).toEqual({ languageCodes: ["ko-KR", "zh-CN"] });
    // The prompt the Codex interpreter uses, with the chosen mood, gender, age, pace and earlier lines.
    const instruction = setup.systemInstruction.parts[0]!.text;
    expect(instruction).toBe(interpreterInstructions(ko, zh, context, "slow"));
    expect(instruction).toContain("a woman in their 30s");
    expect(instruction).toContain("请给我两碗。");
    expect(instruction).toContain("Chinese: speak Mandarin");
  });
});
