import { isApiRequestAllowed } from "@/lib/request-security";
import { subscribeCloudCall, type CloudRelayEvent } from "@/lib/cloud-interpreter";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 30_000;

// GET /api/live/interpret/cloud/events?callId=... - the relayed Vertex Live messages of one call, as SSE.
// One reader per call; closing it stops the call.
export function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }
  const callId = new URL(req.url).searchParams.get("callId");
  if (!callId) return new Response("bad-request", { status: 400 });

  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let ended = false;
  const stop = () => {
    clearInterval(heartbeat);
    detach?.();
    detach = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The reader is gone; cleanup runs from abort/cancel.
        }
      };
      // Bytes queued here that the browser has not taken yet (the strategy below counts bytes).
      const unread = () => Math.max(0, -(controller.desiredSize ?? 0));
      const send = (event: CloudRelayEvent) => {
        write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === "close") {
          ended = true;
          clearInterval(heartbeat);
          detach = null;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
        return unread();
      };
      const attached = subscribeCloudCall(callId, send);
      if (!attached) {
        write(`data: ${JSON.stringify({ type: "close", code: 4404, reason: "The interpreter call is gone." })}\n\n`);
        controller.close();
        return;
      }
      // The close can already have been sent while attaching (an ended call's reason, or the unread cap).
      if (ended) return;
      detach = attached;
      heartbeat = setInterval(() => write(":\n\n"), HEARTBEAT_MS);
      req.signal?.addEventListener("abort", stop);
    },
    cancel: stop,
  }, { highWaterMark: 0, size: (chunk) => chunk?.byteLength ?? 0 });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
