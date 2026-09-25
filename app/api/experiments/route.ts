import { NextResponse } from "next/server";
import {
  EXPERIMENT_DEFAULT_SESSIONS,
  EXPERIMENT_MAX_SESSIONS,
  type ExperimentScope,
} from "@/lib/run-xray-types";
import { RunXrayError, listExperiments, syncStatsDb } from "@/lib/run-xray";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function failure(error: unknown): NextResponse {
  // 런타임이 매긴 상태 코드만 그대로 쓰고, 나머지는 서버 오류로 남긴다.
  const status = error instanceof RunXrayError ? error.status : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
}

// GET /api/experiments?folder=<folder>&sessions=<n>&scope=all|attributed - 구성별 집계 비교.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const params = new URL(req.url).searchParams;
    const rawFolder = params.get("folder");
    const folder = rawFolder && rawFolder.trim() ? rawFolder : null;
    const rawSessions = Number.parseInt(params.get("sessions") ?? "", 10);
    const sessions = Number.isFinite(rawSessions)
      ? Math.min(Math.max(rawSessions, 1), EXPERIMENT_MAX_SESSIONS)
      : EXPERIMENT_DEFAULT_SESSIONS;
    // 아는 값 하나만 인정하고 나머지는 기본 범위로 떨어뜨린다.
    const scope: ExperimentScope = params.get("scope") === "attributed" ? "attributed" : "all";
    await syncStatsDb();
    return NextResponse.json(listExperiments(folder, sessions, scope));
  } catch (error) {
    return failure(error);
  }
}
