import { isApiRequestAllowed } from "@/lib/request-security";
import { subscribeLiveCall } from "@/lib/live-session";
import type { LiveEvent } from "@/lib/live-types";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 30_000;

// GET /api/live/events?callId=rtc_... - SSE stream of live call state
export function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return new Response("Untrusted API request", { status: 403 });
  }
  const callId = new URL(req.url).searchParams.get("callId");
  if (!callId) return new Response("bad-request", { status: 400 });

  const encoder = new TextEncoder();
  let detach: (() => void) | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: LiveEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          // The reader is gone; cleanup runs from the abort listener.
        }
      };
      detach = subscribeLiveCall(callId, send);
      if (!detach) {
        send({ type: "error", message: "not-found" });
        controller.close();
        return;
      }

      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(":\n\n"));
        } catch {
          // controller already closed
        }
      }, HEARTBEAT_MS);

      req.signal?.addEventListener("abort", () => {
        clearInterval(heartbeat);
        detach?.();
        detach = null;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      detach?.();
      detach = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
    },
  });
}
