import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { InterpreterTextError, fetchInterpreterReading } from "@/lib/interpreter-travel";
import { INTERPRETER_TEXT_OUTPUT_MAX_CHARS, READING_LANGUAGES } from "@/lib/translator-context";
import { findTranslatorLanguage } from "@/lib/translator-languages";

export const dynamic = "force-dynamic";

/**
 * POST /api/live/interpret/reading - 일본어·태국어·베트남어 한 줄의 한글 발음만 받는다. 보여주기 카드가
 * 발음 없는 줄을 열 때 한 번 부른다. 본문 `{ text, language }`, 답 `{ reading }`(못 받으면 `null`).
 * 글은 기록하지 않고, 타자 통역과 같은 구독 경로만 쓴다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || !("text" in body) || !("language" in body)) return Response.json({ error: "bad-request" }, { status: 400 });
  const { text, language: code } = body;
  const language = findTranslatorLanguage(code);
  if (typeof text !== "string" || !text.trim() || text.length > INTERPRETER_TEXT_OUTPUT_MAX_CHARS || !language || !READING_LANGUAGES.includes(language.code)) {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }
  try {
    const reading = await fetchInterpreterReading(text.trim(), language, req.signal);
    return Response.json({ reading: reading ?? null });
  } catch (error) {
    if (error instanceof InterpreterTextError && error.kind === "live-auth") return Response.json({ error: "live-auth" }, { status: 401 });
    return Response.json({ error: "live-upstream" }, { status: 502 });
  }
}
