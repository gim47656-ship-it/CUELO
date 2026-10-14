import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { LiveError } from "@/lib/live-session";
import { createInterpreterCall } from "@/lib/translator-live";
import { findTranslatorLanguage } from "@/lib/translator-languages";

export const dynamic = "force-dynamic";

/**
 * POST /api/live/interpret - open a sessionless interpreter call.
 *
 * Body `{ sdp, mine, theirs }`; the two language codes must be distinct
 * entries of `lib/translator-languages.ts`. The answer SDP comes back with the
 * call id, and the call is then read and ended through `/api/live/events` and
 * `/api/live/call/[callId]` like a session call.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let sdp = "";
  let mineCode: unknown;
  let theirsCode: unknown;
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") {
      if ("sdp" in body && typeof body.sdp === "string") sdp = body.sdp;
      if ("mine" in body) mineCode = body.mine;
      if ("theirs" in body) theirsCode = body.theirs;
    }
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  const mine = findTranslatorLanguage(mineCode);
  const theirs = findTranslatorLanguage(theirsCode);
  if (!sdp.trim() || !mine || !theirs || mine.code === theirs.code) {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }

  try {
    const result = await createInterpreterCall({ sdp, mine, theirs });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof LiveError) {
      return NextResponse.json({ error: error.kind, message: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : String(error);
    // A missing or expired Codex credential is the one failure the user can fix.
    const isAuth = message.includes("OAuth") || message.includes("credential") || message.includes("401");
    return NextResponse.json(
      { error: isAuth ? "live-auth" : "live-upstream", message },
      { status: isAuth ? 401 : 502 },
    );
  }
}
