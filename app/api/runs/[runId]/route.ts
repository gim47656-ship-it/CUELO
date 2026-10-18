import { NextResponse } from "next/server";
import { RunXrayError, getRunDetail, parseRunId } from "@/lib/run-xray";
import { maskedErrorMessage } from "@/lib/run-xray-turns";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function failure(error: unknown): NextResponse {
  // 런타임이 매긴 상태 코드만 그대로 쓰고, 나머지는 서버 오류로 남긴다.
  const status = error instanceof RunXrayError ? error.status : 500;
  return NextResponse.json({ error: maskedErrorMessage(error) }, { status });
}

// GET /api/runs/<runId> - runId는 `${sessionId}:${entryId}`. 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { sessionId, entryId } = parseRunId((await params).runId);
    return NextResponse.json(getRunDetail(sessionId, entryId));
  } catch (error) {
    return failure(error);
  }
}
