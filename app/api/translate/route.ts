import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { MAX_TRANSLATE_CHARS, findTranslatorLanguage } from "@/lib/translator-languages";
import { translateWithGemini } from "@/lib/translator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, error: string) {
  return NextResponse.json({ code, error }, { status });
}

/** POST { text, source, target } -> { translation }: 통역 모드의 번역 한 건. 세션을 만들지 않는다. */
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
  const { text, source, target } = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sourceLanguage = findTranslatorLanguage(source);
  const targetLanguage = findTranslatorLanguage(target);
  if (!sourceLanguage || !targetLanguage) return errorResponse(400, "invalid_language", "Unsupported source or target language");
  if (typeof text !== "string" || !text.trim()) return errorResponse(400, "invalid_text", "text is required");
  if (text.length > MAX_TRANSLATE_CHARS) {
    return errorResponse(413, "text_too_long", `text exceeds ${MAX_TRANSLATE_CHARS} characters`);
  }
  if (sourceLanguage.code === targetLanguage.code) return NextResponse.json({ translation: text.trim() });
  try {
    const translation = await translateWithGemini(text.trim(), sourceLanguage, targetLanguage, req.signal);
    return NextResponse.json({ translation });
  } catch (error) {
    if (req.signal.aborted) return errorResponse(499, "aborted", "Request aborted");
    return errorResponse(502, "translate_failed", error instanceof Error ? error.message : String(error));
  }
}
