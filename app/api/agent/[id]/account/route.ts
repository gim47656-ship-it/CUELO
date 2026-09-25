import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { isApiRequestAllowed } from "@/lib/request-security";
import { getSessionAccountState } from "@/lib/hanse-account-state";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const { id } = await params;
  const live = getRpcSession(id);
  const state = await getSessionAccountState(id, live?.isAlive() ? live.inner : undefined);
  // 대기 중 wrapper가 종료/교체되었으면 그 pin도 더 이상 live 증거가 아니다.
  const current = getRpcSession(id);
  const body = current === live && current?.isAlive()
    ? state : await getSessionAccountState(id, undefined);
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}
