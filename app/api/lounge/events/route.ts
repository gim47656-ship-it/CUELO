import { isApiRequestAllowed } from "@/lib/request-security";
import { getLounge } from "@/lib/lounge/runtime";
import type { LoungeServerEvent } from "@/lib/lounge/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return new Response("Untrusted API request", { status: 403 });
  let lounge;
  try {
    lounge = await getLounge();
    await lounge.refreshAccounts();
  } catch {
    return Response.json({ error: "단톡방 런타임을 읽지 못했습니다." }, { status: 503 });
  }
  const room = lounge;
  let cleanup = () => {};
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      const send = (event: LoungeServerEvent) => {
        if (!closed) controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
      };
      // 구독 후 snapshot을 동기 전송하므로 사이에 생긴 메시지를 놓치지 않는다.
      const unsubscribe = room.subscribe(send);
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          send({ event: "snapshot", data: room.snapshot() });
          const partial = room.currentDelta();
          if (partial) send(partial);
        } catch {
          cleanup();
        }
      }, 5_000);
      cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        request.signal.removeEventListener("abort", cleanup);
        if (!cancelled) controller.close();
      };
      request.signal.addEventListener("abort", cleanup, { once: true });
      if (request.signal.aborted) {
        cleanup();
        return;
      }
      send({ event: "snapshot", data: room.snapshot() });
      const partial = room.currentDelta();
      if (partial) send(partial);
    },
    cancel() { cancelled = true; cleanup(); },
  });
  return new Response(stream, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  } });
}
