import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { readLivePace } from "@/lib/live-pace";
import { findTranslatorLanguage } from "@/lib/translator-languages";
import { parseInterpreterContext } from "@/lib/translator-context";
import {
  createGeminiInterpreterToken,
  GEMINI_INTERPRETER_MODEL,
  GeminiInterpreterError,
  listGeminiCredentials,
} from "@/lib/gemini-interpreter";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/live/interpret/gemini - the stored, enabled Google API keys a Gemini interpreter call
 * may use, by AuthStorage row id, and the model. No key bytes, masked or not.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { authStorage } = await getOmpRuntime();
  return NextResponse.json(
    { credentials: listGeminiCredentials(authStorage.credentials), model: GEMINI_INTERPRETER_MODEL },
    { headers: NO_STORE },
  );
}

/**
 * POST /api/live/interpret/gemini - mint a single-use, short-lived Gemini Live token for this pair.
 *
 * Body `{ mine, theirs, context?, credentialId }`. The languages must be distinct entries of
 * `lib/translator-languages.ts`; `context` is filtered by `parseInterpreterContext`. The token has the
 * whole session setup (model, interpreter instructions, transcription) locked in, so the browser
 * cannot change them. The selected key must be an enabled Google API key; nothing else is tried.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let mineCode: unknown;
  let theirsCode: unknown;
  let contextValue: unknown;
  let credentialId: unknown;
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") {
      if ("mine" in body) mineCode = body.mine;
      if ("theirs" in body) theirsCode = body.theirs;
      if ("context" in body) contextValue = body.context;
      if ("credentialId" in body) credentialId = body.credentialId;
    }
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  const mine = findTranslatorLanguage(mineCode);
  const theirs = findTranslatorLanguage(theirsCode);
  if (!mine || !theirs || mine.code === theirs.code || !Number.isSafeInteger(credentialId) || (credentialId as number) <= 0) {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }

  try {
    const { authStorage } = await getOmpRuntime();
    const result = await createGeminiInterpreterToken({
      credentials: authStorage.credentials,
      credentialId: credentialId as number,
      mine,
      theirs,
      context: parseInterpreterContext(contextValue),
      pace: await readLivePace(),
    });
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof GeminiInterpreterError) {
      return NextResponse.json({ error: error.kind, message: error.message }, { status: error.status, headers: NO_STORE });
    }
    // Unexpected: keep the detail in the server log only, never echo it.
    console.error("[gemini-interpreter] token request failed:", error instanceof Error ? error.name : typeof error);
    return NextResponse.json({ error: "live-upstream", message: "Gemini token request failed." }, { status: 502, headers: NO_STORE });
  }
}
