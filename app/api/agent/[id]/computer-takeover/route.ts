import { NextResponse } from "next/server";
import { ComputerTakeoverError } from "@/lib/computer-takeover";
import { getRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

/**
 * POST /api/agent/[id]/computer-takeover { enabled } - the user lets this one session use
 * `computer` takeover input, or takes it back. The value lives only in that session's Settings
 * (never config.yml) and is dropped when the session ends.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const enabled = typeof body === "object" && body !== null ? (body as { enabled?: unknown }).enabled : undefined;
  if (typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  const session = getRpcSession(id);
  if (!session?.isAlive()) {
    return NextResponse.json({ error: "Session is not running" }, { status: 404 });
  }
  try {
    const state = session.setComputerTakeover(enabled);
    return NextResponse.json(
      { enabled: state.enabled, configured: state.configured },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ComputerTakeoverError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
