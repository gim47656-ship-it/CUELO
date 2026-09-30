import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { readArchivedIds } from "@/lib/session-archive";
import { isApiRequestAllowed } from "@/lib/request-security";
import { searchTranscripts } from "@/lib/transcript-search";
import type { SessionInfo } from "@/lib/types";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

// GET /api/sessions/search?q= - bounded transcript search over the saved sessions the sidebar lists.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  try {
    const query = new URL(req.url).searchParams.get("q") ?? "";
    const archived = readArchivedIds();
    // Only files the session list already reads: the search opens no other path.
    const sessions = (await listAllSessions()).filter((session) => !archived.has(session.id) && session.path);
    const result = await searchTranscripts(sessions, query);
    const byId = new Map<string, SessionInfo>(sessions.map((session) => [session.id, session]));
    const hitSessions: Record<string, SessionInfo> = {};
    for (const hit of result.hits) {
      const session = byId.get(hit.sessionId);
      if (session) hitSessions[hit.sessionId] = session;
    }
    return NextResponse.json({ query: query.trim(), ...result, sessions: hitSessions }, { headers: NO_STORE });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers: NO_STORE });
  }
}
