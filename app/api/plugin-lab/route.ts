import { NextResponse } from "next/server";
import { listLabPlugins } from "@/lib/plugin-lab";

export const dynamic = "force-dynamic";

// GET /api/plugin-lab → { plugins: LabPlugin[] }
export async function GET() {
  try {
    return NextResponse.json({ plugins: await listLabPlugins() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
