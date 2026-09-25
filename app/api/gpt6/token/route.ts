/**
 * 저장소 토큰 회전 — WEB 6PRO 탭이 쓰는 쪽.
 *
 * 지금 쓰는 토큰을 제시한 호출만 회전한다. 회전 응답이 새 평문 토큰을 담으므로, 증명 없는
 * 회전을 허용하면 그 자체가 토큰 탈취 경로가 된다. 교체 뒤 저장소에는 새 해시만 남아 이전
 * 토큰은 즉시 거부되고, 연결번호 기록은 그대로 살아 있다.
 *
 * handles 라우트와 같은 입구(`gpt6AdminGuard`)를 쓴다 — 평문 토큰이 나가는 라우트다.
 */
import { NextResponse } from "next/server";
import { hasJsonContentType } from "@/lib/request-security";
import { getGpt6Bridge, gpt6AdminGuard, gpt6ErrorResponse, gpt6McpUrl } from "../runtime";

export const dynamic = "force-dynamic";

// POST /api/gpt6/token — {token} 은 지금 커넥터에 넣어 둔 토큰. 응답의 token이 새 토큰이다.
export async function POST(req: Request) {
  const denied = gpt6AdminGuard(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { token?: unknown };
    const rotated = getGpt6Bridge().rotateToken(typeof body.token === "string" ? body.token.trim() : "");
    return NextResponse.json({ token: rotated.token, rotatedAt: rotated.rotatedAt, mcpUrl: gpt6McpUrl() });
  } catch (error) {
    return gpt6ErrorResponse(error);
  }
}
