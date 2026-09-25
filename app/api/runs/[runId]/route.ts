import { NextResponse } from "next/server";
import { RunXrayError, getRunDetail } from "@/lib/run-xray";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function failure(error: unknown): NextResponse {
  // 런타임이 매긴 상태 코드만 그대로 쓰고, 나머지는 서버 오류로 남긴다.
  const status = error instanceof RunXrayError ? error.status : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

// GET /api/runs/<runId> - runId는 `${sessionId}:${entryId}`. 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { runId } = await params;
    let decoded: string;
    try {
      decoded = decodeURIComponent(runId);
    } catch {
      throw new RunXrayError("runId 형식이 올바르지 않습니다.", 400);
    }
    const separator = decoded.indexOf(":");
    if (separator < 0) throw new RunXrayError("runId 형식이 올바르지 않습니다.", 400);
    const sessionId = decoded.slice(0, separator);
    const entryId = decoded.slice(separator + 1);
    if (!sessionId || !entryId) throw new RunXrayError("runId 형식이 올바르지 않습니다.", 400);
    return NextResponse.json(getRunDetail(sessionId, entryId));
  } catch (error) {
    return failure(error);
  }
}
