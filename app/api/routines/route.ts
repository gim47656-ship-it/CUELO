import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRoutineSyncState, commitRoutineChange, requestRoutineSync } from "@/lib/routines/git-sync";
import { readRoutineRunStates } from "@/lib/routines/state";
import { routineReadKeys } from "@/lib/routines/reads";
import { isRoutineRunning } from "@/lib/routines/runner";
import { ROUTINE_TIMEZONE, nextRunAt } from "@/lib/routines/schedule";
import {
  type Routine, inspectRepo, listPosts, newRoutineId, parseRoutineInput, readRoutines, routinesDir, thisRoutineHost, writeRoutineFile,
} from "@/lib/routines/store";

export const dynamic = "force-dynamic";

/**
 * GET: 로컬 작업 사본의 루틴과 글 목록을 바로 돌려주고, 저장소 받기는 백그라운드로 건다(30초에 한 번).
 * 화면은 `sync.syncing`이 끝나면 다시 읽는다. 저장소가 없으면 `setup`으로 알린다.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const dir = routinesDir();
  const repo = inspectRepo(dir);
  const host = thisRoutineHost();
  if (!repo.ok) {
    return NextResponse.json({ setup: { reason: repo.reason, dir }, thisHost: host, hosts: [host], sync: getRoutineSyncState(), routines: [], readPosts: [] });
  }
  requestRoutineSync(dir);
  const runStates = readRoutineRunStates();
  const now = new Date();
  // 다음 실행은 켜진 루틴만. 마지막 실행은 이 PC의 기록이라 이 PC가 돌린 회차만 보인다(글 없이 끝난 회차 포함).
  const routines = readRoutines(dir).map((routine) => ({
    ...routine,
    running: isRoutineRunning(routine.id),
    nextRunAt: routine.enabled ? nextRunAt(routine.schedule, routine.timezone, now)?.toISOString() ?? null : null,
    lastRun: runStates[routine.id]?.lastRun ?? null,
    posts: listPosts(dir, routine.id),
  }));
  const hosts = [...new Set([host, ...routines.flatMap((routine) => [routine.host, ...routine.posts.map((post) => post.host)])].filter(Boolean))];
  return NextResponse.json({ setup: null, thisHost: host, hosts, sync: getRoutineSyncState(), routines, readPosts: routineReadKeys(dir, now.getTime()) });
}

/** POST: 새 루틴을 만들어 커밋하고 올린다. 시간대는 언제나 Asia/Seoul로 쓴다. */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = parseRoutineInput(body);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const now = new Date();
  const routine: Routine = {
    id: newRoutineId(now),
    ...parsed.input,
    timezone: ROUTINE_TIMEZONE,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  try {
    await commitRoutineChange(dir, `routine(${routine.id}): create ${routine.name}`, () => ({ paths: [writeRoutineFile(dir, routine)], result: undefined }));
    return NextResponse.json({ routine, sync: getRoutineSyncState() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
