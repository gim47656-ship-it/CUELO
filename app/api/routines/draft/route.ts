import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { createRoutineDraft } from "@/lib/routines/draft";
import { inspectRepo, readRoutines, routinesDir, thisRoutineHost } from "@/lib/routines/store";

export const dynamic = "force-dynamic";
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const dir = routinesDir();
  if (!inspectRepo(dir).ok) return NextResponse.json({ error: "Routines repository is not set up" }, { status: 409 });
  let raw;
  try { raw = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const text = typeof raw?.text === "string" ? raw.text.trim() : "";
  if (!text || text.length > 8000) return NextResponse.json({ error: "text must be 1-8000 characters" }, { status: 400 });
  try { return NextResponse.json(await createRoutineDraft(text, readRoutines(dir), thisRoutineHost())); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 502 }); }
}
