import { NextResponse } from "next/server";
import {
  getUpdateStatus,
  markUpdateClientParked,
  markUpdateClientResumed,
  registerUpdateClient,
  type UpdateFailureNoticeDecision,
  type UpdateWakeDecision,
} from "@/lib/update-maintenance";
import { notifyUpdateFailureToInitiator, wakeUpdateInitiatorSession } from "@/lib/update-wake";
import { ensureInterruptWatcher } from "@/lib/update-interrupt";
import { renderUpdateWaitPage } from "@/lib/update-wait-page";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
// 서버 프로세스가 뜰 때 한 번 정해진다. 재시작하면 반드시 바뀐다.
const SERVER_BOOT_ID = `${process.pid}-${Math.floor((Date.now() - process.uptime() * 1000) / 1000)}`;
// 업데이트·재시작 중단 요청 감시와 교체 뒤 재개(lib/update-interrupt.ts). 탭 heartbeat가 곧바로 이 모듈을 연다.
ensureInterruptWatcher();

function noStoreHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    "Cache-Control": "no-store, no-cache, must-revalidate",
    Pragma: "no-cache",
    ...extra,
  };
}

function jsonError(error: unknown, status: number): NextResponse {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status, headers: noStoreHeaders() },
  );
}

export async function GET(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) return jsonError("Untrusted API request", 403);
  const url = new URL(req.url);
  const requestId = url.searchParams.get("requestId") ?? "";
  const stageHash = (url.searchParams.get("stageHash") ?? "").toLowerCase();
  if (url.searchParams.get("mode") !== "wait") {
    return NextResponse.json(getUpdateStatus(requestId, stageHash), { headers: noStoreHeaders({ Connection: "close" }) });
  }

  const clientId = url.searchParams.get("clientId") ?? "";
  try {
    const client = markUpdateClientParked({ requestId, stageHash, clientId });
    return new Response(renderUpdateWaitPage({ requestId, stageHash, clientId, sessionId: client.sessionId, resumeUrl: client.resumeUrl }), {
      status: 200,
      headers: noStoreHeaders({
        "Content-Type": "text/html; charset=utf-8",
        Connection: "close",
        "X-CUELO-Maintenance": "parked",
      }),
    });
  } catch (error) {
    return jsonError(error, 409);
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) return jsonError("Untrusted API request", 403);
  if (!hasJsonContentType(req)) return jsonError("Content-Type must be application/json", 415);
  let body: Record<string, unknown>;
  try {
    body = await req.json() as Record<string, unknown>;
  } catch (error) {
    return jsonError(error, 400);
  }

  try {
    const action = String(body.action ?? "");
    if (action === "heartbeat") {
      const state = registerUpdateClient({
        clientId: String(body.clientId ?? ""),
        sessionId: body.sessionId === null ? null : String(body.sessionId ?? ""),
        resumeUrl: String(body.resumeUrl ?? ""),
        preservationError: body.preservationError === null || body.preservationError === undefined
          ? null
          : String(body.preservationError),
      });
      // 복귀한 탭이 직전 업데이트를 가리키면 그 request의 실제 receipt 값만 함께 싣는다.
      // 배포 완료 뒤에도 계속 바뀌는 cleanup progress는 여기서만 읽고, 쓰기 차단 판정
      // (mutationBlocked/writeSafe)은 기존 계약 그대로 둔다.
      const requestId = String(body.requestId ?? "");
      const stageHash = String(body.stageHash ?? "").toLowerCase();
      const status = requestId && stageHash ? getUpdateStatus(requestId, stageHash) : null;
      return NextResponse.json({
        schemaVersion: 2,
        // 탭이 서버 재시작을 알아채는 값. 재시작이 heartbeat 주기보다 짧아도 값이 바뀌면 새로고침한다.
        serverBootId: SERVER_BOOT_ID,
        ...state,
        ...(status ? {
          update: {
            requestId,
            stageHash,
            deploymentCompleted: status.deploymentCompleted === true,
            writeSafe: status.writeSafe === true,
            terminalStatus: status.terminalStatus ?? null,
            cleanup: status.cleanup ?? null,
          },
        } : {}),
      }, { headers: noStoreHeaders({ Connection: "close" }) });
    }
    if (action === "resume-confirm") {
      const requestId = String(body.requestId ?? "");
      const stageHash = String(body.stageHash ?? "").toLowerCase();
      const clientId = String(body.clientId ?? "");
      const sessionId = body.sessionId === null ? null : String(body.sessionId ?? "");
      markUpdateClientResumed({ requestId, stageHash, clientId, sessionId });
      // 복귀는 여기서 이미 확정됐다. 자동 재개는 부가 기능이므로 실패해도 복귀를
      // 되돌리지 않고, 사용자가 직접 이어가는 기존 동작으로 떨어진다.
      let wake: UpdateWakeDecision | { wake: false; reason: "error" } = { wake: false, reason: "error" };
      try {
        wake = await wakeUpdateInitiatorSession({ requestId, stageHash, clientId, sessionId });
      } catch (error) {
        console.warn(`[cuelo] 업데이트 자동 재개에 실패했습니다 (${requestId}):`, error);
      }
      return NextResponse.json({ schemaVersion: 2, resumed: true, wake }, { headers: noStoreHeaders({ Connection: "close" }) });
    }
    if (action === "failure-notify") {
      const requestId = String(body.requestId ?? "");
      const stageHash = String(body.stageHash ?? "").toLowerCase();
      const clientId = String(body.clientId ?? "");
      const sessionId = body.sessionId === null ? null : String(body.sessionId ?? "");
      // 실패 여부는 클라이언트 주장이 아니라 서버가 result 파일로 다시 판정한다. 여기서
      // 보내는 것은 request/세션 신원뿐이다. 통지는 부가 기능이므로 실패해도 200으로 답하고,
      // 판정 결과를 그대로 돌려준다.
      let notice: UpdateFailureNoticeDecision | { notice: false; reason: "error" } = { notice: false, reason: "error" };
      try {
        notice = await notifyUpdateFailureToInitiator({ requestId, stageHash, clientId, sessionId });
      } catch (error) {
        console.warn(`[cuelo] 업데이트 실패 통지에 실패했습니다 (${requestId}):`, error);
      }
      return NextResponse.json({ schemaVersion: 2, notice }, { headers: noStoreHeaders({ Connection: "close" }) });
    }
    return jsonError("unknown maintenance action", 400);
  } catch (error) {
    return jsonError(error, 409);
  }
}
