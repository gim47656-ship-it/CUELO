import { NextResponse } from "next/server";
import { transcribeAudioWithGemini } from "@/lib/audio-transcribe";
import {
  readAudioTranscriptionRequest,
  resolveFfmpegPath,
  respondAudioPlan,
  respondAudioTranscription,
} from "@/lib/attachment-audio";
import { ManagedAttachmentError, withManagedAttachment } from "@/lib/attachment-store";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

function leaseErrorResponse(error: unknown): Response {
  if (error instanceof ManagedAttachmentError) {
    switch (error.code) {
      case "invalid_id":
        return NextResponse.json({ code: error.code, error: "Invalid attachment id" }, { status: 400 });
      case "not_found":
        return NextResponse.json({ code: error.code, error: "Attachment not found" }, { status: 404 });
      case "busy":
        return NextResponse.json({ code: error.code, error: "Attachment is being cleaned up; try again" }, { status: 503 });
    }
  }
  console.error("[attachments/transcription] unexpected failure", error);
  return NextResponse.json({ code: "internal", error: "Transcription failed unexpectedly" }, { status: 500 });
}

/** GET -> AudioTranscriptionPlan: what transcribing this stored audio will take. Sends nothing. */
export async function GET(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  try {
    return await withManagedAttachment(id, (attachment) =>
      respondAudioPlan(attachment, { resolveFfmpeg: resolveFfmpegPath, signal: req.signal }));
  } catch (error) {
    return leaseErrorResponse(error);
  }
}

/** POST { confirmed?: boolean } -> { transcript, parts }. Large audio needs confirmed: true. */
export async function POST(req: Request, { params }: Params) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const body = await readAudioTranscriptionRequest(req);
  if (!body) {
    return NextResponse.json({ code: "invalid_body", error: "Body must be empty or { confirmed?: boolean }" }, { status: 400 });
  }
  try {
    return await withManagedAttachment(id, (attachment) =>
      respondAudioTranscription(attachment, body, {
        resolveFfmpeg: resolveFfmpegPath,
        transcribe: transcribeAudioWithGemini,
        signal: req.signal,
      }));
  } catch (error) {
    return leaseErrorResponse(error);
  }
}
