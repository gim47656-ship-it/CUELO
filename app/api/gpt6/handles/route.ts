/**
 * 연결번호 API — WEB 6PRO 탭이 쓰는 쪽.
 *
 * `POST`는 연결번호와 함께 그 연결번호 전용 `handleKey`를 돌려준다. 토큰 평문은 저장소에
 * 아직 토큰이 없을 때(최초 발급)만 이 응답에 실린다 — 그 뒤로는 `/api/gpt6/token` 회전
 * 응답에서만 나간다. 조회(`GET`)는 발급 현황과 화면이 안내할 주소 두 개(직접 접속용
 * `mcpUrl`과 tunnel-client 대상 `tunnelTargetUrl`), 토큰 유무, 실패 집계를 주고,
 * 폐기(`DELETE`)는 상태만 바꾼다.
 *
 * 이 라우트들은 평문 토큰과 전 핸들 목록을 내주므로 `gpt6AdminGuard`를 건다 — 기존 브라우저
 * 가드에 더해 로컬·테일넷에서 온 요청만 통과시킨다. MCP 라우트는 6 Pro가 부르는 곳이 아니라
 * 집 PC의 `tunnel-client`가 브라우저가 아닌 클라이언트로 부르는 곳이므로 그 가드를 걸지 않는다
 * (`app/api/gpt6/mcp/route.ts` 주석 참조).
 */
import { NextResponse } from "next/server";
import { existsSync } from "node:fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { hasJsonContentType } from "@/lib/request-security";
import {
  announceGpt6Binding,
  getGpt6Bridge,
  gpt6AdminGuard,
  gpt6ErrorResponse,
  gpt6McpUrl,
  gpt6TunnelTargetUrl,
} from "../runtime";

export const dynamic = "force-dynamic";

function normalizeCwd(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

// POST /api/gpt6/handles — 연결번호 발급. {cwd, sessionId}는 이 시점 스냅샷으로 굳는다.
export async function POST(req: Request) {
  const denied = gpt6AdminGuard(req);
  if (denied) return denied;
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as {
      cwd?: unknown;
      sessionId?: unknown;
      instruction?: unknown;
      ttlMinutes?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    if (!cwd) return NextResponse.json({ error: "cwd is required", code: "invalid_argument" }, { status: 400 });
    if (!sessionId) {
      return NextResponse.json({ error: "sessionId is required", code: "invalid_argument" }, { status: 400 });
    }
    if (!existsSync(cwd)) {
      return NextResponse.json({ error: "Folder not found", code: "invalid_argument" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Access denied", code: "invalid_argument" }, { status: 403 });
    }

    // 살아 있는 세션이면 그 cwd가 정본이다. 다른 폴더로 발급해 두면 첫 호출부터
    // cwd_mismatch로 죽으므로 발급 자리에서 끊는다 — 조용히 대체하지 않는다.
    const live = getRpcSession(sessionId);
    if (live?.isAlive()) {
      if (normalizeCwd(live.cwd) !== normalizeCwd(cwd)) {
        return NextResponse.json({
          error: `세션 ${sessionId}의 작업폴더는 ${live.cwd}입니다. 그 폴더로 다시 발급하세요.`,
          code: "cwd_mismatch",
        }, { status: 409 });
      }
    } else if (!(await resolveSessionPath(sessionId))) {
      return NextResponse.json({ error: `세션 ${sessionId}를 찾을 수 없습니다.`, code: "session_not_found" }, { status: 404 });
    }

    const issued = getGpt6Bridge().issueHandle({
      cwd,
      sessionId,
      ...(typeof body.instruction === "string" ? { instruction: body.instruction } : {}),
      ...(body.ttlMinutes === undefined ? {} : { ttlMinutes: body.ttlMinutes as number }),
    });

    // 묶였다는 사실을 그 세션에 남긴다. 에이전트는 자기 session id를 모르므로 묶는 쪽이
    // 알려야 한다. 최선 노력이며 실패해도 발급은 그대로 성공한다(함수 안에서 잡는다).
    await announceGpt6Binding(issued.sessionId, issued.handle, issued.expiresAt);

    return NextResponse.json({
      handle: issued.handle,
      cwd: issued.cwd,
      sessionId: issued.sessionId,
      createdAt: issued.createdAt,
      expiresAt: issued.expiresAt,
      startSentence: issued.startSentence,
      handleKey: issued.handleKey,
      mcpUrl: gpt6McpUrl(),
      // 최초 발급에서만 평문 토큰이 실린다. 이미 토큰이 있으면 이 키 자체가 없다.
      ...(issued.token === null ? {} : { token: issued.token }),
    });
  } catch (error) {
    return gpt6ErrorResponse(error);
  }
}

// GET /api/gpt6/handles — 발급 현황. 토큰은 절대 돌려주지 않는다.
export async function GET(req: Request) {
  const denied = gpt6AdminGuard(req);
  if (denied) return denied;

  try {
    const { handles, tokenPresent, failedAuthCount, lastFailedAt } = getGpt6Bridge().listHandles();
    return NextResponse.json({
      // 화면이 두 주소를 함께 안내한다 — `mcpUrl`은 직접 접속용, `tunnelTargetUrl`은
      // 집 PC의 tunnel-client가 향할 loopback 주소다.
      handles: handles.map((handle) => ({
        handle: handle.handle,
        cwd: handle.cwd,
        sessionId: handle.sessionId,
        createdAt: handle.createdAt,
        expiresAt: handle.expiresAt,
        revokedAt: handle.revokedAt,
        lastCallAt: handle.lastCallAt,
        callCount: handle.callCount,
        status: handle.status,
      })),
      mcpUrl: gpt6McpUrl(),
      tunnelTargetUrl: gpt6TunnelTargetUrl(),
      tokenPresent,
      failedAuthCount,
      lastFailedAt,
    });
  } catch (error) {
    return gpt6ErrorResponse(error);
  }
}

// DELETE /api/gpt6/handles?handle=H-1042 — 폐기. 이후 그 연결번호는 어떤 도구도 통과시키지 않는다.
export async function DELETE(req: Request) {
  const denied = gpt6AdminGuard(req);
  if (denied) return denied;

  try {
    const handle = new URL(req.url).searchParams.get("handle") ?? "";
    return NextResponse.json(getGpt6Bridge().revokeHandle(handle));
  } catch (error) {
    return gpt6ErrorResponse(error);
  }
}
