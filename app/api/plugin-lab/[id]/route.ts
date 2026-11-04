import { NextResponse } from "next/server";
import { isLabPluginId, setLabPluginEnabled } from "@/lib/plugin-lab";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/plugin-lab/<id> body { enabled: boolean } → { plugin: LabPlugin }
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const { id } = await params;
  if (!isLabPluginId(id)) return NextResponse.json({ error: "Invalid plugin id" }, { status: 400 });
  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  try {
    const plugin = await setLabPluginEnabled(id, body.enabled);
    if (!plugin) return NextResponse.json({ error: "Plugin not found" }, { status: 404 });
    return NextResponse.json({ plugin });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
