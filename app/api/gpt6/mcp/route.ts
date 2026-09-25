/**
 * MCP 서버 라우트 — 6 Pro가 Secure MCP Tunnel로 OMP를 호출하는 입구. JSON-RPC 2.0 over HTTP.
 *
 * **여기에는 브라우저 전용 가드 `isApiRequestAllowed`를 걸지 않는다.** 이 요청을 보내는 것은
 * 브라우저가 아니라 집 PC의 `tunnel-client`이고 `Origin`/`Sec-Fetch-Site` 헤더가 없으므로,
 * 그 가드를 걸면 정상 호출이 403으로 막힌다. 대신 `Authorization: Bearer <토큰>` 헤더와
 * JSON content-type을 검사하고 본문은 토큰이 맞을 때만 파싱한다. 그 토큰은 커넥터가 아니라
 * `tunnel-client` 설정에 있고(커넥터에는 `tunnel_id`만 있다), 연결번호 하나에 대한 권한은
 * 도구 인자의 `handleKey`가 쥔다(둘 다 없으면 어떤 도구도 실행되지 않는다).
 *
 * 받은 호출의 도구 이름·결과는 `~/.omp/gpt6-mcp-calls.log`에 한 줄씩 남긴다(lib/gpt6-call-log.ts).
 * 터널 클라이언트 로그에는 요청 id와 시각만 있고 도구 이름이 없어서, ChatGPT 쪽이 보고한
 * "안전 검사 차단"과 서버 수신분을 대조할 수단이 없었다.
 */
import { NextResponse } from "next/server";
import { GPT6_RPC_ERROR } from "@/lib/gpt6-bridge";
import { gpt6CallFields, gpt6CallStatus, logGpt6Call } from "@/lib/gpt6-call-log";
import { hasJsonContentType } from "@/lib/request-security";
import { getGpt6Bridge, gpt6BearerToken } from "../runtime";
import { getUpdateMutationBlock } from "@/lib/update-maintenance";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const startedAt = Date.now();

  if (!hasJsonContentType(req)) {
    logGpt6Call({ status: "rejected:content-type", durationMs: Date.now() - startedAt });
    return NextResponse.json(
      { error: "Content-Type must be application/json" },
      { status: 415 },
    );
  }

  const bridge = getGpt6Bridge();
  const token = gpt6BearerToken(req);
  if (!bridge.acceptsToken(token)) {
    logGpt6Call({ status: "rejected:token", durationMs: Date.now() - startedAt });
    return NextResponse.json({ error: "Unauthorized", code: "invalid_token" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    logGpt6Call({ status: "rejected:parse", durationMs: Date.now() - startedAt });
    return NextResponse.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: GPT6_RPC_ERROR.parse, message: "JSON 본문을 해석할 수 없습니다." },
    });
  }
  const maintenance = getUpdateMutationBlock();
  const rpc = body && typeof body === "object" ? body as { id?: unknown; method?: unknown } : null;
  if (maintenance && rpc?.method === "tools/call") {
    logGpt6Call({ status: "rejected:update-draining", durationMs: Date.now() - startedAt });
    return NextResponse.json({
      jsonrpc: "2.0",
      id: rpc.id ?? null,
      error: {
        code: -32000,
        message: `CUELO update ${maintenance.phase}`,
        data: { code: "update_draining", requestId: maintenance.requestId },
      },
    }, { status: 503 });
  }


  const response = await bridge.dispatch(body, { token });
  logGpt6Call({
    ...gpt6CallFields(body),
    status: gpt6CallStatus(response),
    durationMs: Date.now() - startedAt,
  });
  // 알림(notifications/*)은 응답 본문이 없다.
  if (response === null) return new Response(null, { status: 202 });
  return NextResponse.json(response);
}
