import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { refreshUpkeepAfterMarkChange } from "./collect";

/**
 * 고침·점검 표시 요청의 공통 경로. 본문에서 `idFrom`으로 지표 id를 읽고 `change`로 표시를 바꾼 뒤 새로 만든 보고서를
 * 돌려준다. `change`가 문자열을 돌려주면 표시를 바꾸지 않고 그 이유로 400을 낸다.
 */
export async function changeUpkeepMark(
  req: Request,
  idFrom: (body: unknown) => string | null,
  invalidId: string,
  change: (agentDir: string, metricId: string, body: unknown) => string | void,
) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "application/json body required" }, { status: 415 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed JSON body" }, { status: 400 });
  }
  const metricId = idFrom(body);
  if (!metricId) return NextResponse.json({ error: invalidId }, { status: 400 });
  try {
    const rejected = change(getAgentDir(), metricId, body);
    if (rejected) return NextResponse.json({ error: rejected }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Could not save the mark" }, { status: 500 });
  }
  try { return NextResponse.json(await refreshUpkeepAfterMarkChange()); }
  catch { return NextResponse.json({ error: "Upkeep scan failed" }, { status: 500 }); }
}
