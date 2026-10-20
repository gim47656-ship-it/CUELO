import { readFile } from "node:fs/promises";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { resolveOfficeAsset } from "@/lib/character-mode";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/office-characters/<path> serves a file from `<agentDir>/characters-office/` only:
 * webp, png, wav or json, no traversal and no symlink out of that folder. Nothing here lives under public/.
 */
export async function GET(req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { path: segments } = await params;
  const asset = await resolveOfficeAsset(getAgentDir(), segments.join("/"));
  if (!asset) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return new NextResponse(new Uint8Array(await readFile(asset.file)), {
      headers: { "Content-Type": asset.contentType, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" },
    });
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
}
