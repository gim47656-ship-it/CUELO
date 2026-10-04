import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { parseAttachmentSettingsPatch } from "@/lib/attachment-settings";
import { readAttachmentSettings, writeAttachmentSettings } from "@/lib/attachment-store";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** GET -> AttachmentSettings: upload size limit and automatic cleanup of unreferenced uploads. */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    return NextResponse.json(await readAttachmentSettings(getAgentDir()), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

/** PATCH { uploadLimitMb?, autoCleanupEnabled? } -> AttachmentSettings. `orphanGraceDays` is fixed at 7. */
export async function PATCH(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "application/json body required" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const parsed = parseAttachmentSettingsPatch(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  try {
    return NextResponse.json(await writeAttachmentSettings(getAgentDir(), parsed.patch), { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
