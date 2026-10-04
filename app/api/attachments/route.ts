import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { rejectUnauthorizedRequest } from "@/lib/api-request-guard";
import { getAttachmentStore, readAttachmentSettings } from "@/lib/attachment-store";
import { handleAttachmentUpload } from "@/lib/chat-attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST multipart { sessionId?, draftId?, file } -> UploadedAttachment: streams a composer
 * attachment to disk. `proxy.ts` skips this path so Next does not buffer the body, so the same
 * host, origin, and password checks run here before the body is read.
 */
export async function POST(req: Request) {
  const rejection = rejectUnauthorizedRequest(req, "/api/attachments");
  if (rejection) {
    await req.body?.cancel().catch(() => {});
    return rejection;
  }
  try {
    return await handleAttachmentUpload(req, {
      store: getAttachmentStore(),
      settings: await readAttachmentSettings(getAgentDir()),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
