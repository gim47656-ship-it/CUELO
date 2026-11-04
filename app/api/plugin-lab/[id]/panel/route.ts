import { NextResponse } from "next/server";
import { LAB_PANEL_HEADERS, isLabPluginId, readLabPanel, recordLabEvent } from "@/lib/plugin-lab";

export const dynamic = "force-dynamic";

// GET /api/plugin-lab/<id>/panel → the manifest's panel HTML, inert outside a sandboxed iframe.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isLabPluginId(id)) return NextResponse.json({ error: "Invalid plugin id" }, { status: 400 });
  try {
    const html = await readLabPanel(id);
    if (html === undefined) return NextResponse.json({ error: "Panel not found" }, { status: 404 });
    // A failed usage write must not keep the panel from opening.
    await recordLabEvent(id, "panel_open").catch((error) => {
      console.error("[plugin-lab] failed to record panel_open:", error instanceof Error ? error.message : error);
    });
    return new Response(html, { status: 200, headers: LAB_PANEL_HEADERS });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
