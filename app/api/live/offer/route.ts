import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { createLiveCall, LiveError } from "@/lib/live-session";

export const dynamic = "force-dynamic";

/**
 * POST /api/live/offer - exchange the browser's offer SDP for a Codex answer.
 *
 * The page never holds the Codex credential, so this route is the only place
 * the offer can be signed and forwarded. The answer is returned verbatim.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let sessionId = "";
  let sdp = "";
  let voice: string | undefined;
  let locale: string | undefined;
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") {
      if ("sessionId" in body && typeof body.sessionId === "string") sessionId = body.sessionId;
      if ("sdp" in body && typeof body.sdp === "string") sdp = body.sdp;
      if ("voice" in body && typeof body.voice === "string") voice = body.voice;
      if ("locale" in body && typeof body.locale === "string") locale = body.locale;
    }
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  if (!sessionId || !sdp.trim()) {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }

  try {
    const result = await createLiveCall({
      sessionId,
      sdp,
      ...(voice ? { voice } : {}),
      ...(locale ? { locale } : {}),
    });
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
