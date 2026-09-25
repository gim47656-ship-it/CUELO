import { buildSessionContext, resolveSessionPath } from "@/lib/session-reader";
import { createMessageUpdateCoalescer, getRpcSession, startRpcSession, type AgentEvent } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";

export const dynamic = "force-dynamic";

const OMITTED_EVENT_TYPES = new Set(["turn_start", "turn_end", "tool_execution_update"]);

function toClientEvent(event: AgentEvent): AgentEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  if (event.type === "message_update") {
    const clientEvent = { ...event };
    delete clientEvent.assistantMessageEvent;
    return clientEvent;
  }
  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}


// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }


  // Fast path: already-running session
  let session = getRpcSession(id);
  if (!session || !session.isAlive()) {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return new Response("Session not found", { status: 404 });
    }
    try {
      ({ session } = await startRpcSession(id, filePath, undefined));
    } catch {
      return new Response("Failed to start agent", { status: 500 });
    }
  }

  // 일회성 진단에서만 시각을 전송한다. 서버 구간과 브라우저 시계는 직접 빼지 않는다.
  const includeTiming = new URL(req.url).searchParams.get("timing") === "1";
  const entriesOnly = new URL(req.url).searchParams.get("entries") === "1";
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const encode = (data: AgentEvent) => {
        if (includeTiming) data = { ...data, serverEmittedAt: Date.now() };
        const text = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(text));
      };

      const coalescer = createMessageUpdateCoalescer(encode);
      const unsubscribe = session.onEvent((event) => {
        const clientEvent = entriesOnly
          ? (event.type === "session_snapshot" ? event : null)
          : (event.type === "session_snapshot" ? null : toClientEvent(event));
        if (!clientEvent) return;
        if (entriesOnly) {
          encode(clientEvent);
          return;
        }
        if (includeTiming) {
          coalescer.push({
            ...clientEvent,
            serverObservedAt: Date.now(),
            streamEventType: (event.assistantMessageEvent as { type?: string } | undefined)?.type,
          });
          return;
        }
        coalescer.push(clientEvent);
      }, { keepAlive: entriesOnly });

      // Subscribe first, then take the persisted snapshot. The two operations are synchronous:
      // an append is either already in this snapshot or arrives through the listener above.
      encode({ type: "connected", sessionId: id });
      if (entriesOnly) {
        const manager = session.inner.sessionManager;
        const entryId = manager.getLeafId();
        if (entryId) {
          encode({
            type: "session_snapshot",
            sessionId: id,
            entryId,
            context: buildSessionContext(manager.getEntries() as never, entryId, {
              deferThinking: true,
              deferToolResultImages: true,
            }),
          });
        }
      }

      // Heartbeat every 30s to prevent server/proxy timeout (Next.js default ~120-150s)
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, 30_000);
      let lastMaintenanceFrame = "";
      const maintenanceHeartbeat = setInterval(() => {
        try {
          const maintenance = getUpdateMutationBlock();
          const frame = maintenance ? `${maintenance.requestId}:${maintenance.phase}` : "";
          if (!maintenance || frame === lastMaintenanceFrame) return;
          lastMaintenanceFrame = frame;
          encode({
            type: "update_maintenance",
            requestId: maintenance.requestId,
            phase: maintenance.phase,
            stageHash: maintenance.stageHash,
          });
        } catch {
          // 공유 receipt를 읽지 못하면 ordinary SSE를 유지하고 worker 쪽 fail-closed 판정에 맡긴다.
        }
      }, 2_000);

      // Cleanup when client disconnects
      const cleanup = () => {
        clearInterval(heartbeat);
        clearInterval(maintenanceHeartbeat);
        coalescer.close();
        unsubscribe();
        controller.close();
      };

      // Detect client disconnect via abort signal
      req.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
