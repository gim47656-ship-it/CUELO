import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { findToolResult, readToolImage, toolImageSources } from "./tool-image-source";

/**
 * 도구 결과 이미지 — 대화창 썸네일이 읽는 자리.
 *
 * `GET ?sessionId&toolCallId` 는 그 도구 결과의 이미지 개수(`{ count }`)를, `&index=N` 을 더하면
 * N 번째 이미지 바이트를 준다. 개수는 서버가 세션 기록에서 직접 센다 — 초기 기록 응답은 도구
 * 결과의 base64 를 빼고 보내므로(`deferMedia`) 화면은 개수를 알 수 없다. `generate_image` 결과는
 * 허용 루트 밖 임시 폴더에 있어 `/api/files` 로는 열리지 않으므로 여기서 그 도구 결과에 실제로
 * 적힌 경로만 연다.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const searchParams = new URL(req.url).searchParams;
  const sessionId = searchParams.get("sessionId");
  const toolCallId = searchParams.get("toolCallId");
  if (!sessionId || !toolCallId) {
    return NextResponse.json({ error: "sessionId and toolCallId are required" }, { status: 400 });
  }
  const indexParam = searchParams.get("index");
  const index = indexParam === null ? null : Number(indexParam);
  if (index !== null && (!Number.isSafeInteger(index) || index < 0)) {
    return NextResponse.json({ error: "Valid index is required" }, { status: 400 });
  }

  try {
    const result = await findToolResult(sessionId, toolCallId);
    if (result === null) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (!result || result.isError) return NextResponse.json({ error: "Tool result not found" }, { status: 404 });

    const sources = toolImageSources(result);
    if (index === null) {
      return NextResponse.json({ count: sources.length }, { headers: { "Cache-Control": "no-store" } });
    }
    const source = sources[index];
    if (!source) return NextResponse.json({ error: "Image not found" }, { status: 404 });

    const body = readToolImage(source);
    if (!body.ok) return NextResponse.json({ error: body.error }, { status: body.status });
    return new Response(new Uint8Array(body.bytes), {
      headers: {
        "Content-Type": body.mime,
        "Content-Length": String(body.bytes.length),
        // 한 도구 결과의 이미지는 바뀌지 않는다. 대화를 다시 그릴 때마다 받지 않게 둔다.
        "Cache-Control": "private, max-age=3600",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
