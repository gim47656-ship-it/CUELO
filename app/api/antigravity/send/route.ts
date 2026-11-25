import { pathToFileURL } from "node:url";
import { ManagedAttachmentError, withManagedAttachment } from "@/lib/attachment-store";
import { MAX_ATTACHED_DOCUMENTS, MAX_ATTACHED_DOCUMENT_TEXT_CHARS, MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS } from "@/lib/document-attachments";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "@/lib/image-attachments";
import { AntigravityError, object } from "@/lib/antigravity/acp";
import { activeFromRequest, antigravityErrorResponse, browserGuard, checkMaintenance, json, readBody } from "@/lib/antigravity/http";
import { contentBlock } from "@/lib/antigravity/protocol";
import type { AcpContent } from "@/lib/antigravity/types";

export const runtime = "nodejs";

async function composerPrompt(body: Record<string, unknown>): Promise<AcpContent[]> {
  const { message, images = [], documents = [] } = body;
  if (typeof message !== "string" || message.length > MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS
    || !Array.isArray(images) || images.length > MAX_ATTACHED_IMAGES
    || !Array.isArray(documents) || documents.length > MAX_ATTACHED_DOCUMENTS) {
    throw new AntigravityError("bad_request", "Invalid Antigravity message or attachments.");
  }
  const blocks: AcpContent[] = [];
  if (message.trim()) blocks.push({ type: "text", text: message });
  for (const image of images) {
    const block = contentBlock({ ...object(image), type: "image" });
    if (block?.type !== "image" || !isBase64ImageWithinLimits(block)) throw new AntigravityError("bad_request", "Invalid image attachment.");
    blocks.push(block);
  }
  let textChars = 0;
  for (const document of documents) {
    const { name, mimeType, text, attachmentId } = object(document);
    if (typeof name !== "string" || !name || name.length > 1024 || typeof mimeType !== "string"
      || typeof text !== "string" || !text || text.length > MAX_ATTACHED_DOCUMENT_TEXT_CHARS) {
      throw new AntigravityError("bad_request", "Invalid document attachment.");
    }
    if (attachmentId !== undefined) {
      if (typeof attachmentId !== "string") throw new AntigravityError("bad_request", "Invalid file attachment.");
      try {
        const block = await withManagedAttachment(attachmentId, async ({ path, mimeType, size }) => ({
          type: "resource_link" as const, uri: pathToFileURL(path).href, name, mimeType, size,
        }));
        blocks.push(block);
      } catch (error) {
        if (!(error instanceof ManagedAttachmentError)) throw error;
        throw new AntigravityError("bad_request", "The attached file is no longer available.");
      }
      continue;
    }
    let uri: string;
    try { uri = `attachment://cuelo/${encodeURIComponent(name)}`; }
    catch { throw new AntigravityError("bad_request", "Invalid attachment name."); }
    textChars += text.length;
    blocks.push({ type: "resource", resource: { uri, mimeType, text } });
  }
  if (!blocks.length || textChars > MAX_TOTAL_ATTACHED_DOCUMENT_TEXT_CHARS) throw new AntigravityError("bad_request", "Empty message or attachment text exceeds the limit.");
  return blocks;
}

export async function POST(req: Request) {
  const rejected = browserGuard(req);
  if (rejected) return rejected;
  try {
    const body = await readBody(req);
    const { submissionId } = body;
    if (typeof submissionId !== "string" || !/^[0-9a-f-]{36}$/i.test(submissionId)) {
      throw new AntigravityError("bad_request", "A valid composer submission ID is required.");
    }
    const prompt = await composerPrompt(body);
    const session = await activeFromRequest(req);
    checkMaintenance();
    session.sendUserPrompt(prompt, submissionId);
    return json({ accepted: true }, 202);
  } catch (error) { return antigravityErrorResponse(error); }
}
