/**
 * 핸들 없는 게시 입구 — 6 Pro 상담 답변을 세션 하나에 그대로 남긴다.
 *
 * WEB6 shim이 수집한 답을 `sessionId`가 정한 세션에 `gpt6-reply` custom entry로 남긴다
 * (`bridge.publishReply`). 그래서 이 경로로 남긴 entry는 대화 본문의 assistant로
 * 투영되고(`lib/session-reader.ts`), SHION(web6) 얼굴이 붙는다.
 *
 * 인증은 저장소의 Bearer 토큰 하나뿐이다(새 비밀도 새 환경변수도 없다). 토큰을 아는
 * 호출자만 지나간다. 브라우저 전용 가드 `isApiRequestAllowed`는 걸지 않고 JSON content-type
 * 검사도 두지 않는다 — 이 요청을 보내는 것은 브라우저가 아닌 loopback shim이며, 토큰이 이미
 * 자격증명이다.
 *
 * 상태 코드: 토큰 불일치 401(`invalid_token`), 인자 오류 400, 세션 기록 없음 404 — 뒤의 둘은
 * `gpt6HttpStatus` 표를 그대로 따른다.
 */
import { NextResponse } from "next/server";
import { getGpt6Bridge, gpt6BearerToken, gpt6ErrorResponse } from "../runtime";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const bridge = getGpt6Bridge();
  const token = gpt6BearerToken(req);
  if (!bridge.acceptsToken(token)) {
    return NextResponse.json({ error: "Unauthorized", code: "invalid_token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "JSON 본문을 해석할 수 없습니다.", code: "invalid_argument" },
      { status: 400 },
    );
  }

  const fields = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  try {
    return NextResponse.json(await bridge.publishReply(fields));
  } catch (error) {
    return gpt6ErrorResponse(error);
  }
}
