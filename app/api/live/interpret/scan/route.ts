import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { InterpreterTextError } from "@/lib/interpreter-travel";
import { SCAN_IMAGE_MAX_BYTES, parseScanRequest, scanImage } from "@/lib/interpreter-scan";

export const dynamic = "force-dynamic";

/** 데이터 주소의 base64는 디코드 크기의 4/3배다. 머리와 다른 필드를 넉넉히 더한 본문 상한. */
const BODY_MAX_BYTES = Math.ceil((SCAN_IMAGE_MAX_BYTES * 4) / 3) + 4096;

/** Content-Length가 없는 스트림도 상한을 넘는 순간 읽기를 끊는다. 넘으면 `null`. */
async function readBoundedText(req: Request): Promise<string | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BODY_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * POST /api/live/interpret/scan - 메뉴판·간판 사진 한 장을 항목별 번역·설명·알레르기·가격으로 풀어 준다.
 * 본문 `{ image(jpeg·png·webp 데이터 주소), mine, theirs, avoid? }`, 답은 `ScanResult` JSON.
 * 사진은 저장하지 않고, 타자 통역과 같은 구독 경로만 쓴다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_MAX_BYTES) return Response.json({ error: "bad-request" }, { status: 400 });
  let body: unknown;
  try {
    const raw = await readBoundedText(req);
    if (raw === null) return Response.json({ error: "bad-request" }, { status: 400 });
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }
  try {
    return Response.json(await scanImage(parseScanRequest(body), req.signal));
  } catch (error) {
    if (error instanceof InterpreterTextError && error.kind === "bad-request") return Response.json({ error: "bad-request" }, { status: 400 });
    if (error instanceof InterpreterTextError && error.kind === "live-auth") return Response.json({ error: "live-auth" }, { status: 401 });
    return Response.json({ error: "live-upstream" }, { status: 502 });
  }
}
