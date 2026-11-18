import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { commitRoutineChange, getRoutineSyncState } from "@/lib/routines/git-sync";
import { inspectRepo, readRoutinesPause, routinesDir, writeRoutinesPause } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

/**
 * PUT `{ paused }`: 모든 루틴의 예약 실행과 답장 처리를 한 번에 멈추거나 다시 켠다. 저장소 맨 위 `pause.json`에 커밋해
 * 올리므로 다른 PC도 따른다(실행 직전에 저장소를 받아 다시 본다). 루틴별 켜짐은 그대로 두고, 이미 도는 실행과
 * 「지금 실행」은 막지 않는다.
 */
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  let body: { paused?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const paused = body?.paused;
  if (typeof paused !== "boolean") return NextResponse.json({ error: "paused must be a boolean" }, { status: 400 });
  try {
    const pause = await commitRoutineChange(dir, `routines: ${paused ? "pause" : "resume"} all`, () => {
      const current = readRoutinesPause(dir);
      if (current.paused === paused) return { paths: [], result: current };
      const next = { paused, changedAt: new Date().toISOString() };
      const written = writeRoutinesPause(dir, next);
      return { paths: [written.path], result: next, rollback: written.rollback };
    });
    return NextResponse.json({ pause, sync: getRoutineSyncState() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
