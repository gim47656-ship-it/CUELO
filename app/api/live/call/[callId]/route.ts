import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { closeLiveCall } from "@/lib/live-session";

export const dynamic = "force-dynamic";

// DELETE /api/live/call/[callId] - hang up and release the sideband socket
export async function DELETE(req: Request, { params }: { params: Promise<{ callId: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { callId } = await params;
  const closed = await closeLiveCall(decodeURIComponent(callId));
  if (!closed) return NextResponse.json({ error: "not-found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
