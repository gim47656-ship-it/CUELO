import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { actOnAssistantProposal } from "@/lib/routines/assistant";
import { AssistantError } from "@/lib/routines/assistant-proposals";
import { inspectRepo, routinesDir } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

/** POST { action: "apply" | "cancel" } confirms exactly one persisted card. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "신뢰할 수 없는 API 요청입니다." }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type은 application/json이어야 합니다." }, { status: 415 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "루틴 저장소가 설정되지 않았습니다." }, { status: 409 });
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "JSON 본문이 올바르지 않습니다." }, { status: 400 }); }
  const action = (body as { action?: unknown } | null)?.action;
  if (action !== "apply" && action !== "cancel") return NextResponse.json({ error: "action은 apply 또는 cancel이어야 합니다." }, { status: 400 });
  const { id } = await params;
  try { await actOnAssistantProposal(dir, id, action); return NextResponse.json({ ok: true }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof AssistantError ? error.status : 500 }); }
}
