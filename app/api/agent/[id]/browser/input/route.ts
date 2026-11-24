import { sendPaneInput } from "@/lib/ego-pane/hub";
import { hasJsonContentType } from "@/lib/request-security";
import { readJsonObject, resolvePaneSession } from "../guard";

export const dynamic = "force-dynamic";

/**
 * POST /api/agent/[id]/browser/input { tabId, events } - pane clicks, wheel and typing for the tab
 * of the session's TaskSpace the sender was looking at. Forwarded only while that tab is the one
 * showing and ego says the space is the user's; the body is never logged.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await resolvePaneSession(req, params);
  if (typeof id !== "string") return id;
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await readJsonObject(req);
  const result = await sendPaneInput(id, body?.tabId, body?.events);
  const status = result === "sent" ? 200 : result === "invalid" ? 400 : 409;
  return Response.json({ result }, { status, headers: { "Cache-Control": "no-store" } });
}
