import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getLiveVoices } from "@/lib/live-session";

export const dynamic = "force-dynamic";

// GET /api/live/voices - voices Codex accepts for a live call
export function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  return NextResponse.json(getLiveVoices(), { headers: { "Cache-Control": "no-store" } });
}
