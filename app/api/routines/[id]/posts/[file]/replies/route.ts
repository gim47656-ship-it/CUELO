import { NextResponse } from "next/server";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { commitRoutineChange, getRoutineSyncState } from "@/lib/routines/git-sync";
import { parseReplyBody, reserveReplyWrite, releaseReplyWrite } from "@/lib/routines/reply";
import { startRoutineReply } from "@/lib/routines/runner";
import { inspectRepo, readPost, readRoutine, routinesDir, thisRoutineHost, writeReplyFile } from "@/lib/routines/store";

export const dynamic = "force-dynamic";

export async function POST(req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const parsed = parseReplyBody(body);
  if ("error" in parsed) return NextResponse.json(parsed, { status: 400 });
  const { id, file } = await params;
  if (!readRoutine(dir, id) || !readPost(dir, id, file)) return NextResponse.json({ error: "Post not found" }, { status: 404 });
  reserveReplyWrite(`${id}/${file}`);
  let released = false;
  try {
    const reply = await commitRoutineChange(dir, `routine(${id}): user reply`, () => {
      if (!readRoutine(dir, id) || !readPost(dir, id, file)) throw new Error("Post not found");
      const saved = writeReplyFile(dir, id, file, { author: "user", host: thisRoutineHost(), createdAt: new Date().toISOString(), body: parsed.body });
      return { paths: [saved.path], result: saved.reply, rollback: () => unlinkSync(join(dir, saved.path)) };
    });
    releaseReplyWrite(`${id}/${file}`);
    released = true;
    const routine = readRoutine(dir, id);
    if (routine) startRoutineReply(dir, routine, file);
    return NextResponse.json({ reply, sync: getRoutineSyncState() }, { status: 201 });
  } catch (error) {
    if (!released) releaseReplyWrite(`${id}/${file}`);
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
