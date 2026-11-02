import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { collectUpkeep } from "@/lib/upkeep/collect";
import { clearFixMark, fixMarkTimeFrom, fixMetricIdFrom, setFixMark } from "@/lib/upkeep/fixes";
import { changeUpkeepMark } from "@/lib/upkeep/mark-request";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return NextResponse.json(await collectUpkeep(new URL(req.url).searchParams.get("refresh") === "1")); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}

const INVALID_FIX_ID = "metricId must name a metric that can take a fix mark";

/** POST { metricId, at? } → 고침 표시를 `at`(없으면 지금)으로 남기고, DELETE { metricId } → 지운 뒤 새로 만든 보고서. */
export function POST(req: Request) {
  return changeUpkeepMark(req, fixMetricIdFrom, INVALID_FIX_ID, (agentDir, metricId, body) => {
    const at = fixMarkTimeFrom(body, new Date());
    if (!at) return "at must be an ISO time within the last seven days and not in the future";
    setFixMark(agentDir, metricId, at);
  });
}

export function DELETE(req: Request) {
  return changeUpkeepMark(req, fixMetricIdFrom, INVALID_FIX_ID, clearFixMark);
}
