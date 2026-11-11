import { NextResponse } from "next/server";
import { createSavedPrompt, listSavedPrompts, SavedPromptInputError } from "@/lib/saved-prompts-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    return NextResponse.json({ prompts: listSavedPrompts() }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cannot load saved prompts" }, { status: 500, headers });
  }
}

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "application/json body required" }, { status: 415 });
  let input: unknown;
  try { input = await req.json(); } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return NextResponse.json({ error: "Prompt body is required" }, { status: 400 });
  try {
    const prompt = createSavedPrompt(input);
    return NextResponse.json({ prompt }, { status: 201, headers });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cannot save prompt" }, {
      status: error instanceof SavedPromptInputError ? 400 : 500, headers,
    });
  }
}
