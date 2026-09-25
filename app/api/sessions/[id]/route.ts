import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { SessionManager } from "@oh-my-pi/pi-coding-agent";
import {
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  getHistoricalContextUsage,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { beginGuardedSessionDeletion, getRpcSession } from "@/lib/rpc-manager";
import { setSessionArchived } from "@/lib/session-archive";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { getDocumentPromptUserMessage } from "@/lib/document-attachments";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? await SessionManager.open(resolvedPath!);
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries() as never;
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const context = buildSessionContext(entries, leafId, { deferThinking, deferToolResultImages });
    const contextUsage = await getHistoricalContextUsage(entries, leafId);
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const firstUserMessage = context.messages.find((message) => message.role === "user");
    const firstUserContent = firstUserMessage?.content;
    const firstUserText = typeof firstUserContent === "string"
      ? firstUserContent
      : Array.isArray(firstUserContent)
        ? firstUserContent
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
        : "";
    const info = header ? {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sm.getSessionName(),
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: getDocumentPromptUserMessage(firstUserText) || "(no messages)",
      parentSessionId,
      transient: !filePath || !existsSync(filePath),
    } : null;

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      totalActiveMs,
      ...(contextUsage ? { contextUsage } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  const { id } = await params;
  try {
    const { name, archived } = await req.json() as { name?: string; archived?: boolean };
    const hasName = typeof name === "string";
    const hasArchived = typeof archived === "boolean";
    if (!hasName && !hasArchived) {
      return NextResponse.json({ error: "name or archived is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (hasName) {
      const sm = await SessionManager.open(filePath);
      await sm.setSessionName(name.trim(), "user");
    }
    if (hasArchived) {
      // Key the registry by the header id (what /api/sessions lists), not by
      // whatever alias the client addressed the session with.
      setSessionArchived(readSessionHeader(filePath)?.id ?? id, archived);
    }
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }

  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    // Bulk clear must never kill work that started after the client's check, so
    // the running test that decides the deletion lives here, not in the browser.
    // 판정과 예약은 rpc 레지스트리 안에서 한 번에 끝난다. 아래의 자식 재부모화와
    // 파일 삭제 전에 예약이 서므로, 그 뒤에 도착한 명령도 같은 id의 재기동도 거부된다.
    const skipRunning = new URL(req.url).searchParams.get("skipRunning") === "1";
    const deletion = beginGuardedSessionDeletion(id, { onlyWhenIdle: skipRunning });
    if (!deletion.reserved) {
      return NextResponse.json({ error: "Session is running", running: true }, { status: 409 });
    }

    try {
      // Read only the bounded header before deleting.
      const header = readSessionHeader(filePath);
      const parentSessionPath = header?.parentSession;

      // Re-attach all direct children to this session's parent (cascade re-parent)
      // Scan sibling files in the same directory
      const targetPathKey = sessionPathKey(filePath);
      const dir = dirname(filePath);
      try {
        const files = readdirSync(dir).filter(
          (file) => file.endsWith(".jsonl") && sessionPathKey(join(dir, file)) !== targetPathKey,
        );
        for (const file of files) {
          const childPath = join(dir, file);
          try {
            const content = readFileSync(childPath, "utf8");
            const lines = content.split("\n");
            const header = JSON.parse(lines[0]) as { type?: string; parentSession?: string };
            if (
              header.type === "session" &&
              header.parentSession &&
              sessionPathKey(header.parentSession) === targetPathKey
            ) {
              // Rewrite header with new parentSession
              header.parentSession = parentSessionPath;
              lines[0] = JSON.stringify(header);
              writeFileSync(childPath, lines.join("\n"));
            }
          } catch { /* skip malformed */ }
        }
      } catch { /* skip if dir unreadable */ }

      await getRpcSession(id)?.shutdown();
      unlinkSync(filePath);
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
    } finally {
      // 예약을 잡은 뒤의 모든 단계가 이 안에 있다. 헤더 읽기처럼 삭제 이전
      // 단계에서 실패해도 세션은 계속 쓰여야 하므로 예약은 반드시 풀린다.
      deletion.release();
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
