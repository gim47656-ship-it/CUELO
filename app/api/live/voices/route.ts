import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getLiveVoices } from "@/lib/live-session";

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
