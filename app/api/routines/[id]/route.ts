import { rmSync } from "node:fs";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { commitRoutineChange, getRoutineSyncState } from "@/lib/routines/git-sync";
import { isRoutineRunning } from "@/lib/routines/runner";
import { updateRoutineRunState } from "@/lib/routines/state";
import { ROUTINE_TIMEZONE } from "@/lib/routines/schedule";
import { type Routine, inspectRepo, isRoutineId, parseRoutineInput, readRoutine, routinePaths, routinesDir, writeRoutineFile } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

class NotFound extends Error {}
class Running extends Error {}

function guard(req: Request, needsJson: boolean): NextResponse | null {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (needsJson && !hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  if (!inspectRepo(routinesDir()).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  return null;
}

function failure(error: unknown) {
  if (error instanceof NotFound) return NextResponse.json({ error: "Routine not found" }, { status: 404 });
  if (error instanceof Running) return NextResponse.json({ error: "Routine is running" }, { status: 409 });
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

/** PUT: 루틴을 고친다. 받아 온 뒤의 파일을 기준으로 만든 시각을 지키고, 시간대는 Asia/Seoul로 쓴다. */
export async function PUT(req: Request, { params }: Params) {
  const blocked = guard(req, true);
  if (blocked) return blocked;
  const { id } = await params;
  if (!isRoutineId(id)) return NextResponse.json({ error: "Invalid routine id" }, { status: 400 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseRoutineInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const dir = routinesDir();
  try {
    const routine = await commitRoutineChange(dir, `routine(${id}): update ${parsed.input.name}`, () => {
      const current = readRoutine(dir, id);
      if (!current) throw new NotFound();
      const next: Routine = { ...current, ...parsed.input, timezone: ROUTINE_TIMEZONE, updatedAt: new Date().toISOString() };
      return { paths: [writeRoutineFile(dir, next)], result: next };
    });
    return NextResponse.json({ routine, sync: getRoutineSyncState() });
  } catch (error) {
    return failure(error);
  }
}

/**
 * PATCH `{ enabled }`: 루틴을 바로 켜고 끈다(확인 없이 누르는 「끄기」·「켜기」). 커밋해 올리므로 다른 PC는 다음
 * 동기화(5분 안) 때 받는다. 이미 도는 회차는 멈추지 않는다.
 */
export async function PATCH(req: Request, { params }: Params) {
  const blocked = guard(req, true);
  if (blocked) return blocked;
  const { id } = await params;
  if (!isRoutineId(id)) return NextResponse.json({ error: "Invalid routine id" }, { status: 400 });
  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body?.enabled !== "boolean") return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  const enabled = body.enabled;
  const dir = routinesDir();
  try {
    const routine = await commitRoutineChange(dir, `routine(${id}): ${enabled ? "enable" : "disable"}`, () => {
      const current = readRoutine(dir, id);
      if (!current) throw new NotFound();
      if (current.enabled === enabled && current.timezone === ROUTINE_TIMEZONE) return { paths: [], result: current };
      const next: Routine = { ...current, enabled, timezone: ROUTINE_TIMEZONE, updatedAt: new Date().toISOString() };
      return { paths: [writeRoutineFile(dir, next)], result: next };
    });
    return NextResponse.json({ routine, sync: getRoutineSyncState() });
  } catch (error) {
    return failure(error);
  }
}

/** DELETE: 루틴 폴더(정의와 글 전부)를 지우고 커밋한다. 지난 글은 git 기록에 남는다. 도는 중이면 거절한다. */
export async function DELETE(req: Request, { params }: Params) {
  const blocked = guard(req, false);
  if (blocked) return blocked;
  const { id } = await params;
  if (!isRoutineId(id)) return NextResponse.json({ error: "Invalid routine id" }, { status: 400 });
  if (isRoutineRunning(id)) return NextResponse.json({ error: "Routine is running" }, { status: 409 });
  const dir = routinesDir();
  try {
    await commitRoutineChange(dir, `routine(${id}): delete`, () => {
      const current = readRoutine(dir, id);
      if (!current) throw new NotFound();
      // 받아 오는 동안 예약이나 지금 실행이 시작됐을 수 있다: 지우기 직전에 다시 본다.
      if (isRoutineRunning(id)) throw new Running();
      const paths = routinePaths(dir, id);
      rmSync(paths.folder, { recursive: true, force: true });
      return { paths: [paths.relFolder], result: undefined };
    });
    updateRoutineRunState(id, () => undefined);
    return NextResponse.json({ deleted: id, sync: getRoutineSyncState() });
  } catch (error) {
    return failure(error);
  }
}
