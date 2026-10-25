import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { sendCloudAudio } from "@/lib/cloud-interpreter";

export const dynamic = "force-dynamic";

const STATUS = { sent: 204, "bad-request": 400, "not-found": 404, "not-open": 409, backlog: 503 } as const;

/** POST /api/live/interpret/cloud/input - body `{ callId, frames: string[] }` (base64 PCM16 16 kHz). */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let callId: unknown;
  let frames: unknown;
  try {
    const body: unknown = await req.json();
    if (body && typeof body === "object") {
      if ("callId" in body) callId = body.callId;
      if ("frames" in body) frames = body.frames;
    }
  } catch {
    return NextResponse.json({ error: "bad-request" }, { status: 400 });
  }
  if (typeof callId !== "string" || !callId) return NextResponse.json({ error: "bad-request" }, { status: 400 });
  const result = sendCloudAudio(callId, frames);
  return result === "sent" ? new Response(null, { status: 204 }) : NextResponse.json({ error: result }, { status: STATUS[result] });
}
