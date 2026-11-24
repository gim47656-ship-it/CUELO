import { readPaneOwnership, returnPaneControl, selectPaneTab } from "@/lib/ego-pane/hub";
import { hasJsonContentType } from "@/lib/request-security";
import { readJsonObject, resolvePaneSession } from "./guard";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/agent/[id]/browser - who controls this session's TaskSpace (null when it has none), and
 * whether an ego lite with a pane channel is running on this server (a client stops asking when not).
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await resolvePaneSession(req, params);
  if (typeof id !== "string") return id;
  return Response.json(await readPaneOwnership(id), { headers: NO_STORE });
}

/**
 * POST /api/agent/[id]/browser
 *   { action: "return" }        - 「조작 돌려주기」: a user-owned space goes back to the agent.
 *   { action: "tab", tabId }    - show one of the space's tabs; null follows the agent's tab again.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = await resolvePaneSession(req, params);
  if (typeof id !== "string") return id;
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await readJsonObject(req);
  if (body?.action === "return") {
    const result = await returnPaneControl(id);
    const status = result === "returned" ? 200 : result === "not-user" ? 409 : 502;
    return Response.json({ result, ownership: (await readPaneOwnership(id)).ownership }, { status, headers: NO_STORE });
  }
  if (body?.action === "tab" && (body.tabId === null || typeof body.tabId === "string")) {
    return selectPaneTab(id, body.tabId)
      ? Response.json({ result: "selected" }, { headers: NO_STORE })
      : Response.json({ error: "Tab is not in this session's TaskSpace" }, { status: 409 });
  }
  return Response.json({ error: "Unknown action" }, { status: 400 });
}
