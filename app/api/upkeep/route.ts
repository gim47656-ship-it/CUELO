import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { collectUpkeep, refreshUpkeepAfterMarkChange } from "@/lib/upkeep/collect";
import { clearFixMark, fixMarkTimeFrom, fixMetricIdFrom, setFixMark } from "@/lib/upkeep/fixes";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try { return NextResponse.json(await collectUpkeep(new URL(req.url).searchParams.get("refresh") === "1")); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}

/**
 * POST { metricId, at? } → 고침 표시를 `at`(없으면 지금)으로 남기고, DELETE { metricId } → 지운 뒤 새로 만든 보고서.
 * `change`가 문자열을 돌려주면 표시를 바꾸지 않고 그 이유로 400을 낸다.
 */
async function changeFixMark(req: Request, change: (agentDir: string, metricId: string, body: unknown) => string | void) {
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
    const rejected = change(getAgentDir(), metricId, body);
    if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Could not save the fix mark" }, { status: 500 });
  }
  try { return NextResponse.json(await refreshUpkeepAfterMarkChange()); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}

export function POST(req: Request) {
  return changeFixMark(req, (agentDir, metricId, body) => {
    const at = fixMarkTimeFrom(body, new Date());
    if (!at) return "at must be an ISO time within the last seven days and not in the future";
    setFixMark(agentDir, metricId, at);
  });
}

export function DELETE(req: Request) {
  return changeFixMark(req, clearFixMark);
}
