import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { startManualRoutineRun } from "@/lib/routines/runner";
import { inspectRepo, isRoutineId, readRoutine, routinesDir, thisRoutineHost } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

/**
 * POST: 루틴을 이 PC에서 지금 한 번 돌린다. 루틴의 실행 PC가 다른 곳이어도 이 페이지를 띄운 PC에서 돈다(화면이 그렇게
 * 알린다). 이 PC에서 마침 돌 차례인 회차가 있으면 이 실행이 그 회차를 쓴 것으로 남긴다. 이미 돌고 있으면 409.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  const { id } = await params;
  if (!isRoutineId(id)) return NextResponse.json({ error: "Invalid routine id" }, { status: 400 });
  const routine = readRoutine(dir, id);
  if (!routine) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  if (!startManualRoutineRun(dir, routine)) return NextResponse.json({ error: "Routine is already running" }, { status: 409 });
  return NextResponse.json({ started: id, host: thisRoutineHost() });
}
