import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { parseSubscription, pushSubscriptions, subscribePush, unsubscribePush } from "@/lib/push/service";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const endpoint = new URL(req.url).searchParams.get("endpoint");
  return NextResponse.json({ subscribed: pushSubscriptions().some((sub) => sub.endpoint === endpoint) });
}
async function mutate(req: Request, remove: boolean) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let raw;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (remove) {
    if (typeof raw?.endpoint !== "string" || !raw.endpoint) return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    unsubscribePush(raw.endpoint);
    return new Response(null, { status: 204 });
  }
  const sub = parseSubscription(raw?.subscription);
  if (!sub) return NextResponse.json({ error: "Invalid browser push subscription" }, { status: 400 });
  subscribePush(sub);
  return NextResponse.json({ ok: true }, { status: 201 });
}
export async function POST(req: Request) { return mutate(req, false); }
export async function DELETE(req: Request) { return mutate(req, true); }
