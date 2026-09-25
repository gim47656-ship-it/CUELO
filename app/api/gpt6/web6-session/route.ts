import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { gpt6AdminGuard, gpt6ErrorResponse, issueGpt6HandleForWeb6 } from "../runtime";

export const dynamic = "force-dynamic";

/** WEB6 loopback shim 전용: 현재 OMP sessionId에 묶인 새 상담 핸들을 발급한다. */
export async function POST(req: Request) {
  const denied = gpt6AdminGuard(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { sessionId?: unknown; requestId?: unknown };
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (!sessionId || !requestId) {
      return NextResponse.json({
        error: "sessionId and requestId are required",
        code: "invalid_argument",
      }, { status: 400 });
    }

    const issued = await issueGpt6HandleForWeb6(sessionId, requestId);
    return NextResponse.json({
      handle: issued.handle,
      handleKey: issued.handleKey,
      startSentence: issued.startSentence,
      sessionId: issued.sessionId,
      expiresAt: issued.expiresAt,
    });
  } catch (error) {
    return gpt6ErrorResponse(error);
  }
}
