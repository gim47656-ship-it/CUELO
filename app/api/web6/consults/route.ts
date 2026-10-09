/**
 * GET /api/web6/consults — 6 Pro(SHION) 상담 기록을 화면에 넘긴다.
 *
 * 기록을 만드는 쪽은 Windows loopback shim(`CUELO_Setup/web6/web6-server.js`)이고 이 라우트는
 * 읽기만 한다. WSL 에서는 shim 의 기록이 Windows 프로필에 쌓이므로 그 파일을 `/mnt/...` 로 직접 읽는다
 * (`consult-log.ts`). 성공 답변의 정본은 session-native custom entry이며, 이 로그에서는
 * query의 authoritative sessionId와 정확히 일치하는 기록만 반환한다.
 *
 * 기록이 없는 것은 오류가 아니라 빈 목록이다 — shim 을 한 번도 쓰지 않은 PC 가 그 상태다.
 */
import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { readConsults } from "./consult-log";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const sessionId = new URL(req.url).searchParams.get("sessionId")?.trim() ?? "";
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  }

  try {
    return NextResponse.json({ consults: await readConsults(sessionId) });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
