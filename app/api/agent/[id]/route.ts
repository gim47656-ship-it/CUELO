import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession } from "@/lib/rpc-manager";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const maintenance = getUpdateMutationBlock();
  if (maintenance) {
    return NextResponse.json({
      error: `CUELO update ${maintenance.phase}`,
      code: "update_draining",
      accepted: false,
      requestId: maintenance.requestId,
    }, { status: 503 });
  }


  const requestStarted = performance.now();
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;

    // Fast path: already-running session
    const existing = getRpcSession(id);
    if (existing?.isAlive()) {
      const sessionReady = performance.now();
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      const completed = performance.now();
      return NextResponse.json({ success: true, data: result }, { headers: {
        "Server-Timing": `session_prepare;dur=${(sessionReady - requestStarted).toFixed(2)}, command_accept;dur=${(completed - sessionReady).toFixed(2)}, request;dur=${(completed - requestStarted).toFixed(2)}`,
      } });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    const { session } = await startRpcSession(id, filePath, undefined);
    const sessionReady = performance.now();
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    const completed = performance.now();
    return NextResponse.json({ success: true, data: result }, { headers: {
      "Server-Timing": `session_prepare;dur=${(sessionReady - requestStarted).toFixed(2)}, command_accept;dur=${(completed - sessionReady).toFixed(2)}, request;dur=${(completed - requestStarted).toFixed(2)}`,
    } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
