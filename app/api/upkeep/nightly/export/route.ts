import { hostname } from "node:os";
import { getAgentDir, getSessionsDir } from "@oh-my-pi/pi-utils";
import { NextResponse } from "next/server";
import { collectLabExport } from "@/lib/plugin-lab";
import { isApiRequestAllowed } from "@/lib/request-security";
import { collectUpkeep } from "@/lib/upkeep/collect";
import { buildNightlyExport, nightlySourceName } from "@/lib/upkeep/nightly-inbox";
import { scanSessions } from "@/lib/upkeep/sessions";
import { collectSkillCandidates, observedCandidates } from "@/lib/upkeep/skill-candidates";
import { buildSkillUsage, installedSkills } from "@/lib/upkeep/skill-usage";

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

/**
 * 클라우드 야간 개선에 보낼 이 PC의 묶음(JSON v2). `cuelo-cloud-sync.sh`가 2시간마다 받아 클라우드 받은편지함에 올린다.
 * 문제 행·절차 후보(learn 후보와 넘긴 흔적에서 찾은 관찰 후보, 최근 14일)·도구 실패 순위와 발췌(최근 7일)·스킬 사용·
 * 실험 플러그인(시험 사본, 최근 14일 사용)을 담고 본문은 비밀을 가린다.
 */
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) {
    console.log("[upkeep/nightly/export] rejected: untrusted request");
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  try {
    const now = new Date();
    const since = now.getTime() - 14 * DAY_MS;
    const agentDir = getAgentDir();
    const sessionsDir = getSessionsDir(agentDir);
    const [report, learned, scan, installed, labPlugins] = await Promise.all([
      collectUpkeep(true),
      collectSkillCandidates(sessionsDir, since, now.getTime()),
      scanSessions(sessionsDir, now.getTime()),
      installedSkills(agentDir),
      collectLabExport(since, sessionsDir, agentDir),
    ]);
    const bundle = buildNightlyExport({
      source: nightlySourceName(process.env, hostname()),
      now,
      report,
      skillCandidates: [...observedCandidates(scan.recoveries, since), ...learned],
      errorsBySignature: scan.windows[0].errorsBySignature,
      // 세션 기록을 다 읽지 못했으면 열지 않은 스킬을 내보내지 않는다(삭제 제안의 근거가 되지 않게).
      skillUsage: buildSkillUsage(scan.skills.windows, {}, installed.skills, now.getTime(), !scan.warnings.length),
      failureExcerpts: scan.failureExcerpts,
      labPlugins,
    });
    const observed = bundle.skillCandidates.filter((c) => c.kind === "observed").length;
    console.log(`[upkeep/nightly/export] ${bundle.source}: ${bundle.problems.length} problem(s), ${bundle.skillCandidates.length} candidate(s) (${observed} observed), ${bundle.toolFailures.length} failure group(s), ${bundle.skillUsage.rows.length} skill(s) opened, ${bundle.labPlugins.length} lab plugin(s)`);
    return NextResponse.json(bundle, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.log(`[upkeep/nightly/export] failed: ${error instanceof Error ? error.message : String(error)}`);
    return NextResponse.json({ error: "Nightly export failed" }, { status: 500 });
  }
}
