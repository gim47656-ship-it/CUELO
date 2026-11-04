import { NextResponse } from "next/server";
import { getLabPlugin, isLabPluginId, recordLabEvent } from "@/lib/plugin-lab";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/plugin-lab/<id>/event body { event: "draft" } → { ok: true }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await params;
  if (!isLabPluginId(id)) return NextResponse.json({ error: "Invalid plugin id" }, { status: 400 });
  let body: { event?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body?.event !== "draft") return NextResponse.json({ error: 'event must be "draft"' }, { status: 400 });
  try {
    if (!(await getLabPlugin(id))) return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    await recordLabEvent(id, "draft");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
