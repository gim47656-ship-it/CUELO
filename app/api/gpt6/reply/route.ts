/**
 * 핸들 없는 게시 입구 — 6 Pro 상담 답변을 세션 하나에 그대로 남긴다.
 *
 * `omp_publish_reply`는 6PRO 탭이 발급한 연결번호(`handleKey`)에 묶여 있어서, 상담 답변을
 * 다른 세션에 남기려면 그 세션을 6PRO에 묶어야 했다. 여기서는 `sessionId`가 대상을 정하므로
 * 묶지 않고도 남길 수 있다 — entry를 남기는 배선은 그 도구와 같은 것을 쓴다
 * (`bridge.publishReply` → `appendReplyEntry`). 그래서 이 경로로 남긴 entry도 대화 본문의
 * assistant로 투영되고(`lib/session-reader.ts`), SHION(web6) 얼굴이 붙는다.
 *
 * 인증은 `/api/gpt6/mcp`와 같은 Bearer 토큰 하나뿐이다(새 비밀도 새 환경변수도 없다).
 * 핸들 키를 요구하지 않는 대신 토큰을 아는 호출자만 지나간다. 브라우저 전용 가드
 * `isApiRequestAllowed`는 MCP 라우트와 같은 이유로 걸지 않고, JSON content-type 검사도
 * 두지 않는다 — 이 요청을 보내는 것은 브라우저가 아니며, 토큰이 이미 자격증명이다.
 *
 * 상태 코드: 토큰 불일치 401(무효 토큰 응답 모양은 MCP 라우트와 같다), 인자 오류 400,
 * 세션 기록 없음 404 — 뒤의 둘은 `gpt6HttpStatus` 표를 그대로 따른다.
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
