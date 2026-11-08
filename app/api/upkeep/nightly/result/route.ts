import { getAgentDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";
import { resolveSessionPath, readSessionHeader } from "@/lib/session-reader";
import { inspectNightlyResult, writeNightlyResult } from "@/lib/upkeep/nightly-result";
import { readNightlyState } from "@/lib/upkeep/nightly";
import { kstDate } from "@/lib/upkeep/prompt";

export const dynamic = "force-dynamic";

const log = (message: string) => console.log(`[upkeep/nightly/result] ${message}`);

/**
 * 야간 실행의 끝 상태를 받은편지함 출처마다 결과 파일로 남긴다(lib/upkeep/nightly-result.ts, 2026-11-09 사용자 결정). 클라우드 실행
 * 스크립트 `cuelo-nightly-run.sh`가 세션이 끝난 뒤 본문 `{"sessionId":"…"}`로, cuelo.service 재시작으로 세션이 끊긴 경우에는
 * `{"sessionId":"…","interrupted":true}`로 부른다. 게시까지 못 간 실행(보류, 중단, 오류)을 각 PC의 아침 보고가 알 수 있게 하는
 * 것이 목적이다. `?dryRun=1`은 결과만 돌려주고 파일을 쓰지 않는다.
 */
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) {
    log("rejected: untrusted request");
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  let interrupted = false;
  let reportedSession: string | null = null;
  if (hasJsonContentType(req)) {
    try {
      const body = (await req.json()) as { interrupted?: unknown; sessionId?: unknown } | null;
      interrupted = body?.interrupted === true;
      reportedSession = typeof body?.sessionId === "string" && /^[A-Za-z0-9-]{1,64}$/.test(body.sessionId) ? body.sessionId : null;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }
  const dryRun = new URL(req.url).searchParams.get("dryRun") === "1";
  const outboxDir = process.env.CUELO_NIGHTLY_OUTBOX_DIR;
  const inboxDir = process.env.CUELO_NIGHTLY_INBOX_DIR;
  if (!outboxDir || !inboxDir) {
    log("skipped: inbox/outbox not configured");
    return NextResponse.json({ action: "skipped", reason: "not-inbox-mode" });
  }
  // 기록을 읽지 못해도 스크립트가 알린 세션이 있으면 그 세션 기록으로 대신한다(한 줄 때문에 보고를 통째로 잃지 않게).
  let saved = null;
  try {
    saved = readNightlyState(getAgentDir());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!reportedSession) {
      log(`skipped: ${message}`);
      return NextResponse.json({ action: "skipped", reason: "unreadable-state", error: message });
    }
    log(`warning: ${message}; using the reported session ${reportedSession}`);
  }
  const sessionFile = await resolveSessionPath(reportedSession ?? saved?.sessionId ?? "");
  // 스크립트가 알린 세션을 우선한다. 시작 응답은 프롬프트를 받은 뒤 기록만 실패할 수 있어(accepted) 그 실행이 기록에 없거나,
  // 기록이 지난 실행을 가리킬 수 있다. 그때는 세션 기록의 작업 사본 경로와 시각으로 대신한다.
  const sessionId = reportedSession ?? saved?.sessionId ?? null;
  if (!sessionId) {
    log("skipped: no nightly run recorded or reported");
    return NextResponse.json({ action: "skipped", reason: "no-nightly-run" });
  }
  let state = saved && saved.sessionId === sessionId ? saved : null;
  if (!state && sessionFile) {
    const header = readSessionHeader(sessionFile);
    // 잘린 세션 머리줄에는 날짜가 없을 수 있다. 없으면 기록을 지어내지 않고 건너뛴다.
    if (header?.cwd && Number.isFinite(Date.parse(header.timestamp))) {
      state = { date: kstDate(header.timestamp), sessionId, worktree: header.cwd, startedAt: header.timestamp };
    }
  }
  if (!state) {
    log(`skipped: no nightly run record for session ${sessionId}`);
    return NextResponse.json({ action: "skipped", reason: "no-nightly-run" });
  }
  // 세션이 아직 돌고 있으면 그 실행은 끝난 것이 아니다. 다만 스크립트가 재시작을 보고하면 세션은 이미 끊긴 것이라 적는다.
  if (!interrupted && getRunningRpcSessionIds().includes(state.sessionId)) {
    log(`skipped: session ${state.sessionId} is still running`);
    return NextResponse.json({ action: "skipped", reason: "still-running" });
  }
  let result;
  try {
    result = await inspectNightlyResult({
      state,
      repo: process.env.CUELO_NIGHTLY_REPO || null,
      sessionFile,
      interrupted,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`failed to inspect: ${message}`);
    return NextResponse.json({ error: message }, { status: 500 });
  }
  for (const warning of result.warnings) log(`warning: ${warning}`);
  if (dryRun) {
    log(`dry run: ${result.outcome} for ${state.sessionId}`);
    return NextResponse.json({ action: "planned", dryRun, result });
  }
  const sources = writeNightlyResult(outboxDir, inboxDir, result);
  if (!sources.written.length || sources.failed.length) {
    const detail = `written ${sources.written.join(", ") || "none"}${sources.failed.length ? `, failed ${sources.failed.join(", ")}` : ""}`;
    log(`warning: ${result.outcome} for ${state.sessionId} could not be written to every source (${detail})`);
    return NextResponse.json(
      { action: "failed", outcome: result.outcome, ...sources, error: "result not written to every inbox source" },
      { status: 500 },
    );
  }
  log(`${result.outcome} for ${state.sessionId} written to ${sources.written.join(", ")} (${result.leftoverCount} leftover(s), ${result.unpushed.length} unpushed)`);
  return NextResponse.json({ action: "written", outcome: result.outcome, sources: sources.written });
}
