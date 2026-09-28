import { join } from "node:path";
import { NextResponse } from "next/server";
import { transcribeAudioWithGemini } from "@/lib/audio-transcribe";
import { ATTACHMENTS_DIR_NAME, handleAttachmentUpload } from "@/lib/chat-attachments";
import { getOmpRuntime } from "@/lib/omp-runtime";
import { isApiRequestAllowed } from "@/lib/request-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** POST multipart { file, sessionId? } -> StoredAttachment: saves a composer attachment for the agent. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { agentDir } = await getOmpRuntime();
    return await handleAttachmentUpload(req, {
      root: join(agentDir, ATTACHMENTS_DIR_NAME),
      transcribe: transcribeAudioWithGemini,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
