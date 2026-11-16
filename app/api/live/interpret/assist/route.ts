import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { fetchInterpreterAssist, parseInterpreterAssistRequest } from "@/lib/interpreter-assist";
import { InterpreterTextError } from "@/lib/interpreter-travel";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: unknown;
  try { body = await req.json(); }
  catch { return Response.json({ error: "bad-request" }, { status: 400 }); }
  try {
    const request = parseInterpreterAssistRequest(body);
    const result = await fetchInterpreterAssist(request, req.signal);
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof InterpreterTextError) return Response.json({ error: error.kind }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return Response.json({ error: "live-upstream" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
