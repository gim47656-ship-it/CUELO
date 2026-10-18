import { NextResponse } from "next/server";
import { RunXrayError, locateRunTranscripts, parseRunId } from "@/lib/run-xray";
import { loadRunWindow, maskedErrorMessage, pageRunTurns, resolveRunRoleTranscript, runEntryText } from "@/lib/run-xray-turns";
import { RUN_TURN_PAGE_DEFAULT } from "@/lib/run-xray-types";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

/** transcript 항목 id·도구 호출 id 모양. 다른 문자는 받지 않는다. */
const ID_RE = /^[\w-]{1,128}$/;

function failure(error: unknown): NextResponse {
  const status = error instanceof RunXrayError ? error.status : 500;
  return NextResponse.json({ error: maskedErrorMessage(error) }, { status });
}

function intParam(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * GET /api/runs/<runId>/turns?role=main&offset=0&limit=30&injectedOnly=1 — 요청 목록 한 쪽.
 * GET /api/runs/<runId>/turns?role=main&entry=<id>[&call=<toolCallId>] — 그 run 창 안 항목 하나의 전체 글.
 * 읽기 전용이며 그 세션의 transcript만 읽는다.
 */
export async function GET(req: Request, { params }: { params: Promise<{ runId: string }> }) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const { sessionId, entryId } = parseRunId((await params).runId);
    const url = new URL(req.url);
    const role = url.searchParams.get("role") || "main";
    const location = locateRunTranscripts(sessionId, entryId);
    const { file, window, roles } = resolveRunRoleTranscript(location, role);
    const data = loadRunWindow(file, window);

    const entry = url.searchParams.get("entry");
    if (entry !== null) {
      const call = url.searchParams.get("call");
      if (!ID_RE.test(entry) || (call !== null && !ID_RE.test(call))) {
        throw new RunXrayError("항목 id 형식이 올바르지 않습니다.", 400);
      }
      const text = runEntryText(data, entry, call);
      if (!text) throw new RunXrayError("이 run에서 그 항목을 찾을 수 없습니다.", 404);
      return NextResponse.json(text);
    }

    return NextResponse.json(pageRunTurns(
      data.built,
      { runId: location.detail.runId, role, roles },
      intParam(url.searchParams.get("offset"), 0),
      intParam(url.searchParams.get("limit"), RUN_TURN_PAGE_DEFAULT),
      url.searchParams.get("injectedOnly") === "1",
    ));
  } catch (error) {
    return failure(error);
  }
}
