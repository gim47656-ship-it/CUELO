import { subscribePane, type PaneEvent } from "@/lib/ego-pane/hub";
import { resolvePaneSession } from "../guard";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 30_000;
/** Frames queued beyond this are dropped for a reader that cannot keep up; state always goes out. */
const MAX_QUEUED_CHUNKS = 3;

/**
 * GET /api/agent/[id]/browser/events - SSE live view of the session's TaskSpace tab: `state`
 * events and JPEG `frame` events. ego captures only while a reader is connected.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await resolvePaneSession(req, params);
  if (typeof id !== "string") return id;

  const encoder = new TextEncoder();
  let leave: (() => void) | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  const stop = () => {
    clearInterval(heartbeat ?? undefined);
    heartbeat = null;
    leave?.();
    leave = null;
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enqueue = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The reader is gone; cleanup runs from abort or cancel.
        }
      };
      leave = subscribePane(id, (event: PaneEvent) => {
        if (event.type === "frame" && (controller.desiredSize ?? 0) < -MAX_QUEUED_CHUNKS) return;
        enqueue(`data: ${JSON.stringify(event)}\n\n`);
      });
      heartbeat = setInterval(() => enqueue(":\n\n"), HEARTBEAT_MS);
      req.signal.addEventListener("abort", () => {
        stop();
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
      // The request can be aborted before the listener is attached.
      if (req.signal.aborted) stop();
    },
    cancel() {
      stop();
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
