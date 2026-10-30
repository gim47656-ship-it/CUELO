import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { collectUpkeep, refreshUpkeepAfterMarkChange } from "@/lib/upkeep/collect";
import { clearFixMark, fixMetricIdFrom, setFixMark } from "@/lib/upkeep/fixes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return NextResponse.json(await collectUpkeep(new URL(req.url).searchParams.get("refresh") === "1")); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}

/** POST·DELETE { metricId } → 고침 표시를 지금 시각으로 남기거나 지운 뒤 새로 만든 보고서 */
async function changeFixMark(req: Request, change: (agentDir: string, metricId: string) => void) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "application/json body required" }, { status: 415 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const metricId = fixMetricIdFrom(body);
  if (!metricId) return NextResponse.json({ error: "metricId must name a metric that can take a fix mark" }, { status: 400 });
  try {
    change(getAgentDir(), metricId);
  } catch {
    return NextResponse.json({ error: "Could not save the fix mark" }, { status: 500 });
  }
  try { return NextResponse.json(await refreshUpkeepAfterMarkChange()); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}

export function POST(req: Request) {
  return changeFixMark(req, (agentDir, metricId) => setFixMark(agentDir, metricId, new Date()));
}

export function DELETE(req: Request) {
  return changeFixMark(req, clearFixMark);
}
