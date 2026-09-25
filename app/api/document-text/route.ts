import { extractText, getDocumentProxy } from "unpdf";
import type { PDFDocumentProxy } from "unpdf/pdfjs";
import {
  MAX_ATTACHED_DOCUMENT_BYTES,
  MAX_ATTACHED_DOCUMENT_TEXT_CHARS,
  MAX_ATTACHED_PDF_PAGES,
} from "@/lib/document-attachments";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0] !== "application/pdf") {
    return errorResponse(415, "unsupported", "PDF 파일만 지원합니다.");
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHED_DOCUMENT_BYTES) {
    return errorResponse(413, "file_too_large", "PDF 파일이 8MB 제한을 초과했습니다.");
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_ATTACHED_DOCUMENT_BYTES) {
    return errorResponse(413, "file_too_large", "PDF 파일이 8MB 제한을 초과했습니다.");
  }

  let pdf: PDFDocumentProxy | null = null;
  try {
    pdf = await getDocumentProxy(bytes);
    if (pdf.numPages > MAX_ATTACHED_PDF_PAGES) {
      return errorResponse(422, "too_many_pages", `PDF가 ${MAX_ATTACHED_PDF_PAGES}페이지 제한을 초과했습니다.`);
    }

    const result = await extractText(pdf, { mergePages: true });
    const text = result.text.trim();
    if (!text) {
      return errorResponse(422, "no_extractable_text", "텍스트를 추출할 수 없는 PDF입니다. 스캔 PDF는 OCR이 필요합니다.");
    }
    if (text.length > MAX_ATTACHED_DOCUMENT_TEXT_CHARS) {
      return errorResponse(413, "text_too_large", "PDF에서 추출된 텍스트가 120,000자 제한을 초과했습니다.");
    }
    return Response.json({ text });
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "PasswordException") {
      return errorResponse(422, "password_protected", "암호로 보호된 PDF는 첨부할 수 없습니다.");
    }
    return errorResponse(422, "invalid_pdf", error instanceof Error ? error.message : "PDF를 읽을 수 없습니다.");
  } finally {
    await pdf?.loadingTask.destroy();
  }
}

function errorResponse(status: number, code: string, error: string): Response {
  return Response.json({ code, error }, { status });
}
