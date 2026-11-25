import { activeFromRequest, antigravityErrorResponse, browserGuard } from "@/lib/antigravity/http";
import type { AntigravityEvent } from "@/lib/antigravity/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const rejected = browserGuard(req);
  if (rejected) return rejected;
  try {
    const session = await activeFromRequest(req);
    const encoder = new TextEncoder();
    let stop: (close?: boolean) => void = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (value: string) => controller.enqueue(encoder.encode(value));
        const unsubscribe = session.subscribe((event: AntigravityEvent) => {
          if ((controller.desiredSize ?? 0) <= 0) return stop();
          write(`data: ${JSON.stringify(event)}\n\n`);
          if ("state" in event && event.state.closed) stop();
        });
        const heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? 0) > 0) write(": keepalive\n\n");
        }, 15_000);
        heartbeat.unref();
        let closed = false;
        const abort = () => stop();
        stop = (close = true) => {
          if (closed) return;
          closed = true;
          unsubscribe();
          clearInterval(heartbeat);
          req.signal.removeEventListener("abort", abort);
          if (close) controller.close();
        };
        if (req.signal.aborted) stop();
        else req.signal.addEventListener("abort", abort, { once: true });
      },
      cancel() { stop(false); },
    }, { highWaterMark: 256 });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
    });
  } catch (error) { return antigravityErrorResponse(error); }
}
