import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { readSelfUpdateState, startSelfUpdate, type SelfUpdateState } from "@/lib/self-update";
import type { CueloUpdateApplyState } from "@/lib/api-types";

export const dynamic = "force-dynamic";

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "private, no-store", Connection: "close" };
}

/**
 * The worker's fields as the browser sees them. The pid, the app root and the recorded supervisor
 * argv stay on the server: the client needs the outcome and where the log is, nothing advisory.
 */
function toWireState(state: SelfUpdateState): CueloUpdateApplyState {
  const job = state.job;
  return {
    mode: state.mode.mode,
    supported: state.mode.supported,
    reason: state.mode.reason,
    running: state.running,
    runningVersion: state.runningVersion,
    job: job ? {
      mode: job.mode,
      phase: job.phase,
      currentVersion: job.currentVersion,
      targetVersion: job.targetVersion,
      targetRef: job.targetRef,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      error: job.error,
      logPath: job.logPath,
    } : null,
  };
}

function jsonError(error: unknown, status: number): NextResponse {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status, headers: noStoreHeaders() },
  );
}

/** GET /api/updates/apply — install mode and the newest run, for the update panel. */
export async function GET(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) return jsonError("Untrusted API request", 403);
  try {
    return NextResponse.json(toWireState(readSelfUpdateState()), { headers: noStoreHeaders() });
  } catch (error) {
    return jsonError(error, 500);
  }
}

/**
 * POST /api/updates/apply — start installing the newest release.
 *
 * The body is ignored: the target version comes from the release check the server runs itself, so
 * a browser cannot name a command, path, package spec, tag or revision. A second press while one
 * update runs returns that job instead of starting another.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isApiRequestAllowed(req)) return jsonError("Untrusted API request", 403);
  if (!hasJsonContentType(req)) return jsonError("Content-Type must be application/json", 415);
  try {
    const result = await startSelfUpdate();
    if (result.state === "unsupported") {
      return NextResponse.json(
        { state: result.state, ...toWireState(readSelfUpdateState()) },
        { status: 409, headers: noStoreHeaders() },
      );
    }
    if (result.state === "error") return jsonError(result.error, 500);
    return NextResponse.json(
      { state: result.state, ...toWireState(readSelfUpdateState()) },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    return jsonError(error, 500);
  }
}
