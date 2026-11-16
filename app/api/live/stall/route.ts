import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { STALL_MAX_BODY, formatStallLine, parseStallReport } from "@/components/translator/stall-report";

export const dynamic = "force-dynamic";

/**
 * 폰 통역 화면의 멈춤·마주보기 기록을 서버 로그(폰 서버 로그, PC journald)에 한 줄씩 남긴다. 숫자와
 * 정해진 낱말만 받고 저장하지 않는다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const body = await req.text();
  if (body.length > STALL_MAX_BODY) return Response.json({ error: "bad-request" }, { status: 400 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return Response.json({ error: "bad-request" }, { status: 400 });
  }
  const report = parseStallReport(parsed);
  if (!report) return Response.json({ error: "bad-request" }, { status: 400 });
  for (const event of report.events) console.warn(formatStallLine(event));
  return new Response(null, { status: 204 });
}
