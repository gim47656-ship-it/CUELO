import { NextResponse } from "next/server";
import { getRunningRpcSessionIds, getWaitingRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling. `waitingSessionIds` are
// running sessions stopped on a user answer (ask, approval); the sidebar lists them under 「확인할 결과」.
export async function GET() {
  return NextResponse.json(
    { runningSessionIds: getRunningRpcSessionIds(), waitingSessionIds: getWaitingRpcSessionIds() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
