import { NextResponse } from "next/server";
import { deleteSavedPrompt } from "@/lib/saved-prompts-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const { id } = await context.params;
  try {
    if (!deleteSavedPrompt(id)) return NextResponse.json({ error: "Saved prompt not found" }, { status: 404 });
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Cannot delete prompt" }, { status: 500 });
  }
}
