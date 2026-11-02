import { hostname } from "node:os";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { isApiRequestAllowed } from "@/lib/request-security";
import { collectUpkeep } from "@/lib/upkeep/collect";
import { buildNightlyExport, nightlySourceName } from "@/lib/upkeep/nightly-inbox";
import { scanSessions } from "@/lib/upkeep/sessions";
import { collectSkillCandidates } from "@/lib/upkeep/skill-candidates";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/**
 * 클라우드 야간 개선에 보낼 이 PC의 묶음(JSON v1). `cuelo-cloud-sync.sh`가 2시간마다 받아 클라우드 받은편지함에 올린다.
 * 문제 행·절차 후보(최근 14일)·도구 실패 순위(최근 7일)만 담고 본문은 비밀을 가린다.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    console.log("[upkeep/nightly/export] rejected: untrusted request");
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const now = new Date();
    const agentDir = getAgentDir();
    const sessionsDir = getSessionsDir(agentDir);
    const [report, skillCandidates, scan] = await Promise.all([
      collectUpkeep(true),
      collectSkillCandidates(sessionsDir, now.getTime() - 14 * DAY_MS, now.getTime()),
      scanSessions(sessionsDir, now.getTime()),
    ]);
    const bundle = buildNightlyExport({
      source: nightlySourceName(process.env, hostname()),
      now,
      report,
      skillCandidates,
      errorsBySignature: scan.windows[0].errorsBySignature,
    });
    console.log(`[upkeep/nightly/export] ${bundle.source}: ${bundle.problems.length} problem(s), ${bundle.skillCandidates.length} candidate(s), ${bundle.toolFailures.length} failure group(s)`);
    return NextResponse.json(bundle, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log(`[upkeep/nightly/export] failed: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: "Nightly export failed" }, { status: 500 });
  }
}
