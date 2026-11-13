import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { decide, getState, SyncError } from "@/lib/repo-sync/service";

export const dynamic = "force-dynamic";
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return NextResponse.json(await getState(), { headers: { "Cache-Control": "no-store" } }); }
  catch { return NextResponse.json({ error: "Cannot read repository sync state" }, { status: 500 }); }
}
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body !== "object" || !("name" in body) || !("action" in body) || typeof body.name !== "string" || !["clone", "decline", "undecline"].includes(String(body.action))) {
    return NextResponse.json({ error: "Expected name and clone, decline or undecline action" }, { status: 400 });
  }
  try {
    await decide(body.name, body.action as "clone" | "decline" | "undecline");
    return NextResponse.json(await getState());
  } catch (error) {
    return NextResponse.json({ error: error instanceof SyncError ? error.message : "Repository action failed" }, { status: error instanceof SyncError ? error.status : 500 });
  }
}
