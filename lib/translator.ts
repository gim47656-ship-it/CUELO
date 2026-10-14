/**
 * 통역 모드의 번역 한 건. 에이전트 세션을 만들지 않고 CUELO의 공용 omp runtime에 저장된
 * Antigravity 자격으로 Gemini 3.8 Flash를 한 번 부른다. 하네스 규칙·시스템 프롬프트·도구·대화
 * 기록은 싣지 않고 아래 몇 줄 지시와 문장만 보내며, 추론은 꺼서 말 한마디가 바로 돌아오게 한다.
 * 호출 방식은 `lib/audio-transcribe.ts`와 같다.
 */
import type { TranslatorLanguage } from "./translator-languages";

export const TRANSLATE_PROVIDER = "google-antigravity";
export const TRANSLATE_MODEL = "gemini-3.8-flash";
const TRANSLATE_TIMEOUT_MS = 30_000;
const TRANSLATE_MAX_TOKENS = 2_048;

export async function translateWithGemini(
  text: string,
  source: TranslatorLanguage,
  target: TranslatorLanguage,
  signal?: AbortSignal,
): Promise<string> {
  const [{ completeSimple }, { getOmpRuntime }] = await Promise.all([
    import("@oh-my-pi/pi-ai"),
    import("@/lib/omp-runtime"),
  ]);
  const { modelRegistry } = await getOmpRuntime();
  const model = modelRegistry.find(TRANSLATE_PROVIDER, TRANSLATE_MODEL);
  if (!model) throw new Error(`${TRANSLATE_PROVIDER}/${TRANSLATE_MODEL} is not available`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) throw new Error(auth.ok ? `No credentials for ${TRANSLATE_PROVIDER}` : auth.error);
  const deadline = AbortSignal.timeout(TRANSLATE_TIMEOUT_MS);
  const instruction = [
    `You interpret a face-to-face conversation for a traveler. Translate the ${source.englishName} text below into natural, polite spoken ${target.englishName}.`,
    "The text comes from speech recognition and may contain recognition mistakes; translate what the speaker most likely meant.",
    "Output only the translation: no quotes, notes, romanization, or alternatives.",
  ].join("\n");
  const result = await completeSimple(
    model,
    {
      systemPrompt: [instruction],
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() }],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: TRANSLATE_MAX_TOKENS,
      disableReasoning: true,
      cacheRetention: "none" as const,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    },
  );
  const translation = result.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (result.stopReason === "length") throw new Error("translation was cut off at the output limit");
  if (result.stopReason !== "stop") {
    throw new Error(result.errorMessage?.slice(0, 160) || `translation stopped (${result.stopReason})`);
  }
  if (!translation) throw new Error("translation returned no text");
  return translation;
}
