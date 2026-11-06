import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { NextResponse } from "next/server";
import { MemoryTraceBuilder } from "@/lib/memory-trace";
import { maskedErrorMessage } from "@/lib/run-xray-turns";
import { isApiRequestAllowed } from "@/lib/request-security";
import { resolveSessionPath } from "@/lib/session-reader";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/sessions/<id>/memory-trace - 세션 기록에서 요청별 기억·지도 문서 탐색을 읽는다. 읽기 전용.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    const builder = new MemoryTraceBuilder(id);
    const input = createReadStream(filePath, { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        // 화면이 닫혀 요청이 끊기면 긴 기록을 끝까지 읽지 않는다.
        if (req.signal.aborted) return new Response(null, { status: 499 });
        if (line) builder.push(line);
      }
    } finally {
      lines.close();
      input.destroy();
    }
    return NextResponse.json(builder.finish(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: maskedErrorMessage(error) }, { status: 500 });
  }
}
