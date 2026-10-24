import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getLiveVoices } from "@/lib/live-session";
import { isLivePace, writeLivePace } from "@/lib/live-pace";

export const dynamic = "force-dynamic";

// GET /api/live/voices - voices Codex accepts for a live call and the configured one
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(await getLiveVoices(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "failed", message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

// PUT /api/live/voices { pace } - save the speaking pace of live and interpreter calls
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "application/json body required" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const pace = (body as { pace?: unknown } | null)?.pace;
  if (!isLivePace(pace)) {
    return NextResponse.json({ error: "pace must be normal or slow" }, { status: 400 });
  }
  try {
    writeLivePace(pace);
    return NextResponse.json(await getLiveVoices(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
