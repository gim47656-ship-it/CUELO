import { NextResponse } from "next/server";
import { RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT } from "@/lib/run-xray-types";
import { RunXrayError, listRuns, syncStatsDb } from "@/lib/run-xray";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_SESSION_ID_CHARS = 200;

function failure(error: unknown): NextResponse {
  // 런타임이 매긴 상태 코드만 그대로 쓰고, 나머지는 서버 오류로 남긴다.
  const status = error instanceof RunXrayError ? error.status : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

// GET /api/runs?sessionId=<id>&limit=<n> - 세션의 run 목록. 최신 run이 먼저 온다.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const params = new URL(req.url).searchParams;
    const sessionId = params.get("sessionId") ?? "";
    if (!sessionId.trim() || sessionId.length > MAX_SESSION_ID_CHARS) {
      throw new RunXrayError("sessionId가 필요합니다.", 400);
    }
    const rawLimit = Number.parseInt(params.get("limit") ?? "", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), RUN_LIST_MAX_LIMIT) : RUN_LIST_DEFAULT_LIMIT;
    await syncStatsDb();
    return NextResponse.json(listRuns(sessionId, limit));
  } catch (error) {
    return failure(error);
  }
}
