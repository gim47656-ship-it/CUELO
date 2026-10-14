import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { MAX_TRANSLATE_CHARS, findTranslatorLanguage } from "@/lib/translator-languages";
import { TranslatorSpeechError, synthesizeTranslation } from "@/lib/translator-speech";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, error: string) {
  return NextResponse.json({ code, error }, { status });
}

/** POST { text, language } -> 모노 `pcm_s16le`(`TRANSLATOR_SPEECH_SAMPLE_RATE`) 스트림: 통역 모드 번역문 한 건을 Cartesia로 읽는다. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) return errorResponse(415, "unsupported", "application/json body required");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", "Malformed JSON body");
  }
  const { text, language } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const speechLanguage = findTranslatorLanguage(language);
  if (!speechLanguage) return errorResponse(400, "invalid_language", "Unsupported language");
  if (typeof text !== "string" || !text.trim()) return errorResponse(400, "invalid_text", "text is required");
  if (text.length > MAX_TRANSLATE_CHARS) {
    return errorResponse(413, "text_too_long", `text exceeds ${MAX_TRANSLATE_CHARS} characters`);
  }
  try {
    const audio = await synthesizeTranslation(text.trim(), speechLanguage, req.signal);
    return new Response(audio, {
      headers: { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (req.signal.aborted) return errorResponse(499, "aborted", "Request aborted");
    if (error instanceof TranslatorSpeechError) return errorResponse(error.status, "speech_failed", error.message);
    return errorResponse(502, "speech_failed", error instanceof Error ? error.message : String(error));
  }
}
