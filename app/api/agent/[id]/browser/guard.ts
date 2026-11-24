import { isPaneSessionId } from "@/lib/ego-pane/space";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

/**
 * Shared entry check of the 브라우저 옆 칸 routes (proxy.ts has already applied the web lock).
 * The id must name a session CUELO knows: the routes reach exactly the TaskSpace `cuelo-<id>-user`,
 * so an id that is no session of this server reaches nothing.
 */
export async function resolvePaneSession(req: Request, params: Promise<{ id: string }>): Promise<string | Response> {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  const { id } = await params;
  if (!isPaneSessionId(id)) return Response.json({ error: "Session not found" }, { status: 404 });
  if (!getRpcSession(id) && !(await resolveSessionPath(id))) return Response.json({ error: "Session not found" }, { status: 404 });
  return id;
}

/** Room for a full batch of the longest text events; nothing the pane sends comes near it. */
const BODY_MAX_BYTES = 512 * 1024;

/** A JSON object body, or null when the body is not one or is larger than a pane request can be. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.body || Number(req.headers.get("content-length") ?? "0") > BODY_MAX_BYTES) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // A body without Content-Length is cut the moment it passes the limit.
      if (total > BODY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    // TextDecoder drops a leading BOM, as Request.json() does.
    const body: unknown = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
    return typeof body === "object" && body !== null && !Array.isArray(body) ? Object.fromEntries(Object.entries(body)) : null;
  } catch {
    return null;
  }
}
