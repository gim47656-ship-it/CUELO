import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";
import { getLounge } from "@/lib/lounge/runtime";
import { parseLoungeAction } from "@/lib/lounge/room";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
const HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const lounge = await getLounge();
    await lounge.refreshAccounts();
    return Response.json(lounge.snapshot(), { headers: HEADERS });
  } catch {
    return Response.json({ error: "단톡방 런타임을 읽지 못했습니다." }, { status: 503, headers: HEADERS });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 16_384) return Response.json({ error: "요청이 너무 큽니다." }, { status: 413 });
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "올바른 JSON이 필요합니다." }, { status: 400 });
  }
  const parsed = parseLoungeAction(body);
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
  try {
    const lounge = await getLounge();
    if (parsed.action.action === "settings") await lounge.refreshAccounts();
    const result = lounge.dispatch(parsed.action);
    return Response.json(result.body, { status: result.status, headers: HEADERS });
  } catch {
    return Response.json({ error: "단톡방 요청을 처리하지 못했습니다." }, { status: 503, headers: HEADERS });
  }
}
