import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { InterpreterTextError, parseInterpreterTextRequest, streamInterpreterText } from "@/lib/interpreter-travel";
import type { InterpreterTextEvent } from "@/lib/translator-context";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const request = parseInterpreterTextRequest(await req.json());
    const abort = new AbortController();
    const signal = AbortSignal.any([req.signal, abort.signal]);
    // Resolve model/auth before committing streaming HTTP headers.
    const events = await streamInterpreterText(request, signal);
    const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream({
      async start(controller) {
        const send = (event: InterpreterTextEvent) => {
          if (!cancelled && !signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        try {
          for await (const event of events) send(event);
        } catch (error) {
          send({ type: "error", error: error instanceof InterpreterTextError && error.kind === "live-auth" ? "live-auth" : "live-upstream" });
        } finally {
          if (!cancelled) controller.close();
          abort.abort();
        }
      },
      cancel() { cancelled = true; abort.abort(); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) {
    if (error instanceof InterpreterTextError) return Response.json({ error: error.kind }, { status: error.status });
    if (error instanceof SyntaxError) return Response.json({ error: "bad-request" }, { status: 400 });
    return Response.json({ error: "live-upstream" }, { status: 502 });
  }
}
