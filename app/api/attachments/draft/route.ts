import { NextResponse } from "next/server";
import { MAX_DRAFT_ATTACHMENTS, ManagedAttachmentError, UnknownAttachmentError, getAttachmentStore } from "@/lib/attachment-store";
import { isAttachmentDraftId, isManagedAttachmentId } from "@/lib/document-attachments";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function errorResponse(status: number, code: string, error: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ code, error, ...extra }, { status });
}

/**
 * PUT { draftId, attachmentIds, sentAttachmentIds? } -> { draftId, attachmentIds }: the managed
 * attachments a composer draft still holds. The list replaces the previous one; `[]` releases the
 * draft. Ids in `sentAttachmentIds` left the draft in a sent message and stay protected until the
 * conversation's reference to them is found. A rejected update changes nothing.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) return errorResponse(415, "unsupported", "application/json body required");
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse(400, "invalid_json", "Malformed JSON body");
  }
  const { draftId, attachmentIds, sentAttachmentIds = [] } = (body && typeof body === "object" ? body : {}) as {
    draftId?: unknown;
    attachmentIds?: unknown;
    sentAttachmentIds?: unknown;
  };
  if (!isAttachmentDraftId(draftId)) return errorResponse(400, "invalid_draft", "draftId must be a UUID");
  for (const list of [attachmentIds, sentAttachmentIds]) {
    if (!Array.isArray(list) || list.length > MAX_DRAFT_ATTACHMENTS || !list.every(isManagedAttachmentId)) {
      return errorResponse(400, "invalid_attachment_ids", `attachmentIds and sentAttachmentIds must list at most ${MAX_DRAFT_ATTACHMENTS} attachment ids`);
    }
  }
  try {
    const ids = await getAttachmentStore().setDraftAttachments(draftId, attachmentIds as string[], sentAttachmentIds as string[]);
    return NextResponse.json({ draftId: draftId.toLowerCase(), attachmentIds: ids });
  } catch (error) {
    if (error instanceof UnknownAttachmentError) {
      return errorResponse(404, "unknown_attachment", error.message, { missing: error.missing });
    }
    if (error instanceof ManagedAttachmentError && error.code === "busy") {
      return errorResponse(503, "busy", error.message);
    }
    return errorResponse(500, "draft_update_failed", error instanceof Error ? error.message : String(error));
  }
}
